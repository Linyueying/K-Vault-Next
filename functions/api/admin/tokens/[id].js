import {
  deleteApiToken,
  getRecordById,
  parseExpiryInput,
  rotateApiToken,
  updateApiToken,
} from '../../../utils/api-token.js';
import { apiError, apiSuccess, decodePathParam, tokenErrorResponse, parseTokenExpiryFromBody } from '../../../utils/api-v1.js';
import { writeAuditLog, AUDIT_EVENTS } from '../../../utils/audit.js';

function clientTag(request) {
  const ua = String(request.headers.get('User-Agent') || '').slice(0, 60);
  return ua || 'unknown';
}

export async function onRequest(context) {
  const { request, params, env } = context;
  const tokenId = decodePathParam(params?.id || '');

  if (!tokenId) {
    return apiError('VALIDATION_ERROR', 'Token id is required.', 400);
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  if (request.method === 'PATCH') {
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    try {
      const patch = {};
      if (Object.prototype.hasOwnProperty.call(body, 'enabled')) {
        patch.enabled = body.enabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'name')) {
        patch.name = body.name;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'scopes')) {
        patch.scopes = body.scopes;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'policies')) {
        patch.policies = body.policies;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'expiresAtMs')) {
        const ms = Number(body.expiresAtMs);
        patch.expiresAt = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : null;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'expiresAt')) {
        patch.expiresAt = parseExpiryInput(body.expiresAt);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'expires_in')) {
        const seconds = Number.parseInt(String(body.expires_in), 10);
        patch.expiresAt = Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : null;
      }

      if (Object.keys(patch).length === 0) {
        return apiError('VALIDATION_ERROR', 'No token fields provided to update.', 400);
      }

      const previous = await getRecordById(tokenId, env);
      const updated = await updateApiToken(tokenId, patch, env);

      if (!updated) {
        return apiError('TOKEN_NOT_FOUND', 'API Token not found.', 404);
      }

      // Audit: distinguish scope changes and enable/disable (requirement #12).
      if (Object.prototype.hasOwnProperty.call(patch, 'enabled') && previous && previous.enabled !== updated.record.enabled) {
        await writeAuditLog(env, {
          event: updated.record.enabled ? AUDIT_EVENTS.TOKEN_ENABLED : AUDIT_EVENTS.TOKEN_DISABLED,
          tokenId,
          operation: 'admin.tokens.update',
          success: true,
          client: clientTag(request),
        });
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'scopes')) {
        await writeAuditLog(env, {
          event: AUDIT_EVENTS.TOKEN_SCOPE_CHANGED,
          tokenId,
          operation: 'admin.tokens.update',
          success: true,
          client: clientTag(request),
          detail: `scopes=[${updated.record.scopes.join(',')}]`,
        });
      }

      return apiSuccess({ token: updated.record });
    } catch (error) {
      return tokenErrorResponse(error, 'TOKEN_UPDATE_FAILED', 400);
    }
  }

  if (request.method === 'POST') {
    // POST /api/admin/tokens/:id with { action: "rotate" } (requirement #7).
    // Also routed here because [id].js sees POST for sub-actions.
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    if (String(body?.action || '').toLowerCase() !== 'rotate') {
      return apiError('VALIDATION_ERROR', 'Unsupported action. Use { "action": "rotate" }.', 400);
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
        client: clientTag(request),
      });

      // Full new secret is returned exactly once (requirement #7).
      return apiSuccess({ token: rotated.token, tokenInfo: rotated.record });
    } catch (error) {
      return tokenErrorResponse(error, 'TOKEN_ROTATE_FAILED', 400);
    }
  }

  if (request.method === 'DELETE') {
    const deleted = await deleteApiToken(tokenId, env);
    if (!deleted) {
      return apiError('TOKEN_NOT_FOUND', 'API Token not found.', 404);
    }

    await writeAuditLog(env, {
      event: AUDIT_EVENTS.TOKEN_DELETED,
      tokenId,
      operation: 'admin.tokens.delete',
      success: true,
      client: clientTag(request),
    });

    return apiSuccess({ deleted: true });
  }

  return apiError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
}
