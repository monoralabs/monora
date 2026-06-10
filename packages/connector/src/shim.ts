import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Self-install: after a successful login, drop a tiny `monora` shim into
 * `~/.local/bin` so the command works everywhere from then on. The shim
 * delegates to npx, so every run uses the latest published connector -
 * no global npm install (no sudo, no EACCES) and nothing to keep updated.
 *
 * A marker line identifies the file as ours; anything else at that path
 * (a real global install, a user script) is never touched.
 */

export const SHIM_MARKER = "# monora shim";
const MARKER = SHIM_MARKER;

// The recursion guard matters: if npx ever fails to resolve the package bin
// (e.g. run from inside the connector source tree, where npm matches the
// local project and finds no built bin), npm falls back to `monora` on PATH,
// which is this shim again. Without the guard that is a fork bomb.
//
// Parameterized by spec so `monora update` can re-pin the shim to an exact
// version: a pinned spec makes npx hit its cache (fast, deterministic, and
// immune to the stale-bare-spec cache problem); the next update moves the pin.
export function shimBody(spec = "@monora-ai/connector"): string {
  return `#!/bin/sh
${MARKER} - runs the connector via npx. Safe to delete; \`monora login\` recreates it.
if [ -n "$MONORA_SHIM" ]; then
  echo "monora: npx could not resolve the connector here (running inside its source tree?)." >&2
  echo "Try again from another directory, or run: npx -y ${spec}" >&2
  exit 1
fi
MONORA_SHIM=1 exec npx -y ${spec} "$@"
`;
}

const SHIM_BODY = shimBody();

export interface ShimResult {
  status: "installed" | "updated" | "unchanged" | "skipped-foreign" | "skipped-platform";
  shimPath: string;
  binDir: string;
  /** Whether `binDir` is already on PATH (false means the user needs one more step). */
  onPath: boolean;
}

export function defaultBinDir(): string {
  return path.join(homedir(), ".local", "bin");
}

export async function installShim(
  opts: { binDir?: string; envPath?: string; platform?: NodeJS.Platform } = {},
): Promise<ShimResult> {
  const platform = opts.platform ?? process.platform;
  const binDir = opts.binDir ?? defaultBinDir();
  const shimPath = path.join(binDir, "monora");
  const envPath = opts.envPath ?? process.env.PATH ?? "";
  const onPath = envPath.split(path.delimiter).includes(binDir);

  // POSIX shims only; on Windows npx already leaves a usable `monora.cmd`
  // when installed, and a sh script would not run.
  if (platform === "win32") {
    return { status: "skipped-platform", shimPath, binDir, onPath };
  }

  const existing = await readFile(shimPath, "utf8").catch(() => null);
  if (existing !== null && !existing.includes(MARKER)) {
    return { status: "skipped-foreign", shimPath, binDir, onPath };
  }
  if (existing !== null) {
    // Ours already - possibly pinned to an exact version by `monora update`.
    // Leave the content alone (a login must not roll a pin back to a bare
    // spec); just re-assert the exec bit (a previous write may have been
    // umask-narrowed).
    await chmod(shimPath, 0o755);
    return { status: "unchanged", shimPath, binDir, onPath };
  }

  await mkdir(binDir, { recursive: true });
  await writeFile(shimPath, SHIM_BODY);
  await chmod(shimPath, 0o755);
  return {
    status: existing === null ? "installed" : "updated",
    shimPath,
    binDir,
    onPath,
  };
}
