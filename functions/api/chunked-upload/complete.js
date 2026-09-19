/**
 * Complete chunked upload request.
 * POST /api/chunked-upload/complete
 *
 * ================================================================
 * 本次修复（P1-3 / P1-5）：
 *
 * 【修复 P1-3】非 R2 分支内存拼装阶段异常导致 R2 临时分片残留
 *   - 原代码：分片读取循环位于 try/finally 之外，readChunkData 抛异常
 *     （R2 get 网络错误 / arrayBuffer 转换失败 / OOM）时逃逸到外层 catch。
 *   - 外层 catch 仅处理 R2 multipart abort 与 uploadedFileInfo 回滚，
 *     非 R2 分支两者均不满足，导致 chunk-upload/ 下临时分片永久残留。
 *   - 修复：将「分片读取 → 大小校验 A/B → Blob 构造 → 分发到目标存储」
 *     整段包进同一个 try/finally，finally 中无条件 cleanupUploadTask。
 *   - 「内存上限检查」与「uploadedChunks 完整性检查」保持在 try 之外：
 *       · 内存上限检查本身主动 cleanup（用户可切换到 R2 重传）
 *       · 完整性检查失败不 cleanup（允许用户继续补齐分片）
 *   - 去除 try 内部各 return 前的重复 cleanup（统一由 finally 完成）。
 *
 * 【修复 P1-5】R2 合并后 head 瞬时失败误删正式对象
 *   - 原代码：mp.complete() 成功后 head 抛异常即无条件删除正式对象、
 *     删除任务 KV、移除 pending multipart，用户数据被系统自己删除，
 *     且无法重试，必须重新上传全部分片。
 *   - 修复：
 *       1) head 最多重试 3 次（带指数退避 300ms / 600ms）
 *       2) 重试仍失败 → 不删除正式对象、不删除任务 KV、保留 uploadedFileInfo，
 *          返回 503 + code=R2_HEAD_RETRY，提示用户稍后重试
 *       3) 仅当 head 成功但确认对象不存在（返回 null）或大小不符时，
 *          才执行删除与清理
 *   - 根因原则：只要目标对象可能已存在，就不能在“验证不成功”时主动删除。
 *
 * ================================================================
 * 历史修复保留：
 * - 强制鉴权、归属校验、uploadId 格式校验
 * - R2 原生 Multipart head 校验最终对象大小
 * - R2 multipart 失败自动 abort
 * - 非 R2 分支合并前后双重大小校验 + chunkSizes 累加校验
 * - 非 R2 分支分发段整体 try/finally，无条件清理临时分片
 * - "分片未完全上传" 不清理，允许用户继续补齐
 * - KV metadata 1024 字节硬限制
 * - 目标存储上传成功后元数据写入失败的回滚
 * - HuggingFace / WebDAV / GitHub 回滚落地
 *
 * ================================================================
 * ⚠️ 已知限制：
 *
 * 1. Discord 回滚需要 DISCORD_BOT_TOKEN。
 *    仅配置 DISCORD_WEBHOOK_URL 时，无法通过 bot API 删除消息。
 *
 * 2. shareOptions 分支的 metadata 大小校验由
 *    utils/share-options.js 负责。
 *
 * 3. 【P1-5 衍生】R2_HEAD_RETRY 分支返回 503 后，若用户重发 complete，
 *    由于 mp.complete() 已成功执行过，再次调用 mp.complete() 可能失败
 *    （uploadId 已失效）。本文件当前未处理该重入场景，属后续迭代边界。
 *
 * ================================================================
 * ⚠️ 部署方须知：
 * - 本文件不负责清理"用户再也不回来"场景下的 R2 泄漏。
 *   必须在 R2 控制台配置：
 *   1) chunk-upload/ 前缀对象 1 天后删除
 *   2) 全局未完成 multipart upload 1 天后 abort
 * ================================================================
 */
import { checkAuthentication } from '../../utils/auth.js';
import { createS3Client } from '../../utils/s3client.js';
import { uploadToDiscord } from '../../utils/discord.js';
import {
  hasHuggingFaceConfig,
  uploadToHuggingFace,
  deleteFromHuggingFace,
} from '../../utils/huggingface.js';
import {
  hasWebDAVConfig,
  normalizeWebDAVPath,
  uploadToWebDAV,
  deleteFromWebDAV,
} from '../../utils/webdav.js';
import {
  hasGitHubConfig,
  normalizeGitHubStoragePath,
  uploadToGitHub,
  deleteFromGitHub,
} from '../../utils/github.js';
import {
  buildTelegramDirectLink,
  buildTelegramBotApiUrl,
  createSignedTelegramFileId,
  getTelegramUploadMethodAndField,
  pickTelegramFileId,
  sendTelegramUploadNotice,
  shouldUseSignedTelegramLinks,
  shouldWriteTelegramMetadata,
} from '../../utils/telegram.js';
import { applyShareOptions, hasShareOptions } from '../../utils/share-options.js';
import { MAX_IN_MEMORY_ASSEMBLY } from '../../utils/chunk-limits.js';

const TEMP_CHUNK_PREFIX = 'chunk-upload';
const MB = 1024 * 1024;
const GB = 1024 * MB;

// 存储类型白名单
const VALID_STORAGE_TYPES = ['telegram', 'r2', 's3', 'discord', 'huggingface', 'webdav', 'github'];

