import { describe, it, expect } from "vitest";
import { looksUnexpected, bugReportEpilogue, REPO_URL } from "../bug-report";

describe("bug-report epilogue (agent-facing issue instructions)", () => {
  it("crafted user-facing errors are NOT bugs", () => {
    expect(looksUnexpected(new Error("no Monora workspace here (run `monora sync` first)"))).toBe(false);
    expect(looksUnexpected(new Error("not on a branch (detached HEAD) - check out a branch (usually main) and re-run"))).toBe(false);
    expect(looksUnexpected(new Error("you have read-only access to acme/alpha - your changes are committed locally and kept, but can't be applied to the brain. Ask an org admin for write access."))).toBe(false);
  });

  it("real defects ARE bugs: wrong types, raw git, system errnos", () => {
    expect(looksUnexpected(new TypeError("Cannot read properties of undefined (reading 'entries')"))).toBe(true);
    expect(looksUnexpected(new Error("Command failed: git -C /x push"))).toBe(true);
    expect(looksUnexpected(new Error("ENOENT: no such file or directory, open '/x/manifest.json'"))).toBe(true);
    expect(looksUnexpected(new Error("fatal: not a git repository"))).toBe(true);
    expect(looksUnexpected("a bare string throw")).toBe(true);
  });

  it("the epilogue tells the agent to anonymize, where to file, and to dedupe", () => {
    const text = bugReportEpilogue("0.1.21");
    expect(text).toContain(REPO_URL);
    expect(text).toContain("ANONYMIZE");
    expect(text).toContain("gh issue create");
    expect(text).toContain("0.1.21");
    expect(text).toMatch(/duplicate/i);
    expect(text).toMatch(/user's OK/i); // the agent asks, Monora never phones home
  });
});
