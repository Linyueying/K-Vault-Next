import { getRecordWithKey as findRecordWithKey } from '../../../utils/file-record.js';

function decodeFileId(raw) {
  try {
    return decodeURIComponent(raw || '');
  } catch {
    return String(raw || '');
  }
}

// 记录定位统一走 utils/file-record.js（索引加速，行为与原有本地实现一致）
function getRecordWithKey(env, fileId) {
  return findRecordWithKey(env, fileId);
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequest(context) {
  const { request, params, env } = context;

  if (!env.img_url) {
    return jsonResponse({ success: false, error: 'KV binding img_url is not configured.' }, 500);
  }

  const url = new URL(request.url);
  const requestedName = (url.searchParams.get('newName') || params.name || '').trim();

  if (!requestedName) {
    return jsonResponse({ success: false, error: 'newName is required.' }, 400);
  }

  if (requestedName.length > 180) {
    return jsonResponse({ success: false, error: 'newName is too long.' }, 400);
  }

  const fileId = decodeFileId(params.id);
  const { record, kvKey } = await getRecordWithKey(env, fileId);

  if (!record?.metadata) {
    return jsonResponse({ success: false, error: `Image metadata not found for ID: ${fileId}` }, 404);
  }

  const metadata = {
    ...record.metadata,
    fileName: requestedName,
  };

  await env.img_url.put(kvKey, '', { metadata });

  return jsonResponse({ success: true, fileName: metadata.fileName, key: kvKey });
}
