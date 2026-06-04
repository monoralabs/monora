# @monora-ai/mcp

Official **read-only** MCP server for [**Monora**](https://monora.ai) - the self-hosted "company brain".

It lets an AI agent (Claude Code, Cursor, Codex, ...) **search and read** only the folders your Monora access key authorizes, served over HTTPS from your own Monora instance. Nothing is copied to your machine, and it **cannot write**.

```bash
claude mcp add monora \
  --env MONORA_URL=https://git.your-company.example \
  --env MONORA_TOKEN=<your-access-key> \
  -- npx @monora-ai/mcp
```

## What it exposes

A small set of read-only tools to the agent: `search`, `read_file`, `list_folders`, `list_files`. Each call is proxied to your Monora instance, which returns only what your key authorizes.

## What it does NOT do

- It talks **only to the instance in `MONORA_URL`** (your own Monora server). No third-party hosts, no telemetry.
- It is **read-only**: no writing, no deleting, no pushing. To edit, use [`@monora-ai/connector`](https://www.npmjs.com/package/@monora-ai/connector) instead, which gives you a local editable tree.
- It only ever returns folders your key is authorized for. Access is enforced **server-side**.
- It stores nothing on disk.

## Security model

- `MONORA_TOKEN` is a bearer access key, **scoped per user** and **revocable at any time** from your Monora instance's settings. Keep it out of shared logs and chats; if it leaks, revoke and reissue.
- Your Monora instance is **self-hosted** - your data stays on infrastructure you control.

## Requirements

Node >= 20.

---

Built and maintained by the Monora team. Questions or issues: <https://monora.ai>.
