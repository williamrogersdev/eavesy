import { createFileRoute } from '@tanstack/react-router';
import { ImageResponse, loadGoogleFont } from 'workers-og';
import { siteConfig } from '@/lib/site';

const WIDTH = 1200;
const HEIGHT = 630;

const html = `
<div style="display:flex;flex-direction:column;justify-content:space-between;width:100%;height:100%;background:#08080c;padding:80px;color:#fafafa;font-family:Inter;">
  <div style="display:flex;align-items:center;">
    <div style="display:flex;align-items:center;justify-content:center;width:60px;height:60px;border-radius:18px;background:#111113;margin-right:22px;"><div style="display:flex;width:24px;height:24px;border-radius:999px;background:#ff3b30;"></div></div>
    <div style="display:flex;font-size:38px;font-weight:700;">${siteConfig.name}</div>
  </div>
  <div style="display:flex;flex-direction:column;">
    <div style="display:flex;font-size:78px;font-weight:700;line-height:1.05;letter-spacing:-0.03em;max-width:920px;">Context capture for AI agents.</div>
    <div style="display:flex;font-size:34px;color:#9b9ba6;max-width:880px;margin-top:28px;">Record your screen and voice. Get a Markdown brief you paste into any agent.</div>
  </div>
  <div style="display:flex;font-size:30px;font-weight:600;color:#ff5c52;">eavesy.com</div>
</div>`;

export const Route = createFileRoute('/og.png')({
  server: {
    handlers: {
      GET: async () => {
        const [regular, bold] = await Promise.all([
          loadGoogleFont({ family: 'Inter', weight: 400 }),
          loadGoogleFont({ family: 'Inter', weight: 700 }),
        ]);
        const image = new ImageResponse(html, {
          width: WIDTH,
          height: HEIGHT,
          fonts: [
            { name: 'Inter', data: regular, weight: 400, style: 'normal' },
            { name: 'Inter', data: bold, weight: 700, style: 'normal' },
          ],
        });
        const headers = new Headers(image.headers);
        headers.set('cache-control', 'public, max-age=86400, s-maxage=604800, immutable');
        return new Response(image.body, { status: image.status, headers });
      },
    },
  },
});
