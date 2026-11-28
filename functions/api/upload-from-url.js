import { envValue } from '../utils/env-config.js';
import { createS3Client } from "../utils/s3client.js";
import { uploadToDiscord } from "../utils/discord.js";
import { hasHuggingFaceConfig, uploadToHuggingFace } from "../utils/huggingface.js";
import { hasWebDAVConfig, normalizeWebDAVPath, uploadToWebDAV } from "../utils/webdav.js";
import { getGitHubConfig, hasGitHubConfig, normalizeGitHubStoragePath, uploadToGitHub } from "../utils/github.js";
import {
  buildTelegramDirectLink,
  buildTelegramBotApiUrl,
  createSignedTelegramFileId,
  deleteTelegramMessagesBatch,
  getTelegramUploadMethodAndField,
  pickTelegramFileId,
  sendTelegramUploadNotice,
  shouldUseSignedTelegramLinks,
  shouldWriteTelegramMetadata,
  SIGNED_LINK_SECRET_MISSING_MESSAGE,
} from "../utils/telegram.js";
import { checkAuthentication, isAuthRequired } from "../utils/auth.js";
import { checkGuestUpload, incrementGuestCount } from "../utils/guest.js";
import { getRecordWithKey, putRecordIndex, putKvFileMetadata } from "../utils/file-record.js";
import {
  applyShareOptions,
  attachShareSummary,
  buildShareSummary,
  extractUploadKey,
  findShareSlugOwner,
  hasShareOptions,
  parseShareOptions,
  validateShareOptions,
} from "../utils/share-options.js";
import {
  CHUNK_SIZE_R2,
  CHUNK_SIZE_TELEGRAM,
  DISCORD_UPLOAD_LIMIT,
  HUGGINGFACE_UPLOAD_LIMIT,
  MAX_FILE_SIZE_R2,
  MAX_IN_MEMORY_ASSEMBLY,
  MAX_TOTAL_CHUNKS,
  TELEGRAM_CHUNKED_MAX_FILE_SIZE,
  TELEGRAM_WEB_UPLOAD_LIMIT,
} from "../utils/chunk-limits.js";
import { parseByteLength } from "../utils/download-length.js";
import { MAX_REDIRECTS, validateRedirectLocation, validateRemoteUrl } from "../utils/ssrf-guard.js";
import { retryR2Op } from "../utils/r2-retry.js";

const MB = 1024 * 1024;
const R2_URL_UPLOAD_LIMIT = 250 * MB;
const R2_URL_PART_SIZE = 8 * MB;
const R2_URL_UPLOAD_CONCURRENCY = 2;
const TELEGRAM_URL_CHUNKED_LIMIT = 180 * MB;
const SOURCE_IDLE_TIMEOUT = 45_000;
const SOURCE_MAX_DURATION = 5 * 60_000;
const PROBE_TIMEOUT_MS = 12_000;
const EOF_GRACE_TIMEOUT_MS = 1_500;
const STREAM_HEARTBEAT_MS = 8_000;
const FETCH_MAX_RETRIES = 2;
const MAX_RESUME_ATTEMPTS = 2;
const TELEGRAM_UPLOAD_TIMEOUT_MS = 55_000;
const TELEGRAM_RETRY_DELAY_MS = 600;
const BACKEND_RETRY_DELAY_MS = 500;
const PROGRESS_TYPE = "application/x-ndjson";
const AUTO_STORAGE_ORDER = ["r2", "s3", "github", "discord", "huggingface", "webdav", "telegram"];

