import { Link } from '@/components/ui/app-link';
import { Mascot } from '@/components/launcher/ui';
import { FOOTER_COLUMNS } from './content';
import { DownloadButton } from './ui';
import { Wordmark } from './nav';

export function Footer() {
  return (
    <footer className="ev-shelf-band relative mt-auto px-6 pb-10 pt-16">
      <div className="mx-auto max-w-6xl">
        <div className="grid gap-10 md:grid-cols-[1.4fr_repeat(4,1fr)]">
          <div>
            <Wordmark />
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-ev-ink-2">
              A small companion that lives on your Mac and keeps what you drop in
              as Markdown your AI can read.
            </p>
            <div className="mt-5">
              <DownloadButton className="px-4 py-2" />
            </div>
          </div>

          {FOOTER_COLUMNS.map((col) => (
            <div key={col.title}>
              <div className="font-round text-xs font-bold text-ev-ink-2">{col.title}</div>
              <ul className="mt-4 space-y-2.5 text-sm">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <Link href={link.href} className="text-ev-ink transition hover:text-ev-slate">{link.label}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-col items-center justify-between gap-4 border-t border-ev-line pt-6 text-sm text-ev-ink-2 sm:flex-row">
          <span className="flex items-center gap-2">
            <Mascot size={16} state="sleeping" />
            © {new Date().getFullYear()} Eavesy. All rights reserved.
          </span>
          <a href="https://github.com/williamrogersdev/eavesy" className="transition hover:text-ev-slate">GitHub ↗</a>
        </div>
      </div>
    </footer>
  );
}
