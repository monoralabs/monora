"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AvatarUploader } from "@/components/avatar-uploader";
import { authClient } from "@/lib/auth-client";

export default function ProfileSettingsPage() {
  const { data: session, isPending } = authClient.useSession();
  const user = session?.user;

  const [name, setName] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<null | { ok: boolean; msg: string }>(
    null,
  );

  // Seed the form once the session has loaded.
  useEffect(() => {
    if (user && !hydrated) {
      setName(user.name ?? "");
      setImage(user.image ?? null);
      setHydrated(true);
    }
  }, [user, hydrated]);

  const dirty = user
    ? name.trim() !== (user.name ?? "") || image !== (user.image ?? null)
    : false;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user || !name.trim()) return;
    setSaving(true);
    setStatus(null);
    const res = await authClient.updateUser({
      name: name.trim(),
      image: image ?? "",
    });
    setSaving(false);
    if (res.error) {
      setStatus({ ok: false, msg: res.error.message ?? "Could not save" });
    } else {
      setStatus({ ok: true, msg: "Saved" });
    }
  }

  return (
    <>
      <p className="text-muted-foreground">
        Your personal profile, shared across every organization you belong to.
      </p>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-6" onSubmit={onSubmit}>
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium">Photo</label>
              <AvatarUploader
                shape="circle"
                kind="avatar"
                value={image}
                fallback={name || user?.email || "?"}
                disabled={isPending || saving}
                onChange={setImage}
              />
            </div>

            <div className="flex max-w-sm flex-col gap-2">
              <label htmlFor="user-name" className="text-sm font-medium">
                Name
              </label>
              <Input
                id="user-name"
                value={name}
                placeholder="Your name"
                disabled={isPending || saving}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="flex max-w-sm flex-col gap-2">
              <label htmlFor="user-email" className="text-sm font-medium">
                Email
              </label>
              <Input
                id="user-email"
                value={user?.email ?? ""}
                disabled
                readOnly
              />
              <p className="text-xs text-muted-foreground">
                Email changes are not supported yet.
              </p>
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
    </>
  );
}
