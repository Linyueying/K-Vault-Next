import assert from 'node:assert/strict';
import { onRequest as dav } from '../functions/dav/[[path]].js';
import { onRequestGet, onRequestPut } from '../functions/api/manage/webdav-root.js';
import { onRequestDelete as deleteFolder } from '../functions/api/manage/folders.js';
import { upsertFolderMarker, moveFolderTree } from '../functions/utils/metadata-d1.js';
import { makeMigratedEnv } from './test-utils.mjs';

const origin = 'https://vault.example';
const auth = 'Basic ' + btoa('backup:example-password');
const env = makeMigratedEnv();
const objects = new Map();
let beforePut;
env.WEBDAV_SERVER_ENABLED = 'true';
env.WEBDAV_SERVER_USERNAME = 'backup';
env.WEBDAV_SERVER_PASSWORD = 'example-password';
env.WEBDAV_SERVER_BACKEND = 'r2';
env.img_url = {
  async get() { return null; },
  async getWithMetadata() { return { value: null, metadata: null }; },
  async put() {},
  async delete() {},
};
env.R2_BUCKET = {
  async put(key, bytes) {
    if (beforePut) await beforePut();
    objects.set(key, bytes);
  },
  async get(key) {
    const bytes = objects.get(key);
    if (!bytes) return null;
    return {
      size: bytes.byteLength, httpMetadata: { contentType: 'text/plain' },
      arrayBuffer: async () => bytes, body: new Response(bytes).body,
    };
  },
  async delete(key) { objects.delete(key); },
};

function request(method, path, options = {}) {
  return new Request(origin + path, {
    method, body: options.body, headers: { Authorization: auth, ...options.headers },
  });
}
function call(method, path, options) {
  return dav({ request: request(method, path, options), env });
}
async function expectStatus(promise, status) {
  const response = await promise;
  assert.equal(response.status, status, await response.clone().text());
  return response;
}
async function select(rootPath, status = 200) {
  const response = await expectStatus(onRequestPut({
    request: request('PUT', '/api/manage/webdav-root', { body: JSON.stringify({ rootPath }) }),
    env,
  }), status);
  return response.json();
}
async function mkdir(path) {
  assert.equal((await upsertFolderMarker(env, path)).ok, true);
}
async function removeFolder(path, recursive = false) {
  await expectStatus(deleteFolder({
    request: request('DELETE', '/api/manage/folders?' + new URLSearchParams({ path, recursive: recursive ? '1' : '0' })),
    env,
  }), 200);
}

const root = '备份';
await mkdir(root);
await mkdir('普通文件');
const rootView = await expectStatus(call('PROPFIND', '/dav/'), 207);
assert.match(await rootView.text(), new RegExp(encodeURIComponent('普通文件')));
assert.equal((await select(root)).status, 'ready');
assert.ok((await select('不存在', 409)).error);
await expectStatus(call('PROPFIND', '/dav/', { headers: { Authorization: '' } }), 401);
await expectStatus(call('MKCOL', '/dav/phone'), 201);
await expectStatus(call('PUT', '/dav/missing/item.txt', { body: 'new' }), 409);
await expectStatus(call('PUT', '/dav/phone/file%23%20%25.txt', { body: 'backup content' }), 201);
const items = await expectStatus(call('PROPFIND', '/dav/phone/'), 207);
const xml = await items.text();
assert.match(xml, /<d:href>\/dav\/phone\/file%23%20%25\.txt<\/d:href>/);
assert.doesNotMatch(xml, new RegExp(encodeURIComponent(root)));
const rootItems = await expectStatus(call('PROPFIND', '/dav/'), 207);
assert.doesNotMatch(await rootItems.text(), new RegExp(encodeURIComponent('普通文件')));
await expectStatus(call('DELETE', '/dav/'), 403);
await expectStatus(call('GET', '/dav/'), 404);
await expectStatus(call('MKCOL', '/dav/'), 405);
await expectStatus(call('PROPFIND', '/dav/%2fetc'), 400);
const record = env._db.prepare('SELECT folder_path, file_name FROM files WHERE is_folder = 0').get();
assert.equal(record.folder_path, root + '/phone');
assert.equal(record.file_name, 'file# %.txt');

const source = '/dav/phone/file%23%20%25.txt';
await expectStatus(call('MOVE', source, { headers: { Destination: '/ordinary' } }), 403);
await expectStatus(call('COPY', source, { headers: { Destination: 'https://other.example/dav/copy.txt' } }), 403);
await expectStatus(call('COPY', source, { headers: { Destination: '/dav/copied.txt' } }), 201);
await expectStatus(call('MOVE', source, { headers: { Destination: '/dav/phone/renamed.txt' } }), 201);
await expectStatus(call('GET', source), 404);
assert.equal(await (await expectStatus(call('GET', '/dav/phone/renamed.txt'), 200)).text(), 'backup content');
await expectStatus(call('DELETE', '/dav/copied.txt'), 204);
assert.equal(env._db.prepare("SELECT COUNT(*) AS n FROM files WHERE file_name = 'copied.txt'").get().n, 0);

await removeFolder(root, true);
assert.equal(env._db.prepare("SELECT folder_path FROM files WHERE file_name = 'renamed.txt'").get().folder_path, null);
for (const method of ['OPTIONS', 'PROPFIND', 'GET', 'HEAD', 'PUT', 'DELETE', 'MKCOL', 'MOVE', 'COPY']) {
  await expectStatus(call(method, '/dav/ordinary.txt'), 503);
}
assert.equal((await (await onRequestGet({ env })).json()).status, 'missing');
await mkdir(root);
await expectStatus(call('PROPFIND', '/dav/'), 503);
assert.equal((await select(root)).status, 'ready');
assert.equal((await moveFolderTree(env, root, '改名后的备份')).updatedMarkers, 1);
await expectStatus(call('PROPFIND', '/dav/'), 503);
assert.equal((await select('改名后的备份')).status, 'ready');
const objectCount = objects.size;
beforePut = () => removeFolder('改名后的备份');
await expectStatus(call('PUT', '/dav/interrupted.txt', { body: 'do not register' }), 503);
beforePut = undefined;
assert.equal(objects.size, objectCount);
assert.equal(env._db.prepare("SELECT COUNT(*) AS n FROM files WHERE file_name = 'interrupted.txt'").get().n, 0);
await mkdir('parent');
await mkdir('parent/mount');
await mkdir('Parent/disjoint');
await select('parent/mount');
await removeFolder('parent', true);
assert.equal((await (await onRequestGet({ env })).json()).status, 'missing');
assert.ok(env._db.prepare("SELECT id FROM files WHERE id = 'folder:Parent/disjoint'").get());
assert.equal((await select('')).status, 'library');
await expectStatus(call('PROPFIND', '/dav/'), 207);
env._db.close();
console.log('WebDAV mount lifecycle and DAV operation tests passed.');
