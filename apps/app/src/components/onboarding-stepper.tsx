"use client";

import { useState } from "react";
import { Check, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CodeBlock } from "@/components/code-block";
import { trpc } from "@/lib/trpc/client";

const PROXY_URL =
  process.env.NEXT_PUBLIC_GIT_PROXY_URL ?? "https://git.monora.ai";

// The local tree (connector) is the one path we show by default: real files
// your agent reads AND writes (git push), works with any agent or editor.
// MCP is the no-clone, read-only alternative, tucked behind a disclosure so
// nobody picks "read-only" by accident just because it carries their tool's
// name. Inside that branch you only pick which agent to wire MCP into.
type AgentId = "connector" | "claude" | "codex" | "cursor";
const MCP_AGENTS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "cursor", label: "Cursor" },
] as const;
type McpAgent = (typeof MCP_AGENTS)[number]["id"];

/**
 * The "do this" line shown right above the command block. Step 2's job is to
 * tell a (technical) human exactly what to do with what they copied - where it
 * runs and what it produces - not to sell the feature. Keep it imperative.
 */
function howTo(agent: AgentId): string {
  switch (agent) {
    case "connector":
      return "Paste this into your terminal. It signs you in, copies the folders you can access into ~/monora-brains, and opens your AI right inside them.";
    case "claude":
      return "Paste this into your terminal. It connects Claude Code to your brain - read-only, with nothing copied to your computer.";
    case "codex":
      return "Add this to ~/.codex/config.toml (create the file if it isn't there yet), then restart Codex.";
    case "cursor":
      return "Add this to ~/.cursor/mcp.json (create the file if it isn't there yet), then restart Cursor.";
  }
}

function command(agent: AgentId, token: string): string {
  switch (agent) {
    case "connector":
      return `# Monora connector - the official CLI for your company brain (https://monora.ai).
# Signs you in (approve in your browser - no key to copy), then copies ONLY the
# folders you can access into ~/monora-brains. It talks only to the --url below.
npx -y @monora-ai/connector login --url ${PROXY_URL}
npx -y @monora-ai/connector sync --workspace ~/monora-brains

# then run your agent inside the composed tree:
cd ~/monora-brains && claude`;
    case "claude":
      return `# Monora MCP - official read-only client (https://monora.ai). Reads only what your key allows; nothing is copied locally.
claude mcp add monora \\
  --env MONORA_URL=${PROXY_URL} \\
  --env MONORA_TOKEN=${token} \\
  -- npx -y @monora-ai/mcp`;
    case "codex":
      return `# ~/.codex/config.toml
[mcp_servers.monora]
command = "npx"
args = ["-y", "@monora-ai/mcp"]
env = { MONORA_URL = "${PROXY_URL}", MONORA_TOKEN = "${token}" }`;
    case "cursor":
      return `// ~/.cursor/mcp.json
{
  "mcpServers": {
    "monora": {
      "command": "npx",
      "args": ["-y", "@monora-ai/mcp"],
      "env": { "MONORA_URL": "${PROXY_URL}", "MONORA_TOKEN": "${token}" }
    }
  }
}`;
  }
}

/**
 * The onboarding checklist. Self-contained: generate a key, connect an agent,
 * and the steps tick themselves off (it polls onboarding status, which flips
 * once your token is actually used to pull). Reused on the Overview card and
 * the Get started page.
 */
export function OnboardingStepper() {
  const status = trpc.onboarding.status.useQuery(undefined, {
    // While not done, poll so the "connected" step ticks live after a pull.
    refetchInterval: (q) => (q.state.data?.completed ? false : 4000),
  });
  const utils = trpc.useUtils();
  const [fresh, setFresh] = useState<string | null>(null);
  const [showMcp, setShowMcp] = useState(false);
  const [mcpAgent, setMcpAgent] = useState<McpAgent>("claude");

  const issue = trpc.tokens.issue.useMutation({
    onSuccess: (res) => {
      setFresh(res.plaintext);
      utils.tokens.list.invalidate();
      utils.onboarding.status.invalidate();
    },
  });

  const completed = status.data?.completed ?? false;
  // The connector path mints its own key in the browser sign-in, so the only
  // place a key is created by hand is the read-only branch below.
  const token = fresh ?? "<your-key>";

  return (
    <div>
      <Step
        n={1}
        title="Bring your brain local"
        done={completed}
        current={!completed}
      >
        <p className="mb-2 text-sm font-medium text-foreground">{howTo("connector")}</p>
        <CodeBlock text={command("connector", token)} />
        <p className="mt-2 text-sm text-muted-foreground">
          Now your brain lives as real files on your machine. Read and edit them
          with anything - Claude Code, Cursor, Codex, even a plain text editor.
          Anything you save flows back automatically, and search works
          instantly. Run `sync` again whenever someone shares a new folder.
        </p>

        <div className="mt-4">
          <button
            onClick={() => setShowMcp((v) => !v)}
            className="text-sm text-accent underline-offset-2 hover:underline"
          >
            {showMcp
              ? "Hide read-only setup"
              : "Only want to read, with nothing on your computer? Connect read-only →"}
          </button>
          {showMcp ? (
            <div className="mt-3 rounded-md border border-border bg-secondary/30 p-3">
              <div className="mb-3 flex flex-wrap gap-2">
                {MCP_AGENTS.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => setMcpAgent(a.id)}
                    className={`rounded-full px-3 py-1 text-sm transition-colors ${
                      mcpAgent === a.id
                        ? "text-white [background:var(--grad-warm)]"
                        : "bg-secondary text-secondary-foreground hover:bg-secondary/70"
                    }`}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
              <p className="mb-2 text-sm font-medium text-foreground">{howTo(mcpAgent)}</p>
              {fresh ? (
                <div className="mb-2">
                  <Badge tone="read">Copy it now - you only see it once</Badge>
                </div>
              ) : (
                <div className="mb-2">
                  <Button
                    size="sm"
                    onClick={() => issue.mutate()}
                    disabled={issue.isPending}
                  >
                    <KeyRound className="size-4" /> Create a key
                  </Button>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Read-only needs a key in the command below. Make one and
                    we&apos;ll drop it in.
                  </p>
                </div>
              )}
              <CodeBlock text={command(mcpAgent, token)} />
              <p className="mt-2 text-sm text-muted-foreground">
                Your AI can read and search the folders you can access. Nothing
                gets copied, nothing changes. Want to edit too? Use the option
                above instead.
              </p>
            </div>
          ) : null}
        </div>
      </Step>

      <Step n={2} title="You're in" done={completed} current={false} last>
        <p className="text-sm text-muted-foreground">
          {completed
            ? "All set. Ask your AI to search your brain or open any file."
            : "This ticks itself the moment your AI connects."}
        </p>
      </Step>
    </div>
  );
}

function Step({
  n,
  title,
  done,
  current,
  last,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  current: boolean;
  last?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`relative flex gap-4 ${!done && !current ? "opacity-55" : ""}`}>
      <div className="flex flex-col items-center">
        <span
          className={`grid size-7 shrink-0 place-items-center rounded-md text-xs font-bold transition-colors ${
            done
              ? "text-white [background:var(--grad-warm)]"
              : current
                ? "border-[1.5px] border-accent text-accent"
                : "border border-border-strong text-muted-foreground"
          }`}
        >
          {done ? <Check className="size-4" /> : n}
        </span>
        {!last && <span className="my-1 w-px flex-1 bg-border" />}
      </div>
      <div className="flex-1 pb-6 pt-0.5">
        <h3 className="mb-2 font-display text-lg">{title}</h3>
        {children}
      </div>
    </div>
  );
}
