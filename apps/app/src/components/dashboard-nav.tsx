"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Brain,
  Settings,
  SlidersHorizontal,
  CircleUser,
  Users,
  Plug,
  Blocks,
  ScrollText,
  CreditCard,
  Shield,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc/client";
import { BrainAvatar } from "@/components/brain-explorer";

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  children?: NavItem[];
};

const PLUGINS: NavItem = {
  href: "/plugins",
  label: "Plugins",
  icon: Blocks,
};

const SETTINGS: NavItem = {
  href: "/settings",
  label: "Settings",
  icon: Settings,
  children: [
    { href: "/settings", label: "General", icon: SlidersHorizontal },
    { href: "/settings/profile", label: "Profile", icon: CircleUser },
    { href: "/settings/members", label: "Members", icon: Users },
    { href: "/settings/connect", label: "Access keys", icon: Plug },
    {
      href: "/settings/activity",
      label: "Activity",
      icon: ScrollText,
    },
    { href: "/settings/billing", label: "Billing", icon: CreditCard },
  ],
};

const topLinkClass = (active: boolean) =>
  cn(
    "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
    active
      ? "bg-secondary font-medium text-foreground"
      : "text-muted-foreground hover:bg-secondary hover:text-foreground",
  );

const childLinkClass = (active: boolean) =>
  cn(
    "flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm transition-colors",
    active
      ? "font-medium text-foreground"
      : "text-muted-foreground hover:text-foreground",
  );

const ADMIN: NavItem = {
  href: "/admin",
  label: "Admin",
  icon: Shield,
};

export function DashboardNav({ isAdmin = false }: { isAdmin?: boolean }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-1 flex-col gap-0.5">
      <BrainsSection pathname={pathname} />
      <StaticSection item={PLUGINS} pathname={pathname} />
      <StaticSection item={SETTINGS} pathname={pathname} />
      {isAdmin && <StaticSection item={ADMIN} pathname={pathname} />}
    </nav>
  );
}

/** A top-level item with optional static children (Overview, Settings). */
function StaticSection({
  item,
  pathname,
}: {
  item: NavItem;
  pathname: string;
}) {
  const Icon = item.icon;
  const sectionActive = item.children
    ? pathname === item.href || pathname.startsWith(`${item.href}/`)
    : pathname === item.href;

  return (
    <div>
      <Link href={item.href} className={topLinkClass(sectionActive)}>
        <Icon className="size-4" />
        {item.label}
      </Link>
      {item.children && sectionActive && (
        <div className="mt-0.5 ml-4 flex flex-col gap-0.5 border-l border-border pl-3">
          {item.children.map((child) => {
            const ChildIcon = child.icon;
            return (
              <Link
                key={child.href}
                href={child.href}
                className={childLinkClass(pathname === child.href)}
              >
                <ChildIcon className="size-3.5" />
                {child.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** "Brains" with one child per brain (the brains), loaded live. */
function BrainsSection({ pathname }: { pathname: string }) {
  const brains = trpc.org.listBrains.useQuery();
  const sectionActive =
    pathname === "/brains" ||
    pathname.startsWith("/brains/");

  return (
    <div>
      <Link href="/brains" className={topLinkClass(sectionActive)}>
        <Brain className="size-4" />
        Brains
      </Link>
      {sectionActive && (brains.data?.length ?? 0) > 0 && (
        <div className="mt-0.5 ml-4 flex flex-col gap-0.5 border-l border-border pl-3">
          {brains.data!.map((b) => {
            const href = `/brains/${b.id}`;
            return (
              <Link
                key={b.id}
                href={href}
                className={childLinkClass(pathname === href)}
              >
                <BrainAvatar name={b.name} className="size-4 rounded text-[9px]" />
                {b.name}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
