"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Rocket } from "lucide-react";
import { trpc } from "@/lib/trpc/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OnboardingStepper } from "@/components/onboarding-stepper";
import {
  AddBrainButton,
  BrainAvatar,
  Grid,
  Tile,
} from "@/components/brain-explorer";

export default function BrainsIndex() {
  const router = useRouter();
  const brains = trpc.org.listBrains.useQuery();
  const onboarding = trpc.onboarding.status.useQuery();

  // Optimistic while loading: don't flash the setup nag.
  const completed = onboarding.data?.completed ?? true;

  // One brain: skip the list, drop straight into it - but only once you're
  // connected. Before that, stay here so the setup banner stays visible.
  const only = brains.data?.length === 1 ? brains.data[0] : null;
  const autoEnter = !!only && (onboarding.data?.completed ?? false);
  useEffect(() => {
    if (autoEnter && only) router.replace(`/brains/${only.id}`);
  }, [autoEnter, only, router]);

  if (brains.isLoading || onboarding.isLoading || autoEnter) {
    return (
      <div className="mx-auto max-w-5xl px-8 py-8">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  const list = brains.data ?? [];

  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl">Brains</h1>
          <p className="mt-1 text-muted-foreground">
            Each brain is a shared knowledge base - a drive of folders, with git
            underneath and access enforced per folder.
          </p>
        </div>
        <AddBrainButton />
      </div>

      {!completed && <GetStarted />}

      <div className="mt-6">
        {list.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
            No brains yet. Create your first one (e.g. &ldquo;Dreamshot&rdquo;)
            with <span className="font-medium">Add brain</span>.
          </p>
        ) : (
          <Grid>
            {list.map((b) => (
              <Link key={b.id} href={`/brains/${b.id}`}>
                <Tile
                  icon={
                    <BrainAvatar
                      name={b.name}
                      className="size-10 rounded-lg text-base"
                    />
                  }
                  title={b.name}
                  subtitle={`/${b.slug}`}
                />
              </Link>
            ))}
          </Grid>
        )}
      </div>
    </div>
  );
}

function GetStarted() {
  return (
    <Card className="mt-8 border-accent/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Rocket className="size-5 text-accent" />
          Finish setting up Monora
        </CardTitle>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Two steps. They tick off on their own once your agent connects.
        </p>
      </CardHeader>
      <CardContent className="pt-1">
        <OnboardingStepper />
      </CardContent>
    </Card>
  );
}
