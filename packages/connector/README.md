# @monora-ai/connector

The official CLI for [Monora](https://monora.ai), the self-hosted company
brain. It composes the folders your access key authorizes into a local git
working tree that you - and your AI tools - can read and edit, and pushes
your changes back to your own Monora instance. It talks only to the instance
URL you connect to.

```bash
npx -y @monora-ai/connector login --url https://git.your-instance.example
monora sync     # bring your folders to this computer
monora save -m "what changed"   # commit + push every changed folder
```

## Commands

| Command | What it does |
|---|---|
| `monora login --url <url>` | Connect this machine (browser approval; installs the `monora` command). |
| `monora sync` | Clone/update every folder your key authorizes. `--brains a,b` / `--orgs <id>` scope a workspace to a subset (sticky); `--unscope` clears it. |
| `monora save -m "..."` | Commit and push every changed folder; creates staged folders (A), archives folders deleted from disk (D, recoverable). `--dry-run` previews. |
| `monora status` | What changed locally (A/M/D per folder). |
| `monora add <dir>` | Promote a subdirectory into its own folder (created on the next save). |
| `monora collapse <folder>` | Fold flat child folders back into their parent and archive the redundant repos. |
| `monora restore [<name>]` | List the trash, or bring an archived folder back - with full history. |
| `monora doctor` | Diagnose why a folder is missing, divergent, or blocked. |
| `monora new-brain "<Name>" --from <dir>` | Create a brain from a local directory and push its content. |
| `monora update` | Update this tool itself to the latest release (any install: shim, npm/pnpm -g). |
| `monora --version` | Print the running version. |

## Safety model

- **Access is decided and enforced server-side** by your Monora instance,
  not by this CLI. A folder you cannot read never appears on disk.
- **Divergence integrates by merge, never force** - no save or sync can
  discard a side. Same-line conflicts are left marked for you (or your AI)
  to resolve; a blind re-save refuses to commit unresolved markers.
- **Deletions are soft**: an archived folder keeps its full git history and
  `monora restore` brings it back.
- The prune never removes uncommitted or unpushed work, and one mutating
  command runs per workspace at a time (`.monora/lock`).
- Access keys are scoped per user and revocable at any time; a revoked key
  stops working immediately. Keys are never persisted into repo config, and
  error output redacts them.

The full edge-case ledger lives in
[`HARDENING.md`](https://github.com/monoralabs/monora/blob/main/packages/connector/HARDENING.md).
