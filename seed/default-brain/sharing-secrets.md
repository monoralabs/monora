# Sharing secrets and `.env` files

**Short version: secrets never go in the brain.** Not in any folder, not "just this once."
The brain is knowledge that people and AI agents read; a leaked key there is a real
incident, and agents are good at finding and using keys.

## What counts as a secret

API keys, access tokens, passwords, private keys (`*.pem`, `*.key`), database URLs with
credentials, and any `.env` holding real values.

## Monora helps, but don't rely on it alone

On ingest, Monora **automatically skips** `.env` files (and `node_modules`, caches, OS
cruft). It **keeps** `.env.example` / `.env.sample` - templates with empty values. So:

- ✅ Commit `.env.example` documenting *which* variables exist (no values).
- ❌ Never commit the real `.env`. Even though ingest drops it, don't push it via the
  connector either - keep it out of the working tree's commits.

## Where secrets actually go

Use your team's **secrets manager**, not the brain:

- **Vaultwarden / Bitwarden, 1Password, Doppler** - shared vaults with per-person access.
- Store the real values there; reference them by *name* in the brain if needed
  (e.g. "the Cloudflare R2 key lives in the `r2-prod` vault item").

## Sharing a secret with a teammate, the right way

1. Put the value in the shared vault (or the relevant collection).
2. Grant that teammate access to that vault item.
3. In the brain, the `.env.example` tells them which variables to set; the vault tells
   them the values. They fill their own local `.env` (which is git-ignored).

This keeps a clean split: **the brain documents config, the vault holds secrets.** Never
the two in one place.
