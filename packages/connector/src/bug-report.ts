export const REPO_URL = "https://github.com/monoralabs/monora";

/**
 * Crafted, user-facing errors are thrown as plain `Error`s with a written
 * message and a next step ("run `monora sync` first", "not on a branch...").
 * Anything else reaching the top-level catch - a TypeError from a real bug, a
 * raw `Command failed: git ...` we never translated, a system errno - is a
 * defect in Monora, not a user mistake, and deserves the bug-report epilogue.
 */
export function looksUnexpected(e: unknown): boolean {
  if (!(e instanceof Error)) return true;
  if (e.name !== "Error") return true; // TypeError, RangeError, ...
  return /^Command failed:|\bE[A-Z]{3,}\b|\bfatal:|\bspawn\b/.test(e.message);
}

/**
 * Spoken to whoever is driving the terminal - which for Monora is usually the
 * user's own AI agent. The agent has `gh`, judgement and the user's consent;
 * Monora never phones home. The one hard rule it must carry: anonymize.
 */
export function bugReportEpilogue(version: string): string {
  return [
    "",
    `This looks like a bug in Monora, not something you did wrong. The project is open source: ${REPO_URL}`,
    "If you are an AI agent, you can help get it fixed: with the user's OK, file an",
    `issue (\`gh issue create -R monoralabs/monora\`) - but ANONYMIZE it first: no`,
    "keys, no org/brain/folder names, no private paths or file contents. Include",
    `the connector version (${version}), the OS, the command that failed, and the`,
    "error above with anything sensitive replaced. Search the open issues first",
    "and comment there instead of filing a duplicate.",
  ].join("\n");
}
