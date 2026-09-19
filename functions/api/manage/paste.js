/**
 * Session-authenticated paste endpoints for the web UI.
 *
 * `/api/v1/paste*` already implements the whole pastebin (create / list / read
 * / delete, with language, expiry and password), but it sits behind an API
 * bearer token. A browser holding an admin session could not reach it at all,
 * so the web UI had no pastebin even though the backend was complete.
 *
 * These routes reuse the very same KV store (`utils/paste-store.js`) and
 * inherit the fail-closed `/api/manage/**` authentication middleware, so no
 * extra token is needed once you are logged into the admin panel.
 *
 * GET  /api/manage/paste?limit=&cursor=  → paginated paste summaries
 * POST /api/manage/paste                 → create a paste
 *
 * @module api/manage/paste
 */
import { createPaste, listPastes } from '../../utils/paste-store.js';

const MAX_CONTENT_BYTES = 1024 * 1024; // 1 MiB, same cap as the v1 API
const MAX_EXPIRES_IN_SECONDS = 365 * 24 * 3600;
const MIN_EXPIRES_IN_SECONDS = 60;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const url = new URL(request.url);
    const limit = Number.parseInt(url.searchParams.get('limit') || '50', 10) || 50;
    const cursor = url.searchParams.get('cursor') || '0';
    const result = await listPastes(env, { limit, cursor });
    return jsonResponse({ ok: true, ...result });
  } catch (error) {
    return jsonResponse({ ok: false, error: error?.message || '读取粘贴列表失败。' }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body = null;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: '请求体必须是 JSON。' }, 400);
  }

  const content = String(body?.content ?? '');
  if (!content.trim()) {
    return jsonResponse({ ok: false, error: '粘贴内容不能为空。' }, 400);
  }

  const size = new TextEncoder().encode(content).byteLength;
  if (size > MAX_CONTENT_BYTES) {
    return jsonResponse({ ok: false, error: '粘贴内容超过 1 MiB 上限。' }, 413);
  }

  const rawExpires = Number(body?.expires_in ?? body?.expiresIn ?? 0);
  let expiresIn = null;
  if (Number.isFinite(rawExpires) && rawExpires > 0) {
    expiresIn = Math.min(Math.max(Math.floor(rawExpires), MIN_EXPIRES_IN_SECONDS), MAX_EXPIRES_IN_SECONDS);
  }

  try {
    const paste = await createPaste(
      {
        content,
        language: body?.language || 'text',
        expiresIn,
        password: String(body?.password || ''),
      },
      env
    );

    return jsonResponse({ ok: true, paste }, 201);
  } catch (error) {
    return jsonResponse({ ok: false, error: error?.message || '创建粘贴失败。' }, 400);
  }
}
