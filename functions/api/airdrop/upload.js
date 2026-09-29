/**
 * 隔空投送 —— 发端上传文件到中转节点
 * POST /api/airdrop/upload?code=XXXXXXXX&token=...
 *
 * 两种来源：
 *   1. 本地选取  multipart/form-data，字段 file
 *   2. 云端选取  JSON { source: 'cloud', url, fileName }
 *      url 只允许本站 /file/ 直链：既是为了防 SSRF（不允许拿任意外网 URL
 *      把 Workers 变成代理），也因为"云端选取"的语义本来就是选自己网盘里
 *      已经传过的文件。
 *
 * 上传完成后房间进入 uploaded，收端轮询到这个状态就开始自动下载。
 */
import {
  getSession,
  roleOf,
  markUploading,
  markUploaded,
  markFailed,
  writeTempFile,
  effectiveMaxBytes,
  isGuestRequest,
  recordStat,
  jsonResponse
} from '../../utils/airdrop.js';

const CLOSED_STATUSES = ['cancelled', 'expired', 'failed'];

export async function onRequestPost(context) {
  const { request, env } = context;
  const params = new URL(request.url).searchParams;
  const code = String(params.get('code') || '').trim().toUpperCase();
  const token = String(params.get('token') || '').trim();

  if (!code || !token) {
    return jsonResponse({ error: '缺少 code 或 token。', code: 'BAD_PARAMS' }, 400);
  }

  const session = await getSession(env, code);
  if (!session) {
    return jsonResponse({ error: '房间不存在或已过期。', code: 'EXPIRED' }, 404);
  }
  if (roleOf(session, token) !== 'sender') {
    return jsonResponse({ error: '只有发送方可以上传文件。', code: 'FORBIDDEN' }, 403);
  }
  if (session.status === 'uploaded' || session.status === 'done') {
    return jsonResponse({ error: '本次投递已经发送过文件。', code: 'ALREADY_SENT' }, 409);
  }
  if (CLOSED_STATUSES.includes(session.status)) {
    return jsonResponse({ error: '房间已结束。', code: 'CLOSED' }, 409);
  }

  const limit = await effectiveMaxBytes(env);
  if (!limit.backend) {
    return jsonResponse({ error: '没有可用的中转节点。', code: 'NO_STORAGE' }, 503);
  }

  const contentType = String(request.headers.get('content-type') || '');
  let payload;
  try {
    payload = contentType.includes('application/json')
      ? await readCloudSource(request, env, limit.maxBytes)
      : await readLocalSource(request, limit.maxBytes);
  } catch (e) {
    if (e && e.code === 'FILE_TOO_LARGE') return tooLarge(limit);
    return jsonResponse({ error: e?.message || '读取文件失败。', code: 'READ_FAILED' }, 400);
  }

  // 让收端立刻看到"对方正在发送"，而不是等到文件落地才有反馈
  await markUploading(env, code, payload.fileName, payload.fileSize, payload.fileType);

  try {
    const written = await writeTempFile(env, session, limit.backend, payload.fileName, payload.body, payload.fileSize);
    await markUploaded(env, code, limit.backend, written.key, written.meta);

    // 在发端这一侧记统计：只有此刻才同时知道"是谁发起的"和"传了多大"
    await recordStat(env, {
      code,
      role: 'sender',
      isGuest: await isGuestRequest(request, env),
      fileName: payload.fileName,
      fileSize: payload.fileSize,
      outcome: 'uploaded'
    });
  } catch (e) {
    await markFailed(env, code, e?.message || '上传到中转节点失败');
    return jsonResponse(
      { error: e?.message || '上传到中转节点失败。', code: 'STORE_FAILED' },
      500
    );
  }

  return jsonResponse({
    ok: true,
    fileName: payload.fileName,
    fileSize: payload.fileSize,
    backend: limit.backend
  });
}

/** 本地选取：读 multipart 表单 */
async function readLocalSource(request, maxBytes) {
  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') {
    const err = new Error('缺少文件字段。');
    err.code = 'NO_FILE';
    throw err;
  }
  // Content-Length 是整包大小（含表单开销），比文件本身略大，用它做
  // 快速失败足够保守：宁可误拒一个贴边的大文件，也不要让超大请求进 Worker。
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared && declared > maxBytes + 1024) throw tooLargeError();
  const size = Number(file.size) || 0;
  if (size && size > maxBytes) throw tooLargeError();

  return {
    fileName: String(file.name || 'airdrop-file'),
    fileSize: size,
    fileType: file.type || null,
    // File 是 Blob 子类，R2 能直接吃；KV 路径在 writeTempFile 里转 ArrayBuffer
    body: file
  };
}

/** 云端选取：从本站直链把文件拉回中转节点 */
async function readCloudSource(request, env, maxBytes) {
  const body = await request.json();
  if (body?.source !== 'cloud') {
    const err = new Error('不支持的来源类型。');
    err.code = 'BAD_SOURCE';
    throw err;
  }

  const selfOrigin = new URL(request.url).origin;
  const target = new URL(String(body.url || ''), selfOrigin);
  if (target.origin !== selfOrigin || !target.pathname.startsWith('/file/')) {
    throw new Error('只能选取本站已上传的文件。');
  }

  const upstream = await fetch(target.toString(), { redirect: 'follow' });
  if (!upstream.ok || !upstream.body) {
    throw new Error('读取云端文件失败，请确认文件仍然存在。');
  }

  const size = Number(upstream.headers.get('content-length') || 0);
  if (size && size > maxBytes) throw tooLargeError();

  return {
    fileName: String(body.fileName || decodeURIComponent(target.pathname.split('/').pop() || 'airdrop-file')),
    fileSize: size,
    fileType: upstream.headers.get('content-type') || null,
    body: upstream.body
  };
}

function tooLargeError() {
  const err = new Error('文件超出中转节点上限。');
  err.code = 'FILE_TOO_LARGE';
  return err;
}

function tooLarge(limit) {
  return jsonResponse({
    error: `文件超出中转节点上限：当前「${limit.label}」单文件最大 ${Math.floor(limit.maxBytes / 1024 / 1024)} MB。`,
    code: 'FILE_TOO_LARGE',
    maxBytes: limit.maxBytes
  }, 413);
}
