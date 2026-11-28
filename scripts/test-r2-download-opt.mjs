import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRequest as fileDownload, entityTagFor, matchesIfRange } from '../functions/file/[[path]].js';
import { onRequest as thumbDownload } from '../functions/thumb/[[path]].js';
import { onRequestGet as airdropDownload } from '../functions/api/airdrop/download.js';
import { scheduleWarm } from '../functions/utils/byte-cache.js';
import { withDownloadLength } from '../functions/utils/download-length.js';
import { clearRecordCacheMemory } from '../functions/utils/record-cache.js';
import { makeMigratedEnv } from './test-utils.mjs';

function makeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  const stats = { get: 0, put: 0, delete: 0, putKeys: [] };
  return {
    store,
    stats,
    async get(key, opts) {
      stats.get++;
      const entry = store.get(key);
      if (!entry) return null;
      const val = entry.value;
      return opts?.type === 'json' && typeof val === 'string' ? JSON.parse(val) : val;
    },
    async getWithMetadata(key) {
      stats.get++;
      return store.get(key) || { value: null, metadata: null };
    },
    async put(key, value, opts) {
      stats.put++;
      stats.putKeys.push(key);
      store.set(key, { value, metadata: opts?.metadata });
    },
    async delete(key) {
      stats.delete++;
      store.delete(key);
    },
  };
}

function makeR2(bytes, overrides = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(String(bytes));
  const calls = { head: 0, get: 0, ranges: [] };
  const bucket = {
    calls,
    async head(key) {
      calls.head++;
      if (overrides.head) return overrides.head(key, calls);
      return { key, size: data.byteLength, uploaded: new Date('2026-01-01T00:00:00Z'), httpEtag: '"r2-etag"' };
    },
    async get(key, opts) {
      calls.get++;
      calls.ranges.push(opts?.range || null);
      if (overrides.get) return overrides.get(key, opts, calls);
      let slice = data;
      let rangeInfo;
      if (opts?.range) {
        if (typeof opts.range.suffix === 'number') {
          const start = Math.max(0, data.byteLength - opts.range.suffix);
          slice = data.subarray(start);
          rangeInfo = { offset: start, length: slice.byteLength };
        } else {
          const offset = Number(opts.range.offset || 0);
          const length = opts.range.length != null ? Number(opts.range.length) : data.byteLength - offset;
          slice = data.subarray(offset, offset + length);
          rangeInfo = { offset, length: slice.byteLength };
        }
      }
      return {
        key,
        size: data.byteLength,
        uploaded: new Date('2026-01-01T00:00:00Z'),
        httpEtag: '"r2-etag"',
        range: rangeInfo,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(slice);
            controller.close();
          },
        }),
      };
    },
  };
  return bucket;
}

