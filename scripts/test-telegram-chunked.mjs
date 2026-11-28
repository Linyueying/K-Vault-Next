/**
 * Telegram 虚拟分片对象存储（方案一）端到端测试。
 *
 * 运行：node scripts/test-telegram-chunked.mjs
 *
 * 覆盖：
 *  1. status.js 限额暴露（2GB / 20MB 直传阈值 / supportsChunkUpload）
 *  2. init.js 校验（>2GB 拒绝、关闭元数据持久化拒绝、18MB 分片上限与自定义分片）
 *  3. chunk.js 直传 sendDocument（零 KV/R2 暂存、D1 upload_parts 持久化、429 FloodWait Retry-After）
 *  4. 服务端级断点续传（跳过已传分片）
 *  5. complete.js 零字节 Manifest 写入（D1 + KV value，KV metadata < 1024B，纯 KV 读回补全，分享设置兼容）
 *  6. file/[[path]].js 流式拼接与跨分片原生 Range（HEAD 零上游请求、完整 GET SHA-256 校验、
 *     跨片/边界/开放/后缀 Range、If-Range、416、上游忽略 Range 返回 200 的本地切片兜底、
 *     分片 file_path 过期自愈）
 *  7. manage/delete/[id].js 级联批量删除所有 Telegram 分片消息
 *  8. abort.js 取消任务时清理已上传的 Telegram 分片消息与 upload_parts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { onRequestGet as statusGet } from '../functions/api/status.js';
import { onRequestPost as initPost } from '../functions/api/chunked-upload/init.js';
import {
  onRequestPost as chunkPost,
  clearTelegramCooldown,
  computeTelegramSendTimeoutMs,
} from '../functions/api/chunked-upload/chunk.js';
import { onRequestPost as completePost } from '../functions/api/chunked-upload/complete.js';
import { onRequestPost as abortPost } from '../functions/api/chunked-upload/abort.js';
import { onRequest as deleteRequest } from '../functions/api/manage/delete/[id].js';
import {
  onRequest as fileRequest,
  buildTgPathEdgeCacheKey,
  clearTgFilePathMemoryCache,
} from '../functions/file/[[path]].js';
import { getRecordWithKey } from '../functions/utils/file-record.js';
import { applyShareOptions } from '../functions/utils/share-options.js';
import { ensureSchema, resetSchemaCache } from '../functions/utils/schema.js';
import { deleteTelegramMessagesBatch } from '../functions/utils/telegram.js';
import {
  CHUNK_SIZE_TELEGRAM,
  TELEGRAM_WEB_UPLOAD_LIMIT,
  TELEGRAM_CHUNKED_MAX_FILE_SIZE,
} from '../functions/utils/chunk-limits.js';

const MB = 1024 * 1024;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function makeDeterministicBuffer(size) {
  const buf = new Uint8Array(size);
  let x = 0x9e3779b9;
  for (let i = 0; i < size; i += 1) {
    x = (Math.imul(x ^ (x >>> 16), 0x85ebca6b) + i) >>> 0;
    buf[i] = x & 0xff;
  }
  return buf;
}

function createMockKV() {
  const store = new Map();
  const kv = {
    store,
    putKeys: [],
    async get(key, opts) {
      const entry = store.get(key);
      if (!entry) return null;
      const type = typeof opts === 'string' ? opts : opts?.type;
      if (type === 'json') {
        return typeof entry.value === 'string' ? JSON.parse(entry.value) : entry.value;
      }
      if (type === 'arrayBuffer') {
        if (entry.value instanceof ArrayBuffer) return entry.value;
        if (ArrayBuffer.isView(entry.value)) {
          return entry.value.buffer.slice(entry.value.byteOffset, entry.value.byteOffset + entry.value.byteLength);
        }
        return new TextEncoder().encode(String(entry.value)).buffer;
      }
      return entry.value;
    },
    async getWithMetadata(key) {
      const entry = store.get(key);
      if (!entry) return { value: null, metadata: null };
      return { value: entry.value, metadata: entry.metadata || null };
    },
    async put(key, value, opts = {}) {
      if (opts?.metadata !== undefined) {
        const metaBytes = new TextEncoder().encode(JSON.stringify(opts.metadata)).byteLength;
        if (metaBytes > 1024) {
          throw new Error(`KV metadata exceeded 1024 bytes (${metaBytes} bytes) for key ${key}`);
        }
      }
      kv.putKeys.push(key);
      store.set(key, { value, metadata: opts?.metadata ?? null });
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = '' } = {}) {
      const keys = [];
      for (const [name, entry] of store.entries()) {
        if (!prefix || name.startsWith(prefix)) {
          keys.push({ name, metadata: entry.metadata || undefined });
        }
      }
      return { keys, list_complete: true };
    },
  };
  return kv;
}

function createMockD1() {
  const sqlite = new DatabaseSync(':memory:');
  return {
    sqlite,
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      let bound = [];
      const runner = {
        bind(...args) {
          bound = args;
          return runner;
        },
        async run() {
          const info = stmt.run(...bound);
          return { success: true, meta: { changes: info.changes } };
        },
        async first(col) {
          const row = stmt.get(...bound);
          if (!row) return null;
          return col ? row[col] : row;
        },
        async all() {
          const results = stmt.all(...bound);
          return { success: true, results };
        },
      };
      return runner;
    },
    async exec(sql) {
      sqlite.exec(sql);
      return { count: 1, duration: 1 };
    },
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };
}

function createMockTelegramServer() {
  let nextMsgId = 1000;
  const files = new Map(); // fileId -> { bytes: Uint8Array, msgId, pathVersion }
  const deletedMsgIds = [];
  const stats = {
    sendDocumentCalls: 0,
    getFileCalls: 0,
    fileDownloadCalls: 0,
    downloadedFileIds: [],
    deleteMessageCalls: 0,
    deleteMessagesCalls: 0,
  };
  let inject429Once = null; // { retryAfter: number }
  let injectSendTimeoutOnce = false;
  let injectGetFile502Once = false;
  let injectGetFile429Once = null; // { retryAfter: number }
  let injectFileDownload503Once = false;
  let ignoreRangeHeader = false;
  let rejectUpstreamRange = false;
  let disableBatchDelete = false;
  const stalePaths = new Set();

  const mockFetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;

    // 1. sendDocument
    if (url.includes('/sendDocument')) {
      stats.sendDocumentCalls += 1;
      if (injectSendTimeoutOnce) {
        injectSendTimeoutOnce = false;
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      if (inject429Once) {
        const ra = inject429Once.retryAfter;
        inject429Once = null;
        return new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: `Too Many Requests: retry after ${ra}`,
            parameters: { retry_after: ra },
          }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const formData = init.body;
      const doc = formData.get('document');
      const ab = await doc.arrayBuffer();
      const bytes = new Uint8Array(ab);
      const msgId = ++nextMsgId;
      const fileId = `BQAC_MOCK_${msgId}`;
      files.set(fileId, { bytes, msgId, pathVersion: 1 });

      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: msgId,
            document: {
              file_id: fileId,
              file_size: bytes.byteLength,
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 2. getFile
    if (url.includes('/getFile')) {
      stats.getFileCalls += 1;
      if (injectGetFile429Once) {
        const ra = injectGetFile429Once.retryAfter;
        injectGetFile429Once = null;
        return new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: `Too Many Requests: retry after ${ra}`,
            parameters: { retry_after: ra },
          }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (injectGetFile502Once) {
        injectGetFile502Once = false;
        return new Response(JSON.stringify({ ok: false, description: 'Bad Gateway' }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const parsed = new URL(url);
      const fileId = parsed.searchParams.get('file_id');
      const entry = files.get(fileId);
      if (!entry) {
        return new Response(JSON.stringify({ ok: false, description: 'file not found' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const filePath = `documents/${fileId}_v${entry.pathVersion}.bin`;
      return new Response(
        JSON.stringify({
          ok: true,
          result: { file_id: fileId, file_path: filePath },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 3. file download: /file/bot<token>/<filePath>
    const fileMatch = url.match(/\/file\/bot[^/]+\/(.+)$/);
    if (fileMatch) {
      const reqPath = fileMatch[1];
      if (stalePaths.has(reqPath)) {
        stalePaths.delete(reqPath);
        return new Response('File path expired', { status: 404 });
      }
      if (injectFileDownload503Once) {
        injectFileDownload503Once = false;
        return new Response('Telegram CDN temporary 503', { status: 503 });
      }

      const idMatch = reqPath.match(/documents\/([^/]+)_v(\d+)\.bin$/);
      if (!idMatch) return new Response('Not found', { status: 404 });
      const fileId = idMatch[1];
      const entry = files.get(fileId);
      if (!entry) return new Response('Not found', { status: 404 });

      stats.fileDownloadCalls += 1;
      stats.downloadedFileIds.push(fileId);

      const headersObj = new Headers(init.headers || {});
      const rangeHeader = headersObj.get('Range');
      const data = entry.bytes;

      if (rangeHeader && rejectUpstreamRange) {
        return new Response('Upstream rejected Range header', { status: 502 });
      }

      if (rangeHeader && !ignoreRangeHeader) {
        const m = rangeHeader.match(/^bytes=(\d+)-(\d+)$/);
        if (m) {
          const start = parseInt(m[1], 10);
          const end = Math.min(parseInt(m[2], 10), data.byteLength - 1);
          const slice = data.subarray(start, end + 1);
          return new Response(slice, {
            status: 206,
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(slice.byteLength),
              'Content-Range': `bytes ${start}-${end}/${data.byteLength}`,
              'Accept-Ranges': 'bytes',
            },
          });
        }
      }

      return new Response(data, {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(data.byteLength),
        },
      });
    }

    // 4a. deleteMessages (Bot API 7.0 batch delete up to 100 IDs)
    if (url.includes('/deleteMessages')) {
      stats.deleteMessagesCalls += 1;
      if (disableBatchDelete) {
        return new Response(JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const payload = JSON.parse(String(init.body || '{}'));
      const ids = Array.isArray(payload.message_ids) ? payload.message_ids : [];
      for (const id of ids) deletedMsgIds.push(id);
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 4b. deleteMessage
    if (url.includes('/deleteMessage')) {
      stats.deleteMessageCalls += 1;
      const payload = JSON.parse(String(init.body || '{}'));
      deletedMsgIds.push(payload.message_id);
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unexpected fetch URL in mock Telegram server: ${url}`);
  };

  return {
    files,
    deletedMsgIds,
    stats,
    mockFetch,
    setInject429Once(retryAfter) {
      inject429Once = { retryAfter };
    },
    setInjectSendTimeoutOnce() {
      injectSendTimeoutOnce = true;
    },
    setInjectGetFile502Once() {
      injectGetFile502Once = true;
    },
    setInjectGetFile429Once(retryAfter) {
      injectGetFile429Once = { retryAfter };
    },
    setInjectFileDownload503Once() {
      injectFileDownload503Once = true;
    },
    setIgnoreRangeHeader(flag) {
      ignoreRangeHeader = Boolean(flag);
    },
    setRejectUpstreamRange(flag) {
      rejectUpstreamRange = Boolean(flag);
    },
    setDisableBatchDelete(flag) {
      disableBatchDelete = Boolean(flag);
    },
    expireCurrentPath(fileId) {
      const entry = files.get(fileId);
      if (!entry) return;
      stalePaths.add(`documents/${fileId}_v${entry.pathVersion}.bin`);
      entry.pathVersion += 1;
    },
    resetDownloadStats() {
      stats.getFileCalls = 0;
      stats.fileDownloadCalls = 0;
      stats.downloadedFileIds = [];
    },
  };
}

const AUTH_HEADER = `Basic ${Buffer.from('admin:pass123').toString('base64')}`;

function makeEnv({ d1 = true, writeTgMeta = true } = {}) {
  const kv = createMockKV();
  const db = d1 ? createMockD1() : null;
  if (db) resetSchemaCache();
  const env = {
    img_url: kv,
    ...(db ? { DB: db } : {}),
    BASIC_USER: 'admin',
    BASIC_PASS: 'pass123',
    TG_BOT_TOKEN: '123456:MOCK_BOT_TOKEN',
    TG_CHAT_ID: '-100999888777',
    TELEGRAM_METADATA_MODE: writeTgMeta ? 'on' : 'off',
    KV_LEGACY_WRITE: 'true',
  };
  return { env, kv, db };
}

function makeContext(request, env, params = {}) {
  const pendingWaitUntil = [];
  return {
    request,
    env,
    params,
    waitUntil(p) {
      pendingWaitUntil.push(Promise.resolve(p).catch(() => {}));
    },
    async flush() {
      await Promise.all(pendingWaitUntil.splice(0));
    },
  };
}

function authedRequest(url, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', AUTH_HEADER);
  return new Request(url, { ...init, headers });
}

test('status.js exposes 2GB Telegram virtual chunked limits', async () => {
  const { env } = makeEnv();
  const ctx = makeContext(authedRequest('https://vault.test/api/status'), env);
  const res = await statusGet(ctx);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.uploadLimits.telegram.maxBytes, TELEGRAM_CHUNKED_MAX_FILE_SIZE);
  assert.equal(body.uploadLimits.telegram.directThreshold, TELEGRAM_WEB_UPLOAD_LIMIT);
  assert.equal(body.uploadLimits.telegram.supportsChunkUpload, true);
});

test('init.js validates Telegram chunked limits and metadata requirement', async () => {
  // 1. >2GB rejected with 413
  {
    const { env } = makeEnv();
    const res = await initPost(
      makeContext(
        authedRequest('https://vault.test/api/chunked-upload/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'huge.mkv',
            fileSize: TELEGRAM_CHUNKED_MAX_FILE_SIZE + 1,
            totalChunks: Math.ceil((TELEGRAM_CHUNKED_MAX_FILE_SIZE + 1) / CHUNK_SIZE_TELEGRAM),
            storageMode: 'telegram',
            chunkSize: CHUNK_SIZE_TELEGRAM,
          }),
        }),
        env
      )
    );
    assert.equal(res.status, 413);
    const data = await res.json();
    assert.equal(data.code, 'TELEGRAM_FILE_TOO_LARGE');
  }

  // 2. >20MB with WRITE_TG_METADATA=false rejected with 409
  {
    const { env } = makeEnv({ writeTgMeta: false });
    const res = await initPost(
      makeContext(
        authedRequest('https://vault.test/api/chunked-upload/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'movie.mp4',
            fileSize: 40 * MB,
            totalChunks: 3,
            storageMode: 'telegram',
            chunkSize: CHUNK_SIZE_TELEGRAM,
          }),
        }),
        env
      )
    );
    assert.equal(res.status, 409);
    const data = await res.json();
    assert.equal(data.code, 'TELEGRAM_METADATA_REQUIRED');
  }

  // 3. 40MB accepted with chunkBackend='telegram', chunkSize=18MB, totalChunks=3
  {
    const { env } = makeEnv();
    await ensureSchema(env);
    const res = await initPost(
      makeContext(
        authedRequest('https://vault.test/api/chunked-upload/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'movie.mp4',
            fileSize: 40 * MB,
            totalChunks: 3,
            storageMode: 'telegram',
            chunkSize: CHUNK_SIZE_TELEGRAM,
          }),
        }),
        env
      )
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.chunkBackend, 'telegram');
    assert.equal(data.telegramChunked, true);
    assert.equal(data.chunkSize, CHUNK_SIZE_TELEGRAM);
    assert.equal(data.totalChunks, 3);
  }
});

test('Telegram virtual chunked E2E: upload, 429 FloodWait, resume, zero-copy complete, streaming + cross-chunk Range + self-healing + cascade delete', async () => {
  const tg = createMockTelegramServer();
  const origFetch = globalThis.fetch;
  globalThis.fetch = tg.mockFetch;

  try {
    const { env, kv } = makeEnv({ d1: true });
    await ensureSchema(env);

    // 3 chunks: 1MB + 1MB + 512KB = 2,621,440 bytes
    const chunkSize = 1 * MB;
    const totalSize = 2 * MB + 512 * 1024;
    const payload = makeDeterministicBuffer(totalSize);
    const expectedHash = sha256(payload);
    const clientFileId = 'fp-tg-chunked-e2e-001';

    // ---- Step 1: init ----
    const initRes = await initPost(
      makeContext(
        authedRequest('https://vault.test/api/chunked-upload/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'archive.bin',
            fileSize: totalSize,
            totalChunks: 3,
            fileType: 'application/octet-stream',
            storageMode: 'telegram',
            chunkSize,
            fileId: clientFileId,
          }),
        }),
        env
      )
    );
    assert.equal(initRes.status, 200);
    const initData = await initRes.json();
    assert.equal(initData.chunkBackend, 'telegram');
    assert.equal(initData.totalChunks, 3);
    const uploadId = initData.uploadId;

    // ---- Step 2: upload chunks 0 & 1 directly to Telegram ----
    for (let i = 0; i < 2; i += 1) {
      const slice = payload.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, totalSize));
      const cRes = await chunkPost(
        makeContext(
          authedRequest(
            `https://vault.test/api/chunked-upload/chunk?uploadId=${uploadId}&chunkIndex=${i}`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(slice.byteLength),
              },
              body: slice,
            }
          ),
          env
        )
      );
      assert.equal(cRes.status, 200);
      const cData = await cRes.json();
      assert.equal(cData.success, true);
      assert.equal(cData.chunkBackend, 'telegram');
      assert.equal(cData.partNumber, i + 1);
      assert.equal(cData.size, slice.byteLength);
      assert.ok(cData.etag.startsWith('tg:'));
    }

    // Verify ZERO KV staging chunks written
    assert.equal(
      kv.putKeys.some((k) => k.startsWith('chunk:')),
      false,
      'Telegram virtual chunks must never stage bytes into KV'
    );

    // ---- Step 3: simulate Telegram 429 FloodWait on chunk 2 ----
    tg.setInject429Once(7);
    const slice2 = payload.subarray(2 * chunkSize, totalSize);
    const rateRes = await chunkPost(
      makeContext(
        authedRequest(
          `https://vault.test/api/chunked-upload/chunk?uploadId=${uploadId}&chunkIndex=2`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(slice2.byteLength),
            },
            body: slice2,
          }
        ),
        env
      )
    );
    assert.equal(rateRes.status, 429);
    assert.equal(rateRes.headers.get('Retry-After'), '7');
    const rateBody = await rateRes.json();
    assert.equal(rateBody.code, 'TG_RATE_LIMITED');
    assert.equal(rateBody.retryable, true);

    // ---- Step 4: server-side resume via init.js skips chunks 0 & 1 ----
    const resumeRes = await initPost(
      makeContext(
        authedRequest('https://vault.test/api/chunked-upload/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'archive.bin',
            fileSize: totalSize,
            totalChunks: 3,
            fileType: 'application/octet-stream',
            storageMode: 'telegram',
            chunkSize,
            fileId: clientFileId,
          }),
        }),
        env
      )
    );
    assert.equal(resumeRes.status, 200);
    const resumeData = await resumeRes.json();
    assert.equal(resumeData.resumed, true);
    assert.equal(resumeData.uploadId, uploadId);
    assert.deepEqual(resumeData.uploadedChunks, [0, 1]);
    assert.equal(resumeData.uploadedParts.length, 2);

    // ---- Step 5: upload chunk 2 after cooldown elapses & complete (zero-copy manifest) ----
    await clearTelegramCooldown(env);
    const c2Res = await chunkPost(
      makeContext(
        authedRequest(
          `https://vault.test/api/chunked-upload/chunk?uploadId=${uploadId}&chunkIndex=2`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(slice2.byteLength),
            },
            body: slice2,
          }
        ),
        env
      )
    );
    assert.equal(c2Res.status, 200);

    const completeCtx = makeContext(
      authedRequest('https://vault.test/api/chunked-upload/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId }),
      }),
      env
    );
    const completeRes = await completePost(completeCtx);
    await completeCtx.flush();
    assert.equal(completeRes.status, 200);
    const completeData = await completeRes.json();
    assert.equal(completeData.success, true);
    assert.ok(completeData.src.startsWith('/file/telegram:tg_'));
    assert.equal(tg.stats.getFileCalls, 0, 'complete.js must not download any bytes from Telegram');
    assert.equal(tg.stats.fileDownloadCalls, 0);

    const fileKey = completeData.src.replace(/^\/file\//, '');

    // Verify D1 record AND pure-KV hydration both return full telegramChunks
    const d1Lookup = await getRecordWithKey(env, fileKey, { forceAll: true });
    assert.equal(d1Lookup.record?.metadata?.telegramChunked, true);
    assert.equal(d1Lookup.record?.metadata?.telegramChunks?.length, 3);
    const chunkFileIds = d1Lookup.record.metadata.telegramChunks.map((c) => c.fileId);

    const kvOnlyEnv = { ...env };
    delete kvOnlyEnv.DB;
    const kvLookup = await getRecordWithKey(kvOnlyEnv, fileKey, { forceAll: true });
    assert.equal(kvLookup.record?.metadata?.telegramChunked, true);
    assert.equal(kvLookup.record?.metadata?.telegramChunks?.length, 3);

    // ---- Step 6: HEAD request makes ZERO Telegram API calls ----
    tg.resetDownloadStats();
    const headCtx = makeContext(
      new Request(`https://vault.test/file/${fileKey}`, { method: 'HEAD' }),
      env,
      { path: [fileKey] }
    );
    const headRes = await fileRequest(headCtx);
    await headCtx.flush();
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get('Content-Length'), String(totalSize));
    assert.equal(headRes.headers.get('Accept-Ranges'), 'bytes');
    const etag = headRes.headers.get('ETag');
    assert.ok(etag);
    assert.equal(tg.stats.getFileCalls, 0);
    assert.equal(tg.stats.fileDownloadCalls, 0);

    // ---- Step 7: Full GET streaming concatenation matches SHA-256 ----
    const fullCtx = makeContext(
      new Request(`https://vault.test/file/${fileKey}`),
      env,
      { path: [fileKey] }
    );
    const fullRes = await fileRequest(fullCtx);
    assert.equal(fullRes.status, 200);
    assert.equal(fullRes.headers.get('Content-Length'), String(totalSize));
    const fullBytes = new Uint8Array(await fullRes.arrayBuffer());
    await fullCtx.flush();
    assert.equal(fullBytes.byteLength, totalSize);
    assert.equal(sha256(fullBytes), expectedHash);

    // ---- Step 8: Cross-chunk Range spanning chunk 0 -> chunk 1 ONLY (chunk 2 untouched!) ----
    tg.resetDownloadStats();
    const rStart = chunkSize - 500;
    const rEnd = chunkSize + 700;
    const cross1Ctx = makeContext(
      new Request(`https://vault.test/file/${fileKey}`, {
        headers: { Range: `bytes=${rStart}-${rEnd}`, 'If-Range': etag },
      }),
      env,
      { path: [fileKey] }
    );
    const cross1Res = await fileRequest(cross1Ctx);
    assert.equal(cross1Res.status, 206);
    assert.equal(cross1Res.headers.get('Content-Range'), `bytes ${rStart}-${rEnd}/${totalSize}`);
    assert.equal(cross1Res.headers.get('Content-Length'), String(rEnd - rStart + 1));
    const cross1Bytes = new Uint8Array(await cross1Res.arrayBuffer());
    await cross1Ctx.flush();
    assert.deepEqual(cross1Bytes, payload.subarray(rStart, rEnd + 1));
    assert.deepEqual(tg.stats.downloadedFileIds, [chunkFileIds[0], chunkFileIds[1]]);

    // ---- Step 9: Cross-chunk Range spanning ALL 3 chunks (0 -> 1 -> 2) ----
    const r3Start = chunkSize - 123;
    const r3End = 2 * chunkSize + 456;
    const cross3Ctx = makeContext(
      new Request(`https://vault.test/file/${fileKey}`, {
        headers: { Range: `bytes=${r3Start}-${r3End}` },
      }),
      env,
      { path: [fileKey] }
    );
    const cross3Res = await fileRequest(cross3Ctx);
    assert.equal(cross3Res.status, 206);
    const cross3Bytes = new Uint8Array(await cross3Res.arrayBuffer());
    await cross3Ctx.flush();
    assert.deepEqual(cross3Bytes, payload.subarray(r3Start, r3End + 1));

    // ---- Step 10: Suffix Range & Open-ended Range ----
    const suffixCtx = makeContext(
      new Request(`https://vault.test/file/${fileKey}`, {
        headers: { Range: 'bytes=-600000' },
      }),
      env,
      { path: [fileKey] }
    );
    const suffixRes = await fileRequest(suffixCtx);
    assert.equal(suffixRes.status, 206);
    assert.equal(
      suffixRes.headers.get('Content-Range'),
      `bytes ${totalSize - 600000}-${totalSize - 1}/${totalSize}`
    );
    assert.deepEqual(
      new Uint8Array(await suffixRes.arrayBuffer()),
      payload.subarray(totalSize - 600000)
    );
    await suffixCtx.flush();

    const openStart = 2 * chunkSize + 100;
    const openCtx = makeContext(
      new Request(`https://vault.test/file/${fileKey}`, {
        headers: { Range: `bytes=${openStart}-` },
      }),
      env,
      { path: [fileKey] }
    );
    const openRes = await fileRequest(openCtx);
    assert.equal(openRes.status, 206);
    assert.deepEqual(
      new Uint8Array(await openRes.arrayBuffer()),
      payload.subarray(openStart)
    );
    await openCtx.flush();

    // ---- Step 11: If-Range mismatch falls back to full 200; OOB Range returns 416 ----
    const mismatchCtx = makeContext(
      new Request(`https://vault.test/file/${fileKey}`, {
        headers: { Range: 'bytes=0-99', 'If-Range': '"stale-etag"' },
      }),
      env,
      { path: [fileKey] }
    );
    const mismatchRes = await fileRequest(mismatchCtx);
    assert.equal(mismatchRes.status, 200);
    assert.equal(mismatchRes.headers.get('Content-Length'), String(totalSize));
    assert.equal((await mismatchRes.arrayBuffer()).byteLength, totalSize);
    await mismatchCtx.flush();

    const oobCtx = makeContext(
      new Request(`https://vault.test/file/${fileKey}`, {
        headers: { Range: `bytes=${totalSize + 10}-` },
      }),
      env,
      { path: [fileKey] }
    );
    const oobRes = await fileRequest(oobCtx);
    assert.equal(oobRes.status, 416);
    assert.equal(oobRes.headers.get('Content-Range'), `bytes */${totalSize}`);

    // ---- Step 12: Defensive local slicing when Telegram upstream ignores Range and returns 200 ----
    tg.setIgnoreRangeHeader(true);
    const defStart = chunkSize - 1000;
    const defEnd = chunkSize + 1500;
    const defCtx = makeContext(
      new Request(`https://vault.test/file/${fileKey}`, {
        headers: { Range: `bytes=${defStart}-${defEnd}` },
      }),
      env,
      { path: [fileKey] }
    );
    const defRes = await fileRequest(defCtx);
    assert.equal(defRes.status, 206);
    const defBytes = new Uint8Array(await defRes.arrayBuffer());
    await defCtx.flush();
    assert.deepEqual(defBytes, payload.subarray(defStart, defEnd + 1));
    tg.setIgnoreRangeHeader(false);

    // ---- Step 13: Per-chunk file_path expiry self-healing on chunk 1 ----
    tg.expireCurrentPath(chunkFileIds[1]);
    const healCtx = makeContext(
      new Request(`https://vault.test/file/${fileKey}`, {
        headers: { Range: `bytes=${chunkSize - 50}-${chunkSize + 50}` },
      }),
      env,
      { path: [fileKey] }
    );
    const healRes = await fileRequest(healCtx);
    assert.equal(healRes.status, 206);
    const healBytes = new Uint8Array(await healRes.arrayBuffer());
    await healCtx.flush();
    assert.deepEqual(healBytes, payload.subarray(chunkSize - 50, chunkSize + 51));

    // ---- Step 14: applyShareOptions works even with a 114-chunk (2GB) manifest (>1KB) ----
    const bigManifestMeta = {
      ...d1Lookup.record.metadata,
      telegramChunks: Array.from({ length: 114 }, (_, idx) => ({
        i: idx,
        fileId: `BQAC_BIG_${idx}_${'x'.repeat(30)}`,
        msgId: 5000 + idx,
        size: CHUNK_SIZE_TELEGRAM,
      })),
    };
    const sharedMeta = await applyShareOptions(env, fileKey, bigManifestMeta, {
      slug: 'tg-big-share',
      expiresIn: 3600,
      maxDownloads: 5,
      password: 'secret',
    });
    assert.equal(sharedMeta.shareSlug, 'tg-big-share');
    assert.equal(sharedMeta.telegramChunks.length, 114);
    // Restore 3-chunk metadata before cascade delete test
    await env.img_url.put(fileKey, JSON.stringify(d1Lookup.record.metadata), {
      metadata: {
        TimeStamp: Date.now(),
        fileName: 'archive.bin',
        fileSize: totalSize,
        storageType: 'telegram',
        chunked: true,
      },
    });
    // Also update D1 back to 3 chunks so delete/[id].js sees exact 3 msgIds
    const { registerFileRecord } = await import('../functions/utils/file-record.js');
    await registerFileRecord(env, fileKey, d1Lookup.record.metadata);

    // ---- Step 15: Cascade delete deletes all 3 Telegram messages ----
    const expectedMsgIds = d1Lookup.record.metadata.telegramChunks.map((c) => c.msgId);
    const delCtx = makeContext(
      authedRequest(`https://vault.test/api/manage/delete/${encodeURIComponent(fileKey)}`, {
        method: 'DELETE',
      }),
      env,
      { id: fileKey }
    );
    const delRes = await deleteRequest(delCtx);
    assert.equal(delRes.status, 200);
    const delData = await delRes.json();
    assert.equal(delData.success, true);
    assert.equal(delData.telegramDeleted, true);
    assert.equal(delData.telegramDeletedChunks, 3);
    assert.equal(delData.telegramTotalChunks, 3);
    assert.deepEqual([...tg.deletedMsgIds].sort((a, b) => a - b), [...expectedMsgIds].sort((a, b) => a - b));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('abort.js cleans up uploaded Telegram chunk messages and part states', async () => {
  const tg = createMockTelegramServer();
  const origFetch = globalThis.fetch;
  globalThis.fetch = tg.mockFetch;

  try {
    const { env } = makeEnv({ d1: true });
    await ensureSchema(env);

    const chunkSize = 1 * MB;
    const totalSize = 3 * MB;
    const payload = makeDeterministicBuffer(totalSize);

    const initRes = await initPost(
      makeContext(
        authedRequest('https://vault.test/api/chunked-upload/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'cancel-me.bin',
            fileSize: totalSize,
            totalChunks: 3,
            storageMode: 'telegram',
            chunkSize,
            fileId: 'fp-cancel-001',
          }),
        }),
        env
      )
    );
    assert.equal(initRes.status, 200);
    const { uploadId } = await initRes.json();

    // Upload 2 of 3 chunks
    for (let i = 0; i < 2; i += 1) {
      const slice = payload.subarray(i * chunkSize, (i + 1) * chunkSize);
      const res = await chunkPost(
        makeContext(
          authedRequest(
            `https://vault.test/api/chunked-upload/chunk?uploadId=${uploadId}&chunkIndex=${i}`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(slice.byteLength),
              },
              body: slice,
            }
          ),
          env
        )
      );
      assert.equal(res.status, 200);
    }

    assert.equal(tg.files.size, 2);

    // Abort upload
    const abortRes = await abortPost(
      makeContext(
        authedRequest('https://vault.test/api/chunked-upload/abort', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploadId }),
        }),
        env
      )
    );
    assert.equal(abortRes.status, 200);
    const abortData = await abortRes.json();
    assert.equal(abortData.ok, true);
    assert.equal(abortData.deletedTelegramChunks, 2);
    assert.equal(tg.deletedMsgIds.length, 2);

    // Task & upload_parts cleaned
    const remainingTask = await env.img_url.get(`upload:${uploadId}`);
    assert.equal(remainingTask, null);
    const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM upload_parts WHERE upload_id = ?')
      .bind(uploadId)
      .first();
    assert.equal(Number(row.c), 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('chunk.js passes through real Telegram 429 retry_after up to 3600s without premature truncation', async () => {
  const tg = createMockTelegramServer();
  const origFetch = globalThis.fetch;
  globalThis.fetch = tg.mockFetch;

  try {
    const { env } = makeEnv({ d1: true });
    await ensureSchema(env);
    const chunkSize = 1 * MB;
    const totalSize = 2 * MB;
    const payload = makeDeterministicBuffer(totalSize);

    const initRes = await initPost(
      makeContext(
        authedRequest('https://vault.test/api/chunked-upload/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'long-floodwait.bin',
            fileSize: totalSize,
            totalChunks: 2,
            storageMode: 'telegram',
            chunkSize,
            fileId: 'fp-floodwait-001',
          }),
        }),
        env
      )
    );
    assert.equal(initRes.status, 200);
    const { uploadId } = await initRes.json();

    const slice0 = payload.subarray(0, chunkSize);

    // 95s FloodWait passes through intact
    tg.setInject429Once(95);
    const res95 = await chunkPost(
      makeContext(
        authedRequest(
          `https://vault.test/api/chunked-upload/chunk?uploadId=${uploadId}&chunkIndex=0`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(slice0.byteLength),
            },
            body: slice0,
          }
        ),
        env
      )
    );
    assert.equal(res95.status, 429);
    assert.equal(res95.headers.get('Retry-After'), '95');
    const body95 = await res95.json();
    assert.equal(body95.code, 'TG_RATE_LIMITED');
    assert.equal(body95.retryAfter, 95);

    // 260s FloodWait passes through intact (not truncated to 180s)
    await clearTelegramCooldown(env);
    tg.setInject429Once(260);
    const res260 = await chunkPost(
      makeContext(
        authedRequest(
          `https://vault.test/api/chunked-upload/chunk?uploadId=${uploadId}&chunkIndex=0`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(slice0.byteLength),
            },
            body: slice0,
          }
        ),
        env
      )
    );
    assert.equal(res260.status, 429);
    assert.equal(res260.headers.get('Retry-After'), '260');
    const body260 = await res260.json();
    assert.equal(body260.retryAfter, 260);

    // >3600s FloodWait is bounded at 3600s
    await clearTelegramCooldown(env);
    tg.setInject429Once(4000);
    const resCap = await chunkPost(
      makeContext(
        authedRequest(
          `https://vault.test/api/chunked-upload/chunk?uploadId=${uploadId}&chunkIndex=0`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(slice0.byteLength),
            },
            body: slice0,
          }
        ),
        env
      )
    );
    assert.equal(resCap.status, 429);
    assert.equal(resCap.headers.get('Retry-After'), '3600');
    const bodyCap = await resCap.json();
    assert.equal(bodyCap.retryAfter, 3600);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('chunk.js idempotently reuses already-persisted Telegram chunks without duplicate sendDocument', async () => {
  const tg = createMockTelegramServer();
  const origFetch = globalThis.fetch;
  globalThis.fetch = tg.mockFetch;

  try {
    const { env } = makeEnv({ d1: true });
    await ensureSchema(env);
    const chunkSize = 1 * MB;
    const totalSize = 2 * MB;
    const payload = makeDeterministicBuffer(totalSize);

    const initRes = await initPost(
      makeContext(
        authedRequest('https://vault.test/api/chunked-upload/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'idempotent.bin',
            fileSize: totalSize,
            totalChunks: 2,
            storageMode: 'telegram',
            chunkSize,
            fileId: 'fp-idem-001',
          }),
        }),
        env
      )
    );
    assert.equal(initRes.status, 200);
    const { uploadId } = await initRes.json();

    const slice0 = payload.subarray(0, chunkSize);
    const first = await chunkPost(
      makeContext(
        authedRequest(
          `https://vault.test/api/chunked-upload/chunk?uploadId=${uploadId}&chunkIndex=0`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(slice0.byteLength),
            },
            body: slice0,
          }
        ),
        env
      )
    );
    assert.equal(first.status, 200);
    const firstData = await first.json();
    assert.equal(tg.stats.sendDocumentCalls, 1);

    // Resend same chunk (simulating lost 200 response on client): must reuse without calling sendDocument again
    const dup = await chunkPost(
      makeContext(
        authedRequest(
          `https://vault.test/api/chunked-upload/chunk?uploadId=${uploadId}&chunkIndex=0`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(slice0.byteLength),
            },
            body: slice0,
          }
        ),
        env
      )
    );
    assert.equal(dup.status, 200);
    const dupData = await dup.json();
    assert.equal(dupData.reused, true);
    assert.equal(dupData.etag, firstData.etag);
    assert.equal(tg.stats.sendDocumentCalls, 1, 'Duplicate chunk upload must NOT call sendDocument a second time');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('file/[[path]].js exposes chunk-alignment headers and recovers from same-path 503 + getFile 502 with pipelined prefetch', async () => {
  const tg = createMockTelegramServer();
  const origFetch = globalThis.fetch;
  globalThis.fetch = tg.mockFetch;

  try {
    const { env } = makeEnv({ d1: true });
    await ensureSchema(env);
    const chunkSize = 1 * MB;
    const totalSize = 3 * MB;
    const payload = makeDeterministicBuffer(totalSize);
    const expectedHash = sha256(payload);

    const initRes = await initPost(
      makeContext(
        authedRequest('https://vault.test/api/chunked-upload/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'stream-resilient.bin',
            fileSize: totalSize,
            totalChunks: 3,
            storageMode: 'telegram',
            chunkSize,
            fileId: 'fp-dl-resilient-001',
          }),
        }),
        env
      )
    );
    assert.equal(initRes.status, 200);
    const { uploadId } = await initRes.json();

    const parts = [];
    for (let i = 0; i < 3; i += 1) {
      const slice = payload.subarray(i * chunkSize, (i + 1) * chunkSize);
      const res = await chunkPost(
        makeContext(
          authedRequest(
            `https://vault.test/api/chunked-upload/chunk?uploadId=${uploadId}&chunkIndex=${i}`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(slice.byteLength),
              },
              body: slice,
            }
          ),
          env
        )
      );
      assert.equal(res.status, 200);
      const d = await res.json();
      parts.push({ partNumber: d.partNumber, etag: d.etag });
    }

    const compRes = await completePost(
      makeContext(
        authedRequest('https://vault.test/api/chunked-upload/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uploadId, parts }),
        }),
        env
      )
    );
    assert.equal(compRes.status, 200);
    const compData = await compRes.json();
    const fileKey = compData.src.replace(/^\/file\//, '');

    // 1) HEAD exposes chunk alignment headers with zero Telegram calls
    tg.resetDownloadStats();
    const headRes = await fileRequest(
      makeContext(new Request(`https://vault.test/file/${encodeURIComponent(fileKey)}`, { method: 'HEAD' }), env, { path: fileKey })
    );
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get('X-KVault-Storage'), 'telegram-chunked');
    assert.equal(headRes.headers.get('X-KVault-Chunk-Size'), String(chunkSize));
    assert.equal(headRes.headers.get('Content-Length'), String(totalSize));
    assert.equal(tg.stats.getFileCalls, 0);

    // 2) Inject transient getFile 502 AND same-path file download 503 (previously failed because refreshed === filePath!)
    tg.setInjectGetFile502Once();
    tg.setInjectFileDownload503Once();
    const getRes = await fileRequest(
      makeContext(new Request(`https://vault.test/file/${encodeURIComponent(fileKey)}`, { method: 'GET' }), env, { path: fileKey })
    );
    assert.equal(getRes.status, 200);
    assert.equal(getRes.headers.get('X-KVault-Storage'), 'telegram-chunked');
    assert.equal(getRes.headers.get('X-KVault-Chunk-Size'), String(chunkSize));
    const downloaded = new Uint8Array(await getRes.arrayBuffer());
    assert.equal(downloaded.byteLength, totalSize);
    assert.equal(sha256(downloaded), expectedHash, 'Downloaded bytes must match SHA-256 after 502+503 recovery & prefetch');

    // 3) Mid-stream cancel cleans up prefetched stream cleanly without throwing
    const cancelRes = await fileRequest(
      makeContext(new Request(`https://vault.test/file/${encodeURIComponent(fileKey)}`, { method: 'GET' }), env, { path: fileKey })
    );
    assert.equal(cancelRes.status, 200);
    const reader = cancelRes.body.getReader();
    const firstChunkRead = await reader.read();
    assert.equal(firstChunkRead.done, false);
    await reader.cancel();
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('deleteTelegramMessagesBatch deletes 114 chunks in 2 subrequests via deleteMessages and falls back safely on 404', async () => {
  const tg = createMockTelegramServer();
  const origFetch = globalThis.fetch;
  globalThis.fetch = tg.mockFetch;

  try {
    const { env } = makeEnv({ d1: false });
    const ids114 = Array.from({ length: 114 }, (_, idx) => 8000 + idx);

    // 1) Bot API 7.0 deleteMessages: 114 IDs -> 2 subrequests (100 + 14), 0 deleteMessage calls
    const batchRes = await deleteTelegramMessagesBatch(env, ids114);
    assert.equal(batchRes.total, 114);
    assert.equal(batchRes.deleted, 114);
    assert.equal(batchRes.method, 'batch');
    assert.equal(batchRes.truncated, false);
    assert.equal(tg.stats.deleteMessagesCalls, 2, '114 messages must be deleted in exactly 2 deleteMessages subrequests');
    assert.equal(tg.stats.deleteMessageCalls, 0);
    assert.equal(tg.deletedMsgIds.length, 114);

    // 2) Fallback when deleteMessages is unsupported (404): bounded single-message calls <= 36
    tg.deletedMsgIds.length = 0;
    tg.stats.deleteMessagesCalls = 0;
    tg.stats.deleteMessageCalls = 0;
    tg.setDisableBatchDelete(true);

    const fbRes = await deleteTelegramMessagesBatch(env, ids114, { maxFallbackMessages: 36 });
    assert.equal(fbRes.total, 114);
    assert.equal(fbRes.deleted, 36);
    assert.equal(fbRes.method, 'fallback');
    assert.equal(fbRes.truncated, true);
    assert.equal(tg.stats.deleteMessagesCalls, 1, 'Should probe deleteMessages once then switch to bounded fallback');
    assert.equal(tg.stats.deleteMessageCalls, 36, 'Fallback must respect maxFallbackMessages budget');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('chunk.js enforces shared server-side 429 cooldown across uploads with zero KV writes on normal path', async () => {
  const tg = createMockTelegramServer();
  const origFetch = globalThis.fetch;
  globalThis.fetch = tg.mockFetch;

  try {
    const { env, kv } = makeEnv({ d1: true });
    await ensureSchema(env);
    const chunkSize = 1 * MB;
    const totalSize = 2 * MB;
    const payload = makeDeterministicBuffer(totalSize);
    const slice0 = payload.subarray(0, chunkSize);

    const initA = await initPost(
      makeContext(
        authedRequest('https://vault.test/api/chunked-upload/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'shared-a.bin',
            fileSize: totalSize,
            totalChunks: 2,
            storageMode: 'telegram',
            chunkSize,
            fileId: 'fp-shared-a',
          }),
        }),
        env
      )
    );
    const { uploadId: uploadA } = await initA.json();

    const initB = await initPost(
      makeContext(
        authedRequest('https://vault.test/api/chunked-upload/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'shared-b.bin',
            fileSize: totalSize,
            totalChunks: 2,
            storageMode: 'telegram',
            chunkSize,
            fileId: 'fp-shared-b',
          }),
        }),
        env
      )
    );
    const { uploadId: uploadB } = await initB.json();

    // 1) Normal upload writes ZERO tg-cooldown: keys to KV
    const okRes = await chunkPost(
      makeContext(
        authedRequest(`https://vault.test/api/chunked-upload/chunk?uploadId=${uploadA}&chunkIndex=0`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(slice0.byteLength),
          },
          body: slice0,
        }),
        env
      )
    );
    assert.equal(okRes.status, 200);
    assert.equal(
      kv.putKeys.some((k) => k.startsWith('tg-cooldown:')),
      false,
      'Normal successful upload must write 0 tg-cooldown KV keys'
    );

    // 2) Upload A hits 429 (15s) -> Upload B immediately short-circuits with shared 429 and 0 extra sendDocument calls
    const sendCallsBefore = tg.stats.sendDocumentCalls;
    tg.setInject429Once(15);
    const slice1 = payload.subarray(chunkSize, totalSize);
    const rA = await chunkPost(
      makeContext(
        authedRequest(`https://vault.test/api/chunked-upload/chunk?uploadId=${uploadA}&chunkIndex=1`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(slice1.byteLength),
          },
          body: slice1,
        }),
        env
      )
    );
    assert.equal(rA.status, 429);
    assert.equal(tg.stats.sendDocumentCalls, sendCallsBefore + 1);
    assert.equal(kv.putKeys.some((k) => k.startsWith('tg-cooldown:')), true);

    const rB = await chunkPost(
      makeContext(
        authedRequest(`https://vault.test/api/chunked-upload/chunk?uploadId=${uploadB}&chunkIndex=0`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(slice0.byteLength),
          },
          body: slice0,
        }),
        env
      )
    );
    assert.equal(rB.status, 429);
    const bodyB = await rB.json();
    assert.equal(bodyB.code, 'TG_RATE_LIMITED');
    assert.equal(bodyB.cooldownSource, 'shared');
    assert.ok(bodyB.retryAfter >= 1 && bodyB.retryAfter <= 15);
    assert.equal(
      tg.stats.sendDocumentCalls,
      sendCallsBefore + 1,
      'Short-circuited upload B must make ZERO Telegram sendDocument calls'
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('chunk.js computes dynamic 25-55s timeout and does not inner-retry after AbortError timeout', async () => {
  assert.equal(computeTelegramSendTimeoutMs(1 * MB), 25 * 1000);
  assert.equal(computeTelegramSendTimeoutMs(10 * MB), 40 * 1000);
  assert.equal(computeTelegramSendTimeoutMs(18 * MB), 55 * 1000);

  const tg = createMockTelegramServer();
  const origFetch = globalThis.fetch;
  globalThis.fetch = tg.mockFetch;

  try {
    const { env } = makeEnv({ d1: true });
    await ensureSchema(env);
    const chunkSize = 1 * MB;
    const totalSize = 2 * MB;
    const payload = makeDeterministicBuffer(totalSize);
    const slice0 = payload.subarray(0, chunkSize);

    const initRes = await initPost(
      makeContext(
        authedRequest('https://vault.test/api/chunked-upload/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'timeout-once.bin',
            fileSize: totalSize,
            totalChunks: 2,
            storageMode: 'telegram',
            chunkSize,
            fileId: 'fp-timeout-once',
          }),
        }),
        env
      )
    );
    const { uploadId } = await initRes.json();

    tg.setInjectSendTimeoutOnce();
    const res = await chunkPost(
      makeContext(
        authedRequest(`https://vault.test/api/chunked-upload/chunk?uploadId=${uploadId}&chunkIndex=0`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(slice0.byteLength),
          },
          body: slice0,
        }),
        env
      )
    );
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.code, 'TG_PART_RETRY');
    assert.equal(body.retryable, true);
    assert.equal(
      tg.stats.sendDocumentCalls,
      1,
      'AbortError timeout must NOT trigger a 2nd attempt inside the same Worker invocation (prevents CF 100s 524)'
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('chunked Telegram download caches chunk file_path in Edge Cache (caches.default) with zero KV tgpath writes/deletes', async () => {
  const tg = createMockTelegramServer();
  const origFetch = globalThis.fetch;
  const origCaches = globalThis.caches;
  globalThis.fetch = tg.mockFetch;

  // Mock Cloudflare caches.default (distinguishing __kvault-tgpath entries from full-file byte cache)
  const edgeStore = new Map();
  let tgPathEdgePuts = 0;
  let tgPathEdgeMatches = 0;
  let tgPathEdgeDeletes = 0;
  const isTgPathKey = (k) => String(k).includes('/__kvault-tgpath/');
  globalThis.caches = {
    default: {
      async match(req) {
        const key = typeof req === 'string' ? req : req.url;
        const entry = edgeStore.get(key);
        if (!entry) return undefined;
        if (isTgPathKey(key)) tgPathEdgeMatches += 1;
        return entry.clone();
      },
      async put(req, resp) {
        const key = typeof req === 'string' ? req : req.url;
        if (isTgPathKey(key)) tgPathEdgePuts += 1;
        edgeStore.set(key, resp.clone());
      },
      async delete(req) {
        const key = typeof req === 'string' ? req : req.url;
        if (isTgPathKey(key)) tgPathEdgeDeletes += 1;
        return edgeStore.delete(key);
      },
    },
  };

  try {
    const { env, kv } = makeEnv({ d1: true });
    await ensureSchema(env);
    const kvDeletedKeys = [];
    const origKvDelete = kv.delete.bind(kv);
    kv.delete = async (key) => {
      kvDeletedKeys.push(key);
      return origKvDelete(key);
    };

    const chunkSize = 1 * MB;
    const totalSize = 3 * MB;
    const payload = makeDeterministicBuffer(totalSize);

    const initRes = await initPost(
      makeContext(
        authedRequest('https://vault.test/api/chunked-upload/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'edge-cache-zero-kv.bin',
            fileSize: totalSize,
            totalChunks: 3,
            storageMode: 'telegram',
            chunkSize,
            fileId: 'fp-edge-tgpath-001',
          }),
        }),
        env
      )
    );
    const { uploadId } = await initRes.json();

    const parts = [];
    for (let i = 0; i < 3; i += 1) {
      const slice = payload.subarray(i * chunkSize, (i + 1) * chunkSize);
      const res = await chunkPost(
        makeContext(
          authedRequest(
            `https://vault.test/api/chunked-upload/chunk?uploadId=${uploadId}&chunkIndex=${i}`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(slice.byteLength),
              },
              body: slice,
            }
          ),
          env
        )
      );
      const d = await res.json();
      parts.push({ partNumber: d.partNumber, etag: d.etag });
    }

    const compCtx = makeContext(
      authedRequest('https://vault.test/api/chunked-upload/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId, parts }),
      }),
      env
    );
    const compRes = await completePost(compCtx);
    await compCtx.flush();
    const { src } = await compRes.json();
    const fileKey = src.replace(/^\/file\//, '');
    const recordLookup = await getRecordWithKey(env, fileKey, { forceAll: true });
    const chunkFileIds = recordLookup.record.metadata.telegramChunks.map((c) => c.fileId);

    const fetchChunkRange = async (idx) => {
      const start = idx * chunkSize;
      const end = Math.min(totalSize - 1, start + chunkSize - 1);
      const ctx = makeContext(
        new Request(`https://vault.test/file/${fileKey}`, {
          headers: { Range: `bytes=${start}-${end}` },
        }),
        env,
        { path: [fileKey] }
      );
      const res = await fileRequest(ctx);
      assert.equal(res.status, 206);
      const bytes = new Uint8Array(await res.arrayBuffer());
      await ctx.flush();
      assert.deepEqual(bytes, payload.subarray(start, end + 1));
    };

    // Clear KV tracking before download
    kv.putKeys.length = 0;
    kvDeletedKeys.length = 0;
    clearTgFilePathMemoryCache();
    tg.resetDownloadStats();

    // 1) Cold Range download (all 3 chunks): populates Edge Cache with 3 tgpath entries, writes ZERO tgpath: keys to KV
    for (let i = 0; i < 3; i += 1) {
      await fetchChunkRange(i);
    }
    assert.equal(tg.stats.getFileCalls, 3);
    assert.equal(
      kv.putKeys.some((k) => k.startsWith('tgpath:')),
      false,
      'Cold chunked Telegram download must write ZERO tgpath: keys to KV'
    );
    assert.equal(tgPathEdgePuts, 3, `Expected 3 __kvault-tgpath edge cache puts, got ${tgPathEdgePuts}`);
    for (const fid of chunkFileIds) {
      const k = buildTgPathEdgeCacheKey(`https://vault.test/file/${fileKey}`, fid).url;
      assert.ok(edgeStore.has(k), `Edge cache should contain tgpath for ${fid}`);
      assert.equal(edgeStore.get(k).headers.get('Cache-Control'), 'public, max-age=2700');
    }

    // 2) Simulate new isolate (clear L1 memory): warm Range download hits caches.default with ZERO getFile calls & ZERO KV writes
    clearTgFilePathMemoryCache();
    kv.putKeys.length = 0;
    tg.resetDownloadStats();
    tgPathEdgeMatches = 0;

    for (let i = 0; i < 3; i += 1) {
      await fetchChunkRange(i);
    }
    assert.equal(tg.stats.getFileCalls, 0, 'Cross-isolate download must hit Edge Cache with 0 getFile calls');
    assert.equal(tgPathEdgeMatches, 3, `Expected 3 __kvault-tgpath edge cache hits, got ${tgPathEdgeMatches}`);
    assert.equal(kv.putKeys.some((k) => k.startsWith('tgpath:')), false);

    // 3) Expired path self-healing: evicts stale entry from Edge Cache with ZERO KV deletes
    clearTgFilePathMemoryCache();
    kvDeletedKeys.length = 0;
    tgPathEdgeDeletes = 0;
    tg.resetDownloadStats();
    tg.expireCurrentPath(chunkFileIds[1]);

    await fetchChunkRange(1);
    assert.equal(tg.stats.getFileCalls, 1, 'Only expired chunk 1 should call getFile once');
    assert.equal(tgPathEdgeDeletes, 1, 'Stale chunk path must be evicted from Edge Cache');
    assert.equal(
      kvDeletedKeys.some((k) => k.startsWith('tgpath:')),
      false,
      'Chunk path invalidation must issue ZERO KV deletes'
    );
  } finally {
    globalThis.fetch = origFetch;
    globalThis.caches = origCaches;
  }
});

