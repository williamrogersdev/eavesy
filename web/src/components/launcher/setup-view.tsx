'use client';

import { Check } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Bubble, Button, Kbd, Mascot, type MascotState } from '@/components/launcher/ui';
import { ackDictationText, onDictationText, setDictationInPanel, type AccountInfo, type Permissions, type PrivacyPane } from '@/lib/desktop/bridge';
import { PermissionChecklist, setupPermissionsReady, setupSpeechRefused, usesFnKey, useOnGrant } from './permission-checklist';
import { ShortcutRow, talkHint, useShortcuts } from './shortcut-row';
import type { SetupPermissionKind } from './use-setup-permissions';
import { useLiveLines } from './use-live-lines';

/**
 * The first win comes before any account: allow the mic, talk once, then decide about signing in.
 * The order is also the analytics order (`SETUP_STEPS` in desktop/src-tauri/src/commands.rs).
 */
export const STEPS = ['Permissions', 'Try it', 'Sign in'] as const;
const PERMISSIONS = 0;
const TRY_IT = 1;
const SIGN_IN = 2;

export function SetupView({
  step,
  onStep,
  paired,
  connecting,
  account,
  permissions,
  checking,
  listening,
  liveSessionId,
  dictationHotkey,
  toggleHotkey,
  onConnect,
  onCancelConnect,
  onRequest,
  onOpenPrivacy,
  onRelaunch,
  onShortcutsChanged,
  onFinish,
}: {
  /** Kept by the launcher so a detour to Settings comes back to the same step. */
  step: number;
  onStep: (step: number) => void;
  paired: boolean;
  connecting: boolean;
  account: AccountInfo | null | undefined;
  permissions: Permissions | null;
  checking: SetupPermissionKind | null;
  /** A dictation is recording right now (the mic is live). */
  listening: boolean;
  /** The recording running now, for its words as they are heard. */
  liveSessionId: string | null;
  dictationHotkey: string;
  toggleHotkey: string;
  onConnect: () => void;
  onCancelConnect: () => void;
  onRequest: (kind: SetupPermissionKind) => Promise<boolean>;
  onOpenPrivacy: (pane: PrivacyPane) => void;
  onRelaunch: () => void;
  /** A shortcut was changed on the Try it step. */
  onShortcutsChanged: () => void;
  onFinish: () => void;
}) {
  const setStep = onStep;
  const [cheer, setCheer] = useState(false);
  const [tried, setTried] = useState('');
  // Only a paste proves dictation reached the cursor; typing in the box doesn't count.
  const [pasted, setPasted] = useState(false);
  const fnInUse = usesFnKey(dictationHotkey, toggleHotkey);
  const micOn = permissions?.mic === true;
  const pasteOn = permissions?.accessibility === true;
  const talk = dictationHotkey;
  const shortcuts = useShortcuts(onShortcutsChanged);
  const tryBox = useRef<HTMLTextAreaElement>(null);
  const ready = setupPermissionsReady(permissions, paired);
  const speechRefused = setupSpeechRefused(permissions, paired);
  const hearing = useLiveLines(step === TRY_IT && listening ? liveSessionId : null, 2).map((line) => line.text).join(' ');
  // Dictating into this panel can't go through ⌘V: Eavesy hands the words over itself.
  useEffect(() => {
    if (step !== TRY_IT) return;
    let disposed = false;
    let off: (() => void) | undefined;
    void setDictationInPanel(true).catch(() => {});
    void onDictationText((text, sessionId) => {
      const box = tryBox.current;
      const caret = box ? { start: box.selectionStart, end: box.selectionEnd } : null;
      setTried((current) => {
        const start = caret?.start ?? current.length;
        const end = caret?.end ?? current.length;
        const before = current.slice(0, start);
        const joined = before && !/\s$/.test(before) ? `${before} ${text}` : `${before}${text}`;
        return joined + current.slice(end);
      });
      setPasted(true);
      tryBox.current?.focus();
      void ackDictationText(sessionId).catch(() => {});
    }).then((unlisten) => { if (disposed) unlisten(); else off = unlisten; });
    return () => {
      disposed = true;
      off?.();
      void setDictationInPanel(false).catch(() => {});
    };
  }, [step]);

  // One small lift each time macOS turns something on.
  useOnGrant(permissions, () => setCheer(true));
  useEffect(() => {
    if (!cheer) return;
    const id = window.setTimeout(() => setCheer(false), 1200);
    return () => window.clearTimeout(id);
  }, [cheer]);

  const heard = pasted && tried.trim().length > 0;
  const mascot: MascotState = listening
    ? 'listening'
    : cheer || (step === TRY_IT && heard) || (step === SIGN_IN && paired)
      ? 'happy'
      : step === SIGN_IN && connecting
        ? 'thinking'
        : step === PERMISSIONS && micOn
          ? 'listening'
          : 'idle';

  const bubble: ReactNode = [
    !micOn
      ? "Hi, I'm Eavesy. I type what you say, anywhere. I'll need to borrow your ears, only while you're talking to me."
      : permissions?.speech === false
        ? paired
          ? 'Thank you. Allow Speech Recognition too and I can paste the moment you stop.'
          : 'Thank you. Allow Speech Recognition too, so I can understand you right here on this Mac.'
        : !pasteOn
          ? 'One more and I can type for you, right where your cursor is.'
          : fnInUse && permissions?.inputMonitoring === false
            ? 'One more so I can hear a tap of fn.'
            : 'Lovely. That’s everything I need.',
    heard
      ? 'Heard you. That works in any app, wherever your cursor is.'
      : listening
        ? "I'm listening. Tap again when you're done."
        : "Go on, say something. I'll show you what I heard.",
    paired
      ? "Nice to meet you properly. I'll be in the menu bar, under the hat icon."
      : connecting
        ? "I'll wait here while you finish in the browser."
        : 'Last thing, and it’s up to you.',
  ][step];

  const back = step > 0 ? <Button variant="ghost" size="md" onClick={() => setStep(step - 1)}>Back</Button> : <span />;
  const next = (label = 'Continue', disabled = false, title?: string) => (
    <Button variant="primary" size="md" disabled={disabled} title={title} onClick={() => setStep(step + 1)}>
      {label}
    </Button>
  );

  let body: ReactNode;
  let footer: ReactNode;
  if (step === PERMISSIONS) {
    body = (
      <>
        <h2 className="ev-onb-title">Let Eavesy hear you</h2>
        <p className="ev-onb-lead">macOS asks once for each one. This list updates on its own.</p>
        <div className="ev-card">
          <PermissionChecklist
            permissions={permissions}
            checking={checking}
            fnInUse={fnInUse}
            speechRequired={!paired}
            only={['mic', 'speech', 'accessibility', 'inputMonitoring']}
            onRequest={onRequest}
            onOpenSettings={onOpenPrivacy}
            onRelaunch={onRelaunch}
          />
        </div>
        {!ready ? (
          <p className="ev-onb-note">
            {micOn ? 'Allow Speech Recognition to continue.' : 'Allow the microphone to continue.'} Screenshots, video and notifications can wait for Settings.
          </p>
        ) : speechRefused && (
          <p className="ev-onb-note">Without Speech Recognition, Eavesy can type your words only once you sign in, on the last step.</p>
        )}
      </>
    );
    const why = ready ? undefined : micOn ? 'Allow Speech Recognition first' : 'Allow the microphone first';
    footer = <>{back}{next('Continue', !ready, why)}</>;
  } else if (step === TRY_IT) {
    body = (
      <>
        <h2 className="ev-onb-title">Try it once</h2>
        <p className="ev-onb-lead">
          {speechRefused
            ? 'Without Speech Recognition, Eavesy types your words once you sign in. Do that on the next step, then talk in any app.'
            : !talk
            ? 'Talk has no shortcut yet. Pick one below, then say something. Your words land in the box.'
            : usesFnKey(talk)
            ? <>Tap <Kbd keys="fn" />, say something, then tap <Kbd keys="fn" /> again. Your words land in the box.</>
            : <>Hold <Kbd keys={talk} />, say something, then let go. Your words land in the box.</>}
        </p>
        <textarea
          ref={tryBox}
          autoFocus
          data-listening={listening || undefined}
          className="ev-onb-try"
          value={tried}
          onChange={(event) => {
            setTried(event.target.value);
            const inputType = (event.nativeEvent as InputEvent).inputType;
            if (inputType === 'insertFromPaste') setPasted(true);
            else if (!event.target.value.trim()) setPasted(false);
          }}
          placeholder={listening ? 'Listening… keep talking' : 'Your words land here…'}
          rows={3}
          aria-label="Try dictation here"
        />
        <p className="ev-onb-note" role="status">
          {heard ? (
            <span className="ev-onb-ok"><Check size={14} strokeWidth={2.25} aria-hidden /> Pasted. You’re all set.</span>
          ) : listening ? (
            <span className="ev-onb-hearing"><span className="ev-onb-rec" aria-hidden />{hearing ? <bdi>{hearing}</bdi> : 'Listening… tap again when you’re done.'}</span>
          ) : speechRefused ? (
            'You can still talk now: the recording is saved, and its words reach History once you sign in.'
          ) : pasteOn ? (
            'Nothing to send anywhere. This box is just for practice.'
          ) : (
            <>Accessibility is off, so I’ll copy instead of paste. Press <Kbd keys="⌘V" /> here.</>
          )}
        </p>
        {/* Both shortcuts, so a clash with another app is caught and fixed during setup. */}
        <div className="ev-card">
          <ShortcutRow shortcuts={shortcuts} action="dictation" hint={talkHint(shortcuts.bindings?.dictation ?? '')} />
          <ShortcutRow shortcuts={shortcuts} action="toggle" hint="Shows this panel with everything you've captured." />
        </div>
      </>
    );
    footer = <>{back}{next(heard || speechRefused ? 'Continue' : 'Skip for now')}</>;
  } else {
    body = (
      <>
        <h2 className="ev-onb-title">{paired ? "You're signed in" : 'Sign in, or stay local'}</h2>
        <p className="ev-onb-lead">
          {paired
            ? `${account?.email ?? account?.name ?? 'This Mac'} is connected. Transcripts and summaries sync to your account.`
            : 'Everything stays in ~/Eavesy on this Mac either way. Signing in adds sharper transcripts, summaries, sync across your Macs, and lets Claude, Cursor and other agents read your captures.'}
        </p>
        {connecting && <p className="ev-onb-note">Click “Approve this Mac” on the page that opened. This updates on its own.</p>}
      </>
    );
    const start = (variant: 'primary' | 'ghost', label: string) => (
      <Button variant={variant} size="md" onClick={onFinish}>{label}</Button>
    );
    footer = paired ? (
      <>{back}{start('primary', 'Start using Eavesy')}</>
    ) : connecting ? (
      <>
        <Button variant="ghost" size="md" onClick={onCancelConnect}>Cancel</Button>
        <Button variant="primary" size="md" loading disabled>Waiting for you in the browser…</Button>
      </>
    ) : (
      <>
        {back}
        <div className="flex gap-2">
          {start('ghost', 'Stay local')}
          <Button variant="primary" size="md" onClick={onConnect}>Sign in at eavesy.com</Button>
        </div>
      </>
    );
  }

  return (
    <div className="ev-onb">
      <div className="ev-onb-scroll">
        <div className="ev-onb-hero">
          <Mascot state={mascot} size={96} recording={listening} />
          <Bubble tail="left" className="ev-onb-bubble">{bubble}</Bubble>
        </div>
        <div className="ev-steps" role="img" aria-label={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}>
          {STEPS.map((name, i) => (
            <i key={name} data-state={i < step ? 'done' : i === step ? 'on' : undefined} />
          ))}
          <span>Step {step + 1} of {STEPS.length}</span>
        </div>
        {body}
      </div>
      <div className="ev-onb-foot">{footer}</div>
    </div>
  );
}
