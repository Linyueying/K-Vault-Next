/**
 * Secret redaction helpers (requirement #13) — Docker/CommonJS variant.
 */

const TOKEN_PATTERN = /kvault_[A-Za-z0-9_-]{6,}/g;
const REDACTED = 'kvault_***REDACTED***';

function redactSecrets(input) {
  if (typeof input !== 'string') return input;
  return input.replace(TOKEN_PATTERN, REDACTED);
}

function redactErrorMessage(error) {
  if (error == null) return '';
  const message = typeof error === 'string' ? error : String(error?.message || error);
  return redactSecrets(message);
}

function safeLogError(error, ...rest) {
  try {
    console.error(redactErrorMessage(error), ...rest.map((item) => (
      typeof item === 'string' ? redactSecrets(item) : item
    )));
  } catch {
    // logging must never throw
  }
}

module.exports = {
  redactSecrets,
  redactErrorMessage,
  safeLogError,
};
