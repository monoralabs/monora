import "server-only";

/**
 * Dev-only "fake inbox". In development we never hit Resend (no verified
 * sending reputation, and we don't want to spam real addresses), so every email
 * the app would send is captured here instead. A CLI harness reads it back over
 * /api/dev/outbox to close the feedback loop: request an OTP, pull the code from
 * the outbox, sign in - no real mailbox, no SMTP, fully automatable.
 *
 * Stored on globalThis so it survives Next's module reloads in dev and is the
 * same array across route handlers and server actions in one process.
 */
export type CapturedEmail = {
  id: number;
  at: string;
  to: string;
  subject: string;
  text: string;
  html: string | null;
  /** What kind of email this is, for easy filtering in the harness. */
  kind: "invitation" | "verification" | "magic-link" | "otp" | "reset" | "other";
  /** Extracted code/link when relevant, so the harness doesn't parse bodies. */
  otp?: string;
  url?: string;
};

type Store = { seq: number; items: CapturedEmail[] };

const KEY = "__monora_dev_outbox__";
const g = globalThis as unknown as Record<string, Store | undefined>;
const store: Store = (g[KEY] ??= { seq: 0, items: [] });

const MAX = 200;

export function captureEmail(email: Omit<CapturedEmail, "id" | "at">): CapturedEmail {
  const entry: CapturedEmail = {
    ...email,
    id: ++store.seq,
    at: new Date().toISOString(),
  };
  store.items.push(entry);
  if (store.items.length > MAX) store.items.splice(0, store.items.length - MAX);
  // Keep the terminal breadcrumb too - handy without the harness.
  const hint = entry.otp ? ` otp=${entry.otp}` : entry.url ? ` url=${entry.url}` : "";
  console.log(`[DEV outbox] -> ${entry.to}: ${entry.subject}${hint}`);
  return entry;
}

export function getOutbox(): CapturedEmail[] {
  return store.items;
}

export function clearOutbox(): void {
  store.items = [];
}
