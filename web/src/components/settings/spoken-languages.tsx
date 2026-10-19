'use client';

import { X } from 'lucide-react';
import { languageName, MAX_SPOKEN_LANGUAGES, NOTES_LANGUAGES } from '@/lib/transcription/language';
import { cn } from '@/lib/utils';

/** The languages someone speaks, as removable chips and a menu to add another. */
export function SpokenLanguages({
  id,
  value,
  onChange,
  className,
}: {
  id?: string;
  value: string[];
  onChange: (next: string[]) => void;
  className?: string;
}) {
  const remaining = NOTES_LANGUAGES.filter((language) => !value.includes(language.code));
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {value.map((code) => (
        <span key={code} className="ev-chip bg-ev-slate-soft text-ev-slate shadow-none">
          {languageName(code)}
          <button
            type="button"
            onClick={() => onChange(value.filter((item) => item !== code))}
            aria-label={`Remove ${languageName(code)}`}
            className="-mr-1 grid h-4 w-4 place-items-center rounded-full hover:bg-ev-hover"
          >
            <X size={11} strokeWidth={2} aria-hidden />
          </button>
        </span>
      ))}
      {value.length < MAX_SPOKEN_LANGUAGES ? (
        <select
          id={id}
          value=""
          onChange={(event) => {
            if (event.target.value) onChange([...value, event.target.value]);
          }}
          aria-label="Add a language"
          className="ev-chip cursor-pointer appearance-none bg-transparent pr-3 outline-none"
        >
          <option value="">{value.length === 0 ? '+ Add a language' : '+ Add'}</option>
          {remaining.map((language) => (
            <option key={language.code} value={language.code}>
              {language.label}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}
