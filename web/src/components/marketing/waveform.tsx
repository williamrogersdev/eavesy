const EQ_BARS = [0.4, 0.8, 0.3, 1, 0.6, 0.9, 0.5, 0.7, 0.35, 0.85, 0.45];

export function Equalizer() {
  return (
    <span className="flex h-4 items-center gap-0.5">
      {EQ_BARS.map((h, i) => (
        <span
          key={i}
          className="w-0.5 animate-eq rounded-full bg-white/80"
          style={{ height: `${h * 100}%`, animationDelay: `${i * 90}ms` }}
        />
      ))}
    </span>
  );
}

const LEVEL_BARS = [0.3, 0.7, 0.5, 0.9, 0.4, 0.8, 0.6, 1, 0.45, 0.75, 0.35, 0.85];

export function LevelBars() {
  return (
    <span className="flex h-8 items-end gap-0.5">
      {LEVEL_BARS.map((h, i) => (
        <span
          key={i}
          className="flex-1 animate-eq rounded-full bg-accent"
          style={{ height: `${h * 100}%`, animationDelay: `${i * 80}ms` }}
        />
      ))}
    </span>
  );
}
