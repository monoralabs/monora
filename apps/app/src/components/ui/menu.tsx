"use client";

import { useState } from "react";
import { EllipsisVertical } from "lucide-react";

/**
 * A tiny "⋮" popover: a trigger button plus an anchored panel that closes on
 * outside click or Escape. No external dependency - we render a transparent
 * full-screen backdrop to catch the dismiss, the same trick used elsewhere in
 * the app for inline forms. Pass arbitrary content as children.
 */
export function MoreMenu({
  children,
  label = "More actions",
  align = "right",
  className = "",
}: {
  children: React.ReactNode | ((close: () => void) => React.ReactNode);
  label?: string;
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        <EllipsisVertical className="size-4" />
      </button>
      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={(e) => {
              e.stopPropagation();
              close();
            }}
            onKeyDown={(e) => e.key === "Escape" && close()}
          />
          <div
            role="menu"
            onClick={(e) => e.stopPropagation()}
            className={`absolute z-50 mt-1 min-w-44 rounded-lg border border-border bg-card p-1 shadow-card ${
              align === "right" ? "right-0" : "left-0"
            }`}
          >
            {typeof children === "function" ? children(close) : children}
          </div>
        </>
      )}
    </div>
  );
}

/** A standard row inside a {@link MoreMenu}. */
export function MenuItem({
  children,
  onClick,
  icon: Icon,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-secondary"
    >
      {Icon && <Icon className="size-4 text-muted-foreground" />}
      {children}
    </button>
  );
}
