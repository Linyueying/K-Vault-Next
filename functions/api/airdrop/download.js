/**
 * 隔空投送 —— 收端下载单个文件
 * GET /api/airdrop/download?code=012345&token=...&idx=0
 * POST 同一地址并回传 X-KVault-Download-Receipt，确认已读完整个响应。
 *
 * 必须带收端凭证：6 位连接码会出现在二维码里，不足以作为下载凭据。
 *
 * 房间进入 uploaded（发端整批发完）后才能取；收端确认后才标记为 downloaded。
 * 全部文件都 downloaded 后，收端调用 /api/airdrop/complete 确认完成。
 * 进入 done 后临时文件已被删除 —— 投递是一次性的，文件落地到收端本地即
 * 完成使命，不留在中转节点上占空间、也不留副本。
 */
import {
  getSessionForDelivery,
  roleOf,
  parseManifest,
  readTempFile,
  markFileDownloaded,
  contentDisposition,
  jsonResponse
} from '../../utils/airdrop.js';
import { withDownloadLength } from '../../utils/download-length.js';
import { assessAirdropFiles } from '../../utils/airdrop-risk.js';
import { getClientIp, fixedWindowRateLimit } from '../../utils/ratelimit.js';

const RECEIPT_HEADER = 'X-KVault-Download-Receipt';
const encoder = new TextEncoder();

async function downloadReceipt(session, file, idx, receipt) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(session.sender_token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
  const message = encoder.encode(JSON.stringify(['airdrop-download', session.code, session.receiver_token, idx, file.key]));
  if (receipt) {
    const signature = Uint8Array.from(atob(receipt), char => char.charCodeAt(0));
    return crypto.subtle.verify('HMAC', key, signature, message);
  }
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  return btoa(String.fromCharCode(...signature));
}

async function getDownloadTarget(context, acknowledging = false) {
  const { request, env } = context;
  const params = new URL(request.url).searchParams;
  const code = String(params.get('code') || '').trim().toUpperCase();
  const token = String(params.get('token') || '').trim();
  const idxRaw = params.get('idx');
  const idx = /^\d+$/.test(idxRaw || '') && Number.isSafeInteger(Number(idxRaw)) ? Number(idxRaw) : -1;

  // 限流：本接口每次请求都要查一次 D1，且失败路径（码不存在/凭证不对）
  // 也要落库查询 —— 不加限流的话可以拿它当"免费 D1 查询机"刷。
  // 60 次/分钟对正常收件足够（一次投送十几个文件也就十几次请求）。
  const rl = await fixedWindowRateLimit({
    env,
    key: getClientIp(request),
    namespace: acknowledging ? 'airdrop-download-ack' : 'airdrop-download',
    windowMs: 60 * 1000,
    max: 60
  });
  if (!rl.allowed) {
    return jsonResponse(
      { error: '下载请求过于频繁，请稍后再试。', code: 'RATE_LIMITED' },
      429,
      { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) }
    );
  }

  if (!code || !token || idx < 0) {
    return jsonResponse({ error: '缺少有效的房间、凭证或文件序号。', code: 'BAD_PARAMS' }, 400);
  }

  // 取文件走"交付宽限"读取：已 uploaded 的房间即便刚跨过 expires_at，
  // 也允许把剩下的文件取完 —— 否则会出现"下到一半，剩余文件被过期清理删掉"。
  const session = await getSessionForDelivery(env, code);
  if (!session) {
    return jsonResponse({ error: '房间不存在或已过期。', code: 'EXPIRED' }, 404);
  }
  if (roleOf(session, token) !== 'receiver') {
    return jsonResponse({ error: '只有接收方可以下载。', code: 'FORBIDDEN' }, 403);
  }
  if (session.status === 'uploading') {
    return jsonResponse({ error: '对方还在发送文件，请稍候。', code: 'NOT_READY' }, 409);
  }
  if (session.status !== 'uploaded') {
    return jsonResponse(
      { error: session.status === 'done' ? '本次投递已完成。' : '对方还没有发送文件。', code: 'NOT_READY' },
      409
    );
  }

  const files = parseManifest(session.files_json);
  const file = files[idx];
  if (!file) {
    return jsonResponse({ error: '文件不存在或已失效。', code: 'GONE' }, 410);
  }

  return { session, files, file, idx };
}

