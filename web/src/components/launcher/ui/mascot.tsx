import { useId, type CSSProperties } from 'react';

/**
 * Eavesy: a honey pebble wearing its own slate roof. The roof's overhangs
 * (the eaves) are its ears, and they only lift while the mic is live. That
 * makes the character the privacy indicator, so never fake `listening`.
 *
 * Calm by default: it holds a pose and blinks now and then. It never animates
 * to ask for attention. Under reduced motion it holds the pose only (eaves
 * still perk while listening, at a fixed angle).
 */

export type MascotState = 'idle' | 'listening' | 'thinking' | 'happy' | 'confused' | 'sleeping';

export type MascotProps = {
  state?: MascotState;
  /** Mic level 0–1. Only read in `listening`. */
  level?: number;
  /** Rendered size in px (square). */
  size?: number;
  /** Red record light on the roof peak. */
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

const BODY = 'M32 15C46.5 15 54 27 54 40C54 51.5 45 58.5 32 58.5C19 58.5 10 51.5 10 40C10 27 17.5 15 32 15Z';

const CSS = `
.evm{--evm-honey:var(--ev-mascot-body,#F6B93B);--evm-shade:var(--ev-mascot-shade,#E39E1E);--evm-roof:var(--ev-mascot-roof,#4B3A78);--evm-eye:#2A2233;--evm-cheek:var(--ev-cheek,#F59BA0);--evm-rec:var(--ev-rec,#FF3B30);--evm-smoke:var(--ev-ink-3,#978C9C);overflow:visible;display:inline-block;vertical-align:middle;flex:none}
.evm *{transform-box:fill-box}
.evm-body{fill:var(--evm-honey)}
.evm-shadeband{stroke:var(--evm-shade);opacity:.45}
.evm-ground{fill:var(--evm-eye);opacity:.10}
.evm-roofline{stroke:var(--evm-roof)}
.evm-chimney{fill:var(--evm-roof)}
.evm-ink{fill:var(--evm-eye)}
.evm-stroke{stroke:var(--evm-eye);fill:none;stroke-linecap:round;stroke-linejoin:round}
.evm-hl{fill:#FFF8EE}
.evm-cheek{fill:var(--evm-cheek);opacity:.7}
.evm-rec{fill:var(--evm-rec);stroke:#FFF8EE;stroke-width:1.4}
.evm-mono .evm-roofline{stroke:currentColor}
.evm-mono .evm-ink{fill:currentColor}
.evm-mono .evm-stroke{stroke:currentColor}

.evm-roof-l{transform-origin:100% 0}
.evm-roof-r{transform-origin:0 0}
.evm-figure{transform-origin:50% 100%;transition:transform 260ms cubic-bezier(.2,.8,.2,1)}
.evm-roof-l,.evm-roof-r{transition:transform 260ms cubic-bezier(.2,.8,.2,1)}
.evm-listening .evm-roof-l,.evm-listening .evm-roof-r,.evm-listening .evm-bob{transition:transform 80ms linear}
.evm-eyes{transform-origin:50% 50%}
.evm-pupils{transition:transform 400ms cubic-bezier(.2,.8,.2,1)}

.evm-idle .evm-eyes,.evm-listening .evm-eyes{animation:evm-blink 8.3s infinite}
.evm-full.evm-idle .evm-pupils{animation:evm-glance 13.1s ease-in-out infinite}
.evm-full.evm-idle .evm-breathe{animation:evm-breathe 4.1s ease-in-out infinite}
.evm-thinking .evm-pupils{animation:evm-ponder 3s ease-in-out infinite alternate}
.evm-happy .evm-breathe{animation:evm-lift 360ms cubic-bezier(.34,1.56,.64,1) 1 both}
.evm-confused .evm-figure{transform:rotate(-6deg)}
.evm-sleeping .evm-breathe{animation:evm-sleep 5s ease-in-out infinite}
.evm-puff{opacity:0;transform-origin:50% 50%;animation:evm-puff 2.4s ease-out infinite}
.evm-puff:nth-child(2){animation-delay:.8s}
.evm-puff:nth-child(3){animation-delay:1.6s}
.evm-z{opacity:0;fill:var(--evm-smoke);font:700 9px ui-rounded,"SF Pro Rounded","Nunito",system-ui,sans-serif;animation:evm-z 3s ease-out infinite}
.evm-z:nth-of-type(2){animation-delay:1.5s;font-size:7px}
.evm-q{fill:var(--evm-roof);font:800 13px ui-rounded,"SF Pro Rounded","Nunito",system-ui,sans-serif}

@keyframes evm-blink{0%,57%,60%,95%,100%{transform:scaleY(1)}58.5%,96.5%{transform:scaleY(.1)}}
@keyframes evm-glance{0%,40%,100%{transform:translate(0,0)}46%,62%{transform:translate(1.3px,-.3px)}68%,74%{transform:translate(-1px,0)}}
@keyframes evm-breathe{0%,100%{transform:translateY(0)}50%{transform:translateY(-.6px)}}
@keyframes evm-ponder{0%{transform:translate(-1.4px,-1.6px)}100%{transform:translate(1.4px,-1.6px)}}
@keyframes evm-lift{0%{transform:translateY(0)}45%{transform:translateY(-1.5px)}100%{transform:translateY(0)}}
@keyframes evm-sleep{0%,100%{transform:scale(1,1)}50%{transform:scale(1.012,.985)}}
@keyframes evm-puff{0%{opacity:0;transform:translate(0,0) scale(.5)}25%{opacity:.45}100%{opacity:0;transform:translate(2px,-11px) scale(1.4)}}
@keyframes evm-z{0%{opacity:0;transform:translate(0,0)}30%{opacity:.8}100%{opacity:0;transform:translate(5px,-9px)}}

@media (prefers-reduced-motion:reduce){
  .evm *{animation:none!important;transition:none!important}
  .evm-puff,.evm-z{opacity:0}
  .evm-bob{transform:none!important}
  .evm-listening .evm-roof-l{transform:rotate(10deg)!important}
  .evm-listening .evm-roof-r{transform:rotate(-10deg)!important}
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

  // Eaves: the ears. Up only while listening, droop asleep.
  const perk = state === 'listening' ? 6 + lvl * 14 : state === 'sleeping' ? -5 : state === 'confused' ? 3 : 0;
  const bob = -lvl * 2.5;

  const eyes = renderEyes(state, mini);
  const mouth = mini ? null : renderMouth(state);

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
        {full && !mono && <ellipse className="evm-ground" cx="32" cy="61" rx="15" ry="2.2" />}

        <g className="evm-figure">
          <g className="evm-bob" style={{ transform: `translateY(${bob}px)` }}>
            <g className="evm-breathe">
              {!mono && (
                <>
                  <path className="evm-body" d={BODY} />
                  {!mini && (
                    <>
                      <clipPath id={clipId}><path d={BODY} /></clipPath>
                      {/* The eave's shadow on its forehead. */}
                      <polyline
                        className="evm-shadeband"
                        clipPath={`url(#${clipId})`}
                        points="8,33.5 32,13.5 56,33.5"
                        fill="none"
                        strokeWidth="5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </>
                  )}
                  {!mini && (
                    <>
                      <ellipse className="evm-cheek" cx="17.6" cy="44.6" rx="3.6" ry="2.2" />
                      <ellipse className="evm-cheek" cx="46.4" cy="44.6" rx="3.6" ry="2.2" />
                    </>
                  )}
                </>
              )}
              <g className="evm-eyes">{eyes}</g>
              {mouth}
            </g>

            {/* Roof: two halves hinged at the peak so each eave can perk. */}
            <g className="evm-roof-l" style={{ transform: `rotate(${perk}deg)` }}>
              <line className="evm-roofline" x1="32" y1="9" x2="5" y2="31" strokeWidth={mini ? 9 : 8} strokeLinecap="round" />
            </g>
            <g className="evm-roof-r" style={{ transform: `rotate(${-perk}deg)` }}>
              {!mini && <rect className="evm-chimney" x="43" y="9.5" width="5.2" height="10" rx="1.4" />}
              <line className="evm-roofline" x1="32" y1="9" x2="59" y2="31" strokeWidth={mini ? 9 : 8} strokeLinecap="round" />
              {state === 'thinking' && tier !== 'mini' && !mono && (
                <g>
                  <circle className="evm-puff" cx="45.6" cy="5" r="2" fill="var(--evm-smoke)" />
                  <circle className="evm-puff" cx="45.6" cy="5" r="2" fill="var(--evm-smoke)" />
                  <circle className="evm-puff" cx="45.6" cy="5" r="2" fill="var(--evm-smoke)" />
                </g>
              )}
            </g>

            {recording && <circle className="evm-rec" cx="32" cy="9" r={mini ? 6.5 : 3.6} />}
          </g>
        </g>

        {full && state === 'sleeping' && (
          <g>
            <text className="evm-z" x="53" y="16">z</text>
            <text className="evm-z" x="58" y="10">z</text>
          </g>
        )}
        {full && state === 'confused' && <text className="evm-q" x="56" y="22">?</text>}
      </svg>
    </>
  );
}

