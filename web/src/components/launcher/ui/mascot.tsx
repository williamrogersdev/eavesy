import { useId, type CSSProperties } from 'react';

/**
 * Eavesy: the Little Snoop, a charcoal bean in a fedora. The hat lifts off
 * its brow only while the mic is live, and the coral lens appears only while
 * recording. That makes the character the privacy indicator, so never fake
 * `listening` or `recording`.
 *
 * Calm by default: it holds a pose and blinks now and then. It never animates
 * to ask for attention. Under reduced motion it holds the pose only (the hat
 * still lifts while listening, at a fixed height).
 */

export type MascotState = 'idle' | 'listening' | 'thinking' | 'happy' | 'confused' | 'sleeping';

export type MascotProps = {
  state?: MascotState;
  /** Mic level 0–1. Only read in `listening`. */
  level?: number;
  /** Rendered size in px (square). */
  size?: number;
  /** Coral lens: shown only while a capture is recording. */
  recording?: boolean;
  /** 'auto' picks by size: ≤19 mini, 20–39 medium, ≥40 full. */
  detail?: 'auto' | 'full' | 'medium' | 'mini';
  /** Single-colour glyph in currentColor (tray / template contexts). */
  mono?: boolean;
  /** Accessible name. Omit for decorative use (aria-hidden). */
  title?: string;
  className?: string;
  style?: CSSProperties;
};

const CROWN = 'M13.5 27C13.8 16.5 19.5 8.5 26.5 8.5Q32 11.5 37.5 8.5C44.5 8.5 50.2 16.5 50.5 27Z';

const CSS = `
.evm{--evm-body:var(--ev-mascot-body,#2B2523);--evm-band:var(--ev-mascot-band,#4A403C);--evm-eye:var(--ev-mascot-eye,#FBF7F0);--evm-rec:var(--ev-rec,#FF5A3C);--evm-smoke:var(--ev-ink-3,#968D85);overflow:visible;display:inline-block;vertical-align:middle;flex:none}
.evm *{transform-box:fill-box}
.evm-body{fill:var(--evm-body)}
.evm-band{fill:var(--evm-band)}
.evm-ground{fill:var(--evm-body);opacity:.12}
.evm-eye{fill:var(--evm-eye)}
.evm-stroke{stroke:var(--evm-eye);fill:none;stroke-linecap:round;stroke-linejoin:round}
.evm-handle{stroke:var(--evm-band);stroke-linecap:round}
.evm-glass{fill:var(--evm-rec)}
.evm-glint{fill:#FFFFFF;opacity:.7}
.evm-rec{fill:var(--evm-rec);stroke:var(--ev-paper,#FBF7F0);stroke-width:1.6}
.evm-mono .evm-body,.evm-mono .evm-eye{fill:currentColor}
.evm-mono .evm-stroke{stroke:currentColor}

.evm-figure{transform-origin:50% 100%;transition:transform 260ms cubic-bezier(.2,.8,.2,1)}
.evm-hat{transform-origin:50% 100%;transition:transform 260ms cubic-bezier(.2,.8,.2,1)}
.evm-listening .evm-hat,.evm-listening .evm-bob{transition:transform 80ms linear}
.evm-eyes{transform-origin:50% 50%}
.evm-pupils{transition:transform 400ms cubic-bezier(.2,.8,.2,1)}

.evm-idle .evm-eyes,.evm-listening .evm-eyes{animation:evm-blink 8.3s infinite}
.evm-full.evm-idle .evm-pupils{animation:evm-glance 13.1s ease-in-out infinite}
.evm-full.evm-idle .evm-breathe{animation:evm-breathe 4.1s ease-in-out infinite}
.evm-thinking .evm-pupils{animation:evm-ponder 3s ease-in-out infinite alternate}
.evm-happy .evm-breathe{animation:evm-lift 360ms cubic-bezier(.34,1.56,.64,1) 1 both}
.evm-confused .evm-figure{transform:rotate(-6deg)}
.evm-sleeping .evm-breathe{animation:evm-sleep 5s ease-in-out infinite}
.evm-z{opacity:0;fill:var(--evm-smoke);font:700 9px ui-rounded,"SF Pro Rounded","Nunito",system-ui,sans-serif;animation:evm-z 3s ease-out infinite}
.evm-z:nth-of-type(2){animation-delay:1.5s;font-size:7px}
.evm-q{fill:var(--evm-smoke);font:800 13px ui-rounded,"SF Pro Rounded","Nunito",system-ui,sans-serif}

@keyframes evm-blink{0%,57%,60%,95%,100%{transform:scaleY(1)}58.5%,96.5%{transform:scaleY(.1)}}
@keyframes evm-glance{0%,40%,100%{transform:translate(0,0)}46%,62%{transform:translate(1.3px,-.3px)}68%,74%{transform:translate(-1px,0)}}
@keyframes evm-breathe{0%,100%{transform:translateY(0)}50%{transform:translateY(-.6px)}}
@keyframes evm-ponder{0%{transform:translate(-1.4px,-.8px)}100%{transform:translate(1.4px,-.8px)}}
@keyframes evm-lift{0%{transform:translateY(0)}45%{transform:translateY(-1.5px)}100%{transform:translateY(0)}}
@keyframes evm-sleep{0%,100%{transform:scale(1,1)}50%{transform:scale(1.012,.985)}}
@keyframes evm-z{0%{opacity:0;transform:translate(0,0)}30%{opacity:.8}100%{opacity:0;transform:translate(5px,-9px)}}

@media (prefers-reduced-motion:reduce){
  .evm *{animation:none!important;transition:none!important}
  .evm-z{opacity:0}
  .evm-bob{transform:none!important}
  .evm-listening .evm-hat{transform:translateY(-3px)!important}
}
`;