class RemoteUploadError extends Error {
  constructor(status, message, extra = null) {
    super(message);
    this.status = status;
    if (extra && typeof extra === "object") {
      Object.assign(this, extra);
    }
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = await checkAuthentication(context);
  // 仅当「要求认证」且用户真实登录时才视为管理员；未配置认证（开放实例）时
  // 匿名访客应走普通访客上传流程（受每日限额约束、禁止抢占 slug / 发布受保护链接），
  // 而非被当成管理员绕过一切限制。
  const isAdmin = Boolean(auth?.authenticated) && isAuthRequired(env);

  let guestLimit = Infinity;
  if (!isAdmin) {
    const guest = await checkGuestUpload(request, env, 0);
    if (!guest.allowed) {
      return jsonResponse({
        error: guest.reason,
        code: guest.code || "GUEST_UPLOAD_FORBIDDEN",
        requireLogin: true,
      }, guest.status || 403);
    }
    guestLimit = guest.maxFileSize;
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (String(body?.action || "").toLowerCase() === "probe") {
    return probeRemoteUrl(context, body, {
      signal: request.signal,
      guestLimit,
      isAuthenticated: Boolean(auth?.authenticated),
    });
  }

  const shareOptions = readShareOptionsFromRequest(body);
  if (shareOptions) {
    if (!isAdmin) return jsonResponse({ error: "仅有管理员可以设置分享保护。" }, 403);
    if (!env.img_url) return jsonResponse({ error: "当前部署缺少 KV 绑定，无法设置分享保护。" }, 500);
    const error = validateShareOptions(shareOptions);
    if (error) return jsonResponse({ error }, 400);
    if (shareOptions.slug && await findShareSlugOwner(env, shareOptions.slug)) {
      return jsonResponse({ error: "自定义短链标识已被占用。", code: "SLUG_CONFLICT" }, 409);
    }
  }

  const run = (signal, report) => mirrorUrl(context, body, { signal, report, guestLimit, shareOptions, isAdmin });
  if (request.headers.get("Accept")?.split(",").some(value => value.trim() === PROGRESS_TYPE)) {
    return streamMirror(request.signal, run);
  }
  return run(request.signal, () => {});
}

function streamMirror(requestSignal, run) {
  const abort = new AbortController();
  const onDisconnect = () => abort.abort();
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeatTimer = null;
  const clearHeartbeat = () => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };
  const stream = new ReadableStream({
    start(controller) {
      let storage;
      const streamStartedAt = Date.now();
      let lastEmitAt = streamStartedAt;
      const emit = (event) => {
        lastEmitAt = Date.now();
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      const report = (event) => {
        if (event.storage) storage = event.storage;
        // Keep phase changes and the final result even if progress updates back up.
        if (!closed && (event.type !== "progress" || controller.desiredSize > 0)) emit(event);
      };
      // 在写入存储后端（saving/finalizing，可能持续 10~60s）期间定时发送轻量心跳，
      // 防止 Cloudflare / 移动网络 NAT / 代理在快完成时因连接长时间无字节输出而主动断开。
      heartbeatTimer = setInterval(() => {
        if (closed) {
          clearHeartbeat();
          return;
        }
        if (Date.now() - lastEmitAt >= STREAM_HEARTBEAT_MS && controller.desiredSize > 0) {
          try {
            emit({ type: "heartbeat", elapsedMs: Date.now() - streamStartedAt });
          } catch {
            clearHeartbeat();
          }
        }
      }, STREAM_HEARTBEAT_MS);
      requestSignal.addEventListener("abort", onDisconnect, { once: true });
      if (requestSignal.aborted) onDisconnect();
      void (async () => {
        try {
          const response = await run(abort.signal, report);
          const data = await response.json();
          if (!closed) emit({ type: "result", status: response.status, data, storage });
        } catch (error) {
          console.error("URL mirror stream error:", error);
          if (!closed) emit({ type: "result", status: 500, data: { error: "转存未能完成" } });
        } finally {
          clearHeartbeat();
          requestSignal.removeEventListener("abort", onDisconnect);
          if (!closed) controller.close();
        }
      })();
    },
    cancel() {
      closed = true;
      clearHeartbeat();
      onDisconnect();
    },
  }, { highWaterMark: 4 });
  return new Response(stream, {
    headers: {
      "Content-Type": PROGRESS_TYPE + "; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "Vary": "Accept",
    },
  });
}

/**
 * Apply the requested share settings to a file that was just mirrored.
 *
 * The backend has registered the file. Apply share settings before returning success.
 */
async function attachShareOptionsToResponse(response, env, shareOptions) {
  let payload = null;
  try {
    payload = await response.clone().json();
  } catch {
    payload = null;
  }

  const key = extractUploadKey(payload);
  if (!key) {
    return jsonResponse({ error: "无法定位刚转存的文件，分享设置未生效。" }, 502);
  }

  const lookup = await getRecordWithKey(env, key, { forceAll: true });
  const record = lookup?.record;
  if (!record?.metadata) {
    return jsonResponse(
      { error: "该存储未写入元数据（可能启用了低 KV 写入模式），无法设置有效期 / 密码 / 短链。" },
      409
    );
  }

  let metadata;
  try {
    metadata = await applyShareOptions(env, lookup.kvKey || key, record.metadata, shareOptions);
  } catch (error) {
    return jsonResponse({ error: error?.message || "写入分享设置失败。" }, 409);
  }

  const summary = buildShareSummary(metadata, lookup.kvKey || key);
  if (!summary) return response;

  attachShareSummary(payload, summary);
  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * Read share options from the request body.
 *
 * Accepts both shapes on purpose: a nested `shareOptions` object (what the
 * current web UI sends, matching the chunked-upload route) and the flat
 * `expires_in` / `max_downloads` / `slug` / `password` fields (what
 * `/api/v1/upload` and `POST /upload` accept), so existing API clients can use
 * this route without changes.
 *
 * @returns Parsed options, or `null` when nothing was requested.
 */
function readShareOptionsFromRequest(body) {
  const nested = body?.shareOptions;
  const source =
    nested && typeof nested === "object"
      ? nested
      : {
          expires_in: body?.expires_in ?? body?.expiresIn,
          max_downloads: body?.max_downloads ?? body?.maxDownloads,
          slug: body?.slug ?? body?.shareSlug,
          password: body?.password,
        };

  const options = parseShareOptions(source);
  return hasShareOptions(options) ? options : null;
}

function sanitizeReferer(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  if (trimmed.length > 2048 || /[\r\n]/.test(trimmed)) {
    throw new RemoteUploadError(400, "Referer 格式无效");
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new RemoteUploadError(400, "Referer 必须是有效的 HTTP/HTTPS 地址");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new RemoteUploadError(400, "Referer 仅支持 HTTP/HTTPS 协议");
  }
  return parsed.href;
}

function parseContentRange(header) {
  const match = String(header || "").trim().match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? null : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
  if (total !== null && (!Number.isSafeInteger(total) || total <= end)) return null;
  return { start, end, total };
}

function canUseTelegramUrlChunking(env) {
  const hasMetadataStore = Boolean(env?.img_url || (env?.DB && typeof env.DB.prepare === "function"));
  return hasMetadataStore && shouldWriteTelegramMetadata(env);
}

function parseRemoteInputUrl(rawUrl) {
  const trimmed = String(rawUrl || "").trim();
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new RemoteUploadError(400, trimmed ? "URL 格式无效" : "请输入 URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new RemoteUploadError(400, "仅支持 HTTP/HTTPS URL");
  }
  return url;
}

function getRangeChunkedConfig(storageMode, env) {
  if (!env?.img_url) return null;
  if (storageMode === "telegram" && canUseTelegramUrlChunking(env)) {
    return {
      chunkSize: CHUNK_SIZE_TELEGRAM,
      minBytes: TELEGRAM_WEB_UPLOAD_LIMIT + 1,
      maxBytes: TELEGRAM_CHUNKED_MAX_FILE_SIZE,
    };
  }
  if (storageMode === "r2" && env.R2_BUCKET) {
    return {
      chunkSize: CHUNK_SIZE_R2,
      minBytes: CHUNK_SIZE_R2 + 1,
      maxBytes: Math.min(MAX_FILE_SIZE_R2, MAX_TOTAL_CHUNKS * CHUNK_SIZE_R2),
    };
  }
  return null;
}

async function probeRemoteUrl(context, body, { signal, guestLimit, isAuthenticated = false }) {
  const { env } = context;
  const probeController = new AbortController();
  const onParentAbort = () => probeController.abort();
  signal.addEventListener("abort", onParentAbort, { once: true });
  if (signal.aborted) onParentAbort();
  const timer = setTimeout(() => probeController.abort(), PROBE_TIMEOUT_MS);

  try {
    const url = parseRemoteInputUrl(body?.url);
    const referer = sanitizeReferer(body?.referer);
    const requested = String(body?.storageMode || "telegram").toLowerCase();
    const explicitFileName = String(body?.customFileName || "").trim();
    const fallbackFileName = String(body?.fileName || body?.name || "").trim();

    let fetched;
    let usedRangeProbe = false;
    try {
      fetched = await fetchRemote(url, probeController.signal, {
        method: "HEAD",
        referer,
        retries: 1,
      });
    } catch (headErr) {
      // 许多对象存储预签名链接或防盗链 CDN 禁止 HEAD（405/403/501/400），自动降级为 1 字节 Range GET 探查
      const status = headErr?.upstreamStatus || headErr?.status;
      if (!probeController.signal.aborted && [400, 403, 405, 501].includes(status)) {
        usedRangeProbe = true;
        fetched = await fetchRemote(url, probeController.signal, {
          method: "GET",
          referer,
          range: "bytes=0-0",
          allowPartial: true,
          retries: 1,
        });
      } else {
        throw headErr;
      }
    }

    const { response: remote, finalUrl } = fetched;
    void remote.body?.cancel().catch(() => {});

    const encoding = remote.headers.get("Content-Encoding")?.trim().toLowerCase();
    const rangeInfo = parseContentRange(remote.headers.get("Content-Range"));
    let totalBytes = null;
    if (rangeInfo?.total > 0) {
      totalBytes = rangeInfo.total;
    } else if (!usedRangeProbe && (!encoding || encoding === "identity")) {
      const declared = parseByteLength(remote.headers.get("Content-Length"));
      if (declared > 0) totalBytes = declared;
    } else if (usedRangeProbe && remote.status === 200 && (!encoding || encoding === "identity")) {
      const declared = parseByteLength(remote.headers.get("Content-Length"));
      if (declared > 0) totalBytes = declared;
    }

    const acceptRanges =
      remote.status === 206 || /\bbytes\b/i.test(remote.headers.get("Accept-Ranges") || "");
    const validator = remote.headers.get("ETag") || remote.headers.get("Last-Modified") || "";
    const contentType = (remote.headers.get("Content-Type") || "application/octet-stream").split(";")[0].trim();
    const fileName = resolveFileName(
      finalUrl,
      contentType,
      remote.headers.get("Content-Disposition"),
      fallbackFileName,
      explicitFileName
    );

    const canRangeChunk = Boolean(isAuthenticated && env?.img_url && acceptRanges && totalBytes > 0);
    let storage = requested;
    let maxBytes = getRemoteUploadLimit(requested === "auto" ? "telegram" : requested, env);
    let exceedsLimit = false;
    let limitReason = "";
    let rangeChunked = false;
    let chunkSize = null;
    let totalChunks = null;

    try {
      // 当源站支持 Range 且用户已登录时，允许按 Range 分片上限（Telegram 2GB / R2 10GB）选路
      if (canRangeChunk && requested !== "auto") {
        const primary = AUTO_STORAGE_ORDER.includes(requested) ? requested : "telegram";
        const primaryRangeCfg = getRangeChunkedConfig(primary, env);
        const primaryEffectiveMax = primaryRangeCfg
          ? Math.max(getRemoteUploadLimit(primary, env), primaryRangeCfg.maxBytes)
          : getRemoteUploadLimit(primary, env);
        if (totalBytes <= primaryEffectiveMax) {
          storage = primary;
        } else if (Boolean(body?.overflowFallback)) {
          const fallbackPref = String(body?.overflowFallbackMode || "").toLowerCase();
          const candidates = fallbackPref
            ? [fallbackPref, ...AUTO_STORAGE_ORDER.filter((m) => m !== fallbackPref)]
            : AUTO_STORAGE_ORDER;
          const picked = candidates.find((mode) => {
            if (mode === primary || !isRemoteStorageConfigured(mode, env)) return false;
            const cfg = getRangeChunkedConfig(mode, env);
            const cap = cfg ? Math.max(getRemoteUploadLimit(mode, env), cfg.maxBytes) : getRemoteUploadLimit(mode, env);
            return totalBytes <= cap;
          });
          storage = picked || primary;
        } else {
          storage = primary;
        }
      } else if (canRangeChunk && requested === "auto") {
        const available = AUTO_STORAGE_ORDER.filter((mode) => isRemoteStorageConfigured(mode, env));
        if (!available.length) throw new RemoteUploadError(400, "没有可用的转存节点");
        const smallLimit = Math.min(TELEGRAM_WEB_UPLOAD_LIMIT, parseByteLength(body?.smartThreshold) || TELEGRAM_WEB_UPLOAD_LIMIT);
        if (totalBytes <= smallLimit && available.includes("telegram")) {
          storage = "telegram";
        } else {
          const preferred = body?.smartLargeMode;
          const ordered = available.includes(preferred)
            ? [preferred, ...available.filter((m) => m !== preferred)]
            : available;
          const picked = ordered.find((mode) => {
            const cfg = getRangeChunkedConfig(mode, env);
            const cap = cfg ? Math.max(getRemoteUploadLimit(mode, env), cfg.maxBytes) : getRemoteUploadLimit(mode, env);
            return totalBytes <= cap;
          });
          if (!picked) {
            const highest = Math.max(...available.map((mode) => {
              const cfg = getRangeChunkedConfig(mode, env);
              return cfg ? Math.max(getRemoteUploadLimit(mode, env), cfg.maxBytes) : getRemoteUploadLimit(mode, env);
            }));
            throw remoteSizeError(highest);
          }
          storage = picked;
        }
      } else {
        storage = selectRemoteStorage(
          requested,
          body?.smartLargeMode,
          body?.smartThreshold,
          totalBytes,
          env,
          Boolean(body?.overflowFallback),
          body?.overflowFallbackMode
        );
      }

      const rangeCfg = canRangeChunk ? getRangeChunkedConfig(storage, env) : null;
      const singleMax = getRemoteUploadLimit(storage, env);
      maxBytes = rangeCfg ? Math.max(singleMax, rangeCfg.maxBytes) : singleMax;

      if (rangeCfg && totalBytes >= rangeCfg.minBytes && totalBytes <= rangeCfg.maxBytes) {
        const chunks = Math.ceil(totalBytes / rangeCfg.chunkSize);
        if (chunks <= MAX_TOTAL_CHUNKS) {
          rangeChunked = true;
          chunkSize = rangeCfg.chunkSize;
          totalChunks = chunks;
        }
      }

      if (totalBytes !== null && totalBytes > guestLimit) {
        exceedsLimit = true;
        limitReason = guestSizeError(guestLimit).message;
      } else if (totalBytes !== null && totalBytes > maxBytes) {
        exceedsLimit = true;
        limitReason = remoteSizeError(maxBytes).message;
      } else if (storage !== "telegram" && !isRemoteStorageConfigured(storage, env)) {
        exceedsLimit = true;
        limitReason = `${storage} 未配置`;
      }
    } catch (selectErr) {
      exceedsLimit = true;
      limitReason = selectErr?.message || "超出当前存储节点限制";
    }

    const telegramChunked =
      storage === "telegram" &&
      canUseTelegramUrlChunking(env) &&
      totalBytes !== null &&
      totalBytes > TELEGRAM_WEB_UPLOAD_LIMIT;

    return jsonResponse({
      ok: true,
      finalUrl: finalUrl.href,
      host: finalUrl.hostname,
      fileName,
      contentType,
      size: totalBytes,
      acceptRanges,
      validator,
      storage,
      maxBytes,
      telegramChunked,
      rangeChunked,
      chunkSize,
      totalChunks,
      exceedsLimit,
      limitReason,
    });
  } catch (error) {
    if (error instanceof RemoteUploadError) {
      return jsonResponse(
        {
          error: error.message,
          ...(error.code ? { code: error.code } : {}),
          ...(error.retryable ? { retryable: true } : {}),
        },
        error.status
      );
    }
    if (probeController.signal.aborted) {
      return jsonResponse({ error: "预检超时，可直接尝试开始转存", retryable: true }, 408);
    }
    console.error("URL probe error:", error);
    return jsonResponse({ error: "无法预检该链接" }, 502);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onParentAbort);
  }
}

async function mirrorUrl(context, body, { signal, report, guestLimit, shareOptions, isAdmin }) {
  const { request, env } = context;
  const source = new AbortController();
  const onDisconnect = () => source.abort();
  let deadline;
  const withinIdleLimit = async (operation) => {
    const idle = setTimeout(() => source.abort(), SOURCE_IDLE_TIMEOUT);
    try {
      source.signal.throwIfAborted();
      return await operation();
    } finally {
      clearTimeout(idle);
    }
  };

  signal.addEventListener("abort", onDisconnect, { once: true });
  if (signal.aborted) onDisconnect();

  try {
    const url = parseRemoteInputUrl(body?.url);
    const referer = sanitizeReferer(body?.referer);

    const requested = String(body?.storageMode || "telegram").toLowerCase();
    const folderPath = normalizeFolderPath(body?.folderPath || body?.folder || "");
    const explicitFileName = String(body?.customFileName || "").trim();
    const fallbackFileName = String(body?.fileName || body?.name || "").trim();

    if (requested === "r2" && !env.R2_BUCKET) throw new RemoteUploadError(400, "R2 未配置");

    report({ type: "phase", phase: "connecting", host: url.hostname });
    deadline = setTimeout(() => source.abort(), SOURCE_MAX_DURATION);
    const { response: remote, finalUrl, effectiveReferer } = await withinIdleLimit(() =>
      fetchRemote(url, source.signal, { referer })
    );
    const encoding = remote.headers.get("Content-Encoding")?.trim().toLowerCase();
    const declared = !encoding || encoding === "identity"
      ? parseByteLength(remote.headers.get("Content-Length")) : null;
    const totalBytes = declared > 0 ? declared : null;
    const acceptRanges = /\bbytes\b/i.test(remote.headers.get("Accept-Ranges") || "");
    const validator = remote.headers.get("ETag") || remote.headers.get("Last-Modified") || "";

    let storage;
    let maxBytes;
    try {
      if (totalBytes > guestLimit) throw guestSizeError(guestLimit);
      storage = selectRemoteStorage(
        requested,
        body?.smartLargeMode,
        body?.smartThreshold,
        totalBytes,
        env,
        Boolean(body?.overflowFallback),
        body?.overflowFallbackMode
      );
      maxBytes = getRemoteUploadLimit(storage, env);
      if (totalBytes > maxBytes) throw remoteSizeError(maxBytes);
      if (storage !== "telegram" && !isRemoteStorageConfigured(storage, env)) {
        throw new RemoteUploadError(400, `${storage} 未配置`);
      }
    } catch (error) {
      void remote.body?.cancel().catch(() => {});
      throw error;
    }

    const contentType = remote.headers.get("Content-Type") || "application/octet-stream";
    const fileName = resolveFileName(
      finalUrl,
      contentType,
      remote.headers.get("Content-Disposition"),
      fallbackFileName,
      explicitFileName
    );
    const extension = getFileExtension(fileName);
    const useTelegramChunked =
      storage === "telegram" &&
      canUseTelegramUrlChunking(env) &&
      (totalBytes === null || totalBytes > TELEGRAM_WEB_UPLOAD_LIMIT);
    const details = {
      fileName,
      storage,
      totalBytes,
      host: finalUrl.hostname,
      acceptRanges,
      telegramChunked: useTelegramChunked && totalBytes !== null && totalBytes > TELEGRAM_WEB_UPLOAD_LIMIT,
    };
    report({ type: "phase", phase: "transferring", receivedBytes: 0, ...details });
    let lastUpdate = 0;
    const chunks = readRemoteChunks(remote, {
      maxBytes,
      guestLimit,
      totalBytes,
      signal: source.signal,
      withinIdleLimit,
      acceptRanges,
      resumeUrl: finalUrl,
      resumeReferer: effectiveReferer,
      validator,
      onResume({ attempt, maxAttempts, receivedBytes }) {
        report({
          type: "phase",
          phase: "resuming",
          attempt,
          maxAttempts,
          receivedBytes,
          ...details,
        });
      },
      onProgress(receivedBytes) {
        const now = Date.now();
        if (now - lastUpdate < 200) return;
        lastUpdate = now;
        report({ type: "progress", phase: "transferring", ...details, receivedBytes });
      },
      onEnd(receivedBytes) {
        clearTimeout(deadline);
        report({ type: "phase", phase: "saving", ...details, receivedBytes });
      },
    });

    let response;
    if (storage === "r2") {
      response = await uploadToR2(chunks, fileName, extension, contentType, env, folderPath, signal, {
        report,
        details,
      });
    } else if (useTelegramChunked) {
      response = await uploadToTelegramChunked(
        chunks,
        fileName,
        extension,
        contentType,
        totalBytes,
        env,
        new URL(request.url).origin,
        folderPath,
        context,
        signal,
        { report, details }
      );
    } else {
      const content = await bufferRemoteFile(chunks, Math.min(maxBytes, guestLimit), totalBytes);
      signal.throwIfAborted();
      const args = [content, fileName, extension, contentType, content.byteLength, env];
      switch (storage) {
        case "s3": response = await uploadToS3(...args, folderPath, signal); break;
        case "discord": response = await uploadToDiscordStorage(...args, folderPath, signal); break;
        case "huggingface": response = await uploadToHFStorage(...args, folderPath, signal); break;
        case "webdav": response = await uploadToWebDAVStorage(...args, folderPath, signal); break;
        case "github": response = await uploadToGitHubStorage(...args, folderPath, signal); break;
        default: response = await uploadToTelegram(...args, new URL(request.url).origin, folderPath, context, signal);
      }
    }

    if (response.ok) {
      report({ type: "phase", phase: "finalizing", ...details });
      if (shareOptions) response = await attachShareOptionsToResponse(response, env, shareOptions);
      if (response.ok && !isAdmin) await incrementGuestCount(request, env);
    }
    return response;
  } catch (error) {
    if (error instanceof RemoteUploadError) {
      return jsonResponse(
        {
          error: error.message,
          ...(error.code ? { code: error.code } : {}),
          ...(error.retryable ? { retryable: true } : {}),
        },
        error.status
      );
    }
    if (signal.aborted) return jsonResponse({ error: "转存连接已断开", retryable: true }, 408);
    console.error("URL upload error:", error);
    return jsonResponse({ error: "服务器错误" }, 500);
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", onDisconnect);
    source.abort();
  }
}

function isRemoteStorageConfigured(mode, env) {
  switch (mode) {
    case "r2": return Boolean(env.R2_BUCKET);
    case "s3": return Boolean(env.S3_ENDPOINT && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY && env.S3_BUCKET);
    case "discord": return Boolean(env.DISCORD_WEBHOOK_URL || env.DISCORD_BOT_TOKEN);
    case "huggingface": return hasHuggingFaceConfig(env);
    case "webdav": return hasWebDAVConfig(env);
    case "github": return hasGitHubConfig(env);
    default: return Boolean(envValue(env, "TG_BOT_TOKEN") && envValue(env, "TG_CHAT_ID"));
  }
}

function selectRemoteStorage(
  requested,
  preferred,
  threshold,
  size,
  env,
  overflowFallback = false,
  overflowFallbackMode = ""
) {
  if (requested !== "auto") {
    const primary = AUTO_STORAGE_ORDER.includes(requested) ? requested : "telegram";
    if (
      overflowFallback &&
      size !== null &&
      size > getRemoteUploadLimit(primary, env)
    ) {
      const normalizedPreferred = String(overflowFallbackMode || "").toLowerCase();
      if (
        normalizedPreferred &&
        normalizedPreferred !== primary &&
        AUTO_STORAGE_ORDER.includes(normalizedPreferred) &&
        isRemoteStorageConfigured(normalizedPreferred, env) &&
        size <= getRemoteUploadLimit(normalizedPreferred, env)
      ) {
        return normalizedPreferred;
      }
      const candidate = AUTO_STORAGE_ORDER.find(
        (mode) =>
          mode !== primary &&
          isRemoteStorageConfigured(mode, env) &&
          size <= getRemoteUploadLimit(mode, env)
      );
      if (candidate) return candidate;
    }
    return primary;
  }
  const available = AUTO_STORAGE_ORDER.filter(mode => isRemoteStorageConfigured(mode, env));
  if (!available.length) throw new RemoteUploadError(400, "没有可用的转存节点");
  // auto 模式下仅 20MB 以内默认优先走 Telegram 单消息直传，大文件仍优先分配给 R2/S3 等对象存储
  const smallLimit = Math.min(TELEGRAM_WEB_UPLOAD_LIMIT, parseByteLength(threshold) || TELEGRAM_WEB_UPLOAD_LIMIT);
  if (size !== null && size <= smallLimit && available.includes("telegram")) return "telegram";

  const ordered = available.includes(preferred)
    ? [preferred, ...available.filter(mode => mode !== preferred)] : available;
  if (size === null) return ordered[0];
  const target = ordered.find(mode => size <= getRemoteUploadLimit(mode, env));
  if (target) return target;
  throw remoteSizeError(Math.max(...available.map(mode => getRemoteUploadLimit(mode, env))));
}

async function sleepWithSignal(ms, signal) {
  if (ms <= 0) return;
  if (signal?.aborted) throw new RemoteUploadError(408, "远程 URL 请求超时", { retryable: true });
  await new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RemoteUploadError(408, "远程 URL 请求超时", { retryable: true }));
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchRemote(initialUrl, signal, options = {}) {
  const {
    method = "GET",
    referer = "",
    range = "",
    ifRange = "",
    allowPartial = false,
    retries = FETCH_MAX_RETRIES,
  } = options;
  let currentUrl = initialUrl;
  let effectiveReferer = referer;
  let triedSameOriginReferer = false;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const check = validateRemoteUrl(currentUrl.href);
    if (!check.ok) {
      throw new RemoteUploadError(400, `SSRF 防护：${check.message}`);
    }

    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 K-Vault URL Uploader",
      Accept: "image/*,video/*,audio/*,application/*,*/*",
      "Accept-Encoding": "identity",
    };
    if (effectiveReferer) headers.Referer = effectiveReferer;
    if (range) headers.Range = range;
    if (ifRange) headers["If-Range"] = ifRange;

    let response;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        response = await fetch(currentUrl.href, {
          method,
          redirect: "manual",
          signal,
          headers,
        });
      } catch (error) {
        if (signal.aborted) {
          throw new RemoteUploadError(408, "远程 URL 请求超时", { retryable: true });
        }
        if (attempt < retries) {
          await sleepWithSignal(400 * (attempt + 1), signal);
          continue;
        }
        console.error("Remote fetch failed:", error);
        throw new RemoteUploadError(502, "无法获取远程 URL", { retryable: true });
      }

