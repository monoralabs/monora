# Best practices for an AI-ready company brain

Monora is read and written by both people and AI agents. A brain that agents work well
in is also one people navigate easily. The rules are simple.

## Structure for access, not just for tidiness

- **The folder is the unit of access.** Draw folder boundaries where *access* differs,
  not just where topics differ. If finance must be founders-only, finance is its own
  folder. If a client is confidential, that client is its own folder.
- **Smaller folders = finer control.** There's no per-file permission. Need to share
  half of something? Split it into two folders.
- **Keep the structure shallow and predictable.** `departments/<dept>`, `work/<client>`,
  `data/<kind>`. Agents (and people) guess where things live when names are consistent.

## Write for both readers

- **Markdown, one topic per file.** It's the substrate - diffable, reviewable, editable
  by an agent.
- **Lowercase-kebab-case filenames.** No spaces, no ALL-CAPS (except `README.md`).
- **State decisions and the *why*,** not just conclusions. Agents reason better with the
  rationale; future-you does too.
- **Cross-link** related files with relative links so an agent can follow the thread.
- **A short `README.md` per folder** that says what's inside and where to start pays for
  itself every time someone (or something) lands there cold.

## Keep the brain clean

- **No secrets.** API keys, tokens, `.env` files never go in. They're auto-excluded on
  ingest, and a leak is a real incident. See [sharing-secrets.md](sharing-secrets.md).
- **No heavy binaries** (video, big image sets) for now - they bloat git history until
  the asset store lands. Link to them instead.
- **No build junk** (`node_modules`, `__pycache__`, `.DS_Store`) - also auto-excluded,
  but don't rely on it; keep sources clean.

## Editing with an agent

Point your agent at your synced workspace. It sees only your authorized folders, so it
literally cannot read what you can't. When it's done, review the diff and `git push`
the folders you have `write` on - same as any code review.
