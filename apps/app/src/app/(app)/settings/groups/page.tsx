"use client";

import { useState } from "react";
import { Users, Plus, X, Trash2, Check, Pencil } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc/client";

type Tone = "read" | "write" | "admin" | "muted";
const permTone = (p: string): Tone =>
  p === "admin" ? "admin" : p === "write" ? "write" : "read";

export default function GroupsPage() {
  const groups = trpc.groups.list.useQuery();

  return (
    <>
      <p className="text-muted-foreground">
        Groups bundle folder access. Put people in a group and they get all its
        folders at once. Effective access is the highest of someone&apos;s
        direct grants and every group they&apos;re in.
      </p>

      <CreateGroup />

      {groups.data?.length === 0 && (
        <p className="mt-6 text-sm text-muted-foreground">
          No groups yet. Create one above (e.g. Sales, Finance, Exec).
        </p>
      )}

      <div className="mt-6 space-y-4">
        {groups.data?.map((g) => (
          <GroupCard
            key={g.id}
            group={{ id: g.id, name: g.name, slug: g.slug }}
            memberCount={g.memberCount}
            grantCount={g.grantCount}
          />
        ))}
      </div>
    </>
  );
}

function CreateGroup() {
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [status, setStatus] = useState<null | { ok: boolean; msg: string }>(
    null,
  );
  const create = trpc.groups.create.useMutation({
    onSuccess: (g) => {
      setStatus({ ok: true, msg: `Created ${g.name}` });
      setName("");
      void utils.groups.list.invalidate();
    },
    onError: (e) => setStatus({ ok: false, msg: e.message }),
  });

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>New group</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate({ name: name.trim() });
          }}
        >
          <Input
            placeholder="Sales"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="max-w-xs"
          />
          <Button type="submit" disabled={create.isPending}>
            <Plus className="size-4" /> Create
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

function GroupCard({
  group,
  memberCount,
  grantCount,
}: {
  group: { id: string; name: string; slug: string };
  memberCount: number;
  grantCount: number;
}) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(group.name);

  const refresh = () => void utils.groups.list.invalidate();
  const rename = trpc.groups.rename.useMutation({
    onSuccess: () => {
      setEditing(false);
      refresh();
    },
  });
  const del = trpc.groups.delete.useMutation({ onSuccess: refresh });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          {editing ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim())
                  rename.mutate({ groupId: group.id, name: name.trim() });
              }}
            >
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-8 max-w-xs"
                autoFocus
              />
              <Button type="submit" size="sm" disabled={rename.isPending}>
                <Check className="size-3.5" /> Save
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setName(group.name);
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            </form>
          ) : (
            <CardTitle className="flex items-center gap-2">
              <Users className="size-4 text-muted-foreground" />
              {group.name}
              <span className="text-xs font-normal text-faint">
                {memberCount} member{memberCount === 1 ? "" : "s"} ·{" "}
                {grantCount} folder{grantCount === 1 ? "" : "s"}
              </span>
            </CardTitle>
          )}
          {!editing && (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditing(true)}
              >
                <Pencil className="size-3.5" /> Rename
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={del.isPending}
                onClick={() => {
                  if (
                    confirm(
                      `Delete "${group.name}"? Members lose the folders they reach only through this group.`,
                    )
                  )
                    del.mutate({ groupId: group.id });
                }}
              >
                <Trash2 className="size-3.5 text-destructive" />
              </Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <GroupMembers groupId={group.id} />
        <GroupGrants groupId={group.id} />
      </CardContent>
    </Card>
  );
}

function GroupMembers({ groupId }: { groupId: string }) {
  const utils = trpc.useUtils();
  const members = trpc.groups.membersOf.useQuery({ groupId });
  const orgMembers = trpc.members.list.useQuery();
  const [pick, setPick] = useState("");

  const refresh = () => {
    void utils.groups.membersOf.invalidate({ groupId });
    void utils.groups.list.invalidate();
  };
  const add = trpc.groups.addMember.useMutation({
    onSuccess: () => {
      setPick("");
      refresh();
    },
  });
  const remove = trpc.groups.removeMember.useMutation({ onSuccess: refresh });

  const inGroup = new Set(members.data?.map((m) => m.userId));
  const candidates = (orgMembers.data ?? []).filter(
    (m) => !inGroup.has(m.userId),
  );

  return (
    <div>
      <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-faint">
        Members
      </h4>
      <div className="space-y-1">
        {members.data?.map((m) => (
          <div
            key={m.userId}
            className="flex items-center justify-between gap-3 rounded-md px-1.5 py-1.5 hover:bg-secondary/50"
          >
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{m.name}</div>
              <div className="truncate text-xs text-faint">{m.email}</div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={remove.isPending}
              onClick={() => remove.mutate({ groupId, userId: m.userId })}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ))}
        {members.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">No members yet.</p>
        )}
      </div>
      {candidates.length > 0 && (
        <div className="mt-2 flex items-center gap-2">
          <Select
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            className="max-w-xs"
          >
            <option value="">Add a member…</option>
            {candidates.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name} ({m.email})
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            disabled={!pick || add.isPending}
            onClick={() => pick && add.mutate({ groupId, userId: pick })}
          >
            <Plus className="size-3.5" /> Add
          </Button>
        </div>
      )}
    </div>
  );
}

function GroupGrants({ groupId }: { groupId: string }) {
  const utils = trpc.useUtils();
  const grants = trpc.groups.grantsOf.useQuery({ groupId });
  const revoke = trpc.groups.revokeFolder.useMutation({
    onSuccess: () => {
      void utils.groups.grantsOf.invalidate({ groupId });
      void utils.groups.list.invalidate();
    },
  });

  return (
    <div>
      <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-faint">
        Folders
      </h4>
      <div className="space-y-1">
        {grants.data?.map((g) => (
          <div
            key={g.folderId}
            className="flex items-center justify-between gap-3 rounded-md px-1.5 py-1.5 hover:bg-secondary/50"
          >
            <span className="truncate text-sm">{g.folderPath}</span>
            <div className="flex items-center gap-2">
              <Badge tone={permTone(g.permission)}>{g.permission}</Badge>
              <Button
                variant="ghost"
                size="sm"
                disabled={revoke.isPending}
                onClick={() =>
                  revoke.mutate({ groupId, folderId: g.folderId })
                }
              >
                <X className="size-3.5" />
              </Button>
            </div>
          </div>
        ))}
        {grants.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No folders yet. Grant a folder to this group from its{" "}
            <span className="font-medium">Share</span> menu in the brain.
          </p>
        )}
      </div>
    </div>
  );
}
