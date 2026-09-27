import {
  getRecordWithKey as findRecordWithKey,
  putRecordIndex,
  deriveIndexId,
  STORAGE_PREFIXES as SHARED_STORAGE_PREFIXES,
} from '../../../utils/file-record.js';
import { updateFileMetadataFields, upsertFolderMarker } from '../../../utils/metadata-d1.js';

/** D1 是否可用（绑定名 DB）。 */
function isD1Enabled(env) {
  return Boolean(env && env.DB && typeof env.DB.prepare === 'function');
}

const STORAGE_PREFIXES = SHARED_STORAGE_PREFIXES;

const INVALID_PREFIXES = ['session:', 'chunk:', 'upload:', 'temp:', 'folder:', 'idxt:', 'dlc:'];

function normalizeFolderPath(value = '') {
  const raw = String(value || '').replace(/\\/g, '/').trim();
  const output = [];
  for (const part of raw.split('/')) {
    const piece = part.trim();
    if (!piece || piece === '.') continue;
    if (piece === '..') {
      output.pop();
      continue;
    }
    output.push(piece);
  }
  return output.join('/');
}

function normalizeFileIdentifier(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  return decoded
    .replace(/^https?:\/\/[^/]+\/file\//i, '')
    .replace(/^\/?file\//i, '')
    .trim();
}

function collectMoveIdentifiers(body = {}) {
  const values = [];
  if (Array.isArray(body.ids)) values.push(...body.ids);
  if (Array.isArray(body.files)) {
    for (const file of body.files) {
      if (!file || typeof file !== 'object') continue;
      values.push(
        file.id,
        file.name,
        file.key,
        file.fileId,
        file.metadata?.id,
        file.metadata?.fileId,
        file.metadata?.fileName
      );
    }
  }
  return Array.from(new Set(values.map(normalizeFileIdentifier).filter(Boolean)));
}

async function getRecordWithKey(env, fileId) {
  const normalizedId = normalizeFileIdentifier(fileId);

  // 先走公共的索引加速探测（裸 ID 命中索引时 2 次读直达）
  const located = await findRecordWithKey(env, normalizedId);
  if (located?.record?.metadata) {
    return located;
  }

  // 原有兜底：按 fileName 全量扫描（保留原语义，仅在前述路径未命中时触发）
  let cursor = undefined;
  let matched = null;
  let matchCount = 0;
  let guard = 0;
  do {
    const page = await env.img_url.list({ limit: 1000, cursor });
    for (const key of page.keys || []) {
      if (!key?.name || INVALID_PREFIXES.some((prefix) => key.name.startsWith(prefix))) continue;
      const metadata = key.metadata || {};
      if (metadata.folderMarker === true) continue;
      if (String(metadata.fileName || '').trim() !== normalizedId) continue;
      matched = key;
      matchCount += 1;
      if (matchCount > 1) break;
    }
    if (matchCount > 1) break;
    cursor = page.list_complete ? undefined : page.cursor;
    guard += 1;
  } while (cursor && guard < 10000);

  if (matchCount === 1 && matched?.name) {
    const record = await env.img_url.getWithMetadata(matched.name);
    if (record?.metadata) {
      // metadata 刚读出来就在手边，直接交给 D1，省掉登记时的二次回读
      await putRecordIndex(env, matched.name, { metadata: record.metadata });
      return { record, kvKey: matched.name };
    }
  }

  return { record: null, kvKey: normalizedId };
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.img_url && !isD1Enabled(env)) {
    return jsonResponse({ success: false, error: 'Storage not configured (need img_url or DB).' }, 500);
  }

  const body = await request.json().catch(() => ({}));
  const ids = collectMoveIdentifiers(body);
  const targetFolderPath = normalizeFolderPath(body.targetFolderPath || body.folderPath || body.path || '');

  if (ids.length === 0) {
    return jsonResponse({ success: false, error: '缺少要移动的文件 ID。' }, 400);
  }

  let moved = 0;
  const notFound = [];

  for (const id of ids) {
    const { record, kvKey } = await getRecordWithKey(env, id);
    if (!record?.metadata) {
      notFound.push(id);
      continue;
    }

    const metadata = {
      ...(record.metadata || {}),
      folderPath: targetFolderPath,
    };

    // ---------- 路径 A：D1 ----------
    // 与 editName 同一个 bug：读侧 D1 优先，写侧却只写 KV，
    // 结果是"移动成功但刷新后文件还在原目录"。
    // 用裸 ID 定位（D1 的 files.id 已剥离存储前缀）。
    let handledByD1 = false;
    if (isD1Enabled(env)) {
      const bareId = deriveIndexId(kvKey || id);
      const res = await updateFileMetadataFields(env, bareId, { folderPath: targetFolderPath });
      if (res.ok && res.updated > 0) {
        handledByD1 = true;
        moved += 1;
      }
    }

    // ---------- 路径 B：KV ----------
    // D1 未绑定、或该记录只在 KV 里（D1 写入失败过的存量）时才写 KV。
    if (!handledByD1 && env?.img_url?.put) {
      await env.img_url.put(kvKey, '', { metadata });
      moved += 1;
      continue;
    }

    // D1 成功了、且 KV 也绑定时保持双写（P3 停写后去掉）
    if (handledByD1 && env?.img_url?.put) {
      await env.img_url.put(kvKey, '', { metadata }).catch(() => {});
    }
  }

  if (moved === 0) {
    return jsonResponse({
      success: false,
      error: '没有找到可移动的文件，目录未变更。请刷新文件列表后重试。',
      targetFolderPath,
      requested: ids.length,
      moved,
      notFound,
    }, 404);
  }

  if (targetFolderPath) {
    // 目录标记：D1 优先（folderMarkerId + upsertFolderMarker），
    // 未绑定时才写 KV 的 `folder:<path>` 键。
    let markedByD1 = false;
    if (isD1Enabled(env)) {
      const res = await upsertFolderMarker(env, targetFolderPath);
      markedByD1 = res.ok === true;
    }
    if (!markedByD1 && env?.img_url?.put) {
      await env.img_url.put(`folder:${targetFolderPath}`, '', {
        metadata: {
          folderMarker: true,
          folderPath: targetFolderPath,
          TimeStamp: Date.now(),
        },
      });
    }
  }

  return jsonResponse({
    success: true,
    targetFolderPath,
    requested: ids.length,
    moved,
    notFound,
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
