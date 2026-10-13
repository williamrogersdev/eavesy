const SAFE = /^(audio|video|image)\/[a-z0-9.+-]+$/;

export function safeMediaType(contentType: string | null | undefined): string {
  const type = contentType?.split(';')[0]?.trim().toLowerCase() ?? '';
  return SAFE.test(type) && type !== 'image/svg+xml' ? type : 'application/octet-stream';
}
