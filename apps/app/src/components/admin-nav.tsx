"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  Building2,
  Brain,
  ArrowLeft,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string; icon: LucideIcon };

const ITEMS: NavItem[] = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard },
  { href: "/admin/brains", label: "Brains", icon: Brain },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/orgs", label: "Organizations", icon: Building2 },
];

export function AdminNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-1 flex-col gap-0.5">
      {ITEMS.map((item) => {
        const Icon = item.icon;
        // Exact match for the overview root; prefix match for the sub-pages.
        const active =
          item.href === "/admin"
            ? pathname === "/admin"
            : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
              active
                ? "bg-secondary font-medium text-foreground"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {item.label}
          </Link>
        );
      })}

      <Link
        href="/brains"
        className="mt-2 flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to app
      </Link>
    </nav>
  );
}