      if (
        [408, 429, 500, 502, 503, 504].includes(response.status) &&
        attempt < retries &&
        !signal.aborted
      ) {
        void response.body?.cancel().catch(() => {});
        const retryAfterSec = Number(response.headers.get("Retry-After") || 0);
        const waitMs =
          response.status === 429 && Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? Math.min(5_000, Math.round(retryAfterSec * 1000))
            : 400 * Math.pow(3, attempt);
        await sleepWithSignal(waitMs, signal);
        continue;
      }
      break;
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      void response.body?.cancel().catch(() => {});
      const location = response.headers.get("Location");
      if (!location) {
        throw new RemoteUploadError(502, "远程 URL 重定向缺少 Location 头");
      }
      const redirectCheck = validateRedirectLocation(location, currentUrl);
      if (!redirectCheck.ok) {
        throw new RemoteUploadError(400, `SSRF 防护：${redirectCheck.message}`);
      }
      currentUrl = redirectCheck.url;
      continue;
    }

    // 针对基础防盗链（403）：未指定自定义 Referer 时自动携带同源 Referer 重试 1 次
    if (response.status === 403 && !effectiveReferer && !triedSameOriginReferer && !signal.aborted) {
      void response.body?.cancel().catch(() => {});
      triedSameOriginReferer = true;
      effectiveReferer = `${currentUrl.origin}/`;
      hop -= 1;
      continue;
    }

    if (!allowPartial && (response.status === 206 || response.headers.has("Content-Range"))) {
      void response.body?.cancel().catch(() => {});
      throw new RemoteUploadError(502, "源站只返回了部分文件");
    }

    if (!response.ok && !(allowPartial && response.status === 206)) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 403) {
        throw new RemoteUploadError(
          403,
          "源站拒绝访问（HTTP 403，可能开启了防盗链，可在高级选项中填写 Referer 后重试）",
          { upstreamStatus: 403 }
        );
      }
      if (response.status === 404) {
        throw new RemoteUploadError(404, "远程文件不存在（HTTP 404）", { upstreamStatus: 404 });
      }
      throw new RemoteUploadError(
        502,
        `远程 URL 响应异常：${response.status} ${response.statusText}`,
        {
          upstreamStatus: response.status,
          retryable: [408, 429, 500, 502, 503, 504].includes(response.status),
        }
      );
    }
    return { response, finalUrl: currentUrl, effectiveReferer };
  }

  throw new RemoteUploadError(400, `重定向次数过多（最多 ${MAX_REDIRECTS} 次）`);
}

