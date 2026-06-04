import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { isPlatformAdmin } from "@/server/authz/platform";
import { AdminNav } from "@/components/admin-nav";
import { SidebarUser } from "@/components/sidebar-user";

/**
 * Platform-admin shell. Deliberately NOT under the (app) route group: it skips
 * the subscription paywall (staff don't pay) and gates on the GLOBAL user.role
 * instead of an org membership. The gate is re-checked server-side on every
 * request; every tRPC call under here is additionally platformAdminProcedure.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/");
  if (!(await isPlatformAdmin(session.user.id))) redirect("/brains");

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-border bg-surface-soft px-3 py-5">
        <div className="flex items-center gap-2 px-3 pb-6">
          <span className="wordmark text-lg">Monora</span>
          <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide text-white uppercase [background:var(--grad-warm)]">
            Admin
          </span>
        </div>

        <AdminNav />

        <SidebarUser name={session.user.name} email={session.user.email} />
      </aside>

      <main className="flex-1 bg-background">{children}</main>
    </div>
  );
}
