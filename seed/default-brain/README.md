# Welcome to Monora

This is the **Guide** brain - the one every member of the org can read. It explains
how to use Monora and how to keep a company brain that both people and AI agents
can work in. It's a living document; it will keep growing.

> Monora is **"Google Drive with permissions, but git underneath."** Every person
> and every AI agent gets one local working tree containing only the folders they're
> authorized to see, enforced by the server.

## Start here

| If you want to... | Read |
|---|---|
| Use the product (clone your folders, edit, save) | [using-monora.md](using-monora.md) |
| Understand who sees what, and onboard a teammate | [managing-access.md](managing-access.md) |
| Write a brain that AI agents work well in | [ai-brain-best-practices.md](ai-brain-best-practices.md) |
| Share a secret / API key the right way | [sharing-secrets.md](sharing-secrets.md) |

## The model in one minute

- **Brain** = a shared drive inside your org (e.g. "Acme", "Guide").
- **Folder** = the unit of access. One folder = one git repo. You're granted folders
  individually (`read` or `write`); a folder you aren't granted is *absent* from your
  tree, not empty.
- **File** = content inside a folder. It inherits the folder's access.
- Privacy is per folder. Need finer control? Make a smaller folder.