async function* readRemoteChunks(response, options) {
  const maxBytes = options.maxBytes;
  const guestLimit = options.guestLimit;
  const totalBytes = options.totalBytes;
  const signal = options.signal;
  const withinIdleLimit = options.withinIdleLimit;
  const progressCallback = options.onProgress;
  const finishCallback = options.onEnd;
  const acceptRanges = Boolean(options.acceptRanges);
  const resumeUrl = options.resumeUrl || null;
  const resumeReferer = options.resumeReferer || "";
  const validator = options.validator || "";
  const resumeCallback = options.onResume || null;
  let reader = response.body?.getReader();
  if (!reader) throw new RemoteUploadError(400, "源文件为空");

  const onAbort = () => { void reader?.cancel().catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  let received = 0;
  let finished = false;
  let resumeAttempts = 0;

  const tryAutoResume = async () => {
    if (
      !acceptRanges ||
      !resumeUrl ||
      totalBytes === null ||
      received <= 0 ||
      received >= totalBytes ||
      resumeAttempts >= MAX_RESUME_ATTEMPTS ||
      signal.aborted
    ) {
      return false;
    }
    resumeAttempts += 1;
    if (typeof resumeCallback === "function") {
      resumeCallback({ attempt: resumeAttempts, maxAttempts: MAX_RESUME_ATTEMPTS, receivedBytes: received, totalBytes });
    }
    try {
      await Promise.race([
        reader.cancel().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 100)),
      ]);
      reader.releaseLock();
    } catch {
      // ignore release failure on broken reader
    }
    try {
      await sleepWithSignal(350 * resumeAttempts, signal);
      const resumed = await withinIdleLimit(() =>
        fetchRemote(resumeUrl, signal, {
          referer: resumeReferer,
          range: `bytes=${received}-`,
          ifRange: validator,
          allowPartial: true,
          retries: 1,
        })
      );
      if (resumed.response.status !== 206) {
        void resumed.response.body?.cancel().catch(() => {});
        return false;
      }
      const rangeInfo = parseContentRange(resumed.response.headers.get("Content-Range"));
      if (!rangeInfo || rangeInfo.start !== received || (rangeInfo.total !== null && rangeInfo.total !== totalBytes)) {
        void resumed.response.body?.cancel().catch(() => {});
        return false;
      }
      const nextReader = resumed.response.body?.getReader();
      if (!nextReader) return false;
      reader = nextReader;
      return true;
    } catch {
      return false;
    }
  };

  try {
    while (true) {
      let chunk;
      // 已收齐 Content-Length 声明的全部字节后，若源站延迟关闭 keep-alive 连接，
      // 仅给 1.5s 宽限期确认是否还有多余字节，超时则直接视为正常收尾，不再苦等 45s 误报 408 超时。
      if (totalBytes !== null && received === totalBytes) {
        let graceTimer = null;
        try {
          signal.throwIfAborted();
          const readPromise = reader.read();
          // 防止宽限期胜出后 reader.cancel() 触发的 readPromise rejection 成为未捕获异常
          readPromise.catch(() => {});
          const graceResult = await Promise.race([
            readPromise,
            new Promise((resolve) => {
              graceTimer = setTimeout(() => resolve({ __eofGrace: true }), EOF_GRACE_TIMEOUT_MS);
            }),
          ]);
          if (graceTimer !== null) clearTimeout(graceTimer);
          signal.throwIfAborted();
          if (graceResult?.__eofGrace) {
            finished = true;
            await Promise.race([
              reader.cancel().catch(() => {}),
              new Promise((resolve) => setTimeout(resolve, 100)),
            ]);
            finishCallback(received);
            return;
          }
          chunk = graceResult;
        } catch {
          if (graceTimer !== null) clearTimeout(graceTimer);
          if (signal.aborted) throw new RemoteUploadError(408, "远程 URL 请求超时", { retryable: true });
          // 已拿到 100% 声明字节且仅在等待 EOF 时源站断连：视为完整接收
          finished = true;
          finishCallback(received);
          return;
        }
      } else {
        try {
          signal.throwIfAborted();
          chunk = await withinIdleLimit(() => reader.read());
          signal.throwIfAborted();
        } catch {
          if (signal.aborted) throw new RemoteUploadError(408, "远程 URL 请求超时", { retryable: true });
          if (await tryAutoResume()) continue;
          throw new RemoteUploadError(502, "远程文件读取中断", { retryable: true });
        }
      }

      if (chunk.done) {
        if (!received) {
          finished = true;
          throw new RemoteUploadError(400, "源文件为空");
        }
        if (totalBytes !== null && received < totalBytes) {
          if (await tryAutoResume()) continue;
          finished = true;
          throw new RemoteUploadError(502, "源文件实际大小与响应头不一致", { retryable: true });
        }
        if (totalBytes !== null && totalBytes !== received) {
          finished = true;
          throw new RemoteUploadError(502, "源文件实际大小与响应头不一致");
        }
        finished = true;
        finishCallback(received);
        return;
      }

      received += chunk.value.byteLength;
      if (received > guestLimit) throw guestSizeError(guestLimit);
      if (received > maxBytes) throw remoteSizeError(maxBytes);
      if (totalBytes !== null && received > totalBytes) {
        throw new RemoteUploadError(502, "源文件实际大小与响应头不一致");
      }
      if (chunk.value.byteLength) {
        progressCallback(received);
        yield chunk.value;
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (!finished) onAbort();
    try {
      reader?.releaseLock();
    } catch {
      // ignore if stream is already errored/cancelled with pending read
    }
  }
}

async function bufferRemoteFile(chunks, maxBytes, totalBytes) {
  let file = new Uint8Array(totalBytes ?? 0);
  let size = 0;
  for await (const chunk of chunks) {
    const required = size + chunk.byteLength;
    if (required > file.byteLength) {
      const next = new Uint8Array(Math.min(maxBytes, Math.max(required, file.byteLength * 2)));
      next.set(file.subarray(0, size));
      file = next;
    }
    file.set(chunk, size);
    size = required;
  }
  return size === file.byteLength ? file.buffer : file.buffer.slice(0, size);
}

function remoteSizeError(maxBytes) {
  return new RemoteUploadError(413, `远程文件超过当前存储后端的 ${formatSize(maxBytes)} 转存上限。`);
}

function guestSizeError(limit) {
  const error = new RemoteUploadError(413, `访客转存的文件不能超过 ${formatSize(limit)}。`);
  error.code = "GUEST_FILE_TOO_LARGE";
  return error;
}

function getRemoteUploadLimit(storageMode, env) {
  switch (storageMode) {
    case "r2": return R2_URL_UPLOAD_LIMIT;
    case "telegram":
      return canUseTelegramUrlChunking(env) ? TELEGRAM_URL_CHUNKED_LIMIT : TELEGRAM_WEB_UPLOAD_LIMIT;
    case "discord": return DISCORD_UPLOAD_LIMIT;
    case "huggingface": return HUGGINGFACE_UPLOAD_LIMIT;
    case "github":
      // Contents API also holds a Base64 copy and an encoded JSON request.
      return getGitHubConfig(env).mode === "contents" ? 25 * MB : MAX_IN_MEMORY_ASSEMBLY;
    default: return MAX_IN_MEMORY_ASSEMBLY;
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function normalizeFolderPath(value) {
  const raw = String(value || "").replace(/\\/g, "/").trim();
  const output = [];
  for (const part of raw.split("/")) {
    const piece = part.trim();
    if (!piece || piece === ".") continue;
    if (piece === "..") {
      output.pop();
      continue;
    }
    output.push(piece);
  }
  return output.join("/");
}

function joinStoragePath(folderPath, fileName) {
  const base = normalizeFolderPath(folderPath);
  if (!base) return fileName;
  return `${base}/${fileName}`;
}

function getFileExtension(fileName) {
  const ext = String(fileName || "")
    .split(".")
    .pop()
    ?.toLowerCase()
    ?.replace(/[^a-z0-9]/g, "");
  return ext || "bin";
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function getExtensionFromMimeType(mimeType) {
  const type = (mimeType || "").split(";")[0].trim().toLowerCase();
  const map = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/bmp": "bmp",
    "image/svg+xml": "svg",
    "image/x-icon": "ico",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "video/x-msvideo": "avi",
    "video/x-matroska": "mkv",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
    "audio/x-m4a": "m4a",
    "audio/mp4": "m4a",
    "application/pdf": "pdf",
    "application/zip": "zip",
    "application/x-rar-compressed": "rar",
    "application/x-7z-compressed": "7z",
    "text/plain": "txt",
    "application/json": "json",
  };
  return map[type] || "bin";
}

/* 解析远程响应头中的真实文件名（处理 RFC 5987 / UTF-8 / ISO-8859-1） */
function parseContentDispositionFilename(disposition) {
  if (!disposition) return "";

  const utf8Match = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1].trim().replace(/^["']|["']$/g, ""));
    } catch (_) {}
  }

  const standardMatch = disposition.match(/filename\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
  if (standardMatch) {
    let raw = (standardMatch[1] || standardMatch[2] || "").trim();
    if (raw.includes("%")) {
      try { raw = decodeURIComponent(raw); } catch (_) {}
    } else {
      try {
        const decoded = decodeURIComponent(escape(raw));
        if (decoded && !decoded.includes("\ufffd")) raw = decoded;
      } catch (_) {}
    }
    return raw;
  }
  return "";
}

/* 综合解析文件名，消除乱码 */
function resolveFileName(parsedUrl, contentType, contentDisposition = "", customFileName = "", explicitFileName = "") {
  let fileName = "";

  // 0. 用户在界面显式指定的自定义文件名优先级最高
  if (explicitFileName) {
    fileName = explicitFileName;
  }

  // 1. 优先远程响应头
  if (!fileName) {
    const dispositionName = parseContentDispositionFilename(contentDisposition);
    if (dispositionName) {
      fileName = dispositionName;
    }
  }

  // 2. 其次前端自动解析传入的兜底文件名
  if (!fileName && customFileName) {
    try {
      fileName = decodeURIComponent(customFileName);
    } catch (_) {
      fileName = customFileName;
    }
  }

  // 3. 再次从 URL 路径解码
  if (!fileName) {
    try {
      const parts = parsedUrl.pathname.split("/").filter(Boolean);
      const rawPart = parts.pop() || "";
      const basePart = rawPart.split("?")[0].split("#")[0];
      if (basePart) {
        fileName = decodeURIComponent(basePart);
      }
    } catch (_) {}
  }

  // 4. 从 URL 查询参数匹配 (?filename=... / ?file=...)
  if (!fileName || !fileName.includes(".")) {
    for (const key of ["filename", "file", "name", "title"]) {
      const val = parsedUrl.searchParams.get(key);
      if (val) {
        try {
          const decoded = decodeURIComponent(val);
          if (decoded.includes(".")) {
            fileName = decoded;
            break;
          }
        } catch (_) {}
      }
    }
  }

  // 5. 兜底默认命名
  if (!fileName) {
    fileName = `url_${Date.now()}.${getExtensionFromMimeType(contentType)}`;
  }

  if (fileName.includes("%")) {
    try { fileName = decodeURIComponent(fileName); } catch (_) {}
  }

  // 去除非法字符并保证扩展名
  fileName = fileName.replace(/[/\\]/g, "_").trim();
  if (!fileName.includes(".")) {
    // 若用户手动重命名时未写扩展名，尝试继承原始响应头/URL 的扩展名，否则按 MIME 推导
    const fallbackExtSource = parseContentDispositionFilename(contentDisposition) || customFileName;
    const inheritedExt = fallbackExtSource && fallbackExtSource.includes(".")
      ? getFileExtension(fallbackExtSource)
      : "";
    fileName = `${fileName}.${inheritedExt || getExtensionFromMimeType(contentType)}`;
  }

  return fileName;
}

function randomId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

function appendCommonMetadata(metadata, folderPath) {
  if (!folderPath) return metadata;
  return {
    ...metadata,
    folderPath,
  };
}

async function postTelegramUpload(apiUrl, buildFormData, signal) {
  const startedAt = Date.now();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (signal?.aborted) {
      throw new RemoteUploadError(408, "转存连接已断开");
    }
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    if (signal) signal.addEventListener("abort", onParentAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TELEGRAM_UPLOAD_TIMEOUT_MS);

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        body: buildFormData(),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (response.ok) {
        return { response, data };
      }
      if (response.status === 429) {
        const retryAfter = Number(data?.parameters?.retry_after || response.headers.get("Retry-After") || 0);
        const validRetry = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0;
        if (validRetry > 0 && validRetry <= 5 && attempt === 0 && !signal?.aborted && Date.now() - startedAt < 25_000) {
          await sleepWithSignal(validRetry * 1000 + 200, signal);
          continue;
        }
        return { response, data, retryAfter: validRetry };
      }
      if (response.status >= 500 && attempt === 0 && !signal?.aborted && Date.now() - startedAt < 25_000) {
        await new Promise((resolve) => setTimeout(resolve, TELEGRAM_RETRY_DELAY_MS));
        continue;
      }
      return { response, data };
    } catch (error) {
      if (signal?.aborted) {
        throw new RemoteUploadError(408, "转存连接已断开");
      }
      if (timedOut) {
        return { timedOut: true, error };
      }
      if (attempt === 0 && !signal?.aborted && Date.now() - startedAt < 25_000) {
        await new Promise((resolve) => setTimeout(resolve, TELEGRAM_RETRY_DELAY_MS));
        continue;
      }
      return { networkError: error };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onParentAbort);
    }
  }
  return { networkError: new Error("Telegram upload exhausted retries") };
}

