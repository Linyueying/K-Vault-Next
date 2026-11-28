import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyR2Error, computeBackoffDelay, retryR2Op } from '../functions/utils/r2-retry.js';
import {
  recordUploadedPart,
  listUploadedParts,
  deletePartStates,
  cleanupExpiredUploadParts,
  cleanupTaskState,
} from '../functions/utils/chunk-state.js';
import { onRequestPost as initChunks, onRequestGet as getChunkStatus } from '../functions/api/chunked-upload/init.js';
import { onRequestPost as uploadChunk } from '../functions/api/chunked-upload/chunk.js';
import { onRequestPost as completeChunks } from '../functions/api/chunked-upload/complete.js';
import { onRequestPost as abortChunks } from '../functions/api/chunked-upload/abort.js';
import { onRequestPost as directUpload } from '../functions/upload.js';
import { onRequestPost as mirrorUpload } from '../functions/api/upload-from-url.js';
import { makeMigratedEnv } from './test-utils.mjs';

const MB = 1024 * 1024;
const AUTH_HEADER = 'Basic ' + btoa('admin:secret');

function hexId(n) {
  return String(n).padStart(32, 'a');
}

function makeKv() {
  const entries = new Map();
  let putCount = 0;
  let getCount = 0;
  let deleteCount = 0;
  const putKeys = [];
  return {
    entries,
    get stats() {
      return { putCount, getCount, deleteCount, putKeys: putKeys.slice() };
    },
    async get(key, options) {
      getCount++;
      const value = entries.get(key)?.value ?? null;
      return options?.type === 'json' && value ? JSON.parse(value) : value;
    },
    async getWithMetadata(key) {
      getCount++;
      return entries.get(key) ?? { value: null, metadata: null };
    },
    async put(key, value, options) {
      putCount++;
      putKeys.push(key);
      entries.set(key, {
        value,
        metadata: options?.metadata,
        expiration: options?.expiration,
        expirationTtl: options?.expirationTtl,
      });
    },
    async delete(key) {
      deleteCount++;
      entries.delete(key);
    },
    async list({ prefix = '', cursor } = {}) {
      const keys = [...entries.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: cursor || undefined };
    },
  };
}

function makeAuthHeaders(extra = {}) {
  return { Authorization: AUTH_HEADER, ...extra };
}

function makeChunkRequest(uploadId, chunkIndex, byteLength) {
  return new Request(
    `https://example.test/api/chunked-upload/chunk?uploadId=${uploadId}&chunkIndex=${chunkIndex}`,
    {
      method: 'POST',
      headers: makeAuthHeaders({
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(byteLength),
      }),
      body: new Uint8Array(byteLength),
    }
  );
}

function makeWaitUntil() {
  const pending = [];
  return {
    waitUntil(promise) {
      pending.push(Promise.resolve(promise));
    },
    async flush() {
      await Promise.allSettled(pending.splice(0));
    },
  };
}

test('r2-retry: classifyR2Error, computeBackoffDelay, and retryR2Op behavior', async () => {
  assert.equal(classifyR2Error(new Error('NoSuchUpload: upload does not exist')), 'expired');
  assert.equal(classifyR2Error(new Error('InvalidPart: etag mismatch')), 'client');
  assert.equal(classifyR2Error(new Error('EntityTooSmall: part smaller than 5MB')), 'client');
  assert.equal(classifyR2Error(Object.assign(new Error('bad'), { status: 400 })), 'client');
  assert.equal(classifyR2Error(Object.assign(new Error('aborted'), { name: 'AbortError' })), 'aborted');
  assert.equal(classifyR2Error(new Error('503 Service Unavailable')), 'transient');

  for (let i = 1; i <= 5; i++) {
    const d = computeBackoffDelay(i, 50, 400);
    assert.ok(d >= 0 && d <= 400);
  }

  let transientAttempts = 0;
  const okResult = await retryR2Op(async () => {
    transientAttempts++;
    if (transientAttempts < 3) throw new Error('temporary network reset');
    return 'recovered';
  }, { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 10 });
  assert.equal(okResult, 'recovered');
  assert.equal(transientAttempts, 3);

  let clientAttempts = 0;
  await assert.rejects(
    retryR2Op(async () => {
      clientAttempts++;
      throw new Error('EntityTooSmall');
    }, { maxAttempts: 4, baseDelayMs: 5, maxDelayMs: 10 }),
    /EntityTooSmall/
  );
  assert.equal(clientAttempts, 1);

  let expiredAttempts = 0;
  await assert.rejects(
    retryR2Op(async () => {
      expiredAttempts++;
      throw new Error('NoSuchUpload');
    }, { maxAttempts: 4, baseDelayMs: 5, maxDelayMs: 10 }),
    /NoSuchUpload/
  );
  assert.equal(expiredAttempts, 1);

  const ac = new AbortController();
  ac.abort();
  let abortedAttempts = 0;
  await assert.rejects(
    retryR2Op(async () => {
      abortedAttempts++;
      return 'never';
    }, { maxAttempts: 3, signal: ac.signal }),
    (err) => err.name === 'AbortError'
  );
  assert.equal(abortedAttempts, 0);
});

