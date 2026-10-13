import { Link } from '@/components/ui/app-link';
import { FOOTER_COLUMNS } from './content';
import { DownloadButton } from './ui';
import { BrandMark } from '@/components/brand-mark';

export function Footer() {
  return (
    <footer className="border-t border-white/[0.06] px-6 py-14">
      <div className="mx-auto max-w-6xl">
        <div className="grid gap-10 md:grid-cols-[1.4fr_repeat(4,1fr)]">
          <div>
            <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
              <BrandMark className="h-7 w-7" />
              Eavesy
            </Link>
            <p className="mt-4 max-w-xs text-sm text-white/55">
              Turn a workflow, meeting, or bug reproduction into structured
              context your AI can act on.
            </p>
            <div className="mt-5">
              <DownloadButton className="px-4 py-2" />
            </div>
          </div>

          {FOOTER_COLUMNS.map((col) => (
            <div key={col.title}>
              <div className="text-sm font-semibold text-white/80">{col.title}</div>
              <ul className="mt-4 space-y-2.5 text-sm">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <Link href={link.href} className="text-white/55 transition hover:text-white">{link.label}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-center justify-between gap-4 border-t border-white/[0.06] pt-6 text-sm text-white/50 sm:flex-row">
          <span>© {new Date().getFullYear()} Eavesy. All rights reserved.</span>
          <a href="https://github.com/williamrogersdev/eavesy" className="transition hover:text-white">GitHub ↗</a>
        </div>
      </div>
    </footer>
  );
}
