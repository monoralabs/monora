import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { defaultConfigPath } from "./config";
import { redactSecrets } from "./sync";

/**
 * Anonymous crash reporting - the second channel of the error-reporting
 * decision (org/product-development/error-reporting.md). Three hard rules:
 *
 *  1. Disclosed: a one-time notice prints before anything is ever sent, and
 *     `MONORA_TELEMETRY=0` / the cross-tool `DO_NOT_TRACK` switch it off.
 *  2. Only real defects: callers gate on `looksUnexpected()` - an expected
 *     "no access" / "resolve the conflict" never leaves the machine.
 *  3. Auditable: no SDK. This file IS the complete client - a single fetch
 *     of a Sentry envelope - so anyone can read exactly what is sent:
 *     version, OS, node version, subcommand, and the error with secrets
 *     redacted and every filesystem path stripped to its basename.
 */

/** Publishable ingest key: it can only submit events, never read them. */
const SENTRY_DSN =
  "https://b509faeb92dd5657e77292049f935f88@o4511552869564416.ingest.de.sentry.io/4511552914587728";

export function telemetryDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const t = env.MONORA_TELEMETRY;
  if (t === "0" || t === "false" || t === "off") return true;
  const dnt = env.DO_NOT_TRACK;
  return dnt !== undefined && dnt !== "" && dnt !== "0";
}

export const TELEMETRY_NOTICE = [
  "One-time note: if Monora ever crashes, it sends an anonymous error report",
  "(version, OS, the error - never your files, folder names or paths) so we",
  "can fix it. Turn it off any time: MONORA_TELEMETRY=0",
].join("\n");

/** Print-once bookkeeping. Returns the notice text exactly one time per
 *  machine (and never when telemetry is off), null afterwards. */
export async function firstRunNotice(
  configDir: string = path.dirname(defaultConfigPath()),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (telemetryDisabled(env)) return null;
  const marker = path.join(configDir, "telemetry.json");
  const seen = await readFile(marker, "utf8").catch(() => null);
  if (seen !== null) return null;
  await mkdir(configDir, { recursive: true });
  await writeFile(
    marker,
    JSON.stringify({ noticeShownAt: new Date().toISOString() }, null, 2) + "\n",
  ).catch(() => {});
  return TELEMETRY_NOTICE;
}

/** Strip everything that could identify the machine or the brain: secrets
 *  (tokens), then every absolute path - POSIX or Windows - down to its
 *  basename. Org/brain/folder names ride inside paths, so this drops them. */
export function scrubForTelemetry(text: string): string {
  return redactSecrets(text)
    .replace(/(?:[A-Za-z]:)?(?:[\\/][^\s:'")(,]+)+[\\/]?/g, (m) => {
      const base = m.split(/[\\/]/).filter(Boolean).pop() ?? "";
      return `.../${base}`;
    });
}

interface CrashContext {
  version: string;
  /** The subcommand only ("save", "sync") - never the full argv. */
  command?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Fire-and-forget a crash event to Sentry's envelope endpoint. Never throws,
 * never blocks longer than 3s - a failed report must not worsen the crash.
 */
export async function reportCrash(
  e: unknown,
  ctx: CrashContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (telemetryDisabled(env)) return;
  try {
    const dsn = new URL(SENTRY_DSN);
    const projectId = dsn.pathname.replace(/\//g, "");
    const endpoint =
      `${dsn.protocol}//${dsn.host}/api/${projectId}/envelope/` +
      `?sentry_version=7&sentry_key=${dsn.username}&sentry_client=monora-connector%2F${ctx.version}`;

    const err = e instanceof Error ? e : new Error(String(e));
    const eventId = [...crypto.getRandomValues(new Uint8Array(16))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const now = new Date().toISOString();
    const event = {
      event_id: eventId,
      timestamp: now,
      platform: "node",
      level: "error",
      release: `monora-connector@${ctx.version}`,
      environment: "production",
      // No server_name, no user, no IP: the event carries nothing that names
      // the machine or the person.
      tags: {
        os: `${os.platform()} ${os.release()}`,
        node: process.version,
        ...(ctx.command ? { command: ctx.command } : {}),
      },
      exception: {
        values: [
          {
            type: err.name,
            value: scrubForTelemetry(err.message),
          },
        ],
      },
      extra: err.stack ? { stack: scrubForTelemetry(err.stack) } : {},
    };
    const envelope =
      JSON.stringify({ event_id: eventId, sent_at: now }) +
      "\n" +
      JSON.stringify({ type: "event" }) +
      "\n" +
      JSON.stringify(event) +
      "\n";

    const doFetch = ctx.fetchImpl ?? fetch;
    await doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope" },
      body: envelope,
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Telemetry is best-effort by definition.
  }
}
