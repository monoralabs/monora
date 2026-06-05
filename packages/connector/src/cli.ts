#!/usr/bin/env node
import { parseArgs } from "node:util";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { sync } from "./sync";
import { save } from "./save";
import { add } from "./add";
import { restore } from "./restore";
import { doctor, formatReport } from "./doctor";
import { readPending } from "./lifecycle";
import { newBrain } from "./new-brain";
import { deviceLogin } from "./device-login";
import { installShim } from "./shim";
import {
  readCredentials,
  writeCredentials,
  defaultConfigPath,
} from "./config";

const exec = promisify(execFile);

/**
 * The connector CLI.
 *   monora login     --url <proxyUrl>            (browser approval; no token typed)
 *   monora login     --url <proxyUrl> --token <token>   (scripts/CI)
 *   monora sync      [--workspace <dir>] [--no-mcp]
 *   monora save      [-m <message>] [--workspace <dir>]
 *   monora status    [--workspace <dir>]
 *   monora doctor    [--workspace <dir>]
 *   monora new-brain <Name> --from <dir> [--workspace <dir>]
 *
 * `sync` composes the folders you are authorized for into one local tree; run
 * `claude`/`codex` in it. `save` is the way back: it commits and pushes every
 * folder with changes in one step (raw `git push` per folder still works too).
 * It also drops a `.mcp.json` wiring the read-only Monora MCP server (read+write
 * tree and fast search in one step); `--no-mcp` skips it.
 * `new-brain` creates a brain from a local folder (one repo per top-level
 * subdir) and pushes its content - dogfooding the product to load a brain.
 */
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" },
      token: { type: "string" },
      message: { type: "string", short: "m" },
      workspace: { type: "string" },
      config: { type: "string" },
      concurrency: { type: "string" },
      from: { type: "string" },
      name: { type: "string" },
      "include-root": { type: "string" },
      "no-mcp": { type: "boolean" },
      "dry-run": { type: "boolean" },
      force: { type: "boolean" },
    },
  });
  const cmd = positionals[0];
  const configPath = values.config ?? defaultConfigPath();
  const workspace = path.resolve(values.workspace ?? process.cwd());

  if (cmd === "login") {
    if (!values.url) {
      console.error("usage: monora login --url <proxyUrl>");
      process.exit(1);
    }
    // Browser-based device login by default - no token on the command line.
    // `--token` stays supported for scripts/CI that already hold one.
    const token = values.token ?? (await deviceLogin(values.url));
    await writeCredentials({ baseUrl: values.url, token }, configPath);
    console.log(`\nSaved credentials to ${configPath}. You're connected.`);
    // Best effort: leave a `monora` command behind so the next command is
    // just `monora sync`. Never let this fail the login.
    const shim = await installShim().catch(() => null);
    if (shim && (shim.status === "installed" || shim.status === "updated")) {
      console.log(`\nThe \`monora\` command is now on your machine (${shim.shimPath}).`);
      if (shim.onPath) {
        console.log("From now on, just run `monora sync`.");
      } else {
        console.log("One more step - add it to your PATH, then just run `monora sync`:");
        console.log(`  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && exec zsh`);
      }
    }
    return;
  }

  if (cmd === "sync") {
    const creds = await readCredentials(configPath);
    const res = await sync({
      baseUrl: creds.baseUrl,
      token: creds.token,
      workspace,
      concurrency: values.concurrency ? Number(values.concurrency) : undefined,
      writeMcpConfig: !values["no-mcp"],
    });
    for (const m of res.mounted) console.log(`  ${m.action.padEnd(7)} ${m.mountPath}`);
    for (const r of res.removed) console.log(`  removed ${r}`);
    for (const c of res.conflicts)
      console.error(`  CONFLICT ${c.mountPath} (${c.files.join(", ")})`);
    for (const e of res.errors) console.error(`  ERROR   ${e.mountPath}: ${e.error}`);
    if (res.conflicts.length) {
      console.log(
        `\n${res.conflicts.length} folder(s) diverged on the same lines and were left with conflict markers. Resolve them, then re-run.`,
      );
    }
    console.log(
      `\n${res.mounted.length} folder(s) in ${workspace} (${(res.metrics.durationMs / 1000).toFixed(1)}s)` +
        (res.errors.length ? ` - ${res.errors.length} error(s)` : ""),
    );
    process.exit(res.errors.length ? 1 : 0);
  }

  if (cmd === "save") {
    // Creds let `save` reconcile folder lifecycle (create + archive), not just
    // push changes. If you are not logged in, it still does the M pass.
    const creds = await readCredentials(configPath).catch(() => null);
    const res = await save({
      workspace,
      message: values.message,
      concurrency: values.concurrency ? Number(values.concurrency) : undefined,
      baseUrl: creds?.baseUrl,
      token: creds?.token,
      dryRun: values["dry-run"],
      force: values.force,
    });

    if (res.plan) {
      // Dry run: show the reconcile plan, change nothing.
      for (const p of res.plan.create) console.log(`  A  ${p}`);
      for (const p of res.plan.delete) console.log(`  D  ${p}`);
      if (res.guarded.length) {
        console.log(
          `\n${res.guarded.length} folder(s) are gone from disk but would NOT be deleted (looks like the whole workspace is missing). Re-run with --force if you really mean it.`,
        );
      }
      if (!res.plan.create.length && !res.plan.delete.length) {
        console.log("No folders to create or delete.");
      }
      console.log("\nDry run - nothing was changed.");
      return;
    }

    const changed = res.saved.filter((s) => s.action !== "clean");
    for (const c of res.created) console.log(`  A  ${c.mountPath}`);
    for (const s of changed) console.log(`  ${s.action.padEnd(6)} ${s.mountPath}`);
    for (const a of res.archived) console.log(`  D  ${a.mountPath}`);
    for (const c of res.conflicts)
      console.error(`  CONFLICT ${c.mountPath} (${c.files.join(", ")})`);
    for (const e of res.errors) console.error(`  ERROR  ${e.mountPath}: ${e.error}`);

    if (res.conflicts.length) {
      console.log(
        `\n${res.conflicts.length} folder(s) diverged on the same lines and were left with conflict markers. Resolve them (or let your AI), then \`monora save\` again. Everything else was saved.`,
      );
    }

    if (res.guarded.length) {
      console.log(
        `\nGuard: ${res.guarded.length} folder(s) vanished from disk and were NOT deleted (this looks like a broken or wrong workspace). Re-run with --force to archive them anyway.`,
      );
    }
    const touched = res.created.length + changed.length + res.archived.length;
    if (touched === 0 && res.errors.length === 0 && !res.guarded.length) {
      console.log("Nothing to save - everything is already up to date.");
    } else {
      const parts: string[] = [];
      if (res.created.length) parts.push(`created ${res.created.length}`);
      if (changed.length) parts.push(`saved ${changed.length}`);
      if (res.archived.length) parts.push(`deleted ${res.archived.length}`);
      console.log(`\n${parts.join(", ") || "Done"}` + (res.errors.length ? ` (${res.errors.length} error(s))` : ""));
      if (res.archived.length) {
        console.log("Deleted folders are recoverable: `monora restore` lists the trash.");
      }
    }
    process.exit(res.errors.length ? 1 : 0);
  }

  if (cmd === "add") {
    const dir = positionals[1];
    if (!dir) {
      console.error("usage: monora add <dir> [--name <display name>]");
      process.exit(1);
    }
    const create = await add({ workspace, dir, name: values.name });
    console.log(`Staged "${create.mountPath}" as a new folder.`);
    console.log("Run `monora save` to create it on the server and push its content.");
    return;
  }

  if (cmd === "restore") {
    const creds = await readCredentials(configPath);
    const target = positionals[1];
    const res = await restore({ baseUrl: creds.baseUrl, token: creds.token, target });
    if (res.restored) {
      console.log(`Restored ${res.restored.repoName}.`);
      console.log("Run `monora sync` to bring it back into your workspace.");
      return;
    }
    if (res.ambiguous) {
      console.error(`"${target}" matches more than one trashed folder - be more specific:`);
      for (const f of res.ambiguous) console.error(`  ${f.repoName}  (${f.path})`);
      process.exit(1);
    }
    if (target) {
      console.error(`Nothing in the trash matches "${target}".`);
    }
    if (res.archived.length === 0) {
      console.log("The trash is empty.");
    } else {
      console.log("In the trash (restore with `monora restore <name>`):");
      for (const f of res.archived) console.log(`  ${f.path.padEnd(28)} ${f.repoName}`);
    }
    process.exit(target ? 1 : 0);
  }

  if (cmd === "new-brain") {
    // Name comes from the positional (`new-brain "My Brain"`) or --name.
    const name = positionals[1] ?? values.name;
    if (!name || !values.from) {
      console.error(
        'usage: monora new-brain "<Name>" --from <dir> [--workspace <dir>] [--include-root <slug>]',
      );
      process.exit(1);
    }
    const creds = await readCredentials(configPath);
    const res = await newBrain({
      baseUrl: creds.baseUrl,
      token: creds.token,
      name,
      from: values.from,
      workspace,
      includeRoot: values["include-root"],
      log: (line) => console.log(line),
    });
    console.log(
      `\nDone. Brain "${res.brainSlug}" has ${res.pushed.length} folder(s) in ${workspace}.`,
    );
    if (res.skippedRootFiles.length) {
      console.log(
        `Note: ${res.skippedRootFiles.length} loose root file(s) were not ingested (put them in a subfolder to include them).`,
      );
    }
    console.log("Run `monora sync` from your workspace to pick it up everywhere.");
    return;
  }

  if (cmd === "doctor") {
    const report = await doctor({ workspace, configPath });
    for (const line of formatReport(report)) console.log(line);
    process.exit(report.actionable ? 1 : 0);
  }

  if (cmd === "status") {
    const metaRaw = await readFile(
      path.join(workspace, ".monora", "manifest.json"),
      "utf8",
    ).catch(() => null);
    if (!metaRaw) {
      console.error("no Monora workspace here (run `monora sync` first)");
      process.exit(1);
    }
    const meta = JSON.parse(metaRaw) as {
      entries: { mountPath: string }[];
    };
    // Folder-level M/U/D, the mirror of git's file-level status: A = staged new
    // folder, D = indexed folder gone from disk, M = tracked folder with changes.
    const pending = await readPending(workspace);
    for (const c of pending.creates) console.log(`  A      ${c.mountPath}`);
    for (const e of meta.entries) {
      const dest = path.join(workspace, e.mountPath);
      try {
        const { stdout } = await exec("git", ["-C", dest, "status", "--porcelain"]);
        console.log(`  ${stdout.trim() ? "M    " : "clean"}  ${e.mountPath}`);
      } catch {
        // git status failed: either the folder is gone from disk (a deletion,
        // "D") or it is present but not a mounted repo (an odd state, "?").
        const present = await access(dest).then(
          () => true,
          () => false,
        );
        console.log(`  ${present ? "?    " : "D    "}  ${e.mountPath}`);
      }
    }
    return;
  }

  console.error(
    "usage: monora <login|sync|save|status|doctor|add|restore|new-brain> [options]",
  );
  process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
