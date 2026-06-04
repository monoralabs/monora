import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { AuthForm } from "@/components/auth-form";
import { SunriseBg } from "@/components/sunrise-bg";

// The app's root IS the sign-in / sign-up page. The marketing landing lives in
// apps/web and links here, optionally carrying a plan intent
// (?plan=teams&interval=annual&seats=8) so we can go straight to checkout.
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const plan = typeof sp.plan === "string" ? sp.plan : undefined;

  // Where to go after auth: checkout if a plan was chosen, else the dashboard.
  const qs = new URLSearchParams();
  for (const k of ["plan", "interval", "seats"]) {
    const v = sp[k];
    if (typeof v === "string") qs.set(k, v);
  }
  const callbackURL = plan ? `/checkout?${qs.toString()}` : "/brains";

  const session = await auth.api.getSession({ headers: await headers() });
  if (session) redirect(callbackURL);

  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden px-6">
      <SunriseBg />
      <div className="relative z-10">
        <AuthForm callbackURL={callbackURL} />
      </div>
    </main>
  );
}
