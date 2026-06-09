import { describe, it, expect } from "vitest";
import { isHelpInvocation, isHelpToken, helpText } from "../help";

describe("isHelpInvocation - asking for help must never run a command", () => {
  it("treats a bare `monora` (no command) as help", () => {
    expect(isHelpInvocation([], undefined, undefined)).toBe(true);
  });

  it("catches the `help` subcommand", () => {
    expect(isHelpInvocation(["help"], "help", undefined)).toBe(true);
    expect(isHelpInvocation(["help", "save"], "help", undefined)).toBe(true);
  });

  it("catches `--help` / `-h` after a command (the parsed flag)", () => {
    expect(isHelpInvocation(["save", "--help"], "save", true)).toBe(true);
    expect(isHelpInvocation(["save", "-h"], "save", true)).toBe(true);
  });

  it("catches `save -m --help` - the real footgun (help swallowed into -m)", () => {
    // parseArgs assigns "--help" as the message, so values.help is false; the
    // raw-args scan must still catch it and NOT run a destructive save.
    expect(isHelpInvocation(["save", "-m", "--help"], "save", false)).toBe(true);
  });

  it("catches `save -- --help` (help as a positional)", () => {
    expect(isHelpInvocation(["save", "--", "--help"], "save", false)).toBe(true);
  });

  it("does NOT treat a quoted message containing --help as a help request", () => {
    // One argv entry, not a bare token -> a real save with that message.
    expect(isHelpInvocation(["save", "-m", "fix the --help output"], "save", false)).toBe(false);
  });

  it("does NOT fire for an ordinary save", () => {
    expect(isHelpInvocation(["save", "-m", "tidy up"], "save", false)).toBe(false);
    expect(isHelpInvocation(["sync"], "sync", false)).toBe(false);
  });
});

describe("isHelpToken - a help token fumbled into the commit message", () => {
  it("flags bare help tokens", () => {
    for (const m of ["--help", "-h", "help", "  --help  ", "HELP"]) {
      expect(isHelpToken(m)).toBe(true);
    }
  });
  it("passes real messages through", () => {
    for (const m of ["fix --help output", "help the user", "update", undefined, ""]) {
      expect(isHelpToken(m)).toBe(false);
    }
  });
});

describe("helpText", () => {
  it("returns the per-command line for a known command", () => {
    expect(helpText("save")).toMatch(/monora save/);
    expect(helpText("collapse")).toMatch(/Fold a folder/);
  });
  it("falls back to the full command list", () => {
    const out = helpText();
    expect(out).toMatch(/usage: monora <command>/);
    expect(out).toMatch(/sync/);
    expect(out).toMatch(/collapse/);
  });
});
