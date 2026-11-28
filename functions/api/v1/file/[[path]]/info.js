import { onRequest as fileInfoInternal } from '../../../file-info/[[path]].js';
import { apiError, apiSuccess, decodePathParam } from '../../../../utils/api-v1.js';

function mapFileInfo(payload = {}) {
  const fileName = payload.fileName || payload.originalName || payload.fileId || '';
  return {
    id: payload.key || payload.fileId || '',
    name: fileName,
    size: Number(payload.fileSize || 0),
    type: payload.contentType || '',
    storage: payload.storageType || 'telegram',
    uploadedAt: payload.uploadTime ? new Date(Number(payload.uploadTime)).toISOString() : null,
    raw: payload,
  };
}

function resolveFileId(params) {
  const raw = params?.path ?? params?.id;
  const joined = Array.isArray(raw) ? raw.join('/') : (raw || '');
  return decodePathParam(joined);
}

export async function onRequest(context) {
  if (context.request.method !== 'GET') {
    return apiError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
  }

  const id = resolveFileId(context.params);
  if (!id) {
    return apiError('VALIDATION_ERROR', 'File id is required.', 400);
  }

  const response = await fileInfoInternal({
    ...context,
    params: {
      ...(context.params || {}),
      path: id,
      id,
    },
  });

  let payload = null;
  try {
    payload = await response.clone().json();
  } catch {
    payload = null;
  }

  if (!response.ok || payload?.success === false || payload?.error) {
    if (response.status === 404) {
      return apiError('FILE_NOT_FOUND', 'File not found.', 404);
    }
    return apiError(
      'FILE_INFO_FAILED',
      payload?.message || payload?.error || 'Failed to get file info.',
      response.status || 500
    );
  }

  return apiSuccess({
    file: mapFileInfo(payload || {}),
  });
}