test('Single-RTT R2 Range (bounded, open-ended, suffix), 416, and ranged HEAD', async () => {
  clearRecordCacheMemory();
  const payload = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const r2 = makeR2(payload);
  const metadata = {
    fileName: 'sample.txt',
    fileSize: payload.length,
    storageType: 'r2',
    r2Key: 'sample.txt',
    updatedAt: Date.parse('2026-01-01T00:00:00Z'),
  };
  const kv = makeKv({ 'r2:sample.txt': { value: '', metadata } });
  const env = { img_url: kv, R2_BUCKET: r2 };

  // 1. Bounded Range -> 0 head calls, 1 get call!
  const res1 = await fileDownload({
    params: { path: 'r2:sample.txt' },
    request: new Request('https://example.test/file/r2:sample.txt', {
      headers: { Range: 'bytes=10-19' },
    }),
    env,
    waitUntil() {},
  });
  assert.equal(res1.status, 206);
  assert.equal(r2.calls.head, 0);
  assert.equal(r2.calls.get, 1);
  assert.equal(res1.headers.get('Content-Range'), `bytes 10-19/${payload.length}`);
  assert.equal(res1.headers.get('Content-Length'), '10');
  assert.ok(res1.headers.get('ETag'), '206 must include ETag (RFC 9110)');
  assert.ok(res1.headers.get('Last-Modified'), '206 must include Last-Modified');
  assert.equal(await res1.text(), payload.slice(10, 20));

  // 2. Open-ended Range -> still 0 head calls!
  const res2 = await fileDownload({
    params: { path: 'r2:sample.txt' },
    request: new Request('https://example.test/file/r2:sample.txt', {
      headers: { Range: 'bytes=52-' },
    }),
    env,
    waitUntil() {},
  });
  assert.equal(res2.status, 206);
  assert.equal(r2.calls.head, 0);
  assert.equal(res2.headers.get('Content-Range'), `bytes 52-61/${payload.length}`);
  assert.equal(await res2.text(), payload.slice(52));

  // 3. Suffix Range -> still 0 head calls!
  const res3 = await fileDownload({
    params: { path: 'r2:sample.txt' },
    request: new Request('https://example.test/file/r2:sample.txt', {
      headers: { Range: 'bytes=-6' },
    }),
    env,
    waitUntil() {},
  });
  assert.equal(res3.status, 206);
  assert.equal(r2.calls.head, 0);
  assert.equal(res3.headers.get('Content-Range'), `bytes 56-61/${payload.length}`);
  assert.equal(await res3.text(), payload.slice(-6));

  // 4. Out-of-bounds Range -> 416 with exact bytes */<size>
  const res4 = await fileDownload({
    params: { path: 'r2:sample.txt' },
    request: new Request('https://example.test/file/r2:sample.txt', {
      headers: { Range: 'bytes=999-1000' },
    }),
    env,
    waitUntil() {},
  });
  assert.equal(res4.status, 416);
  assert.equal(res4.headers.get('Content-Range'), `bytes */${payload.length}`);

  // 5. HEAD with Range header must only call head(), NEVER get()!
  const getsBeforeHead = r2.calls.get;
  const headsBeforeHead = r2.calls.head;
  const resHead = await fileDownload({
    params: { path: 'r2:sample.txt' },
    request: new Request('https://example.test/file/r2:sample.txt', {
      method: 'HEAD',
      headers: { Range: 'bytes=0-10' },
    }),
    env,
    waitUntil() {},
  });
  assert.equal(resHead.status, 200);
  assert.equal(r2.calls.get, getsBeforeHead);
  assert.equal(r2.calls.head, headsBeforeHead + 1);
  assert.equal(resHead.headers.get('Content-Length'), String(payload.length));
});

test('RFC 9110 If-Range, If-Modified-Since, CORS headers, and record-cache background waitUntil forwarding', async () => {
  clearRecordCacheMemory();
  const payload = 'hello-conditional-world';
  const r2 = makeR2(payload);
  const ts = Date.parse('2026-06-15T12:00:00Z');
  const metadata = {
    fileName: 'cond.txt',
    fileSize: payload.length,
    storageType: 'r2',
    r2Key: 'cond.txt',
    updatedAt: ts,
  };
  const kv = makeKv({ 'r2:cond.txt': { value: '', metadata } });
  const env = { img_url: kv, R2_BUCKET: r2 };
  const expectedEtag = await entityTagFor(metadata, 'r2:cond.txt');

  // Unit check matchesIfRange
  assert.equal(matchesIfRange('', expectedEtag, ts), true);
  assert.equal(matchesIfRange(expectedEtag, expectedEtag, ts), true);
  assert.equal(matchesIfRange('"different"', expectedEtag, ts), false);
  assert.equal(matchesIfRange(`W/${expectedEtag}`, expectedEtag, ts), false);
  assert.equal(matchesIfRange(new Date(ts).toUTCString(), expectedEtag, ts), true);
  assert.equal(matchesIfRange(new Date(ts - 10000).toUTCString(), expectedEtag, ts), false);

  // 1. Range + matching If-Range -> 206 + registers reccache write in waitUntil!
  const jobs = [];
  const resMatch = await fileDownload({
    params: { path: 'r2:cond.txt' },
    request: new Request('https://example.test/file/r2:cond.txt', {
      headers: { Range: 'bytes=0-4', 'If-Range': expectedEtag },
    }),
    env,
    waitUntil: (p) => jobs.push(p),
  });
  await Promise.allSettled(jobs);
  assert.equal(resMatch.status, 206);
  assert.equal(await resMatch.text(), 'hello');
  assert.ok(kv.stats.putKeys.includes('reccache:r2:cond.txt'), 'options.background must be forwarded so reccache:* persists via waitUntil');
  assert.match(resMatch.headers.get('Access-Control-Expose-Headers') || '', /ETag/);
  assert.match(resMatch.headers.get('Access-Control-Allow-Headers') || '', /If-Range/);

  // 2. Range + mismatched If-Range -> 200 OK full body!
  const resMismatch = await fileDownload({
    params: { path: 'r2:cond.txt' },
    request: new Request('https://example.test/file/r2:cond.txt', {
      headers: { Range: 'bytes=0-4', 'If-Range': '"stale-etag"' },
    }),
    env,
    waitUntil() {},
  });
  assert.equal(resMismatch.status, 200);
  assert.equal(await resMismatch.text(), payload);

  // 3. If-Modified-Since -> 304 Not Modified without hitting R2!
  const r2GetsBefore = r2.calls.get;
  const res304 = await fileDownload({
    params: { path: 'r2:cond.txt' },
    request: new Request('https://example.test/file/r2:cond.txt', {
      headers: { 'If-Modified-Since': new Date(ts).toUTCString() },
    }),
    env,
    waitUntil() {},
  });
  assert.equal(res304.status, 304);
  assert.equal(r2.calls.get, r2GetsBefore);
});

