import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRequestGet, onRequestPost } from '../functions/api/manage/trash.js';
import { onRequest as authMiddleware } from '../functions/api/manage/_middleware.js';
import { onRequest as download } from '../functions/file/[[path]].js';
import { onRequest as shareInfo } from '../functions/api/share-info.js';
import { onRequest as downloadThumb } from '../functions/thumb/[[path]].js';
import { onRequest as hardDelete } from '../functions/api/manage/delete/[id].js';
import { listFilesPage } from '../functions/utils/file-list.js';
import { listRecordsInFolder, registerFileRecord } from '../functions/utils/file-record.js';
import { showFiles } from '../functions/utils/show.js';
import { makeMigratedEnv } from './test-utils.mjs';

const origin = 'https://example.test';

function fakeKv() {
  const records = new Map();
  return {
    records,
    getWithMetadata: async key => records.get(key) || { metadata: null, value: null },
    get: async key => records.get(key)?.value ?? null,
    put: async (key, value, { metadata } = {}) => records.set(key, { metadata, value }),
    delete: async key => records.delete(key),
    list: async ({ prefix = '' } = {}) => ({
      keys: [...records].filter(([key]) => key.startsWith(prefix))
        .map(([name, { metadata }]) => ({ name, metadata })),
      list_complete: true,
    }),
  };
}

function manage(env, body, { loggedIn = true, source = origin, offset = 0 } = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json', Origin: source });
  if (loggedIn) headers.set('Authorization', 'Basic ' + btoa('admin:password'));
  const request = new Request(origin + '/api/manage/trash?offset=' + offset, {
    method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
  });
  const context = { env, request, data: {} };
  context.next = () => (body ? onRequestPost(context) : onRequestGet(context));
  return authMiddleware[0]({ ...context, next: () => authMiddleware[1](context) });
}

function fileRequest(handler, env, id, prefix = '/file/') {
  return handler({ env, request: new Request(origin + prefix + encodeURIComponent(id)), params: { path: id } });
}

test('D1 trash preserves the original row and prevents cached downloads until restored', async t => {
  const { DB, _db } = makeMigratedEnv();
  t.after(() => _db.close());
  const kv = fakeKv();
  let backendDeletes = 0;
  const env = {
    DB, img_url: kv, BASIC_USER: 'admin', BASIC_PASS: 'password', DISABLE_RATE_LIMIT: 'true',
    R2_BUCKET: { async delete() { backendDeletes++; } },
  };
  const id = 'r2:trash-test.png';
  const metadata = {
    fileName: '原始.png', fileSize: 5, TimeStamp: 12345, folderPath: 'photos/archive',
    storageType: 'r2', r2Key: 'trash-test.png', shareSlug: 'original-link', shareTitle: '原始分享', contentSha: 'same-content',
  };
  assert.equal((await registerFileRecord(env, id, metadata)).ok, true);
  _db.prepare("UPDATE files SET share_download_count = 4 WHERE id = 'trash-test.png'").run();
  await kv.put(id, JSON.stringify({ metadata }), { metadata });

  // Simulate cached bytes at a different edge location. The local purge cannot remove them.
  const oldCaches = globalThis.caches;
  globalThis.caches = { default: {
    async match() { return new Response('bytes', { headers: { 'Content-Type': 'image/png' } }); },
    async delete() { return false; },
  } };
  t.after(() => { globalThis.caches = oldCaches; });
  assert.equal((await fileRequest(download, env, id)).headers.get('X-KVault-Byte-Cache'), 'HIT');

  assert.equal((await manage(env, { id, action: 'trash' }, { loggedIn: false })).status, 401);
  assert.equal((await manage(env, { id, action: 'trash' }, { source: 'https://other.test' })).status, 403);
  const moved = await (await manage(env, { id, action: 'trash' })).json();
  const { trashedAt } = moved.entry;
  assert.equal(moved.entry.folderPath, metadata.folderPath);
  assert.equal((await (await manage(env, { id, action: 'trash' })).json()).entry.trashedAt, trashedAt);
  assert.deepEqual((await (await manage(env)).json()).entries, [moved.entry]);
  assert.deepEqual((await listFilesPage(env)).keys, []);
  assert.deepEqual((await listRecordsInFolder(env, metadata.folderPath)).files, []);
  assert.equal((await showFiles(env, [id])).get(id), null);
  assert.equal((await fileRequest(download, env, id)).status, 404);
  assert.equal((await fileRequest(download, env, 'trash-test.png')).status, 404);
  assert.equal((await fileRequest(downloadThumb, env, id, '/thumb/')).status, 404);
  const share = () => shareInfo({ env, request: new Request(origin + '/api/share-info?s=original-link') });
  assert.equal((await share()).status, 404);
  assert.equal((await hardDelete({ env, request: new Request(origin + '/api/manage/delete'), params: { id } })).status, 404);
  assert.equal(backendDeletes, 0);
  assert.equal((await registerFileRecord(env, 'r2:copy.png', {
    ...metadata, fileName: 'copy.png', r2Key: 'copy.png', shareSlug: null,
  })).ok, true);
  assert.equal((await manage(env, { id, action: 'restore', trashedAt: trashedAt + 1 })).status, 409);
  assert.equal((await manage(env, { id, action: 'restore', trashedAt })).status, 200);
  assert.equal((await manage(env, { id, action: 'restore', trashedAt })).status, 200);
  assert.deepEqual((await (await manage(env)).json()).entries, []);
  assert.equal((await listFilesPage(env)).keys.find(key => key.name === id).metadata.folderPath, metadata.folderPath);
  assert.equal((await fileRequest(download, env, id)).status, 200);
  assert.equal((await share()).status, 200);
  const restored = _db.prepare("SELECT * FROM files WHERE id = 'trash-test.png'").get();
  assert.equal(restored.share_download_count, 4);
  assert.equal(restored.share_title, metadata.shareTitle);
  assert.equal(restored.trashed_at, null);
  assert.equal(_db.prepare("SELECT id FROM files WHERE content_sha = 'same-content'").get().id, 'copy.png');
  assert.deepEqual(kv.records.get(id), { value: JSON.stringify({ metadata }), metadata });
});

test('KV-only trash can be restored using the bare ID while preserving the raw payload', async () => {
  const kv = fakeKv();
  const env = { img_url: kv, BASIC_USER: 'admin', BASIC_PASS: 'password', DISABLE_RATE_LIMIT: 'true' };
  const id = 's3:legacy.txt';
  const metadata = { fileName: '遗留文件.txt', TimeStamp: 54321, storageType: 's3', folderPath: 'old/folder' };
  const value = JSON.stringify({ s3Key: 'original-object' });
  await kv.put(id, value, { metadata });

  const moved = await (await manage(env, { id: 'legacy.txt', action: 'trash' })).json();
  assert.equal(moved.success, true);
  assert.equal(moved.entry.id, id);
  assert.equal((await fileRequest(download, env, id)).status, 404);
  assert.deepEqual((await listFilesPage(env)).keys, []);
  assert.deepEqual((await (await manage(env)).json()).entries, [moved.entry]);

  assert.equal((await manage(env, { id, action: 'restore', trashedAt: moved.entry.trashedAt })).status, 200);
  assert.deepEqual(kv.records.get(id), { value, metadata });
  assert.deepEqual((await (await manage(env)).json()).entries, []);
  assert.equal((await listFilesPage(env)).keys[0].name, id);
});
