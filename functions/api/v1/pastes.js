import { listPastes } from '../../utils/paste-store.js';
import { apiError, apiSuccess, parsePositiveInt } from '../../utils/api-v1.js';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const limit = parsePositiveInt(url.searchParams.get('limit'), {
    defaultValue: 50,
    min: 1,
    max: 200,
  });
  const cursor = parsePositiveInt(url.searchParams.get('cursor'), {
    defaultValue: 0,
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  });

  try {
    const result = await listPastes(context.env, { limit, cursor });
    return apiSuccess({
      pastes: (result.items || []).map((item) => ({
        id: item.id,
        language: item.language,
        createdAt: item.createdAt ? new Date(Number(item.createdAt)).toISOString() : null,
        expiresAt: item.expiresAt ? new Date(Number(item.expiresAt)).toISOString() : null,
        hasPassword: Boolean(item.hasPassword),
        size: Number(item.size || 0),
      })),
      pagination: {
        cursor: result.cursor || null,
        listComplete: Boolean(result.listComplete),
        total: Number(result.total || 0),
      },
    });
  } catch (error) {
    return apiError('PASTES_LIST_FAILED', error.message || 'Failed to list pastes.', 500);
  }
}

export async function onRequest(context) {
  if (context.request.method !== 'GET') {
    return apiError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
  }
  return onRequestGet(context);
}