function clamp01(n: number) {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

export function Mascot({
  state = 'idle',
  level = 0,
  size = 64,
  recording = false,
  detail = 'auto',
  mono = false,
  title,
  className,
  style,
}: MascotProps) {
  const clipId = `evm-clip-${useId().replace(/:/g, '')}`;
  const tier = detail === 'auto' ? (size <= 19 ? 'mini' : size < 40 ? 'medium' : 'full') : detail;
  const full = tier === 'full';
  const mini = tier === 'mini' || mono;
  const lvl = state === 'listening' ? clamp01(level) : 0;

  // The hat: tipped up off the brow while listening, pulled down asleep.
  const lift = state === 'listening' ? 2 + lvl * 4 : state === 'sleeping' ? -3 : 0;
  const tilt = state === 'confused' ? 6 : state === 'listening' ? -3 : 0;
  const bob = -lvl * 2.5;

  return (
    <>
      {/* Hoisted and deduped by React 19: one copy in <head> however many mascots render. */}
      <style href="ev-mascot" precedence="default">{CSS}</style>
      <svg
        viewBox="-4 -8 72 72"
        width={size}
        height={size}
        role={title ? 'img' : undefined}
        aria-hidden={title ? undefined : true}
        aria-label={title}
        className={['evm', `evm-${state}`, `evm-${tier}`, mono ? 'evm-mono' : '', className ?? ''].join(' ')}
        style={style}
        data-state={state}
      >
        {full && !mono && <ellipse className="evm-ground" cx="32" cy="61" rx="17" ry="2.2" />}

        <g className="evm-figure">
          <g className="evm-bob" style={{ transform: `translateY(${bob}px)` }}>
            <g className="evm-breathe">
              {!mono && <ellipse className="evm-body" cx="32" cy="41" rx="21" ry="17" />}
              <g className="evm-eyes">{renderEyes(state, mini)}</g>
            </g>

            <g className="evm-hat" style={{ transform: `translateY(${-lift}px) rotate(${tilt}deg)` }}>
              <ellipse className="evm-body" cx="32" cy="27" rx="30" ry={mini ? 5.6 : 5} />
              <path className="evm-body" d={CROWN} />
              {!mini && (
                <>
                  <clipPath id={clipId}><path d={CROWN} /></clipPath>
                  <rect className="evm-band" clipPath={`url(#${clipId})`} x="10" y="20" width="44" height="4.6" />
                </>
              )}
            </g>

            {recording && !mini && (
              <g>
                <line className="evm-handle" x1="53" y1="56" x2="59" y2="63" strokeWidth="3.4" />
                <circle className="evm-body" cx="49.5" cy="51.5" r="7.6" />
                <circle className="evm-glass" cx="49.5" cy="51.5" r="5" />
                <circle className="evm-glint" cx="47.8" cy="49.8" r="1.3" />
              </g>
            )}
            {recording && mini && <circle className="evm-rec" cx="51" cy="52" r="7" />}
          </g>
        </g>

        {full && state === 'sleeping' && (
          <g>
            <text className="evm-z" x="55" y="12">z</text>
            <text className="evm-z" x="60" y="6">z</text>
          </g>
        )}
        {full && state === 'confused' && <text className="evm-q" x="57" y="40">?</text>}
      </svg>
    </>
  );
}

function renderEyes(state: MascotState, mini: boolean) {
  switch (state) {
    case 'happy':
      return (
        <>
          <path className="evm-stroke" d="M21.6 43.4Q25 39 28.4 43.4" strokeWidth={mini ? 3.6 : 2.6} />
          <path className="evm-stroke" d="M35.6 43.4Q39 39 42.4 43.4" strokeWidth={mini ? 3.6 : 2.6} />
        </>
      );
    case 'sleeping':
      return (
        <>
          <path className="evm-stroke" d="M21.6 42Q25 45 28.4 42" strokeWidth={mini ? 4.4 : 2.4} />
          <path className="evm-stroke" d="M35.6 42Q39 45 42.4 42" strokeWidth={mini ? 4.4 : 2.4} />
        </>
      );
    default: {
      const ry = state === 'listening' ? 6.2 : 5.4;
      const m = mini ? 1.25 : 1;
      const confused = state === 'confused';
      return (
        <g className="evm-pupils">
          <ellipse className="evm-eye" cx="25" cy="42" rx={(confused ? 3.2 : 3.8) * m} ry={(confused ? 4.4 : ry) * m} />
          <ellipse className="evm-eye" cx="39" cy="42" rx={(confused ? 4.3 : 3.8) * m} ry={(confused ? 6 : ry) * m} />
        </g>
      );
    }
  }
}

export default Mascot;
