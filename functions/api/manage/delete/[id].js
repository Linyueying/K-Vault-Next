import { createS3Client } from '../../../utils/s3client.js';
import { envValue } from '../../../utils/env-config.js';
import { deleteDiscordMessage } from '../../../utils/discord.js';
import { deleteHuggingFaceFile } from '../../../utils/huggingface.js';
import { deleteWebDAVFile } from '../../../utils/webdav.js';
import { deleteGitHubFile } from '../../../utils/github.js';
import { buildTelegramBotApiUrl } from '../../../utils/telegram.js';
import {
  STORAGE_PREFIXES,
  getRecordWithKey as findRecordWithKey,
  deleteRecordIndex,
  deleteDownloadCount,
  removeFileRecord,
  deriveIndexId,
} from '../../../utils/file-record.js';
import { cleanupShareSlugMapping } from '../../../utils/share-options.js';
import { deleteThumb } from '../../../utils/thumb-store.js';
import { purgeByteCache } from '../../../utils/byte-cache.js';

// 记录定位统一走 utils/file-record.js（索引加速，行为与原有本地实现一致）
function getRecordWithKey(env, fileId) {
  return findRecordWithKey(env, fileId);
}

export async function onRequest(context) {
  const { request, env, params } = context;
  let fileId = params.id;

  try {
    fileId = decodeURIComponent(fileId);
  } catch {
    fileId = String(params.id || '');
  }

  try {
    if (!env.img_url) {
      throw new Error('KV binding img_url is not configured.');
    }

    const { record, kvKey } = await getRecordWithKey(env, fileId);
    if (!record?.metadata) {
      return jsonResponse({ success: false, error: 'File metadata not found.' }, 404);
    }

    const metadata = record.metadata;
    const storageType = String(metadata.storageType || metadata.storage || 'telegram').toLowerCase();

    if (storageType === 'r2' || fileId.startsWith('r2:')) {
      const r2Key = metadata.r2Key
        || (kvKey?.startsWith('r2:') ? kvKey.slice(3) : null)
        || (fileId.startsWith('r2:') ? fileId.slice(3) : fileId);

      if (!env.R2_BUCKET) throw new Error('R2 bucket is not configured.');
      if (!r2Key) throw new Error('Failed to resolve R2 key.');

      await env.R2_BUCKET.delete(r2Key);
        await cleanupRecordArtifacts(env, metadata, kvKey);
      await purgeEdgeCache(request, fileId, kvKey);

      return jsonResponse({
        success: true,
        message: 'Deleted from R2 and KV.',
        fileId,
        r2Key,
        kvKey,
      });
    }

    if (storageType === 's3' || fileId.startsWith('s3:')) {
      const s3Key = metadata.s3Key || fileId.replace(/^s3:/, '');
      try {
        const s3 = createS3Client(env);
        await s3.deleteObject(s3Key);
      } catch (error) {
        console.error('S3 delete error (best-effort):', error);
      }
        await cleanupRecordArtifacts(env, metadata, kvKey);
      await purgeEdgeCache(request, fileId, kvKey);

      return jsonResponse({
        success: true,
        message: 'Deleted from S3 and KV.',
        fileId,
        kvKey,
      });
    }

    if (storageType === 'discord' || fileId.startsWith('discord:')) {
      let discordDeleted = false;
      try {
        if (metadata.discordChannelId && metadata.discordMessageId) {
          discordDeleted = await deleteDiscordMessage(
            metadata.discordChannelId,
            metadata.discordMessageId,
            env
          );
        }
      } catch (error) {
        console.error('Discord delete error (best-effort):', error);
      }

        await cleanupRecordArtifacts(env, metadata, kvKey);
      await purgeEdgeCache(request, fileId, kvKey);

      return jsonResponse({
        success: true,
        message: discordDeleted ? 'Deleted from Discord and KV.' : 'KV deleted (Discord best-effort).',
        fileId,
        kvKey,
      });
    }

    if (storageType === 'huggingface' || fileId.startsWith('hf:')) {
      let hfDeleted = false;
      try {
        if (metadata.hfPath) {
          hfDeleted = await deleteHuggingFaceFile(metadata.hfPath, env);
        }
      } catch (error) {
        console.error('HuggingFace delete error (best-effort):', error);
      }

        await cleanupRecordArtifacts(env, metadata, kvKey);
      await purgeEdgeCache(request, fileId, kvKey);

      return jsonResponse({
        success: true,
        message: hfDeleted ? 'Deleted from HuggingFace and KV.' : 'KV deleted (HuggingFace best-effort).',
        fileId,
        kvKey,
      });
    }

    if (storageType === 'webdav' || fileId.startsWith('webdav:')) {
      let webdavDeleted = false;
      try {
        const webdavPath = metadata.webdavPath || metadata.path || fileId.replace(/^webdav:/, '');
        if (webdavPath) {
          webdavDeleted = await deleteWebDAVFile(webdavPath, env);
        }
      } catch (error) {
        console.error('WebDAV delete error (best-effort):', error);
      }

        await cleanupRecordArtifacts(env, metadata, kvKey);
      await purgeEdgeCache(request, fileId, kvKey);

      return jsonResponse({
        success: true,
        message: webdavDeleted ? 'Deleted from WebDAV and KV.' : 'KV deleted (WebDAV best-effort).',
        fileId,
        kvKey,
      });
    }

    if (storageType === 'github' || fileId.startsWith('github:')) {
      let githubDeleted = false;
      try {
        const githubStorageKey = metadata.githubStorageKey || fileId.replace(/^github:/, '');
        githubDeleted = await deleteGitHubFile(githubStorageKey, metadata, env);
      } catch (error) {
        console.error('GitHub delete error (best-effort):', error);
      }

        await cleanupRecordArtifacts(env, metadata, kvKey);
      await purgeEdgeCache(request, fileId, kvKey);

      return jsonResponse({
        success: true,
        message: githubDeleted ? 'Deleted from GitHub and KV.' : 'KV deleted (GitHub best-effort).',
        fileId,
        kvKey,
      });
    }

    let telegramDeleted = false;
    let telegramDeleteAttempted = false;
    let telegramDeleteError = null;

    try {
      if (metadata.telegramMessageId) {
        telegramDeleteAttempted = true;
        telegramDeleted = await deleteTelegramMessage(metadata.telegramMessageId, env);
      }
    } catch (error) {
      telegramDeleteError = error;
      console.error('Telegram deleteMessage threw:', error);
    } finally {
        await cleanupRecordArtifacts(env, metadata, kvKey);
      await purgeEdgeCache(request, fileId, kvKey);
    }

    return jsonResponse({
      success: true,
      message: telegramDeleted
        ? 'Deleted from Telegram and KV.'
        : 'KV metadata deleted (Telegram deletion best-effort).',
      fileId,
      kvKey,
      telegramDeleteAttempted,
      telegramDeleted,
      warning: telegramDeleted ? '' : 'Telegram deletion failed or messageId missing.',
      telegramDeleteError: telegramDeleteError ? telegramDeleteError.message : null,
    });
  } catch (error) {
    console.error('Delete error:', error);
    return jsonResponse({ success: false, error: error.message }, 500);
  }
}

