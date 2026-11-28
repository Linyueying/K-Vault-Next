import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRequestPost as upload } from '../functions/api/v1/upload.js';
import { onRequestPost as mirror } from '../functions/api/upload-from-url.js';
import { onRequestPost as initChunks } from '../functions/api/chunked-upload/init.js';
import { onRequestPost as uploadChunk } from '../functions/api/chunked-upload/chunk.js';
import { onRequestPost as completeChunks } from '../functions/api/chunked-upload/complete.js';
import { checkUploadPolicy } from '../functions/utils/policy-enforce.js';
import { makeMigratedEnv } from './test-utils.mjs';

const MB = 1024 * 1024;

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
      entries.set(key, { value, metadata: options?.metadata, expiration: options?.expiration, expirationTtl: options?.expirationTtl });
    },
    async delete(key) { entries.delete(key); },
    async list({ prefix }) {
      return { keys: [...entries.keys()].filter(key => key.startsWith(prefix)).map(name => ({ name })) };
    },
  };
}

function uploadRequest(fields, query = '') {
  const body = new FormData();
  body.set('file', new File(['test data'], 'file.txt', { type: 'text/plain' }));
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return new Request(`https://example.test/api/v1/upload${query}`, { method: 'POST', body });
}

function mirrorRequest(storageMode, accept = 'application/json') {
  return new Request('https://example.test/api/upload-from-url', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa('test:test'), Accept: accept },
    body: JSON.stringify({ url: 'https://origin.example/file.bin', storageMode }),
  });
}

test('folder aliases persist the same canonical directory used by the policy', async () => {
  const env = { img_url: makeKv(), R2_BUCKET: { async put() {} } };
  const apiToken = { id: 'folder', policies: { folderPrefix: 'docs' } };

  assert.equal(checkUploadPolicy(apiToken, { folderPath: 'other' }).ok, false);
  for (const [fields, query, expected] of [
    [{ folder: ' /docs//reports/ ' }, '', 'docs/reports'],
    [{}, '?folder=docs%2Fnotes', 'docs/notes'],
  ]) {
    const request = uploadRequest({ storage: 'r2', ...fields }, query);
    const response = await upload({ request, env, data: { apiToken } });
    assert.equal(response.status, 200);
    const { file } = await response.json();
    assert.equal((await env.img_url.getWithMetadata(file.id)).metadata.folderPath, expected);
  }
});

test('protected uploads get a new record with all requested settings in D1', async (t) => {
  const migrated = makeMigratedEnv();
  t.after(() => migrated._db.close());
  const env = { ...migrated, img_url: makeKv(), KV_LEGACY_WRITE: 'false', R2_BUCKET: { async put() {} } };
  const data = { apiToken: { id: 'share' } };
  const original = await upload({ request: uploadRequest({ storage: 'r2' }), env, data });
  assert.equal(original.status, 200);
  const originalId = (await original.json()).file.id;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('test data'));
  const sha = Buffer.from(digest).toString('hex');
  const result = migrated._db.prepare('UPDATE files SET content_sha = ? WHERE kv_key = ?').run(sha, originalId);
  assert.equal(result.changes, 1);
  const response = await upload({
    request: uploadRequest({
      storage: 'r2', deduplicate: 'true', password: 'test-pass',
      expires_in: '120', max_downloads: '2', slug: 'protected-upload',
    }),
    env, data,
  });

  assert.equal(response.status, 200);
  const { file, links } = await response.json();
  assert.notEqual(file.id, originalId);
  assert.match(links.share, /\/s\/protected-upload$/);
  const stored = migrated._db.prepare('SELECT * FROM files WHERE kv_key = ?').get(file.id);
  assert.equal(stored.share_slug, 'protected-upload');
  assert.equal(stored.share_max_downloads, 2);
  assert.ok(stored.share_password_hash);
  assert.ok(stored.share_expires_at > Date.now());
});

test('protected Telegram uploads report unavailable metadata before uploading', async () => {
  const response = await upload({
    request: uploadRequest({ storage: 'telegram', password: 'test-pass' }),
    env: { img_url: makeKv(), TELEGRAM_METADATA_MODE: 'off' },
    data: { apiToken: { id: 'share' } },
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'SHARE_METADATA_UNAVAILABLE');
});

test('URL mirroring rejects a declared size before consuming the response', async (t) => {
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull() { reads += 1; },
  }, { highWaterMark: 0 }), { headers: { 'Content-Length': String(21 * MB) } }));
  const response = await mirror({
    request: mirrorRequest('telegram'),
    env: { BASIC_USER: 'test', BASIC_PASS: 'test' },
  });

  assert.equal(response.status, 413);
  assert.equal(reads, 0);
});

