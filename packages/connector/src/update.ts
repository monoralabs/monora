import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { defaultBinDir, shimBody, SHIM_MARKER } from "./shim";

const exec = promisify(execFile);

/**
 * `monora update` - bring the connector itself to the latest release, whatever
 * way it was installed. Exists because the install paths go stale in
 * different ways and asking users (or their AI) to diagnose that is exactly
 * the kind of git/npm plumbing this CLI is meant to hide:
 *
 * - the login shim runs `npx -y @monora-ai/connector` and npx CACHES: a bare
 *   spec can keep serving an old version forever. Update warms the cache with
 *   the exact new version and re-pins the shim to it (fast + deterministic).
 * - a real `npm i -g` / `pnpm add -g` install only changes when re-run.
 * - a development checkout (dist/ run via a wrapper) updates via git, not npm.
 */

const PKG = "@monora-ai/connector";

/** The version of THIS running connector, read from the package's own
 *  package.json (works installed, in the npx cache, and in a checkout). */
export async function currentVersion(): Promise<string> {
  const url = new URL("../package.json", import.meta.url);
  const raw = await readFile(url, "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}

/** The latest published version, straight from the npm registry (no npm
 *  binary involved, so this works even where npm is missing). */
export async function latestVersion(fetchFn: typeof fetch = fetch): Promise<string> {
  const res = await fetchFn(`https://registry.npmjs.org/${encodeURIComponent(PKG)}/latest`);
  if (!res.ok) throw new Error(`could not reach the npm registry (HTTP ${res.status})`);
  const body = (await res.json()) as { version?: string };
  if (!body.version) throw new Error("the npm registry returned no version");
  return body.version;
}

export type InstallMode = "npx-shim" | "npm-global" | "pnpm-global" | "local-build";

/** How is this connector installed? Decided from how we were launched. */
export function detectMode(argv1: string, env: NodeJS.ProcessEnv = process.env): InstallMode {
  const segs = argv1.split(/[\\/]/);
  // The login shim exports MONORA_SHIM=1; the npx cache lives under `_npx`.
  if (env.MONORA_SHIM || segs.includes("_npx")) return "npx-shim";
  if (segs.includes("pnpm") && segs.includes("node_modules")) return "pnpm-global";
  if (segs.includes("node_modules")) return "npm-global";
  return "local-build";
}

export interface UpdateOutcome {
  current: string;
  latest: string;
  action: "up-to-date" | "updated-shim" | "updated-global" | "manual";
  /** Human/AI-readable summary of what happened or what to do. */
  detail: string;
}

export interface UpdateDeps {
  fetchFn?: typeof fetch;
  argv1?: string;
  env?: NodeJS.ProcessEnv;
  run?: (cmd: string, args: string[]) => Promise<unknown>;
  shimPath?: string;
}

async function defaultRun(cmd: string, args: string[]): Promise<unknown> {
  return exec(cmd, args, { env: { ...process.env, MONORA_SHIM: "" } });
}

/** Re-point our login shim at the exact new version. A pinned spec makes npx
 *  hit its cache (fast, deterministic); the next `monora update` moves the
 *  pin. A foreign file at the shim path is never touched. */
async function pinShim(version: string, shimPath: string): Promise<boolean> {
  const existing = await readFile(shimPath, "utf8").catch(() => null);
  if (existing === null || !existing.includes(SHIM_MARKER)) return false;
  await writeFile(shimPath, shimBody(`${PKG}@${version}`));
  await chmod(shimPath, 0o755);
  return true;
}

export async function update(deps: UpdateDeps = {}): Promise<UpdateOutcome> {
  const current = await currentVersion();
  const latest = await latestVersion(deps.fetchFn);
  if (current === latest) {
    return {
      current,
      latest,
      action: "up-to-date",
      detail: `already on the latest version (${latest})`,
    };
  }

  const argv1 = deps.argv1 ?? process.argv[1] ?? "";
  const env = deps.env ?? process.env;
  const run = deps.run ?? defaultRun;
  const mode = detectMode(argv1, env);

  if (mode === "npx-shim") {
    // Warm the npx cache with the exact new version (the bare spec the shim
    // used until now can serve a stale cache forever), then pin the shim.
    await run("npx", ["-y", `${PKG}@${latest}`, "--version"]);
    const pinned = await pinShim(latest, deps.shimPath ?? path.join(defaultBinDir(), "monora"));
    return {
      current,
      latest,
      action: "updated-shim",
      detail: pinned
        ? `updated ${current} -> ${latest} (the \`monora\` command now runs ${latest})`
        : `downloaded ${latest}; the \`monora\` command at your shim path is not ours, so it was left untouched - run \`npx -y ${PKG}@${latest}\` directly`,
    };
  }

  if (mode === "npm-global" || mode === "pnpm-global") {
    const args =
      mode === "pnpm-global"
        ? ["add", "-g", `${PKG}@${latest}`]
        : ["install", "-g", `${PKG}@${latest}`];
    await run(mode === "pnpm-global" ? "pnpm" : "npm", args);
    return {
      current,
      latest,
      action: "updated-global",
      detail: `updated ${current} -> ${latest} (global install)`,
    };
  }

  return {
    current,
    latest,
    action: "manual",
    detail:
      `a newer release exists (${current} -> ${latest}), but this \`monora\` runs from a local build (${argv1}). ` +
      `Update the checkout (git pull + build), or install the release: npm i -g ${PKG}@${latest}`,
  };
}
