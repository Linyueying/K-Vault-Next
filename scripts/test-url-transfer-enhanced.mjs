import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRequestPost as mirror } from '../functions/api/upload-from-url.js';
import { onRequestPost as initChunks } from '../functions/api/chunked-upload/init.js';
import { onRequestPost as urlChunk } from '../functions/api/chunked-upload/url-chunk.js';
import { onRequestPost as completeChunks } from '../functions/api/chunked-upload/complete.js';
import { clearTelegramCooldown } from '../functions/api/chunked-upload/chunk.js';
import { makeMigratedEnv } from './test-utils.mjs';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const AUTH = { Authorization: 'Basic ' + btoa('test:test') };

function makeKv() {
  const entries = new Map();
  return {
    entries,
    async get(key, options) {
      const value = entries.get(key)?.value ?? null;
      return options?.type === 'json' && value ? JSON.parse(value) : value;
    },
    async getWithMetadata(key) {
      return entries.get(key) ?? { value: null, metadata: null };
    },
    async put(key, value, options) {
      entries.set(key, {
        value,
        metadata: options?.metadata,
        expiration: options?.expiration,
        expirationTtl: options?.expirationTtl,
      });
    },
    async delete(key) {
      entries.delete(key);
    },
    async list({ prefix }) {
      return {
        keys: [...entries.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      };
    },
  };
}

function postMirror(body, accept = 'application/json') {
  return new Request('https://example.test/api/upload-from-url', {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json', Accept: accept },
    body: JSON.stringify(body),
  });
}

test('URL probe: HEAD success, 405 Range GET fallback, Telegram chunked flag, oversize & SSRF guard', async (t) => {
  const kv = makeKv();
  const env = {
    BASIC_USER: 'test',
    BASIC_PASS: 'test',
    img_url: kv,
    TG_BOT_TOKEN: '123456:token',
    TG_CHAT_ID: '-10012345',
  };

  // 1. HEAD returns 405 -> falls back to GET Range: bytes=0-0 and detects 30MB Telegram virtual chunking
  const seenMethods = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    seenMethods.push(`${init.method}:${init.headers?.Range || ''}`);
    if (init.method === 'HEAD') {
      return new Response(null, { status: 405, statusText: 'Method Not Allowed' });
    }
    return new Response(new Uint8Array([0x25]), {
      status: 206,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes 0-0/${30 * MB}`,
        'Content-Disposition': 'attachment; filename="demo-clip.mp4"',
      },
    });
  });

  const res = await mirror({
    request: postMirror({
      action: 'probe',
      url: 'https://cdn.example/video/stream?id=42',
      storageMode: 'telegram',
    }),
    env,
  });
  assert.equal(res.status, 200);
  const probe = await res.json();
  assert.equal(probe.ok, true);
  assert.equal(probe.fileName, 'demo-clip.mp4');
  assert.equal(probe.size, 30 * MB);
  assert.equal(probe.acceptRanges, true);
  assert.equal(probe.storage, 'telegram');
  assert.equal(probe.telegramChunked, true);
  assert.equal(probe.exceedsLimit, false);
  assert.deepEqual(seenMethods, ['HEAD:', 'GET:bytes=0-0']);

  // 2. Oversize file detected during probe (> 180MB for Telegram chunked)
  t.mock.method(globalThis, 'fetch', async () => new Response(null, {
    status: 200,
    headers: {
      'Content-Length': String(220 * MB),
      'Content-Type': 'application/octet-stream',
    },
  }));
  const oversizeRes = await mirror({
    request: postMirror({
      action: 'probe',
      url: 'https://cdn.example/huge.iso',
      storageMode: 'telegram',
    }),
    env,
  });
  assert.equal(oversizeRes.status, 200);
  const oversize = await oversizeRes.json();
  assert.equal(oversize.exceedsLimit, true);
  assert.match(oversize.limitReason, /上限/);

  // 3. SSRF private address rejected
  const ssrfRes = await mirror({
    request: postMirror({
      action: 'probe',
      url: 'http://127.0.0.1/secret',
      storageMode: 'telegram',
    }),
    env,
  });
  assert.equal(ssrfRes.status, 400);
});

test('fetchRemote retries transient 503, auto-falls back to same-origin Referer on 403, and respects customFileName', async (t) => {
  let savedBytes = 0;
  let calls = 0;
  const referers = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls += 1;
    referers.push(init.headers?.Referer || '');
    if (calls === 1) {
      return new Response('temporary outage', { status: 503, statusText: 'Service Unavailable' });
    }
    if (calls === 2) {
      return new Response('hotlink denied', { status: 403, statusText: 'Forbidden' });
    }
    return new Response('hello-world', {
      status: 200,
      headers: {
        'Content-Length': '11',
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="original-name.pdf"',
      },
    });
  });

  const env = {
    BASIC_USER: 'test',
    BASIC_PASS: 'test',
    R2_BUCKET: {
      async put(_key, body) {
        savedBytes = body.byteLength;
      },
    },
  };

  const res = await mirror({
    request: postMirror({
      url: 'https://img.example/protected/doc',
      storageMode: 'r2',
      customFileName: 'my-renamed-doc',
    }),
    env,
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data[0].fileName, 'my-renamed-doc.pdf');
  assert.equal(data[0].size, 11);
  assert.equal(savedBytes, 11);
  assert.equal(calls, 3);
  assert.deepEqual(referers, ['', '', 'https://img.example/']);

  // Invalid Referer rejected with 400
  const badRef = await mirror({
    request: postMirror({
      url: 'https://img.example/protected/doc',
      storageMode: 'r2',
      referer: 'javascript:alert(1)',
    }),
    env,
  });
  assert.equal(badRef.status, 400);
});

test('readRemoteChunks auto-resumes mid-stream drop via Range + If-Range without data corruption', async (t) => {
  const fullPayload = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  let fetchCount = 0;
  let resumeRangeHeader = '';
  let resumeIfRangeHeader = '';
  let savedPayload = null;

  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    fetchCount += 1;
    if (fetchCount === 1) {
      let sent = false;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(fullPayload.subarray(0, 4));
            } else {
              controller.error(new Error('ECONNRESET mid-stream'));
            }
          },
        }),
        {
          status: 200,
          headers: {
            'Content-Length': '10',
            'Accept-Ranges': 'bytes',
            ETag: '"etag-v1"',
            'Content-Type': 'application/octet-stream',
          },
        }
      );
    }
    resumeRangeHeader = init.headers?.Range || '';
    resumeIfRangeHeader = init.headers?.['If-Range'] || '';
    return new Response(fullPayload.subarray(4), {
      status: 206,
      headers: {
        'Content-Range': 'bytes 4-9/10',
        'Content-Length': '6',
        'Content-Type': 'application/octet-stream',
      },
    });
  });

  const env = {
    BASIC_USER: 'test',
    BASIC_PASS: 'test',
    R2_BUCKET: {
      async put(_key, body) {
        savedPayload = new Uint8Array(body);
      },
    },
  };

  const res = await mirror({
    request: postMirror({ url: 'https://origin.example/resume.bin', storageMode: 'r2' }, 'application/x-ndjson'),
    env,
  });
  const events = (await res.text()).trim().split('\n').map((line) => JSON.parse(line));

  assert.equal(fetchCount, 2);
  assert.equal(resumeRangeHeader, 'bytes=4-');
  assert.equal(resumeIfRangeHeader, '"etag-v1"');
  assert.ok(events.some((ev) => ev.phase === 'resuming' && ev.receivedBytes === 4));
  const final = events.at(-1);
  assert.equal(final.type, 'result');
  assert.equal(final.status, 200);
  assert.equal(final.data[0].size, 10);
  assert.deepEqual([...savedPayload], [...fullPayload]);
});

test('R2 URL mirroring pipelines 8MB parts concurrently (concurrency=2) and completes in sorted part order', async (t) => {
  let remaining = 20; // 20MB -> 8MB + 8MB + 4MB (3 parts)
  t.mock.method(globalThis, 'fetch', async () => new Response(
    new ReadableStream({
      pull(controller) {
        if (remaining-- > 0) controller.enqueue(new Uint8Array(MB));
        else controller.close();
      },
    }),
    { headers: { 'Content-Length': String(20 * MB), 'Content-Type': 'application/octet-stream' } }
  ));

  let activeParts = 0;
  let maxConcurrentParts = 0;
  let completedOrder = null;

  const env = {
    BASIC_USER: 'test',
    BASIC_PASS: 'test',
    R2_BUCKET: {
      async createMultipartUpload() {
        return {
          async uploadPart(partNumber, bytes) {
            activeParts += 1;
            maxConcurrentParts = Math.max(maxConcurrentParts, activeParts);
            // Make part 1 slower than part 2 so out-of-order completion is tested too
            await new Promise((r) => setTimeout(r, partNumber === 1 ? 60 : 15));
            activeParts -= 1;
            return { partNumber, etag: `etag-${partNumber}-${bytes.byteLength}` };
          },
          async complete(parts) {
            completedOrder = parts.map((p) => p.partNumber);
          },
          async abort() {
            assert.fail('should not abort successful pipelined upload');
          },
        };
      },
    },
  };

  const res = await mirror({
    request: postMirror({ url: 'https://origin.example/20mb.bin', storageMode: 'r2' }),
    env,
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data[0].size, 20 * MB);
  assert.equal(maxConcurrentParts, 2);
  assert.deepEqual(completedOrder, [1, 2, 3]);
});

test('Telegram virtual chunked URL mirroring streams >20MB in 18MB chunks, writes compact KV + full manifest, and rolls back on failure', async (t) => {
  const migrated = makeMigratedEnv();
  t.after(() => migrated._db.close());
  const kv = makeKv();
  const background = [];
  const uploadedChunkSizes = [];
  let noticeSent = false;

  // 1. Successful 22MB stream (18MB + 4MB = 2 Telegram chunks)
  let remaining1 = 22;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const target = String(url);
    if (target.startsWith('https://origin.example/')) {
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (remaining1-- > 0) controller.enqueue(new Uint8Array(MB));
            else controller.close();
          },
        }),
        { headers: { 'Content-Length': String(22 * MB), 'Content-Type': 'video/mp4' } }
      );
    }
    if (target.includes('/sendDocument')) {
      const doc = init.body.get('document');
      uploadedChunkSizes.push(doc.size);
      const idx = uploadedChunkSizes.length;
      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 500 + idx,
          document: { file_id: `TG_CHUNK_FILE_${idx}` },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (target.includes('/sendMessage')) {
      noticeSent = true;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 999 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  });

  const env = {
    ...migrated,
    BASIC_USER: 'test',
    BASIC_PASS: 'test',
    img_url: kv,
    TG_BOT_TOKEN: '123456:token',
    TG_CHAT_ID: '-10012345',
    TG_UPLOAD_NOTICE: 'true',
  };

  const res = await mirror({
    request: postMirror({ url: 'https://origin.example/movie.mp4', storageMode: 'telegram' }),
    env,
    waitUntil(job) {
      background.push(job);
    },
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data[0].size, 22 * MB);
  assert.equal(data[0].telegramChunked, true);
  assert.equal(data[0].totalChunks, 2);
  assert.deepEqual(uploadedChunkSizes, [18 * MB, 4 * MB]);

  const kvKey = data[0].src.replace(/^\/file\//, '');
  const stored = kv.entries.get(kvKey);
  assert.ok(stored, 'chunked record written to KV');
  assert.equal(stored.metadata.telegramChunked, true);
  assert.equal(stored.metadata.telegramChunks, undefined, 'telegramChunks omitted from compact KV metadata');
  assert.ok(new TextEncoder().encode(JSON.stringify(stored.metadata)).byteLength < 1024);
  const fullValue = JSON.parse(stored.value);
  assert.equal(fullValue.telegramChunks.length, 2);
  assert.equal(fullValue.telegramChunks[0].fileId, 'TG_CHUNK_FILE_1');
  assert.equal(fullValue.telegramChunks[1].size, 4 * MB);

  await Promise.all(background);
  assert.equal(noticeSent, true);

  // 2. Rollback test: chunk 2 fails with 400 -> chunk 1 message (id 701) is deleted via Telegram API
  let remaining2 = 22;
  let chunkCall = 0;
  const deletedMessageIds = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const target = String(url);
    if (target.startsWith('https://origin.example/')) {
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (remaining2-- > 0) controller.enqueue(new Uint8Array(MB));
            else controller.close();
          },
        }),
        { headers: { 'Content-Length': String(22 * MB), 'Content-Type': 'application/octet-stream' } }
      );
    }
    if (target.includes('/sendDocument')) {
      chunkCall += 1;
      if (chunkCall === 1) {
        return new Response(JSON.stringify({
          ok: true,
          result: { message_id: 701, document: { file_id: 'TG_ORPHAN_1' } },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: false, description: 'Bad Request: file error' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (target.includes('/deleteMessage')) {
      const payload = JSON.parse(init.body);
      if (Array.isArray(payload.message_ids)) deletedMessageIds.push(...payload.message_ids);
      else if (payload.message_id) deletedMessageIds.push(payload.message_id);
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected rollback fetch: ${target}`);
  });

  const failRes = await mirror({
    request: postMirror({ url: 'https://origin.example/fail.bin', storageMode: 'telegram' }),
    env,
  });
  assert.equal(failRes.status, 500);
  assert.deepEqual(deletedMessageIds, [701]);
});