test('URL mirroring cancels a response that crosses the backend limit while reading', async (t) => {
  const chunk = new Uint8Array(MB);
  let reads = 0;
  let canceled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull(controller) {
      if (++reads <= 25) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() { canceled = true; },
  }, { highWaterMark: 0 })));
  const response = await mirror({
    request: mirrorRequest('telegram'),
    env: { BASIC_USER: 'test', BASIC_PASS: 'test' },
  });

  assert.equal(response.status, 413);
  assert.equal(reads, 21);
  assert.equal(canceled, true);
});

test('R2 URL mirroring uses bounded parts and commits after the final byte', async (t) => {
  const parts = [];
  let complete = false;
  let remaining = 9;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull(controller) {
      if (remaining-- > 0) controller.enqueue(new Uint8Array(MB));
      else controller.close();
    },
  })));
  const env = {
    BASIC_USER: 'test',
    BASIC_PASS: 'test',
    R2_BUCKET: {
      async createMultipartUpload() {
        return {
          async uploadPart(partNumber, bytes) {
            parts.push(bytes.byteLength);
            return { partNumber, etag: String(partNumber) };
          },
          async complete() { complete = true; },
          async abort() { assert.fail('successful upload aborted'); },
        };
      },
    },
  };
  const response = await mirror({ request: mirrorRequest('r2'), env });
  assert.equal(response.status, 200);
  assert.equal((await response.json())[0].size, 9 * MB);
  assert.deepEqual(parts, [8 * MB, MB]);
  assert.equal(complete, true);
});

test('URL mirroring streams real byte counts before confirming storage', { timeout: 3000 }, async (t) => {
  let upstream;
  let fetches = 0;
  const saved = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async () => {
    fetches += 1;
    return new Response(new ReadableStream({ start(controller) { upstream = controller; } }), {
      headers: { 'Content-Length': '4' },
    });
  });
  const response = await mirror({
    request: mirrorRequest('auto', 'application/x-ndjson'),
    env: { BASIC_USER: 'test', BASIC_PASS: 'test', R2_BUCKET: { put: () => saved.promise } },
  });
  assert.match(response.headers.get('Content-Type'), /^application\/x-ndjson/);
  const reader = response.body.getReader();
  t.after(async () => {
    saved.resolve();
    await reader.cancel();
  });
  const next = async () => JSON.parse(new TextDecoder().decode((await reader.read()).value));
  assert.equal((await next()).phase, 'connecting');
  const transfer = await next();
  assert.equal(transfer.storage, 'r2');
  assert.equal(transfer.totalBytes, 4);
  upstream.enqueue(new Uint8Array(2));
  const progress = await next();
  assert.equal(progress.type, 'progress');
  assert.equal(progress.receivedBytes, 2);
  upstream.enqueue(new Uint8Array(2));
  upstream.close();
  const saving = await next();
  assert.equal(saving.phase, 'saving');
  assert.equal(saving.receivedBytes, 4);
  saved.resolve();
  assert.equal((await next()).phase, 'finalizing');
  const result = await next();
  assert.equal(result.status, 200);
  assert.equal(result.data[0].size, 4);
  assert.equal(fetches, 1);
});

