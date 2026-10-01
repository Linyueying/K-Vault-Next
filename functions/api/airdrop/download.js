/**
 * 隔空投送 —— 收端下载单个文件
 * GET /api/airdrop/download?code=XXXXXXXX&token=...&idx=0
 *
 * 必须带收端凭证：8 位连接码会出现在二维码里，不足以作为下载凭据。
 *
 * 房间进入 uploaded（发端整批发完）后才能取；取完把该条目标记为 downloaded。
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

export async function onRequestGet(context) {
  const { request, env } = context;
  const params = new URL(request.url).searchParams;
  const code = String(params.get('code') || '').trim().toUpperCase();
  const token = String(params.get('token') || '').trim();
  const idxRaw = params.get('idx');
  const idx = Number.isInteger(Number(idxRaw)) ? Number(idxRaw) : -1;

  if (!code || !token) {
    return jsonResponse({ error: '缺少 code 或 token。', code: 'BAD_PARAMS' }, 400);
  }

  // 取文件走"交付宽限"读取：已 uploaded 的房间即便刚跨过 expires_at，
  // 也允许把剩下的文件取完 —— 否则会出现"下到一半，剩余文件被过期清理删掉"。
  // 只放宽取件，不延长轮询（status 接口仍走严格的 getSession）。
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

  const stream = await readTempFile(env, file);
  if (!stream) {
    return jsonResponse({ error: '文件已失效，请让对方重新发送。', code: 'GONE' }, 410);
  }

  const headers = {
    'Content-Type': file.type || 'application/octet-stream',
    'Content-Length': String(stream.size || file.size || 0),
    'Content-Disposition': contentDisposition(file.name),
    'Cache-Control': 'no-store'
  };

  // 标记时机很重要：必须等响应体被真正读完（收端拿全字节）再记 downloaded。
  // 若在"开始响应"时就记，收端流还没走完，发端就会从 downloadedCount 里
  // 提前读出"全部已取走"，把没传完的投递当成完成。
  // tee 一条支流在后台逐块排空（不整块缓冲，控内存）；收端中途断开时
  // 两条支流一起失败，自然不会标记 —— 下载不完整就该重取。
  if (stream.body && typeof stream.body.tee === 'function' && typeof context.waitUntil === 'function') {
    const [toClient, toWatcher] = stream.body.tee();
    context.waitUntil((async () => {
      try {
        const reader = toWatcher.getReader();
        for (;;) {
          const step = await reader.read();
          if (step.done) break;
        }
        await markFileDownloaded(env, code, idx);
      } catch (e) {
        /* 收端中断 / 上游失败：不标记，收端重取即可 */
      }
    })());
    return new Response(toClient, { headers });
  }

  // 老路径（环境不支持 tee / waitUntil）：维持"开始即标记"的旧行为保底，
  // 宁可信号偏早，也不能让 complete 的前置条件永远不满足。
  markFileDownloaded(env, code, idx).catch(() => {});

  return new Response(stream.body, { headers });
}
