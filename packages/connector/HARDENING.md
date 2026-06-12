# `monora save` / `monora sync` hardening — edge-case ledger

**Status: rounds 1-8 complete (48 cases), 137 unit/e2e tests, shipped through
`@monora-ai/connector` 0.1.17 (2026-06-10). Live battery: see the
`connector-live-battery` skill.**

Working document for the save/sync robustness loop. Each case gets a test in
`src/__tests__/save-edges.test.ts` first; the test documents the EXPECTED
behavior, then the code is fixed until it passes. Status legend:
`[ ]` not started · `[T]` test written (red) · `[F]` fixed (green) · `[OK]` already correct, test added as a guard · `[~]` documented, deliberately not fixed.

The happy path (commit, push, clean merge, re-root reconcile, same-line
conflict report, D-pass guard) is covered by `save.test.ts` and works.

## P0 — data corruption / data loss

- [F] **E1. Re-save with unresolved conflict commits the markers.**
  After save reports a conflict, running `monora save` again (an agent retry
  does this naturally) runs `git add -A` + `commit`, which stages the
  `<<<<<<<` marker files, completes the merge, and PUSHES the markers to the
  server. Every other machine then pulls corrupted files.
  Expected: a folder whose conflicted files still contain markers is
  re-reported in `conflicts`, never committed. Once the user edits the files
  (markers gone), save completes the merge commit and pushes.
  → Fixed in `saveEntry`: unmerged-index detection + marker scan before commit.

- [F] **E2. Detached HEAD reports "saved" but pushes nothing.**
  On a detached HEAD, `commitsAhead` finds no upstream → push is skipped →
  the commit lands on no branch (lost to gc eventually) yet the folder is
  reported `saved`. Expected: refuse to commit, report a per-folder error
  telling the user the folder is not on a branch.

- [F] **E3. Branch without upstream silently strands commits.**
  Same mechanism as E2: commits are made but `@{u}` is missing so the push is
  skipped and the action says `saved`. Expected: push with `-u origin HEAD`
  so the work lands on the server (the proxy accepts branch pushes), or error
  honestly if there is no `origin`.

- [F] **E4. `applyCreate` pushes a staged folder to a FOREIGN remote.**
  If the staged directory is already a git repo with its own `origin` (the
  user cloned something there, or re-staged after a partial failure), the
  `.git` exists so `remote add` is skipped and `push -u origin HEAD:main`
  ships the brain content to whatever `origin` was. Expected: `origin` is
  always (re)pointed at the created folder's cloneUrl before pushing.

- [F] **E5. Embedded repo becomes a gitlink in the parent commit.**
  A nested mounted folder (own repo) that is not carved out of the parent's
  `.gitignore` — or any repo the user cloned inside a brain folder — is added
  by `git add -A` as a bare gitlink: other machines get a broken empty dir.
  Expected: save never commits a gitlink; nested mount paths and embedded
  repos are excluded from the parent's add/status pathspec.

## P1 — operations break / lie

- [F] **E6. Staged EMPTY folder always fails to create.**
  `applyCreate` on an empty dir: commit fails (caught, fine) but then
  `push HEAD:main` fails on the unborn HEAD → the create errors every run.
  Worse, if the dir gains files later the repo has no upstream (`-u` never
  ran) so E3 strands it. Expected: `--allow-empty` initial commit, push `-u`.

- [F] **E7. Manifest fetch failure aborts the whole save.**
  `fetchServerManifest` throwing (lifecycle route down, transient 500) kills
  save before the M pass, so not even plain commit+push of existing folders
  happens. Expected: A/D are skipped with a recorded error; M still runs.

- [F] **E8. Dir present but `.git` missing is silently skipped.**
  A half-synced folder (sync interrupted after mkdir, or user nuked `.git`)
  is skipped without a word in the M pass: save reports success while the
  folder never saves. Expected: per-folder error "not a git repo, run
  monora sync". (A fully MISSING dir is the D case and stays silent.)

- [F] **E9. Dry-run omits the M plan.**
  The comment says "Still report which M folders are dirty" but the code
  returns immediately: `--dry-run` shows creates/deletes and no modifies.
  Expected: `plan.changed` lists folders with dirty status or unpushed
  commits.

All E-cases above: tests in `save-edges.test.ts`, fixes shipped in `save.ts`
(+ `conflictedFiles` exported from `git-integrate.ts`, dry-run `M` lines in
`cli.ts`). Full suite green (74 passing).

