/**
 * Initialize chunked upload task.
 * POST /api/chunked-upload/init
 *
 * ================================================================
 * ⚠️ 部署必做项（代码无法自动完成，必须由部署方手动配置）
 * ================================================================
 * 请在 Cloudflare R2 控制台为该 Bucket 配置以下生命周期规则，
 * 否则"用户再也不回来"场景下 R2 存储将永久泄漏：
 *
 * 1) 对象生命周期规则
 *    - 前缀：chunk-upload/
 *    - 动作：Delete objects after 1 day
 *    - 目的：清理非 R2 原生分支的临时分片对象
 *
 * 2) 未完成 Multipart 上传生命周期规则
 *    - 前缀：留空（全局）
 *    - 动作：Abort incomplete multipart uploads after 1 day
 *    - 目的：清理 R2 原生 multipart upload
 *
 * 代码层惰性清理仅在"用户再次 init"时触发，无法覆盖
 * "用户再也不回来"的场景，因此上述规则是必需项，不是可选项。
 * ================================================================
 *
 * 修复要点：
 * 1. 强制鉴权，不再依赖 AUTH_REQUIRED 环境变量
 * 2. 强制校验 totalChunks === Math.ceil(fileSize / chunkSize)
 * 3. 限制 totalChunks 上限，限制 fileSize 上限
 * 4. 将 ownerId / chunkSize / chunkSizes / shareOptions 写入任务
 * 5. R2 存储模式预创建 Multipart Upload
 * 6. 拒绝访客分片上传
 * 7. fileName、fileSize、fileType、storageMode 严格格式校验
 * 8. GET 端点强制鉴权 + 归属校验
 * 9. 统一 getOwnerId(auth)，禁止使用 'admin' 兜底
 *
 * R2 泄漏修复：
 * 10. R2 multipart 创建后，若 KV 写入失败，立即 abort() 回滚
 *     （KV 未写入时 delete upload: 为幂等兜底）
 * 11. 每次 init 前惰性 abort 超过 90 分钟的待处理 multipart，
 *     不依赖任务 KV 是否存在
 * 12. 单用户并发任务数与每日任务数软限制
 * 13. 待处理 multipart 记录到 user-multiparts:<ownerId>，
 *     列表有硬上限，避免膨胀
 * 14. abort 失败保留条目以便重试，由生命周期规则兜底
 * 15. R2 createMultipartUpload 返回的 mp 缺 uploadId 时，
 *     尽力 abort，避免形成孤儿 multipart
 *
 * 本次 AI-3 修复：
 * 16. 统一从 utils/chunk-limits.js 导入大小限制常量
 * 17. S3 / WebDAV / GitHub 等非 R2 原生分支限制到 MAX_IN_MEMORY_ASSEMBLY
 * 18. GET 断点续传改为从 chunk-state:${uploadId}:${chunkIndex}
 *     或 R2 chunk-upload/${uploadId}/ 动态列出已上传分片
 *
 * ================================================================
 * 【P0 修复】前后端分片契约不一致
 * ================================================================
 * 旧实现用全局 CHUNK_SIZE = 50MB 强校验 totalChunks，但前端非 R2
 * 分支按 20MB/片 切片，导致非 R2 存储（S3/Discord/HF/GitHub/WebDAV）
 * 的 20MB~40MB 文件分片上传 100% 返回 CHUNK_COUNT_MISMATCH。
 *
 * 现改为：
 *   1. 先解析 chunkBackend（'r2' 或 'kv'）
 *   2. 用 resolveChunkSizeForBackend(chunkBackend === 'r2') 推导 chunkSize
 *      - r2 → 50MB
 *      - kv → 20MB（KV 单值上限 25MB，留安全余量）
 *   3. 用实际 chunkSize 计算 expectedTotalChunks 并校验
 *   4. 任务 KV 与响应写入实际 chunkSize，不再写全局 CHUNK_SIZE
 *
 * 前端 index.html 必须使用同一规则：
 *   this.r2Available ? CHUNK_SIZE_R2 : CHUNK_SIZE_KV
 * ================================================================
 */
import { checkAuthentication } from '../../utils/auth.js';
import { shouldWriteTelegramMetadata } from '../../utils/telegram.js';
import {
  findShareSlugOwner,
  hasShareOptions,
  parseShareOptions,
  validateShareOptions,
} from '../../utils/share-options.js';
import {
  resolveChunkSizeForBackend,
  MAX_IN_MEMORY_ASSEMBLY,
  MAX_FILE_SIZE_R2,
  MAX_TOTAL_CHUNKS,
  TELEGRAM_WEB_UPLOAD_LIMIT,
  DISCORD_UPLOAD_LIMIT,
  HUGGINGFACE_UPLOAD_LIMIT,
  GITHUB_UPLOAD_LIMIT,
} from '../../utils/chunk-limits.js';
import {
  listUploadedChunkIndices,
  listUploadedParts,
  resumeMapKey,
} from '../../utils/chunk-state.js';