function formatTelegramUploadFailure(result) {
  if (result?.timedOut) {
    return jsonResponse({ error: "Telegram 上传超时，请稍后重试", retryable: true }, 504);
  }
  if (result?.networkError) {
    return jsonResponse({ error: `Telegram request failed: ${result.networkError.message}` }, 502);
  }
  const status = result?.response?.status || 500;
  if (status === 429) {
    const retryAfter = result.retryAfter || 0;
    const hint = retryAfter > 0 ? `（建议 ${retryAfter} 秒后重试）` : "";
    return jsonResponse(
      {
        error: `Telegram 触发限流${hint}`,
        retryable: true,
        ...(retryAfter > 0 ? { retryAfter } : {}),
      },
      429
    );
  }
  const description = result?.data?.description || `Telegram upload failed (HTTP ${status})`;
  return jsonResponse({ error: description }, status >= 500 ? 502 : 500);
}

async function uploadToTelegram(arrayBuffer, fileName, fileExtension, contentType, fileSize, env, fallbackOrigin = "", folderPath = "", context = null, signal = null) {
  const blob = new Blob([arrayBuffer], { type: contentType });
  const file = new File([blob], fileName, { type: contentType });
  const chatId = envValue(env, 'TG_CHAT_ID');

  const { method: apiEndpoint, field } = getTelegramUploadMethodAndField(contentType);
  const apiUrl = buildTelegramBotApiUrl(env, apiEndpoint);

  const primary = await postTelegramUpload(
    apiUrl,
    () => {
      const formData = new FormData();
      formData.append("chat_id", chatId);
      formData.append(field, file);
      return formData;
    },
    signal
  );

  if (primary.response?.ok) {
    return processTelegramSuccess(primary.data, fileName, fileExtension, contentType, fileSize, env, fallbackOrigin, folderPath, context);
  }

  if (apiEndpoint === "sendAudio" && !primary.timedOut && !primary.networkError && primary.response?.status !== 429) {
    const fallback = await postTelegramUpload(
      buildTelegramBotApiUrl(env, "sendDocument"),
      () => {
        const docFormData = new FormData();
        docFormData.append("chat_id", chatId);
        docFormData.append("document", file);
        return docFormData;
      },
      signal
    );
    if (fallback.response?.ok) {
      return processTelegramSuccess(fallback.data, fileName, fileExtension, contentType, fileSize, env, fallbackOrigin, folderPath, context);
    }
    return formatTelegramUploadFailure(fallback);
  }

  return formatTelegramUploadFailure(primary);
}

