// If-Range accepts a strong ETag or an HTTP date. Weak ETags cannot verify
// that the bytes from separate range requests belong to the same version.
export function normalizeRangeValidator(value) {
  const validator = typeof value === 'string' ? value.trim() : '';
  if (!validator || validator.length > 512) return '';
  if (/^"[^"\r\n]*"$/.test(validator)) return validator;
  if (!/^[A-Za-z]{3}, .+ GMT$/.test(validator)) return '';
  const timestamp = Date.parse(validator);
  return Number.isFinite(timestamp) ? new Date(timestamp).toUTCString() : '';
}

export async function rangeUploadSourceId(url, validator) {
  if (typeof url !== 'string' || url.length > 8192) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  parsed.hash = '';
  const input = JSON.stringify([parsed.href, normalizeRangeValidator(validator)]);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
