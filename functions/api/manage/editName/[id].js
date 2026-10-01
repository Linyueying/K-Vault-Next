import { getRecordWithKey as findRecordWithKey, deriveIndexId, putKvFileMetadata, registerFileRecord } from '../../../utils/file-record.js';
import { updateFileMetadataFields } from '../../../utils/metadata-d1.js';

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
  const { request, params, env } = context;

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

  // ---------- 路径 A：D1 ----------
  // 读侧 getRecordWithKey 是 D1 优先，所以这里必须同步写 D1。
  // 此前只写 KV，导致 D1 接管读侧后"改名成功但列表还是旧名字"。
  if (isD1Enabled(env)) {
    // 用**裸 ID** 定位：D1 的 files.id 是剥离存储前缀后的值。
    // kvKey 形如 `r2:photo.png`，直接当主键会更新 0 行且不报错。
    const id = deriveIndexId(kvKey || fileId);
    const res = await updateFileMetadataFields(env, id, { fileName: requestedName });
    if (res.ok && res.updated > 0) {
      // 同步 KV（若绑定了）：受「存储回滚模式」开关控制，
      // 关闭后 KV 不再是数据源，D1 就是唯一事实。
      await putKvFileMetadata(env, kvKey, metadata);
      return jsonResponse({ success: true, fileName: metadata.fileName, key: kvKey });
    }
    /* updated === 0：D1 里没有这一行。
       典型来源是 D1 引入**之前**上传的历史文件 —— 记录只在 KV，
       files 表里从来没有它。此时**不能**直接报 404：
         1. 用户明明在列表里看得见这个文件（列表走 KV 兜底），
            报「找不到」纯粹是自相矛盾；
         2. 「点赞」走的是 registerFileRecord（UPSERT），遇到同样情况
            会补插一行照常成功 —— 两个接口行为不一致本身就是 bug。
       这里与 toggleLike 对齐：手里已有完整 metadata，直接补插，
       顺带把这条历史记录纳入 D1 管辖（下次就是 UPDATE 快路径了）。 */
    if (res.ok && res.updated === 0) {
      const upsert = await registerFileRecord(env, kvKey, metadata, { indexId: id });
      if (upsert.ok) {
        await putKvFileMetadata(env, kvKey, metadata);
        return jsonResponse({ success: true, fileName: metadata.fileName, key: kvKey });
      }
      // 补插也失败 → 落到 KV 兜底，不让一次 D1 抖动阻断改名
      console.warn('editName: D1 backfill failed, falling back to KV:', upsert.error);
    }
    // 更新失败 → 落到 KV 兜底，不让一次 D1 抖动阻断改名
  }

  // ---------- 路径 B：KV 兜底 ----------
  if (!env?.img_url) {
    return jsonResponse({ success: false, error: 'Storage not configured.' }, 500);
  }

  await putKvFileMetadata(env, kvKey, metadata);

  return jsonResponse({ success: true, fileName: metadata.fileName, key: kvKey });
}
