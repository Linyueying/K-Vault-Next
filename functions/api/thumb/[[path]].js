/**
 * PUT /api/thumb/<fileKey> —— 上传一张缩略图
 *
 * ================================================================
 * 【为什么是「上传完成后再单独 PUT」，而不是随上传表单一起提交】
 * 上传有两条**完全独立**的落库路径：直传（functions/upload.js）与
 * 分片（functions/api/chunked-upload/complete.js）。把缩略图塞进表单意味着
 * 两条路径都要改，而分片那条根本没有「附带一份小文件」的位置。
 *
 * 统一成「前端拿到 fileKey 后再 PUT 一次」之后：
 *   · upload.js / complete.js **零改动**
 *   · 两条路径共用同一段写入代码
 *   · 顺带获得「给任意已有文件补缩略图」的能力（重建入口可直接复用本端点）
 *
 * 代价是多一次请求；因为缩略图失败不影响主上传（前端只告警），可接受。
 */

import { getRecordWithKey } from '../../utils/file-record.js';
import { putThumb, parseFileKey, THUMB_MAX_BYTES } from '../../utils/thumb-store.js';
import { getThumbConfig } from '../../utils/runtime-config.js';

export async function onRequest(context) {
  const { request, env } = context;
  const method = String(request.method || '').toUpperCase();

  if (method !== 'PUT' && method !== 'POST') {
    return json({ error: 'Method Not Allowed' }, 405, { Allow: 'PUT, POST, OPTIONS' });
  }

  const key = parseFileKey(context.params);
  if (!key) return json({ error: '缺少文件 key' }, 400);

  const config = await getThumbConfig(env);
  if (config && config.enabled === false) {
    // 关闭时对外表现成"这个端点不存在"，与 /mcp 的 fail-closed 同构。
    return json({ error: 'THUMBNAIL_DISABLED' }, 404);
  }

  const contentType = String(request.headers.get('Content-Type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (!contentType.startsWith('image/')) {
    return json({ error: '缩略图必须是图片类型。' }, 415);
  }

  let buffer;
  try {
    buffer = await request.arrayBuffer();
  } catch {
    return json({ error: '读取请求体失败。' }, 400);
  }
  if (!buffer || buffer.byteLength === 0) return json({ error: '缩略图内容为空。' }, 400);
  if (buffer.byteLength > THUMB_MAX_BYTES) {
    return json({ error: '缩略图体积超出上限。' }, 413);
  }

  // 缩略图必须挂在一个**真实存在**的文件上，否则任何人都能拿任意 key
  // 往 KV / R2 里堆垃圾对象（这正是本端点不接受匿名写入的原因之一）。
  const { record } = await getRecordWithKey(env, key);
  if (!record?.metadata) return json({ error: '目标文件不存在。' }, 404);

  const result = await putThumb(env, key, buffer, { contentType });
  if (!result.ok) {
    return json({ error: '缩略图写入失败。', reason: result.reason }, result.reason === 'no-backend' ? 503 : 500);
  }

  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

function json(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}
