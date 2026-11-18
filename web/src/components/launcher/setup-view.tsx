'use client';

import { Check } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Kbd, Mascot, type MascotState } from '@/components/launcher/ui';
import { ackDictationText, onDictationText, setDictationInPanel, type AccountInfo, type Permissions, type PrivacyPane } from '@/lib/desktop/bridge';
import { PermissionChecklist, setupPermissionsReady, usesFnKey, useOnGrant } from './permission-checklist';
import { ShortcutRow, useShortcuts } from './shortcut-row';
import type { SetupPermissionKind } from './use-setup-permissions';
import { useLiveLines } from './use-live-lines';

/**
 * Sign in first: an account is what makes Eavesy useful (sync, summaries, agents), so it is the
 * way in, not an option at the end. Then access, then an optional try. Each step has one primary
 * button, always in the same place. The order is also the analytics order (`SETUP_STEPS` in
 * desktop/src-tauri/src/commands.rs).
 */
export const STEPS = ['Sign in', 'Permissions', 'Try it'] as const;
const SIGN_IN = 0;
const PERMISSIONS = 1;
const TRY_IT = 2;

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
  const pasteOn = permissions?.accessibility === true;
  const talk = dictationHotkey;
  const shortcuts = useShortcuts(onShortcutsChanged);
  const tryBox = useRef<HTMLTextAreaElement>(null);
  const ready = setupPermissionsReady(permissions, paired);
  const hearing = useLiveLines(step === TRY_IT && listening ? liveSessionId : null, 2).map((line) => line.text).join(' ');

  // Signing in finishes in the browser: once it has, move on by itself.
  const wasPaired = useRef(paired);
  useEffect(() => {
    if (paired && !wasPaired.current && step === SIGN_IN) setStep(PERMISSIONS);
    wasPaired.current = paired;
  }, [paired, step, setStep]);

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
    : cheer || heard || (step === SIGN_IN && paired)
      ? 'happy'
      : connecting
        ? 'thinking'
        : 'idle';

  const back = step > 0 ? <Button variant="ghost" size="md" onClick={() => setStep(step - 1)}>Back</Button> : <span />;
  const next = (disabled = false, title?: string) => (
    <Button variant="primary" size="md" disabled={disabled} title={title} onClick={() => setStep(step + 1)}>Continue</Button>
  );

  let body: ReactNode;
  let footer: ReactNode;
  if (step === SIGN_IN) {
    body = paired ? (
      <>
        <h2 className="ev-onb-title">You’re signed in</h2>
        <p className="ev-onb-lead">{account?.email ?? account?.name ?? 'This Mac is connected to your account.'}</p>
      </>
    ) : connecting ? (
      <>
        <h2 className="ev-onb-title">Approve this Mac in your browser</h2>
        <p className="ev-onb-lead">Click <b>Approve this Mac</b> on the page that opened. This screen moves on by itself.</p>
      </>
    ) : (
      <>
        <h2 className="ev-onb-title">Sign in to Eavesy</h2>
        <p className="ev-onb-lead">Your recordings sync to your account, with summaries you can share or hand to an AI agent.</p>
        <p className="ev-onb-note">New to Eavesy? You can create an account on the same page.</p>
      </>
    );
    footer = paired ? (
      <><span />{next()}</>
    ) : connecting ? (
      <>
        <Button variant="ghost" size="md" onClick={onCancelConnect}>Cancel</Button>
        <Button variant="primary" size="md" loading disabled>Waiting for you in the browser…</Button>
      </>
    ) : (
      <><span /><Button variant="primary" size="md" onClick={onConnect}>Sign in at eavesy.com</Button></>
    );
  } else if (step === PERMISSIONS) {
    const kinds: SetupPermissionKind[] = ['mic', 'accessibility'];
    if (fnInUse) kinds.push('inputMonitoring');
    if (!paired) kinds.splice(1, 0, 'speech');
    body = (
      <>
        <h2 className="ev-onb-title">Let Eavesy hear you</h2>
        <p className="ev-onb-lead">macOS asks once for each. Only the microphone is required.</p>
        <div className="ev-card">
          <PermissionChecklist
            permissions={permissions}
            checking={checking}
            fnInUse={fnInUse}
            speechRequired={!paired}
            only={kinds}
            onRequest={onRequest}
            onOpenSettings={onOpenPrivacy}
            onRelaunch={onRelaunch}
          />
        </div>
      </>
    );
    const why = ready ? undefined : permissions?.mic === true ? 'Allow Speech Recognition first' : 'Allow the microphone first';
    footer = <>{back}{next(!ready, why)}</>;
  } else {
    body = (
      <>
        <h2 className="ev-onb-title">You’re ready</h2>
        <p className="ev-onb-lead">
          {!talk
            ? 'Give Talk a shortcut below to dictate into any app.'
            : usesFnKey(talk)
              ? <>Tap <Kbd keys="fn" />, talk, then tap <Kbd keys="fn" /> again. Your words appear where your cursor is.</>
              : <>Hold <Kbd keys={talk} /> and talk, then let go. Your words appear where your cursor is.</>}
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
          placeholder={listening ? 'Listening…' : 'Optional: try it here'}
          rows={3}
          aria-label="Try dictation here"
        />
        <p className="ev-onb-note" role="status">
          {heard ? (
            <span className="ev-onb-ok"><Check size={14} strokeWidth={2.25} aria-hidden /> It works.</span>
          ) : listening ? (
            <span className="ev-onb-hearing"><span className="ev-onb-rec" aria-hidden />{hearing ? <bdi>{hearing}</bdi> : 'Listening…'}</span>
          ) : pasteOn ? null : (
            <>Accessibility is off, so press <Kbd keys="⌘V" /> to paste.</>
          )}
        </p>
        <div className="ev-card">
          <ShortcutRow shortcuts={shortcuts} action="dictation" hint="Change it if it clashes with another app." />
        </div>
      </>
    );
    footer = <>{back}<Button variant="primary" size="md" onClick={onFinish}>Start using Eavesy</Button></>;
  }

  return (
    <div className="ev-onb">
      <div className="ev-onb-scroll">
        <div className="ev-onb-head">
          <Mascot state={mascot} size={44} recording={listening} />
          <div className="ev-steps" role="img" aria-label={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}>
            {STEPS.map((name, i) => (
              <i key={name} data-state={i < step ? 'done' : i === step ? 'on' : undefined} />
            ))}
            <span>{STEPS[step]}</span>
          </div>
        </div>
        {body}
      </div>
      <div className="ev-onb-foot">{footer}</div>
    </div>
  );
}
