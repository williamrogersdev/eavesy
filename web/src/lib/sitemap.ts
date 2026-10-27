import { absoluteUrl } from "./site";
export interface SitemapEntry {
  path: string;
  modified?: string;
}
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
export function renderSitemap(entries: SitemapEntry[]): string {
  const urls = entries
    .map(({ path, modified }) => {
      const date =
        modified && Number.isFinite(Date.parse(modified))
          ? new Date(modified).toISOString()
          : undefined;
      return `  <url><loc>${escapeXml(absoluteUrl(path))}</loc>${date ? `<lastmod>${date}</lastmod>` : ""}</url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
