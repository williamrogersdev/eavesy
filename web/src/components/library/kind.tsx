import { AudioLines, Camera, Clapperboard, Image as ImageIcon, Mic, Users, Video, type LucideIcon } from 'lucide-react';
import type { LibItem, LibVariant } from '@/lib/api/use-library';

/** Fixed kind icons (DESIGN.md §4 Iconography). */
const KINDS: Record<LibVariant, { icon: LucideIcon; label: string; plural: string }> = {
  voice: { icon: AudioLines, label: 'Voice note', plural: 'Voice notes' },
  meeting: { icon: Users, label: 'Meeting', plural: 'Meetings' },
  screenshot: { icon: Camera, label: 'Screenshot', plural: 'Screenshots' },
  screen: { icon: Clapperboard, label: 'Screen recording', plural: 'Screen recordings' },
  video: { icon: Video, label: 'Video', plural: 'Videos' },
  audio: { icon: Mic, label: 'Audio', plural: 'Audio' },
  image: { icon: ImageIcon, label: 'Image', plural: 'Images' },
};

export function kindOf(variant: LibVariant) {
  return KINDS[variant] ?? KINDS.audio;
}

export function KindIcon({ item, size = 16, className }: { item: Pick<LibItem, 'variant'>; size?: number; className?: string }) {
  const Icon = kindOf(item.variant).icon;
  return <Icon size={size} strokeWidth={1.75} className={className} aria-hidden />;
}