## P2 — guards & smoke coverage

- [OK] **E10. Delete-guard boundaries.** 2-of-2 missing → guard trips
  (missing === total). 3-of-5 → trips (≥3 and majority). 2-of-3 → does NOT
  trip (en-masse threshold is 3): both archive. Tests pin these so a future
  edit doesn't quietly change them.

- [OK] **E11. Content smoke: binary files, symlinks, unicode/space names.**
  One test commits all three and checks the remote round-trips them.

## Round 2 — adversarial review of the hardened code

- [F] **F2. Repo nested BELOW an untracked dir became a gitlink.** Porcelain
  collapses untracked trees to the topmost dir (`?? sub/`), so a clone at
  `sub/nested/.git` escaped the exclude scan. Fixed: the scan now walks
  untracked dirs looking for `.git` at any depth (capped).
- [F] **F3. Repo inside an already-tracked dir became a gitlink.** Such a dir
  never shows as `?? `, so no exclude fired. Fixed with the belt to the
  suspenders: `dropStagedGitlinks` unstages any mode-160000 entry that is not
  a declared submodule, right before EVERY commit (save + create). No commit
  can record a gitlink anymore, whatever path got it into the index.
- [F] **F4. Spaces/unicode dir names broke the exclude scan.** Porcelain
  quotes such paths, so `endsWith("/")` failed and the sliced path was
  garbage. Fixed: `status --porcelain -z` (unquoted, NUL-separated) and
  `:(exclude,literal)` pathspecs.
- [F] **F5. User-installed git hooks ran on connector commits.** A failing
  pre-commit blocked the save (and a mutating one silently rewrote brain
  content before push). Fixed: all connector commits (save, create, collapse)
  pass `--no-verify` - save is an abstraction over git, not a dev workflow.
- [F] **F7. Nested pending creates applied in stage order.** Staging `a/b`
  before `a` meant the child was applied first, the carve-out found no parent
  repo, and the parent then swallowed the child. Fixed: the A pass sorts
  creates parents-first and excludes nested pending paths from each create's
  initial commit.
- [F] **F13. Carved-out nested mounts broke the parent's save on some git
  versions.** Naming a `.gitignore`d path in an `:(exclude)` pathspec makes
  git refuse the whole `add` ("paths are ignored") - found live on the Mac
  Mini's monora root. Excludes are now filtered through `git check-ignore`:
  an already-ignored path needs no exclude.
- [F] **F12. Corrupted `.monora/manifest.json` said "not a workspace".**
  A parse failure now throws "unreadable (corrupt or truncated) - run
  `monora sync` to rebuild it" instead of the misleading first-run message.
- [F] **F11 (partial). `monora add` duplicate check was case-sensitive.**
  On macOS's case-insensitive filesystem `Notes` and `notes` mount onto the
  same dir. The add-time check now compares case-insensitively. The broader
  case (server-side slug policy, sync mounting two case-colliding folders
  concurrently) is a server/sync concern - see below.

## Round 3 — `monora sync` (tests in `sync-edges.test.ts`)

P0 (data loss / escape):

- [F] **S1. Prune destroyed committed-but-unpushed work.** `reconcileRemovals`
  only checked `status --porcelain`: a revoked folder with local COMMITS that
  never pushed reads as clean and was `rm -rf`'d - the commits existed nowhere
  else. Now any commit not on a remote blocks the prune with an error, like
  the dirty-tree case. (The old fixture used remoteless `git init` repos and
  pinned the unsafe behavior; updated to a realistic pushed clone.)
- [F] **S2. Pruning a revoked parent deleted the still-authorized child
  inside it.** A nested mount lives in its parent's directory; `rm -rf` on
  the revoked parent took the child repo (and its uncommitted work) with it.
  Now a revoked folder that contains any currently-authorized mount is left
  in place with an error.
- [F] **S3. The graft's `checkout -f HEAD` overwrote same-named local
  files.** Hit the remount flow we ourselves recommend (lose `.git`, edit,
  re-sync: edits gone) and restore-onto-a-recreated-path (F8). The graft now
  materializes ONLY tracked files missing from disk; an existing file that
  differs is never touched - it just shows as a local modification for the
  next save. (Mounting a root over nested folders still works: those files
  are absent, so they materialize.)
