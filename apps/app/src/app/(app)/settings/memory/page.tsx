"use client";

import { Trash2, Pause, Play, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc/client";

function when(value: Date | string) {
  return new Date(value).toLocaleString();
}

export default function MemoryPage() {
  const utils = trpc.useUtils();
  const settings = trpc.memory.getSettings.useQuery();
  const observations = trpc.memory.listObservations.useQuery({ limit: 50 });
  const reflections = trpc.memory.listReflections.useQuery({ limit: 25 });
  const events = trpc.memory.listEvents.useQuery({ limit: 25 });

  const updateSettings = trpc.memory.updateSettings.useMutation({
    onSuccess: async () => {
      await utils.memory.getSettings.invalidate();
    },
  });
  const deleteMemory = trpc.memory.deleteMyMemory.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.memory.listEvents.invalidate(),
        utils.memory.listObservations.invalidate(),
        utils.memory.listReflections.invalidate(),
      ]);
    },
  });
  const dreamBrief = trpc.memory.createDreamBrief.useMutation();

  const enabled = settings.data?.enabled ?? true;

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-2xl text-muted-foreground">
          Your AI can keep a private memory of what you do in Monora. It belongs
          to you, follows your key, and stays separate from team activity.
        </p>
        <Badge tone={enabled ? "admin" : "muted"}>
          {enabled ? "enabled" : "paused"}
        </Badge>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Controls</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button
            variant={enabled ? "outline" : "default"}
            disabled={updateSettings.isPending}
            onClick={() => updateSettings.mutate({ enabled: !enabled })}
          >
            {enabled ? <Pause /> : <Play />}
            {enabled ? "Pause memory" : "Resume memory"}
          </Button>
          <Button
            variant="outline"
            disabled={dreamBrief.isPending}
            onClick={() => dreamBrief.mutate()}
          >
            <Sparkles />
            Prepare dream brief
          </Button>
          <Button
            variant="destructive"
            disabled={deleteMemory.isPending}
            onClick={() => {
              if (window.confirm("Delete your private memory?")) {
                deleteMemory.mutate();
              }
            }}
          >
            <Trash2 />
            Delete memory
          </Button>
        </CardContent>
      </Card>

      {dreamBrief.data && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>{dreamBrief.data.title}</CardTitle>
            <p className="font-mono text-xs text-faint">
              {dreamBrief.data.briefId}
            </p>
          </CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap rounded-md bg-secondary p-4 text-sm text-muted-foreground">
              {dreamBrief.data.instructions}
            </pre>
          </CardContent>
        </Card>
      )}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Observations</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col divide-y divide-border/60">
            {observations.data?.map((o) => (
              <div key={o.id} className="py-3">
                <p className="text-sm">{o.body}</p>
                <p className="mt-1 text-xs text-faint">{when(o.createdAt)}</p>
              </div>
            ))}
          </div>
          {observations.data?.length === 0 && (
            <p className="py-4 text-sm text-muted-foreground">
              No observations yet.
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Dream reflections</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-5">
            {reflections.data?.map((r) => (
              <article key={r.id} className="border-b border-border/60 pb-5 last:border-0">
                <div className="flex items-center justify-between gap-4">
                  <h2 className="font-medium">{r.title}</h2>
                  <span className="text-xs text-faint">{when(r.createdAt)}</span>
                </div>
                <div className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
                  {r.bodyMarkdown}
                </div>
              </article>
            ))}
          </div>
          {reflections.data?.length === 0 && (
            <p className="py-4 text-sm text-muted-foreground">
              No dream reflections yet.
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Recent memory events</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="pb-2 font-medium">Event</th>
                <th className="pb-2 text-right font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {events.data?.map((e) => (
                <tr key={e.id} className="border-b border-border/60 last:border-0">
                  <td className="py-2.5 font-mono">{e.eventType}</td>
                  <td className="py-2.5 text-right text-faint">
                    {when(e.observedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {events.data?.length === 0 && (
            <p className="py-4 text-sm text-muted-foreground">Nothing yet.</p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
