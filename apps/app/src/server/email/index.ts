import "server-only";
import { Resend } from "resend";
import { env } from "@/env";
import { captureEmail, type CapturedEmail } from "@/server/dev-outbox";

/**
 * Single place that talks to Resend. Every transactional email (invitation,
 * email verification, password reset, magic link, OTP) is built and sent from
 * here, so the rendered look and the error handling stay in one spot.
 *
 * Design rules for the HTML live in ./CLAUDE.md - read it before touching a
 * template. The short version: every email is the same on-brand card
 * (`layout()`), colors are the brand tokens copied below, layout is tables +
 * inline styles (email clients strip <style> and don't do flex/grid).
 *
 * The old inline `resend.emails.send(...)` calls in server/auth swallowed
 * failures (the Resend `error` was never checked) AND skipped this card, so
 * prod sent unstyled plain-text emails that also looked successful on a 403 /
 * bounce / rate limit. `send()` below checks `error` and throws, and routes
 * dev through the outbox, so callers just pick a template.
 */
const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;
const isDev = env.NODE_ENV === "development";
const FROM = env.EMAIL_FROM ?? "Monora <noreply@monora.ai>";

export type SendResult = { id: string | null; skipped: boolean };

async function send(opts: {
  to: string;
  subject: string;
  html: string;
  text: string;
  kind?: CapturedEmail["kind"];
  url?: string;
  otp?: string;
}): Promise<SendResult> {
  if (isDev || !resend) {
    // No Resend (dev, or self-host without RESEND_API_KEY): capture into the
    // outbox so the link/code is readable from logs without a real mailbox.
    if (!isDev && !resend) {
      console.warn(
        "[email] RESEND_API_KEY unset; email captured to outbox, not delivered",
      );
    }
    captureEmail({
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
      kind: opts.kind ?? "other",
      url: opts.url,
      otp: opts.otp,
    });
    return { id: null, skipped: true };
  }
  const { data, error } = await resend.emails.send({
    from: FROM,
    to: [opts.to],
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
  });
  if (error) {
    // Surface the real reason instead of pretending it sent.
    throw new Error(
      `Resend rejected "${opts.subject}" to ${opts.to}: ${
        error.message ?? JSON.stringify(error)
      }`,
    );
  }
  return { id: data?.id ?? null, skipped: false };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* -------------------------------------------------------------------------- */
/* Brand tokens + shared building blocks                                       */
/*                                                                             */
/* Hex values are copied from packages/brand/tokens.css (email can't @import   */
/* CSS, so they're inlined). If a token changes there, change it here too.     */
/* -------------------------------------------------------------------------- */

const CREAM = "#FBF7F0"; // --cream: page + footer background
const CARD = "#FFFFFF"; // card surface
const BORDER = "#EFE7DA"; // hairline borders
const INK = "#1E1B17"; // --ink: primary text
const MUTED = "#5B554D"; // secondary text
const CORAL = "#E2613E"; // --accent: buttons, the header rule
const BRICK = "#C0392B"; // --grad-text end: links (never amber on text)
const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Lead paragraph (16px, ink). The headline of the message. */
const lead = (html: string) =>
  `<p style="margin:0 0 14px;font-size:16px;line-height:1.5;color:${INK};">${html}</p>`;

/** Supporting paragraph (14px, muted). Context under the lead. */
const sub = (html: string) =>
  `<p style="margin:0 0 26px;font-size:14px;line-height:1.6;color:${MUTED};">${html}</p>`;

/** The top content block - lead + sub paragraphs sit here. */
const bodyRows = (inner: string) =>
  `<tr><td style="padding:24px 36px 0;">${inner}</td></tr>`;

/** Primary call-to-action. Coral fill, one per email. */
const button = (url: string, label: string) =>
  `<tr><td style="padding:0 36px 26px;">
        <a href="${url}" style="display:inline-block;background:${CORAL};color:#FFFFFF;text-decoration:none;font-size:15px;font-weight:600;padding:13px 26px;border-radius:11px;">${label}</a>
      </td></tr>`;

/** Plain-text fallback link under the button (some clients block buttons). */
const pasteLink = (url: string) =>
  `<tr><td style="padding:0 36px 30px;">
        <p style="margin:0 0 2px;font-size:12px;line-height:1.6;color:${MUTED};">Or paste this link into your browser:</p>
        <a href="${url}" style="font-size:12px;line-height:1.6;color:${BRICK};word-break:break-all;">${url}</a>
      </td></tr>`;

/** Big monospace one-time code in a cream pill. Used by OTP only. */
const codeBlock = (code: string) =>
  `<tr><td style="padding:4px 36px 28px;">
        <div style="display:inline-block;background:${CREAM};border:1px solid ${BORDER};border-radius:12px;padding:14px 8px 14px 22px;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:30px;font-weight:700;letter-spacing:0.32em;color:${INK};">${code}</div>
      </td></tr>`;

/**
 * The on-brand card shell every email shares: cream page, white rounded card,
 * Monora wordmark + coral rule header, caller's `inner` rows, then a footer
 * note. Keep ALL email-specific content in `inner`; only the footer text and
 * the rows differ between emails.
 */
function layout(opts: { inner: string; footerNote: string }): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${CREAM};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CREAM};padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:440px;background:${CARD};border:1px solid ${BORDER};border-radius:22px;overflow:hidden;font-family:${FONT};">
        <tr><td style="padding:34px 36px 0;">
          <div style="font-family:'Playfair Display',Georgia,serif;font-size:25px;font-weight:700;color:${INK};letter-spacing:-0.01em;">Monora</div>
          <div style="height:2px;width:46px;background:${CORAL};border-radius:2px;margin-top:11px;"></div>
        </td></tr>
        ${opts.inner}
        <tr><td style="padding:18px 36px;background:${CREAM};border-top:1px solid ${BORDER};">
          <p style="margin:0;font-size:12px;line-height:1.5;color:${MUTED};">${opts.footerNote}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/* -------------------------------------------------------------------------- */