// ============================================
// 配额与清理参数
// ============================================
// 单用户并发任务数（软限制：KV 无原子性，允许轻微超限，
// 只用于防误用；防恶意请使用 Cloudflare Rate Limiting / WAF）
//
// ⚠️ 前端联动：index.html 的并行上传 heavyPool 上限
//    （PARALLEL_MAX_HEAVY）与本值对齐，两者必须保持一致。
//    调大本值后若前端未同步调大，只是并发上不去（不会报错）；
//    调小本值后前端未同步调小，则会开始出现
//    429 CONCURRENT_LIMIT_EXCEEDED。
//
//    注意 Telegram 直传（POST /upload）不经过本文件，
//    不占用这里的并发名额，因此前端 lightPool 不受本值约束。
const MAX_CONCURRENT_TASKS_PER_USER = 5;

// 单用户每日 init 次数（软限制，同上）
const MAX_DAILY_TASKS_PER_USER = 100;

// 待处理 multipart 过期阈值（超过则惰性 abort）
const STALE_MULTIPART_MS = 90 * 60 * 1000; // 90 分钟

// 上传任务 KV TTL，与 STALE_MULTIPART_MS 对齐
// （避免窗口内任务 KV 已过期但 multipart 仍存在的情况；
//   惰性清理本身也不依赖任务 KV 是否存在）
const TASK_TTL_SECONDS = 90 * 60; // 5400 秒

// user-multiparts 列表硬上限，避免单值膨胀（KV 单值上限 25MB）
const MAX_PENDING_PER_USER = 20;

// 用户状态 KV（user-recent / user-multiparts / user-daily）TTL
const USER_STATE_TTL = 86400 * 2; // 2 天

const VALID_STORAGE_MODES = [
  'telegram',
  'r2',
  's3',
  'discord',
  'huggingface',
  'webdav',
  'github',
];

