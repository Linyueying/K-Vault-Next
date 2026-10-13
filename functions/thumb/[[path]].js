/**
 * GET /thumb/<fileKey> —— 图片缩略图读取端点
 *
 * ================================================================
 * 【为什么是一个独立端点，而不是 /file/<key>?thumb=1】
 * `file/[[path]].js` 里叠了下载计次、分享配额、密码校验、合集闸门、
 * Range 断点、HEAD 收敛等一整串逻辑，且它的取对象 handler 全是模块私有、
 * 无法复用。缩略图需要的是「零副作用的静态小图」，把自己塞进那条链路
 * 既会误触发计数，也会让两件事的边界糊掉。
 *
 * ================================================================
 * 【回退语义：这是本端点的核心】
 * 除了「有缩略图且文件可公开访问」这一种情况，**其余一律 302 到 /file/<key>**：
 *   · 老文件还没有缩略图            → 302，行为与接入本功能前完全一致
 *   · 文件带分享密码 / 限次         → 302，把鉴权交还给 /file/ 原本的实现
 *   · 目标文件不存在 / 存储读失败   → 302，由 /file/ 给出它该给的 404
 *
 * 因此前端**不需要写 @error 回退**，只要把 src 换成 /thumb/<key> 即可；
 * 而 `?password=...` 之类的 query 会原样透传，分享页无需特殊处理。
 */

import { getRecordWithKey } from '../utils/file-record.js';
import { getThumb, parseFileKey } from '../utils/thumb-store.js';
import { checkAuthentication, isAuthRequired } from '../utils/auth.js';

export async function onRequest(context) {
  const method = String(context?.request?.method || 'GET').toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Range, Accept, Origin',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'GET, HEAD, OPTIONS' },
    });
  }

  return handle(context, method === 'HEAD');
}

/**
 * @param {any} context - Pages 请求上下文
 * @param {boolean} headOnly
 */
async function handle(context, headOnly) {
  const { request, env } = context;
  const key = parseFileKey(context.params);

  // key 解析不出来、或站点没绑 KV（缩略图无处可存）→ 直接交还原文件路径。
  if (!key || !env?.img_url?.get) return fallbackToFile(request, key);

  const thumb = await getThumb(env, key);
  if (!thumb) return fallbackToFile(request, key);

  // 命中缩略图后，还要确认这个文件「是否可公开访问」——
  // 否则分享密码 / 限次就被一张缩略图绕过去了。
  const metadata = await readMetadata(env, key);
  const guarded = isShareGuarded(metadata);

  if (guarded) {
    // 只有受保护文件才付一次会话校验的代价；绝大多数文件走不到这里。
    const isAdmin = isAuthRequired(env) && (await isAdminRequest(context));
    if (!isAdmin) return fallbackToFile(request, key);
  }

  const headers = new Headers();
  headers.set('Content-Type', thumb.contentType || 'image/webp');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('X-Thumbnail', '1');
  // 受保护文件的缩略图只对管理员可见，**必须**禁止任何共享缓存，
  // 否则边缘缓存会把管理员看到的那张小图喂给匿名访客。
  headers.set(
    'Cache-Control',
    guarded ? 'private, no-store, max-age=0' : 'public, max-age=31536000, immutable'
  );
  if (guarded) headers.set('CDN-Cache-Control', 'no-store');

  return new Response(headOnly ? null : thumb.body, { status: 200, headers });
}

/** 取文件元数据；失败不抛出（读不到就当"没有保护"，因为此时缩略图本身也在被否决的边缘） */
async function readMetadata(env, key) {
  try {
    const { record } = await getRecordWithKey(env, key);
    return record?.metadata || null;
  } catch (error) {
    console.warn('thumb: read metadata failed:', error?.message || error);
    return null;
  }
}

/**
 * 文件是否受「访问保护」。
 *
 * 只认**密码**与**下载次数上限**两条：它们决定"谁/几次能看到内容"，
 * 缩略图作为内容的可视摘要，必须一并受约束。
 *
 * 刻意**不**把过期时间算进来：过了期的只是分享链接失效，文件本身仍在，
 * 管理端列表照常展示，此时给缩略图不会泄露任何本该隐藏的东西。
 *
 * @param {any} metadata
 */
function isShareGuarded(metadata) {
  if (!metadata || typeof metadata !== 'object') return false;
  if (metadata.sharePasswordHash) return true;
  if (Number(metadata.shareMaxDownloads || 0) > 0) return true;
  return false;
}

async function isAdminRequest(context) {
  try {
    const result = await checkAuthentication(context);
    return Boolean(result?.authenticated);
  } catch {
    return false;
  }
}

/**
 * 回退到原文件直链，并**原样透传 query**（`password` / `dl` 等）。
 * /file/ 会用自己的鉴权与错误语义处理这次请求。
 */
function fallbackToFile(request, key) {
  const url = new URL(request.url);
  const target = new URL(`/file/${encodeURI(String(key || ''))}`, url.origin);
  target.search = url.search;
  return Response.redirect(target.toString(), 302);
}
