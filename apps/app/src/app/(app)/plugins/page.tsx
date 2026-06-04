import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";

export const metadata: Metadata = {
  title: "Plugins - Monora",
};

type Service = {
  name: string;
  logo: string;
  blurb: string;
};

// Connectors we want to bring into the brain. Logos live in /public/logos.
const SERVICES: Service[] = [
  { name: "Gmail", logo: "/logos/gmail.svg", blurb: "Threads, contacts & attachments" },
  { name: "HubSpot", logo: "/logos/hubspot.svg", blurb: "CRM, deals & contacts" },
  { name: "Granola", logo: "/logos/granola.svg", blurb: "Meeting notes & transcripts" },
  { name: "Slack", logo: "/logos/slack.svg", blurb: "Channels & conversations" },
  { name: "Notion", logo: "/logos/notion.svg", blurb: "Docs, wikis & databases" },
  { name: "Google Drive", logo: "/logos/googledrive.svg", blurb: "Files, docs & sheets" },
  { name: "Linear", logo: "/logos/linear.svg", blurb: "Issues, projects & cycles" },
  { name: "Salesforce", logo: "/logos/salesforce.svg", blurb: "Accounts & opportunities" },
  { name: "Zoom", logo: "/logos/zoom.svg", blurb: "Recordings & transcripts" },
  { name: "GitHub", logo: "/logos/github.svg", blurb: "Repos, issues & PRs" },
];

export default function PluginsPage() {
  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl">Plugins</h1>
            <Badge tone="muted">Coming soon</Badge>
          </div>
          <p className="mt-1 text-muted-foreground">
            Connect the tools your team already lives in. Monora pulls their
            knowledge into your brains - synced, searchable, and access-enforced
            per folder.
          </p>
        </div>
      </div>

      <p className="mt-8 text-sm font-medium text-muted-foreground">
        Coming soon...
      </p>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SERVICES.map((s) => (
          <ConnectionTile key={s.name} service={s} />
        ))}
      </div>
    </div>
  );
}

function ConnectionTile({ service }: { service: Service }) {
  return (
    <div className="group relative flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3.5 transition-colors hover:border-accent/40">
      <span className="grid size-10 shrink-0 place-items-center rounded-md border border-border bg-surface-soft">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={service.logo}
          alt={`${service.name} logo`}
          width={22}
          height={22}
          className="size-[22px] opacity-70 grayscale transition group-hover:opacity-100 group-hover:grayscale-0"
        />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{service.name}</p>
        <p className="truncate text-xs text-muted-foreground">{service.blurb}</p>
      </div>
      <span className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground">
        Connect
      </span>
    </div>
  );
}
