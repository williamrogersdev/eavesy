import { Link } from '@/components/ui/app-link';
import { Mascot } from '@/components/launcher/ui';
import { GithubMark } from '@/components/github-mark';
import { siteConfig } from '@/lib/site';
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
            <div className="mt-5 flex flex-wrap gap-2">
              <DownloadButton className="px-4 py-2" />
              <a
                href={siteConfig.github}
                className="inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 font-round text-sm font-bold text-ev-ink shadow-[inset_0_0_0_1px_var(--ev-line-strong)] transition duration-150 hover:bg-ev-well active:scale-[0.97]"
              >
                <GithubMark className="h-4 w-4" />
                GitHub
              </a>
            </div>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-ev-ink-2">
              Open source under the Apache License 2.0.{' '}
              <Link href="/docs/open-source" className="text-ev-ink underline underline-offset-2 transition hover:text-ev-coat">
                Read the code or host your own.
              </Link>
            </p>
          </div>

          {FOOTER_COLUMNS.map((col) => (
            <div key={col.title}>
              <div className="font-round text-xs font-bold text-ev-ink-2">{col.title}</div>
              <ul className="mt-4 space-y-2.5 text-sm">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <Link href={link.href} className="text-ev-ink transition hover:text-ev-coat">{link.label}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-14 flex flex-col items-center justify-between gap-4 border-t border-ev-line pt-6 text-sm text-ev-ink-2 sm:flex-row">
          <span className="flex items-center gap-2">
            <Mascot size={16} state="sleeping" />
            © {new Date().getFullYear()} Eavesy. Open source under Apache-2.0.
          </span>
          <a href={siteConfig.github} className="inline-flex items-center gap-1.5 transition hover:text-ev-coat">
            <GithubMark className="h-4 w-4" />
            williamrogersdev/eavesy
          </a>
        </div>
      </div>
    </footer>
  );
}
