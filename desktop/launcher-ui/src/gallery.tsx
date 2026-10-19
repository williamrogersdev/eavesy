// Dev-only gallery of the launcher primitives (vite dev → /gallery.html).
// Not part of the production build inputs. See desktop/DESIGN.md §8.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AudioLines, Camera, Clapperboard, FolderOpen, Globe, LogOut, Settings, Users, Copy, MoreHorizontal } from 'lucide-react';
import {
  Bubble,
  Button,
  Card,
  Chip,
  Composer,
  IconButton,
  Kbd,
  Mascot,
  Menu,
  Segmented,
  StatusDisc,
  Switch,
  ToolbarSegment,
  ToolbarShelf,
  type MascotState,
} from '@/components/launcher/ui';
import './styles.css';

const STATES: MascotState[] = ['idle', 'listening', 'thinking', 'happy', 'confused', 'sleeping'];

function Gallery() {
  const [chip, setChip] = useState('All');
  const [on, setOn] = useState(true);
  const [pos, setPos] = useState<'top' | 'bottom'>('top');
  const [level, setLevel] = useState(0.4);
  const [live, setLive] = useState(false);
  const [drag, setDrag] = useState(false);
  return (
    <div className="ev" style={{ background: 'var(--ev-paper)', color: 'var(--ev-ink)', minHeight: '100vh', padding: 24, fontFamily: 'var(--ev-font-text)' }}>
      <div style={{ display: 'grid', gap: 22, maxWidth: 440 }}>
        <section style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          {STATES.map((s) => (
            <figure key={s} style={{ margin: 0, textAlign: 'center', font: 'var(--ev-t-small)', color: 'var(--ev-ink-3)' }}>
              <Mascot state={s} size={56} level={level} recording={s === 'listening'} />
              <figcaption>{s}</figcaption>
            </figure>
          ))}
          <Mascot size={22} />
          <Mascot size={18} />
          <Mascot size={16} state="listening" recording level={level} />
          <input aria-label="Mic level" type="range" min={0} max={1} step={0.01} value={level} onChange={(e) => setLevel(+e.target.value)} />
        </section>
        <ToolbarShelf>
          <ToolbarSegment icon={AudioLines} label="Talk" kbd="fn" hint="Tap fn and talk. Tap it again to paste where your cursor is." dimmed={live} />
          <ToolbarSegment icon={Users} label="Meeting" hint="Records both sides of a call" active={live} elapsed="12:40" onClick={() => setLive(!live)} />
          <ToolbarSegment icon={Camera} label="Screenshot" dimmed={live} />
          <ToolbarSegment icon={Clapperboard} label="Video" dimmed={live} />
        </ToolbarShelf>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {['All', 'Voice', 'Meetings', 'Screens', 'Notes'].map((c) => (
            <Chip key={c} selected={chip === c} count={4} onClick={() => setChip(c)}>{c}</Chip>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button variant="primary">Sign in at eavesy.com</Button>
          <Button>Stay local for now</Button>
          <Button variant="quiet" size="sm">Save</Button>
          <Button variant="outline" size="sm" icon={FolderOpen}>Change</Button>
          <Button variant="danger-rec" size="sm">Stop</Button>
          <Button variant="primary" loading>Waiting</Button>
          <IconButton label="Copy" icon={Copy} />
          <IconButton label="More" icon={MoreHorizontal} size={24} />
          <Kbd keys="⌘⇧Space" size="md" />
          <Menu
            trigger={<button type="button" className="ev-acct" aria-label="Account">W</button>}
            header={<><div className="ev-menu-header-title">Will Rogers</div><div className="ev-menu-header-sub">will@example.com</div></>}
            items={[
              { label: 'Open eavesy.com', icon: Globe, onSelect: () => {} },
              { label: 'Open ~/Eavesy folder', icon: FolderOpen, onSelect: () => {} },
              { label: 'Settings', icon: Settings, kbd: '⌘,', onSelect: () => {} },
              'separator',
              { label: 'Sign out', icon: LogOut, tone: 'warn', onSelect: () => {} },
            ]}
          />
        </div>
        <Card title="Capture">
          <div style={{ padding: '10px 12px' }}>
            <Switch checked={on} onCheckedChange={setOn} label="Live captions" hint="Show words in the HUD as you talk." />
          </div>
          <div style={{ padding: '10px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ font: 'var(--ev-t-ui)' }}>HUD position</span>
            <Segmented label="HUD position" value={pos} onChange={setPos} options={[{ value: 'top', label: 'Top' }, { value: 'bottom', label: 'Bottom' }]} />
          </div>
          <div style={{ padding: '10px 12px', display: 'flex', gap: 8, alignItems: 'center' }}>
            <StatusDisc status="granted" /><StatusDisc status="pending" /><StatusDisc status="denied" /><StatusDisc status="checking" />
          </div>
        </Card>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <Mascot size={72} />
          <Bubble tail="left">It&apos;s quiet up here. Tap <Kbd keys="fn" /> and talk, or drop something in below.</Bubble>
        </div>
        <label style={{ font: 'var(--ev-t-small)' }}><input type="checkbox" checked={drag} onChange={(e) => setDrag(e.target.checked)} /> drag active</label>
        <div style={{ position: 'relative', height: 160, borderRadius: 16, background: 'var(--ev-paper)', boxShadow: 'var(--ev-e-3)', overflow: 'hidden' }}>
          <Composer dragActive={drag} onSaveNote={(t) => console.log('note', t)} onFiles={(f) => console.log('files', f)} />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Gallery /></StrictMode>);
