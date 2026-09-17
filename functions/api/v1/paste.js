import { createPaste } from '../../utils/paste-store.js';
import { apiError, apiSuccess, buildAbsoluteUrl, parsePositiveInt } from '../../utils/api-v1.js';

export async function onRequestPost(context) {
  let body = {};
  try {
    body = await context.request.json();
  } catch {
    body = {};
  }

  const content = String(body?.content || '');
  const language = String(body?.language || 'text');
  const expiresIn = parsePositiveInt(body?.expires_in ?? body?.expiresIn, { defaultValue: 0, min: 1, max: 3650 * 24 * 3600 });
  const password = String(body?.password || '');

  if (!content.trim()) {
    return apiError('VALIDATION_ERROR', 'Field "content" is required.', 400);
  }

  try {
    const paste = await createPaste(
      {
        content,
        language,
        expiresIn: expiresIn > 0 ? expiresIn : null,
        password,
      },
      context.env
    );

    return apiSuccess(
      {
        paste: {
          id: paste.id,
          language: paste.language,
          createdAt: new Date(Number(paste.createdAt || Date.now())).toISOString(),
          expiresAt: paste.expiresAt ? new Date(Number(paste.expiresAt)).toISOString() : null,
          hasPassword: paste.hasPassword,
        },
        links: {
          view: buildAbsoluteUrl(context.request, `/api/v1/paste/${encodeURIComponent(paste.id)}`),
          raw: buildAbsoluteUrl(context.request, `/api/v1/paste/${encodeURIComponent(paste.id)}`),
        },
      },
      201
    );
  } catch (error) {
    return apiError('PASTE_CREATE_FAILED', error.message || 'Failed to create paste.', 400);
  }
}

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return apiError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
  }
  return onRequestPost(context);
}
