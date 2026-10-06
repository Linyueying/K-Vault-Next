import { envValue } from '../../utils/env-config.js';
import {
  checkAuthentication,
  isAuthRequired,
  safeStringEqual,
} from '../../utils/auth.js';
import {
  buildTelegramDirectLink,
  createSignedTelegramFileId,
  getTelegramFileFromMessage,
  sendTelegramUploadNotice,
  shouldUseSignedTelegramLinks,
  shouldWriteTelegramMetadata,
} from '../../utils/telegram.js';
import { putRecordIndex } from '../../utils/file-record.js';

export async function onRequestGet(context) {
  const { request, env } = context;

  // ---- GET 探针：只对管理员可见 ----
  //
  // 修复前这个探针对所有人都返回 200，`secretConfigured` 还会把「门锁到底锁没锁」
  // 直接写在门外墙上——匿名调用方只要读一个布尔值就知道这个端点值不值得打
  // （线上扫出来的就是 `secretConfigured:false`）。
  //
  // 现在匿名一律 **404 而不是 401/403**：既不回显任何配置状态，也不确认这个
  // 端点真实存在。真正的排障信息只有登录后的管理员拿得到。
  if (!(await isAdminViewer(context))) {
    return jsonResponse({ error: 'Not found' }, 404);
  }

  const url = new URL(request.url);
  // 只回布尔值，绝不回显 secret 本身。让管理员能确认「secret 到底配上了没有」
  // ——配不上时下面的 POST 是整体停用的。
  return jsonResponse({
    ok: true,
    message: 'Telegram webhook endpoint is ready.',
    endpoint: url.pathname,
    secretConfigured: Boolean(envValue(env, 'TELEGRAM_WEBHOOK_SECRET')),
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // ---- 鉴权：fail-closed，且必须排在所有业务检查之前 ----
  //
  // 修复前这里写成 `if (expectedSecret) { ...校验... }`——secret 没配就整段跳过，
  // 等于任何人都能匿名 POST 到本端点：往 KV 里写任意元数据、给任意 file_id
  // 生成直链、拿你的 bot 当免费图床。
  //
  // 现在反过来：没配 secret 就直接停用端点（503），配了才逐请求校验，
  // 且用恒定时间比较，避免通过响应耗时逐字节爆破 secret。
  //
  // 顺序同样是修复的一部分：`TG_Bot_Token` 的检查曾经排在 secret 校验前面，
  // 于是匿名请求能靠 500 vs 401 的差别，探到「bot token 有没有配」这种纯
  // 部署状态。现在鉴权先验完，配置缺失只在通过校验后才说的出来。
  const expectedSecret = envValue(env, 'TELEGRAM_WEBHOOK_SECRET');
  if (!expectedSecret) {
    return jsonResponse(
      {
        ok: false,
        error: 'WEBHOOK_SECRET_NOT_CONFIGURED',
        message:
          'Telegram webhook is disabled until TELEGRAM_WEBHOOK_SECRET (alias: TG_WEBHOOK_SECRET) is set, ' +
          'and the same value is passed to setWebhook as secret_token.',
      },
      503
    );
  }

  const headerSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!safeStringEqual(headerSecret, expectedSecret)) {
    return jsonResponse({ ok: false, error: 'Invalid webhook secret.' }, 401);
  }

  if (!envValue(env, 'TG_BOT_TOKEN')) {
    return jsonResponse({ ok: false, error: 'TG_Bot_Token is not configured.' }, 500);
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid JSON body.' }, 400);
  }

  const message = update?.message || update?.channel_post;
  if (!message) {
    return jsonResponse({ ok: true, ignored: 'no-message' });
  }

  // ---- 可选加固：来源会话白名单 ----
  //
  // secret 校验把「匿名互联网」挡在外面，但挡不住「任何 Telegram 用户给你的
  // bot 发文件」——那依然会让你的 bot 替陌生人生成直链、占用 KV 额度。
  // 设 `TG_WEBHOOK_CHAT_IDS`（逗号分隔，可填多个）即可只认指定会话/频道。
  //
  // 刻意留空即放行：channel_post 与 message 的来源形态各异，一刀切按
  // TG_Chat_ID 收紧会误伤既有流程，因此这是可选加固而非默认策略。
  const allowedChatIds = parseChatAllowlist(envValue(env, 'TG_WEBHOOK_CHAT_IDS'));
  if (allowedChatIds.length) {
    const incomingChatId = String(message?.chat?.id ?? '');
    if (!incomingChatId || !allowedChatIds.includes(incomingChatId)) {
      return jsonResponse({ ok: true, ignored: 'chat-not-allowed' });
    }
  }

  const media = getTelegramFileFromMessage(message);
  if (!media) {
    return jsonResponse({ ok: true, ignored: 'message-without-file' });
  }

  const useSigned = shouldUseSignedTelegramLinks(env);
  const directId = useSigned
    ? await createSignedTelegramFileId(
        {
          fileId: media.fileId,
          fileExtension: media.fileExtension,
          fileName: media.fileName,
          mimeType: media.mimeType,
          fileSize: media.fileSize,
          messageId: media.messageId,
        },
        env
      )
    : `${media.fileId}.${media.fileExtension}`;

  if (env.img_url && shouldWriteTelegramMetadata(env)) {
    const telegramKvKey = `${media.fileId}.${media.fileExtension}`;
    // 先算出 metadata 再写：KV 与 D1 共用同一份，省掉 D1 登记时的 KV 回读
    const recordMetadata = {
      TimeStamp: Date.now(),
      ListType: 'None',
      Label: 'None',
      liked: false,
      fileName: media.fileName,
      fileSize: media.fileSize,
      storageType: 'telegram',
      telegramFileId: media.fileId,
      telegramMessageId: media.messageId || undefined,
      fromWebhook: true,
      signedLink: useSigned,
    };
    await env.img_url.put(telegramKvKey, '', { metadata: recordMetadata });
    await putRecordIndex(env, telegramKvKey, { metadata: recordMetadata });
  }

  const directLink = buildTelegramDirectLink(env, directId, new URL(request.url).origin);
  const chatId = message?.chat?.id;
  let reply = {
    attempted: false,
    ok: false,
    skipped: true,
    reason: chatId ? 'not-sent' : 'missing-chat-id',
  };

  if (chatId) {
    const noticeResult = await sendTelegramUploadNotice(
      {
        chatId,
        replyToMessageId: message.message_id,
        directLink,
        fileId: media.fileId,
        messageId: media.messageId || message.message_id,
        fileName: media.fileName,
        fileSize: media.fileSize,
      },
      env
    );
    reply = normalizeReplyResult(noticeResult);
    if (!noticeResult?.ok && !noticeResult?.skipped) {
      console.warn(
        'Webhook reply failed:',
        noticeResult?.data?.description || noticeResult?.error || 'unknown error'
      );
    }
  }

  return jsonResponse({
    ok: true,
    directLink,
    storageType: 'telegram',
    mode: useSigned ? 'signed' : 'kv',
    update: {
      chatId,
      messageId: message.message_id,
      mediaKind: media.kind,
    },
    reply,
  });
}

/**
 * 判断调用方是否是已登录的管理员。
 *
 * `checkAuthentication` 在「压根没配管理员账密」时会返回 `authenticated:true`
 * ——那是给登录页用的放行语义（没设密码 = 人人可进），直接拿来当鉴权结果会
 * 重新把口子开回去。所以必须先用 `isAuthRequired` 守一道：**开放实例里没有
 * 人能证明自己是谁，一律按匿名处理。**
 */
async function isAdminViewer(context) {
  const { env } = context;
  if (!isAuthRequired(env)) return false;
  try {
    return (await checkAuthentication(context)).authenticated === true;
  } catch {
    return false;
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // 响应里含直链与鉴权结论，绝不进任何缓存
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * 解析 `TG_WEBHOOK_CHAT_IDS`（逗号/空格分隔）。
 * 允许负号开头的频道 ID（-100...），其他非数字字符一律丢弃。
 */
function parseChatAllowlist(raw) {
  return String(raw || '')
    .split(/[\s,]+/)
    .map(part => part.trim())
    .filter(part => /^-?\d+$/.test(part));
}

function normalizeReplyResult(result) {
  if (!result) {
    return {
      attempted: true,
      ok: false,
      skipped: false,
      reason: 'empty-result',
    };
  }

  return {
    attempted: !result.skipped,
    ok: Boolean(result.ok),
    skipped: Boolean(result.skipped),
    reason: result.reason || result.error || result.data?.description || '',
    status: result.data?.error_code || undefined,
  };
}