export async function onRequestPost(context) {
  const { request, env } = context;

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

    const ownerId = getOwnerId(auth);
    if (!ownerId) {
      return jsonResponse({ error: '无法识别用户身份，拒绝创建上传任务' }, 401);
    }

    // ============================================
    // 2. 解析 JSON body
    // ============================================
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const {
      fileName,
      fileSize,
      fileType,
      totalChunks,
      storageMode,
      shareOptions,
      // ↓↓ 服务端级断点续传字段：
      //    fileId   —— 前端算出的稳定文件指纹（头尾采样 SHA-256），
      //                 用于在服务端定位"同一个文件的上一次任务"
      //    uploadId —— 前端已知的任务 ID（同一次会话内重试时直接带上）
      fileId,
      uploadId: requestedUploadId,
    } = body || {};

    const normalizedFileId = normalizeFileId(fileId);
    const normalizedResumeId = normalizeUploadId(requestedUploadId);

    const folderPath = normalizeFolderPath(body?.folderPath || body?.folder || '');

    // ============================================
    // 3. 参数校验
    // ============================================
    if (typeof fileName !== 'string' || !fileName.trim()) {
      return jsonResponse({ error: 'fileName 缺失或格式错误' }, 400);
    }
    if (fileName.length > 512) {
      return jsonResponse({ error: 'fileName 过长' }, 400);
    }

    const normalizedFileSize = Number(fileSize);
    if (!Number.isInteger(normalizedFileSize) || normalizedFileSize <= 0) {
      return jsonResponse({ error: 'fileSize 必须为正整数' }, 400);
    }
    if (normalizedFileSize > MAX_FILE_SIZE_R2) {
      return jsonResponse(
        { error: `文件大小超过限制 (最大 ${MAX_FILE_SIZE_R2 / 1024 / 1024}MB)` },
        413
      );
    }

    const normalizedTotalChunks = Number(totalChunks);
    if (!Number.isInteger(normalizedTotalChunks) || normalizedTotalChunks <= 0) {
      return jsonResponse({ error: 'totalChunks 必须为正整数' }, 400);
    }
    if (normalizedTotalChunks > MAX_TOTAL_CHUNKS) {
      return jsonResponse(
        { error: `totalChunks 超过上限 (${MAX_TOTAL_CHUNKS})` },
        400
      );
    }

    // ============================================
    // 5. 存储模式与存储级大小限制
    // ============================================
    const normalizedStorage = VALID_STORAGE_MODES.includes(storageMode)
      ? storageMode
      : 'telegram';

    const validation = validateChunkUpload(normalizedStorage, normalizedFileSize);
    if (!validation.ok) {
      return jsonResponse(
        { error: validation.message, code: validation.code },
        validation.status
      );
    }

    if (normalizedStorage === 'r2' && !env.R2_BUCKET) {
      return jsonResponse(
        { error: 'R2 未配置，无法创建 R2 分片上传任务' },
        500
      );
    }

    // ============================================
    // 5.5 分享选项前置校验
    //
    // 此前 init 只是把 body.shareOptions 原样塞进任务 KV，全部校验都拖到
    // complete 阶段。后果是：非法短链 / 超长密码 / 已被占用的 slug 必须等
    // 用户传完全部数据、合并完成后才失败并回滚 —— 白白消耗一整轮上传流量。
    //
    // 这里在创建任何后端资源之前就把错误挡掉，与 `POST /upload`
    // （functions/upload.js）以及 /api/v1/upload 的口径完全对齐。
    // ============================================
    const parsedShareOptions = parseShareOptions(shareOptions || null);

    if (hasShareOptions(parsedShareOptions)) {
      const shareOptionError = validateShareOptions(parsedShareOptions);
      if (shareOptionError) {
        return jsonResponse({ error: shareOptionError }, 400);
      }

      if (
        parsedShareOptions.slug &&
        (await findShareSlugOwner(env, parsedShareOptions.slug))
      ) {
        return jsonResponse(
          { error: '自定义短链标识已被占用。', code: 'SLUG_CONFLICT' },
          409
        );
      }

      // Telegram 可以配置为跳过 KV 元数据写入（TELEGRAM_METADATA_MODE=off /
      // TELEGRAM_SKIP_METADATA=1），而分享字段正存放在那条记录里。与其让用户
      // 拿到一个"看起来受保护、实际毫无防护"的链接，不如现在就说清楚。
      if (
        normalizedStorage === 'telegram' &&
        !shouldWriteTelegramMetadata(env)
      ) {
        return jsonResponse(
          {
            error:
              '当前 Telegram 元数据写入已关闭（TELEGRAM_METADATA_MODE=off 或 TELEGRAM_SKIP_METADATA=1），无法设置有效期 / 密码 / 下载次数 / 短链。请改用其他存储后端，或恢复元数据写入。',
            code: 'SHARE_UNSUPPORTED_STORAGE',
          },
          409
        );
      }
    }

    // ============================================
    // 6. 【P0 修复】先确定分片暂存后端，再据此推导 chunkSize
    //    与 totalChunks 校验
    //
    //    分片大小必须由"分片暂存后端"决定，而不是全局 CHUNK_SIZE。
    //    否则前端非 R2 分支（20MB/片）与后端期望（50MB/片）对不上，
    //    所有非 R2 分片上传会 100% 返回 CHUNK_COUNT_MISMATCH。
    //
    //    规则（前后端必须完全一致）：
    //      - chunkBackend === 'r2' → 50MB
    //      - chunkBackend === 'kv' → 20MB（KV 单值上限 25MB）
    // ============================================
    const chunkBackend = resolveChunkBackend(env);
    const chunkSize = resolveChunkSizeForBackend(chunkBackend === 'r2');

    const expectedTotalChunks = Math.ceil(normalizedFileSize / chunkSize);
    if (normalizedTotalChunks !== expectedTotalChunks) {
      return jsonResponse(
        {
          error:
            `totalChunks 与 fileSize 不一致：声明 ${normalizedTotalChunks}，` +
            `期望 ${expectedTotalChunks}（fileSize=${normalizedFileSize}, ` +
            `chunkSize=${chunkSize}, chunkBackend=${chunkBackend}）`,
        code: 'CHUNK_COUNT_MISMATCH',
      },
      400
    );
  }

    // ============================================
    // 6.5 【服务端级断点续传】尝试复用未过期的上传任务
    //
    // 放在配额检查之前是有意为之：
    //   - 续传不应消耗每日配额，否则用户重试几次就把 100 次/天耗光
    //   - 续传不应占用并发名额，任务本来就还活着
    //   - 续传不创建新的 multipart，避免同一文件出现多条 R2 未完成上传
    //
    // 命中时直接返回服务端权威进度（uploadedChunks / parts），
    // 前端据此跳过已上传分片 —— 换设备、换浏览器、清缓存都能续。
    // ============================================
    const resumedResponse = await tryResumeTask(env, ownerId, {
      fileId: normalizedFileId,
      uploadId: normalizedResumeId,
      fileName,
      fileSize: normalizedFileSize,
      totalChunks: normalizedTotalChunks,
      chunkSize,
      storageMode: normalizedStorage,
      folderPath,
    });
    if (resumedResponse) return resumedResponse;

    // ============================================
    // 7. 惰性清理 + 单用户配额检查
    //    注意：并发/每日为【软限制】，KV 最终一致性下可能超限，
    //          仅防误用；防恶意请依赖 Cloudflare Rate Limiting。
    // ============================================
    await cleanupStaleMultiparts(env, ownerId);

    const rateCheck = await checkUserRateLimits(env, ownerId);
    if (!rateCheck.ok) {
      return jsonResponse(
        { error: rateCheck.message, code: rateCheck.code },
        rateCheck.status
      );
    }

    // ============================================
    // 8. 生成 uploadId
    //    （chunkBackend 已在第 6 步提前解析，这里不再重复）
    // ============================================
    const uploadId = generateUploadId();

    // ============================================
    // 9. R2 存储模式预创建 Multipart Upload
    // ============================================
    let mp = null;
    let r2Multipart = null;
    if (normalizedStorage === 'r2' && env.R2_BUCKET) {
      const ext = getFileExtension(fileName);
      const r2Id = `r2_${Date.now()}_${Math.random()
        .toString(36)
        .substring(2, 8)}`;
      const r2Key = folderPath
        ? `${folderPath}/${r2Id}.${ext}`
        : `${r2Id}.${ext}`;

      try {
        mp = await env.R2_BUCKET.createMultipartUpload(r2Key, {
          httpMetadata: {
            contentType: fileType || 'application/octet-stream',
          },
          customMetadata: {
            fileName: encodeURIComponent(fileName),
            uploadId,
            ownerId,
          },
        });

        if (!mp || !mp.uploadId) {
          // mp 可能存在但缺 uploadId，
          // 尽力 abort（可能因缺 uploadId 而失败，忽略异常）。
          // 若 abort 也失败，最终由 R2 生命周期规则兜底。
          if (mp && typeof mp.abort === 'function') {
            try {
              await mp.abort();
            } catch (abortErr) {
              console.warn(
                'Abort after missing uploadId failed (will rely on lifecycle rule):',
                abortErr?.message || abortErr
              );
            }
          }
          return jsonResponse(
            { error: 'R2 createMultipartUpload 未返回 uploadId' },
            500
          );
        }

        r2Multipart = {
          key: r2Key,
          uploadId: mp.uploadId,
        };
      } catch (err) {
        console.error('R2 createMultipartUpload error:', err);
        return jsonResponse(
          { error: `R2 初始化 multipart 失败: ${err.message || err}` },
          500
        );
      }
    }

    // ============================================
    // 10. 写入任务到 KV
    //    - KV 写入失败时：立即 abort 刚创建的 multipart（关键回滚）
    //    - delete upload: 为幂等兜底（正常情况 KV 未写入）
    //    - 【P0 修复】写入实际 chunkSize，不再写全局 CHUNK_SIZE
    // ============================================
    const uploadTask = {
      uploadId,
      ownerId,
      fileName,
      fileSize: normalizedFileSize,
      fileType: fileType || 'application/octet-stream',
      totalChunks: normalizedTotalChunks,
      chunkSize,
      storageMode: normalizedStorage,
      folderPath,
      chunkBackend,
      // 文件指纹：服务端续传靠它把"下一次上传"映射到"上一次任务"
      fileId: normalizedFileId || undefined,
      uploadedChunks: [],
      chunkSizes: {},
      r2Multipart,
      // 写规范化后的结果而非原始 body：complete 阶段拿到的必然是干净数据，
      // 不必重复做一次 parse/validate。
      shareOptions: hasShareOptions(parsedShareOptions)
        ? parsedShareOptions
        : null,
      createdAt: Date.now(),
      status: 'pending',
    };

    try {
      await env.img_url.put(`upload:${uploadId}`, JSON.stringify(uploadTask), {
        expirationTtl: TASK_TTL_SECONDS,
      });
    } catch (err) {
      // 关键回滚：KV 写入失败 → abort 刚创建的 multipart
      if (mp) {
        try {
          await mp.abort();
          console.log(
            `Aborted R2 multipart after KV failure: uploadId=${uploadId}, r2UploadId=${r2Multipart.uploadId}`
          );
        } catch (abortErr) {
          console.error(
            'Abort multipart after KV failure failed:',
            abortErr
          );
          // abort 也失败：交给生命周期规则兜底
        }
      }
      // 幂等 delete：正常情况 KV 未写入，此处是保险
      await env.img_url.delete(`upload:${uploadId}`).catch(() => {});
      console.error('KV write failed after multipart creation:', err);
      return jsonResponse(
        { error: `任务记录失败: ${err.message || err}` },
        500
      );
    }

    // ============================================
    // 11. 后续副作用：失败不阻塞主流程
    // ============================================
    if (r2Multipart) {
      await addPendingMultipart(env, ownerId, {
        uploadId,
        key: r2Multipart.key,
        r2UploadId: r2Multipart.uploadId,
        createdAt: Date.now(),
      }).catch((err) => {
        console.error('addPendingMultipart failed:', err);
      });
    }

    await recordUserInit(env, ownerId, uploadId, rateCheck).catch((err) => {
      console.error('recordUserInit failed:', err);
    });

    // 登记 fileId → uploadId，供后续（可能来自另一台设备）的续传定位
    await writeResumeMap(env, ownerId, normalizedFileId, uploadId).catch(
      (err) => console.error('writeResumeMap failed:', err)
    );

    return jsonResponse({
      success: true,
      uploadId,
      chunkSize,
      totalChunks: normalizedTotalChunks,
      chunkBackend,
      r2Multipart: !!r2Multipart,
      resumed: false,
      uploadedChunks: [],
      parts: [],
    });
  } catch (error) {
    console.error('Init upload error:', error);
    return jsonResponse({ error: error.message || 'Unknown error' }, 500);
  }
}

