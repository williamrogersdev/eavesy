const PRIVATE_ROUTE =
  /^\/(?:app|sign-in|sign-up|api|connect|onboarding)(?:\/|$)/;
export function isPrivateAuditPath(path: string): boolean {
  return PRIVATE_ROUTE.test(path);
}
export function isPublicAuditDestination(
  origin: string,
  responseUrl: string,
): boolean {
  const destination = new URL(responseUrl);
  return (
    destination.origin === new URL(origin).origin &&
    !isPrivateAuditPath(destination.pathname)
  );
}