test('URL probe advertises 2GB Telegram and 10GB R2 Range-chunked mode when Accept-Ranges: bytes is supported', async (t) => {
  const kv = makeKv();
  const env = {
    BASIC_USER: 'test',
    BASIC_PASS: 'test',
    img_url: kv,
    TG_BOT_TOKEN: '123456:token',
    TG_CHAT_ID: '-10012345',
    R2_BUCKET: { put: async () => {} },
  };

  // 1. 1.5GB file with Accept-Ranges: bytes -> eligible for 2GB Telegram Range-chunked (86 x 18MB)
  const size15G = Math.floor(1.5 * GB);
  t.mock.method(globalThis, 'fetch', async () => new Response(null, {
    status: 200,
    headers: {
      'Content-Length': String(size15G),
      'Accept-Ranges': 'bytes',
      ETag: '"etag-15g"',
      'Content-Type': 'video/x-matroska',
    },
  }));

  const tgRes = await mirror({
    request: postMirror({
      action: 'probe',
      url: 'https://cdn.example/movie-4k.mkv',
      storageMode: 'telegram',
    }),
    env,
  });
  assert.equal(tgRes.status, 200);
  const tgProbe = await tgRes.json();
  assert.equal(tgProbe.ok, true);
  assert.equal(tgProbe.exceedsLimit, false);
  assert.equal(tgProbe.rangeChunked, true);
  assert.equal(tgProbe.telegramChunked, true);
  assert.equal(tgProbe.chunkSize, 18 * MB);
  assert.equal(tgProbe.totalChunks, Math.ceil(size15G / (18 * MB)));
  assert.equal(tgProbe.validator, '"etag-15g"');
  assert.equal(tgProbe.maxBytes, 2 * GB);

  // 2. 2.5GB file -> exceeds 2GB Telegram limit, but succeeds for R2 Range-chunked (52 x 50MB)
  const size25G = Math.floor(2.5 * GB);
  t.mock.method(globalThis, 'fetch', async () => new Response(null, {
    status: 200,
    headers: {
      'Content-Length': String(size25G),
      'Accept-Ranges': 'bytes',
      'Content-Type': 'application/octet-stream',
    },
  }));

  const tgOver = await (await mirror({
    request: postMirror({ action: 'probe', url: 'https://cdn.example/huge.iso', storageMode: 'telegram' }),
    env,
  })).json();
  assert.equal(tgOver.exceedsLimit, true);

  const r2Ok = await (await mirror({
    request: postMirror({ action: 'probe', url: 'https://cdn.example/huge.iso', storageMode: 'r2' }),
    env,
  })).json();
  assert.equal(r2Ok.exceedsLimit, false);
  assert.equal(r2Ok.rangeChunked, true);
  assert.equal(r2Ok.chunkSize, 50 * MB);
  assert.equal(r2Ok.totalChunks, Math.ceil(size25G / (50 * MB)));
});

