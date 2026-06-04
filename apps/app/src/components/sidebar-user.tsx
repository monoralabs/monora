"use client";

import { useState } from "react";
import { LogOut } from "lucide-react";
import { signOut } from "@/lib/auth-client";

/**
 * Sidebar footer: the signed-in user's avatar + email, doubling as the trigger
 * for a small popover with "Sign out". The popover opens *upward* (it sits at
 * the bottom of the sidebar) and dismisses on outside click - the same
 * backdrop trick used by {@link MoreMenu}. After sign-out we do a hard redirect
 * to "/" so the server layout re-evaluates the (now absent) session.
 */
export function SidebarUser({
  name,
  email,
}: {
  name?: string | null;
  email?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const initials = (name ?? email ?? "?").slice(0, 2).toUpperCase();

  async function handleSignOut() {
    setLoading(true);
    try {
      await signOut();
    } finally {
      window.location.href = "/";
    }
  }

  return (
    <div className="relative mt-auto">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-secondary"
      >
        <span className="grid size-7 place-items-center rounded-full text-xs font-bold text-white [background:var(--grad-warm)]">
          {initials}
        </span>
        <span className="flex-1 truncate text-left text-muted-foreground">
          {email}
        </span>
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
            className="absolute bottom-full left-0 z-50 mb-1 w-full rounded-lg border border-border bg-card p-1 shadow-card"
          >
            <button
              type="button"
              role="menuitem"
              onClick={handleSignOut}
              disabled={loading}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-secondary disabled:opacity-50"
            >
              <LogOut className="size-4 text-muted-foreground" />
              {loading ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