test('D1 upload_parts end-to-end: 0 KV part-state writes, resume via D1, complete & cleanup', async (t) => {
  const migrated = makeMigratedEnv();
  t.after(() => migrated._db.close());
  const kv = makeKv();
  const wu = makeWaitUntil();

  const objects = new Map();
  const multipartParts = new Map();
  let headCalls = 0;

  const r2 = {
    async list() { return { objects: [], truncated: false }; },
    async createMultipartUpload(key) {
      const uploadId = `r2-mp-${Date.now()}`;
      multipartParts.set(uploadId, { key, parts: new Map(), aborted: false });
      return { uploadId };
    },
    resumeMultipartUpload(key, r2UploadId) {
      return {
        async uploadPart(partNumber, body) {
          const state = multipartParts.get(r2UploadId);
          const size = body.byteLength ?? body.size ?? 0;
          const etag = `etag-p${partNumber}-${size}`;
          state.parts.set(partNumber, size);
          return { partNumber, etag };
        },
        async complete(parts) {
          const state = multipartParts.get(r2UploadId);
          let totalSize = 0;
          for (const p of parts) {
            totalSize += state.parts.get(p.partNumber) || 0;
          }
          objects.set(key, { size: totalSize, key });
          return { key, etag: 'final-etag' };
        },
        async abort() {
          const state = multipartParts.get(r2UploadId);
          if (state) state.aborted = true;
        },
      };
    },
    async head(key) {
      headCalls++;
      return objects.get(key) || null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };

  const env = {
    ...migrated,
    img_url: kv,
    R2_BUCKET: r2,
    BASIC_USER: 'admin',
    BASIC_PASS: 'secret',
  };

  const chunkSize = 8 * MB;
  const fileSize = 16 * MB + 1024;
  const totalChunks = Math.ceil(fileSize / chunkSize); // 3 chunks

  // 1. Init
  const initRes = await initChunks({
    request: new Request('https://example.test/api/chunked-upload/init', {
      method: 'POST',
      headers: makeAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        fileName: 'video.mp4',
        fileSize,
        fileType: 'video/mp4',
        totalChunks,
        chunkSize,
        storageMode: 'r2',
        fileId: 'fp-video-1',
        resume: true,
      }),
    }),
    env,
    waitUntil: wu.waitUntil,
  });
  assert.equal(initRes.status, 200);
  const initData = await initRes.json();
  assert.equal(initData.resumed, false);
  assert.equal(initData.chunkSize, chunkSize);
  const uploadId = initData.uploadId;

  // 2. Upload chunks 0 and 1
  for (const idx of [0, 1]) {
    const res = await uploadChunk({
      request: makeChunkRequest(uploadId, idx, chunkSize),
      env,
      waitUntil: wu.waitUntil,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.partNumber, idx + 1);
  }

  // Verify 0 KV part-state writes, 2 D1 upload_parts rows
  const kvPartStateWrites = kv.stats.putKeys.filter((k) => k.startsWith('part-state:'));
  assert.equal(kvPartStateWrites.length, 0);
  const d1Rows = migrated._db
    .prepare('SELECT chunk_index, part_number, etag, size FROM upload_parts WHERE upload_id = ? ORDER BY chunk_index')
    .all(uploadId);
  assert.equal(d1Rows.length, 2);
  assert.deepEqual(d1Rows.map((r) => r.chunk_index), [0, 1]);

  // 3. Resume via init POST and GET status
  const resumeRes = await initChunks({
    request: new Request('https://example.test/api/chunked-upload/init', {
      method: 'POST',
      headers: makeAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        fileName: 'video.mp4',
        fileSize,
        fileType: 'video/mp4',
        totalChunks,
        chunkSize,
        storageMode: 'r2',
        fileId: 'fp-video-1',
        resume: true,
        uploadId,
      }),
    }),
    env,
    waitUntil: wu.waitUntil,
  });
  assert.equal(resumeRes.status, 200);
  const resumeData = await resumeRes.json();
  assert.equal(resumeData.resumed, true);
  assert.deepEqual(resumeData.uploadedChunks, [0, 1]);
  assert.equal(resumeData.parts.length, 2);

  const statusRes = await getChunkStatus({
    request: new Request(`https://example.test/api/chunked-upload/init?uploadId=${uploadId}`, {
      method: 'GET',
      headers: makeAuthHeaders(),
    }),
    env,
  });
  assert.equal(statusRes.status, 200);
  const statusData = await statusRes.json();
  assert.deepEqual(statusData.uploadedChunks, [0, 1]);

  // 4. Upload final chunk 2
  const lastRes = await uploadChunk({
    request: makeChunkRequest(uploadId, 2, 1024),
    env,
    waitUntil: wu.waitUntil,
  });
  assert.equal(lastRes.status, 200);

  // 5. Complete (even passing empty parts array, server recovers all 3 from D1!)
  const completeRes = await completeChunks({
    request: new Request('https://example.test/api/chunked-upload/complete', {
      method: 'POST',
      headers: makeAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ uploadId, parts: [] }),
    }),
    env,
    waitUntil: wu.waitUntil,
  });
  assert.equal(completeRes.status, 200);
  const completeData = await completeRes.json();
  assert.equal(completeData.success, true);
  assert.ok(typeof completeData.src === 'string' && completeData.src.startsWith('/file/'));
  assert.equal(headCalls, 1);

  await wu.flush();

  // Verify D1 upload_parts cleaned up after complete
  const remainingRows = migrated._db
    .prepare('SELECT COUNT(*) as cnt FROM upload_parts WHERE upload_id = ?')
    .get(uploadId);
  assert.equal(remainingRows.cnt, 0);

  // Verify cleanupExpiredUploadParts removes expired rows only
  const nowSec = Math.floor(Date.now() / 1000);
  await recordUploadedPart(env, hexId(91), 0, { partNumber: 1, etag: 'e1', size: 10 }, { expiresAt: nowSec - 60 });
  await recordUploadedPart(env, hexId(92), 0, { partNumber: 1, etag: 'e2', size: 10 }, { expiresAt: nowSec + 3600 });
  await cleanupExpiredUploadParts(env);
  assert.equal((await listUploadedParts(env, hexId(91))).length, 0);
  assert.equal((await listUploadedParts(env, hexId(92))).length, 1);
  await deletePartStates(env, hexId(92), 1);
  assert.equal((await listUploadedParts(env, hexId(92))).length, 0);
});

