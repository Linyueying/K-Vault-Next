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
} from '../../../utils/file-record.js';
import { cleanupShareSlugMapping } from '../../../utils/share-options.js';

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
      await purgeEdgeCache(request, fileId);

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
      await purgeEdgeCache(request, fileId);

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
      await purgeEdgeCache(request, fileId);

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
      await purgeEdgeCache(request, fileId);

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
      await purgeEdgeCache(request, fileId);

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
      await purgeEdgeCache(request, fileId);

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
      await purgeEdgeCache(request, fileId);
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

async function purgeEdgeCache(request, fileId) {
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
 *   1. 文件记录本体（kvKey）
 *   2. share_slug 反向映射（复用 utils/share-options.js，判归属后才删）
 *   3. idxt: 索引键（新增，避免索引残留导致列表出现"幽灵条目"）
 *   4. dlc: 下载计数键（新增）
 */
async function cleanupRecordArtifacts(env, metadata = {}, kvKey = '') {
  await cleanupShareSlugMapping(env, metadata, kvKey);
  await env.img_url.delete(kvKey);
  await deleteRecordIndex(env, kvKey || metadata?.fileId || '');
  await deleteDownloadCount(env, kvKey);
}
