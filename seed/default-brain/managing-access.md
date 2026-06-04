# Managing access (for admins)

Access in Monora is **per folder**, granted to **people** - never "share with everyone"
by accident. This is how you onboard the team and decide who sees what.

## Onboarding a teammate

1. **Invite** them (Settings → Members → Invite, or the admin CLI `invite`). They get
   an email, accept, and sign in once - that creates their account.
2. **Grant folders.** From the brain's sharing view, give them `read` or `write` on the
   folders they need. Everything you don't grant stays invisible to them.
3. They **create a token** and run `monora login` + `monora sync` (see
   [using-monora.md](using-monora.md)), or just browse in the app.

New folders aren't shared automatically (except a nested folder inherits its parent's
grants *at the moment it's created*). For existing folders, grant each explicitly.

## Permission levels

- **read** - clone/pull and view.
- **write** - read + `git push` (edit the content).
- **admin** - write + manage the folder's sharing.

## Suggested tiers (adapt to your org)

| Tier | Who | Folders |
|---|---|---|
| All-hands | everyone | the Guide brain, shared references, design assets |
| Per-department | the people in it | `departments/<dept>` (write), others read or hidden |
| Confidential | founders / named people | finance, HR, legal, executive, customer PII |
| Per-client | that account's team | `work/<client>` only |

## Clients and contacts: one folder each

Anything you want to share with a specific subset is its **own folder**:

- **Each client** (`work/acme`) is its own repo + ACL. Grant only that account's team.
- **Contacts / PII** (`data/contacts`) is its own folder too - share it with sales/founders
  without exposing the rest of `data/`, and vice-versa.

Want a client or contact set added or updated? Whoever has `write` on that folder pushes
it in - it enters through the authenticated proxy (token + TLS + per-folder check), not
an email or a loose zip. That **is** the secure channel.

## Removing access

Revoke the grant. On their next `sync` the folder is removed from their tree (kept in
place only if they have uncommitted local changes, which is then flagged).