async function deleteTelegramMessage(messageId, env) {
  if (!messageId || !envValue(env, 'TG_BOT_TOKEN') || !envValue(env, 'TG_CHAT_ID')) {
    return false;
  }

  try {
    const response = await fetch(buildTelegramBotApiUrl(env, 'deleteMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: envValue(env, 'TG_CHAT_ID'),
        message_id: messageId,
      }),
    });

    let data = { ok: false };
    try {
      data = await response.json();
    } catch {
      data = { ok: false };
    }

    return response.ok && data.ok;
  } catch (error) {
    console.error('Telegram delete message error:', error);
    return false;
  }
}

/**
 * 清除边缘上与该文件相关的副本。
 *
 * 两条链路都要清：
 *   1. `/file/<id>` —— 旧版本开启过 `PUBLIC_DOWNLOAD_CACHE` 的部署可能还留着
 *      响应头缓存条目；升级不会自动清空 Cache API，所以这里顺手删掉（廉价兜底）
 *   2. `/__kvault-bytecache/<id>` —— 字节缓存（现在唯一的缓存层）
 *
 * 第 2 条不是可选项：字节缓存的键带着存储前缀的各种写法（`r2:c.png` /
 * `c.png`），只删 `/file/<id>` 会留下「后台已删除、链接仍能完整下载」的
 * 副本，直到 TTL 到期。purgeByteCache 内部会展开所有等价写法。
 *
 * 清理失败不影响删除结果 —— 残留副本仍会随 TTL 自然过期。
 */
async function purgeEdgeCache(request, fileId, kvKey) {
  try {
    const cache = caches.default;
    const origin = new URL(request.url).origin;
    const urlsToPurge = [
      `${origin}/file/${fileId}`,
      `${origin}/file/${encodeURIComponent(fileId)}`,
    ];
    for (const url of urlsToPurge) {
      await cache.delete(new Request(url));
    }
    await purgeByteCache(origin, [fileId, kvKey || '']);
  } catch (error) {
    console.warn('Edge cache purge failed (non-critical):', error.message);
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * 删除文件记录时的统一清理：
 *   1. 文件记录本体 —— D1（主源）与 KV（降级/双写副本）
 *   2. share_slug 反向映射（复用 utils/share-options.js，判归属后才删）
 *   3. idxt: 索引键（新增，避免索引残留导致列表出现"幽灵条目"）
 *   4. dlc: 下载计数键（新增）
 *   5. 缩略图附属对象（thumb:<kvKey> / thumb/<kvKey>，见 utils/thumb-store.js）
 *
 * ⚠️ D1 侧的删除**不受回滚模式开关影响**：删除是"记录不该再存在"，
 * 不是"要不要多写一份副本"。开关只管写入冗余，管不着删除。
 * 此前这里完全没碰 D1，导致 D1 接管读侧后"删除成功但列表里文件还在"。
 */
async function cleanupRecordArtifacts(env, metadata = {}, kvKey = '') {
  await cleanupShareSlugMapping(env, metadata, kvKey);

  // 缩略图附属对象：它的 key 由 kvKey 纯派生、不在任何元数据里留痕，
  // 因此**只能在这里显式删除** —— 漏掉就是永久泄漏
  // （KV 不会自己回收，R2 也没有针对它的生命周期规则）。
  await deleteThumb(env, kvKey);

  // D1 主源：用裸 ID 删（kvKey 带存储前缀，当主键会删 0 行且不报错）。
  if (env?.DB && typeof env.DB.prepare === 'function') {
    const bareId = deriveIndexId(kvKey || metadata?.fileId || '');
    if (bareId) {
      const removed = await removeFileRecord(env, bareId).catch(() => false);
      if (!removed) {
        console.warn('cleanupRecordArtifacts: D1 delete failed for', bareId);
      }
    }
  }

  await env.img_url.delete(kvKey);
  await deleteRecordIndex(env, kvKey || metadata?.fileId || '');
  await deleteDownloadCount(env, kvKey);
}