test('KV fallback parallel listUploadedParts & R2-native cleanupTaskState avoids chunk-upload deletes', async () => {
  const kv = makeKv();
  const r2Deletes = [];
  const env = {
    img_url: kv,
    R2_BUCKET: {
      async delete(key) { r2Deletes.push(key); },
    },
  };

  const id = hexId(101);
  for (let i = 0; i < 25; i++) {
    await recordUploadedPart(env, id, i, { partNumber: i + 1, etag: `e-${i + 1}`, size: 1024 });
  }
  const parts = await listUploadedParts(env, id);
  assert.equal(parts.length, 25);
  assert.equal(parts[0].partNumber, 1);
  assert.equal(parts[24].partNumber, 25);

  await cleanupTaskState(env, id, {
    storageMode: 'r2',
    chunkBackend: 'r2',
    totalChunks: 25,
    r2Multipart: { key: 'real-object.bin', uploadId: 'mp-1' },
  });
  assert.equal(r2Deletes.length, 0);
  assert.equal((await listUploadedParts(env, id)).length, 0);
});

test('chunk.js: retries transient R2 uploadPart and classifies expired/invalid/retry errors', async () => {
  const kv = makeKv();
  const ownerId = 'admin';
  const makeTask = (uploadId) => ({
    uploadId,
    ownerId,
    fileName: 'a.bin',
    fileSize: 10 * MB,
    totalChunks: 2,
    chunkSize: 5 * MB,
    storageMode: 'r2',
    chunkBackend: 'r2',
    r2Multipart: { key: `k-${uploadId}`, uploadId: `mp-${uploadId}` },
    createdAt: Date.now(),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });

  // Case 1: transient error succeeds on 2nd attempt
  let attempts1 = 0;
  const id1 = hexId(201);
  await kv.put(`upload:${id1}`, JSON.stringify(makeTask(id1)));
  const res1 = await uploadChunk({
    request: makeChunkRequest(id1, 0, 5 * MB),
    env: {
      img_url: kv,
      BASIC_USER: 'admin',
      BASIC_PASS: 'secret',
      R2_BUCKET: {
        resumeMultipartUpload() {
          return {
            async uploadPart(partNumber) {
              attempts1++;
              if (attempts1 === 1) throw new Error('R2 temporary timeout');
              return { partNumber, etag: 'ok-etag' };
            },
          };
        },
      },
    },
  });
  assert.equal(res1.status, 200);
  assert.equal(attempts1, 2);

  // Case 2: NoSuchUpload -> 404 R2_UPLOAD_EXPIRED (fast-fail, 1 attempt)
  let attempts2 = 0;
  const id2 = hexId(202);
  await kv.put(`upload:${id2}`, JSON.stringify(makeTask(id2)));
  const res2 = await uploadChunk({
    request: makeChunkRequest(id2, 0, 5 * MB),
    env: {
      img_url: kv,
      BASIC_USER: 'admin',
      BASIC_PASS: 'secret',
      R2_BUCKET: {
        resumeMultipartUpload() {
          return {
            async uploadPart() {
              attempts2++;
              throw new Error('NoSuchUpload: expired');
            },
          };
        },
      },
    },
  });
  assert.equal(res2.status, 404);
  assert.equal((await res2.json()).code, 'R2_UPLOAD_EXPIRED');
  assert.equal(attempts2, 1);

  // Case 3: Persistent transient error -> 503 R2_PART_RETRY + Retry-After: 1
  const id3 = hexId(203);
  await kv.put(`upload:${id3}`, JSON.stringify(makeTask(id3)));
  const res3 = await uploadChunk({
    request: makeChunkRequest(id3, 0, 5 * MB),
    env: {
      img_url: kv,
      BASIC_USER: 'admin',
      BASIC_PASS: 'secret',
      R2_BUCKET: {
        resumeMultipartUpload() {
          return {
            async uploadPart() {
              throw new Error('503 Internal Error');
            },
          };
        },
      },
    },
  });
  assert.equal(res3.status, 503);
  assert.equal(res3.headers.get('Retry-After'), '1');
  assert.equal((await res3.json()).code, 'R2_PART_RETRY');

  // Case 4: InvalidPart client error -> 400 R2_PART_INVALID (fast-fail, 1 attempt)
  let attempts4 = 0;
  const id4 = hexId(204);
  await kv.put(`upload:${id4}`, JSON.stringify(makeTask(id4)));
  const res4 = await uploadChunk({
    request: makeChunkRequest(id4, 0, 5 * MB),
    env: {
      img_url: kv,
      BASIC_USER: 'admin',
      BASIC_PASS: 'secret',
      R2_BUCKET: {
        resumeMultipartUpload() {
          return {
            async uploadPart() {
              attempts4++;
              throw new Error('InvalidPart: malformed part');
            },
          };
        },
      },
    },
  });
  assert.equal(res4.status, 400);
  assert.equal((await res4.json()).code, 'R2_PART_INVALID');
  assert.equal(attempts4, 1);
});

