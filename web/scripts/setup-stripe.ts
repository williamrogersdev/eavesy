import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('✘ STRIPE_SECRET_KEY env var is required.');
  process.exit(1);
}
const APP_URL = process.env.APP_URL ?? 'https://eavesy.com';
const stripe = new Stripe(key);
const mode = key.startsWith('sk_live') ? 'LIVE' : 'TEST';

interface PlanSpec {
  marker: string;
  name: string;
  description: string;
  unitAmount: number;
}

const PLANS: PlanSpec[] = [
  {
    marker: 'pro',
    name: 'Eavesy Pro',
    description: 'Mac app, unlimited recordings, semantic search & templates, sync.',
    unitAmount: 1200,
  },
  {
    marker: 'team',
    name: 'Eavesy Team',
    description: 'Everything in Pro plus shared workspace, SSO & admin, priority support.',
    unitAmount: 2000, // per seat / month
  },
];

const WEBHOOK_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
];

async function findProductByMarker(marker: string): Promise<Stripe.Product | null> {
  try {
    const res = await stripe.products.search({
      query: `metadata['eavesy']:'${marker}'`,
      limit: 1,
    });
    if (res.data[0]) return res.data[0];
  } catch {
    /* search not enabled on some accounts — fall through to list */
  }
  for await (const product of stripe.products.list({ limit: 100 })) {
    if (product.metadata?.eavesy === marker) return product;
  }
  return null;
}

async function ensurePlan(spec: PlanSpec): Promise<string> {
  let product = await findProductByMarker(spec.marker);
  if (!product) {
    product = await stripe.products.create({
      name: spec.name,
      description: spec.description,
      metadata: { eavesy: spec.marker },
    });
    console.log(`  + created product ${spec.name} (${product.id})`);
  } else {
    console.log(`  = reusing product ${spec.name} (${product.id})`);
  }

  let priceId: string | undefined;
  for await (const price of stripe.prices.list({ product: product.id, active: true, limit: 100 })) {
    if (
      price.unit_amount === spec.unitAmount &&
      price.currency === 'usd' &&
      price.recurring?.interval === 'month'
    ) {
      priceId = price.id;
      break;
    }
  }
  if (!priceId) {
    const price = await stripe.prices.create({
      product: product.id,
      currency: 'usd',
      unit_amount: spec.unitAmount,
      recurring: { interval: 'month' },
      metadata: { eavesy: spec.marker },
    });
    priceId = price.id;
    console.log(`  + created price $${(spec.unitAmount / 100).toFixed(2)}/mo (${priceId})`);
  } else {
    console.log(`  = reusing price (${priceId})`);
  }
  return priceId;
}

async function ensureWebhook(): Promise<string | null> {
  const url = `${APP_URL}/api/webhooks/stripe`;
  for await (const ep of stripe.webhookEndpoints.list({ limit: 100 })) {
    if (ep.url === url) {
      console.log(`  = webhook already exists (${ep.id})`);
      console.log('    ⚠  signing secret is only shown at creation — if you lost it,');
      console.log('       roll it in the Stripe dashboard or delete + re-run this script.');
      return null;
    }
  }
  const ep = await stripe.webhookEndpoints.create({
    url,
    enabled_events: WEBHOOK_EVENTS,
    description: 'Eavesy subscription lifecycle',
  });
  console.log(`  + created webhook ${ep.id}`);
  return ep.secret ?? null;
}

async function main() {
  console.log(`\n🔧 Setting up Stripe in ${mode} mode (app: ${APP_URL})\n`);

  console.log('Products & prices:');
  const proPrice = await ensurePlan(PLANS[0]);
  const teamPrice = await ensurePlan(PLANS[1]);

  console.log('\nWebhook:');
  const whSecret = await ensureWebhook();

  console.log('\n────────────────────────────────────────────────');
  console.log('✅ Done. Wire these into the Worker:\n');
  console.log(`STRIPE_PRICE_PRO=${proPrice}`);
  console.log(`STRIPE_PRICE_TEAM=${teamPrice}`);
  if (whSecret) console.log(`STRIPE_WEBHOOK_SECRET=${whSecret}`);
  console.log('\nNext steps (from web/):');
  console.log('  1. Add STRIPE_PRICE_PRO / STRIPE_PRICE_TEAM to wrangler.toml [vars] and .env.local');
  console.log('  2. printf "%s" "<STRIPE_SECRET_KEY>"     | bunx wrangler secret put STRIPE_SECRET_KEY');
  if (whSecret)
    console.log('  3. printf "%s" "<STRIPE_WEBHOOK_SECRET>" | bunx wrangler secret put STRIPE_WEBHOOK_SECRET');
  console.log('  4. Rebuild + deploy: bunx opennextjs-cloudflare build && bunx opennextjs-cloudflare deploy');
  console.log('────────────────────────────────────────────────\n');
}

main().catch((err) => {
  console.error('✘ setup-stripe failed:', err);
  process.exit(1);
});