/* Templates - one send function per email. Each builds text + html and goes   */
/* through send() (dev outbox vs Resend, throws on failure).                    */
/* -------------------------------------------------------------------------- */

/** Send (or resend) an organization invitation. Throws on Resend failure. */
export async function sendInvitationEmail(opts: {
  to: string;
  inviteUrl: string;
  orgName: string;
  inviterName: string;
}): Promise<SendResult> {
  const orgName = escapeHtml(opts.orgName);
  const inviterName = escapeHtml(opts.inviterName);
  const url = escapeHtml(opts.inviteUrl);
  const html = layout({
    inner:
      bodyRows(
        lead(
          `<strong>${inviterName}</strong> invited you to join <strong>${orgName}</strong> on Monora.`,
        ) +
          sub(
            "Monora gives your team one local working tree with only the folders you're allowed to see. Accept to get started.",
          ),
      ) +
      button(url, "Accept invitation") +
      pasteLink(url),
    footerNote: "If you didn't expect this, you can safely ignore this email.",
  });
  return send({
    to: opts.to,
    subject: `${opts.inviterName} invited you to ${opts.orgName} on Monora`,
    html,
    text: `${opts.inviterName} invited you to join ${opts.orgName} on Monora.\n\nAccept the invitation: ${opts.inviteUrl}\n\nIf you didn't expect this, you can ignore this email.`,
    kind: "invitation",
    url: opts.inviteUrl,
  });
}

/** Branded "confirm your email" for self-serve email+password signups. */
export async function sendVerificationEmail(opts: {
  to: string;
  verifyUrl: string;
}): Promise<SendResult> {
  const url = escapeHtml(opts.verifyUrl);
  const html = layout({
    inner:
      bodyRows(
        lead("Confirm your email to finish setting up Monora.") +
          sub(
            "Tap the button below to verify this address. The link expires shortly.",
          ),
      ) +
      button(url, "Confirm email") +
      pasteLink(url),
    footerNote:
      "If you didn't create a Monora account, you can safely ignore this email.",
  });
  return send({
    to: opts.to,
    subject: "Confirm your email for Monora",
    html,
    text: `Confirm your email for Monora:\n\n${opts.verifyUrl}\n\nIf you didn't create an account, you can ignore this email.`,
    kind: "verification",
    url: opts.verifyUrl,
  });
}

/** One-time sign-in / verification code (email OTP plugin). */
export async function sendOtpEmail(opts: {
  to: string;
  otp: string;
}): Promise<SendResult> {
  const code = escapeHtml(opts.otp);
  const html = layout({
    inner:
      bodyRows(
        lead("Here's your Monora sign-in code.") +
          sub("Enter it in the tab you started from. It expires in 10 minutes."),
      ) + codeBlock(code),
    footerNote:
      "If you didn't request this code, you can safely ignore this email.",
  });
  return send({
    to: opts.to,
    subject: `Your Monora code: ${opts.otp}`,
    html,
    text: `Your Monora sign-in code is ${opts.otp}\n\nIt expires in 10 minutes. If you didn't request it, you can ignore this email.`,
    kind: "otp",
    otp: opts.otp,
  });
}

/** Passwordless sign-in link (magic link plugin). */
export async function sendMagicLinkEmail(opts: {
  to: string;
  signInUrl: string;
}): Promise<SendResult> {
  const url = escapeHtml(opts.signInUrl);
  const html = layout({
    inner:
      bodyRows(
        lead("Sign in to Monora.") +
          sub(
            "Tap the button below to sign in. The link works once and expires shortly.",
          ),
      ) +
      button(url, "Sign in") +
      pasteLink(url),
    footerNote:
      "If you didn't try to sign in, you can safely ignore this email.",
  });
  return send({
    to: opts.to,
    subject: "Sign in to Monora",
    html,
    text: `Sign in to Monora:\n\n${opts.signInUrl}\n\nThe link works once and expires shortly. If you didn't request it, you can ignore this email.`,
    kind: "magic-link",
    url: opts.signInUrl,
  });
}

/** Password reset link (email+password plugin). */
export async function sendPasswordResetEmail(opts: {
  to: string;
  resetUrl: string;
}): Promise<SendResult> {
  const url = escapeHtml(opts.resetUrl);
  const html = layout({
    inner:
      bodyRows(
        lead("Reset your Monora password.") +
          sub(
            "Tap the button below to choose a new password. The link expires shortly.",
          ),
      ) +
      button(url, "Reset password") +
      pasteLink(url),
    footerNote:
      "If you didn't request this, you can safely ignore this email - your password won't change.",
  });
  return send({
    to: opts.to,
    subject: "Reset your Monora password",
    html,
    text: `Reset your Monora password:\n\n${opts.resetUrl}\n\nIf you didn't request this, you can ignore this email - your password won't change.`,
    kind: "reset",
    url: opts.resetUrl,
  });
}
