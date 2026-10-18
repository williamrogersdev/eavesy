'use client';

import { Check } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Bubble, Button, Kbd, Mascot, type MascotState } from '@/components/launcher/ui';
import type { AccountInfo, Permissions, PrivacyPane } from '@/lib/desktop/bridge';
import { PermissionChecklist, usesFnKey, useOnGrant } from './permission-checklist';
import { ShortcutRow, talkHint, useShortcuts } from './shortcut-row';
import type { SetupPermissionKind } from './use-setup-permissions';

const STEPS = ['Sign in', 'Permissions', 'Shortcuts', 'Done'] as const;

export function SetupView({
  step,
  onStep,
  paired,
  connecting,
  account,
  permissions,
  checking,
  listening,
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
  dictationHotkey: string;
  toggleHotkey: string;
  onConnect: () => void;
  onCancelConnect: () => void;
  onRequest: (kind: SetupPermissionKind) => Promise<boolean>;
  onOpenPrivacy: (pane: PrivacyPane) => void;
  onRelaunch: () => void;
  /** A shortcut was changed on the Shortcuts step. */
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
  const talk = dictationHotkey || '⌘⇧D';
  const shortcuts = useShortcuts(onShortcutsChanged);

  // Signing in finishes in the browser; when it does, move on by ourselves.
  // (The step lives in the launcher, so this runs as an effect, not during render.)
  const wasPaired = useRef(paired);
  useEffect(() => {
    if (paired && !wasPaired.current && step === 0) onStep(1);
    wasPaired.current = paired;
  }, [paired, step, onStep]);

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
    : cheer || (step === 3 && heard)
      ? 'happy'
      : step === 0 && connecting
        ? 'thinking'
        : step === 1 && micOn
          ? 'listening'
          : 'idle';

  const bubble: ReactNode = [
    paired
      ? 'Nice to meet you properly. Your captures will sync to your account.'
      : connecting
        ? "I'll wait here while you finish in the browser."
        : "Hi, I'm Eavesy. I live up here and write things down for you.",
    !micOn
      ? "I'll need to borrow your ears. Only while you're talking to me, promise."
      : permissions?.speech === false
        ? 'Thank you. Allow Speech Recognition too and I can paste the moment you stop.'
        : !pasteOn
          ? 'One more and I can type for you, right where your cursor is.'
        : 'Lovely. The rest just makes me more useful.',
    'Two keys are all you need. You can change them any time.',
    heard
      ? "Heard you. That's it, I'll be in the menu bar."
      : "That's it. I'll be in the menu bar, under the roof icon.",
  ][step];

  const back = step > 0 ? <Button variant="ghost" size="md" onClick={() => setStep(step - 1)}>Back</Button> : <span />;
  const next = (label = 'Continue', disabled = false, title?: string) => (
    <Button variant="primary" size="md" disabled={disabled} title={title} onClick={() => setStep(step + 1)}>
      {label}
    </Button>
  );

  let body: ReactNode;
  let footer: ReactNode;
  if (step === 0) {
    body = (
      <>
        <h2 className="ev-onb-title">{paired ? "You're signed in" : 'Sign in, or stay local'}</h2>
        <p className="ev-onb-lead">
          {paired
            ? `${account?.email ?? account?.name ?? 'This Mac'} is connected. Transcripts and summaries sync to your account.`
            : 'Recordings stay in ~/Eavesy on this Mac either way. Signing in adds transcripts, summaries and sync across your devices.'}
        </p>
        {connecting && <p className="ev-onb-note">Click “Approve this Mac” on the page that opened. This updates on its own.</p>}
      </>
    );
    footer = paired ? (
      <>{back}{next()}</>
    ) : connecting ? (
      <>
        <Button variant="ghost" size="md" onClick={onCancelConnect}>Cancel</Button>
        <Button variant="primary" size="md" loading disabled>Waiting for you in the browser…</Button>
      </>
    ) : (
      <>
        <Button variant="ghost" size="md" onClick={() => setStep(1)}>Stay local for now</Button>
        <Button variant="primary" size="md" onClick={onConnect}>Sign in at eavesy.com</Button>
      </>
    );
  } else if (step === 1) {
    body = (
      <>
        <h2 className="ev-onb-title">Let Eavesy hear you</h2>
        <p className="ev-onb-lead">macOS asks once for each one. This list updates on its own.</p>
        <div className="ev-card">
          <PermissionChecklist
            permissions={permissions}
            checking={checking}
            fnInUse={fnInUse}
            only={['mic', 'speech', 'accessibility', 'inputMonitoring']}
            onRequest={onRequest}
            onOpenSettings={onOpenPrivacy}
            onRelaunch={onRelaunch}
          />
        </div>
        <h3 className="ev-card-title ev-onb-later">Later is fine</h3>
        <div className="ev-card">
          <PermissionChecklist
            permissions={permissions}
            checking={checking}
            fnInUse={fnInUse}
            only={['notifications', 'screen']}
            onRequest={onRequest}
            onOpenSettings={onOpenPrivacy}
            onRelaunch={onRelaunch}
          />
        </div>
      </>
    );
    footer = <>{back}{next('Continue', !micOn, micOn ? undefined : 'Allow the microphone first')}</>;
  } else if (step === 2) {
    body = (
      <>
        <h2 className="ev-onb-title">Your shortcuts</h2>
        <p className="ev-onb-lead">They work from any app, even when this panel is closed.</p>
        {/* Click a shortcut to change it; fn setup steps show under the row that uses it. */}
        <div className="ev-card">
          <ShortcutRow shortcuts={shortcuts} action="dictation" hint={talkHint(shortcuts.bindings?.dictation ?? '')} />
          <ShortcutRow shortcuts={shortcuts} action="toggle" hint="Shows this panel with everything you've captured." />
        </div>
      </>
    );
    footer = <>{back}{next()}</>;
  } else {
    body = (
      <>
        <h2 className="ev-onb-title">Try it once</h2>
        <p className="ev-onb-lead">
          Click in the box, then {usesFnKey(talk) ? <>tap <Kbd keys="fn" /></> : <>hold <Kbd keys={talk} /></>} and say something.
        </p>
        <textarea
          className="ev-onb-try"
          value={tried}
          onChange={(event) => {
            setTried(event.target.value);
            const inputType = (event.nativeEvent as InputEvent).inputType;
            if (inputType === 'insertFromPaste') setPasted(true);
            else if (!event.target.value.trim()) setPasted(false);
          }}
          placeholder="Your words land here…"
          rows={3}
          aria-label="Try dictation here"
        />
        <p className="ev-onb-note" role="status">
          {heard ? (
            <span className="ev-onb-ok"><Check size={14} strokeWidth={2.25} aria-hidden /> Pasted. You’re all set.</span>
          ) : listening ? (
            'Listening…'
          ) : pasteOn ? (
            'Nothing to send anywhere. This box is just for practice.'
          ) : (
            <>Accessibility is off, so I’ll copy instead of paste. Press <Kbd keys="⌘V" /> here.</>
          )}
        </p>
      </>
    );
    footer = (
      <>
        {back}
        <Button variant="primary" size="md" onClick={onFinish}>Start using Eavesy</Button>
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