- [F] **S4. Manifest mount paths could escape the workspace.** A buggy or
  hostile server manifest with `../...`/absolute mount paths made sync write
  - and the prune potentially `rm -rf` - OUTSIDE the workspace. Mount paths
  are now validated (no `..`, `.`, empty segments, absolute) in both the
  mount and prune passes.

P1 (honesty / UX):

- [F] **S5. Detached HEAD at pull time surfaced a raw git error.** Now the
  same clear per-folder error as save: "not on a branch (detached HEAD)".
- [F] **S6. Sync silently clobbered a user-edited workspace `CLAUDE.md`.**
  The generated file now carries a marker comment; sync only rewrites the
  file when it is absent or still carries the marker. Legacy generated files
  (pre-marker) are treated as user-owned and frozen - delete the file (or
  re-add the marker) to hand it back.
- [F] **S7. A FILE occupying a mount path errored with raw ENOTDIR.** Now a
  clear per-folder error ("a file occupies this folder's mount path"); other
  folders sync on.
- [F] **S8. A non-JSON manifest response (proxy behind a captive page, wrong
  baseUrl) threw a cryptic parse error.** Now: "the manifest response was
  not JSON - is this baseUrl a Monora proxy?".

Documented, not fixed:

- [~] **S9. Interrupted graft** (`.git` renamed in, process killed before
  files materialize): next sync takes the pull path with an all-deleted
  working tree and errors until resolved. Self-healing it would conflict
  with honoring deliberate local deletions. Recovery: `git checkout -- .`
  in the folder, or delete the folder and re-sync.
- [F] **S10. Stale `<dest>.monora-clone-<pid>` temp dirs** from a SIGKILL
  mid-graft are now swept per-entry at sync time - safe since the workspace
  lock guarantees no other run is mid-graft.
- [~] **S11. Duplicate mount paths in one manifest** still race in the same
  depth level (one clone errors per-entry); NEW case-collisions can no
  longer be created server-side (F11 resolved), so this only affects
  pre-existing rows.

## Round 5 — found in the wild (Mac Mini + MBP convergence, 2026-06-10)

- [F] **F14. An AA gitlink conflict that is the ONLY change never concludes.**
  The unmerged gitlink path is excluded from the filtered status, so save
  skipped the commit phase and the in-progress merge blocked every later
  pull/push. Save now concludes a marker-free merge (MERGE_HEAD present)
  even when the filtered status is empty - the gitlink drops from the index
  and the merge commit pushes.
- [F] **S12. Fossilized stale Bearer headers broke auth on both machines.**
  Old setups / machine-copied repos carried `http.extraheader =
  Authorization: Bearer mna_<old>` persisted in `.git/config`; git sends TWO
  Authorization headers and the proxy reads the stale one -> every pull/push
  401s while curl with the live token works. The connector never persists
  this header by design, so any persisted Monora bearer header is stale:
  sync and save now drop it before touching the remote. (Also seen: a
  credential.helper pointing at ANOTHER machine's home dir on copied repos;
  sync rewires it after the first successful pull.)

## Round 6 — found by REAL scoped-sync exercise (2026-06-10 PM)

Running the scope lifecycle for real (`--brains monora` over a fully-mounted
scratch workspace) surfaced a chain the unit fixtures never composed:

- [F] **S13. The prune blocked itself on dirt it inflicted.** Children were
  removed first, which made a parent whose tree still referenced them read
  dirty ("D child"), blocking the parent forever. The prune now safety-checks
  EVERY candidate against the untouched disk first, then deletes parents
  first (verified descendants are subsumed).
- [F] **S14. Pruning left empty intermediate shells** (qualified brain dirs
  like `<slug>-<org8>/`). Now climbed and `rmdir`'d - which only ever removes
  empty dirs.