test('complete.js: transient complete preserves parts, mismatch size fails cleanly, head reused, metadata retryable', async (t) => {
  const migrated = makeMigratedEnv();
  t.after(() => migrated._db.close());
  const kv = makeKv();
  const ownerId = 'admin';

  // Case A: mp.complete transient error when object does not exist -> 503 R2_COMPLETE_RETRY WITHOUT abort, retry succeeds!
  let abortCallsA = 0;
  let completeAttemptsA = 0;
  const objectsA = new Map();
  const idA = hexId(301);
  const taskBase = {
    ownerId,
    fileName: 't.bin',
    fileSize: 5 * MB,
    totalChunks: 1,
    chunkSize: 5 * MB,
    storageMode: 'r2',
    chunkBackend: 'r2',
    createdAt: Date.now(),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
  await kv.put(`upload:${idA}`, JSON.stringify({
    ...taskBase,
    uploadId: idA,
    r2Multipart: { key: 'k-transient.bin', uploadId: 'mp-transient' },
  }));
  const envA = {
    ...migrated,
    img_url: kv,
    BASIC_USER: 'admin',
    BASIC_PASS: 'secret',
    R2_BUCKET: {
      resumeMultipartUpload(key) {
        return {
          async complete() {
            completeAttemptsA++;
            if (completeAttemptsA === 1) throw new Error('503 transient complete error');
            objectsA.set(key, { size: 5 * MB });
            return { key, etag: 'done' };
          },
          async abort() { abortCallsA++; },
        };
      },
      async head(key) { return objectsA.get(key) || null; },
      async delete(key) { objectsA.delete(key); },
    },
  };

  const resA1 = await completeChunks({
    request: new Request('https://example.test/api/chunked-upload/complete', {
      method: 'POST',
      headers: makeAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ uploadId: idA, parts: [{ partNumber: 1, etag: 'e1' }] }),
    }),
    env: envA,
  });
  assert.equal(resA1.status, 503);
  assert.equal((await resA1.json()).code, 'R2_COMPLETE_RETRY');
  assert.equal(abortCallsA, 0);

  const resA2 = await completeChunks({
    request: new Request('https://example.test/api/chunked-upload/complete', {
      method: 'POST',
      headers: makeAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ uploadId: idA, parts: [{ partNumber: 1, etag: 'e1' }] }),
    }),
    env: envA,
  });
  assert.equal(resA2.status, 200);
  assert.equal(completeAttemptsA, 2);

  // Case B: mp.complete throws & headObj exists with WRONG size -> delete + abort + 400 R2_SIZE_MISMATCH (no fall-through!)
  let abortCallsB = 0;
  let deleteCallsB = 0;
  const idB = hexId(302);
  await kv.put(`upload:${idB}`, JSON.stringify({
    ...taskBase,
    uploadId: idB,
    r2Multipart: { key: 'k-mismatch.bin', uploadId: 'mp-mismatch' },
  }));
  const resB = await completeChunks({
    request: new Request('https://example.test/api/chunked-upload/complete', {
      method: 'POST',
      headers: makeAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ uploadId: idB, parts: [{ partNumber: 1, etag: 'e1' }] }),
    }),
    env: {
      ...migrated,
      img_url: kv,
      BASIC_USER: 'admin',
      BASIC_PASS: 'secret',
      R2_BUCKET: {
        resumeMultipartUpload() {
          return {
            async complete() { throw new Error('already completed'); },
            async abort() { abortCallsB++; },
          };
        },
        async head() { return { size: 12345 }; }, // mismatched!
        async delete() { deleteCallsB++; },
      },
    },
  });
  assert.equal(resB.status, 400);
  assert.equal((await resB.json()).code, 'R2_SIZE_MISMATCH');
  assert.equal(deleteCallsB, 1);
  assert.equal(abortCallsB, 1);

  // Case C: mp.complete throws & headObj exists with MATCHING size -> head called ONLY ONCE, succeeds!
  let headCallsC = 0;
  const idC = hexId(303);
  await kv.put(`upload:${idC}`, JSON.stringify({
    ...taskBase,
    uploadId: idC,
    r2Multipart: { key: 'k-reuse.bin', uploadId: 'mp-reuse' },
  }));
  const resC = await completeChunks({
    request: new Request('https://example.test/api/chunked-upload/complete', {
      method: 'POST',
      headers: makeAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ uploadId: idC, parts: [{ partNumber: 1, etag: 'e1' }] }),
    }),
    env: {
      ...migrated,
      img_url: kv,
      BASIC_USER: 'admin',
      BASIC_PASS: 'secret',
      R2_BUCKET: {
        resumeMultipartUpload() {
          return {
            async complete() { throw new Error('already completed by concurrent retry'); },
            async abort() {},
          };
        },
        async head() {
          headCallsC++;
          return { size: 5 * MB };
        },
        async delete() {},
      },
    },
  });
  assert.equal(resC.status, 200);
  assert.equal(headCallsC, 1);

  // Case D: object_ready metadata failure -> keeps object + retryable: true; 2nd complete skips mp.complete and succeeds!
  let completeCallsD = 0;
  let deleteCallsD = 0;
  let failMetaWrite = true;
  const idD = hexId(304);
  const kvD = makeKv();
  const origPut = kvD.put.bind(kvD);
  kvD.put = async (key, value, options) => {
    if (failMetaWrite && key.startsWith('r2:')) {
      failMetaWrite = false;
      throw new Error('KV temporary write outage');
    }
    return origPut(key, value, options);
  };
  await kvD.put(`upload:${idD}`, JSON.stringify({
    ...taskBase,
    uploadId: idD,
    r2Multipart: { key: 'k-meta.bin', uploadId: 'mp-meta' },
  }));
  const envD = {
    img_url: kvD,
    BASIC_USER: 'admin',
    BASIC_PASS: 'secret',
    R2_BUCKET: {
      resumeMultipartUpload(key) {
        return {
          async complete() {
            completeCallsD++;
            return { key, etag: 'e-meta' };
          },
          async abort() {},
        };
      },
      async head() { return { size: 5 * MB }; },
      async delete() { deleteCallsD++; },
    },
  };

  const resD1 = await completeChunks({
    request: new Request('https://example.test/api/chunked-upload/complete', {
      method: 'POST',
      headers: makeAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ uploadId: idD, parts: [{ partNumber: 1, etag: 'e1' }] }),
    }),
    env: envD,
  });
  assert.equal(resD1.status, 500);
  const bodyD1 = await resD1.json();
  assert.equal(bodyD1.code, 'METADATA_WRITE_FAILED');
  assert.equal(bodyD1.retryable, true);
  assert.equal(deleteCallsD, 0);
  assert.equal(completeCallsD, 1);

  const resD2 = await completeChunks({
    request: new Request('https://example.test/api/chunked-upload/complete', {
      method: 'POST',
      headers: makeAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ uploadId: idD, parts: [{ partNumber: 1, etag: 'e1' }] }),
    }),
    env: envD,
  });
  assert.equal(resD2.status, 200);
  assert.equal(completeCallsD, 1); // Did NOT re-call mp.complete!
});

