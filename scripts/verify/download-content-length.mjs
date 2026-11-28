import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { upstreamByteLength } from '../../functions/utils/download-length.js';

// Use the real Workers HTTP server. A synthetic Response in Node keeps manual headers
// even when Workers would drop them for a generic ReadableStream.
const require = createRequire(import.meta.url);
const fromWrangler = () => createRequire(require.resolve('wrangler/package.json'))('miniflare');
const { Miniflare } = process.env.MINIFLARE_PATH ? require(process.env.MINIFLARE_PATH) : fromWrangler();
const root = fileURLToPath(new URL('../..', import.meta.url));
const payload = 'hello-world'.repeat(1024);
const worker = new Miniflare({
  compatibilityDate: '2026-05-03',
  modulesRoot: root,
  scriptPath: resolve(root, 'download-content-length-fixture.mjs'),
  modules: true,
  modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
  script: `
    import { onRequest as file } from './functions/file/[[path]].js';
    import { onRequestGet as airdrop } from './functions/api/airdrop/download.js';
    import { onRequest as middleware } from './functions/_middleware.js';

    export default {
      fetch(request, env, context) {
        const path = new URL(request.url).pathname;
        const routeContext = {
          request, env, waitUntil: context.waitUntil.bind(context),
          params: { path: path.slice('/file/'.length) },
        };
        return middleware({
          ...routeContext,
          next: () => path.startsWith('/file/') ? file(routeContext) : airdrop(routeContext),
        });
      },
    };
  `,
  r2Buckets: ['R2_BUCKET'],
  kvNamespaces: ['img_url'],
  d1Databases: ['DB'],
});

try {
  const base = await worker.ready;
  const r2 = await worker.getR2Bucket('R2_BUCKET');
  const kv = await worker.getKVNamespace('img_url');
  const db = await worker.getD1Database('DB');
  for (const migration of ['0010_airdrop.sql', '0011_airdrop_files.sql', '0012_airdrop_stats_detail.sql']) {
    // D1 batch accepts complete statements, including CREATE TABLE blocks.
    const sql = readFileSync(resolve(root, 'migrations', migration), 'utf8');
    const statements = sql.replace(/^\s*--.*$/gm, '').split(';').map(value => value.trim()).filter(Boolean);
    await db.batch(statements.map(statement => db.prepare(statement)));
  }
  const fixtures = { 'hello.txt': payload, 'empty.txt': '' };
  for (const [name, body] of Object.entries(fixtures)) {
    await r2.put(name, body);
    await kv.put('r2:' + name, '', {
      metadata: { r2Key: name, fileName: name, fileSize: body.length, storageType: 'r2' }
    });
  }
  const code = '123456';
  const receiverToken = 'receiver-token';
  await db.prepare(`INSERT INTO airdrop_sessions
    (code, status, sender_token, receiver_token, files_json, created_at, expires_at)
    VALUES (?, 'uploaded', ?, ?, ?, ?, ?)`).bind(code, 'sender-token', receiverToken, JSON.stringify([
    { idx: 0, name: 'hello.txt', size: payload.length, type: 'text/plain', backend: 'r2', key: 'hello.txt', status: 'uploaded' }
  ]), Date.now(), Date.now() + 60000).run();

  // Miniflare's local HTTP proxy does not honor no-transform in its compression
  // simulation. Request identity here and assert the production directive separately.
  const get = (path, { method = 'GET', headers } = {}) => fetch(new URL(path, base), {
    method, headers: { 'Accept-Encoding': 'identity', ...headers }
  });
  const url = '/file/r2:hello.txt?dl=1';
  const response = await get(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(payload.length));
  assert.match(response.headers.get('cache-control'), /\bno-transform\b/);
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.equal(response.headers.get('x-kvault-byte-cache'), 'MISS');
  assert.equal(await response.text(), payload);

  let cached;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = await get(url);
    assert.equal(candidate.headers.get('content-length'), String(payload.length));
    assert.equal(await candidate.text(), payload);
    if (candidate.headers.get('x-kvault-byte-cache') === 'HIT') {
      cached = candidate;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(cached, 'cache returns the full byte length on HIT as well as MISS');

  const range = await get(url, { headers: { Range: 'bytes=1-4' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-length'), '4');
  assert.equal(range.headers.get('content-range'), 'bytes 1-4/' + payload.length);
  assert.equal(await range.text(), payload.slice(1, 5));

  const head = await get(url, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), String(payload.length));
  assert.equal(await head.text(), '');
  const empty = await get('/file/r2:empty.txt?dl=1');
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get('content-length'), '0');
  assert.equal(await empty.text(), '');

  const delivery = await get('/api/airdrop/download?' + new URLSearchParams({
    code, token: receiverToken, idx: '0'
  }));
  assert.equal(delivery.status, 200);
  assert.equal(delivery.headers.get('content-length'), String(payload.length));
  assert.match(delivery.headers.get('cache-control'), /\bno-transform\b/);
  assert.equal(await delivery.text(), payload);
  const upstream = (headers, status = 200) => new Response(null, { status, headers });
  assert.equal(upstreamByteLength(upstream({ 'Content-Length': '6' })), 6);
  assert.equal(upstreamByteLength(upstream({ 'Content-Length': '0' })), null);
  assert.equal(upstreamByteLength(upstream({}), 12), 12);
  assert.equal(upstreamByteLength(upstream({ 'Content-Length': '6', 'Content-Encoding': 'gzip' }), 12), null);
  assert.equal(upstreamByteLength(upstream({ 'Content-Range': 'bytes 1-4/12' }, 206), 12), 4);
  assert.equal(upstreamByteLength(upstream({ 'Content-Range': 'bytes 1-4/12', 'Content-Length': '12' }, 206)), null);
  assert.equal(upstreamByteLength(upstream({}, 206), 12), null);
  console.log('OK Workers HTTP download lengths: cache miss, cache hit, range, HEAD, zero-byte file and AirDrop');
} finally {
  await worker.dispose();
}
