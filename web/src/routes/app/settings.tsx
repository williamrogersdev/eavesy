import { DictionarySettings } from '@/components/dictionary/dictionary-settings';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { isRecord, optionalString } from '@/lib/json';
import { cn } from '@/lib/utils';
import { AppAlert, AppPage, AppPageHeader, AppRow as Row, AppSection, appButton, appInput as input } from '@/components/ui/app-page';
import { AccountData } from '@/components/settings/account-data';
import { TemplateManager } from '@/components/settings/template-manager';
import { refreshMe } from '@/lib/api/use-me';
import { NOTES_LANGUAGES } from '@/lib/transcription/language';
import { dictationStyle, isWritingChoice, WRITING_CHOICES, writingChoice, writingFor, type DictationStyle } from '@/lib/transcription/dictation-style';
import { SpokenLanguages } from '@/components/settings/spoken-languages';
import { MAX_TERM_LENGTH, MAX_VOCABULARY_TERMS } from '@/lib/transcription/vocabulary';
import { ChipInput } from '@/components/ui/chip-input';
import { SaveToast, useSaveToast } from '@/components/ui/save-toast';
import { Link } from '@/components/ui/app-link';

interface Me {
  id: string;
  email?: string;
  displayName?: string;
  companyName?: string | null;
  role?: string | null;
  phoneNumber?: string | null;
  isAnonymous: boolean;
  defaultTranscriptionEngine: 'whisper';
  defaultLanguage: string;
  notesLanguage: string | null;
  spokenLanguages: string[];
  customVocabulary: string[];
  dictationStyle: DictationStyle;
  dictationForAgents: boolean;
  emailRecaps: boolean;
  emailRecapTranscript: boolean;
  emailRecapsAvailable: boolean;
  shareNotesOffer: boolean;
  shareNotesScope: 'everyone' | 'domain';
  shareNotesAuto: boolean;
  /** The owner's company domain, or null for a personal webmail address. */
  companyDomain: string | null;
  hasAnthropicKey: boolean;
  anthropicKeyHint?: string | null;
  hasOpenRouterKey: boolean;
  openRouterConnectedAt?: number | null;
}

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'transcription', label: 'Transcription' },
  { id: 'notes', label: 'Notes and email' },
  { id: 'data', label: 'Your data' },
] as const;
type Tab = (typeof TABS)[number]['id'];