test('abort.js: deduplicates R2 aborts and cleans D1 upload_parts', async (t) => {
  const migrated = makeMigratedEnv();
  t.after(() => migrated._db.close());
  const kv = makeKv();
  const ownerId = 'admin';
  const uploadId = hexId(401);
  const abortTargets = [];

  const env = {
    ...migrated,
    img_url: kv,
    BASIC_USER: 'admin',
    BASIC_PASS: 'secret',
    R2_BUCKET: {
      resumeMultipartUpload(key, r2UploadId) {
        return {
          async abort() {
            abortTargets.push(`${key}::${r2UploadId}`);
          },
        };
      },
    },
  };

  await kv.put(`upload:${uploadId}`, JSON.stringify({
    uploadId,
    ownerId,
    totalChunks: 2,
    storageMode: 'r2',
    r2Multipart: { key: 'dup.bin', uploadId: 'mp-dup' },
  }));
  await kv.put(`user-multiparts:${ownerId}`, JSON.stringify([
    { uploadId, key: 'dup.bin', r2UploadId: 'mp-dup', totalChunks: 2, createdAt: Date.now() },
  ]));
  await recordUploadedPart(env, uploadId, 0, { partNumber: 1, etag: 'e1', size: 5 * MB });
  await recordUploadedPart(env, uploadId, 1, { partNumber: 2, etag: 'e2', size: 1024 });

  const res = await abortChunks({
    request: new Request('https://example.test/api/chunked-upload/abort', {
      method: 'POST',
      headers: makeAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ uploadId }),
    }),
    env,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(abortTargets, ['dup.bin::mp-dup']);
  assert.equal((await listUploadedParts(env, uploadId)).length, 0);
  assert.equal(await kv.get(`upload:${uploadId}`), null);
});