test('R2 transient read errors retry automatically and return 503 Retry-After when exhausted', async () => {
  clearRecordCacheMemory();
  const payload = 'recovered-bytes';
  const metadata = { fileName: 'flaky.txt', fileSize: payload.length, storageType: 'r2', r2Key: 'flaky.txt' };
  const kv = makeKv({ 'r2:flaky.txt': { value: '', metadata } });

  // 1. Fails once with transient error, succeeds on 2nd attempt
  const r2Recover = makeR2(payload, {
    get(_key, _opts, calls) {
      if (calls.get === 1) throw new Error('503 temporary R2 hiccup');
      return {
        size: payload.length,
        body: new ReadableStream({
          start(c) { c.enqueue(new TextEncoder().encode(payload)); c.close(); },
        }),
      };
    },
  });
  const resOk = await fileDownload({
    params: { path: 'r2:flaky.txt' },
    request: new Request('https://example.test/file/r2:flaky.txt'),
    env: { img_url: kv, R2_BUCKET: r2Recover },
    waitUntil() {},
  });
  assert.equal(resOk.status, 200);
  assert.equal(r2Recover.calls.get, 2);
  assert.equal(await resOk.text(), payload);

  // 2. Always fails transiently -> 503 with Retry-After: 1
  const r2Down = makeR2(payload, {
    get() { throw new Error('503 R2 overloaded'); },
  });
  const res503 = await fileDownload({
    params: { path: 'r2:flaky.txt' },
    request: new Request('https://example.test/file/r2:flaky.txt'),
    env: { img_url: kv, R2_BUCKET: r2Down },
    waitUntil() {},
  });
  assert.equal(res503.status, 503);
  assert.equal(res503.headers.get('Retry-After'), '1');
  assert.equal(r2Down.calls.get, 3);
});

