import { checkAuthentication, isAuthRequired } from '../../utils/auth.js';
import { apiError } from '../../utils/api-v1.js';
import { handleApiPreflight } from '../../utils/cors.js';

/**
 * Admin API middleware (requirement #1 — fail closed).
 *
 * /api/admin/** ALWAYS requires admin authentication:
 * - KV binding missing            -> 500 SERVER_MISCONFIGURED
 * - No BASIC_USER/BASIC_PASS set  -> 503 ADMIN_AUTH_NOT_CONFIGURED
 * - Invalid/expired credentials   -> 401 UNAUTHORIZED
 *
 * Public browse / guest upload modes never grant anonymous admin access.
 * /api/admin/** is never opened for cross-origin access (preflight answers
 * 204 without ACAO, browser blocks the actual request).
 */
export async function onRequest(context) {
  const { request, env } = context;

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

  if (!isAuthRequired(env)) {
    return apiError(
      'ADMIN_AUTH_NOT_CONFIGURED',
      'Admin API requires BASIC_USER and BASIC_PASS to be configured. Admin endpoints fail closed when no admin credential is set.',
      503
    );
  }

  const authResult = await checkAuthentication(context);
  if (!authResult.authenticated) {
    return apiError('UNAUTHORIZED', 'Admin authentication required.', 401);
  }

  return context.next();
}
