import { sanitizeShareText } from '../../utils/share-options.js';
import {
  SHOW_WRITE_LIMIT, showCursor, showFiles, showJson, showKind, showPage, showReady,
} from '../../utils/show.js';

function normalizeTag(value) {
  if (typeof value !== 'string') return '';
  return sanitizeShareText(value.normalize('NFKC').trim().replace(/^#+/, '').replace(/\s+/gu, ' '), 40);
}

const notConfigured = () => showJson({ error: 'Show 需要绑定 D1 数据库（DB）。' }, 503);

export async function onRequestGet({ request, env }) {
  const before = showCursor(request);
  if (Number.isNaN(before)) return showJson({ error: '无效的翻页参数' }, 400);
  if (!await showReady(env)) return notConfigured();
  return showJson(await showPage(env, before, true));
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return showJson({ error: '请求来源无效' }, 403);
  if (!await showReady(env)) return notConfigured();

  let body;
  try {
    body = await request.json();
  } catch {
    return showJson({ error: '无法读取发布请求' }, 400);
  }
  if (body?.action === 'edit' || body?.action === 'remove') {
    const { action, id } = body;
    if (!Number.isSafeInteger(id) || id <= 0) return showJson({ error: '作品编号无效' }, 400);

    if (action === 'remove') {
      await env.DB.prepare('DELETE FROM show_entries WHERE id = ?').bind(id).run();
      return showJson({ ok: true });
    }

    const title = sanitizeShareText(body.title, 120);
    const caption = sanitizeShareText(body.caption, 800);
    const tag = body.tag === undefined ? null : normalizeTag(body.tag);
    const saved = await env.DB.prepare(
      'UPDATE show_entries SET title = ?, caption = ?, tag = COALESCE(?, tag) WHERE id = ? RETURNING tag'
    ).bind(title, caption, tag, id).first();
    return saved ? showJson({ ok: true, title, caption, tag: saved.tag }) : showJson({ error: '作品已移出 Show' }, 404);
  }

  const entries = Array.isArray(body?.entries) ? body.entries
    : Array.isArray(body?.keys) ? body.keys.map(key => ({ key })) : [];
  if (body?.action !== 'publish' || !entries.length || entries.length > SHOW_WRITE_LIMIT ||
      entries.some(entry => typeof entry?.key !== 'string' || !entry.key.trim() || entry.key.length > 512 ||
        (entry.title !== undefined && typeof entry.title !== 'string'))) {
    return showJson({ error: '请选择要发布的图片或视频' }, 400);
  }
  const titles = new Map(entries.map(entry => [entry.key, sanitizeShareText(entry.title, 120)]));
  const keys = [...titles.keys()];
  const tag = normalizeTag(body.tag);
  const files = await showFiles(env, keys);
  const accepted = keys.filter(key => showKind(key, files.get(key)));
  const timestamp = Date.now();
  let added = 0;
  if (accepted.length) {
    const statements = accepted.map(key => env.DB.prepare(
      'INSERT INTO show_entries (file_key, published_at, title, tag) VALUES (?, ?, ?, ?) ON CONFLICT(file_key) DO NOTHING'
    ).bind(key, timestamp, titles.get(key), tag));
    const results = await env.DB.batch(statements);
    added = results.reduce((sum, result) => sum + (result.meta?.changes || 0), 0);
  }
  return showJson({ added, existing: accepted.length - added, rejected: keys.length - accepted.length });
}
