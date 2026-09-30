const SENSITIVE_KEY_PATTERNS = [
  // Stellar secret seeds (S... strkeys, 56 chars)
  /S[A-Z2-7]{55}/g,
  // Generic key patterns in JSON/logs
  /secretKey\s*[:=]\s*["']?\S+/gi,
  /privateKey\s*[:=]\s*["']?\S+/gi,
  /apiKey\s*[:=]\s*["']?\S+/gi,
  /accessToken\s*[:=]\s*["']?\S+/gi,
  /refreshToken\s*[:=]\s*["']?\S+/gi,
  /jwt\s*[:=]\s*["']?\S+/gi,
  /signingKey\s*[:=]\s*["']?\S+/gi,
  /webhookSecret\s*[:=]\s*["']?\S+/gi,
  /channelKey\s*[:=]\s*["']?\S+/gi,
  /killswitchOperatorToken\s*[:=]\s*["']?\S+/gi,
  /adminApiKeys\s*[:=]\s*["']?\S+/gi,
  /sentryDsn\s*[:=]\s*["']?\S+/gi,
  /vaultToken\s*[:=]\s*["']?\S+/gi,
  // AWS secret access key
  /AKIA[0-9A-Z]{16}/g,
  // Generic password/secret in URL
  /:\/\/[^:\/\s]+:([^@\/\s]{8,})@/gi,
  // Database connection strings with passwords
  /postgresql:\/\/[^:]+:([^@]+)@/gi,
  /mysql:\/\/[^:]+:([^@]+)@/gi,
  // Bearer tokens
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
];

/**
 * Scan a serialized error/log payload for raw Stellar secret-key material.
 * Returns the first few suspicious matches so tests can assert that logs and
 * thrown errors never expose the hot-wallet seed or similar credentials.
 */
export function findSensitiveKeyMaterial(value: unknown): string[] {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const hits = new Set<string>();

  for (const pattern of SENSITIVE_KEY_PATTERNS) {
    const matches = text.match(pattern);
    if (!matches) continue;
    for (const match of matches) {
      hits.add(match);
    }
  }

  return [...hits].slice(0, 10);
}

export function assertNoSensitiveKeyMaterial(value: unknown, context = "serialized payload"): void {
  const leaked = findSensitiveKeyMaterial(value);
  if (leaked.length > 0) {
    throw new Error(`${context} contains sensitive key material: ${leaked.join(", ")}`);
  }
}
