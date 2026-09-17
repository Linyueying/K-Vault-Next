import { apiSuccess } from '../../utils/api-v1.js';

/**
 * GET /api/v1/me (requirement #4) — Token introspection for any valid token.
 * Never returns tokenHash, tokenSalt or the full secret.
 */
export async function onRequestGet(context) {
  const token = context.data?.apiToken;
  if (!token) {
    // Middleware guarantees this; defensive fallback.
    return new Response(JSON.stringify({
      success: false,
      error: { code: 'TOKEN_INVALID', message: 'API Token is invalid.' },
    }), { status: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  return apiSuccess({
    data: {
      token: {
        id: token.id,
        name: token.name,
        scopes: [...(token.scopes || [])],
        expiresAt: token.expiresAt ?? null,
        enabled: Boolean(token.enabled),
        policies: token.policies ? { ...token.policies } : null,
        createdAt: token.createdAt ?? null,
        lastUsedAt: token.lastUsedAt ?? null,
      },
    },
  });
}
