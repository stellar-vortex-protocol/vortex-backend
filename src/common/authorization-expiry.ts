export function isAuthorizationExpired(expiresAt: number, now = Date.now()) {
  return expiresAt <= now;
}
