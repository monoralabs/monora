// Idempotent Stripe product/price setup for Monora. Run once per environment:
//
//   mise exec -- node scripts/stripe-setup.mjs
//
// Uses STRIPE_SECRET_KEY from the environment (test key in dev via mise; pass a
// live key for production). Safe to re-run: products are matched by metadata and
// prices by lookup_key, so nothing is duplicated. Prints the price IDs to drop
// into mise.local.toml.
//
// Plans mirror the landing (apps/web pricing-monora.tsx): per-seat pricing,
// annual = 20% off. Enterprise is "talk to us" (no Stripe price).
import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("Missing STRIPE_SECRET_KEY in env (mise).");
  process.exit(1);
}
const stripe = new Stripe(key);
const live = key.startsWith("sk_live");
console.log(`\nStripe setup in ${live ? "LIVE" : "TEST"} mode\n`);

// Per-seat amounts in cents (USD, matching the landing's "$/seat/mo").
const PLANS = [
  {
    slug: "starter",
    name: "Monora Starter",
    monthly: 800, // $8 / seat / mo
    annual: 7200, // $6 / seat / mo billed yearly => $72 / seat / yr
  },
  {
    slug: "teams",
    name: "Monora Teams",
    monthly: 1500, // $15 / seat / mo
    annual: 14400, // $12 / seat / mo billed yearly => $144 / seat / yr
  },
];

async function findProduct(slug) {
  const res = await stripe.products.search({
    query: `metadata['monora_plan']:'${slug}'`,
  });
  return res.data[0] ?? null;
}

async function ensureProduct(plan) {
  const existing = await findProduct(plan.slug);
  if (existing) {
    console.log(`  product ${plan.slug}: reuse ${existing.id}`);
    return existing;
  }
  const created = await stripe.products.create({
    name: plan.name,
    metadata: { monora_plan: plan.slug },
  });
  console.log(`  product ${plan.slug}: created ${created.id}`);
  return created;
}

async function findPriceByLookupKey(lookupKey) {
  const res = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 });
  return res.data[0] ?? null;
}

async function ensurePrice(product, lookupKey, unitAmount, interval) {
  const existing = await findPriceByLookupKey(lookupKey);
  if (existing) {
    console.log(`  price ${lookupKey}: reuse ${existing.id}`);
    return existing;
  }
  const created = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: unitAmount,
    recurring: { interval, usage_type: "licensed" }, // per-seat => quantity at checkout
    lookup_key: lookupKey,
    metadata: { monora_plan: product.metadata.monora_plan },
  });
  console.log(`  price ${lookupKey}: created ${created.id}`);
  return created;
}

const out = {};
for (const plan of PLANS) {
  console.log(`Plan ${plan.slug}:`);
  const product = await ensureProduct(plan);
  const monthly = await ensurePrice(
    product,
    `${plan.slug}_monthly`,
    plan.monthly,
    "month",
  );
  const annual = await ensurePrice(
    product,
    `${plan.slug}_annual`,
    plan.annual,
    "year",
  );
  out[`${plan.slug.toUpperCase()}_PRICE_ID`] = monthly.id;
  out[`${plan.slug.toUpperCase()}_ANNUAL_PRICE_ID`] = annual.id;
}

console.log("\n--- Paste into mise.local.toml ---\n");
for (const [k, v] of Object.entries(out)) {
  console.log(`${k} = "${v}"`);
}
console.log("");
