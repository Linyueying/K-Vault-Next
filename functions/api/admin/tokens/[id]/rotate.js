import { rotateApiToken } from '../../../../utils/api-token.js';
import { apiError, apiSuccess, decodePathParam, tokenErrorResponse } from '../../../../utils/api-v1.js';
import { writeAuditLog, AUDIT_EVENTS } from '../../../../utils/audit.js';

/**
 * POST /api/admin/tokens/:id/rotate (requirement #7).
 * New secret is generated, old secret dies immediately. The full new secret
 * is returned exactly once and never again in list APIs.
 */
export async function onRequestPost(context) {
  const { params, env, request } = context;
  const tokenId = decodePathParam(params?.id || '');

  if (!tokenId) {
    return apiError('VALIDATION_ERROR', 'Token id is required.', 400);
  }

  try {
    const rotated = await rotateApiToken(tokenId, env);
    if (!rotated) {
      return apiError('TOKEN_NOT_FOUND', 'API Token not found.', 404);
    }

    await writeAuditLog(env, {
      event: AUDIT_EVENTS.TOKEN_ROTATED,
      tokenId,
      operation: 'admin.tokens.rotate',
      success: true,
      client: String(request.headers.get('User-Agent') || '').slice(0, 60) || 'unknown',
    });

    return apiSuccess({ token: rotated.token, tokenInfo: rotated.record });
  } catch (error) {
    return tokenErrorResponse(error, 'TOKEN_ROTATE_FAILED', 400);
  }
}

export async function onRequest(context) {
  return apiError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
}
