/**
 * Unified API CORS (requirement #3).
 *
 * - API_CORS_ORIGINS: comma-separated origin whitelist. "*" allows any origin
 *   (without credentials). Unset/empty = same-origin only (no ACAO header).
 * - Preflight OPTIONS always answers 204 without requiring a Bearer token.
 * - /api/admin/** is never opened for cross-origin access.
 */

const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'Authorization, Content-Type, Accept, Range, Idempotency-Key, X-KVault-Client';
const MAX_AGE = '86400';

export function parseCorsOrigins(env) {
  const raw = String(env?.API_CORS_ORIGINS || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function resolveCorsHeaders(request, env) {
  const headers = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Max-Age': MAX_AGE,
  };

  const origin = String(request.headers.get('Origin') || '').trim();
  if (!origin) return headers;

  const whitelist = parseCorsOrigins(env);
  if (whitelist.includes('*')) {
    headers['Access-Control-Allow-Origin'] = '*';
    return headers;
  }
  if (whitelist.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    return headers;
  }
  // Origin not whitelisted: no ACAO header -> browser blocks the response.
  return headers;
}

export function handleApiPreflight(request, env) {
  return new Response(null, {
    status: 204,
    headers: resolveCorsHeaders(request, env),
  });
}
