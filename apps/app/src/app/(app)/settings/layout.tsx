"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  SlidersHorizontal,
  CircleUser,
  Users,
  Plug,
  ScrollText,
  CreditCard,
} from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/settings", label: "General", icon: SlidersHorizontal },
  { href: "/settings/profile", label: "Profile", icon: CircleUser },
  { href: "/settings/members", label: "Members", icon: Users },
  { href: "/settings/connect", label: "Access keys", icon: Plug },
  { href: "/settings/activity", label: "Activity", icon: ScrollText },
  { href: "/settings/billing", label: "Billing", icon: CreditCard },
];

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <div>
        <h1 className="text-3xl">Settings</h1>
        <p className="mt-1 text-muted-foreground">
          Manage your organization, team, connections, and billing.
        </p>
      </div>

      <nav className="mt-6 flex gap-6 border-b border-border">
        {TABS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "-mb-px flex items-center gap-2 border-b-2 pb-3 text-sm transition-colors",
                active
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-4" />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-6">{children}</div>
    </div>
  );
}