function parseAirdropRange(rangeHeader, totalSize) {
  const match = String(rangeHeader || '').trim().match(/^bytes=(\d+)-(\d*)$/);
  if (!match || !Number.isSafeInteger(totalSize) || totalSize <= 0) return null;
  const start = Number(match[1]);
  const end = match[2] === '' ? totalSize - 1 : Math.min(Number(match[2]), totalSize - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= totalSize || start > end) {
    return { unsatisfiable: true };
  }
  return { start, end, length: end - start + 1 };
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const target = await getDownloadTarget(context);
  if (target instanceof Response) return target;
  const { session, files, file, idx } = target;

  if (assessAirdropFiles(files).length && request.headers.get('X-KVault-Accept-Risk') !== '1') {
    return jsonResponse({ error: '此投送需要确认文件风险后才能继续。', code: 'RISK_CONFIRMATION_REQUIRED' }, 409);
  }

  const rangeHeader = request.headers.get('Range');
  const fileTotalSize = Number.isSafeInteger(Number(file.size)) && Number(file.size) > 0 ? Number(file.size) : null;
  let parsedRange = null;
  if (rangeHeader && file.backend === 'r2' && fileTotalSize) {
    parsedRange = parseAirdropRange(rangeHeader, fileTotalSize);
    if (parsedRange?.unsatisfiable) {
      return new Response('Range Not Satisfiable', {
        status: 416,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes */${fileTotalSize}`,
          'Cache-Control': 'no-store',
        },
      });
    }
  }

  let stream;
  try {
    stream = await readTempFile(env, file, {
      range: parsedRange ? { offset: parsedRange.start, length: parsedRange.length } : null,
      rangeHeader: file.backend === 'telegram' ? rangeHeader : null,
    });
  } catch (error) {
    const { classifyR2Error } = await import('../../utils/r2-retry.js');
    if (classifyR2Error(error) === 'transient') {
      return jsonResponse(
        { error: '云端存储暂时繁忙，请稍后重试。', code: 'STORAGE_RETRY' },
        503,
        { 'Retry-After': '1' }
      );
    }
    throw error;
  }
  if (!stream) {
    return jsonResponse({ error: '文件已失效，请让对方重新发送。', code: 'GONE' }, 410);
  }

  const isPartial = Boolean(parsedRange) || stream.status === 206;
  const headers = {
    'Content-Type': file.type || 'application/octet-stream',
    'Content-Disposition': contentDisposition(file.name),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    [RECEIPT_HEADER]: await downloadReceipt(session, file, idx)
  };
  if (parsedRange) {
    const total = stream.totalSize ?? fileTotalSize;
    headers['Content-Range'] = `bytes ${parsedRange.start}-${parsedRange.end}/${total}`;
    headers['Content-Length'] = String(parsedRange.length);
  } else {
    if (stream.contentRange) headers['Content-Range'] = stream.contentRange;
    if (stream.size !== null) headers['Content-Length'] = String(stream.size);
  }

  return withDownloadLength(new Response(stream.body, { status: isPartial ? 206 : 200, headers }));
}

/** 接收端读完响应后回传该文件的回执，GET 本身不会更新接收状态。 */
export async function onRequestPost(context) {
  const { request, env } = context;
  const receipt = request.headers.get(RECEIPT_HEADER) || '';
  if (!/^[A-Za-z0-9+/]{43}=$/.test(receipt)) {
    return jsonResponse({ error: '缺少有效的下载回执。', code: 'BAD_RECEIPT' }, 400);
  }
  const target = await getDownloadTarget(context, true);
  if (target instanceof Response) return target;
  const { session, file, idx } = target;
  if (!await downloadReceipt(session, file, idx, receipt)) {
    return jsonResponse({ error: '下载回执与当前文件不匹配。', code: 'BAD_RECEIPT' }, 403);
  }
  if (!await markFileDownloaded(env, session, idx)) {
    return jsonResponse({ error: '房间已结束或状态已变化。', code: 'ROOM_CHANGED' }, 409);
  }
  return jsonResponse({ ok: true });
}
