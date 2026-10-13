export function errMsg(error: unknown, fallback = 'Something went wrong'): string {
  if (typeof error === 'string' && error.trim()) return error;
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message: unknown = error.message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}
