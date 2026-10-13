export type PlanId = 'free' | 'pro' | 'team';

export type PlanCheckout =
  | { kind: 'free' }
  | { kind: 'stripe' }
  | { kind: 'contact' };

export interface PlanDef {
  id: PlanId;
  name: string;
  price: string;
  period?: string;
  tagline: string;
  features: string[];
  checkout: PlanCheckout;
  featured?: boolean;
  comingSoon?: boolean;
}

export const PLAN_DEFS: PlanDef[] = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    tagline: 'For trying it out',
    features: [
      'Record in your browser',
      'No length limit',
      'AI transcript + summary',
      'Export to Markdown & audio',
    ],
    checkout: { kind: 'free' },
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$12',
    period: '/mo',
    tagline: 'For daily drivers',
    featured: true,
    comingSoon: true,
    features: [
      'Everything in Free',
      'Mac app — system audio',
      'Semantic search & templates',
      'Sync across devices',
    ],
    checkout: { kind: 'stripe' },
  },
  {
    id: 'team',
    name: 'Team',
    price: '$20',
    period: '/user/mo',
    tagline: 'For teams',
    features: [
      'Everything in Pro',
      'Shared workspace',
      'SSO & admin controls',
      'Priority support',
    ],
    checkout: { kind: 'contact' },
  },
];

export function getPlan(id: PlanId): PlanDef {
  const plan = PLAN_DEFS.find((p) => p.id === id);
  if (!plan) throw new Error(`Unknown plan: ${id}`);
  return plan;
}

export const CONTACT_SALES_EMAIL = 'sales@eavesy.com';