/**
 * GET /api/chunked-upload/init?uploadId=xxx
 * 查询上传任务状态（用于断点续传），强制鉴权 + 归属校验。
 */
export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const auth = await checkAuthentication(context);
    if (!auth || !auth.authenticated) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    if (!env.img_url) {
      return jsonResponse(
        { error: 'KV binding img_url is required.' },
        500
      );
    }

    const ownerId = getOwnerId(auth);
    if (!ownerId) {
      return jsonResponse({ error: '无法识别用户身份，拒绝访问上传任务' }, 401);
    }

    const url = new URL(request.url);
    const uploadId = url.searchParams.get('uploadId');

    if (
      !uploadId ||
      typeof uploadId !== 'string' ||
      !/^[a-f0-9]{16,64}$/i.test(uploadId)
    ) {
      return jsonResponse({ error: 'uploadId 格式错误' }, 400);
    }

    const taskData = await env.img_url.get(`upload:${uploadId}`, {
      type: 'json',
    });
    if (!taskData) {
      return jsonResponse({ error: '上传任务不存在或已过期' }, 404);
    }

    if (!taskData.ownerId || taskData.ownerId !== ownerId) {
      return jsonResponse({ error: '无权访问该上传任务' }, 403);
    }

    const uploadedChunks = await listUploadedChunks(env, uploadId, taskData);
    const parts =
      taskData.storageMode === 'r2' && taskData.r2Multipart?.uploadId
        ? await listUploadedParts(env, uploadId)
        : [];

    const safeTask = {
      uploadId: taskData.uploadId,
      fileName: taskData.fileName,
      fileSize: taskData.fileSize,
      fileType: taskData.fileType,
      totalChunks: taskData.totalChunks,
      chunkSize: taskData.chunkSize,
      storageMode: taskData.storageMode,
      folderPath: taskData.folderPath,
      chunkBackend: taskData.chunkBackend,
      uploadedChunks,
      // R2 原生 multipart 的 etag 清单：前端拿到就能直接 complete，
      // 不必为了凑齐 parts 重传已经进 R2 的分片。
      parts,
      uploadedParts: parts,
      chunkSizes: {},
      createdAt: taskData.createdAt,
      status: taskData.status,
    };

    return jsonResponse({
      success: true,
      ...safeTask,
    });
  } catch (error) {
    console.error('Get upload task error:', error);
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

// ============================================
// 服务端级断点续传
// ============================================

/**
 * 文件指纹格式校验。
 *
 * fileId 会拼进 KV key（`resume-map:<ownerId>:<fileId>`），
 * 因此必须限制字符集，避免构造出越界的 key（例如带上 ':' 去命中别人的映射）。
 * 前端 computeFileId 产出的是 32 位 hex + `-` + size，稳定落在这个范围内。
 */
function normalizeFileId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{8,128}$/.test(trimmed) ? trimmed : null;
}

