import { AlertCircle, Check, Loader2 } from 'lucide-react';

export type DiscStatus = 'granted' | 'pending' | 'denied' | 'checking';

const LABEL: Record<DiscStatus, string> = {
  granted: 'On',
  pending: 'Not set up yet',
  denied: 'Off',
  checking: 'Checking',
};

export function StatusDisc({ status }: { status: DiscStatus }) {
  return (
    <span className="ev-disc" data-status={status} role="img" aria-label={LABEL[status]}>
      {status === 'granted' && <Check size={14} strokeWidth={2.25} aria-hidden />}
      {status === 'denied' && <AlertCircle size={14} strokeWidth={2} aria-hidden />}
      {status === 'checking' && <Loader2 size={14} strokeWidth={2} className="ev-spin" aria-hidden />}
    </span>
  );
}