test('upload.js direct R2 upload: retries transient put and rolls back orphan R2 object on metadata failure', async () => {
  // 1. Transient R2 put recovers on retry
  let putAttempts = 0;
  const kvOk = makeKv();
  const fd1 = new FormData();
  fd1.set('file', new File(['hello r2'], 'hello.txt', { type: 'text/plain' }));
  fd1.set('storageMode', 'r2');
  const res1 = await directUpload({
    request: new Request('https://example.test/upload', {
      method: 'POST',
      headers: makeAuthHeaders(),
      body: fd1,
    }),
    env: {
      img_url: kvOk,
      BASIC_USER: 'admin',
      BASIC_PASS: 'secret',
      R2_BUCKET: {
        async put() {
          putAttempts++;
          if (putAttempts === 1) throw new Error('R2 temporary put error');
        },
        async delete() {},
      },
    },
  });
  assert.equal(res1.status, 200);
  assert.equal(putAttempts, 2);

  // 2. Metadata write fails after R2 put -> deletes orphan R2 object
  const deletedKeys = [];
  const kvFail = makeKv();
  const origPut = kvFail.put.bind(kvFail);
  kvFail.put = async (key, value, options) => {
    if (key.startsWith('r2:')) throw new Error('KV write failed');
    return origPut(key, value, options);
  };
  const fd2 = new FormData();
  fd2.set('file', new File(['orphan check'], 'orphan.txt', { type: 'text/plain' }));
  fd2.set('storageMode', 'r2');
  const res2 = await directUpload({
    request: new Request('https://example.test/upload', {
      method: 'POST',
      headers: makeAuthHeaders(),
      body: fd2,
    }),
    env: {
      img_url: kvFail,
      BASIC_USER: 'admin',
      BASIC_PASS: 'secret',
      R2_BUCKET: {
        async put() {},
        async delete(key) { deletedKeys.push(key); },
      },
    },
  });
  assert.equal(res2.status, 500);
  assert.equal(deletedKeys.length, 1);
});

