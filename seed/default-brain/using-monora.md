# Using Monora

Two ways to work with your authorized folders: the **web app** (browse/read) and the
**connector** (a real local git tree you and your agents edit).

## In the browser

Go to **app.monora.ai** → **Brains**. You'll see the brains you can access; open one
to browse its folders and files. You only ever see folders you've been granted.

## On your machine (the connector)

The connector composes the folders you're authorized for into one local working tree -
one folder = one git repo, real git underneath, so `claude` / `codex` / your editor
operate on it natively.

1. **Get a token.** App → Settings → Tokens → create one. Copy it (shown once).
2. **Log in, then sync into a workspace for your org:**
   ```bash
   monora login --url https://git.monora.ai --token <your-token>
   monora sync --workspace ~/monora/<org>      # e.g. ~/monora/acme
   ```
   Convention: keep one home, `~/monora/`, and give each org its own subfolder.
   `sync` clones (or fast-forwards) every folder you can see into
   `~/monora/<org>/<folder>/`. Run it again anytime to pull the latest and pick up
   newly-shared folders.
3. **Work normally.** Open `~/monora/<org>` in your editor or point an agent at it.

> **One workspace = your whole org.** Today every brain you can see in the org lands
> flat in the same tree - the "Guide" brain's `guide/` sits next to the folders of
> your other brains (`departments/`, `data/`, ...). That's fine; folder names rarely
> collide. Belong to more than one org? Sync each into its own `~/monora/<org>` so
> they never mix. (`~/monora/` is for synced brains; keep it separate from any code
> checkout - don't sync inside a code repo.)

## Saving your changes (write-back)

If you have `write` on a folder, saving is a normal git push from inside it:

```bash
cd ~/monora/<org>/departments/sales
git add -A && git commit -m "update Q3 deck notes"
git push
```

The server checks your permission on every push. No `write` = the push is rejected.
There's no magic sync daemon - commit and push when you mean to save.

## Rules of the road

- A folder you can't access is **absent** from your tree (not empty). That's by design.
- **Never commit secrets** (`.env`, keys, tokens). See [sharing-secrets.md](sharing-secrets.md).
- Big binaries (video, large images) aren't ingested yet - keep them out for now.
- Lost access to a folder? On the next `sync` it's removed (unless you have uncommitted
  changes there, in which case it's left in place and flagged).
