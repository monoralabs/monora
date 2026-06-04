import { NextResponse } from "next/server";
import { env } from "@/env";
import { getOutbox, clearOutbox } from "@/server/dev-outbox";

// Dev-only fake inbox for the e2e harness. 404s outside development so it can
// never leak captured emails in prod.
function guard() {
  return env.NODE_ENV === "development";
}

export async function GET() {
  if (!guard()) return new NextResponse("Not found", { status: 404 });
  return NextResponse.json({ emails: getOutbox() });
}

export async function DELETE() {
  if (!guard()) return new NextResponse("Not found", { status: 404 });
  clearOutbox();
  return NextResponse.json({ ok: true });
}
