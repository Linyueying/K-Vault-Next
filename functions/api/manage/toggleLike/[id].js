import { getRecordWithKey as findRecordWithKey, deriveIndexId, putKvFileMetadata, registerFileRecord } from '../../../utils/file-record.js';

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

/** D1 是否可用（绑定名 DB）。 */
function isD1Enabled(env) {
  return Boolean(env && env.DB && typeof env.DB.prepare === 'function');
}

export async function onRequest(context) {
  const { params, env } = context;

  if (!env.img_url) {
    return jsonResponse({ success: false, error: 'KV binding img_url is not configured.' }, 500);
  }

  const fileId = decodeFileId(params.id);
  const { record, kvKey } = await getRecordWithKey(env, fileId);

  if (!record?.metadata) {
    return jsonResponse({ success: false, error: `Image metadata not found for ID: ${fileId}` }, 404);
  }

  const metadata = {
    ...record.metadata,
    liked: !Boolean(record.metadata.liked),
  };

  // ---------- 路径 A：D1 ----------
  // 读侧 getRecordWithKey 是 D1 优先，所以这里必须同步写 D1 ——
  // 否则会出现「点赞成功但刷新列表还是未点赞」的静默不一致
  // （与 editName / move-folder 同类的问题）。
  if (isD1Enabled(env)) {
    // 用裸 ID 定位：D1 的 files.id 已剥离存储前缀，kvKey 直接当主键会更新 0 行。
    const id = deriveIndexId(kvKey || fileId);
    // 手里已有完整 metadata，走全字段 upsert（不发生 KV 回读）。
    const res = await registerFileRecord(env, kvKey, metadata, { indexId: id });
    if (res.ok) {
      await putKvFileMetadata(env, kvKey, metadata);
      return jsonResponse({ success: true, liked: metadata.liked, key: kvKey });
    }
    // D1 写失败 → 落到 KV 兜底，不让一次抖动阻断点赞
    console.warn('toggleLike: D1 write failed, falling back to KV:', res.error);
  }

  // ---------- 路径 B：KV 兜底 ----------
  await putKvFileMetadata(env, kvKey, metadata);

  return jsonResponse({ success: true, liked: metadata.liked, key: kvKey });
}
