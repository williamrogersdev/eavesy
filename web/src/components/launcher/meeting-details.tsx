'use client';

import { CalendarDays, Users, Video } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button, Switch } from '@/components/launcher/ui';
import { setRecordChoice, type UpcomingMeeting } from '@/lib/api/calendar';
import { errMsg } from '@/lib/desktop/bridge';
import { attendeeList, choiceFor, linkHost, meetingSpan, recordHint, recordsMeeting } from './meeting-model';

/**
 * One meeting's record switch: Settings → Connections lists one per meeting,
 * and the menu bar's meeting card shows the one it names. Left as the
 * "record all" setting says, it stores nothing.
 */
export function MeetingRecordSwitch({ meeting, autoRecord, label, hint, onChanged, onError }: {
  meeting: UpcomingMeeting;
  autoRecord: boolean;
  label?: ReactNode;
  hint?: ReactNode;
  onChanged: (choice: UpcomingMeeting['recordChoice']) => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const choose = (record: boolean) => {
    const choice = choiceFor(record, autoRecord);
    setBusy(true);
    void setRecordChoice(meeting.id, choice)
      .then(() => onChanged(choice))
      .catch((e: unknown) => onError(errMsg(e, 'Couldn’t save that. Try again.')))
      .finally(() => setBusy(false));
  };
  return (
    <Switch
      checked={recordsMeeting(meeting, autoRecord)}
      onCheckedChange={choose}
      disabled={busy}
      label={label ?? meeting.title}
      hint={hint ?? recordHint(meeting, autoRecord)}
    />
  );
}

function Detail({ icon: Icon, label, children }: { icon: typeof CalendarDays; label: string; children: ReactNode }) {
  return (
    <div className="ev-meeting-detail">
      <Icon size={14} strokeWidth={1.75} aria-label={label} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** The meeting the menu bar names: when, who, where to join, and whether Eavesy records it. */
export function MeetingDetails({ meeting, autoRecord, now, onJoin, onChanged }: {
  meeting: UpcomingMeeting;
  autoRecord: boolean;
  now: number;
  onJoin: () => void;
  onChanged: (choice: UpcomingMeeting['recordChoice']) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const { names, more } = attendeeList(meeting.attendees, 5);
  const host = meeting.meetingUrl ? linkHost(meeting.meetingUrl) : null;
  return (
    <div className="ev-meeting">
      <h1 className="ev-meeting-title">{meeting.title.trim() || 'Meeting'}</h1>
      <Detail icon={CalendarDays} label="When">{meetingSpan(meeting, now)}</Detail>
      {names.length > 0 && (
        <Detail icon={Users} label="People">
          <ul className="ev-meeting-people">
            {names.map((name, index) => <li key={`${index}-${name}`}>{name}</li>)}
            {more > 0 && <li className="ev-meeting-more">and {more} more</li>}
          </ul>
        </Detail>
      )}
      {host && (
        <Detail icon={Video} label="Join link">
          <div className="ev-meeting-join">
            <span className="ev-meeting-host">{host}</span>
            <Button variant="primary" size="sm" onClick={onJoin}>Join</Button>
          </div>
        </Detail>
      )}
      <div className="ev-meeting-record">
        <MeetingRecordSwitch
          meeting={meeting}
          autoRecord={autoRecord}
          label="Record on this Mac"
          onChanged={(choice) => { setError(null); onChanged(choice); }}
          onError={setError}
        />
      </div>
      {error && <p role="alert" className="ev-set-hint">{error}</p>}
    </div>
  );
}
