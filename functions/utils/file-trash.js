import { changedCount } from './d1-result.js';
import { deriveIndexId, getRecordWithKey, invalidateFileLookup } from './file-record.js';
import { inferStorageType, invalidateFileList, listAllKeys, shouldIncludeKey } from './file-list.js';
import { isD1Enabled, rowToRecord } from './metadata-d1.js';
import { ensureSchema } from './schema.js';
import { purgeByteCache } from './byte-cache.js';

const PAGE_SIZE = 50;

function entry(id, metadata, trashedAt) {
  return {
    id,
    name: metadata.fileName || id,
    size: Number(metadata.fileSize) || 0,
    folderPath: metadata.folderPath || '',
    storage: inferStorageType(id, metadata),
    trashedAt: Number(trashedAt),
  };
}

async function trashDb(env) {
  if (!isD1Enabled(env)) return null;
  const schema = await ensureSchema(env);
  if (!schema.ok) throw new Error('File trash schema unavailable');
  return env.DB;
}

export async function listTrash(env, offset) {
  const db = await trashDb(env);
  const rows = db ? (await db.prepare(
    `SELECT id, kv_key, file_name, file_size, folder_path, storage, trashed_at FROM files
     WHERE trashed_at IS NOT NULL AND is_folder = 0
     ORDER BY trashed_at DESC, COALESCE(kv_key, id) ASC LIMIT ?`
  ).bind(offset + PAGE_SIZE + 1).all()).results || [] : [];
  const files = rows.map(row => entry(row.kv_key || row.id, {
    fileName: row.file_name, fileSize: row.file_size, folderPath: row.folder_path, storage: row.storage,
  }, row.trashed_at));
  const kvFiles = env.img_url?.list ? await listAllKeys(env) : [];
  for (const { name, metadata } of kvFiles) {
    if (metadata?.trashedAt && !(db && metadata.trashMirror)) {
      files.push(entry(name, metadata, metadata.trashedAt));
    }
  }
  files.sort((a, b) => b.trashedAt - a.trashedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const entries = files.slice(offset, offset + PAGE_SIZE);
  return { entries, next: files.length > offset + PAGE_SIZE ? offset + PAGE_SIZE : null };
}

export async function changeTrash(env, { id, action, expected, origin }) {
  const db = await trashDb(env);
  const row = db ? await db.prepare(
    'SELECT * FROM files WHERE id = ? LIMIT 1'
  ).bind(deriveIndexId(id)).first() : null;
  const found = row
    ? { kvKey: row.kv_key || row.id, record: rowToRecord(row), trashedAt: row.trashed_at }
    : await getRecordWithKey(env, id, { includeTrashed: true, skipIndex: true });
  const { kvKey, record } = found;
  if (!record?.metadata || row?.is_folder || (id !== kvKey && id !== deriveIndexId(kvKey))) return { status: 404 };
  const { trashedAt: _marker, ...activeMetadata } = record.metadata;
  if (!shouldIncludeKey({ name: kvKey, metadata: activeMetadata })) return { status: 404 };

  const previous = Number(found.trashedAt) || null;
  const restoring = action === 'restore';
  if (restoring && previous === null) return { status: 200 };
  if (restoring && previous !== expected) return { status: 409 };
  const next = restoring ? null : previous || Date.now();

  const raw = await env.img_url?.getWithMetadata?.(kvKey);
  if (raw?.metadata) {
    const { trashedAt, trashMirror, ...metadata } = raw.metadata;
    if ((Number(trashedAt) || null) !== next) {
      const nextMetadata = restoring ? metadata : { ...metadata, trashedAt: next, ...(row ? { trashMirror: true } : {}) };
      const put = () => env.img_url.put(kvKey, raw.value ?? '', { metadata: nextMetadata });
      try {
        await put();
      } catch (error) {
        if (Number(error?.status) !== 429 && !/429|too many requests/i.test(error?.message || '')) throw error;
        await new Promise(resolve => setTimeout(resolve, 1100));
        await put();
      }
    }
  } else if (!row) {
    return { status: 404 };
  }

  if (row && previous !== next) {
    // 同内容的文件可能已重新上传。恢复原文件时，现有文件保留去重索引。
    const result = await db.prepare(
      `UPDATE files SET trashed_at = ?,
         content_sha = CASE WHEN ? IS NULL AND EXISTS (
           SELECT 1 FROM files AS active WHERE active.content_sha = files.content_sha
            AND active.trashed_at IS NULL AND active.id <> files.id
         ) THEN NULL ELSE content_sha END
       WHERE id = ? AND trashed_at IS ? AND is_folder = 0`
    ).bind(next, next, row.id, previous).run();
    if (!changedCount(result)) return { status: 409 };
  }

  invalidateFileList();
  await Promise.allSettled([
    invalidateFileLookup(env, kvKey),
    purgeByteCache(origin, [kvKey, deriveIndexId(kvKey)]),
    env.img_url?.delete?.('fstat:__index__'),
  ]);

  return {
    status: 200,
    ...(next ? { entry: entry(kvKey, record.metadata, next) } : {}),
  };
}
