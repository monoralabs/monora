# @monora-ai/connector

Official CLI for [**Monora**](https://monora.ai) - the self-hosted "company brain".

It composes the folders your access key authorizes into a **local git working tree** at a directory you choose, so you (and your AI tools) can read and edit real files. Changes you commit push back to your own Monora instance.

```bash
# 1. sign in - opens your browser to approve this machine (no key to copy/paste)
npx @monora-ai/connector login --url https://git.your-company.example

# 2. build your authorized folders into a local tree
npx @monora-ai/connector sync --workspace ~/monora-brains
```

## What it does

- **`login`** - approve the machine in your browser (a short device-code flow); the CLI stores the resulting credential locally (`~/.monora/credentials.json`), so the other commands and the MCP server can use it. No token is ever typed on the command line. (`--token <key>` is still accepted for scripts/CI.)
- **`sync`** - clones or updates **only the folders your key authorizes** into the workspace directory you pass. Access is decided and enforced **server-side** by your Monora instance, not by this CLI.
- **`save`** - commits and pushes every folder in the workspace that has changes, in one step (`monora save -m "what changed"`). It is the way back after you (or your AI) edit files. Each folder is its own repo, so each gets its own commit; a `read`-only folder is rejected server-side. Raw `git commit`/`git push` from inside a folder still works too.

## What it does NOT do

- It talks **only to the instance URL you pass** with `--url` (your own Monora server). No third-party hosts, no telemetry, no analytics.
- It only ever fetches folders your key is authorized for. It cannot widen your own access.
- It reads and writes **only inside the workspace directory you choose**. It does not touch anything else on your machine.

## Security model

- Access keys are **scoped per user** and can be **revoked at any time** from your Monora instance's settings. A revoked key stops working immediately.
- Your Monora instance is **self-hosted** - your data stays on infrastructure you control.
- The key is a bearer credential: keep it out of shared logs and chats. If one leaks, revoke it and issue a new one.

## Requirements

Node >= 20.

---

Built and maintained by the Monora team. Questions or issues: <https://monora.ai>.