function normalizeUploadId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[a-f0-9]{16,64}$/i.test(trimmed) ? trimmed : null;
}

async function writeResumeMap(env, ownerId, fileId, uploadId) {
  if (!env?.img_url || !ownerId || !fileId || !uploadId) return;
  await env.img_url.put(resumeMapKey(ownerId, fileId), uploadId, {
    expirationTtl: TASK_TTL_SECONDS,
  });
}

/**
 * 尝试复用一个尚未过期的上传任务。
 *
 * @returns {Response|null} 命中续传时返回响应，否则返回 null 让主流程新建任务。
 *
 * 判定顺序：
 *   1. 定位候选 uploadId（前端显式传入优先，其次 fileId 映射）
 *   2. 归属校验 —— 绝不允许 A 用户续传 B 用户的任务
 *   3. 参数一致性校验 —— 文件大小/名称/存储/分片数/目录任一不同就放弃复用。
 *      这一步是正确性的底线：旧分片是按旧参数切的，拼进新文件必然损坏。
 *   4. 查询服务端真实进度并返回
 */
async function tryResumeTask(env, ownerId, req) {
  if (!env?.img_url) return null;

  let candidateId = req.uploadId;

  if (!candidateId && req.fileId) {
    try {
      const mapped = await env.img_url.get(resumeMapKey(ownerId, req.fileId));
      candidateId = normalizeUploadId(mapped);
    } catch (err) {
      console.error('read resume-map failed:', err);
    }
  }

  if (!candidateId) return null;

  let taskData;
  try {
    taskData = await env.img_url.get(`upload:${candidateId}`, { type: 'json' });
  } catch (err) {
    console.error('read upload task for resume failed:', err);
    return null;
  }

  if (!taskData || taskData.status === 'completed') {
    // 映射指向的任务已不存在/已完成：顺手清掉，避免下次再查一次空
    if (req.fileId) {
      await env.img_url.delete(resumeMapKey(ownerId, req.fileId)).catch(() => {});
    }
    return null;
  }

  // ---- 归属校验 ----
  if (!taskData.ownerId || taskData.ownerId !== ownerId) {
    return null;
  }

  // ---- 参数一致性校验 ----
  if (Number(taskData.fileSize) !== req.fileSize) return null;
  if (taskData.fileName !== req.fileName) return null;
  if (taskData.storageMode !== req.storageMode) return null;
  if (Number(taskData.totalChunks) !== req.totalChunks) return null;
  if (Number(taskData.chunkSize || 0) !== req.chunkSize) return null;
  if ((taskData.folderPath || '') !== (req.folderPath || '')) return null;

  // 已过期任务不该被续上（KV TTL 理论上已经删掉，这里是双保险）
  if (
    Number.isFinite(taskData.createdAt) &&
    Date.now() - taskData.createdAt > STALE_MULTIPART_MS
  ) {
    return null;
  }

  // ---- 补齐 fileId 并刷新 TTL ----
  //
  // 续传会拉长任务生命周期：不重置 TTL 的话，任务 KV 会在 90 分钟后过期，
  // 而分片数据可能还在，导致"分片存在但任务没了"的孤儿状态。
  //
  // ⚠️ 只有确实带了 fileId 才写这一行。直接赋 undefined 会让
  //    JSON.stringify 把该字段整个丢掉，等于把已登记的指纹从任务里抹除，
  //    下一次按 fileId 续传就再也命中不了。
  if (req.fileId && taskData.fileId !== req.fileId) {
    taskData.fileId = req.fileId;
  }
  await env.img_url
    .put(`upload:${candidateId}`, JSON.stringify(taskData), {
      expirationTtl: TASK_TTL_SECONDS,
    })
    .catch((err) => console.error('refresh task TTL failed:', err));
  if (req.fileId) {
    await writeResumeMap(env, ownerId, req.fileId, candidateId).catch(
      (err) => console.error('refresh resume-map failed:', err)
    );
  }

  // ---- 查询服务端真实进度 ----
  const uploadedChunks = await listUploadedChunkIndices(
    env,
    candidateId,
    taskData
  );
  const parts =
    taskData.storageMode === 'r2' && taskData.r2Multipart?.uploadId
      ? await listUploadedParts(env, candidateId)
      : [];

  console.log(
    `Resume chunked upload: uploadId=${candidateId}, ` +
      `chunks=${uploadedChunks.length}/${taskData.totalChunks}, parts=${parts.length}`
  );

  return jsonResponse({
    success: true,
    uploadId: candidateId,
    chunkSize: taskData.chunkSize,
    totalChunks: taskData.totalChunks,
    chunkBackend: taskData.chunkBackend,
    r2Multipart: !!taskData.r2Multipart,
    resumed: true,
    uploadedChunks,
    parts,
    // 与 GET 端点 / safeTask 保持同样的字段名：
    // 前端 extractDoneChunks 会嗅探 uploadedParts，extractDoneParts 嗅探 parts，
    // 两个名字都给，避免任一侧嗅探失败退化成全量重传。
    uploadedParts: parts,
    fileName: taskData.fileName,
    fileSize: taskData.fileSize,
    storageMode: taskData.storageMode,
    folderPath: taskData.folderPath || '',
  });
}

