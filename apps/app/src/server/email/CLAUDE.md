# Transactional emails - design + how to add one

Every email the product sends (invitation, email verification, password reset,
magic link, OTP) is built and sent from `index.ts`. They all share one on-brand
look. Read this before adding or editing a template.

## The rules (why emails are written the weird way they are)

Email clients are not browsers. They strip `<style>` blocks, ignore most modern
CSS, and render flex/grid unreliably. So:

- **Table layout, inline styles only.** No `<style>`, no classes, no flex/grid.
  Structure with `<table role="presentation">`; space with `padding` on `<td>`.
- **Inline brand hex, don't import.** We can't `@import` the brand CSS, so the
  token values are copied as constants at the top of `index.ts` (`CREAM`, `INK`,
  `CORAL`, ...). They mirror `packages/brand/tokens.css` - **if a token changes
  there, change it here too.** Never invent a color; use a constant.
- **Legibility rule (from brand.md):** amber `#F4A24C` is fills/sun only, never
  on text. Links use brick `#C0392B` (`BRICK`), not amber, not raw blue.
- **Always provide `text`.** Every `send()` takes a plaintext `text` fallback as
  well as `html` - clients that don't render HTML, and the dev outbox harness,
  read it. Keep the link/code in the text version.
- **Wordmark, not logo image.** The header is the "Monora" wordmark in Playfair
  (falls back to Georgia - most clients won't load a web font) plus the coral
  rule. No external image (blocked by default in many clients).

## The shared shell

`layout({ inner, footerNote })` renders the whole card: cream page → white
rounded card → Monora wordmark + coral rule header → your `inner` rows →
footer note. **Put everything email-specific in `inner`.** Only `footerNote`
and the rows change between emails - the chrome never does.

Building blocks for `inner` (compose them, in this order):

| Helper | Use |
|---|---|
| `bodyRows(lead(...) + sub(...))` | the top text block: one `lead` (16px ink headline) + one `sub` (14px muted context) |
| `button(url, label)` | the single coral call-to-action. One per email. |
| `pasteLink(url)` | the "or paste this link" fallback under the button - include it whenever there's a `button` |
| `codeBlock(code)` | big monospace code pill (OTP only) - used instead of a button |

A link email = `bodyRows(...) + button(url, "...") + pasteLink(url)`.
A code email = `bodyRows(...) + codeBlock(code)` (no button/pasteLink).

## Adding a new email

1. Write `export async function sendXEmail(opts): Promise<SendResult>` in
   `index.ts` next to the others.
2. `escapeHtml()` every interpolated value (names, org names, codes, urls).
3. Build `html` with `layout(...)` + the helpers above. Write a matching `text`.
4. Call `send({ to, subject, html, text, kind, url|otp })`.
   - `kind` must be one of `CapturedEmail["kind"]` (`server/dev-outbox.ts`) -
     add a new kind there first if needed.
   - Pass `url` (links) or `otp` (codes) so the dev outbox/e2e harness can read
     it back without parsing the body.
5. **Send through `send()`, never `resend.emails.send()` directly.** `send()`
   routes dev → outbox / prod → Resend and **throws on Resend failure** (a 403,
   bounce, or rate limit). The old inline sends in `server/auth/index.ts`
   swallowed those and skipped this card - that's the bug this module fixes.

## Wiring (where these get called)

Better Auth plugins in `server/auth/index.ts` call these - the email content
lives here, not there:

| Email | Caller |
|---|---|
| invitation | `organization({ sendInvitationEmail })` + `members.resendInvitation` (tRPC) |
| verification | `emailVerification.sendVerificationEmail` |
| password reset | `emailAndPassword.sendResetPassword` |
| magic link | `magicLink({ sendMagicLink })` |
| OTP | `emailOTP({ sendVerificationOTP })` |

## Previewing changes

In dev, nothing hits Resend - emails land in the outbox (`server/dev-outbox.ts`)
and at `GET /api/dev/outbox` (404 outside development). The `html` is captured,
so you can pull it and open it in a browser to eyeball a template without
sending a real email.