test('chunked Telegram download handles last-1% resume without upstream Range, propagates getFile 429, and avoids Edge Cache subrequests on multi-chunk streams', async () => {
  const tg = createMockTelegramServer();
  const origFetch = globalThis.fetch;
  const origCaches = globalThis.caches;
  globalThis.fetch = tg.mockFetch;

  let tgPathEdgeOps = 0;
  const isTgPathKey = (k) => String(k).includes('/__kvault-tgpath/');
  globalThis.caches = {
    default: {
      async match(req) {
        const key = typeof req === 'string' ? req : req.url;
        if (isTgPathKey(key)) tgPathEdgeOps += 1;
        return undefined;
      },
      async put(req) {
        const key = typeof req === 'string' ? req : req.url;
        if (isTgPathKey(key)) tgPathEdgeOps += 1;
      },
      async delete(req) {
        const key = typeof req === 'string' ? req : req.url;
        if (isTgPathKey(key)) tgPathEdgeOps += 1;
        return true;
      },
    },
  };

  try {
    const { env } = makeEnv({ d1: true });
    await ensureSchema(env);
    const chunkSize = 1 * MB;
    const totalSize = 2 * MB + 500_000;
    const payload = makeDeterministicBuffer(totalSize);

    const initRes = await initPost(
      makeContext(
        authedRequest('https://vault.test/api/chunked-upload/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileName: 'last-one-percent.bin',
            fileSize: totalSize,
            totalChunks: 3,
            storageMode: 'telegram',
            chunkSize,
            fileId: 'fp-last-one-pct',
          }),
        }),
        env
      )
    );
    const { uploadId } = await initRes.json();

    const parts = [];
    for (let i = 0; i < 3; i += 1) {
      const start = i * chunkSize;
      const end = Math.min(totalSize, start + chunkSize);
      const slice = payload.subarray(start, end);
      const res = await chunkPost(
        makeContext(
          authedRequest(
            `https://vault.test/api/chunked-upload/chunk?uploadId=${uploadId}&chunkIndex=${i}`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(slice.byteLength),
              },
              body: slice,
            }
          ),
          env
        )
      );
      const d = await res.json();
      parts.push({ partNumber: d.partNumber, etag: d.etag });
    }

    const compCtx = makeContext(
      authedRequest('https://vault.test/api/chunked-upload/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadId, parts }),
      }),
      env
    );
    const compRes = await completePost(compCtx);
    await compCtx.flush();
    const { src } = await compRes.json();
    const fileKey = src.replace(/^\/file\//, '');

    // 1) Last 1% resume inside final chunk: must NOT send Range to Telegram (rejectUpstreamRange=true returns 502 if Range is sent!)
    tg.setRejectUpstreamRange(true);
    clearTgFilePathMemoryCache();
    const last1PctStart = totalSize - 25_000;
    const tailCtx = makeContext(
      new Request(`https://vault.test/file/${fileKey}`, {
        headers: { Range: `bytes=${last1PctStart}-` },
      }),
      env,
      { path: [fileKey] }
    );
    const tailRes = await fileRequest(tailCtx);
    assert.equal(tailRes.status, 206, 'Last-1% mid-chunk resume must succeed with 206 even when Telegram rejects upstream Range');
    assert.equal(tailRes.headers.get('Content-Range'), `bytes ${last1PctStart}-${totalSize - 1}/${totalSize}`);
    assert.equal(tailRes.headers.get('Content-Length'), '25000');
    const tailBytes = new Uint8Array(await tailRes.arrayBuffer());
    await tailCtx.flush();
    assert.deepEqual(tailBytes, payload.subarray(last1PctStart));
    tg.setRejectUpstreamRange(false);

    // 2) getFile 429 must propagate real 429 + Retry-After (NOT opaque 502!) with 0 extra retries
    clearTgFilePathMemoryCache();
    tg.resetDownloadStats();
    tg.setInjectGetFile429Once(25);
    const rlCtx = makeContext(
      new Request(`https://vault.test/file/${fileKey}`, {
        headers: { Range: `bytes=${last1PctStart}-` },
      }),
      env,
      { path: [fileKey] }
    );
    const rlRes = await fileRequest(rlCtx);
    assert.equal(rlRes.status, 429, 'getFile 429 must return HTTP 429 instead of masking as 502');
    assert.equal(rlRes.headers.get('Retry-After'), '25');
    assert.equal(tg.stats.getFileCalls, 1, 'Long getFile 429 must fail fast without burning retry subrequests');

    // 3) Multi-chunk continuous stream skips __kvault-tgpath Edge Cache ops to cut Cloudflare Free-tier subrequests in half
    clearTgFilePathMemoryCache();
    tgPathEdgeOps = 0;
    tg.resetDownloadStats();
    const fullCtx = makeContext(
      new Request(`https://vault.test/file/${fileKey}`),
      env,
      { path: [fileKey] }
    );
    const fullRes = await fileRequest(fullCtx);
    assert.equal(fullRes.status, 200);
    const fullBytes = new Uint8Array(await fullRes.arrayBuffer());
    await fullCtx.flush();
    assert.equal(fullBytes.byteLength, totalSize);
    assert.equal(sha256(fullBytes), sha256(payload));
    assert.equal(tgPathEdgeOps, 0, 'Multi-chunk stream must NOT burn caches.default subrequests on __kvault-tgpath');
  } finally {
    globalThis.fetch = origFetch;
    globalThis.caches = origCaches;
  }
});