test('upload-from-url.js R2 mirroring: retries transient uploadPart and rolls back on metadata failure', async (t) => {
  // 1. Transient uploadPart failure recovers on 2nd attempt (9MB > 8MB R2_STREAM_PART_SIZE -> multipart)
  let partAttempts = 0;
  let remaining1 = 9;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull(controller) {
      if (remaining1-- > 0) controller.enqueue(new Uint8Array(MB));
      else controller.close();
    },
  })));
  const res1 = await mirrorUpload({
    request: new Request('https://example.test/api/upload-from-url', {
      method: 'POST',
      headers: makeAuthHeaders({ Accept: 'application/json' }),
      body: JSON.stringify({ url: 'https://origin.example/sample.bin', storageMode: 'r2' }),
    }),
    env: {
      img_url: makeKv(),
      BASIC_USER: 'admin',
      BASIC_PASS: 'secret',
      R2_BUCKET: {
        async createMultipartUpload() {
          return {
            async uploadPart(partNumber) {
              partAttempts++;
              if (partAttempts === 1) throw new Error('503 R2 part busy');
              return { partNumber, etag: `etag-${partNumber}` };
            },
            async complete() {},
            async abort() {},
          };
        },
        async put() {},
        async delete() {},
      },
    },
  });
  assert.equal(res1.status, 200);
  assert.ok(partAttempts >= 3); // 1 failed + 1 succeeded for part 1 + 1 for part 2

  // 2. Metadata write fails after multipart complete -> deletes orphan R2 object
  const deletedKeys = [];
  let remaining2 = 9;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    pull(controller) {
      if (remaining2-- > 0) controller.enqueue(new Uint8Array(MB));
      else controller.close();
    },
  })));
  const kvFail = makeKv();
  const origPut = kvFail.put.bind(kvFail);
  kvFail.put = async (key, value, options) => {
    if (key.startsWith('r2:')) throw new Error('KV outage');
    return origPut(key, value, options);
  };
  const res2 = await mirrorUpload({
    request: new Request('https://example.test/api/upload-from-url', {
      method: 'POST',
      headers: makeAuthHeaders({ Accept: 'application/json' }),
      body: JSON.stringify({ url: 'https://origin.example/sample2.bin', storageMode: 'r2' }),
    }),
    env: {
      img_url: kvFail,
      BASIC_USER: 'admin',
      BASIC_PASS: 'secret',
      R2_BUCKET: {
        async createMultipartUpload() {
          return {
            async uploadPart(partNumber) { return { partNumber, etag: `e-${partNumber}` }; },
            async complete() {},
            async abort() {},
          };
        },
        async put() {},
        async delete(key) { deletedKeys.push(key); },
      },
    },
  });
  assert.equal(res2.status, 500);
  assert.equal(deletedKeys.length, 1);
});
