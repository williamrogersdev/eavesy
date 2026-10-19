import { createFileRoute } from '@tanstack/react-router';
import { ImageResponse, loadGoogleFont } from 'workers-og';
import { siteConfig } from '@/lib/site';

const WIDTH = 1200;
const HEIGHT = 630;

const MASCOT = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9Ii00IC04IDcyIDcyIiB3aWR0aD0iMjg4IiBoZWlnaHQ9IjI4OCI+CiAgPHRpdGxlPkVhdmVzeTwvdGl0bGU+CiAgPGRlZnM+PGNsaXBQYXRoIGlkPSJjIj48cGF0aCBkPSJNMTMuNSAyN0MxMy44IDE2LjUgMTkuNSA4LjUgMjYuNSA4LjVRMzIgMTEuNSAzNy41IDguNUM0NC41IDguNSA1MC4yIDE2LjUgNTAuNSAyN1oiLz48L2NsaXBQYXRoPjwvZGVmcz4KICA8ZWxsaXBzZSBjeD0iMzIiIGN5PSI2MSIgcng9IjE3IiByeT0iMi4yIiBmaWxsPSIjMkIyNTIzIiBvcGFjaXR5PSIuMTIiLz4KICA8ZWxsaXBzZSBjeD0iMzIiIGN5PSI0MSIgcng9IjIxIiByeT0iMTciIGZpbGw9IiMyQjI1MjMiLz4KICA8ZWxsaXBzZSBjeD0iMjUiIGN5PSI0MiIgcng9IjMuOCIgcnk9IjUuNCIgZmlsbD0iI0ZCRjdGMCIvPgogIDxlbGxpcHNlIGN4PSIzOSIgY3k9IjQyIiByeD0iMy44IiByeT0iNS40IiBmaWxsPSIjRkJGN0YwIi8+CiAgPGVsbGlwc2UgY3g9IjMyIiBjeT0iMjciIHJ4PSIzMCIgcnk9IjUiIGZpbGw9IiMyQjI1MjMiLz4KICA8cGF0aCBkPSJNMTMuNSAyN0MxMy44IDE2LjUgMTkuNSA4LjUgMjYuNSA4LjVRMzIgMTEuNSAzNy41IDguNUM0NC41IDguNSA1MC4yIDE2LjUgNTAuNSAyN1oiIGZpbGw9IiMyQjI1MjMiLz4KICA8cmVjdCBjbGlwLXBhdGg9InVybCgjYykiIHg9IjEwIiB5PSIyMCIgd2lkdGg9IjQ0IiBoZWlnaHQ9IjQuNiIgZmlsbD0iIzRBNDAzQyIvPgogIDxsaW5lIHgxPSI1MyIgeTE9IjU2IiB4Mj0iNTkiIHkyPSI2MyIgc3Ryb2tlPSIjNEE0MDNDIiBzdHJva2Utd2lkdGg9IjMuNCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+CiAgPGNpcmNsZSBjeD0iNDkuNSIgY3k9IjUxLjUiIHI9IjcuNiIgZmlsbD0iIzJCMjUyMyIvPgogIDxjaXJjbGUgY3g9IjQ5LjUiIGN5PSI1MS41IiByPSI1IiBmaWxsPSIjRkY1QTNDIi8+CiAgPGNpcmNsZSBjeD0iNDcuOCIgY3k9IjQ5LjgiIHI9IjEuMyIgZmlsbD0iI0ZGRkZGRiIgb3BhY2l0eT0iLjciLz4KPC9zdmc+Cg==';

const html = `
<div style="display:flex;flex-direction:column;justify-content:space-between;width:100%;height:100%;background:#FBF7F0;padding:80px;color:#211C1A;font-family:Nunito;">
  <div style="display:flex;align-items:center;">
    <img src="${MASCOT}" width="76" height="76" style="margin-right:18px;" />
    <div style="display:flex;font-size:42px;font-weight:800;">${siteConfig.name}</div>
  </div>
  <div style="display:flex;flex-direction:column;">
    <div style="display:flex;font-size:80px;font-weight:800;line-height:1.04;letter-spacing:-0.02em;max-width:900px;">Drop it in.</div>
    <div style="display:flex;font-size:80px;font-weight:800;line-height:1.04;letter-spacing:-0.02em;color:#5F5751;max-width:900px;">Paste it to your AI<span style="color:#FF5A3C;">.</span></div>
    <div style="display:flex;font-size:32px;color:#5F5751;max-width:880px;margin-top:28px;">Clipboard, screenshots, dictation and recordings, kept as Markdown on your Mac.</div>
  </div>
  <div style="display:flex;font-size:30px;font-weight:800;color:#211C1A;">eavesy.com</div>
</div>`;

export const Route = createFileRoute('/og.png')({
  server: {
    handlers: {
      GET: async () => {
        const [regular, bold] = await Promise.all([
          loadGoogleFont({ family: 'Nunito', weight: 400 }),
          loadGoogleFont({ family: 'Nunito', weight: 800 }),
        ]);
        const image = new ImageResponse(html, {
          width: WIDTH,
          height: HEIGHT,
          fonts: [
            { name: 'Nunito', data: regular, weight: 400, style: 'normal' },
            { name: 'Nunito', data: bold, weight: 800, style: 'normal' },
          ],
        });
        const headers = new Headers(image.headers);
        headers.set('cache-control', 'public, max-age=86400, s-maxage=604800, immutable');
        return new Response(image.body, { status: image.status, headers });
      },
    },
  },
});
