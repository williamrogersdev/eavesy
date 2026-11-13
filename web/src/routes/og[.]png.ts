import { createFileRoute } from '@tanstack/react-router';
import { ImageResponse, loadGoogleFont } from 'workers-og';
import { siteConfig } from '@/lib/site';

const WIDTH = 1200;
const HEIGHT = 630;

const MASCOT = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9Ii00IC04IDcyIDcyIiB3aWR0aD0iMjg4IiBoZWlnaHQ9IjI4OCI+CiAgPHRpdGxlPkVhdmVzeTwvdGl0bGU+CiAgPGRlZnM+PGNsaXBQYXRoIGlkPSJjIj48cGF0aCBkPSJNMTMuNSAyN0MxMy44IDE2LjUgMTkuNSA4LjUgMjYuNSA4LjVRMzIgMTEuNSAzNy41IDguNUM0NC41IDguNSA1MC4yIDE2LjUgNTAuNSAyN1oiLz48L2NsaXBQYXRoPjwvZGVmcz4KICA8ZWxsaXBzZSBjeD0iMzIiIGN5PSI2MSIgcng9IjE3IiByeT0iMi4yIiBmaWxsPSIjMTYyMTNGIiBvcGFjaXR5PSIuMTIiLz4KICA8ZWxsaXBzZSBjeD0iMzIiIGN5PSI0MSIgcng9IjIxIiByeT0iMTciIGZpbGw9IiNGMkIyMzMiLz4KICA8ZWxsaXBzZSBjeD0iMjUiIGN5PSI0MiIgcng9IjMuOCIgcnk9IjUuNCIgZmlsbD0iIzE2MjEzRiIvPgogIDxlbGxpcHNlIGN4PSIzOSIgY3k9IjQyIiByeD0iMy44IiByeT0iNS40IiBmaWxsPSIjMTYyMTNGIi8+CiAgPGVsbGlwc2UgY3g9IjMyIiBjeT0iMjciIHJ4PSIzMCIgcnk9IjUiIGZpbGw9IiMxNjIxM0YiLz4KICA8cGF0aCBkPSJNMTMuNSAyN0MxMy44IDE2LjUgMTkuNSA4LjUgMjYuNSA4LjVRMzIgMTEuNSAzNy41IDguNUM0NC41IDguNSA1MC4yIDE2LjUgNTAuNSAyN1oiIGZpbGw9IiMxNjIxM0YiLz4KICA8cmVjdCBjbGlwLXBhdGg9InVybCgjYykiIHg9IjEwIiB5PSIyMCIgd2lkdGg9IjQ0IiBoZWlnaHQ9IjQuNiIgZmlsbD0iI0ZCRjhGMSIvPgogIDxsaW5lIHgxPSI1MyIgeTE9IjU2IiB4Mj0iNTkiIHkyPSI2MyIgc3Ryb2tlPSIjMTYyMTNGIiBzdHJva2Utd2lkdGg9IjMuNCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+CiAgPGNpcmNsZSBjeD0iNDkuNSIgY3k9IjUxLjUiIHI9IjcuNiIgZmlsbD0iIzE2MjEzRiIvPgogIDxjaXJjbGUgY3g9IjQ5LjUiIGN5PSI1MS41IiByPSI1IiBmaWxsPSIjRkY1QTNDIi8+CiAgPGNpcmNsZSBjeD0iNDcuOCIgY3k9IjQ5LjgiIHI9IjEuMyIgZmlsbD0iI0ZGRkZGRiIgb3BhY2l0eT0iLjciLz4KPC9zdmc+Cg==';

const html = `
<div style="display:flex;flex-direction:column;justify-content:space-between;width:100%;height:100%;background:#FBF8F1;padding:80px;color:#16213F;font-family:Geist;">
  <div style="display:flex;align-items:center;">
    <img src="${MASCOT}" width="76" height="76" style="margin-right:18px;" />
    <div style="display:flex;font-size:42px;font-weight:700;">${siteConfig.name}</div>
  </div>
  <div style="display:flex;flex-direction:column;">
    <div style="display:flex;font-size:80px;font-weight:700;line-height:1.04;letter-spacing:-0.02em;max-width:900px;">Drop it in.</div>
    <div style="display:flex;font-size:80px;font-weight:700;line-height:1.04;letter-spacing:-0.02em;color:#16213F;max-width:900px;">Paste it to your AI<span style="color:#F2B233;">.</span></div>
    <div style="display:flex;font-size:32px;color:#505A75;max-width:880px;margin-top:28px;">Capture text, screenshots, dictation and recordings as plain files on your Mac.</div>
  </div>
  <div style="display:flex;font-size:30px;font-weight:700;color:#16213F;">eavesy.com</div>
</div>`;

export const Route = createFileRoute('/og.png')({
  server: {
    handlers: {
      GET: async () => {
        const [regular, bold] = await Promise.all([
          loadGoogleFont({ family: 'Geist', weight: 400 }),
          loadGoogleFont({ family: 'Geist', weight: 700 }),
        ]);
        const image = new ImageResponse(html, {
          width: WIDTH,
          height: HEIGHT,
          fonts: [
            { name: 'Geist', data: regular, weight: 400, style: 'normal' },
            { name: 'Geist', data: bold, weight: 700, style: 'normal' },
          ],
        });
        const headers = new Headers(image.headers);
        headers.set('cache-control', 'public, max-age=86400, s-maxage=604800, immutable');
        return new Response(image.body, { status: image.status, headers });
      },
    },
  },
});
