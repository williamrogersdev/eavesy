import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MeetingDetails } from '@/components/launcher/meeting-details';
import { parseUpcomingMeeting, type UpcomingMeeting } from '@/lib/api/calendar';
import { getSettings, openSettingsWindow } from '@/lib/desktop/bridge';
import { invoke, useEvent } from './marking';
import './styles.css';

document.documentElement.style.background = 'transparent';
document.body.style.background = 'transparent';

const preview = !(window as unknown as { __TAURI__?: unknown }).__TAURI__;
const PREVIEW: UpcomingMeeting | null = preview ? {
  id: 'preview', title: 'William & Ben | Numeral Intro', startsAt: Date.now() + 11 * 60_000, endsAt: Date.now() + 41 * 60_000,
  meetingUrl: 'https://meet.google.com/abc-defg-hij', recordChoice: null,
  attendees: [{ email: 'ben@numeral.com', name: 'Ben Carter' }, { email: 'william@eavesy.com', name: null }],
} : null;

/** The card under the menu bar's meeting item (meeting_bar.rs). */
function MeetingCard() {
  const [meeting, setMeeting] = useState<UpcomingMeeting | null>(PREVIEW);
  const [autoRecord, setAutoRecord] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const card = useRef<HTMLDivElement>(null);

  const load = () => {
    void invoke('menu_bar_meeting').then((value) => setMeeting(parseUpcomingMeeting(value))).catch(() => {});
    void getSettings().then((settings) => setAutoRecord(settings?.auto_record_meetings ?? true));
    setNow(Date.now());
  };
  useEffect(() => {
    if (preview) return;
    load();
    window.addEventListener('focus', load);
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') void invoke('close_meeting_card'); };
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('focus', load); window.removeEventListener('keydown', escape); clearInterval(timer); };
  }, []);
  useEvent('meeting:updated', (payload) => { setMeeting(parseUpcomingMeeting(payload)); setNow(Date.now()); });

  // The window fits the card as it grows or shrinks.
  useEffect(() => {
    const node = card.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const report = () => void invoke('fit_meeting_card', { height: Math.ceil(node.getBoundingClientRect().height) + 12 });
    const observer = new ResizeObserver(report);
    observer.observe(node);
    report();
    return () => observer.disconnect();
  }, [meeting === null]);

  return (
    <div ref={card} className="launcher-scope ev ev-meeting-card" role="dialog" aria-label="Next meeting">
      {meeting ? (
        <MeetingDetails
          meeting={meeting}
          autoRecord={autoRecord}
          now={now}
          onJoin={() => void invoke('open_meeting_link')}
          onChanged={(choice) => setMeeting((current) => current && current.id === meeting.id ? { ...current, recordChoice: choice } : current)}
        />
      ) : (
        <p className="ev-set-hint">No meeting coming up.</p>
      )}
      <button
        type="button"
        className="ev-meeting-all"
        onClick={() => { void openSettingsWindow('connections'); void invoke('close_meeting_card'); }}
      >
        All upcoming meetings
      </button>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><MeetingCard /></StrictMode>);
