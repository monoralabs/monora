"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AvatarUploader } from "@/components/avatar-uploader";
import { authClient } from "@/lib/auth-client";

export default function GeneralSettingsPage() {
  const { data: org, isPending } = authClient.useActiveOrganization();

  const [name, setName] = useState("");
  const [logo, setLogo] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<null | { ok: boolean; msg: string }>(
    null,
  );

  // Seed the form once the active org has loaded.
  useEffect(() => {
    if (org && !hydrated) {
      setName(org.name);
      setLogo(org.logo ?? null);
      setHydrated(true);
    }
  }, [org, hydrated]);

  const dirty = org ? name.trim() !== org.name || logo !== (org.logo ?? null) : false;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!org || !name.trim()) return;
    setSaving(true);
    setStatus(null);
    const res = await authClient.organization.update({
      organizationId: org.id,
      data: { name: name.trim(), logo: logo ?? "" },
    });
    setSaving(false);
    if (res.error) {
      setStatus({ ok: false, msg: res.error.message ?? "Could not save" });
    } else {
      setStatus({ ok: true, msg: "Saved" });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Organization</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-6" onSubmit={onSubmit}>
          <div className="flex flex-col gap-2">
            <label className="text-sm font-medium">Logo</label>
            <AvatarUploader
              shape="square"
              kind="org-logo"
              value={logo}
              fallback={name || org?.name || "?"}
              disabled={isPending || saving}
              onChange={setLogo}
            />
          </div>

          <div className="flex max-w-sm flex-col gap-2">
            <label htmlFor="org-name" className="text-sm font-medium">
              Organization name
            </label>
            <Input
              id="org-name"
              value={name}
              placeholder="Acme Inc."
              disabled={isPending || saving}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={!dirty || saving || !name.trim()}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
            {status && (
              <span
                className={`text-sm ${status.ok ? "text-accent" : "text-destructive"}`}
              >
                {status.msg}
              </span>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
