import { parseSignedTelegramFileId } from '../../utils/telegram.js';
import { getRecordWithKey as findRecordWithKey } from '../../utils/file-record.js';

// 获取文件元数据 API（包括原始文件名）
export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // [[path]] 路由：多层路径会被解析成数组，需要 join 后再解码
  let fileId = params.path ?? params.id;
  if (Array.isArray(fileId)) {
    fileId = fileId.join('/');
  }
  if (!fileId) {
    return jsonResponse({ error: 'Missing file ID' }, 400);
  }
  try {
    fileId = decodeURIComponent(fileId);
  } catch (_) {
    // 解码失败则保留原值
  }

  try {
    const signed = await parseSignedTelegramFileId(fileId, env);
    if (signed) {
      const fileName = signed.fileName || `${signed.fileId}.${signed.fileExtension || 'bin'}`;
      return jsonResponse(
        {
          success: true,
          fileId,
          key: null,
          fileName,
          originalName: signed.fileName || null,
          fileSize: signed.fileSize || 0,
          uploadTime: signed.timestamp || null,
          storageType: 'telegram',
          listType: 'None',
          label: 'None',
          liked: false,
          source: 'signed-link',
        },
        200,
        { 'Cache-Control': 'public, max-age=3600' }
      );
    }

    if (!env.img_url) {
      return jsonResponse({ error: 'KV storage not available' }, 500);
    }

    const { record, kvKey: foundKey } = await findRecordWithKey(env, fileId);

    if (!record || !record.metadata) {
      return jsonResponse(
        {
          error: 'File not found',
          fileId,
          fileName: fileId,
          originalName: null,
        },
        404
      );
    }

    const metadata = record.metadata;
    return jsonResponse(
      {
        success: true,
        fileId,
        key: foundKey,
        fileName: metadata.fileName || fileId,
        originalName: metadata.fileName || null,
        fileSize: metadata.fileSize || 0,
        uploadTime: metadata.TimeStamp || null,
        storageType: metadata.storageType || metadata.storage || 'telegram',
        listType: metadata.ListType || 'None',
        label: metadata.Label || 'None',
        liked: metadata.liked || false,
      },
      200,
      { 'Cache-Control': 'public, max-age=3600' }
    );
  } catch (error) {
    console.error('Error fetching file info:', error);
    return jsonResponse(
      {
        error: 'Internal server error',
        message: error.message,
      },
      500
    );
  }
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      ...extraHeaders,
    },
  });
}