test('Telegram Range-chunked multi-request URL transfer E2E: init -> url-chunk -> idempotent reuse -> shared 429 cooldown -> complete', async (t) => {
  const migrated = makeMigratedEnv();
  t.after(() => migrated._db.close());
  const kv = makeKv();
  const env = {
    ...migrated,
    BASIC_USER: 'test',
    BASIC_PASS: 'test',
    img_url: kv,
    TG_BOT_TOKEN: '123456:token',
    TG_CHAT_ID: '-100777888',
  };
  await clearTelegramCooldown(env);
  t.after(async () => { await clearTelegramCooldown(env); });

  const fileSize = 5 * MB;
  const chunkSize = 2 * MB; // 2MB + 2MB + 1MB = 3 chunks
  const totalChunks = 3;
  const source = { url: 'https://origin.example/archive.tar', validator: '"v-tar"' };

  const postJson = (path, payload) => new Request(`https://example.test/api/chunked-upload/${path}`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  // 1. Initialize Telegram chunked upload task
  const initRes = await initChunks({
    request: postJson('init', {
      fileName: 'archive.tar',
      fileSize,
      fileType: 'application/x-tar',
      totalChunks,
      chunkSize,
      storageMode: 'telegram',
      fileId: '11223344556677889900aabbccddeeff',
      rangeSource: source,
    }),
    env,
  });
  assert.equal(initRes.status, 200);
  const initData = await initRes.json();
  assert.equal(initData.telegramChunked, true);
  const uploadId = initData.uploadId;

  let remoteFetchCount = 0;
  let tgSendCount = 0;
  let failNextTgWith429 = false;
  let originValidator = source.validator;
  const seenRanges = [];

  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const target = String(url);
    if (target.startsWith('https://origin.example/')) {
      remoteFetchCount += 1;
      const range = init.headers?.Range || '';
      seenRanges.push(range);
      const m = range.match(/^bytes=(\d+)-(\d+)$/);
      assert.ok(m, `expected Range header, got ${range}`);
      const start = Number(m[1]);
      const end = Number(m[2]);
      const len = end - start + 1;
      assert.equal(init.headers?.['If-Range'], '"v-tar"');
      return new Response(new Uint8Array(len).fill(start & 0xff), {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Content-Length': String(len),
          ETag: originValidator,
        },
      });
    }
    if (target.includes('/sendDocument')) {
      tgSendCount += 1;
      if (failNextTgWith429) {
        failNextTgWith429 = false;
        return new Response(JSON.stringify({ ok: false, parameters: { retry_after: 9 } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 800 + tgSendCount,
          document: { file_id: `TG_RANGE_FILE_${tgSendCount}` },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected fetch: ${target}`);
  });

  // 2. Transfer chunk 0
  const c0Res = await urlChunk({
    request: postJson('url-chunk', {
      uploadId,
      chunkIndex: 0,
      url: 'https://origin.example/archive.tar',
      validator: '"v-tar"',
    }),
    env,
  });
  assert.equal(c0Res.status, 200);
  const c0 = await c0Res.json();
  assert.equal(c0.reused, false);
  assert.equal(c0.size, 2 * MB);
  assert.equal(remoteFetchCount, 1);
  assert.equal(tgSendCount, 1);

  // 3. Re-requesting chunk 0 is idempotently reused with 0 remote fetches and 0 Telegram calls
  const c0Again = await (await urlChunk({
    request: postJson('url-chunk', {
      uploadId,
      chunkIndex: 0,
      url: 'https://origin.example/archive.tar',
      validator: '"v-tar"',
    }),
    env,
  })).json();
  assert.equal(c0Again.reused, true);
  assert.equal(c0Again.etag, c0.etag);
  assert.equal(remoteFetchCount, 1);
  assert.equal(tgSendCount, 1);

  // A changed request binding cannot reuse an existing part.
  const rebound = await urlChunk({
    request: postJson('url-chunk', { uploadId, chunkIndex: 0, ...source, validator: '"different"' }),
    env,
  });
  assert.equal((await rebound.json()).code, 'SOURCE_CHANGED');
  assert.equal(remoteFetchCount, 1);

  // Even an origin returning 206 is rejected if its validator has changed.
  originValidator = '"different"';
  const changed = await urlChunk({
    request: postJson('url-chunk', { uploadId, chunkIndex: 1, ...source }),
    env,
  });
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).code, 'SOURCE_CHANGED');
  assert.equal(tgSendCount, 1);
  originValidator = source.validator;

  // 4. Chunk 1 hits Telegram 429 -> records shared cooldown -> Chunk 2 short-circuits BEFORE fetching origin!
  failNextTgWith429 = true;
  const c1RateLimited = await urlChunk({
    request: postJson('url-chunk', {
      uploadId,
      chunkIndex: 1,
      url: 'https://origin.example/archive.tar',
      validator: '"v-tar"',
    }),
    env,
  });
  assert.equal(c1RateLimited.status, 429);
  assert.equal(remoteFetchCount, 3);

  const c2ShortCircuit = await urlChunk({
    request: postJson('url-chunk', {
      uploadId,
      chunkIndex: 2,
      url: 'https://origin.example/archive.tar',
      validator: '"v-tar"',
    }),
    env,
  });
  assert.equal(c2ShortCircuit.status, 429);
  const c2Body = await c2ShortCircuit.json();
  assert.equal(c2Body.cooldownSource, 'shared');
  assert.equal(remoteFetchCount, 3, 'shared 429 cooldown must short-circuit BEFORE remote origin fetch');

  // 5. Clear cooldown and finish chunks 1 & 2, then complete zero-copy manifest
  await clearTelegramCooldown(env);
  const c1 = await (await urlChunk({
    request: postJson('url-chunk', { uploadId, chunkIndex: 1, url: 'https://origin.example/archive.tar', validator: '"v-tar"' }),
    env,
  })).json();
  const c2 = await (await urlChunk({
    request: postJson('url-chunk', { uploadId, chunkIndex: 2, url: 'https://origin.example/archive.tar', validator: '"v-tar"' }),
    env,
  })).json();
  assert.equal(c1.success, true);
  assert.equal(c2.success, true);
  assert.equal(c2.size, 1 * MB);

  const completeRes = await completeChunks({
    request: postJson('complete', {
      uploadId,
      parts: [
        { partNumber: c0.partNumber, etag: c0.etag, size: c0.size },
        { partNumber: c1.partNumber, etag: c1.etag, size: c1.size },
        { partNumber: c2.partNumber, etag: c2.etag, size: c2.size },
      ],
    }),
    env,
  });
  assert.equal(completeRes.status, 200);
  const completed = await completeRes.json();
  assert.match(completed.src, /^\/file\/telegram:tg_/);
  assert.equal(completed.fileSize, fileSize);
  assert.equal(seenRanges[0], `bytes=0-${2 * MB - 1}`);
  assert.equal(seenRanges.at(-1), `bytes=${4 * MB}-${5 * MB - 1}`);
});

test('R2 Range-chunked url-chunk streams parts and rejects ignored Range (200) or changed source (Content-Range mismatch)', async (t) => {
  const kv = makeKv();
  const uploadedParts = [];
  let completedParts = null;

  const env = {
    BASIC_USER: 'test',
    BASIC_PASS: 'test',
    img_url: kv,
    R2_BUCKET: {
      async createMultipartUpload(key) {
        return { uploadId: 'r2-mp-url-1', key };
      },
      resumeMultipartUpload() {
        return {
          async uploadPart(partNumber, data) {
            const len = data?.byteLength ?? 0;
            uploadedParts.push({ partNumber, len });
            return { partNumber, etag: `r2-etag-${partNumber}` };
          },
          async complete(parts) {
            completedParts = parts;
          },
          async abort() {},
        };
      },
      async head() {
        return { size: 7 * MB };
      },
    },
  };

  const postJson = (path, payload) => new Request(`https://example.test/api/chunked-upload/${path}`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const fileSize = 7 * MB;
  const chunkSize = 5 * MB; // 5MB + 2MB
  const initData = await (await initChunks({
    request: postJson('init', {
      fileName: 'backup.bin',
      fileSize,
      fileType: 'application/octet-stream',
      totalChunks: 2,
      chunkSize,
      storageMode: 'r2',
    }),
    env,
  })).json();
  const uploadId = initData.uploadId;

  // 1. Origin ignores Range and returns 200 -> 422 RANGE_NOT_SUPPORTED
  t.mock.method(globalThis, 'fetch', async () => new Response('full-body', { status: 200 }));
  const ignoredRes = await urlChunk({
    request: postJson('url-chunk', { uploadId, chunkIndex: 0, url: 'https://origin.example/backup.bin' }),
    env,
  });
  assert.equal(ignoredRes.status, 422);
  assert.equal((await ignoredRes.json()).code, 'RANGE_NOT_SUPPORTED');

  // 2. Origin returns mismatched Content-Range total -> 409 SOURCE_CHANGED
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(5 * MB), {
    status: 206,
    headers: { 'Content-Range': `bytes 0-${5 * MB - 1}/${9 * MB}` },
  }));
  const changedRes = await urlChunk({
    request: postJson('url-chunk', { uploadId, chunkIndex: 0, url: 'https://origin.example/backup.bin' }),
    env,
  });
  assert.equal(changedRes.status, 409);
  assert.equal((await changedRes.json()).code, 'SOURCE_CHANGED');

  // 3. Valid 206 responses complete both R2 parts and finalize multipart
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const [, s, e] = init.headers.Range.match(/^bytes=(\d+)-(\d+)$/);
    const start = Number(s);
    const end = Number(e);
    return new Response(new Uint8Array(end - start + 1), {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/${fileSize}` },
    });
  });

  const p0 = await (await urlChunk({
    request: postJson('url-chunk', { uploadId, chunkIndex: 0, url: 'https://origin.example/backup.bin' }),
    env,
  })).json();
  const p1 = await (await urlChunk({
    request: postJson('url-chunk', { uploadId, chunkIndex: 1, url: 'https://origin.example/backup.bin' }),
    env,
  })).json();
  assert.equal(p0.success, true);
  assert.equal(p1.success, true);

  const compRes = await completeChunks({
    request: postJson('complete', {
      uploadId,
      parts: [
        { partNumber: p0.partNumber, etag: p0.etag },
        { partNumber: p1.partNumber, etag: p1.etag },
      ],
    }),
    env,
  });
  assert.equal(compRes.status, 200);
  assert.deepEqual(uploadedParts, [
    { partNumber: 1, len: 5 * MB },
    { partNumber: 2, len: 2 * MB },
  ]);
  assert.equal(completedParts.length, 2);
});