async function processTelegramSuccess(responseData, fileName, fileExtension, mimeType, fileSize, env, fallbackOrigin = "", folderPath = "", context = null) {
  const fileId = pickTelegramFileId(responseData);
  const messageId = responseData?.result?.message_id;

  if (!fileId) {
    return jsonResponse({ error: "Telegram 已接收文件，但未返回可用的文件 ID" }, 500);
  }

  const directId = await buildTelegramDirectId(fileId, fileExtension, fileName, mimeType, fileSize, messageId, env);

  // fail-closed：没有签名密钥就不给直链，返回明确错误而不是 `null`。
  if (!directId) {
    return jsonResponse(
      {
        error: SIGNED_LINK_SECRET_MISSING_MESSAGE,
        code: "SIGNED_LINK_SECRET_NOT_CONFIGURED",
      },
      503
    );
  }

  if (env.img_url && shouldWriteTelegramMetadata(env)) {
    const telegramKvKey = `${fileId}.${fileExtension}`;
    // 先算出 metadata 再写：KV 与 D1 共用同一份，省掉 D1 登记时的 KV 回读
    const recordMetadata = appendCommonMetadata(
      {
        TimeStamp: Date.now(),
        ListType: "None",
        Label: "None",
        liked: false,
        fileName,
        fileSize,
        storageType: "telegram",
        telegramFileId: fileId,
        telegramMessageId: messageId || undefined,
        signedLink: shouldUseSignedTelegramLinks(env),
      },
      folderPath
    );
    await putKvFileMetadata(env, telegramKvKey, recordMetadata);
    await putRecordIndex(env, telegramKvKey, { metadata: recordMetadata });
  }

  const directLink = buildTelegramDirectLink(env, directId, fallbackOrigin);
  // 通知为非关键收尾步骤：在 Pages/Workers 环境下交给 context.waitUntil 异步执行，
  // 避免在转存即将完成时因 Telegram 通知接口延迟而拖长响应甚至触发超时。
  const noticeTask = (async () => {
    try {
      const noticeResult = await sendTelegramUploadNotice(
        {
          chatId: envValue(env, 'TG_CHAT_ID'),
          replyToMessageId: messageId || undefined,
          directLink,
          fileId,
          messageId,
          fileName,
          fileSize,
        },
        env
      );
      if (!noticeResult?.ok && !noticeResult?.skipped) {
        console.warn(
          "Telegram upload notice failed:",
          noticeResult?.data?.description || noticeResult?.error || "unknown error"
        );
      }
    } catch (error) {
      console.warn("Telegram upload notice error:", error.message);
    }
  })();

  if (typeof context?.waitUntil === "function") {
    context.waitUntil(noticeTask);
  } else {
    await noticeTask;
  }

  // 关键修复：把正确的真实文件名与体积返回给前端
  return jsonResponse([{
    src: `/file/${directId}`,
    fileName,
    name: fileName,
    size: fileSize,
  }]);
}