async function lifecycleRequest(env, path, handler, body) {
  const context = makeContext(authedRequest(`https://vault.test/api/chunked-upload/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env);
  const response = await handler(context);
  await context.flush();
  return { status: response.status, body: await response.json() };
}

async function startLifecycleUpload(env, totalChunks = 2) {
  const result = await lifecycleRequest(env, 'init', initPost, {
    fileName: 'lifecycle.bin',
    fileSize: totalChunks * MB,
    chunkSize: MB,
    totalChunks,
    storageMode: 'telegram',
    fileId: '0123456789abcdef0123456789abcdef',
  });
  assert.equal(result.status, 200);
  return result.body.uploadId;
}

async function uploadLifecyclePart(env, uploadId, chunkIndex) {
  const context = makeContext(authedRequest(
    `https://vault.test/api/chunked-upload/chunk?uploadId=${uploadId}&chunkIndex=${chunkIndex}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(MB) },
      body: new Uint8Array(MB),
    },
  ), env);
  const response = await chunkPost(context);
  await context.flush();
  return { status: response.status, body: await response.json() };
}

test('Telegram requires a stored receipt before confirming a part and completes mixed D1/KV receipts', async (t) => {
  const { env, kv } = makeEnv();
  const telegram = createMockTelegramServer();
  t.mock.method(globalThis, 'fetch', telegram.mockFetch);
  const uploadId = await startLifecycleUpload(env);

  assert.equal((await uploadLifecyclePart(env, uploadId, 0)).status, 200);
  const prepare = env.DB.prepare;
  const put = kv.put;
  t.mock.method(env.DB, 'prepare', (sql) => {
    if (sql.includes('INSERT OR REPLACE INTO upload_parts')) throw new Error('D1 receipt write unavailable');
    return prepare(sql);
  });
  const kvWrite = t.mock.method(kv, 'put', (key, ...args) => {
    if (key.startsWith('part-state:')) throw new Error('KV receipt write unavailable');
    return put(key, ...args);
  });

  const failed = await uploadLifecyclePart(env, uploadId, 1);
  assert.equal(failed.status, 503);
  assert.equal(failed.body.code, 'TG_PART_STATE_RETRY');
  assert.ok(kv.putKeys.some((key) => key.startsWith(`tg-upload-cleanup:message:${uploadId}:`)));

  const incomplete = await lifecycleRequest(env, 'complete', completePost, { uploadId });
  assert.equal(incomplete.status, 409);
  assert.deepEqual(incomplete.body.missingChunks, [1]);

  kvWrite.mock.restore();
  assert.equal((await uploadLifecyclePart(env, uploadId, 1)).status, 200);
  const status = await lifecycleRequest(env, 'init', initPost, {
    uploadId, fileName: 'lifecycle.bin', fileSize: 2 * MB, chunkSize: MB, totalChunks: 2, storageMode: 'telegram',
  });
  assert.deepEqual(status.body.uploadedChunks, [0, 1]);
  assert.equal((await lifecycleRequest(env, 'complete', completePost, { uploadId })).status, 200);
  assert.equal(await kv.get(`part-state:${uploadId}:1`), null);
});

