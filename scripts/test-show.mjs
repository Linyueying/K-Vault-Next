import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRequestGet as viewShow } from '../functions/api/show.js';
import { onRequestGet as listShow, onRequestPost as updateShow } from '../functions/api/manage/show.js';
import {
  onRequestGet as getSettings,
  onRequestPost as saveSettings,
  onRequestDelete as resetSettings,
} from '../functions/api/manage/settings.js';
import { onRequest as manageMiddleware } from '../functions/api/manage/_middleware.js';
import { CONFIG_GROUPS, SHOW_STYLES, invalidateRuntimeConfigCache } from '../functions/utils/runtime-config.js';
import { makeMigratedEnv } from './test-utils.mjs';

const origin = 'https://example.test';

function request(path, body, admin = false, headers = {}, method) {
  return new Request(origin + path, {
    method: method || (body ? 'POST' : 'GET'),
    body: body ? JSON.stringify(body) : undefined,
    headers: { ...(admin ? { Authorization: 'Basic ' + btoa('test:test') } : {}), ...headers },
  });
}

test('Show only exposes curated media and rechecks file restrictions after publishing', async (t) => {
  const { _db, DB } = makeMigratedEnv();
  t.after(() => _db.close());
  DB.batch = async statements => Promise.all(statements.map(statement => statement.run()));
  const legacyFile = { fileName: '旧作品.webm' };
  const env = {
    DB, BASIC_USER: 'test', BASIC_PASS: 'test', DISABLE_RATE_LIMIT: 'true',
    img_url: { async getWithMetadata(key) { return key === 's3:legacy.webm' ? { metadata: legacyFile } : null; } },
  };
  const insertFile = _db.prepare(
    `INSERT INTO files (id, kv_key, storage, file_name, uploaded_at, share_password_hash)
     VALUES (?, ?, 'r2', ?, ?, ?)`
  );
  insertFile.run('photo.png', 'r2:photo.png', '山间.png', Date.now(), null);
  insertFile.run('private.png', 'r2:private.png', '私人.png', Date.now(), 'secret');
  insertFile.run('document.txt', 'r2:document.txt', '说明.txt', Date.now(), null);

  const publish = { action: 'publish', keys: ['r2:photo.png', 's3:legacy.webm', 'r2:private.png', 'r2:document.txt'] };
  const tagged = {
    action: 'publish', tag: ' ＃ 山间  周末 ',
    entries: publish.keys.map(key => ({ key, title: key === 'r2:photo.png' ? '新的展示名称' : '' })),
  };
  const manage = (body, { admin = true, headers } = {}) => {
    const context = { env, data: {}, request: request('/api/manage/show', body, admin, headers) };
    context.next = () => (body ? updateShow(context) : listShow(context));
    return manageMiddleware[1](context);
  };
  const read = async (suffix = '') => {
    const response = await viewShow({ env, request: request('/api/show' + suffix) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    return response.json();
  };

  assert.deepEqual((await read()).items, []);
  assert.equal((await manage(publish, { admin: false })).status, 401);
  assert.equal((await manage(publish, { headers: { Origin: 'https://other.test' } })).status, 403);
  assert.deepEqual(await (await manage(tagged)).json(), { added: 2, existing: 0, rejected: 2 });
  assert.deepEqual(await (await manage(publish)).json(), { added: 0, existing: 2, rejected: 2 });

  const { items, settings } = await read();
  assert.equal(settings.style, 'journal');
  assert.equal(settings.enabled, true);
  assert.deepEqual(items.map(item => item.kind), ['video', 'image']);
  assert.deepEqual(items.map(item => item.tag), ['山间 周末', '山间 周末']);
  assert.deepEqual(items.map(item => item.src), ['/file/s3%3Alegacy.webm', '/file/r2%3Aphoto.png']);
  assert.ok(items.every(item => !Object.hasOwn(item, 'fileKey')));
  const photo = items[1];
  assert.equal(photo.title, '新的展示名称');
  assert.equal((await manage({ action: 'edit', id: photo.id, title: ' 山里 ', caption: '清晨。' })).status, 200);
  assert.equal((await read()).items[1].title, '山里');
  assert.equal((await read()).items[1].tag, '山间 周末');
  assert.equal((await (await manage({ action: 'edit', id: photo.id, title: '山里', tag: '清晨' })).json()).tag, '清晨');

  _db.prepare("UPDATE files SET share_max_downloads = 1 WHERE id = 'photo.png'").run();
  assert.deepEqual((await read()).items.map(item => item.kind), ['video']);
  const managed = (await (await manage()).json()).items;
  assert.equal(managed.find(item => item.id === photo.id).kind, null);
  assert.equal((await manage({ action: 'remove', id: photo.id })).status, 200);
  assert.ok(_db.prepare("SELECT 1 FROM files WHERE id = 'photo.png'").get());
  assert.ok(!(await (await manage()).json()).items.some(item => item.id === photo.id));
});

test('Show runtime settings validate, persist to KV, control /api/show, and reset cleanly', async (t) => {
  invalidateRuntimeConfigCache('show');
  assert.ok(CONFIG_GROUPS.includes('show'));
  assert.deepEqual(SHOW_STYLES, ['journal', 'gallery', 'filmstrip']);

  const { _db, DB } = makeMigratedEnv();
  t.after(() => {
    invalidateRuntimeConfigCache('show');
    _db.close();
  });
  const kvStore = new Map();
  const env = {
    DB,
    BASIC_USER: 'test',
    BASIC_PASS: 'test',
    DISABLE_RATE_LIMIT: 'true',
    img_url: {
      async get(key, opts) {
        if (!kvStore.has(key)) return null;
        const raw = kvStore.get(key);
        return (opts === 'json' || opts?.type === 'json') ? JSON.parse(raw) : raw;
      },
      async put(key, val) { kvStore.set(key, String(val)); },
      async delete(key) { kvStore.delete(key); },
      async getWithMetadata() { return null; },
    },
  };

  for (let i = 1; i <= 8; i += 1) {
    _db.prepare(
      `INSERT INTO files (id, kv_key, storage, file_name, uploaded_at) VALUES (?, ?, 'r2', ?, ?)`
    ).run(`p${i}.jpg`, `r2:p${i}.jpg`, `作品${i}.jpg`, Date.now());
    _db.prepare(
      `INSERT INTO show_entries (file_key, published_at, title, tag) VALUES (?, ?, ?, ?)`
    ).run(`r2:p${i}.jpg`, Date.now(), `作品 ${i}`, i <= 4 ? '山海' : '夜色');
  }

  // 默认配置读取
  const initialRes = await getSettings({ env, request: request('/api/manage/settings', null, true) });
  assert.equal(initialRes.status, 200);
  const initial = await initialRes.json();
  assert.equal(initial.show.style, 'journal');
  assert.equal(initial.show.source, 'env');
  assert.equal(initial.show.pageSize, 12);

  // 校验拒绝非法样式与越界 pageSize
  const badStyle = await saveSettings({
    env,
    request: request('/api/manage/settings', { show: { style: 'unknown' } }, true),
  });
  assert.equal(badStyle.status, 400);
  const badSize = await saveSettings({
    env,
    request: request('/api/manage/settings', { show: { pageSize: 3 } }, true),
  });
  assert.equal(badSize.status, 400);

  // 保存为 gallery 样式 + 每页 6 条 + 允许下载
  const savedRes = await saveSettings({
    env,
    request: request('/api/manage/settings', {
      show: {
        enabled: true,
        style: 'gallery',
        title: '暗房展厅',
        eyebrow: 'EXHIBITION',
        intro: '精选影像作品。',
        pageSize: 6,
        showShareButton: false,
        showTagFilter: true,
        showCaptions: false,
        allowDownload: true,
      },
    }, true),
  });
  assert.equal(savedRes.status, 200);
  const saved = await savedRes.json();
  assert.equal(saved.show.source, 'kv');
  assert.equal(saved.show.style, 'gallery');
  assert.equal(saved.show.title, '暗房展厅');
  assert.equal(saved.show.allowDownload, true);

  // /api/show 立刻反映新样式、分页数与开关
  const pubRes = await viewShow({ env, request: request('/api/show') });
  assert.equal(pubRes.status, 200);
  const pub = await pubRes.json();
  assert.equal(pub.settings.style, 'gallery');
  assert.equal(pub.settings.title, '暗房展厅');
  assert.equal(pub.settings.showShareButton, false);
  assert.equal(pub.settings.showCaptions, false);
  assert.equal(pub.settings.allowDownload, true);
  assert.equal(pub.items.length, 6);
  assert.ok(pub.next !== null);

  // 关闭 Show 时 /api/show 返回 disabled: true 且不暴露作品
  await saveSettings({
    env,
    request: request('/api/manage/settings', { show: { enabled: false, style: 'filmstrip' } }, true),
  });
  const disabledPub = await (await viewShow({ env, request: request('/api/show') })).json();
  assert.equal(disabledPub.disabled, true);
  assert.deepEqual(disabledPub.items, []);
  assert.equal(disabledPub.settings.style, 'filmstrip');

  // 重置恢复默认
  const resetRes = await resetSettings({
    env,
    request: request('/api/manage/settings?group=show', null, true, {}, 'DELETE'),
  });
  assert.equal(resetRes.status, 200);
  const reset = await resetRes.json();
  assert.equal(reset.show.source, 'env');
  assert.equal(reset.show.style, 'journal');
  assert.equal(reset.show.enabled, true);
  assert.equal(reset.show.pageSize, 12);
});
