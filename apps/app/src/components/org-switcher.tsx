"use client";

import { useState } from "react";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { organization } from "@/lib/auth-client";

export interface OrgSummary {
  id: string;
  name: string;
  logo: string | null;
}

/**
 * Sidebar org switcher: shows the active org and, on click, a popover listing
 * every org the user belongs to plus a "Create organization" action. Switching
 * calls Better Auth's setActive (updates session.activeOrganizationId) and then
 * does a hard reload so the server layout re-evaluates the new tenant's data and
 * paywall. The org list is passed from the server layout (it already has the
 * session); only the mutations run on the client. Same dismiss-on-backdrop trick
 * as {@link SidebarUser}.
 */
export function OrgSwitcher({
  orgs,
  activeOrgId,
}: {
  orgs: OrgSummary[];
  activeOrgId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = orgs.find((o) => o.id === activeOrgId) ?? orgs[0] ?? null;
  const activeName = active?.name ?? "Workspace";
  const activeLogo = active?.logo || null;

  async function switchTo(id: string) {
    if (id === activeOrgId) {
      setOpen(false);
      return;
    }
    setBusy(true);
    try {
      await organization.setActive({ organizationId: id });
      // Hard reload so the server layout re-runs the paywall + tenant queries.
      window.location.href = "/overview";
    } catch {
      setBusy(false);
      setError("Could not switch organization");
    }
  }

  async function createOrg(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    // Derive a URL-safe slug; a short random suffix keeps it unique without a
    // round-trip to check for collisions.
    const base =
      trimmed
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32) || "org";
    const slug = `${base}-${crypto.randomUUID().slice(0, 4)}`;
    try {
      const res = await organization.create({ name: trimmed, slug });
      const newId = res.data?.id;
      if (!newId) throw new Error("no id");
      await organization.setActive({ organizationId: newId });
      // New orgs have no subscription yet, so the layout will route to checkout.
      window.location.href = "/overview";
    } catch {
      setBusy(false);
      setError("Could not create organization");
    }
  }

  return (
    <div className="relative mb-4">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          setCreating(false);
          setError(null);
        }}
        className="flex w-full items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-left text-sm transition-colors hover:bg-secondary"
      >
        <span className="grid size-6 shrink-0 place-items-center overflow-hidden rounded-md text-xs font-bold text-white [background:var(--grad-warm)]">
          {activeLogo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={activeLogo} alt="" className="size-full object-cover" />
          ) : (
            activeName.slice(0, 1).toUpperCase()
          )}
        </span>
        <span className="flex-1 truncate font-medium">{activeName}</span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
          />
          <div
            role="menu"
            className="absolute left-0 right-0 top-full z-50 mt-1 rounded-lg border border-border bg-card p-1 shadow-card"
          >
            {!creating ? (
              <>
                <div className="max-h-64 overflow-y-auto">
                  {orgs.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      onClick={() => switchTo(o.id)}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-secondary disabled:opacity-50"
                    >
                      <span className="grid size-5 shrink-0 place-items-center overflow-hidden rounded text-[10px] font-bold text-white [background:var(--grad-warm)]">
                        {o.logo ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={o.logo} alt="" className="size-full object-cover" />
                        ) : (
                          o.name.slice(0, 1).toUpperCase()
                        )}
                      </span>
                      <span className="flex-1 truncate">{o.name}</span>
                      {o.id === activeOrgId && (
                        <Check className="size-4 shrink-0 text-muted-foreground" />
                      )}
                    </button>
                  ))}
                </div>
                <div className="my-1 border-t border-border" />
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setCreating(true);
                    setError(null);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-secondary"
                >
                  <Plus className="size-4 text-muted-foreground" />
                  Create organization
                </button>
              </>
            ) : (
              <form onSubmit={createOrg} className="p-1">
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Organization name"
                  className="mb-2 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-ring"
                />
                <div className="flex gap-1">
                  <button
                    type="submit"
                    disabled={busy || !name.trim()}
                    className="flex-1 rounded-md px-2.5 py-1.5 text-sm font-medium text-white [background:var(--grad-warm)] disabled:opacity-50"
                  >
                    {busy ? "Creating…" : "Create"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCreating(false);
                      setName("");
                    }}
                    className="rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-secondary"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
            {error && (
              <p className="px-2.5 py-1.5 text-xs text-destructive">{error}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