test('Telegram completion is single-writer and restores the same result after a lost outcome write', async (t) => {
  const { env, kv } = makeEnv({ d1: false });
  const telegram = createMockTelegramServer();
  t.mock.method(globalThis, 'fetch', telegram.mockFetch);
  const uploadId = await startLifecycleUpload(env);
  for (const index of [0, 1]) {
    assert.equal((await uploadLifecyclePart(env, uploadId, index)).status, 200);
  }

  const put = kv.put;
  let entered;
  let unblock;
  const enteredCommit = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { unblock = resolve; });
  let failOutcome = true;
  t.mock.method(kv, 'put', async (key, ...args) => {
    if (key.startsWith('telegram:tg_')) {
      entered();
      await blocked;
    }
    if (key === `tg-upload-outcome:${uploadId}` && failOutcome) {
      failOutcome = false;
      throw new Error('Completion outcome write unavailable');
    }
    return put(key, ...args);
  });

  const first = lifecycleRequest(env, 'complete', completePost, { uploadId });
  await enteredCommit;
  try {
    const concurrent = await lifecycleRequest(env, 'complete', completePost, { uploadId });
    assert.equal(concurrent.body.code, 'TG_TASK_BUSY');
    const abort = await lifecycleRequest(env, 'abort', abortPost, { uploadId });
    assert.equal(abort.body.code, 'TG_TASK_BUSY');
  } finally {
    unblock();
  }

  assert.equal((await first).status, 503);
  const second = await lifecycleRequest(env, 'complete', completePost, { uploadId });
  assert.equal(second.status, 200);
  const replay = await lifecycleRequest(env, 'complete', completePost, { uploadId });
  assert.deepEqual(replay.body, second.body);
  assert.equal(kv.putKeys.filter((key) => key.startsWith('telegram:tg_')).length, 1);
  const recovery = await lifecycleRequest(env, 'init', initPost, {
    uploadId, fileName: 'lifecycle.bin', fileSize: 2 * MB, chunkSize: MB, totalChunks: 2,
    storageMode: 'telegram', fileId: '0123456789abcdef0123456789abcdef', recoverCompleted: true,
  });
  assert.deepEqual(recovery.body.result, second.body);
  assert.equal((await lifecycleRequest(env, 'abort', abortPost, { uploadId })).body.alreadyCompleted, true);
  assert.equal(telegram.deletedMsgIds.length, 0);
});

