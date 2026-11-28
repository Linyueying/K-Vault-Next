import { onRequest as serveFileInternal } from '../../../file/[[path]].js';
import { onRequest as deleteFileInternal } from '../../manage/delete/[id].js';
import { apiError, apiSuccess, decodePathParam } from '../../../utils/api-v1.js';

/**
 * 把 params 中的 path / id 统一解析成单个字符串 ID。
 * [[path]] 路由下，params.path 可能是数组（多层路径），需要 join 后再解码。
 */
function resolveFileId(params) {
  const raw = params?.path ?? params?.id;
  const joined = Array.isArray(raw) ? raw.join('/') : (raw || '');
  return decodePathParam(joined);
}

async function handleRead(context) {
  const id = resolveFileId(context.params);
  if (!id) {
    return apiError('VALIDATION_ERROR', 'File id is required.', 400);
  }

  const response = await serveFileInternal({
    ...context,
    params: {
      ...(context.params || {}),
      path: id, // 新参数名（serveFileInternal 读这个）
      id,       // 兼容旧参数名
    },
  });

  if (response.status >= 400) {
    let message = 'Failed to read file.';
    try {
      const text = await response.clone().text();
      if (text) {
        message = text;
      }
    } catch {
      // keep fallback
    }

    if (response.status === 404) {
      return apiError('FILE_NOT_FOUND', 'File not found.', 404);
    }
    if (response.status === 401) {
      return apiError('FILE_PASSWORD_REQUIRED', message, 401);
    }
    if (response.status === 403) {
      return apiError('FILE_ACCESS_DENIED', message, 403);
    }
    if (response.status === 410) {
      return apiError('FILE_LINK_EXPIRED', message, 410);
    }
    return apiError('FILE_READ_FAILED', message, response.status || 500);
  }

  return response;
}

async function handleDelete(context) {
  const id = resolveFileId(context.params);
  if (!id) {
    return apiError('VALIDATION_ERROR', 'File id is required.', 400);
  }

  const response = await deleteFileInternal({
    ...context,
    params: {
      ...(context.params || {}),
      path: id, // 兼容两种写法
      id,
    },
  });

  let payload = null;
  try {
    payload = await response.clone().json();
  } catch {
    payload = null;
  }

  if (!response.ok || !payload?.success) {
    if (response.status === 404) {
      return apiError('FILE_NOT_FOUND', 'File not found.', 404);
    }

    return apiError(
      'FILE_DELETE_FAILED',
      payload?.error || 'Failed to delete file.',
      response.status || 500
    );
  }

  return apiSuccess({
    deleted: true,
    fileId: id,
    message: payload?.message || 'File deleted.',
  });
}

export async function onRequest(context) {
  const method = String(context.request.method || 'GET').toUpperCase();

  if (method === 'GET') {
    return handleRead(context);
  }

  if (method === 'DELETE') {
    return handleDelete(context);
  }

  return apiError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
}