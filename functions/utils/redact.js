/**
 * Secret redaction helpers (requirement #13).
 * Ensures full API Token secrets never leak into logs, error messages,
 * audit records or console output.
 */

const TOKEN_PATTERN = /kvault_[A-Za-z0-9_-]{6,}/g;
const REDACTED = 'kvault_***REDACTED***';

export function redactSecrets(input) {
  if (typeof input !== 'string') return input;
  return input.replace(TOKEN_PATTERN, REDACTED);
}

