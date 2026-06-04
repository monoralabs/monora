import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import type { RepoName } from "@monora/core";
import { resolveRepoDir } from "./paths";

/** The two git services the smart-HTTP protocol exposes. */
export type GitService = "upload-pack" | "receive-pack";

/** 4-hex length-prefixed pkt-line. Length is the byte count (not UTF-16 code
 *  units), so a multibyte service string still frames correctly. */
function pktLine(s: string): Buffer {
  const len = Buffer.byteLength(s, "utf8") + 4;
  return Buffer.from(len.toString(16).padStart(4, "0") + s, "utf8");
}

/** Hermetic env for every git subprocess: drop ambient host config so a
 *  malicious global alias/filter can't run, and never block on a credential
 *  prompt. When the client negotiated protocol v2 (the Git-Protocol header),
 *  forward it as GIT_PROTOCOL so the fetch isn't silently downgraded to v0. */
function gitEnv(protocol?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    ...(protocol ? { GIT_PROTOCOL: protocol } : {}),
  };
}

function runGit(
  args: string[],
  cwd: string,
  opts: { input?: Buffer; protocol?: string } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: gitEnv(opts.protocol) });
    const out: Buffer[] = [];
    const errBufs: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => errBufs.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else
        reject(
          new Error(
            `git ${args.join(" ")} exited ${code}: ${Buffer.concat(errBufs).toString()}`,
          ),
        );
    });
    if (opts.input) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/**
 * Serves git smart-HTTP over already-authorized bare repos. It performs NO
 * authorization itself - the caller (the proxy) MUST authorize before invoking
 * any method here. Repo paths are still resolved under gitRoot defensively.
 *
 * Buffers stdout (knowledge repos are small); swap to streaming if large
 * binaries land in folders.
 */
export class GitHttp {
  private readonly gitRoot: string;
  constructor(gitRoot: string) {
    this.gitRoot = path.resolve(gitRoot);
  }

  contentType(service: GitService, kind: "advertisement" | "result"): string {
    return `application/x-git-${service}-${kind}`;
  }

  async repoExists(repoName: RepoName): Promise<boolean> {
    try {
      await access(path.join(resolveRepoDir(this.gitRoot, repoName), "HEAD"));
      return true;
    } catch {
      return false;
    }
  }

  /** Body for GET /info/refs?service=git-<service>. */
  async advertiseRefs(
    repoName: RepoName,
    service: GitService,
    protocol?: string,
  ): Promise<Buffer> {
    const dir = resolveRepoDir(this.gitRoot, repoName);
    const refs = await runGit(
      [service, "--stateless-rpc", "--advertise-refs", dir],
      dir,
      { protocol },
    );
    return Buffer.concat([
      pktLine(`# service=git-${service}\n`),
      Buffer.from("0000"),
      refs,
    ]);
  }

  /** Body for POST /git-<service>: feed the client's request, return git's. */
  async rpc(
    repoName: RepoName,
    service: GitService,
    input: Buffer,
    protocol?: string,
  ): Promise<Buffer> {
    const dir = resolveRepoDir(this.gitRoot, repoName);
    return runGit([service, "--stateless-rpc", dir], dir, { input, protocol });
  }
}
