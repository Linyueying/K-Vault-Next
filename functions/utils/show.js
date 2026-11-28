import { deriveIndexId } from './file-record.js';
import { inferFileType } from './file-type.js';
import { isD1Enabled, rowToRecord } from './metadata-d1.js';
import { ensureSchema } from './schema.js';

export const SHOW_WRITE_LIMIT = 24;
const PAGE_SIZE = 12;

export function showJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function showReady(env) {
  if (!isD1Enabled(env)) return false;
  return (await ensureSchema(env)).ok;
}

export function showCursor(request) {
  const raw = new URL(request.url).searchParams.get('before');
  if (raw === null) return null;
  return /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) > 0 ? Number(raw) : NaN;
}

export function showKind(key, metadata) {
  if (!metadata || metadata.folderMarker || key.startsWith('folder:')) return null;
  if (!['none', 'white', 'whitelist'].includes(String(metadata.ListType || 'None').toLowerCase())) return null;
  if (metadata.sharePasswordHash || Number(metadata.shareExpiresAt) > 0 || Number(metadata.shareMaxDownloads) > 0) return null;
  if (/\.svgz?$/i.test(key) || /\.svgz?$/i.test(metadata.fileName || '') || /svg/i.test(metadata.mime || '')) return null;
  const kind = inferFileType(key, metadata);
  return kind === 'image' || kind === 'video' ? kind : null;
}

// Prefer the current file index. Old records that exist only in KV are looked up by exact key.
export async function showFiles(env, keys) {
  if (!keys.length) return new Map();
  const ids = [...new Set(keys.map(key => deriveIndexId(key)))];
  const { results = [] } = await env.DB.prepare(
    `SELECT * FROM files WHERE id IN (${ids.map(() => '?').join(',')})`
  ).bind(...ids).all();
  const index = new Map(results.map(row => [row.id, row]));
  return new Map(await Promise.all(keys.map(async key => {
    const row = index.get(deriveIndexId(key));
    if (row) {
      return [key, !row.is_folder && !row.trashed_at && (row.kv_key || row.id) === key ? rowToRecord(row).metadata : null];
    }
    const legacy = await env.img_url?.getWithMetadata(key);
    return [key, legacy?.metadata?.trashedAt ? null : legacy?.metadata || null];
  })));
}

export async function showPage(env, before, admin = false, pageSize = PAGE_SIZE) {
  const limit = Number.isInteger(pageSize) && pageSize >= 6 && pageSize <= 36 ? pageSize : PAGE_SIZE;
  const { results = [] } = await env.DB.prepare(
    `SELECT id, file_key, published_at, title, caption, tag FROM show_entries
     ${before ? 'WHERE id < ?' : ''} ORDER BY id DESC LIMIT ?`
  ).bind(...(before ? [before] : []), limit + 1).all();
  const page = results.slice(0, limit);
  const files = await showFiles(env, page.map(row => row.file_key));
  const items = page.flatMap(row => {
    const metadata = files.get(row.file_key);
    const kind = showKind(row.file_key, metadata);
    if (!admin && !kind) return [];

    const fileName = metadata?.fileName || row.file_key;
    return [{
      id: row.id,
      kind,
      title: row.title || fileName.replace(/\.[^.]+$/, ''),
      caption: row.caption,
      tag: row.tag,
      publishedAt: row.published_at,
      ...(kind ? { src: '/file/' + encodeURIComponent(row.file_key), fileName } : {}),
      ...(admin ? { fileKey: row.file_key, fileName, customTitle: row.title } : {}),
    }];
  });
  return { items, next: results.length > limit ? page.at(-1).id : null };
}
