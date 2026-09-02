const SENSITIVE_KEY_PATTERNS = [
  /S[A-Z2-7]{55}/g,
  /secretKey\s*[:=]\s*["']?\S+/gi,
  /privateKey\s*[:=]\s*["']?\S+/gi,
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