function renderEyes(state: MascotState, mini: boolean) {
  const hl = !mini;
  switch (state) {
    case 'happy':
      return (
        <>
          <path className="evm-stroke" d="M20.8 38.6Q24 34.4 27.2 38.6" strokeWidth={mini ? 3.4 : 2.4} />
          <path className="evm-stroke" d="M36.8 38.6Q40 34.4 43.2 38.6" strokeWidth={mini ? 3.4 : 2.4} />
        </>
      );
    case 'sleeping':
      return (
        <>
          <path className="evm-stroke" d="M20.8 37.6Q24 40.4 27.2 37.6" strokeWidth={mini ? 4.4 : 2.2} />
          <path className="evm-stroke" d="M36.8 37.6Q40 40.4 43.2 37.6" strokeWidth={mini ? 4.4 : 2.2} />
        </>
      );
    default: {
      const wide = state === 'listening';
      const rL = state === 'confused' ? 3.0 : 3.2;
      const rR = state === 'confused' ? 3.8 : 3.2;
      const ry = wide ? 4.7 : 4.2;
      const m = mini ? 1.35 : 1;
      return (
        <g className="evm-pupils">
          <ellipse className="evm-ink" cx="24" cy="37.5" rx={rL * m} ry={(state === 'confused' ? 3.8 : ry) * m} />
          <ellipse className="evm-ink" cx="40" cy="37.5" rx={rR * m} ry={(state === 'confused' ? 4.8 : ry) * m} />
          {hl && <circle className="evm-hl" cx="25.2" cy="35.8" r="1.15" />}
          {hl && <circle className="evm-hl" cx="41.2" cy="35.8" r="1.15" />}
        </g>
      );
    }
  }
}

function renderMouth(state: MascotState) {
  switch (state) {
    case 'listening':
      return <ellipse className="evm-ink" cx="32" cy="46.6" rx="1.7" ry="2.1" />;
    case 'thinking':
      return <path className="evm-stroke" d="M29.6 46.4H34.4" strokeWidth="1.8" />;
    case 'happy':
      return <path className="evm-stroke" d="M28.4 45Q32 49.6 35.6 45" strokeWidth="1.9" />;
    case 'confused':
      return <path className="evm-stroke" d="M28.5 46.8q1.75-1.6 3.5 0t3.5 0" strokeWidth="1.7" />;
    case 'sleeping':
      return <ellipse className="evm-ink" cx="32" cy="46.4" rx="1.3" ry="1" />;
    default:
      return <path className="evm-stroke" d="M29.2 45.4Q32 48.2 34.8 45.4" strokeWidth="1.8" />;
  }
}

export default Mascot;
