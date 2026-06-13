# Managing access (for admins)

Access in Monora is **per folder**, granted to **people** and to **groups** - never
"share with everyone" by accident. This is how you onboard the team and decide who sees
what.

## Onboarding a teammate

1. **Invite** them (Settings → Members → Invite, or the admin CLI `invite`). They get
   an email, accept, and sign in once - that creates their account.
2. **Give them access.** Either add them to a **group** (Settings → Groups) so they get
   that group's whole folder set at once, or grant individual folders from the brain's
   sharing view. Everything you don't grant stays invisible to them.
3. They **create a token** and run `monora login` + `monora sync` (see
   [using-monora.md](using-monora.md)), or just browse in the app.

New folders aren't shared automatically (except a nested folder inherits its parent's
grants *at the moment it's created*). For existing folders, grant each explicitly - or
add it to a group so everyone in that group gets it at once.

## Permission levels

- **read** - clone/pull and view.
- **write** - read + `git push` (edit the content).
- **admin** - write + manage the folder's sharing.

## Groups: access that scales with the team

Granting folder-by-folder, per person, doesn't scale: when three sales reps should all
see the same folders, you end up editing each by hand, and adding a folder to "what sales
sees" means touching every member. Groups fix that.

A **group** (e.g. `Sales`, `Finance`, `Exec`) is a named bundle of folder grants:

- Put people in the group; they get every folder the group grants.
- Add or remove a folder from the group and it propagates to **all** members at once.
- Manage groups and membership in **Settings → Groups**. Grant a folder to a group from
  that folder's **Share** menu in the brain (pick the group, set read/write/admin), the
  same place you grant a person.

**How direct and group access combine:** a person's effective permission on a folder is
the **highest** of their direct grant and every group they're in. A direct grant or a
group can only ever *add* access, never take it away. So a direct `write` on top of a
group's `read` gives `write`; being in two groups gives the higher of the two.

### Suggested starter groups (adapt to your org)

| Group | Who | Folders |
|---|---|---|
| All-hands | everyone | the Guide brain, shared references, design assets |
| Per-department | the people in it | `departments/<dept>` (write), others read or hidden |
| Confidential | founders / named people | finance, HR, legal, executive, customer PII |
| Per-client | that account's team | `work/<client>` only |

## Clients and contacts: one folder each

Anything you want to share with a specific subset is its **own folder**:

- **Each client** (`work/acme`) is its own repo + ACL. Grant only that account's team
  (directly, or via a per-client group).
- **Contacts / PII** (`data/contacts`) is its own folder too - share it with sales/founders
  without exposing the rest of `data/`, and vice-versa.

Want a client or contact set added or updated? Whoever has `write` on that folder pushes
it in - it enters through the authenticated proxy (token + TLS + per-folder check), not
an email or a loose zip. That **is** the secure channel.

## Removing access

Revoke the grant. On their next `sync` the folder is removed from their tree (kept in
place only if they have uncommitted local changes, which is then flagged).

One thing to watch with groups: revoking a person's **direct** grant does **not** remove
access they still get from a group (access only adds, it never subtracts). If someone
should no longer see a folder, either **take them out of the group** or **remove the
folder from the group** - the brain's Share menu shows a "via <group>" badge next to
anyone whose access comes from a group, so you can see exactly why they can reach it.