test('Telegram cancellation keeps failed deletions recoverable and removes a late part', async (t) => {
  const { env, kv } = makeEnv();
  const telegram = createMockTelegramServer();
  let entered;
  let unblock;
  const sending = new Promise((resolve) => { entered = resolve; });
  const blocked = new Promise((resolve) => { unblock = resolve; });
  let delaySend = false;
  let rejectDeletion = true;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = String(input);
    if (url.includes('/sendDocument') && delaySend) {
      entered();
      await blocked;
    }
    if (url.includes('/deleteMessage') && rejectDeletion) {
      return Response.json({ ok: false, description: 'mock permission denied' }, { status: 403 });
    }
    return telegram.mockFetch(input, options);
  });
  const uploadId = await startLifecycleUpload(env);
  assert.equal((await uploadLifecyclePart(env, uploadId, 0)).status, 200);

  delaySend = true;
  const late = uploadLifecyclePart(env, uploadId, 1);
  await sending;
  try {
    const canceled = await lifecycleRequest(env, 'abort', abortPost, { uploadId });
    assert.equal(canceled.status, 200);
    assert.equal(canceled.body.cleanupPending, true);
    assert.equal(await kv.get(`upload:${uploadId}`), null);
    assert.ok(await kv.get(`tg-upload-cleanup:task:${uploadId}`));
    rejectDeletion = false;
  } finally {
    unblock();
  }

  assert.equal((await late).status, 404);
  const retry = await lifecycleRequest(env, 'abort', abortPost, { uploadId });
  assert.equal(retry.body.cleanupPending, false);
  assert.equal(telegram.deletedMsgIds.length, 2);
});

