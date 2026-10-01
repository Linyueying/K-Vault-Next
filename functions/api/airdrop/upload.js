/**
 * 隔空投送 —— 发端上传单个文件到中转节点
 * POST /api/airdrop/upload?code=XXXXXXXX&token=...&node=r2&final=0
 *
 * 两种来源：
 *   1. 本地选取  multipart/form-data，字段 file
 *   2. 云端选取  JSON { source: 'cloud', url, fileName }
 *      url 只允许本站 /file/ 直链：既是为了防 SSRF（不允许拿任意外网 URL
 *      把 Workers 变成代理），也因为"云端选取"的语义本来就是选自己网盘里
 *      已经传过的文件。
 *
 * 节点由发端在界面上选（node 参数），后端只校验它是否可用、文件是否超限。
 * 一个房间可以传多个文件：发端逐文件调用本接口，最后一个带 final=1，
 * 房间从 uploading 翻到 uploaded，收端才开始逐文件下载。
 *
 * 门禁用 checkAirdropAccess（发端语义）：上传是写路径，访客发起权、每日
 * 次数必须在这里再校验一次，不能只依赖 create 时的那一次。
 */
import {
  checkAirdropAccess,
  getSession,
  roleOf,
  nodeInfo,
  writeTempFile,
  addManifestFile,
  parseManifest,
  markFailed,
  isGuestRequest,
  recordStat,
  jsonResponse
} from '../../utils/airdrop.js';
import { getClientIp, fixedWindowRateLimit } from '../../utils/ratelimit.js';

const CLOSED_STATUSES = ['cancelled', 'expired', 'failed'];

export async function onRequestPost(context) {
  const { request, env } = context;
  const params = new URL(request.url).searchParams;
  const code = String(params.get('code') || '').trim().toUpperCase();
  const token = String(params.get('token') || '').trim();
  const node = String(params.get('node') || '').trim();
  const isFinal = params.get('final') === '1' || params.get('final') === 'true';

  if (!code || !token) {
    return jsonResponse({ error: '缺少 code 或 token。', code: 'BAD_PARAMS' }, 400);
  }

  // 限流：这是**写中转节点**的路径，一次请求会真实占用 R2 / Telegram 空间。
  // 单房间虽受 5 分钟 TTL 与单文件上限约束，但并发/高频上传仍可短时间灌满，
  // 且失败路径也要查 D1。60 次/分钟对正常批量选取足够宽松。
  const rl = await fixedWindowRateLimit({
    env,
    key: getClientIp(request),
    namespace: 'airdrop-upload',
    windowMs: 60 * 1000,
    max: 60
  });
  if (!rl.allowed) {
    return jsonResponse(
      { error: '上传请求过于频繁，请稍后再试。', code: 'RATE_LIMITED' },
      429,
      { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) }
    );
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

  // 纵深防御：上传是"写"路径，必须再过一次发端门禁（总开关 / 节点 /
  // 访客发起权 / 每日次数）。正常情况下持发端凭证的人必然是 create 时
  // 通过门禁拿到的 token，这一步不会拦到任何人；但"只有 create 拦过一次"
  // 不足以防住「token 被转发给未获授权者后由其代传」——
  // 上传方是不是访客、当日额度还剩多少，只有在真正落地的这一刻才算得准。
  const gate = await checkAirdropAccess(request, env);
  if (!gate.allowed) {
    return jsonResponse(
      { error: gate.reason, code: gate.code, requireLogin: gate.status === 401 },
      gate.status
    );
  }

  // 节点可用性 + 上限：发端选的节点必须在当前环境真的能用
  const info = nodeInfo(env, node);
  if (!info) {
    return jsonResponse({ error: '所选存储节点不可用，请换一个节点。', code: 'NO_STORAGE' }, 503);
  }

  const contentType = String(request.headers.get('content-type') || '');
  let payload;
  try {
    payload = contentType.includes('application/json')
      ? await readCloudSource(request, env, info.maxBytes)
      : await readLocalSource(request, info.maxBytes);
  } catch (e) {
    if (e && e.code === 'FILE_TOO_LARGE') return tooLarge(info);
    return jsonResponse({ error: e?.message || '读取文件失败。', code: 'READ_FAILED' }, 400);
  }

  const seq = parseManifest(session.files_json).length;
  try {
    const written = await writeTempFile(env, code, node, payload.fileName, payload.body, payload.fileSize, seq);
    await addManifestFile(env, code, {
      name: payload.fileName,
      size: payload.fileSize,
      type: payload.fileType,
      backend: node,
      key: written.key,
      meta: written.meta
    }, isFinal);

    // 统计只在「整批发完」那一刻记一条（以房间维度，而不是按文件计数）：
    // 此刻才同时知道发端身份、文件总数与总大小。
    if (isFinal) {
      const after = await getSession(env, code);
      const files = parseManifest(after?.files_json);
      const totalSize = files.reduce((a, f) => a + (Number(f.size) || 0), 0);
      await recordStat(env, {
        code,
        role: 'sender',
        isGuest: await isGuestRequest(request, env),
        fileName: files[0]?.name ? `${files.length} 个文件` : '批量文件',
        fileSize: totalSize,
        outcome: 'uploaded'
      });
    }
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
    backend: node,
    final: isFinal
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
    // File 是 Blob 子类，R2 能直接吃；Telegram 路径在 writeTempFile 里转 ArrayBuffer
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

function tooLarge(info) {
  return jsonResponse({
    error: `文件超出中转节点上限：当前「${info.label}」单文件最大 ${Math.floor(info.maxBytes / 1024 / 1024)} MB。`,
    code: 'FILE_TOO_LARGE',
    maxBytes: info.maxBytes
  }, 413);
}