/** The tab a URL hash opens; `#email` is linked from notes emails. */
function tabForHash(hash: string): Tab {
  const id = hash.replace(/^#/, '');
  if (id === 'email') return 'notes';
  return TABS.find((tab) => tab.id === id)?.id ?? 'general';
}

export const Route = createFileRoute('/app/settings')({
  component: SettingsPage,
});

function SettingsPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [saving, setSaving] = useState(false);
  const [displayName, setDisplayName] = useState('');
  // Read from the URL after hydration, so the server and first client render agree.
  const [tab, setTab] = useState<Tab>('general');
  const vocabularySave = useRef(0);
  const savedVocabulary = useRef<{ attempt: number; words: string[] }>({ attempt: 0, words: [] });
  const navigate = useNavigate();
  const toast = useSaveToast();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (window.location.hash === '#projects') {
      void navigate({ to: '/app/projects', replace: true });
      return;
    }
    const params = new URLSearchParams(window.location.search);
    // Old Mac builds opened /app/settings?pair=CODE; /connect/mac approves codes now.
    const pairCode = params.get('pair');
    if (pairCode) {
      window.location.replace(`/connect/mac?code=${encodeURIComponent(pairCode)}`);
      return;
    }
    // Connections moved to Integrations; an old link's outcome is shown there.
    if (params.has('connected') || params.has('error')) {
      window.location.replace(`/app/integrations?${params.toString()}`);
      return;
    }
    const followHash = () => setTab(tabForHash(window.location.hash));
    followHash();
    window.addEventListener('hashchange', followHash);
    return () => window.removeEventListener('hashchange', followHash);
  }, [navigate]);

  const openTab = (next: Tab) => {
    setTab(next);
    window.history.replaceState({}, '', next === 'general' ? '/app/settings' : `/app/settings#${next}`);
  };

  useEffect(() => {
    void fetch('/api/me')
      .then(async (r): Promise<unknown> => r.json())
      .then((data) => {
        const account = parseMe(data);
        if (!account) throw new Error('Server returned invalid account settings');
        setMe(account);
        setDisplayName(account.displayName ?? '');
        savedVocabulary.current = { attempt: 0, words: account.customVocabulary };
      })
      .catch(() => setError('Could not load account settings.'));
  }, []);

  const saveName = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayName }),
      });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      setMe((current) => (current ? { ...current, displayName: displayName.trim() } : current));
      void refreshMe();
      toast.show();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save settings.');
    } finally {
      setSaving(false);
    }
  };

  const saveLanguage = async (change: Partial<Pick<Me, 'defaultLanguage' | 'notesLanguage' | 'spokenLanguages' | 'dictationStyle' | 'dictationForAgents'>>) => {
    const previous = me;
    setError(null);
    if (previous) setMe({ ...previous, ...change });
    try {
      const response = await fetch('/api/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(change),
      });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      void refreshMe();
      toast.show();
    } catch (cause) {
      setMe(previous);
      setError(cause instanceof Error ? cause.message : 'Could not save the language.');
    }
  };

  const saveRecaps = async (change: Partial<Pick<Me, 'emailRecaps' | 'emailRecapTranscript' | 'shareNotesOffer' | 'shareNotesScope' | 'shareNotesAuto'>>) => {
    const previous = me;
    setError(null);
    if (previous) setMe({ ...previous, ...change });
    try {
      const response = await fetch('/api/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(change),
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        throw new Error(isRecord(body) && typeof body.error === 'string' && body.error !== 'invalid_request' ? body.error : `Server returned ${response.status}`);
      }
      void refreshMe();
      toast.show();
    } catch (cause) {
      setMe(previous);
      setError(cause instanceof Error ? cause.message : 'Could not save email recaps.');
    }
  };

  const saveVocabulary = async (customVocabulary: string[]) => {
    const attempt = ++vocabularySave.current;
    setError(null);
    setMe((current) => (current ? { ...current, customVocabulary } : current));
    try {
      const response = await fetch('/api/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ customVocabulary }),
      });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      if (attempt > savedVocabulary.current.attempt) savedVocabulary.current = { attempt, words: customVocabulary };
      if (attempt === vocabularySave.current) toast.show();
    } catch (cause) {
      if (attempt !== vocabularySave.current) return;
      setMe((current) => (current ? { ...current, customVocabulary: savedVocabulary.current.words } : current));
      setError(cause instanceof Error ? `Could not save your words: ${cause.message}` : 'Could not save your words.');
    }
  };

  if (!me && error) {
    return <AppPage width="reading"><AppAlert>{error}</AppAlert></AppPage>;
  }
  if (!me) {
    return <AppPage width="reading"><p role="status" className="text-sm text-ev-ink-2">Loading settings…</p></AppPage>;
  }

  const nameChanged = displayName.trim() !== (me.displayName ?? '');

  return (
    <AppPage width="reading">
      <AppPageHeader title="Settings" />

      <div role="tablist" aria-label="Settings" className="flex gap-1 overflow-x-auto border-b border-ev-line">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`settings-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls="settings-panel"
            onClick={() => openTab(item.id)}
            className={cn(
              '-mb-px shrink-0 border-b-2 px-3 pb-2.5 pt-1 font-round text-[13.5px] font-bold transition',
              tab === item.id ? 'border-ev-coat text-ev-coat' : 'border-transparent text-ev-ink-2 hover:text-ev-ink',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error ? <AppAlert>{error}</AppAlert> : null}

      <div id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`} className="flex max-w-2xl flex-col gap-5">
        {tab === 'general' ? (
          <>
            <AppSection title="Account">
              <Row label="Email">
                <span className="text-sm">{me.email ?? '—'}</span>
              </Row>
              <Row label="Name" htmlFor="settings-display-name">
                <div className="flex w-full gap-2">
                  <input
                    id="settings-display-name"
                    type="text"
                    autoComplete="name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && nameChanged && !saving) void saveName();
                    }}
                    className={input}
                  />
                  {nameChanged ? (
                    <button type="button" onClick={() => void saveName()} disabled={saving} className={appButton('primary')}>
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                  ) : null}
                </div>
              </Row>
            </AppSection>
            <AppSection title="Connections">
              <Row label="Calendar, AI apps and API keys" hint="Everything Eavesy connects to.">
                <Link href="/app/integrations" className={appButton('secondary', 'sm')}>Open Integrations</Link>
              </Row>
            </AppSection>
          </>
        ) : null}

        {tab === 'transcription' ? (
          <>
            <AppSection title="Languages">
              <Row label="Languages you speak" hint="Empty detects any language." htmlFor="settings-language">
                <SpokenLanguages
                  id="settings-language"
                  value={me.spokenLanguages}
                  onChange={(spokenLanguages) => void saveLanguage({ spokenLanguages, defaultLanguage: 'auto' })}
                />
              </Row>
              <Row label="Notes language" hint="Transcripts in another language get a Translate button." htmlFor="settings-notes-language">
                <select
                  id="settings-notes-language"
                  value={me.notesLanguage ?? ''}
                  onChange={(e) => void saveLanguage({ notesLanguage: e.target.value || null })}
                  className={`${input} sm:w-56`}
                >
                  <option value="">Same as the meeting</option>
                  {NOTES_LANGUAGES.map((language) => (
                    <option key={language.code} value={language.code}>
                      {language.label}
                    </option>
                  ))}
                </select>
              </Row>
            </AppSection>
            <AppSection title="Dictation">
              <Row
                label="Write dictation"
                hint={WRITING_CHOICES.find((choice) => choice.id === writingChoice({ style: me.dictationStyle, forAgents: me.dictationForAgents }))?.hint ?? ''}
                htmlFor="settings-dictation-style"
              >
                <select
                  id="settings-dictation-style"
                  value={writingChoice({ style: me.dictationStyle, forAgents: me.dictationForAgents })}
                  onChange={(e) => {
                    if (!isWritingChoice(e.target.value)) return;
                    const writing = writingFor(e.target.value, { style: me.dictationStyle, forAgents: me.dictationForAgents });
                    void saveLanguage({ dictationStyle: writing.style, dictationForAgents: writing.forAgents });
                  }}
                  className={`${input} sm:w-56`}
                >
                  {WRITING_CHOICES.map((choice) => (
                    <option key={choice.id} value={choice.id}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </Row>
            </AppSection>
            <AppSection
              title="Custom words"
              description={
                <>
                  Names and jargon to spell your way. Words for one client belong
                  in <Link href="/app/projects" className="underline underline-offset-2 hover:text-ev-ink">Projects</Link>.
                </>
              }
            >
              <ChipInput
                id="settings-vocabulary"
                label="Custom words"
                value={me.customVocabulary}
                onChange={(next) => void saveVocabulary(next)}
                max={MAX_VOCABULARY_TERMS}
                maxLength={MAX_TERM_LENGTH}
                placeholder="Eavesy, Priya Raman, Kubernetes…"
                hint="Press Enter or comma after each."
              />
            </AppSection>
            <AppSection title="Personal dictionary">
              <DictionarySettings />
            </AppSection>
          </>
        ) : null}

        {tab === 'notes' ? (
          <>
            <TemplateManager />
            <AppSection
              id="email"
              title="Email"
              description={me.emailRecapsAvailable ? `Notes go to ${me.email ?? 'your address'} after each meeting.` : 'Email is not set up on this server.'}
            >
              <Row label="Email me notes after every meeting" htmlFor="settings-email-recaps">
                <input
                  id="settings-email-recaps"
                  type="checkbox"
                  checked={me.emailRecaps}
                  disabled={!me.emailRecapsAvailable || me.isAnonymous || !me.email}
                  onChange={(e) => void saveRecaps({ emailRecaps: e.target.checked })}
                />
              </Row>
              <Row label="Attach the transcript" htmlFor="settings-email-recap-transcript">
                <input
                  id="settings-email-recap-transcript"
                  type="checkbox"
                  checked={me.emailRecapTranscript}
                  disabled={!me.emailRecapsAvailable}
                  onChange={(e) => void saveRecaps({ emailRecapTranscript: e.target.checked })}
                />
              </Row>
            </AppSection>
            <AppSection title="Sharing notes with attendees">
              <Row label="Offer “Send to everyone”" hint="You review the list before anything is sent." htmlFor="settings-share-notes-offer">
                <input
                  id="settings-share-notes-offer"
                  type="checkbox"
                  checked={me.shareNotesOffer}
                  disabled={!me.emailRecapsAvailable}
                  onChange={(e) => void saveRecaps({ shareNotesOffer: e.target.checked })}
                />
              </Row>
              <Row
                label="Who can receive notes"
                hint={me.shareNotesScope === 'domain' && !me.companyDomain ? 'Your address is a personal one, so nobody counts as your company.' : undefined}
                htmlFor="settings-share-notes-scope"
              >
                <select
                  id="settings-share-notes-scope"
                  value={me.shareNotesScope}
                  disabled={!me.emailRecapsAvailable}
                  onChange={(e) => void saveRecaps({ shareNotesScope: e.target.value === 'domain' ? 'domain' : 'everyone' })}
                  className={`${input} sm:w-56`}
                >
                  <option value="everyone">Everyone</option>
                  <option value="domain">{me.companyDomain ? `Only people at ${me.companyDomain}` : 'Only my company’s domain'}</option>
                </select>
              </Row>
              <Row label="Send to attendees automatically" hint="Without asking you first." htmlFor="settings-share-notes-auto">
                <input
                  id="settings-share-notes-auto"
                  type="checkbox"
                  checked={me.shareNotesAuto}
                  disabled={!me.emailRecapsAvailable || !me.emailRecaps}
                  onChange={(e) => void saveRecaps({ shareNotesAuto: e.target.checked })}
                />
              </Row>
            </AppSection>
          </>
        ) : null}

        {tab === 'data' ? (
          <AppSection title="Your data">
            <AccountData email={me.email} />
          </AppSection>
        ) : null}
      </div>

      <SaveToast text={toast.text} />
    </AppPage>
  );
}

function parseMe(value: unknown): Me | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== 'string' ||
    typeof value.isAnonymous !== 'boolean' ||
    value.defaultTranscriptionEngine !== 'whisper' ||
    typeof value.defaultLanguage !== 'string' ||
    typeof value.hasAnthropicKey !== 'boolean' ||
    typeof value.hasOpenRouterKey !== 'boolean'
  ) {
    return null;
  }
  return {
    id: value.id,
    email: optionalString(value.email),
    displayName: optionalString(value.displayName),
    companyName: nullableString(value.companyName),
    role: nullableString(value.role),
    phoneNumber: nullableString(value.phoneNumber),
    isAnonymous: value.isAnonymous,
    defaultTranscriptionEngine: 'whisper',
    defaultLanguage: value.defaultLanguage,
    notesLanguage: typeof value.notesLanguage === 'string' ? value.notesLanguage : null,
    spokenLanguages: Array.isArray(value.spokenLanguages)
      ? value.spokenLanguages.filter((code): code is string => typeof code === 'string')
      : [],
    customVocabulary: Array.isArray(value.customVocabulary)
      ? value.customVocabulary.filter((term): term is string => typeof term === 'string')
      : [],
    dictationStyle: dictationStyle(value.dictationStyle),
    dictationForAgents: value.dictationForAgents === true,
    emailRecaps: value.emailRecaps === true,
    emailRecapTranscript: value.emailRecapTranscript === true,
    emailRecapsAvailable: value.emailRecapsAvailable === true,
    shareNotesOffer: value.shareNotesOffer !== false,
    shareNotesScope: value.shareNotesScope === 'domain' ? 'domain' : 'everyone',
    shareNotesAuto: value.shareNotesAuto === true,
    companyDomain: typeof value.companyDomain === 'string' ? value.companyDomain : null,
    hasAnthropicKey: value.hasAnthropicKey,
    anthropicKeyHint: nullableString(value.anthropicKeyHint),
    hasOpenRouterKey: value.hasOpenRouterKey,
    openRouterConnectedAt: nullableNumber(value.openRouterConnectedAt),
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}
