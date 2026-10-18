'use client';

import { RotateCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, StatusDisc, type DiscStatus } from '@/components/launcher/ui';
import type { PermissionStatus, Permissions, PrivacyPane } from '@/lib/desktop/bridge';
import type { SetupPermissionKind } from './use-setup-permissions';

/** How much Eavesy needs a permission. Shown as a quiet tag after the name. */
type Need = 'required' | 'recommended' | 'optional' | 'not-needed';

interface PermissionSpec {
  kind: SetupPermissionKind;
  label: string;
  hint: string;
  /** Shown once macOS won't ask again, so only System Settings helps. */
  settingsHint: string;
  pane: PrivacyPane;
  need: Need;
  /** macOS applies a new grant only after Eavesy reopens. */
  relaunch?: boolean;
}

const TAG: Record<Need, string | null> = {
  required: 'required',
  recommended: null,
  optional: 'optional',
  'not-needed': 'not needed',
};

/** Whether the Talk or Open Eavesy shortcut is the fn key, which needs Input Monitoring. */
export function usesFnKey(...accelerators: string[]): boolean {
  return accelerators.some((accel) => accel.trim().toLowerCase() === 'fn');
}

export function permissionSpecs(fnInUse: boolean): PermissionSpec[] {
  return [
    {
      kind: 'mic',
      label: 'Microphone',
      hint: 'Lets Eavesy hear you while you talk. It only listens while its ears are up.',
      settingsHint: 'Turn on Eavesy under Microphone in System Settings. This list updates on its own.',
      pane: 'microphone',
      need: 'required',
    },
    {
      kind: 'speech',
      label: 'Speech Recognition',
      hint: 'Shows live captions and pastes the moment you stop talking.',
      settingsHint: 'Turn on Eavesy under Speech Recognition in System Settings.',
      pane: 'speech',
      need: 'recommended',
    },
    {
      kind: 'accessibility',
      label: 'Accessibility',
      hint: 'Lets Eavesy type the transcript where your cursor is.',
      settingsHint: 'Turn on Eavesy under Accessibility in System Settings. This list updates on its own.',
      pane: 'accessibility',
      need: 'recommended',
    },
    {
      kind: 'inputMonitoring',
      label: 'Input Monitoring',
      hint: fnInUse ? 'Lets the fn key start dictation.' : 'Only needed if you use fn as a shortcut.',
      settingsHint: 'Turn on Eavesy under Input Monitoring in System Settings, then reopen Eavesy.',
      pane: 'input_monitoring',
      need: fnInUse ? 'recommended' : 'not-needed',
      relaunch: true,
    },
    {
      kind: 'notifications',
      label: 'Notifications',
      hint: 'Tells you when sign-in finishes or an update is ready.',
      settingsHint: 'Turn on notifications for Eavesy in System Settings → Notifications.',
      pane: 'notifications',
      need: 'optional',
    },
    {
      kind: 'screen',
      label: 'Screen Recording',
      hint: 'For screenshots, screen videos and meeting audio. You can turn it on later.',
      settingsHint: 'Turn on Eavesy under Screen & System Audio Recording, then reopen Eavesy.',
      pane: 'screen',
      need: 'optional',
      relaunch: true,
    },
  ];
}

export function isGranted(permissions: Permissions | null, kind: SetupPermissionKind): boolean | undefined {
  if (!permissions) return undefined;
  return permissions[kind] ?? false;
}

/**
 * Whether macOS has already answered, so Allow would do nothing and only System Settings helps.
 * Screen Recording and Accessibility can't tell "never asked" from "said no" (`notGranted`), so
 * those count as unanswered until Eavesy has asked once.
 */
function answered(permissions: Permissions | null, kind: SetupPermissionKind): boolean {
  const status: PermissionStatus | undefined = permissions?.status?.[kind];
  if (kind === 'mic' && status === undefined) return !!permissions?.micAsked;
  return status === 'denied' || status === 'restricted';
}

