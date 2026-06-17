const DEFAULT_PATTERNS: RegExp[] = [
  // Key=value assignments
  /\b(token|secret|password|api[_-]?key|credential)\s*[=:]\s*\S+/gi,

  // slock secrets (F2 confirmed, short suffix like slock_secret_abc123)
  /\b(slock_secret)_[A-Za-z0-9_]{6,}/g,

  // OpenAI / Stripe API keys (F2 confirmed, e.g. sk-test-deadbeef..., sk-proj-...)
  /\b(sk-[A-Za-z0-9-]{20,})/g,

  // GitHub personal access tokens
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/g,

  // AWS access key IDs
  /\b(AKIA[0-9A-Z]{16})/g,

  // Generic long base64/blob (40+ chars, requires mixed content:
  // upper+lower, or contains +/=, or a digit mix — NOT pure lowercase hex)
  /\b(?=.*[0-9])(?=.*[a-z])(?=.*[A-Z+\/=])[A-Za-z0-9+\/=]{40,}\b/g,
];

export function scanCredentials(input: string, extraPatterns: RegExp[] = []): string | null {
  const patterns = [...DEFAULT_PATTERNS, ...extraPatterns];

  for (const pattern of patterns) {
    // Reset lastIndex for regex with global flag
    pattern.lastIndex = 0;
    const match = pattern.exec(input);
    if (match) {
      return match[0];
    }
  }

  return null;
}
