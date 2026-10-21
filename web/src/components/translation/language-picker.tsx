import './language-picker.css';
import { Check, Languages } from 'lucide-react';
import { Button, Menu } from '@/components/launcher/ui';
import { LANGUAGES, languageName, type Language } from '@/lib/translation/languages';

/** The language of this text, beside the action that copies it. */
export function LanguagePicker({ value, pending, onChange, onOpenChange, disabled = false }: {
  value: Language | null;
  pending?: boolean;
  onChange: (language: Language | null) => void;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}) {
  return <Menu contentClassName="ev-language-menu" onOpenChange={onOpenChange} align="end" trigger={
    <Button size="sm" variant="ghost" icon={Languages} disabled={disabled} aria-label={value ? `Translation language: ${languageName(value)}` : 'Translate'} title="Change the language of this text">
      {pending ? 'Translating…' : value ? languageName(value) : 'Translate'}
    </Button>
  } items={[
    { id: 'original', label: 'Original', icon: value === null ? Check : undefined, onSelect: () => onChange(null) },
    'separator',
    ...LANGUAGES.map(([code, label]) => ({ id: code, label, icon: value === code ? Check : undefined, onSelect: () => onChange(code) })),
  ]} />;
}