test('Edge Byte Cache: HEAD HIT, native 206 Range HIT, single-flight coalescing, and O(1) scheduleWarm drain', async (t) => {
  clearRecordCacheMemory();
  const originalCaches = globalThis.caches;
  t.after(() => {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  });

  // 1. HEAD & Range native 206 HIT
  const r2Unused = makeR2('never-touched');
  const kv = makeKv({
    'r2:cached.bin': { value: '', metadata: { fileName: 'cached.bin', fileSize: 10, storageType: 'r2', r2Key: 'cached.bin' } },
  });
  globalThis.caches = {
    default: {
      async match(req) {
        if (req.headers.get('Range')) {
          return new Response('0123', {
            status: 206,
            headers: {
              ETag: '"c1"',
              'Content-Range': 'bytes 0-3/10',
              'Content-Length': '4',
              'Content-Type': 'application/octet-stream',
            },
          });
        }
        return new Response('0123456789', {
          status: 200,
          headers: { ETag: '"c1"', 'Content-Length': '10', 'Content-Type': 'application/octet-stream' },
        });
      },
      async put() {},
      async delete() { return true; },
    },
  };

  const headHit = await fileDownload({
    params: { path: 'r2:cached.bin' },
    request: new Request('https://example.test/file/r2:cached.bin', { method: 'HEAD' }),
    env: { img_url: kv, R2_BUCKET: r2Unused },
    waitUntil() {},
  });
  assert.equal(headHit.status, 200);
  assert.equal(headHit.headers.get('X-KVault-Byte-Cache'), 'HIT');
  assert.equal(r2Unused.calls.head, 0);
  assert.equal(r2Unused.calls.get, 0);

  const rangeHit = await fileDownload({
    params: { path: 'r2:cached.bin' },
    request: new Request('https://example.test/file/r2:cached.bin', { headers: { Range: 'bytes=0-3', 'If-Range': '"c1"' } }),
    env: { img_url: kv, R2_BUCKET: r2Unused },
    waitUntil() {},
  });
  assert.equal(rangeHit.status, 206);
  assert.equal(rangeHit.headers.get('X-KVault-Byte-Cache'), 'HIT');
  assert.equal(await rangeHit.text(), '0123');
  assert.equal(r2Unused.calls.get, 0);

  // 2. Single-flight coalescing on concurrent cache misses -> only 1 cache.put!
  let cachePutCount = 0;
  globalThis.caches = {
    default: {
      async match() { return undefined; },
      async put() { cachePutCount++; },
      async delete() { return true; },
    },
  };
  const r2Slow = makeR2('concurrent-payload');
  const kvMiss = makeKv({
    'r2:miss.bin': { value: '', metadata: { fileName: 'miss.bin', fileSize: 18, storageType: 'r2', r2Key: 'miss.bin' } },
  });
  const jobs = [];
  const [rA, rB] = await Promise.all([
    fileDownload({
      params: { path: 'r2:miss.bin' },
      request: new Request('https://example.test/file/r2:miss.bin'),
      env: { img_url: kvMiss, R2_BUCKET: r2Slow },
      waitUntil: (p) => jobs.push(p),
    }),
    fileDownload({
      params: { path: 'r2:miss.bin' },
      request: new Request('https://example.test/file/r2:miss.bin'),
      env: { img_url: kvMiss, R2_BUCKET: r2Slow },
      waitUntil: (p) => jobs.push(p),
    }),
  ]);
  const [tA, tB] = await Promise.all([rA.text(), rB.text()]);
  await Promise.allSettled(jobs);
  assert.equal(tA, 'concurrent-payload');
  assert.equal(tB, 'concurrent-payload');
  assert.equal(cachePutCount, 1);

  // 3. scheduleWarm drains stream without calling response.arrayBuffer()
  let arrayBufferCalled = false;
  let streamDrained = false;
  t.mock.method(globalThis, 'fetch', async () => {
    const resp = new Response(new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]));
        c.close();
        streamDrained = true;
      },
    }));
    resp.arrayBuffer = async () => {
      arrayBufferCalled = true;
      return new ArrayBuffer(3);
    };
    return resp;
  });
  const warmJobs = [];
  await scheduleWarm({}, { waitUntil: (p) => warmJobs.push(p) }, 'https://example.test', 'r2:w.bin', { size: 3 });
  await Promise.allSettled(warmJobs);
  assert.equal(streamDrained, true);
  assert.equal(arrayBufferCalled, false);
});

test('download-length deduplicates no-transform directive', () => {
  const res = withDownloadLength(new Response('abc', {
    status: 200,
    headers: { 'Content-Length': '3', 'Cache-Control': 'public, max-age=3600, no-transform' },
  }));
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=3600, no-transform');
});