export function PermissionChecklistRow({
  spec,
  permissions,
  checking,
  onRequest,
  onOpenSettings,
  onRelaunch,
}: {
  spec: PermissionSpec;
  permissions: Permissions | null;
  checking: boolean;
  onRequest: (kind: SetupPermissionKind) => void;
  onOpenSettings: (pane: PrivacyPane) => void;
  onRelaunch: () => void;
}) {
  const granted = isGranted(permissions, spec.kind);
  // Asked in this panel: a second Allow would show nothing, so it opens System Settings instead.
  const [asked, setAsked] = useState(false);
  // Granted while this list was open: some permissions need Eavesy to reopen before they work.
  const [grantedAtStart, setGrantedAtStart] = useState(granted);
  if (grantedAtStart === undefined && granted !== undefined) setGrantedAtStart(granted);
  const newlyGranted = granted === true && grantedAtStart === false;

  const inSettings = answered(permissions, spec.kind) || asked;
  const status: DiscStatus = checking
    ? 'checking'
    : granted
      ? 'granted'
      : answered(permissions, spec.kind)
        ? 'denied'
        : 'pending';
  const showRelaunch = !!spec.relaunch && (newlyGranted || (asked && !granted));
  const tag = TAG[spec.need];

  const act = () => {
    if (inSettings) onOpenSettings(spec.pane);
    else onRequest(spec.kind);
    setAsked(true);
  };

  return (
    <div className="ev-perm" data-need={spec.need}>
      <StatusDisc status={status} />
      <div className="min-w-0">
        <div className="ev-perm-title">
          {spec.label}
          {tag && <span className="ev-perm-tag">{tag}</span>}
        </div>
        <p className="ev-perm-hint">
          {showRelaunch && granted
            ? 'On. macOS applies this after Eavesy reopens.'
            : inSettings && !granted
              ? spec.settingsHint
              : spec.hint}
        </p>
      </div>
      <div className="ev-perm-action">
        {showRelaunch && (
          <Button variant={granted ? 'primary' : 'ghost'} size="sm" icon={RotateCw} onClick={onRelaunch} title="Quit and reopen Eavesy">
            Reopen
          </Button>
        )}
        {granted ? (
          !showRelaunch && <span className="ev-perm-on">On</span>
        ) : (
          <Button
            variant={spec.need === 'required' ? 'primary' : 'outline'}
            size="sm"
            disabled={checking || granted === undefined}
            onClick={act}
          >
            {inSettings ? 'Open Settings' : 'Allow'}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Every permission Eavesy uses, with live status. The same rows in onboarding and in
 * Settings ▸ Permissions. Each Allow asks macOS for one permission; the panel steps aside
 * (Rust lowers it) so the system alert can be clicked.
 */
export function PermissionChecklist({
  permissions,
  checking,
  fnInUse,
  only,
  onRequest,
  onOpenSettings,
  onRelaunch,
}: {
  permissions: Permissions | null;
  checking: SetupPermissionKind | null;
  fnInUse: boolean;
  /** Limit to these kinds, in this order. */
  only?: SetupPermissionKind[];
  onRequest: (kind: SetupPermissionKind) => void;
  onOpenSettings: (pane: PrivacyPane) => void;
  onRelaunch: () => void;
}) {
  const specs = permissionSpecs(fnInUse);
  const rows = only ? only.map((kind) => specs.find((spec) => spec.kind === kind)!).filter(Boolean) : specs;
  return (
    <>
      {rows.map((spec) => (
        <PermissionChecklistRow
          key={spec.kind}
          spec={spec}
          permissions={permissions}
          checking={checking === spec.kind}
          onRequest={onRequest}
          onOpenSettings={onOpenSettings}
          onRelaunch={onRelaunch}
        />
      ))}
    </>
  );
}

/** Plays a one-shot callback each time another permission turns on. */
export function useOnGrant(permissions: Permissions | null, onGrant: () => void) {
  const count = permissions
    ? (['mic', 'speech', 'accessibility', 'inputMonitoring', 'notifications', 'screen'] as const)
      .filter((kind) => permissions[kind]).length
    : null;
  const previous = useRef<number | null>(null);
  const callback = useRef(onGrant);
  useEffect(() => { callback.current = onGrant; });
  useEffect(() => {
    if (count === null) return;
    if (previous.current !== null && count > previous.current) callback.current();
    previous.current = count;
  }, [count]);
}
