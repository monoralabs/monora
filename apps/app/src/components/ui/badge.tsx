import { cn } from "@/lib/utils";

type Tone = "neutral" | "read" | "write" | "admin" | "muted";

const TONES: Record<Tone, string> = {
  neutral: "bg-secondary text-secondary-foreground",
  read: "bg-accent-subtle text-accent",
  write: "bg-accent-subtle text-accent",
  admin: "text-white [background:var(--grad-warm)]",
  muted: "bg-secondary text-muted-foreground",
};

/** Small status pill. `permission` maps read/write/admin to a brand tone. */
export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
