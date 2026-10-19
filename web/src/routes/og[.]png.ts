import { createFileRoute } from '@tanstack/react-router';
import { ImageResponse, loadGoogleFont } from 'workers-og';
import { siteConfig } from '@/lib/site';

const WIDTH = 1200;
const HEIGHT = 630;

const MASCOT = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9Ii00IC04IDcyIDcyIiB3aWR0aD0iMjg4IiBoZWlnaHQ9IjI4OCI+CiAgCiAgPGRlZnM+PGNsaXBQYXRoIGlkPSJiIj48cGF0aCBkPSJNMzIgMTVDNDYuNSAxNSA1NCAyNyA1NCA0MEM1NCA1MS41IDQ1IDU4LjUgMzIgNTguNUMxOSA1OC41IDEwIDUxLjUgMTAgNDBDMTAgMjcgMTcuNSAxNSAzMiAxNVoiLz48L2NsaXBQYXRoPjwvZGVmcz4KICA8ZWxsaXBzZSBjeD0iMzIiIGN5PSI2MSIgcng9IjE1IiByeT0iMi4yIiBmaWxsPSIjMkEyMjMzIiBvcGFjaXR5PSIuMSIvPgogIDxwYXRoIGQ9Ik0zMiAxNUM0Ni41IDE1IDU0IDI3IDU0IDQwQzU0IDUxLjUgNDUgNTguNSAzMiA1OC41QzE5IDU4LjUgMTAgNTEuNSAxMCA0MEMxMCAyNyAxNy41IDE1IDMyIDE1WiIgZmlsbD0iI0Y2QjkzQiIvPgogIDxwb2x5bGluZSBjbGlwLXBhdGg9InVybCgjYikiIHBvaW50cz0iOCwzMy41IDMyLDEzLjUgNTYsMzMuNSIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjRTM5RTFFIiBzdHJva2Utb3BhY2l0eT0iLjQ1IiBzdHJva2Utd2lkdGg9IjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPgogIDxlbGxpcHNlIGN4PSIxNy42IiBjeT0iNDQuNiIgcng9IjMuNiIgcnk9IjIuMiIgZmlsbD0iI0Y1OUJBMCIgb3BhY2l0eT0iLjciLz4KICA8ZWxsaXBzZSBjeD0iNDYuNCIgY3k9IjQ0LjYiIHJ4PSIzLjYiIHJ5PSIyLjIiIGZpbGw9IiNGNTlCQTAiIG9wYWNpdHk9Ii43Ii8+CiAgPGVsbGlwc2UgY3g9IjI0IiBjeT0iMzcuNSIgcng9IjMuMiIgcnk9IjQuMiIgZmlsbD0iIzJBMjIzMyIvPgogIDxlbGxpcHNlIGN4PSI0MCIgY3k9IjM3LjUiIHJ4PSIzLjIiIHJ5PSI0LjIiIGZpbGw9IiMyQTIyMzMiLz4KICA8Y2lyY2xlIGN4PSIyNS4yIiBjeT0iMzUuOCIgcj0iMS4xNSIgZmlsbD0iI0ZGRjhFRSIvPgogIDxjaXJjbGUgY3g9IjQxLjIiIGN5PSIzNS44IiByPSIxLjE1IiBmaWxsPSIjRkZGOEVFIi8+CiAgPHBhdGggZD0iTTI5LjIgNDUuNFEzMiA0OC4yIDM0LjggNDUuNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMkEyMjMzIiBzdHJva2Utd2lkdGg9IjEuOCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+CiAgPHJlY3QgeD0iNDMiIHk9IjkuNSIgd2lkdGg9IjUuMiIgaGVpZ2h0PSIxMCIgcng9IjEuNCIgZmlsbD0iIzRCM0E3OCIvPgogIDxsaW5lIHgxPSIzMiIgeTE9IjkiIHgyPSI1IiB5Mj0iMzEiIHN0cm9rZT0iIzRCM0E3OCIgc3Ryb2tlLXdpZHRoPSI4IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz4KICA8bGluZSB4MT0iMzIiIHkxPSI5IiB4Mj0iNTkiIHkyPSIzMSIgc3Ryb2tlPSIjNEIzQTc4IiBzdHJva2Utd2lkdGg9IjgiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L3N2Zz4K';

const html = `
<div style="display:flex;flex-direction:column;justify-content:space-between;width:100%;height:100%;background:#FBF7F2;padding:80px;color:#2A2233;font-family:Nunito;">
  <div style="display:flex;align-items:center;">
    <img src="${MASCOT}" width="76" height="76" style="margin-right:18px;" />
    <div style="display:flex;font-size:42px;font-weight:800;">${siteConfig.name}</div>
  </div>
  <div style="display:flex;flex-direction:column;">
    <div style="display:flex;font-size:80px;font-weight:800;line-height:1.04;letter-spacing:-0.02em;max-width:900px;">Drop it in.</div>
    <div style="display:flex;font-size:80px;font-weight:800;line-height:1.04;letter-spacing:-0.02em;color:#4B3A78;max-width:900px;">Paste it to your AI.</div>
    <div style="display:flex;font-size:32px;color:#675D70;max-width:880px;margin-top:28px;">Clipboard, screenshots, dictation and recordings, kept as Markdown on your Mac.</div>
  </div>
  <div style="display:flex;font-size:30px;font-weight:800;color:#4B3A78;">eavesy.com</div>
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