test('URL mirroring treats encoded lengths as unknown and reports truncated files as errors', async (t) => {
  let writes = 0;
  const env = { BASIC_USER: 'test', BASIC_PASS: 'test', R2_BUCKET: { async put() { writes += 1; } } };
  const upstream = t.mock.method(globalThis, 'fetch', async () => new Response('hello', {
    headers: { 'Content-Length': '10', 'Content-Encoding': 'gzip' },
  }));
  const mirrorEvents = async () => {
    const response = await mirror({ request: mirrorRequest('r2', 'application/x-ndjson'), env });
    return (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  };
  const compressed = await mirrorEvents();
  assert.equal(compressed.find(event => event.phase === 'transferring').totalBytes, null);
  assert.equal(compressed.at(-1).data[0].size, 5);

  upstream.mock.mockImplementation(async () => new Response('hello', { headers: { 'Content-Length': '10' } }));
  const truncated = await mirrorEvents();
  assert.equal(truncated.at(-1).status, 502);
  assert.equal(writes, 1);
});

test('R2 multipart preserves a common deadline across slow uploads and resume', async (t) => {
  const start = 1_800_000_000_000;
  const deadline = start / 1000 + 24 * 60 * 60;
  let now = start;
  t.mock.method(Date, 'now', () => now);
  const kv = makeKv();
  let aborts = 0;
  let created = 0;
  const env = {
    BASIC_USER: 'test',
    BASIC_PASS: 'test',
    img_url: kv,
    R2_BUCKET: {
      async createMultipartUpload() { return { uploadId: `multipart-${++created}` }; },
      resumeMultipartUpload() {
        return {
          async abort() { aborts++; },
          async uploadPart(partNumber, data) {
            assert.equal(data.byteLength, 1);
            return { partNumber, etag: 'part-etag' };
          },
          async complete(parts) {
            assert.deepEqual(parts, [{ partNumber: 1, etag: 'part-etag' }]);
          },
        };
      },
      async head() { return { size: 1 }; },
    },
  };
  const headers = { Authorization: 'Basic ' + btoa('test:test') };
  const post = (path, body) => ({
    env,
    request: new Request(`https://example.test/api/chunked-upload/${path}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    }),
  });
  const file = {
    fileName: 'slow.bin', fileSize: 1, totalChunks: 1,
    chunkSize: 5 * MB, storageMode: 'r2', fileId: 'slow-file-id',
  };

  const initial = await initChunks(post('init', file));
  assert.equal(initial.status, 200);
  const { uploadId } = await initial.json();
  const taskKey = `upload:${uploadId}`;
  const mapKey = [...kv.entries.keys()].find(key => key.startsWith('resume-map:'));
  assert.equal(kv.entries.get(taskKey).expiration, deadline);
  assert.equal(kv.entries.get(mapKey).expiration, deadline);

  now = start + 91 * 60 * 1000;
  const second = await initChunks(post('init', { ...file, fileId: 'another-file-id' }));
  assert.equal(second.status, 200);
  assert.equal(aborts, 0);

  const chunkRequest = () => ({
    env,
    request: new Request(`https://example.test/api/chunked-upload/chunk?uploadId=${uploadId}&chunkIndex=0`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': '1' },
      body: new Uint8Array([42]),
    }),
  });
  const part = await uploadChunk(chunkRequest());
  assert.equal(part.status, 200);
  assert.equal(kv.entries.get(`part-state:${uploadId}:0`).expiration, deadline);

  const resumed = await initChunks(post('init', file));
  assert.equal(resumed.status, 200);
  const state = await resumed.json();
  assert.equal(state.uploadId, uploadId);
  assert.deepEqual(state.uploadedChunks, [0]);
  assert.deepEqual(state.parts, [{ partNumber: 1, etag: 'part-etag' }]);

  now = deadline * 1000;
  // Simulate a stale KV read after the deadline.
  assert.equal((await uploadChunk(chunkRequest())).status, 404);
  assert.equal((await completeChunks(post('complete', { uploadId }))).status, 404);

  const fresh = await initChunks(post('init', file));
  assert.equal(fresh.status, 200);
  assert.notEqual((await fresh.json()).uploadId, uploadId);
  assert.equal(aborts, 1);
});

test('new non-R2 uploads stage chunks in expiring KV and sweep abandoned R2 staging objects', async () => {
  const kv = makeKv();
  const oldId = 'a'.repeat(32);
  const activeId = 'b'.repeat(32);
  const recentId = 'c'.repeat(32);
  const oldObject = (uploadId, uploaded = new Date(Date.now() - 25 * 60 * 60 * 1000)) => ({
    key: `chunk-upload/${uploadId}/0`,
    uploaded,
    customMetadata: { type: 'chunk', uploadId, chunkIndex: '0' },
  });
  kv.entries.set(`upload:${activeId}`, { value: JSON.stringify({
    uploadId: activeId, ownerId: 'test', fileName: 'legacy.bin', fileSize: 1,
    totalChunks: 1, chunkSize: 50 * MB, storageMode: 's3', chunkBackend: 'r2',
    createdAt: Date.now(),
  }) });
  const deleted = [];
  const background = [];
  const env = {
    BASIC_USER: 'test',
    BASIC_PASS: 'test',
    CHUNK_BACKEND: 'r2',
    S3_ENDPOINT: 'https://example.test',
    S3_ACCESS_KEY_ID: 'test',
    img_url: kv,
    R2_BUCKET: {
      async list(options) {
        if (options.prefix === `chunk-upload/${activeId}/`) return { objects: [oldObject(activeId)] };
        assert.equal(options.prefix, 'chunk-upload/');
        return { objects: [
          oldObject(oldId), oldObject(activeId), oldObject(recentId, new Date(Date.now())),
          { ...oldObject('d'.repeat(32)), key: 'chunk-upload/r2_permanent.bin' },
        ] };
      },
      async delete(keys) { deleted.push(...keys); },
      async put() { assert.fail('new staged chunks should not be written to R2'); },
    },
  };
  const headers = { Authorization: 'Basic ' + btoa('test:test') };
  const init = (body) => initChunks({
    env,
    waitUntil(job) { background.push(job); },
    request: new Request('https://example.test/api/chunked-upload/init', {
      method: 'POST', headers, body: JSON.stringify(body),
    }),
  });
  const file = { fileName: 'new.bin', fileSize: 1, totalChunks: 1, chunkSize: 10 * MB, storageMode: 's3' };
  const initial = await init(file);
  assert.equal(initial.status, 200);
  const task = await initial.json();
  assert.equal(task.chunkBackend, 'kv');
  await Promise.all(background);
  assert.deepEqual(deleted, [`chunk-upload/${oldId}/0`]);

  const part = await uploadChunk({
    env,
    request: new Request(`https://example.test/api/chunked-upload/chunk?uploadId=${task.uploadId}&chunkIndex=0`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': '1' },
      body: new Uint8Array([42]),
    }),
  });
  assert.equal(part.status, 200);
  assert.equal(kv.entries.get(`chunk:${task.uploadId}:0`).expirationTtl, 90 * 60);

  const resumed = await init({ ...file, uploadId: activeId, fileName: 'legacy.bin', chunkSize: 50 * MB });
  assert.equal(resumed.status, 200);
  const state = await resumed.json();
  assert.equal(state.uploadId, activeId);
  assert.equal(state.chunkBackend, 'r2');
  assert.deepEqual(state.uploadedChunks, [0]);
  await Promise.all(background);
});