// 用户状态 KV TTL（与 init.js 保持一致）
const USER_STATE_TTL = 86400 * 2;

// 【P0-3】KV metadata 安全上限（Cloudflare 硬限制 1024 字节，留安全余量）
export const KV_METADATA_SAFE_LIMIT = 1000;

// 【修复 P1-5】R2 head 校验重试配置
const R2_HEAD_MAX_RETRIES = 3;
const R2_HEAD_RETRY_BASE_DELAY_MS = 300;

export async function onRequestPost(context) {
  const { request, env } = context;

  // ============================================================
  // 以下变量必须在函数作用域声明，以便外层 catch 访问（回滚/abort 兜底）
  // ============================================================
  let uploadId = null;
  let taskData = null;
  let r2Aborted = false;
  let r2Completed = false;          // R2 multipart 是否已完成
  let ownerId = null;
  let uploadedFileInfo = null;      // 已上传目标文件的最小标识
  let extraMetadata = {};           // 存储分支附加元数据（也用于回滚辅助）
  let responseFileKey = null;
  let metadataKey = null;
  let telegramNoticePayload = null;
  let storageType = null;
  let totalChunks = 0;
  let folderPath = '';
  let fileExtension = '';
  let nonR2ChunkBackend = null;
  let nonR2CleanupNeeded = false;

  try {
    // ============================================
    // 1. 强制鉴权
    // ============================================
    const auth = await checkAuthentication(context);
    if (!auth || !auth.authenticated) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    if (!env.img_url) {
      return jsonResponse(
        { error: 'KV binding img_url is required for chunk upload task state.' },
        500
      );
    }

    ownerId = getOwnerId(auth);
    if (!ownerId) {
      return jsonResponse({ error: '无法识别用户身份，拒绝完成上传' }, 401);
    }

    // ============================================
    // 2. 严格解析 JSON body
    // ============================================
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    uploadId = body?.uploadId;
    if (
      !uploadId ||
      typeof uploadId !== 'string' ||
      !/^[a-f0-9]{16,64}$/i.test(uploadId)
    ) {
      return jsonResponse({ error: '缺少或非法 uploadId' }, 400);
    }

    // ============================================
    // 3. 读取并校验任务
    // ============================================
    taskData = await env.img_url.get(`upload:${uploadId}`, { type: 'json' });
    if (!taskData) {
      return jsonResponse({ error: '上传任务不存在或已过期' }, 404);
    }

    if (!taskData.ownerId || taskData.ownerId !== ownerId) {
      return jsonResponse({ error: '无权操作该上传任务' }, 403);
    }

    totalChunks = Number(taskData.totalChunks || 0);
    if (!Number.isInteger(totalChunks) || totalChunks <= 0) {
      return jsonResponse({ error: 'Invalid totalChunks in upload task.' }, 400);
    }

    const fileSizeNum = Number(taskData.fileSize || 0);
    if (!Number.isInteger(fileSizeNum) || fileSizeNum <= 0) {
      return jsonResponse({ error: 'Invalid fileSize in upload task.' }, 400);
    }

    storageType = String(taskData.storageMode || 'telegram').toLowerCase();
    if (!VALID_STORAGE_TYPES.includes(storageType)) {
      return jsonResponse({ error: `不支持的存储类型：${storageType}` }, 400);
    }

    const completionValidation = validateCompletionTarget(storageType, fileSizeNum);
    if (!completionValidation.ok) {
      return jsonResponse(
        { error: completionValidation.message, code: completionValidation.code },
        completionValidation.status
      );
    }

    folderPath = normalizeFolderPath(taskData.folderPath || '');
    fileExtension = getFileExtension(taskData.fileName);

    // ============================================
    // 4. R2 原生 Multipart 分支
    // ============================================
    if (storageType === 'r2') {
      if (!env.R2_BUCKET) {
        return jsonResponse({ error: 'R2 未配置，无法完成上传' }, 500);
      }
      if (
        !taskData.r2Multipart ||
        !taskData.r2Multipart.key ||
        !taskData.r2Multipart.uploadId
      ) {
        return jsonResponse(
          { error: 'R2 multipart 任务信息不完整，无法完成合并' },
          500
        );
      }

      // ---- 校验 parts ----
      const rawParts =
        Array.isArray(body?.parts) && body.parts.length
          ? body.parts
          : Array.isArray(taskData.uploadedParts)
            ? taskData.uploadedParts
            : [];

      const parts = rawParts
        .filter(
          (p) =>
            p &&
            Number.isInteger(p.partNumber) &&
            p.partNumber > 0 &&
            typeof p.etag === 'string' &&
            p.etag.length > 0
        )
        .map((p) => ({ partNumber: p.partNumber, etag: p.etag }))
        .sort((a, b) => a.partNumber - b.partNumber);

      const uniquePartNumbers = new Set(parts.map((p) => p.partNumber));
      if (parts.length !== totalChunks || uniquePartNumbers.size !== totalChunks) {
        return jsonResponse(
          {
            error:
              `分片信息不完整或重复：预期 ${totalChunks} 个，` +
              `实际有效 ${parts.length} 个，去重后 ${uniquePartNumbers.size} 个`,
          },
          400
        );
      }

      for (let i = 1; i <= totalChunks; i++) {
        if (!uniquePartNumbers.has(i)) {
          return jsonResponse({ error: `缺少 partNumber ${i}` }, 400);
        }
      }

      const mp = env.R2_BUCKET.resumeMultipartUpload(
        taskData.r2Multipart.key,
        taskData.r2Multipart.uploadId
      );

      // ---- 执行 complete ----
      try {
        await mp.complete(parts);
        r2Completed = true;
        uploadedFileInfo = {
          type: 'r2',
          key: taskData.r2Multipart.key,
        };
      } catch (err) {
        console.error('R2 multipart complete error:', err);
        // complete 失败 → 尝试 abort，避免存储泄漏
        try {
          await mp.abort();
          r2Aborted = true;
          await removePendingMultipart(env, ownerId, uploadId).catch((e) => {
            console.error('removePendingMultipart after abort failed:', e);
          });
        } catch (abortErr) {
          console.error('R2 multipart abort error:', abortErr);
        }
        return jsonResponse(
          { error: `R2 合并失败: ${err.message || err}` },
          500
        );
      }

      // ============================================================
      // ---- head 校验最终对象大小 ----
      // 【修复 P1-5】
      //   head 失败分两类：
      //     (a) 瞬时错误（网络抖动 / R2 5xx / 超时）→ 保留对象，返回 503 可重试
      //     (b) 对象确实不存在（head 返回 null）或大小不符 → 才清理
      //   绝不能把 (a) 当作 (b) 处理，否则会误删用户已成功合并的正式对象。
      // ============================================================
      let headObj = null;
      let headErr = null;
      for (let attempt = 1; attempt <= R2_HEAD_MAX_RETRIES; attempt++) {
        try {
          headObj = await env.R2_BUCKET.head(taskData.r2Multipart.key);
          headErr = null;
          break;
        } catch (err) {
          headErr = err;
          console.warn(
            `R2 head attempt ${attempt}/${R2_HEAD_MAX_RETRIES} failed:`,
            err?.message || err
          );
          if (attempt < R2_HEAD_MAX_RETRIES) {
            await new Promise((r) =>
              setTimeout(r, R2_HEAD_RETRY_BASE_DELAY_MS * attempt)
            );
          }
        }
      }

      if (headErr) {
        // 【关键】head 重试仍失败：不删除正式对象、不删除任务 KV，
        // 保留 uploadedFileInfo，返回 503 提示用户稍后重试 complete。
        console.error(
          'R2 head failed after retries, preserving object for retry:',
          headErr
        );
        return jsonResponse(
          {
            error: `R2 校验暂时失败，请稍后重试: ${headErr.message || headErr}`,
            code: 'R2_HEAD_RETRY',
          },
          503
        );
      }

      if (!headObj) {
        // head 成功但对象确实不存在 → 清理任务 KV + pending
        await env.img_url.delete(`upload:${uploadId}`).catch(() => {});
        await removePendingMultipart(env, ownerId, uploadId).catch((e) => {
          console.error('removePendingMultipart after object missing failed:', e);
        });
        uploadedFileInfo = null;
        return jsonResponse(
          { error: 'R2 对象不存在（合并后无法 head）', code: 'R2_OBJECT_MISSING' },
          500
        );
      }

      if (Number(headObj.size) !== fileSizeNum) {
        // head 成功且大小确认不符 → 此时才删除对象并清理
        try {
          await env.R2_BUCKET.delete(taskData.r2Multipart.key);
        } catch (delErr) {
          console.error('R2 delete mismatched object error:', delErr);
        }
        await env.img_url.delete(`upload:${uploadId}`).catch(() => {});
        await removePendingMultipart(env, ownerId, uploadId).catch((e) => {
          console.error('removePendingMultipart after size-mismatch failed:', e);
        });
        uploadedFileInfo = null;
        return jsonResponse(
          {
            error: `R2 对象实际大小 ${headObj.size} 与声明 ${fileSizeNum} 不一致`,
            code: 'R2_SIZE_MISMATCH',
          },
          400
        );
      }

      // 正常完成：从 user-multiparts 移除（对象保留，元数据待写）
      await removePendingMultipart(env, ownerId, uploadId).catch((e) => {
        console.error('removePendingMultipart on R2 success failed:', e);
      });

      responseFileKey = `r2:${taskData.r2Multipart.key}`;
      metadataKey = responseFileKey;
      extraMetadata.r2Key = taskData.r2Multipart.key;
    }
    // ============================================
    // 5. 非 R2 原生分支：单缓冲内存拼装
    // ============================================
    else {
      const chunkBackend = resolveChunkBackend(taskData, env);
      nonR2ChunkBackend = chunkBackend;

      // ---- 内存拼装上限（分片已完整，出错则清理分片） ----
      if (fileSizeNum > MAX_IN_MEMORY_ASSEMBLY) {
        await cleanupUploadTask(uploadId, totalChunks, chunkBackend, env).catch(
          (e) => console.error('Cleanup on MAX_IN_MEMORY_ASSEMBLY failed:', e)
        );
        return jsonResponse(
          {
            error:
              `该存储节点分片合并需要内存拼装，文件 ${formatBytes(fileSizeNum)} ` +
              `超过上限 ${formatBytes(MAX_IN_MEMORY_ASSEMBLY)}，请使用 R2 或减小文件。`,
          },
          413
        );
      }

      // ---- 单缓冲组装 ----
      const completeBuffer = new Uint8Array(fileSizeNum);
      let offset = 0;

      for (let i = 0; i < totalChunks; i++) {
        let chunkData;
        try {
          chunkData = await readChunkData(uploadId, i, chunkBackend, env);
        } catch (err) {
          console.error(`readChunkData ${i} error:`, err);
          return jsonResponse(
            { error: `读取分片 ${i} 暂时失败，请稍后重试`, code: 'CHUNK_READ_RETRY' },
            503
          );
        }
        if (!chunkData) {
          return jsonResponse(
            { error: `分片 ${i} 数据缺失`, code: 'CHUNK_MISSING' },
            400
          );
        }
        const bytes =
          chunkData instanceof ArrayBuffer
            ? new Uint8Array(chunkData)
            : new Uint8Array(chunkData.buffer || chunkData);
        if (offset + bytes.byteLength > fileSizeNum) {
          return jsonResponse(
            { error: `分片 ${i} 超出声明文件大小`, code: 'CHUNK_OVERFLOW' },
            400
          );
        }
        completeBuffer.set(bytes, offset);
        offset += bytes.byteLength;
      }

      if (offset !== fileSizeNum) {
        return jsonResponse(
          {
            error: `分片实际总大小 ${offset} 与声明 ${fileSizeNum} 不一致`,
            code: 'CHUNK_TOTAL_MISMATCH',
          },
          400
        );
      }

      // 标记：分发成功后需要清理
      nonR2CleanupNeeded = true;

      // ============================================
      // 6. 分发到目标存储
      //
      // 分片已全部读入内存，可以安全删除存储后端的分片对象。
      // 清理将在元数据写入成功后进行。
      // 每个存储分支成功上传后立即写 uploadedFileInfo，
      // 供元数据失败时回滚。
      // ============================================
      if (storageType === 's3') {
        if (!env.S3_ENDPOINT || !env.S3_ACCESS_KEY_ID) {
          return jsonResponse({ error: 'S3 未配置，无法完成上传' }, 500);
        }
        const s3 = createS3Client(env);
        const s3Id = `s3_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        const s3FileName = `${s3Id}.${fileExtension}`;
        const s3Key = joinStoragePath(folderPath, s3FileName);

        await s3.putObject(s3Key, completeBuffer.buffer, {
          contentType: taskData.fileType || 'application/octet-stream',
          metadata: { filename: encodeURIComponent(taskData.fileName) },
        });
        responseFileKey = `s3:${s3Key}`;
        metadataKey = responseFileKey;
        extraMetadata.s3Key = s3Key;
        uploadedFileInfo = { type: 's3', key: s3Key };
      } else if (storageType === 'discord') {
        if (!env.DISCORD_WEBHOOK_URL && !env.DISCORD_BOT_TOKEN) {
          return jsonResponse({ error: 'Discord 未配置，无法完成上传' }, 500);
        }
        const discordResult = await uploadToDiscord(
          completeBuffer.buffer,
          taskData.fileName,
          taskData.fileType,
          env
        );
        if (!discordResult.success) {
          return jsonResponse(
            { error: 'Discord 上传失败: ' + discordResult.error },
            500
          );
        }
        const discordId = `discord_${Date.now()}_${Math.random()
          .toString(36)
          .substring(2, 8)}`;
        responseFileKey = `discord:${discordId}.${fileExtension}`;
        metadataKey = responseFileKey;
        extraMetadata.discordChannelId = discordResult.channelId;
        extraMetadata.discordMessageId = discordResult.messageId;
        extraMetadata.discordAttachmentId = discordResult.attachmentId;
        uploadedFileInfo = {
          type: 'discord',
          channelId: discordResult.channelId,
          messageId: discordResult.messageId,
        };
      } else if (storageType === 'huggingface') {
        if (!hasHuggingFaceConfig(env)) {
          return jsonResponse({ error: 'HuggingFace 未配置，无法完成上传' }, 500);
        }
        const hfId = `hf_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        const hfPath = joinStoragePath(folderPath, `${hfId}.${fileExtension}`);
        const hfResult = await uploadToHuggingFace(
          completeBuffer.buffer,
          hfPath,
          taskData.fileName,
          env
        );
        if (!hfResult.success) {
          return jsonResponse(
            { error: 'HuggingFace 上传失败: ' + hfResult.error },
            500
          );
        }
        responseFileKey = `hf:${hfId}.${fileExtension}`;
        metadataKey = responseFileKey;
        extraMetadata.hfPath = hfPath;
        uploadedFileInfo = { type: 'huggingface', path: hfPath };
      } else if (storageType === 'webdav') {
        if (!hasWebDAVConfig(env)) {
          return jsonResponse({ error: 'WebDAV 未配置，无法完成上传' }, 500);
        }
        const wdId = `wd_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        const publicId = `${wdId}.${fileExtension}`;
        const webdavPath = joinStoragePath(folderPath, publicId);
        const webdavResult = await uploadToWebDAV(
          completeBuffer.buffer,
          webdavPath,
          taskData.fileType || 'application/octet-stream',
          env
        );
        responseFileKey = `webdav:${publicId}`;
        metadataKey = responseFileKey;
        extraMetadata.webdavPath = normalizeWebDAVPath(
          webdavResult.path || webdavPath
        );
        uploadedFileInfo = {
          type: 'webdav',
          path: extraMetadata.webdavPath,
        };
      } else if (storageType === 'github') {
        if (!hasGitHubConfig(env)) {
          return jsonResponse({ error: 'GitHub 未配置，无法完成上传' }, 500);
        }
        const ghId = `github_${Date.now()}_${Math.random()
          .toString(36)
          .substring(2, 8)}`;
        const publicId = `${ghId}.${fileExtension}`;
        const githubStorageKey = joinStoragePath(folderPath, publicId);
        const githubResult = await uploadToGitHub(
          completeBuffer.buffer,
          normalizeGitHubStoragePath(githubStorageKey),
          taskData.fileName,
          taskData.fileType || 'application/octet-stream',
          env
        );
        responseFileKey = `github:${publicId}`;
        metadataKey = responseFileKey;
        extraMetadata.githubStorageKey = normalizeGitHubStoragePath(
          githubResult.storagePath || githubStorageKey
        );
        uploadedFileInfo = {
          type: 'github',
          storageKey: extraMetadata.githubStorageKey,
        };
      } else if (storageType === 'telegram') {
        const file = new File([completeBuffer], taskData.fileName, {
          type: taskData.fileType || 'application/octet-stream',
        });
        const result = await uploadToTelegram(file, env);
        if (!result.success) {
          return jsonResponse({ error: result.error }, 500);
        }
        metadataKey = `${result.fileId}.${fileExtension}`;
        taskData.telegramMessageId =
          result.messageId || taskData.telegramMessageId;
        responseFileKey = await buildTelegramDirectId(
          result.fileId,
          fileExtension,
          taskData.fileName,
          taskData.fileType,
          taskData.fileSize,
          taskData.telegramMessageId,
          env
        );
        extraMetadata.signedLink = shouldUseSignedTelegramLinks(env);
        extraMetadata.telegramFileId = result.fileId;
        telegramNoticePayload = {
          replyToMessageId: taskData.telegramMessageId || undefined,
          directLink: buildTelegramDirectLink(
            env,
            responseFileKey,
            new URL(request.url).origin
          ),
          fileId: result.fileId,
          messageId: taskData.telegramMessageId || undefined,
          fileName: taskData.fileName,
          fileSize: taskData.fileSize,
        };
        uploadedFileInfo = {
          type: 'telegram',
          messageId: result.messageId,
        };
      } else {
        return jsonResponse(
          { error: `不支持的存储类型：${storageType}` },
          400
        );
      }
    }

    // ============================================
    // 7. 写入文件元数据
    //    - 完整元数据写入 KV value，metadata 仅保留最小字段
    //    - 写入失败（含 applyShareOptions 抛错）→ 回滚已上传目标文件
    //    - 写入成功后立即清空 uploadedFileInfo
    // ============================================
    const shouldWriteMetadata =
      storageType === 'telegram' ? shouldWriteTelegramMetadata(env) : true;

    if (shouldWriteMetadata && metadataKey) {
      const fileMetadata = {
        TimeStamp: Date.now(),
        ListType: 'None',
        Label: 'None',
        liked: false,
        fileName: taskData.fileName,
        fileSize: taskData.fileSize,
        chunked: true,
        totalChunks,
        storageType,
        folderPath: folderPath || undefined,
        r2Key:
          storageType === 'r2'
            ? metadataKey.replace(/^r2:/, '')
            : undefined,
        telegramMessageId:
          storageType === 'telegram' ? taskData.telegramMessageId : undefined,
        ...extraMetadata,
      };

      try {
        await writeFileMetadata(
          env,
          metadataKey,
          fileMetadata,
          taskData.shareOptions
        );
        // 元数据已提交，立即清空，避免后续步骤异常误回滚
        uploadedFileInfo = null;
      } catch (metaError) {
        console.error(
          'Metadata write failed, rolling back uploaded file:',
          metaError
        );

        // 回滚已上传目标文件
        if (uploadedFileInfo) {
          await rollbackUploadedFile(uploadedFileInfo, env);
          uploadedFileInfo = null;
        }

        // 注意：不删除任务 KV、不清理分片，保留以便用户重试 complete。
        // 对于 R2 分支，也不删除任务 KV 和 pending multipart。

        const message = metaError?.message || '写入文件元数据失败。';
        const isSlugConflict = /已被占用/.test(message);
        return jsonResponse(
          {
            error: isSlugConflict
              ? `分享短链已被占用，上传已回滚：${message}`
              : `元数据写入失败，上传已回滚：${message}`,
            code: isSlugConflict ? 'SLUG_CONFLICT' : 'METADATA_WRITE_FAILED',
          },
          isSlugConflict ? 409 : 500
        );
      }
    }

    // ============================================
    // 8. Telegram 上传通知
    // ============================================
    if (storageType === 'telegram' && telegramNoticePayload) {
      const noticeResult = await sendTelegramUploadNotice(
        telegramNoticePayload,
        env
      );
      if (!noticeResult?.ok && !noticeResult?.skipped) {
        console.warn(
          'Chunked Telegram upload notice failed:',
          noticeResult?.data?.description ||
            noticeResult?.error ||
            'unknown error'
        );
      }
    }

    // ============================================
    // 9. 清理非 R2 临时分片（成功分发 + 元数据写入成功）
    // ============================================
    if (nonR2CleanupNeeded && nonR2ChunkBackend) {
      await cleanupUploadTask(uploadId, totalChunks, nonR2ChunkBackend, env).catch(
        (e) => console.error('Cleanup after success failed:', e)
      );
    }

    // ============================================
    // 10. 清理主任务跟踪记录 + 待处理 multipart 记录
    // ============================================
    await env.img_url.delete(`upload:${uploadId}`).catch(() => {});
    await removePendingMultipart(env, ownerId, uploadId).catch((e) => {
      console.error('removePendingMultipart on success failed:', e);
    });

    // 防御性兜底（正常情况下第 7 步已清空）
    uploadedFileInfo = null;

    return jsonResponse({
      success: true,
      src: `/file/${responseFileKey}`,
      fileName: taskData.fileName,
      fileSize: taskData.fileSize,
    });
  } catch (error) {
    // ============================================
    // 异常兜底
    // ============================================

    // 仅在 R2 multipart 未完成时尝试 abort
    if (
      taskData?.r2Multipart &&
      env.R2_BUCKET &&
      !r2Aborted &&
      !r2Completed &&
      taskData.storageMode === 'r2'
    ) {
      try {
        const mp = env.R2_BUCKET.resumeMultipartUpload(
          taskData.r2Multipart.key,
          taskData.r2Multipart.uploadId
        );
        await mp.abort();
        r2Aborted = true;
        if (ownerId && uploadId) {
          await removePendingMultipart(env, ownerId, uploadId).catch(() => {});
        }
      } catch (abortErr) {
        console.error('R2 abort on error:', abortErr);
      }
    }

    // 兜底回滚：若文件已上传但流程意外失败，主动删除
    if (uploadedFileInfo) {
      await rollbackUploadedFile(uploadedFileInfo, env);
      uploadedFileInfo = null;
      if (uploadId) {
        await env.img_url.delete(`upload:${uploadId}`).catch(() => {});
      }
    }

    console.error('Complete upload error:', error);
    return jsonResponse({ error: error.message || 'Unknown error' }, 500);
  }
}

// ============================================
// 工具函数
// ============================================

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getOwnerId(auth) {
  const raw =
    auth?.userId ??
    auth?.user?.id ??
    auth?.user?.email ??
    auth?.email ??
    null;

  if (raw === null || raw === undefined) return null;

  const value = String(raw).trim();
  return value || null;
}

function getMissingChunks(uploaded, total) {
  const uploadedSet = new Set(uploaded || []);
  const missing = [];
  for (let i = 0; i < total; i++) {
    if (!uploadedSet.has(i)) missing.push(i);
  }
  return missing;
}

function validateCompletionTarget(storageMode, fileSize) {
  if (storageMode === 'r2' && fileSize > 2 * GB) {
    return {
      ok: false,
      status: 413,
      code: 'FILE_TOO_LARGE',
      message: '文件大小超过 2GB 上限',
    };
  }
  if (['s3', 'webdav', 'github'].includes(storageMode) && fileSize > MAX_IN_MEMORY_ASSEMBLY) {
    return {
      ok: false,
      status: 413,
      code: 'FILE_TOO_LARGE',
      message: `文件大小超过内存拼装上限 ${formatBytes(MAX_IN_MEMORY_ASSEMBLY)}`,
    };
  }
  if (storageMode === 'telegram' && fileSize > 20 * MB) {
    return {
      ok: false,
      status: 400,
      code: 'TELEGRAM_CHUNK_UNSUPPORTED',
      message: 'Cloudflare Pages 上的 Telegram 网页上传仅适合 20MB 以内文件。',
    };
  }
  if (storageMode === 'discord' && fileSize > 25 * MB) {
    return {
      ok: false,
      status: 413,
      code: 'DISCORD_FILE_TOO_LARGE',
      message: 'Discord 默认上传上限按 25MB 处理。',
    };
  }
  if (storageMode === 'huggingface' && fileSize > 35 * MB) {
    return {
      ok: false,
      status: 413,
      code: 'HUGGINGFACE_FILE_TOO_LARGE',
      message: 'HuggingFace 普通上传链路建议控制在 35MB 以内。',
    };
  }
  return { ok: true };
}

function resolveChunkBackend(taskData, env) {
  if (taskData?.chunkBackend === 'r2' && env.R2_BUCKET) return 'r2';
  if (taskData?.chunkBackend === 'kv') return 'kv';
  return env.R2_BUCKET ? 'r2' : 'kv';
}

function getChunkObjectKey(uploadId, chunkIndex) {
  return `${TEMP_CHUNK_PREFIX}/${uploadId}/${chunkIndex}`;
}

async function readChunkData(uploadId, chunkIndex, chunkBackend, env) {
  if (chunkBackend === 'r2') {
    if (!env.R2_BUCKET) return null;
    const object = await env.R2_BUCKET.get(getChunkObjectKey(uploadId, chunkIndex));
    if (!object) return null;
    return await object.arrayBuffer();
  }
  return await env.img_url.get(`chunk:${uploadId}:${chunkIndex}`, {
    type: 'arrayBuffer',
  });
}

async function cleanupUploadTask(uploadId, totalChunks, chunkBackend, env) {
  try {
    if (chunkBackend === 'r2' && env.R2_BUCKET) {
      const toDelete = [];
      for (let i = 0; i < totalChunks; i++) {
        toDelete.push(env.R2_BUCKET.delete(getChunkObjectKey(uploadId, i)));
      }
      await Promise.allSettled(toDelete);
      return;
    }

    if (chunkBackend === 'kv') {
      const toDelete = [];
      for (let i = 0; i < totalChunks; i++) {
        toDelete.push(env.img_url.delete(`chunk:${uploadId}:${i}`));
      }
      await Promise.allSettled(toDelete);
    }
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}

/**
 * 从 user-multiparts:<ownerId> 移除该任务的待处理 multipart 记录。
 */
async function removePendingMultipart(env, ownerId, uploadId) {
  if (!env?.img_url || !ownerId || !uploadId) return;
  const key = `user-multiparts:${ownerId}`;
  try {
    const raw = await env.img_url.get(key, { type: 'json' });
    if (!Array.isArray(raw) || raw.length === 0) return;
    const filtered = raw.filter((e) => e && e.uploadId !== uploadId);
    if (filtered.length === raw.length) return;
    await env.img_url.put(key, JSON.stringify(filtered), {
      expirationTtl: USER_STATE_TTL,
    });
  } catch (err) {
    console.error('removePendingMultipart error:', err);
  }
}

/**
 * 安全写入文件元数据。
 *
 * Cloudflare KV metadata 上限 1024 字节。
 * - 完整元数据写入 KV value（JSON）
 * - metadata 仅保留列表索引所需的最小字段
 * - 写入前校验最小 metadata 的 UTF-8 字节数 <= KV_METADATA_SAFE_LIMIT
 */
async function writeFileMetadata(env, metadataKey, fileMetadata, shareOptions) {
  if (hasShareOptions(shareOptions)) {
    // ⚠️ shareOptions 分支的 metadata 大小校验由
    //    utils/share-options.js 负责。
    await applyShareOptions(env, metadataKey, fileMetadata, shareOptions);
    return;
  }

  const value = JSON.stringify(fileMetadata);
  const minimalMetadata = buildMinimalMetadata(fileMetadata);
  assertMetadataSizeSafe(minimalMetadata);

  await env.img_url.put(metadataKey, value, {
    metadata: minimalMetadata,
  });
}

/**
 * 校验 metadata 对象的 UTF-8 序列化大小不超过安全上限。
 * 供本模块与 utils/share-options.js 共用。
 */
export function assertMetadataSizeSafe(metadataObj) {
  const size = new TextEncoder().encode(
    JSON.stringify(metadataObj)
  ).byteLength;
  if (size > KV_METADATA_SAFE_LIMIT) {
    throw new Error(
      `KV metadata 过大 (${size} bytes > ${KV_METADATA_SAFE_LIMIT})`
    );
  }
  return size;
}

/**
 * 构造最小 metadata，用于 KV 列表索引。
 * 完整数据存放在 KV value 中。
 */
function buildMinimalMetadata(fileMetadata) {
  return {
    TimeStamp: fileMetadata.TimeStamp,
    ListType: fileMetadata.ListType,
    Label: fileMetadata.Label,
    liked: fileMetadata.liked,
    fileName: truncateForMetadata(fileMetadata.fileName, 180),
    fileSize: fileMetadata.fileSize,
    chunked: fileMetadata.chunked,
    storageType: fileMetadata.storageType,
  };
}

function truncateForMetadata(value, maxChars) {
  const s = String(value ?? '');
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars);
}

/**
 * 元数据写入失败时，删除已上传到目标存储的文件。
 *
 * 覆盖范围：
 * - R2 / S3：直接删除对象
 * - Telegram：删除消息（需要 TG_Chat_ID）
 * - Discord：删除消息（需要 DISCORD_BOT_TOKEN）
 * - HuggingFace / WebDAV / GitHub：调用 utils 中的 deleteFromXxx
 *
 * 回滚本身失败不抛出，避免掩盖原始错误。
 */
async function rollbackUploadedFile(uploadedFileInfo, env) {
  if (!uploadedFileInfo) return;
  try {
    switch (uploadedFileInfo.type) {
      case 'r2':
        if (uploadedFileInfo.key && env.R2_BUCKET) {
          await env.R2_BUCKET.delete(uploadedFileInfo.key);
          console.log(`Rolled back R2 object: ${uploadedFileInfo.key}`);
        }
        break;

      case 's3':
        if (
          uploadedFileInfo.key &&
          env.S3_ENDPOINT &&
          env.S3_ACCESS_KEY_ID
        ) {
          const s3 = createS3Client(env);
          await s3.deleteObject(uploadedFileInfo.key);
          console.log(`Rolled back S3 object: ${uploadedFileInfo.key}`);
        }
        break;

      case 'discord': {
        if (!uploadedFileInfo.channelId || !uploadedFileInfo.messageId) {
          console.warn(
            'Discord rollback skipped: missing channelId/messageId',
            uploadedFileInfo
          );
          break;
        }
        if (!env.DISCORD_BOT_TOKEN) {
          console.warn(
            `Discord rollback skipped: DISCORD_BOT_TOKEN not configured. ` +
              `Orphan message: channel=${uploadedFileInfo.channelId}, ` +
              `message=${uploadedFileInfo.messageId}`
          );
          break;
        }
        const resp = await fetch(
          `https://discord.com/api/v10/channels/${uploadedFileInfo.channelId}/messages/${uploadedFileInfo.messageId}`,
          {
            method: 'DELETE',
            headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` },
          }
        );
        if (!resp.ok && resp.status !== 404) {
          console.warn(`Discord rollback non-OK status: ${resp.status}`);
        } else {
          console.log(
            `Rolled back Discord message: ${uploadedFileInfo.messageId}`
          );
        }
        break;
      }

      case 'telegram':
        if (uploadedFileInfo.messageId && env.TG_Chat_ID) {
          const url = buildTelegramBotApiUrl(env, 'deleteMessage');
          const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: env.TG_Chat_ID,
              message_id: uploadedFileInfo.messageId,
            }),
          });
          const data = await resp.json().catch(() => ({}));
          if (!data.ok) {
            console.warn(
              `Telegram rollback failed: ${data.description || resp.status}`
            );
          } else {
            console.log(
              `Rolled back Telegram message: ${uploadedFileInfo.messageId}`
            );
          }
        } else if (!uploadedFileInfo.messageId) {
          console.warn(
            'Telegram rollback skipped: no messageId available',
            uploadedFileInfo
          );
        }
        break;

      case 'huggingface': {
        if (!uploadedFileInfo.path) {
          console.warn(
            'HuggingFace rollback skipped: missing path',
            uploadedFileInfo
          );
          break;
        }
        if (!hasHuggingFaceConfig(env)) {
          console.warn(
            `HuggingFace rollback skipped: HuggingFace 未配置。` +
              ` Orphan file: ${uploadedFileInfo.path}`
          );
          break;
        }
        await deleteFromHuggingFace(uploadedFileInfo.path, env);
        console.log(
          `Rolled back HuggingFace file: ${uploadedFileInfo.path}`
        );
        break;
      }

      case 'webdav': {
        if (!uploadedFileInfo.path) {
          console.warn(
            'WebDAV rollback skipped: missing path',
            uploadedFileInfo
          );
          break;
        }
        if (!hasWebDAVConfig(env)) {
          console.warn(
            `WebDAV rollback skipped: WebDAV 未配置。` +
              ` Orphan file: ${uploadedFileInfo.path}`
          );
          break;
        }
        await deleteFromWebDAV(uploadedFileInfo.path, env);
        console.log(`Rolled back WebDAV file: ${uploadedFileInfo.path}`);
        break;
      }

      case 'github': {
        if (!uploadedFileInfo.storageKey) {
          console.warn(
            'GitHub rollback skipped: missing storageKey',
            uploadedFileInfo
          );
          break;
        }
        if (!hasGitHubConfig(env)) {
          console.warn(
            `GitHub rollback skipped: GitHub 未配置。` +
              ` Orphan file: ${uploadedFileInfo.storageKey}`
          );
          break;
        }
        await deleteFromGitHub(uploadedFileInfo.storageKey, env);
        console.log(
          `Rolled back GitHub file: ${uploadedFileInfo.storageKey}`
        );
        break;
      }

      default:
        console.warn(
          'Unknown uploaded file type for rollback:',
          uploadedFileInfo.type
        );
    }
  } catch (rollbackErr) {
    console.error('rollbackUploadedFile error:', rollbackErr);
  }
}

async function uploadToTelegram(file, env) {
  const formData = new FormData();
  formData.append('chat_id', env.TG_Chat_ID);

  const { method: apiEndpoint, field } = getTelegramUploadMethodAndField(
    file.type
  );
  formData.append(field, file);

  try {
    const response = await fetch(buildTelegramBotApiUrl(env, apiEndpoint), {
      method: 'POST',
      body: formData,
    });
    const data = await response.json();

    if (!response.ok || !data.ok) {
      if (apiEndpoint === 'sendAudio') {
        const docFormData = new FormData();
        docFormData.append('chat_id', env.TG_Chat_ID);
        docFormData.append('document', file);

        const docResponse = await fetch(
          buildTelegramBotApiUrl(env, 'sendDocument'),
          {
            method: 'POST',
            body: docFormData,
          }
        );
        const docData = await docResponse.json();
        if (docResponse.ok && docData.ok) {
          const fileId = pickTelegramFileId(docData);
          if (!fileId)
            return {
              success: false,
              error: 'Telegram 已接收文件，但未返回可用的文件 ID',
            };
          return {
            success: true,
            fileId,
            messageId: docData?.result?.message_id,
          };
        }
      }
      return { success: false, error: data.description || '上传失败' };
    }

    const fileId = pickTelegramFileId(data);
    if (!fileId)
      return {
        success: false,
        error: 'Telegram 已接收文件，但未返回可用的文件 ID',
      };
    return {
      success: true,
      fileId,
      messageId: data?.result?.message_id,
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function getFileExtension(fileName) {
  const ext = String(fileName || '').split('.').pop()?.toLowerCase();
  if (!ext || ext === String(fileName || '').toLowerCase()) return 'bin';
  return ext.replace(/[^a-z0-9]/g, '') || 'bin';
}

function normalizeFolderPath(value) {
  const raw = String(value || '').replace(/\\/g, '/').trim();
  const output = [];
  for (const part of raw.split('/')) {
    const piece = part.trim();
    if (!piece || piece === '.') continue;
    if (piece === '..') {
      output.pop();
      continue;
    }
    output.push(piece);
  }
  return output.join('/');
}

function joinStoragePath(folderPath, fileName) {
  const normalizedFolder = normalizeFolderPath(folderPath);
  if (!normalizedFolder) return fileName;
  return `${normalizedFolder}/${fileName}`;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

async function buildTelegramDirectId(
  fileId,
  fileExtension,
  fileName,
  mimeType,
  fileSize,
  messageId,
  env
) {
  if (!shouldUseSignedTelegramLinks(env)) {
    return `${fileId}.${fileExtension}`;
  }
  return await createSignedTelegramFileId(
    {
      fileId,
      fileExtension,
      fileName,
      mimeType,
      fileSize,
      messageId,
    },
    env
  );
}