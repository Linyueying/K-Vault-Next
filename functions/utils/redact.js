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

export function redactErrorMessage(error) {
  if (error == null) return '';
  const message = typeof error === 'string' ? error : String(error?.message || error);
  return redactSecrets(message);
}

export function safeLogError(error, ...rest) {
  try {
    console.error(redactErrorMessage(error), ...rest.map((item) => (
      typeof item === 'string' ? redactSecrets(item) : item
    )));
  } catch {
    // logging must never throw
  }
}
