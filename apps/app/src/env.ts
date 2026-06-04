import { z } from "zod";

// Fail fast on misconfiguration instead of crashing deep inside a request.
// Values are supplied by mise (mise.local.toml) in dev and the host env in prod.
const schema = z.object({
  DATABASE_URL: z.string().url(),

  // Better Auth
  BETTER_AUTH_SECRET: z.string().min(1),
  BETTER_AUTH_URL: z.string().url(),

  // Email (Resend). Optional: without it, transactional email is captured to
  // the dev outbox / logged instead of delivered (self-host without email set up).
  RESEND_API_KEY: z.string().optional(),
  // From address for transactional email; override per deployment.
  EMAIL_FROM: z.string().optional(),

  // Social login (reused OAuth apps)
  GOOGLE_ID: z.string().optional(),
  GOOGLE_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),

  // Billing (Stripe). OFF by default: the open-source / self-hosted product is
  // single-org with no paywall. Set BILLING_ENABLED=true (the managed cloud
  // does) to light up the Stripe plugin, per-seat reconcile, and the paywall.
  BILLING_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // Price IDs created by scripts/stripe-setup.mjs (optional until you run it).
  STARTER_PRICE_ID: z.string().optional(),
  STARTER_ANNUAL_PRICE_ID: z.string().optional(),
  TEAMS_PRICE_ID: z.string().optional(),
  TEAMS_ANNUAL_PRICE_ID: z.string().optional(),

  // Git data plane: root dir holding bare repos (<org>/<brain>/<folder>.git).
  GIT_ROOT: z.string().min(1).default("/tmp/monora-git"),

  // Source dir for the default "Monora" guide brain seeded into every org.
  // Ships in the image (Dockerfile COPY of seed/); falls back to the repo path.
  DEFAULT_BRAIN_SEED_DIR: z.string().optional(),

  // Object storage (Cloudflare R2, S3-compatible): avatars, org logos, assets.
  // Fully optional: when unset, binary blobs fall back to a local-disk store and
  // the asset-upload route 503s. No default bucket/URL, so a self-hoster never
  // writes to someone else's storage by accident.
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_PUBLIC_BASE_URL: z.string().url().optional(),
  R2_KEY_PREFIX: z.string().default("monora"),

  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error(
    "❌ Invalid environment variables:",
    z.flattenError(parsed.error).fieldErrors,
  );
  throw new Error("Invalid environment variables");
}

export const env = parsed.data;