- [F] **S15. An un-carved nested mount blocked its parent's prune** (`??
  child/` read as uncommitted work). The prune now measures dirt the way
  save does: known nested mounts are excluded from the status.
- [F] **F15. COMMITTED gitlinks (the historical corruption) never healed.**
  They hide behind excluded paths, so the filtered status read clean and the
  commit phase never ran - every fresh clone inherited the corrupt tree and
  read phantom-dirty whenever a child moved (the Mini's mystery "M" rows).
  Save now runs the commit phase whenever the index holds a non-submodule
  gitlink; the drop + push cleanses the tree for every machine.
- [F] **F16. Save now ensures the carve-out convention.** A nested mount
  with no `/child/` line in the parent's `.gitignore` gets one added and
  pushed - plain `git status` reads clean for users, fresh clones are born
  quiet, and the prune converges. (Real dreamshot/monora-guide brains healed
  with this on 2026-06-10.)

## Round 8 — a second STALE workspace in the wild (~/dev/dreamshot, 2026-06-10)

A legacy workspace with a granular-era index surfaced a four-bug chain
(reported by a parallel debugging session; reproduced and fixed here):

- [F] **S16. The prune could DELETE parent-tracked content.** A stale meta
  listed granular clones whose paths the parent now tracks as flat content;
  pruning them rm -rf'd tracked files - and the next save would commit those
  deletions and push. Such candidates are now DEMOTED: only the stale `.git`
  is dropped, every file survives as parent content.
- [F] **S17. The 401-domino emptied the shared credential store.** On any
  401 (e.g. a stale clone pulling its now-archived repo) git calls
  `credential reject`, and the plain `store` helper ERASES the entry -
  truncating `~/.monora/git-credentials` to 0 bytes and breaking auth for
  every other repo until the next sync. The per-repo helper is now
  READ-ONLY: it answers `get` via credential-store and ignores
  `store`/`erase`. (The sync-time write is also atomic now - tmp + rename.)
- [F] **F18. Stale carve lines silently swallowed new files.** `.gitignore`
  still carved `/x/` for dirs the repo now TRACKS (granular->flat
  leftovers): new files under x were never saved, and naming x in pathspecs
  could fail the whole add. Save now removes a carve line whose dir is not a
  nested mount but IS tracked - the contradiction state.
- [F] **S18. Tokens leaked into error output.** Failed-command messages
  embed the full git command line including `Authorization: Bearer mna_...`,
  and those strings reach the terminal, logs and CI. Every reported error
  now passes through redaction (`mna_***`).

## Round 9 (open) — the a3a89a5 incident: no guard against mass FILE deletion

2026-06-10 evening: a RAW-git commit made in the stale granular workspace
(embedded .git dirs still present) recorded 87 tracked files as deleted in
the flat `skills` repo and pushed; every replica then pulled the wipe
silently, and the web explorer made it visible only by eye. Recovered
surgically from history (the 57 still-missing files checked out from
`a3a89a5^`, stale carve lines dropped, saved).

What it teaches:

- `monora save` would NOT have produced that commit (embedded excludes +
  de-gitlink + carve healing) - but the docs rightly promise raw git works,
  and raw git has none of those guards in a poisoned working tree.
- [ ] **Candidate guard: incoming/outgoing mass-deletion detection.** Save's
  D-guard protects folder-level deletes; FILE-level mass deletion inside one
  folder has no equivalent. Proposal: save refuses to push a commit deleting
  more than N tracked files without --force, and sync WARNS when an incoming
  merge deletes more than N files (it still applies - git is the truth - but
  the user hears about it instead of discovering by eye).
- [x] The healing that already shipped (demote, F18, carve cleanup) removes
  the poisoned state that made raw git destructive in the first place.

## Round 10 — the read-only save, found in the wild (Estefanía, 2026-06-12)

A user with `read` grants on every folder ran `monora save`: the commit
landed locally, the push got the proxy's uniform 401 - and git, treating 401
as "bad credentials, retry", fell through to the SYSTEM credential helper:
on Windows, Git Credential Manager popped a username/password dialog for
git.monora.ai. Monora's whole promise is that git stays invisible. Meanwhile
`monora doctor` reported "Everything looks healthy" (it only ever checked
READ access). Three fixes, one server-side change:

- [F] **S19. The proxy now answers an authenticated, folder-readable push
  with 403 + a plain-text reason, not the uniform 401.** A 401 makes every
  git client re-prompt for credentials over a permission no credential can
  fix. The carve-out leaks nothing: it fires only when the subject can
  already READ the folder (scoped-out / unreadable / missing folders still
  get the indistinguishable 401). `GIT_WRITE_DENIED` in
  `authorize-git-request.ts`; adversarial tests pin both the 403 and the
  no-existence-leak boundary.
- [F] **S20. The connector never lets git fall through to a system
  credential helper.** `gitAuthArgs` now resets the helper list
  (`-c credential.helper=`) on every connector-run git command:
  if the bearer header is rejected, git FAILS - it never asks GCM/osxkeychain
  for credentials it couldn't have. (`GIT_TERMINAL_PROMPT=0` alone never
  covered GUI helpers.)
- [F] **S21. A denied push is reported, not dumped.** Push failures are
  classified (`classifyPushError`): 403 → the folder lands in
  `result.readOnly` ("your changes are kept locally; ask an org admin for
  write access"), 401 → a `monora login` hint. Neither attempts the
  divergence merge-and-retry (a denial is final). Mixed workspaces save
  every writable folder and report the read-only ones in their own section.
- [F] **S22. Doctor now reads the `permission` field it always had.** The
  manifest carries per-folder permissions; doctor ignored them and declared
  a fully read-only login healthy. It now reports read-only folders up
  front (named individually in mixed workspaces).
- [F] **S23. Sync names read-only folders carrying local-only commits.**
  The download side was safe (merge, never overwrite) but silent: a
  read-only folder with rejected-save commits looked synced while that work
  could never reach the server. Sync now reports them
  (`result.readOnlyAhead`) with the write-access next step.
- [F] **S24. The dirty-merge refusal speaks product, not git.** When
  unsaved local edits collide with incoming updates, git refuses the merge
  (correctly - nothing is touched) but the raw "Your local changes would be
  overwritten by merge" gave no next step. Sync now says: save or discard,
  then re-sync.

- [F] **S25. Per-folder defects now reach telemetry.** The top-level catch
  only ever saw errors that THREW; everything save/sync/collapse swallow
  into `result.errors` (the per-folder model - one folder fails, the rest
  proceed) was invisible to Sentry. `reportUnexpected()` now hooks the 8
  swallow sites (saveEntry, syncEntry, applyCreate, archiveFolder,
  fetchServerManifest, uncarve, pushParent, archiveChild), gated by
  `looksUnexpected` (expected user-state errors never report), deduped per
  run (a dead network across 30 folders = ONE event, keyed by
  operation+message, never by folder), and flushed with a bounded window
  before `process.exit` would kill the fetch. Process-level
  uncaughtException/unhandledRejection now die redacted + reported too,
  and the MCP stdio server exits with one stderr line instead of a raw
  Node dump (no telemetry there - it may run on agent-provided tokens).

Live battery 2026-06-12: stages 0-9 re-run green from source (no auth
regression from the credential-helper reset), and the new stage 10 passed
against prod end-to-end: 403 + friendly body on the push, READ-ONLY save
outcome with the commit kept locally, doctor + sync notices, server HEAD
unchanged, `git.denied` in the audit log, and the stranded commit pushed
clean once write was granted.

## Round 7 — the LIVE battery (real lab brain against prod, 2026-06-10)

A standing test brain (`connector-lab`) now exists on prod for end-to-end
batteries: every connector command runs against the real git proxy and every
step is verified SERVER-SIDE over SSH (bare trees + DB rows). The repeatable
procedure lives in `~/dev/monora/.claude/skills/connector-live-battery/`.

- [F] **F17. Two machines racing the FIRST push of a born-empty repo.** Both
  cloned the folder while its repo was empty (unborn HEAD, no upstream).
  Machine A pushes first; machine B's `push -u origin HEAD` hits
  non-fast-forward - and that path had NO merge-retry (only the
  with-upstream path did). Found live within minutes: the lab brain's root
  folder + the F16 auto-carve raced exactly this way. B now adopts the
  freshly-born remote branch as upstream, merges, and pushes.
- [~] **Restore vs a stale machine's save.** A machine whose local index
  still lists a folder, whose dir is locally deleted, re-archives it on save
  - even if another machine restored it meanwhile. Correct from that
  machine's view, a footgun globally. Mitigation: sync before save after a
  cross-machine restore. A real fix needs a restoredAt/generation marker in
  the manifest to detect the stale-index case - server-side, later.

Everything else passed live: unicode/symlink/binary/marker-content round-trip
(server-verified), divergence merge, the E1 blind-re-save refusal, A/D with
DB-verified lifecycle, restore with history, adversarial embedded repo + hook
(zero gitlinks server-side), collapse fold + skip-own-repo, one-pass scope
prune with no residue.

## Round 4 — `monora collapse` (tests in `collapse-edges.test.ts`)

- [F] **C1. The parent-is-a-repo check ran AFTER mutating its `.gitignore`.**
  An unmounted parent now fails before anything is touched. (The feared
  child-`.git` deletion from F9 turned out to be dead code - own-repo
  children are routed to `skipped` before step 1 ever sees them; the branch
  was removed.)
- [F] **C2. Skipped own-repo children were committed as gitlinks.** The
  parent's `add -A` recorded them (and any user-dropped clone) as broken
  gitlinks pushed to every machine - and died outright on an embedded repo
  with no commits. Fixed by reusing save's `embeddedRepoExcludes` pathspecs
  plus the `dropStagedGitlinks` net before the commit.
- [F] **C3. A failed parent push threw the whole result away.** A diverged
  remote is now merged and re-pushed (same policy as save); a hard failure
  reports a structured error, archives NOTHING, and the un-carve is committed
  locally so a re-run (or a plain save) completes the job.
- [F] **C4. A child the parent never absorbed was archived anyway.** If the
  un-carve missed (a `.gitignore` variant, an `info/exclude` rule), the
  child's files reached no pushed repo while the folder silently left the
  manifest. Collapse now verifies the parent actually tracks each child's
  subpath before archiving it.
- [F] **C5. Hostile child mount paths reached file IO.** Same
  `isUnsafeMountPath` guard as sync, applied to the children pass.
- [F] **C6 (was F9b). Collapse ignored `pending.json`.** Staged creates under
  the collapsed parent are now unstaged (reported in `result.unstaged`) so
  the next save cannot re-split what was just folded.

Documented: a collapse interrupted between the parent push and the archive
pass leaves children archived-pending; re-running collapse converges (the
verify-absorbed check passes, archive retries). Parent uncommitted user
changes are absorbed into the collapse commit (it is a save, after all).

## Known limitations (documented, not fixed here)

- [~] **F1. Binary (markerless) conflict: re-save resolves to the LOCAL
  version.** A binary file conflicted on both sides has no text markers, so
  the unresolved-conflict guard cannot tell "user resolved" from "user did
  nothing", and a re-save commits the working-tree (local) version - exactly
  what `git commit -a` would do mid-merge. NOT data loss: the merge commit
  keeps both parents, so the remote version stays in history on the server
  and is recoverable. The first save does report the conflict. Revisit if
  brains start carrying meaningful binaries.
- [~] **F6. A folder whose remote is named something other than `origin`**
  errors with "no origin remote" instead of pushing. Proxy-cloned folders are
  always `origin`; only hand-rewired repos hit this, and the error is honest.
- [F] **F8. `monora restore` + `sync` onto an occupied mount path** -
  resolved by S3: the graft no longer overwrites existing files, so a
  restore landing on a re-created path keeps the local versions (they show
  as modifications) and only materializes what is missing.
- [F] **F9. `collapse` hardening** - resolved in Round 4 (C1-C6): the
  child-`.git` deletion was dead code (removed), pending.json is honored,
  and push failures no longer lose state.
- [~] **F10. SIGINT mid-save** can leave an applied create still staged in
  `pending.json`; the re-run re-creates idempotently and `set-url origin`
  (E4 fix) makes the retry safe locally. Server-side create idempotency
  SHIPPED 2026-06-10 (same slug+path returns the existing folder; trashed
  slug conflicts with a restore hint) - the retry is now safe end to end.
- [F] **F11 (rest). Case-colliding folders server-side** - RESOLVED
  2026-06-10: createFolder rejects mount paths colliding case-insensitively
  (slugs were already lowercase-unique), so macOS workspaces can no longer
  receive two folders mounting onto one directory.

- [~] **Remote moves between merge and second push** → per-folder error;
  re-running save converges. A bounded retry loop would mask it.
- [F] **Cross-process lock** - RESOLVED 2026-06-10: sync/save/collapse take
  `.monora/lock` (pid-based, stale-clearing); a second command is refused
  with who/since.
- [~] **Partial `applyCreate` (server created, push failed)** leaves the
  pending entry staged; the retry re-POSTs the create. Idempotency of the
  create route is a SERVER concern (returns the existing folder or 409) —
  tracked separately. E4's origin re-pointing makes the retry safe locally.

## Loop protocol

1. Pick the highest open case, write/extend its test in
   `save-edges.test.ts` asserting the EXPECTED behavior.
2. `pnpm test` → confirm red for the right reason.
3. Fix in `save.ts` / `git-integrate.ts` (smallest change that makes the
   invariant hold; never weaken an existing test).
4. `pnpm test` → all green, flip the checkbox here, commit test+fix together.