function getOwnerId(auth) {
  const raw =
    auth?.userId ??
    auth?.user?.id ??
    auth?.user?.email ??
    auth?.email ??
    (typeof auth?.user === 'string' ? auth.user : null) ??
    null;

  if (raw === null || raw === undefined) return null;

  const value = String(raw).trim();
  return value || null;
}

function resolveChunkBackend(env) {
  const mode = String(env.CHUNK_BACKEND || 'auto').toLowerCase();
  if (mode === 'kv') return 'kv';
  if (mode === 'r2') return env.R2_BUCKET ? 'r2' : 'kv';
  return env.R2_BUCKET ? 'r2' : 'kv';
}

function generateUploadId() {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
}

function getFileExtension(fileName) {
  const ext = String(fileName || '').split('.').pop()?.toLowerCase();
  if (!ext || ext === String(fileName || '').toLowerCase()) return 'bin';
  return ext.replace(/[^a-z0-9]/g, '') || 'bin';
}

function validateChunkUpload(storageMode, fileSize) {
  // 全局硬上限：R2 原生 multipart 上限
  if (fileSize > MAX_FILE_SIZE_R2) {
    return {
      ok: false,
      status: 413,
      code: 'FILE_TOO_LARGE',
      message: `文件大小超过限制 (最大 ${MAX_FILE_SIZE_R2 / 1024 / 1024}MB)`,
    };
  }

  // Telegram 网页上传限制
  if (storageMode === 'telegram' && fileSize > TELEGRAM_WEB_UPLOAD_LIMIT) {
    return {
      ok: false,
      status: 400,
      code: 'TELEGRAM_CHUNK_UNSUPPORTED',
      message:
        'Cloudflare Pages 上的 Telegram 网页上传仅适合 20MB 以内文件。' +
        '更大的文件请切换到 R2/S3/WebDAV/GitHub。',
    };
  }

  // Discord 限制
  if (storageMode === 'discord' && fileSize > DISCORD_UPLOAD_LIMIT) {
    return {
      ok: false,
      status: 413,
      code: 'DISCORD_FILE_TOO_LARGE',
      message: 'Discord 默认上传上限按 25MB 处理；更大的文件请使用 R2/S3/WebDAV/GitHub。',
    };
  }

  // HuggingFace 普通上传限制
  if (storageMode === 'huggingface' && fileSize > HUGGINGFACE_UPLOAD_LIMIT) {
    return {
      ok: false,
      status: 413,
      code: 'HUGGINGFACE_FILE_TOO_LARGE',
      message:
        'HuggingFace 普通上传链路建议控制在 35MB 以内；更大的文件请使用 LFS 或其他对象存储。',
    };
  }

  // GitHub：原限制 100MB，但当前非 R2 原生分支走内存拼装，
  // 因此实际取 min(GITHUB_UPLOAD_LIMIT, MAX_IN_MEMORY_ASSEMBLY)
  if (storageMode === 'github') {
    const githubLimit = Math.min(GITHUB_UPLOAD_LIMIT, MAX_IN_MEMORY_ASSEMBLY);
    if (fileSize > githubLimit) {
      return {
        ok: false,
        status: 413,
        code: 'GITHUB_FILE_TOO_LARGE',
        message:
          `GitHub Releases 当前走内存拼装，上限 ${githubLimit / 1024 / 1024}MB，` +
          `请使用 R2 或其他支持原生分片的存储。`,
      };
    }
  }

  // S3 / WebDAV：非 R2 原生分支，必须在 complete 阶段内存拼装，
  // 因此强制限制到 MAX_IN_MEMORY_ASSEMBLY。
  if (
    (storageMode === 's3' || storageMode === 'webdav') &&
    fileSize > MAX_IN_MEMORY_ASSEMBLY
  ) {
    return {
      ok: false,
      status: 413,
      code: 'IN_MEMORY_ASSEMBLY_LIMIT_EXCEEDED',
      message:
        `该存储走内存拼装，上限 ${MAX_IN_MEMORY_ASSEMBLY / 1024 / 1024}MB，请使用 R2。`,
    };
  }

  // R2 原生模式允许到 MAX_FILE_SIZE_R2，已在全局检查中覆盖。
  return { ok: true };
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

/**
 * 动态列出已上传分片索引（GET 断点续传查询）。
 *
 * 键名约定统一收敛到 utils/chunk-state.js：
 * - KV 暂存后端：      chunk:<uploadId>:<chunkIndex>
 * - R2 暂存后端：      chunk-upload/<uploadId>/<chunkIndex>
 * - R2 原生 multipart：part-state:<uploadId>:<chunkIndex>
 *
 * ⚠️ 历史 bug：本函数原按 `chunk-state:${uploadId}:` 前缀 list，
 *    而 chunk.js 写入的是 `chunk:${uploadId}:${chunkIndex}` —— 前缀对不上，
 *    服务端查询永远返回空数组，断点续传因此实质失效。现已统一。
 *
 * list 失败不抛错，返回 []，允许前端重新上传。
 */
async function listUploadedChunks(env, uploadId, taskData) {
  return await listUploadedChunkIndices(env, uploadId, taskData);
}

// ============================================
// 待处理 Multipart 惰性清理
// ============================================

/**
 * 惰性清理：abort 超过 STALE_MULTIPART_MS 的待处理 multipart。
 *
 * 重要设计：
 * - 不依赖 `upload:${uploadId}` 任务 KV 是否存在（可能已过期），
 *   只依赖 user-multiparts 条目中的 r2Multipart 信息。
 * - abort 失败时保留条目以便下次重试。
 * - abort 成功时删除对应任务 KV（幂等）并从列表移除。
 *
 * 该函数是"用户仍活跃"场景下的兜底；"用户再也不回来"的场景
 * 必须依赖 R2 生命周期规则（见文件头注释）。
 */
async function cleanupStaleMultiparts(env, ownerId) {
  if (!env.R2_BUCKET) return;

  const key = `user-multiparts:${ownerId}`;
  let pending;
  try {
    pending = await env.img_url.get(key, { type: 'json' });
  } catch {
    return;
  }
  if (!Array.isArray(pending) || pending.length === 0) return;

  const now = Date.now();
  const stillPending = [];
  let abortedCount = 0;

  for (const entry of pending) {
    if (!entry || typeof entry !== 'object') continue;
    if (!entry.key || !entry.r2UploadId) continue;

    // 未到过期时间 → 保留
    if (now - (entry.createdAt || 0) < STALE_MULTIPART_MS) {
      stillPending.push(entry);
      continue;
    }

    // 已过期：尝试 abort（不依赖任务 KV 是否存在）
    let aborted = false;
    try {
      const mp = env.R2_BUCKET.resumeMultipartUpload(
        entry.key,
        entry.r2UploadId
      );
      await mp.abort();
      aborted = true;
      abortedCount++;
      console.log(
        `Lazy-aborted stale R2 multipart: uploadId=${entry.uploadId}, r2UploadId=${entry.r2UploadId}`
      );
    } catch (err) {
      // abort 可能因为"已 complete / 已 abort / 网络异常"失败
      // → 保留条目，下次重试，最终由生命周期规则兜底
      console.warn(
        `Lazy-abort stale multipart failed (${entry.r2UploadId}), will retry:`,
        err?.message || err
      );
      stillPending.push(entry);
      continue;
    }

    if (aborted) {
      // 清理任务 KV（可能已过期，delete 幂等）
      if (entry.uploadId) {
        await env.img_url.delete(`upload:${entry.uploadId}`).catch(() => {});
      }
      // 不 push → 自动从列表移除
    }
  }

  // 写回更新后的列表（TTL 续期）
  await env.img_url
    .put(key, JSON.stringify(stillPending), { expirationTtl: USER_STATE_TTL })
    .catch((err) => {
      console.error('Update user-multiparts failed:', err);
    });

  if (abortedCount > 0) {
    console.log(
      `Lazy-cleanup aborted ${abortedCount} stale multipart(s) for user=${ownerId}`
    );
  }
}

// ============================================
// 单用户配额（软限制）
// ============================================

/**
 * 检查单用户并发与每日配额。
 *
 * ⚠️ 软限制说明：
 * - KV 无原子操作，并发 init 请求可能同时通过检查
 * - 这是"防误用"限制，不是"防恶意攻击"
 * - 真硬限制请使用 Cloudflare Rate Limiting 规则或 WAF
 */
async function checkUserRateLimits(env, ownerId) {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const dailyKey = `user-daily:${ownerId}:${today}`;

  // ---- 每日配额 ----
  let dailyCount = 0;
  try {
    const raw = await env.img_url.get(dailyKey);
    dailyCount = parseInt(raw || '0', 10) || 0;
  } catch {
    dailyCount = 0;
  }
  if (dailyCount >= MAX_DAILY_TASKS_PER_USER) {
    return {
      ok: false,
      status: 429,
      code: 'DAILY_LIMIT_EXCEEDED',
      message: `每日上传任务数已达上限 (${MAX_DAILY_TASKS_PER_USER})，请明日再试。`,
    };
  }

  // ---- 并发配额 ----
  let recentEntries = [];
  try {
    const raw = await env.img_url.get(`user-recent:${ownerId}`, {
      type: 'json',
    });
    if (Array.isArray(raw)) recentEntries = raw;
  } catch {
    recentEntries = [];
  }

  // 过滤：仍在窗口内 + 任务 KV 仍存在
  const activeRecent = [];
  for (const entry of recentEntries) {
    if (!entry || typeof entry !== 'object') continue;
    const ts = Number(entry.ts);
    const id = String(entry.uploadId || '');
    if (!Number.isFinite(ts) || now - ts > STALE_MULTIPART_MS) continue;
    if (!id) continue;

    let exists = null;
    try {
      exists = await env.img_url.get(`upload:${id}`);
    } catch {
      exists = null;
    }
    if (exists) activeRecent.push({ ts, uploadId: id });
  }

  if (activeRecent.length >= MAX_CONCURRENT_TASKS_PER_USER) {
    return {
      ok: false,
      status: 429,
      code: 'CONCURRENT_LIMIT_EXCEEDED',
      message:
        `并发上传任务数已达上限 (${MAX_CONCURRENT_TASKS_PER_USER})，` +
        `请等待其他任务完成或过期后再试。`,
    };
  }

  return { ok: true, dailyKey, dailyCount, activeRecent };
}

/**
 * 记录本次 init：更新 user-recent 与 user-daily 计数。
 */
async function recordUserInit(env, ownerId, uploadId, rateInfo) {
  const now = Date.now();
  const { dailyKey, dailyCount, activeRecent } = rateInfo || {};

  const updatedRecent = [
    ...(Array.isArray(activeRecent) ? activeRecent : []),
    { ts: now, uploadId },
  ];

  await env.img_url.put(
    `user-recent:${ownerId}`,
    JSON.stringify(updatedRecent),
    { expirationTtl: USER_STATE_TTL }
  );

  if (dailyKey) {
    await env.img_url.put(dailyKey, String((dailyCount || 0) + 1), {
      expirationTtl: USER_STATE_TTL,
    });
  }
}

/**
 * 把新创建的 multipart 记录到 user-multiparts:<ownerId>。
 *
 * - 列表硬上限 MAX_PENDING_PER_USER，超过丢弃最旧条目
 * - 过期条目由 cleanupStaleMultiparts 处理
 */
async function addPendingMultipart(env, ownerId, entry) {
  const key = `user-multiparts:${ownerId}`;
  let list = [];
  try {
    const raw = await env.img_url.get(key, { type: 'json' });
    if (Array.isArray(raw)) list = raw;
  } catch {
    list = [];
  }

  list.push(entry);

  // 硬上限，防列表膨胀（KV 单值 25MB 限制）
  if (list.length > MAX_PENDING_PER_USER) {
    list = list.slice(-MAX_PENDING_PER_USER);
  }

  await env.img_url.put(key, JSON.stringify(list), {
    expirationTtl: USER_STATE_TTL,
  });
}