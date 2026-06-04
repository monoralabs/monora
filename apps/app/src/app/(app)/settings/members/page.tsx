"use client";

import { useState } from "react";
import { UserPlus, RotateCw, X, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc/client";
import { authClient } from "@/lib/auth-client";

export default function MembersPage() {
  const members = trpc.members.list.useQuery();

  return (
    <>
      <p className="text-muted-foreground">
        Invite your team. New members see nothing until you grant them folders
        (deny by default).
      </p>

      <Invite />

      <PendingInvitations />

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Team</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 font-medium">Email</th>
                <th className="pb-2 text-right font-medium">Role</th>
              </tr>
            </thead>
            <tbody>
              {members.data?.map((m) => (
                <tr
                  key={m.userId}
                  className="border-b border-border/60 last:border-0"
                >
                  <td className="py-3 font-medium">{m.name}</td>
                  <td className="py-3 text-muted-foreground">{m.email}</td>
                  <td className="py-3 text-right">
                    <Badge tone={m.role === "owner" ? "admin" : "muted"}>
                      {m.role}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {members.data?.length === 0 && (
            <p className="py-4 text-sm text-muted-foreground">
              Just you so far.
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function Invite() {
  const utils = trpc.useUtils();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [status, setStatus] = useState<null | { ok: boolean; msg: string }>(
    null,
  );
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setPending(true);
    setStatus(null);
    const res = await authClient.organization.inviteMember({
      email: email.trim(),
      role: role as "member" | "admin" | "owner",
    });
    setPending(false);
    if (res.error) {
      // The most common failure is "already invited" - point the user at the
      // pending list below (where they can resend) instead of a dead end.
      const already = /already.*invit/i.test(res.error.message ?? "");
      setStatus({
        ok: false,
        msg: already
          ? `${email.trim()} already has a pending invite - resend or cancel it below.`
          : (res.error.message ?? "Invite failed"),
      });
    } else {
      setStatus({ ok: true, msg: `Invitation sent to ${email.trim()}` });
      setEmail("");
    }
    // Either way, refresh the pending list so a new (or existing) invite shows.
    void utils.members.listInvitations.invalidate();
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Invite a teammate</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="flex flex-wrap items-center gap-2" onSubmit={onSubmit}>
          <Input
            type="email"
            placeholder="teammate@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="max-w-xs"
          />
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="member">member</option>
            <option value="admin">admin</option>
          </Select>
          <Button type="submit" disabled={pending}>
            <UserPlus className="size-4" /> Invite
          </Button>
          {status && (
            <span
              className={`text-xs ${status.ok ? "text-accent" : "text-destructive"}`}
            >
              {status.msg}
            </span>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function PendingInvitations() {
  const utils = trpc.useUtils();
  const invites = trpc.members.listInvitations.useQuery();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState<null | { ok: boolean; msg: string }>(null);

  const resend = trpc.members.resendInvitation.useMutation();
  const cancel = trpc.members.cancelInvitation.useMutation();

  if (!invites.data || invites.data.length === 0) return null;

  async function onResend(id: string, email: string) {
    setBusyId(id);
    setNote(null);
    try {
      await resend.mutateAsync({ invitationId: id });
      setNote({ ok: true, msg: `Invitation resent to ${email}` });
    } catch (e) {
      setNote({
        ok: false,
        msg: e instanceof Error ? e.message : `Could not resend to ${email}`,
      });
    } finally {
      setBusyId(null);
    }
  }

  async function onCancel(id: string, email: string) {
    setBusyId(id);
    setNote(null);
    try {
      await cancel.mutateAsync({ invitationId: id });
      setNote({ ok: true, msg: `Invitation to ${email} canceled` });
      void utils.members.listInvitations.invalidate();
    } catch (e) {
      setNote({
        ok: false,
        msg: e instanceof Error ? e.message : `Could not cancel ${email}`,
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Pending invitations</CardTitle>
      </CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="pb-2 font-medium">Email</th>
              <th className="pb-2 font-medium">Role</th>
              <th className="pb-2 font-medium">Status</th>
              <th className="pb-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {invites.data.map((inv) => {
              const expired = inv.expiresAt.getTime() < Date.now();
              const rowBusy = busyId === inv.id;
              return (
                <tr
                  key={inv.id}
                  className="border-b border-border/60 last:border-0"
                >
                  <td className="py-3 font-medium">{inv.email}</td>
                  <td className="py-3">
                    <Badge tone="muted">{inv.role ?? "member"}</Badge>
                  </td>
                  <td className="py-3">
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <Clock className="size-3.5" />
                      {expired ? "Expired" : "Pending"}
                    </span>
                  </td>
                  <td className="py-3">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={rowBusy}
                        onClick={() => onResend(inv.id, inv.email)}
                      >
                        <RotateCw className="size-3.5" /> Resend
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={rowBusy}
                        onClick={() => onCancel(inv.id, inv.email)}
                      >
                        <X className="size-3.5" /> Cancel
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {note && (
          <p
            className={`mt-3 text-xs ${note.ok ? "text-accent" : "text-destructive"}`}
          >
            {note.msg}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