async function uploadToTelegramChunked(
  chunks,
  fileName,
  fileExtension,
  contentType,
  declaredTotalBytes,
  env,
  fallbackOrigin = "",
  folderPath = "",
  context = null,
  signal = null,
  progressCtx = null
) {
  const chatId = envValue(env, "TG_CHAT_ID");
  const apiUrl = buildTelegramBotApiUrl(env, "sendDocument");
  const baseName = fileName.replace(/\.[^.]+$/, "") || "file";
  const estimatedTotalChunks = declaredTotalBytes
    ? Math.max(1, Math.ceil(declaredTotalBytes / CHUNK_SIZE_TELEGRAM))
    : null;

  const buffer = new Uint8Array(CHUNK_SIZE_TELEGRAM);
  let buffered = 0;
  let size = 0;
  let uploadedBytes = 0;
  const telegramChunks = [];
  const uploadedMsgIds = [];

  const rollbackUploadedChunks = async () => {
    if (!uploadedMsgIds.length) return;
    await deleteTelegramMessagesBatch(env, uploadedMsgIds).catch((err) => {
      console.warn("Telegram chunked URL upload rollback failed:", err?.message || err);
    });
  };

  const flushChunk = async (byteCount, isFinal) => {
    if (byteCount <= 0) return;
    signal?.throwIfAborted();
    const partIndex = telegramChunks.length;
    const partLabel = String(partIndex + 1).padStart(3, "0");
    const partFileName = `${baseName}.part${partLabel}`;
    const slice = byteCount === buffer.byteLength ? buffer : buffer.subarray(0, byteCount);
    const partFile = new File([slice], partFileName, { type: "application/octet-stream" });

    const res = await postTelegramUpload(
      apiUrl,
      () => {
        const formData = new FormData();
        formData.append("chat_id", chatId);
        formData.append("document", partFile);
        return formData;
      },
      signal
    );

    if (!res.response?.ok) {
      const errResp = formatTelegramUploadFailure(res);
      const errData = await errResp.json().catch(() => ({ error: "Telegram 分片上传失败" }));
      throw new RemoteUploadError(errResp.status, errData.error || "Telegram 分片上传失败", {
        retryable: Boolean(errData.retryable),
      });
    }

    const fileId = pickTelegramFileId(res.data);
    const msgId = res.data?.result?.message_id;
    if (!fileId) {
      throw new RemoteUploadError(502, `Telegram 分片 ${partIndex + 1} 未返回可用的文件 ID`, {
        retryable: true,
      });
    }
    if (msgId) uploadedMsgIds.push(msgId);
    telegramChunks.push({
      i: partIndex,
      fileId,
      ...(msgId ? { msgId } : {}),
      size: byteCount,
    });
    uploadedBytes += byteCount;

    if (progressCtx?.report) {
      progressCtx.report({
        type: "progress",
        phase: isFinal ? "saving" : "transferring",
        ...progressCtx.details,
        telegramChunked: true,
        receivedBytes: size,
        uploadedBytes,
        chunkIndex: telegramChunks.length,
        totalChunks: isFinal ? telegramChunks.length : estimatedTotalChunks,
      });
    }
  };

  try {
    for await (const chunk of chunks) {
      let offset = 0;
      while (offset < chunk.byteLength) {
        if (buffered === buffer.byteLength) {
          await flushChunk(buffered, false);
          buffered = 0;
        }
        const length = Math.min(buffer.byteLength - buffered, chunk.byteLength - offset);
        buffer.set(chunk.subarray(offset, offset + length), buffered);
        buffered += length;
        offset += length;
      }
      size += chunk.byteLength;
    }

    signal?.throwIfAborted();

    // 未知总长度且实际体积 <= 18MB：退回普通单消息上传，保持签名直链与单跳下载体验
    if (telegramChunks.length === 0) {
      const singleBuf = buffer.slice(0, buffered).buffer;
      return await uploadToTelegram(
        singleBuf,
        fileName,
        fileExtension,
        contentType,
        size,
        env,
        fallbackOrigin,
        folderPath,
        context,
        signal
      );
    }

    if (buffered > 0) {
      await flushChunk(buffered, true);
      buffered = 0;
    }

    const tgId = randomId("tg");
    const kvKey = `telegram:${tgId}.${fileExtension}`;
    const firstChunk = telegramChunks[0];
    const fullMetadata = appendCommonMetadata(
      {
        TimeStamp: Date.now(),
        ListType: "None",
        Label: "None",
        liked: false,
        fileName,
        fileSize: size,
        contentType,
        storageType: "telegram",
        telegramChunked: true,
        telegramChunkSize: CHUNK_SIZE_TELEGRAM,
        telegramChunks,
        telegramFileId: firstChunk.fileId,
        telegramMessageId: firstChunk.msgId || undefined,
        signedLink: false,
      },
      folderPath
    );

    const { telegramChunks: _omitChunks, ...compactMeta } = fullMetadata;
    const fullJson = JSON.stringify(fullMetadata);
    await putKvFileMetadata(env, kvKey, compactMeta, fullJson);
    await putRecordIndex(env, kvKey, { metadata: fullMetadata });

    const directLink = buildTelegramDirectLink(env, kvKey, fallbackOrigin);
    const noticeTask = (async () => {
      try {
        const noticeResult = await sendTelegramUploadNotice(
          {
            chatId,
            replyToMessageId: firstChunk.msgId || undefined,
            directLink,
            fileId: firstChunk.fileId,
            messageId: firstChunk.msgId,
            fileName,
            fileSize: size,
          },
          env
        );
        if (!noticeResult?.ok && !noticeResult?.skipped) {
          console.warn(
            "Telegram chunked URL upload notice failed:",
            noticeResult?.data?.description || noticeResult?.error || "unknown error"
          );
        }
      } catch (error) {
        console.warn("Telegram chunked URL upload notice error:", error.message);
      }
    })();

    if (typeof context?.waitUntil === "function") {
      context.waitUntil(noticeTask);
    } else {
      await noticeTask;
    }

    return jsonResponse([{
      src: `/file/${kvKey}`,
      fileName,
      name: fileName,
      size,
      telegramChunked: true,
      totalChunks: telegramChunks.length,
    }]);
  } catch (error) {
    await rollbackUploadedChunks();
    if (error instanceof RemoteUploadError) throw error;
    if (signal?.aborted) throw new RemoteUploadError(408, "转存连接已断开", { retryable: true });
    console.error("Telegram chunked URL upload error:", error);
    return jsonResponse({ error: `Telegram 分片转存失败: ${error.message}`, retryable: true }, 502);
  }
}

async function writeRemoteR2Object(bucket, objectKey, chunks, options, signal, progressCtx = null) {
  let buffer;
  let buffered = 0;
  let size = 0;
  let uploadedBytes = 0;
  let multipart;
  let nextPartNumber = 1;
  const parts = [];
  const inFlight = [];

  const enqueuePartUpload = async (partNumber, partBuffer) => {
    const task = retryR2Op(
      () => multipart.uploadPart(partNumber, partBuffer),
      { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 1500, signal }
    ).then((part) => {
      parts.push(part);
      uploadedBytes += partBuffer.byteLength;
      if (progressCtx?.report) {
        progressCtx.report({
          type: "progress",
          phase: "transferring",
          ...progressCtx.details,
          receivedBytes: size,
          uploadedBytes,
          chunkIndex: parts.length,
          totalChunks: progressCtx.details?.totalBytes
            ? Math.ceil(progressCtx.details.totalBytes / R2_URL_PART_SIZE)
            : null,
        });
      }
    });
    // 挂空 catch 防止流水线中某片提前 reject 时在主循环 await 之前触发未捕获异常
    task.catch(() => {});
    inFlight.push(task);
    if (inFlight.length >= R2_URL_UPLOAD_CONCURRENCY) {
      await inFlight.shift();
    }
  };

  try {
    for await (const chunk of chunks) {
      // R2 requires all non-final parts to have the same size.
      buffer ??= new Uint8Array(R2_URL_PART_SIZE);
      let offset = 0;
      while (offset < chunk.byteLength) {
        if (buffered === buffer.byteLength) {
          signal.throwIfAborted();
          multipart ??= await retryR2Op(
            () => bucket.createMultipartUpload(objectKey, options),
            { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 1200, signal }
          );
          const partNumber = nextPartNumber++;
          const filled = buffer;
          buffer = new Uint8Array(R2_URL_PART_SIZE);
          buffered = 0;
          await enqueuePartUpload(partNumber, filled);
        }
        const length = Math.min(buffer.byteLength - buffered, chunk.byteLength - offset);
        buffer.set(chunk.subarray(offset, offset + length), buffered);
        buffered += length;
        offset += length;
      }
      size += chunk.byteLength;
    }

    signal.throwIfAborted();
    const lastPart = buffer.subarray(0, buffered);
    if (multipart) {
      if (inFlight.length) {
        await Promise.all(inFlight);
        inFlight.length = 0;
      }
      if (buffered > 0) {
        const lastPartNumber = nextPartNumber++;
        const part = await retryR2Op(
          () => multipart.uploadPart(lastPartNumber, lastPart),
          { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 1500, signal }
        );
        parts.push(part);
      }
      parts.sort((a, b) => a.partNumber - b.partNumber);
      signal.throwIfAborted();
      await retryR2Op(
        () => multipart.complete(parts),
        { maxAttempts: 2, baseDelayMs: 250, maxDelayMs: 1000, signal }
      );
    } else {
      await retryR2Op(
        () => bucket.put(objectKey, lastPart, options),
        { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 1200, signal }
      );
    }
    return size;
  } catch (error) {
    if (inFlight.length) {
      await Promise.allSettled(inFlight);
    }
    if (multipart) await multipart.abort().catch((err) => console.warn("R2 URL upload abort failed:", err));
    throw error;
  }
}

async function uploadToR2(chunks, fileName, fileExtension, contentType, env, folderPath, signal, progressCtx = null) {
  let objectKey = null;
  let objectWritten = false;
  try {
    const fileId = randomId("r2");
    objectKey = `${fileId}.${fileExtension}`;
    const fileSize = await writeRemoteR2Object(
      env.R2_BUCKET,
      objectKey,
      chunks,
      {
        httpMetadata: { contentType },
        customMetadata: { fileName: encodeURIComponent(fileName), uploadTime: Date.now().toString() },
      },
      signal,
      progressCtx
    );
    objectWritten = true;

    if (env.img_url) {
      // 先算出 metadata 再写：KV 与 D1 共用同一份，省掉 D1 登记时的 KV 回读
      const recordMetadata = appendCommonMetadata(
        {
          TimeStamp: Date.now(),
          ListType: "None",
          Label: "None",
          liked: false,
          fileName,
          fileSize,
          storageType: "r2",
          r2Key: objectKey,
        },
        folderPath
      );
      await putKvFileMetadata(env, `r2:${objectKey}`, recordMetadata);
      await putRecordIndex(env, `r2:${objectKey}`, { metadata: recordMetadata });
    }

    return jsonResponse([{
      src: `/file/r2:${objectKey}`,
      fileName,
      name: fileName,
      size: fileSize,
    }]);
  } catch (error) {
    if (objectWritten && objectKey && env.R2_BUCKET && typeof env.R2_BUCKET.delete === "function") {
      await env.R2_BUCKET.delete(objectKey).catch((delErr) => {
        console.warn(`R2 URL upload rollback delete failed (${objectKey}):`, delErr?.message || delErr);
      });
    }
    if (error instanceof RemoteUploadError) throw error;
    console.error("R2 upload error:", error);
    return jsonResponse({ error: `R2 upload failed: ${error.message}`, retryable: true }, 500);
  }
}

