import {
  BookOpen,
  Bot,
  CreditCard,
  LifeBuoy,
  Plug,
  Rocket,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';

export interface CategoryMeta {
  icon: LucideIcon;
  blurb: string;
}

const CATEGORY_META: Record<string, CategoryMeta> = {
  'Getting started': {
    icon: Rocket,
    blurb: 'Install Eavesy and capture your first session in a couple of minutes.',
  },
  'Using Eavesy': {
    icon: Sparkles,
    blurb: 'Recording, transcripts, summaries, templates, search, and exports.',
  },
  'For AI agents': {
    icon: Bot,
    blurb: 'Turn a session into context you can paste — or point an agent at.',
  },
  Integrations: {
    icon: Plug,
    blurb: 'Use Eavesy with your calls, notes apps, and in-person conversations.',
  },
  'Accounts & billing': {
    icon: CreditCard,
    blurb: 'Plans, the data you own, and the controls you have over it.',
  },
  Help: {
    icon: LifeBuoy,
    blurb: 'Shortcuts, fixes for common issues, and answers to frequent questions.',
  },
};

const FALLBACK: CategoryMeta = {
  icon: BookOpen,
  blurb: 'Guides and reference for Eavesy.',
};

export function categoryMeta(category: string): CategoryMeta {
  return CATEGORY_META[category] ?? FALLBACK;
}