test('thumb endpoint: returns ETag, serves 304 on If-None-Match, and retries transient R2 reads', async () => {
  clearRecordCacheMemory();
  let r2Attempts = 0;
  const thumbBytes = new Uint8Array([10, 20, 30, 40]);
  const kv = makeKv({
    'r2:pic.jpg': { value: '', metadata: { fileName: 'pic.jpg', storageType: 'r2', TimeStamp: 1700000000000 } },
    'config:thumb': { value: JSON.stringify({ enabled: true, backend: 'r2' }) },
  });
  const env = {
    img_url: kv,
    R2_BUCKET: {
      async put() {},
      async delete() {},
      async get() {
        r2Attempts++;
        if (r2Attempts === 1) throw new Error('503 R2 thumb retry');
        return {
          size: thumbBytes.byteLength,
          httpEtag: '"thumb-r2-1"',
          httpMetadata: { contentType: 'image/webp' },
          body: thumbBytes,
        };
      },
    },
  };

  const res1 = await thumbDownload({
    params: { path: 'r2:pic.jpg' },
    request: new Request('https://example.test/thumb/r2:pic.jpg'),
    env,
    waitUntil() {},
  });
  assert.equal(res1.status, 200);
  assert.equal(r2Attempts, 2);
  const etag = res1.headers.get('ETag');
  assert.equal(etag, '"thumb-r2-1"');

  const res304 = await thumbDownload({
    params: { path: 'r2:pic.jpg' },
    request: new Request('https://example.test/thumb/r2:pic.jpg', {
      headers: { 'If-None-Match': etag },
    }),
    env,
    waitUntil() {},
  });
  assert.equal(res304.status, 304);
  assert.equal(res304.headers.get('ETag'), etag);
});

test('airdrop download: R2 Range 206/416, transient retry, and 503 Retry-After', async (t) => {
  const migrated = makeMigratedEnv();
  t.after(() => migrated._db.close());
  const payload = 'ABCDEFGHIJKLMNOP';
  const code = '987654';
  const recvToken = 'recv-tok-1';
  const now = Date.now();

  migrated._db.prepare(
    `INSERT INTO airdrop_sessions
     (code, status, sender_token, receiver_token, files_json, file_count, total_size, created_at, expires_at)
     VALUES (?, 'uploaded', 'send-tok-1', ?, ?, 1, ?, ?, ?)`
  ).run(
    code,
    recvToken,
    JSON.stringify([{ name: 'doc.bin', size: payload.length, type: 'application/octet-stream', backend: 'r2', key: 'ad/doc.bin', status: 'uploaded' }]),
    payload.length,
    now,
    now + 300000
  );

  // 1. Range 206 with transient retry on attempt 1
  let getCalls = 0;
  const r2 = makeR2(payload, {
    get(key, opts) {
      getCalls++;
      if (getCalls === 1) throw new Error('503 temporary airdrop R2 glitch');
      const start = opts?.range?.offset || 0;
      const len = opts?.range?.length ?? (payload.length - start);
      const slice = new TextEncoder().encode(payload.slice(start, start + len));
      return {
        key,
        size: payload.length,
        body: new ReadableStream({ start(c) { c.enqueue(slice); c.close(); } }),
      };
    },
  });
  const env = { ...migrated, img_url: makeKv(), R2_BUCKET: r2 };

  const res206 = await airdropDownload({
    request: new Request(`https://example.test/api/airdrop/download?code=${code}&token=${recvToken}&idx=0`, {
      headers: { Range: 'bytes=4-9' },
    }),
    env,
  });
  assert.equal(res206.status, 206);
  assert.equal(getCalls, 2);
  assert.equal(res206.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(res206.headers.get('Content-Range'), `bytes 4-9/${payload.length}`);
  assert.equal(res206.headers.get('Content-Length'), '6');
  assert.equal(await res206.text(), 'EFGHIJ');

  // 2. Out-of-bounds Range -> 416
  const res416 = await airdropDownload({
    request: new Request(`https://example.test/api/airdrop/download?code=${code}&token=${recvToken}&idx=0`, {
      headers: { Range: 'bytes=999-' },
    }),
    env,
  });
  assert.equal(res416.status, 416);
  assert.equal(res416.headers.get('Content-Range'), `bytes */${payload.length}`);

  // 3. Persistent transient R2 failure -> 503 + Retry-After: 1
  const r2Down = makeR2(payload, {
    get() { throw new Error('503 R2 unavailable'); },
  });
  const res503 = await airdropDownload({
    request: new Request(`https://example.test/api/airdrop/download?code=${code}&token=${recvToken}&idx=0`),
    env: { ...migrated, img_url: makeKv(), R2_BUCKET: r2Down },
  });
  assert.equal(res503.status, 503);
  assert.equal(res503.headers.get('Retry-After'), '1');
});