async function retryBackendUpload(operation, signal) {
  const startedAt = Date.now();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (signal?.aborted) throw new RemoteUploadError(408, "转存连接已断开", { retryable: true });
    try {
      return await operation();
    } catch (error) {
      if (signal?.aborted) throw new RemoteUploadError(408, "转存连接已断开", { retryable: true });
      const msg = String(error?.message || "");
      const looksClientError = /\b(400|401|403|404|409|413|422)\b/.test(msg);
      if (attempt === 0 && !looksClientError && Date.now() - startedAt < 25_000) {
        await sleepWithSignal(BACKEND_RETRY_DELAY_MS, signal);
        continue;
      }
      throw error;
    }
  }
}

async function uploadToS3(arrayBuffer, fileName, fileExtension, contentType, fileSize, env, folderPath = "", signal = null) {
  try {
    const s3 = createS3Client(env);
    const fileId = randomId("s3");
    const objectKey = `${fileId}.${fileExtension}`;

    await retryBackendUpload(
      () =>
        s3.putObject(objectKey, arrayBuffer, {
          contentType,
          metadata: {
            "x-amz-meta-filename": encodeURIComponent(fileName),
            "x-amz-meta-uploadtime": Date.now().toString(),
          },
        }),
      signal
    );

    if (env.img_url) {
      // 先算出 metadata 再写：KV 与 D1 共用同一份，省掉 D1 登记时的 KV 回读
      const recordMetadata = appendCommonMetadata(
        {
          TimeStamp: Date.now(),
          ListType: "None",
          Label: "None",
          liked: false,
          fileName,
          fileSize,
          storageType: "s3",
          s3Key: objectKey,
        },
        folderPath
      );
      await putKvFileMetadata(env, `s3:${objectKey}`, recordMetadata);
      await putRecordIndex(env, `s3:${objectKey}`, { metadata: recordMetadata });
    }

    return jsonResponse([{
      src: `/file/s3:${objectKey}`,
      fileName,
      name: fileName,
      size: fileSize,
    }]);
  } catch (error) {
    if (error instanceof RemoteUploadError) throw error;
    console.error("S3 upload error:", error);
    return jsonResponse({ error: `S3 upload failed: ${error.message}`, retryable: true }, 500);
  }
}

async function uploadToDiscordStorage(arrayBuffer, fileName, fileExtension, contentType, fileSize, env, folderPath = "", signal = null) {
  try {
    const result = await retryBackendUpload(
      async () => {
        const res = await uploadToDiscord(arrayBuffer, fileName, contentType, env);
        if (!res.success) throw new Error(res.error || "unknown error");
        return res;
      },
      signal
    );

    const fileId = randomId("discord");
    const kvKey = `discord:${fileId}.${fileExtension}`;

    if (env.img_url) {
      // 先算出 metadata 再写：KV 与 D1 共用同一份，省掉 D1 登记时的 KV 回读
      const recordMetadata = appendCommonMetadata(
        {
          TimeStamp: Date.now(),
          ListType: "None",
          Label: "None",
          liked: false,
          fileName,
          fileSize,
          storageType: "discord",
          discordChannelId: result.channelId,
          discordMessageId: result.messageId,
          discordAttachmentId: result.attachmentId,
          discordUploadMode: result.mode,
          discordSourceUrl: result.sourceUrl,
        },
        folderPath
      );
      await putKvFileMetadata(env, kvKey, recordMetadata);
      await putRecordIndex(env, kvKey, { metadata: recordMetadata });
    }

    return jsonResponse([{
      src: `/file/${kvKey}`,
      fileName,
      name: fileName,
      size: fileSize,
    }]);
  } catch (error) {
    if (error instanceof RemoteUploadError) throw error;
    console.error("Discord upload error:", error);
    return jsonResponse({ error: `Discord upload failed: ${error.message}`, retryable: true }, 500);
  }
}

async function uploadToHFStorage(arrayBuffer, fileName, fileExtension, _contentType, fileSize, env, folderPath = "", signal = null) {
  try {
    const fileId = randomId("hf");
    const hfPath = joinStoragePath(folderPath, `${fileId}.${fileExtension}`);

    const result = await retryBackendUpload(
      async () => {
        const res = await uploadToHuggingFace(arrayBuffer, hfPath, fileName, env);
        if (!res.success) throw new Error(res.error || "unknown error");
        return res;
      },
      signal
    );

    const kvKey = `hf:${fileId}.${fileExtension}`;

    if (env.img_url) {
      // 先算出 metadata 再写：KV 与 D1 共用同一份，省掉 D1 登记时的 KV 回读
      const recordMetadata = appendCommonMetadata(
        {
          TimeStamp: Date.now(),
          ListType: "None",
          Label: "None",
          liked: false,
          fileName,
          fileSize,
          storageType: "huggingface",
          hfPath,
        },
        folderPath
      );
      await putKvFileMetadata(env, kvKey, recordMetadata);
      await putRecordIndex(env, kvKey, { metadata: recordMetadata });
    }

    return jsonResponse([{
      src: `/file/${kvKey}`,
      fileName,
      name: fileName,
      size: fileSize,
    }]);
  } catch (error) {
    if (error instanceof RemoteUploadError) throw error;
    console.error("HuggingFace upload error:", error);
    return jsonResponse({ error: `HuggingFace upload failed: ${error.message}`, retryable: true }, 500);
  }
}

async function uploadToWebDAVStorage(arrayBuffer, fileName, fileExtension, contentType, fileSize, env, folderPath = "", signal = null) {
  try {
    const fileId = randomId("wd");
    const publicId = `${fileId}.${fileExtension}`;
    const webdavPath = joinStoragePath(folderPath, publicId);

    const result = await retryBackendUpload(
      () => uploadToWebDAV(arrayBuffer, webdavPath, contentType || "application/octet-stream", env),
      signal
    );

    const kvKey = `webdav:${publicId}`;
    if (env.img_url) {
      // 先算出 metadata 再写：KV 与 D1 共用同一份，省掉 D1 登记时的 KV 回读
      const recordMetadata = appendCommonMetadata(
        {
          TimeStamp: Date.now(),
          ListType: "None",
          Label: "None",
          liked: false,
          fileName,
          fileSize,
          storageType: "webdav",
          webdavPath: normalizeWebDAVPath(result.path || webdavPath),
          webdavEtag: result.etag || undefined,
        },
        folderPath
      );
      await putKvFileMetadata(env, kvKey, recordMetadata);
      await putRecordIndex(env, kvKey, { metadata: recordMetadata });
    }

    return jsonResponse([{
      src: `/file/${kvKey}`,
      fileName,
      name: fileName,
      size: fileSize,
    }]);
  } catch (error) {
    if (error instanceof RemoteUploadError) throw error;
    console.error("WebDAV upload error:", error);
    return jsonResponse({ error: `WebDAV upload failed: ${error.message}`, retryable: true }, 500);
  }
}

async function uploadToGitHubStorage(arrayBuffer, fileName, fileExtension, contentType, fileSize, env, folderPath = "", signal = null) {
  try {
    const fileId = randomId("github");
    const publicId = `${fileId}.${fileExtension}`;
    const githubStorageKey = joinStoragePath(folderPath, publicId);

    const result = await retryBackendUpload(
      () =>
        uploadToGitHub(
          arrayBuffer,
          normalizeGitHubStoragePath(githubStorageKey),
          fileName,
          contentType || "application/octet-stream",
          env
        ),
      signal
    );

    const kvKey = `github:${publicId}`;
    if (env.img_url) {
      // 先算出 metadata 再写：KV 与 D1 共用同一份，省掉 D1 登记时的 KV 回读
      const recordMetadata = appendCommonMetadata(
        {
          TimeStamp: Date.now(),
          ListType: "None",
          Label: "None",
          liked: false,
          fileName,
          fileSize,
          storageType: "github",
          githubStorageKey: normalizeGitHubStoragePath(result.storagePath || githubStorageKey),
          ...(result.metadata || {}),
        },
        folderPath
      );
      await putKvFileMetadata(env, kvKey, recordMetadata);
      await putRecordIndex(env, kvKey, { metadata: recordMetadata });
    }

    return jsonResponse([{
      src: `/file/${kvKey}`,
      fileName,
      name: fileName,
      size: fileSize,
    }]);
  } catch (error) {
    if (error instanceof RemoteUploadError) throw error;
    console.error("GitHub upload error:", error);
    return jsonResponse({ error: `GitHub upload failed: ${error.message}`, retryable: true }, 500);
  }
}

async function buildTelegramDirectId(fileId, fileExtension, fileName, mimeType, fileSize, messageId, env) {
  if (!shouldUseSignedTelegramLinks(env)) {
    return `${fileId}.${fileExtension}`;
  }
  // 未配置密钥时 createSignedTelegramFileId 返回 null（fail-closed），
  // 这里原样传回，由调用点判定并给出明确错误，避免把 `null` 当成直链 ID。
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
