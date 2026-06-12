import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  telemetryDisabled,
  firstRunNotice,
  scrubForTelemetry,
  reportCrash,
  reportUnexpected,
  flushTelemetry,
  resetTelemetryForTests,
  TELEMETRY_NOTICE,
} from "../telemetry";

describe("telemetry (anonymous crash reports)", () => {
  it("honors MONORA_TELEMETRY=0 and the DO_NOT_TRACK convention", () => {
    expect(telemetryDisabled({})).toBe(false);
    expect(telemetryDisabled({ MONORA_TELEMETRY: "0" })).toBe(true);
    expect(telemetryDisabled({ MONORA_TELEMETRY: "off" })).toBe(true);
    expect(telemetryDisabled({ DO_NOT_TRACK: "1" })).toBe(true);
    expect(telemetryDisabled({ DO_NOT_TRACK: "0" })).toBe(false);
  });

  it("shows the notice exactly once per machine, and never when disabled", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "monora-telemetry-"));
    try {
      expect(await firstRunNotice(dir, {})).toBe(TELEMETRY_NOTICE);
      expect(await firstRunNotice(dir, {})).toBeNull(); // second run: silent
      const dir2 = await mkdtemp(path.join(tmpdir(), "monora-telemetry-"));
      expect(await firstRunNotice(dir2, { MONORA_TELEMETRY: "0" })).toBeNull();
      await rm(dir2, { recursive: true, force: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("scrubs tokens and strips every path to its basename", () => {
    const scrubbed = scrubForTelemetry(
      "Command failed: git -c http.extraHeader=Authorization: Bearer mna_secret123 " +
        "-C /Users/javier/dev/dreamshot/skills/quotation push " +
        "and C:\\Users\\estefania\\brains\\dreamshot\\sales too",
    );
    expect(scrubbed).not.toContain("mna_secret123");
    expect(scrubbed).not.toContain("/Users/javier");
    expect(scrubbed).not.toContain("dreamshot");
    expect(scrubbed).not.toContain("estefania");
    expect(scrubbed).toContain(".../quotation");
  });

  it("sends a scrubbed envelope with version/OS/command tags only", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: { body?: unknown }) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const err = new Error(
      "ENOENT: no such file, open '/Users/javier/dev/monora-brains/dreamshot/sales/x.md' (token mna_abc)",
    );
    await reportCrash(err, { version: "0.1.22", command: "save", fetchImpl }, {});

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("ingest.de.sentry.io/api/");
    expect(calls[0]!.url).toContain("sentry_key=");
    const body = calls[0]!.body;
    expect(body).toContain('"release":"monora-connector@0.1.22"');
    expect(body).toContain('"command":"save"');
    expect(body).not.toContain("mna_abc");
    expect(body).not.toContain("/Users/javier");
    expect(body).not.toContain("dreamshot");
    // Nothing that names the machine or the person.
    expect(body).not.toContain("server_name");
    expect(body).not.toContain('"user"');
  });

  it("sends nothing when disabled, and never throws on network failure", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await reportCrash(new Error("x"), { version: "v", fetchImpl }, { MONORA_TELEMETRY: "0" });
    expect(fetchImpl).not.toHaveBeenCalled();

    const failing = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(
      reportCrash(new Error("x"), { version: "v", fetchImpl: failing }, {}),
    ).resolves.toBeUndefined();
  });
});

describe("reportUnexpected + flushTelemetry (per-folder coverage)", () => {
  beforeEach(() => resetTelemetryForTests());

  function spyFetch() {
    const calls: string[] = [];
    const impl = (async (_url: unknown, init?: { body?: unknown }) => {
      calls.push(String(init?.body));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, impl };
  }

  it("reports a real defect from a swallowed catch, once per distinct failure", async () => {
    const { calls, impl } = spyFetch();
    const raw = new Error("Command failed: git -C /x push");
    reportUnexpected(raw, { command: "save", operation: "saveEntry", fetchImpl: impl }, {});
    reportUnexpected(raw, { command: "save", operation: "saveEntry", fetchImpl: impl }, {}); // same folder-class failure again
    reportUnexpected(raw, { command: "sync", operation: "syncEntry", fetchImpl: impl }, {}); // distinct operation
    await flushTelemetry();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('"operation":"saveEntry"');
    expect(calls[1]).toContain('"operation":"syncEntry"');
  });

  it("never reports expected user-state errors", async () => {
    const { calls, impl } = spyFetch();
    reportUnexpected(
      new Error("not on a branch (detached HEAD) - check out a branch (usually main) and re-run"),
      { command: "save", operation: "saveEntry", fetchImpl: impl },
      {},
    );
    await flushTelemetry();
    expect(calls).toHaveLength(0);
  });

  it("respects the opt-out from swallowed-catch sites too", async () => {
    const { calls, impl } = spyFetch();
    reportUnexpected(
      new TypeError("boom"),
      { command: "save", operation: "saveEntry", fetchImpl: impl },
      { MONORA_TELEMETRY: "0" },
    );
    await flushTelemetry();
    expect(calls).toHaveLength(0);
  });

  it("flushTelemetry is a no-op when nothing reported and bounded when something hangs", async () => {
    await expect(flushTelemetry()).resolves.toBeUndefined(); // empty: instant
    const hanging = (async () => new Promise(() => {})) as unknown as typeof fetch;
    reportUnexpected(new TypeError("hang"), { command: "sync", operation: "syncEntry", fetchImpl: hanging }, {});
    const t0 = Date.now();
    await flushTelemetry(200);
    expect(Date.now() - t0).toBeLessThan(2000); // bounded by maxMs, not by the hang
  });
});