test('Telegram expiration sweeps fragments after the main KV task has expired', async (t) => {
  const { env, kv } = makeEnv({ d1: false });
  const telegram = createMockTelegramServer();
  t.mock.method(globalThis, 'fetch', telegram.mockFetch);
  const uploadId = await startLifecycleUpload(env);
  const task = await kv.get(`upload:${uploadId}`, { type: 'json' });
  const put = kv.put;
  let receiptExpiration;
  t.mock.method(kv, 'put', (key, value, options) => {
    if (key.startsWith('part-state:')) receiptExpiration = options?.expiration;
    return put(key, value, options);
  });
  assert.equal((await uploadLifecyclePart(env, uploadId, 0)).status, 200);
  assert.ok(receiptExpiration > task.expiresAt);
  await kv.delete(`upload:${uploadId}`);

  t.mock.method(Date, 'now', () => (task.expiresAt + 60) * 1000);
  const { sweepTelegramUploads } = await import('../functions/utils/telegram-upload-state.js');
  await sweepTelegramUploads(env);
  assert.equal(telegram.deletedMsgIds.length, 1);
  assert.equal(await kv.get(`part-state:${uploadId}:0`), null);
});

test('KV-only Telegram cancellation waits for cross-location visibility before deleting fragments', async (t) => {
  const { env, kv } = makeEnv({ d1: false });
  const telegram = createMockTelegramServer();
  t.mock.method(globalThis, 'fetch', telegram.mockFetch);
  const uploadId = await startLifecycleUpload(env);
  assert.equal((await uploadLifecyclePart(env, uploadId, 0)).status, 200);

  const canceled = await lifecycleRequest(env, 'abort', abortPost, { uploadId });
  assert.equal(canceled.body.cleanupPending, true);
  assert.equal(telegram.deletedMsgIds.length, 0);
  const journal = await kv.get(`tg-upload-cleanup:task:${uploadId}`, { type: 'json' });
  t.mock.method(Date, 'now', () => (journal.cleanupDueAt + 1) * 1000);
  const { sweepTelegramUploads } = await import('../functions/utils/telegram-upload-state.js');
  await sweepTelegramUploads(env);
  assert.equal(telegram.deletedMsgIds.length, 1);
  assert.equal(await kv.get(`tg-upload-cleanup:task:${uploadId}`), null);
});
