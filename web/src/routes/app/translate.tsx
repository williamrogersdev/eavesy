import { createFileRoute } from '@tanstack/react-router';
import { Translator } from '@/components/translation/translator';

export const Route = createFileRoute('/app/translate')({ component: TranslatePage });

function TranslatePage() {
  return <div className="ev relative mx-auto flex min-h-[520px] max-w-2xl flex-col p-4"><Translator /></div>;
}
