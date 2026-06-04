# Security Policy

Monora is built to hold a company's most sensitive knowledge, so security reports get priority.

## Reporting a vulnerability

Email **security@monora.ai** with details and, if possible, a reproduction. Please do not open a public issue for security reports. We aim to acknowledge within 72 hours.

## Supported versions

Pre-1.0: security fixes land on `main`. Once releases are tagged, the latest minor is supported.

## Security model

- The git proxy authorizes **every** request at a single chokepoint; the tenant is derived from the brain id, never trusted from the URL.
- Access is **per-folder**; a token's scopes intersect the folder ACL and never widen it (enforced on clone/push and on the read APIs).
- Multi-tenant isolation is enforced by Postgres **RLS** (org-scoped). A separate owner role is used only for migrations, never at request time.
- git subprocesses run with a hermetic environment (no ambient host config, no hooks, no credential prompts).
- Self-hosted repos and blobs stay on your disk; the self-hosted app does not phone home.
