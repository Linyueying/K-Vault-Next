import {
  checkTokenRateLimit,
  parseBearerToken,
  touchApiTokenUsage,
  verifyApiToken,
} from '../../utils/api-token.js';
import { apiError } from '../../utils/api-v1.js';
import { handleApiPreflight, resolveCorsHeaders } from '../../utils/cors.js';
import { writeAuditLog, AUDIT_EVENTS } from '../../utils/audit.js';

// Low-write mode (MINIMIZE_KV_WRITES=true): token validation still reads KV,
// but usage stats are persisted at most once per hour.
const MINIMIZED_USAGE_UPDATE_INTERVAL_MS = 60 * 60 * 1000;

function resolveRequiredScope(request) {
  const pathname = new URL(request.url).pathname.replace(/\/+$/, '');
  const method = String(request.method || 'GET').toUpperCase();
  const isReadMethod = method === 'GET' || method === 'HEAD';

  const base = '/api/v1';
  if (!pathname.startsWith(base)) return '';
  const subPath = pathname.slice(base.length) || '/';

  // Public, no bearer required:
  if (isReadMethod && subPath === '/capabilities') return '';

  // Introspection: any valid token, no specific scope ("@me" sentinel).
  if (isReadMethod && subPath === '/me') return '@me';

  if (method === 'POST' && subPath === '/upload') return 'upload';
  if (method === 'POST' && subPath === '/import') return 'upload';
  if (isReadMethod && subPath === '/files') return 'read';

  // File routes are [[path]] routes, so the id can span multiple segments.
  // Match on the prefix rather than a single-segment regex — otherwise
  // `/api/v1/file/a/b` matched nothing and slipped through unauthenticated.
  // Any other method still needs a valid token.
  if (subPath === '/file' || subPath.startsWith('/file/')) {
    if (isReadMethod) return 'read';
    if (method === 'DELETE') return 'delete';
    return '@me';
  }

  if (method === 'POST' && subPath === '/paste') return 'paste';
  if (isReadMethod && subPath === '/pastes') return 'read';
  if (subPath === '/paste' || subPath.startsWith('/paste/')) {
    if (isReadMethod) return 'read';
    if (method === 'DELETE') return 'delete';
    return '@me';
  }

  // Unknown routes fail closed: require a valid token rather than letting the
  // request through with no authentication at all.
  return '@me';
}

function clientTag(request) {
  return String(request.headers.get('User-Agent') || '').slice(0, 60) || 'unknown';
}

export async function onRequest(context) {
  const { request, env } = context;

  // Preflight: always 204, never requires a Bearer token (requirement #3).
  if (request.method === 'OPTIONS') {
    return handleApiPreflight(request, env);
  }

  if (!env?.img_url) {
    return apiError(
      'SERVER_MISCONFIGURED',
      'KV binding img_url is not configured.',
      500
    );
  }

  const corsHeaders = resolveCorsHeaders(request, env);

  const requiredScope = resolveRequiredScope(request);

  if (requiredScope === '') {
    const response = await context.next();
    applyCorsToResponse(response, corsHeaders);
    return response;
  }

  const tokenValue = parseBearerToken(request);
  const verifyResult = await verifyApiToken(tokenValue, env, requiredScope);

  if (!verifyResult.ok) {
    // Usage telemetry for failed verification (tokenId when parseable) and an
    // audit trail entry; both never block the response flow.
    const failedId = parseBearerToken(request);
    context.waitUntil?.(Promise.resolve(
      touchApiTokenUsage(extractTokenId(failedId), env, {
        success: false,
        operation: `${request.method} ${new URL(request.url).pathname}`,
        client: clientTag(request),
      })
    ).catch(() => {}));
    context.waitUntil?.(writeAuditLog(env, {
      event: AUDIT_EVENTS.TOKEN_VERIFY_FAILED,
      operation: `${request.method} ${new URL(request.url).pathname}`,
      success: false,
      client: clientTag(request),
      detail: verifyResult.code || 'TOKEN_INVALID',
    }).catch(() => {}));

    const errorResponse = apiError(
      verifyResult.code || 'TOKEN_INVALID',
      verifyResult.message || 'API Token is invalid.',
      verifyResult.status || 401
    );
    applyCorsToResponse(errorResponse, corsHeaders);
    return errorResponse;
  }

  // Per-token rate limit (requirement #10).
  const rateLimit = await checkTokenRateLimit(verifyResult.token, env);
  if (!rateLimit.allowed) {
    const limited = apiError('RATE_LIMITED', 'API Token rate limit exceeded.', 429, {
      retryAfterMs: rateLimit.retryAfterMs,
    });
    limited.headers.set('Retry-After', String(Math.ceil(rateLimit.retryAfterMs / 1000)));
    applyCorsToResponse(limited, corsHeaders);
    return limited;
  }

  context.data = context.data || {};
  context.data.apiToken = verifyResult.token;

  // Telemetry: writes only the stat key, 60s sampled (requirement #2).
  // Low-write mode: raise the telemetry sampling interval from 60s to 1h.
  const minimizeKvWrites = env.MINIMIZE_KV_WRITES === 'true';
  const touchPromise = touchApiTokenUsage(verifyResult.token.id, env, {
    minIntervalMs: minimizeKvWrites ? MINIMIZED_USAGE_UPDATE_INTERVAL_MS : 0,
    success: true,
    operation: `${request.method} ${new URL(request.url).pathname}`.slice(0, 64),
    client: clientTag(request),
  }).catch((error) => {
    console.warn('Failed to update API token usage stats:', error?.message || error);
  });
  if (typeof context.waitUntil === 'function') {
    context.waitUntil(touchPromise);
  }

  const response = await context.next();
  applyCorsToResponse(response, corsHeaders);
  return response;
}

function applyCorsToResponse(response, corsHeaders) {
  if (!response || !response.headers) return response;
  Object.entries(corsHeaders).forEach(([key, value]) => {
    try {
      response.headers.set(key, value);
    } catch {
      // immutable headers are fine to skip
    }
  });
  return response;
}

function extractTokenId(tokenValue) {
  const match = /^kvault_([A-Za-z0-9_-]{6,128})_/.exec(String(tokenValue || '').trim());
  return match ? match[1] : '';
}
