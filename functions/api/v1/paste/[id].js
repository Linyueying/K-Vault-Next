import { deletePasteById, getPasteById } from '../../../utils/paste-store.js';
import { apiError, apiSuccess, decodePathParam } from '../../../utils/api-v1.js';

async function handleGet(context, pasteId) {
  const url = new URL(context.request.url);
  const password =
    url.searchParams.get('password')
    || context.request.headers.get('X-Paste-Password')
    || '';

  const result = await getPasteById(pasteId, context.env, { password });
  if (!result.ok) {
    return apiError(
      result.code || 'PASTE_READ_FAILED',
      result.message || 'Failed to read paste.',
      result.status || 400
    );
  }

  return apiSuccess({
    paste: {
      id: result.paste.id,
      content: result.paste.content,
      language: result.paste.language,
      createdAt: result.paste.createdAt ? new Date(Number(result.paste.createdAt)).toISOString() : null,
      expiresAt: result.paste.expiresAt ? new Date(Number(result.paste.expiresAt)).toISOString() : null,
      hasPassword: Boolean(result.paste.hasPassword),
      size: Number(result.paste.size || 0),
    },
  });
}

async function handleDelete(context, pasteId) {
  const deleted = await deletePasteById(pasteId, context.env);
  if (!deleted) {
    return apiError('PASTE_NOT_FOUND', 'Paste not found.', 404);
  }
  return apiSuccess({
    deleted: true,
    pasteId,
  });
}

export async function onRequest(context) {
  const pasteId = decodePathParam(context.params?.id || '');
  if (!pasteId) {
    return apiError('VALIDATION_ERROR', 'Paste id is required.', 400);
  }

  const method = String(context.request.method || 'GET').toUpperCase();
  if (method === 'GET') {
    return handleGet(context, pasteId);
  }
  if (method === 'DELETE') {
    return handleDelete(context, pasteId);
  }

  return apiError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
}