test('URL mirroring completes cleanly via EOF grace when origin hangs after sending 100% Content-Length', { timeout: 5000 }, async (t) => {
  let savedBytes = 0;
  let canceled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(
    new ReadableStream({
      start(controller) {
        // Send exact Content-Length bytes and deliberately never call controller.close()
        // to simulate an origin holding an HTTP/1.1 keep-alive connection open at 100%.
        controller.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6]));
      },
      cancel() {
        canceled = true;
      },
    }),
    { headers: { 'Content-Length': '6', 'Content-Type': 'application/octet-stream' } }
  ));

  const env = {
    BASIC_USER: 'test',
    BASIC_PASS: 'test',
    R2_BUCKET: {
      async put(_key, body) {
        savedBytes = body.byteLength;
      },
    },
  };
  const startedAt = Date.now();
  const response = await mirror({ request: mirrorRequest('r2', 'application/x-ndjson'), env });
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  const elapsed = Date.now() - startedAt;

  const finalEvent = events.at(-1);
  assert.equal(finalEvent.type, 'result');
  assert.equal(finalEvent.status, 200);
  assert.equal(finalEvent.data[0].size, 6);
  assert.equal(savedBytes, 6);
  assert.equal(canceled, true);
  assert.ok(elapsed < 4000, `expected EOF grace completion well under 4s, got ${elapsed}ms`);
});

test('URL mirroring to Telegram retries transient non-JSON 502 and offloads upload notice to waitUntil', { timeout: 5000 }, async (t) => {
  let tgUploadCalls = 0;
  let noticeStarted = false;
  const releaseNotice = Promise.withResolvers();
  const background = [];

  t.mock.method(globalThis, 'fetch', async (url) => {
    const target = String(url);
    if (target.startsWith('https://origin.example/')) {
      return new Response('hello-tg', {
        headers: { 'Content-Length': '8', 'Content-Type': 'application/octet-stream' },
      });
    }
    if (target.includes('/sendDocument')) {
      tgUploadCalls += 1;
      if (tgUploadCalls === 1) {
        return new Response('<html>502 Bad Gateway</html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      return new Response(JSON.stringify({
        ok: true,
        result: {
          message_id: 99,
          document: { file_id: 'BQACAgUAAxkBAAI_test_file_id' },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (target.includes('/sendMessage')) {
      noticeStarted = true;
      await releaseNotice.promise;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 100 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch URL: ${target}`);
  });

  t.after(() => releaseNotice.resolve());

  const env = {
    BASIC_USER: 'test',
    BASIC_PASS: 'test',
    TG_BOT_TOKEN: '123456:test-token',
    TG_CHAT_ID: '-1001234567890',
    TG_UPLOAD_NOTICE: 'true',
    SIGNED_LINK_SECRET: 'test-signing-secret-for-unit-test',
  };

  const response = await mirror({
    request: mirrorRequest('telegram', 'application/json'),
    env,
    waitUntil(job) {
      background.push(job);
    },
  });

  // Response must return immediately without blocking on the slow Telegram sendMessage notice
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data[0].size, 8);
  assert.equal(tgUploadCalls, 2);
  assert.equal(background.length, 1);
  assert.equal(noticeStarted, true);

  releaseNotice.resolve();
  await Promise.all(background);
});

