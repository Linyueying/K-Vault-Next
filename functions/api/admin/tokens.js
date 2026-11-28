import {
  createApiToken,
  getApiTokenScopes,
  listApiTokens,
  parseExpiryInput,
} from '../../utils/api-token.js';
import { apiError, apiSuccess, tokenErrorResponse, parseTokenExpiryFromBody } from '../../utils/api-v1.js';
import { writeAuditLog, AUDIT_EVENTS } from '../../utils/audit.js';

function clientTag(request) {
  const ua = String(request.headers.get('User-Agent') || '').slice(0, 60);
  return ua || 'unknown';
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  if (request.method === 'GET') {
    const tokens = await listApiTokens(env);
    return apiSuccess({
      tokens,
      scopes: getApiTokenScopes(),
    });
  }

  if (request.method !== 'POST') {
    return apiError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const name = String(body?.name || body?.remark || '').trim();
  if (!name) {
    return apiError('VALIDATION_ERROR', 'Token name is required.', 400);
  }

  try {
    const expiry = parseTokenExpiryFromBody(body);
    const expiresAt = expiry.kind === 'iso'
      ? parseExpiryInput(expiry.value)
      : (expiry.kind === 'ms' ? expiry.value : null);

    const created = await createApiToken(
      {
        name,
        scopes: body?.scopes || [],
        expiresAt,
        policies: body?.policies,
        enabled: body?.enabled !== false,
      },
      env
    );

    await writeAuditLog(env, {
      event: AUDIT_EVENTS.TOKEN_CREATED,
      tokenId: created.record.id,
      operation: 'admin.tokens.create',
      success: true,
      client: clientTag(request),
      detail: `name="${created.record.name}" scopes=[${created.record.scopes.join(',')}]`,
    });

    return apiSuccess(
      {
        token: created.token,
        tokenInfo: created.record,
      },
      201
    );
  } catch (error) {
    return tokenErrorResponse(error, 'TOKEN_CREATE_FAILED', 400);
  }
}
