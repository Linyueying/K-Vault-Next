#!/usr/bin/env node
/**
 * 密码库同步端到端测试（第一性原理回归测试）
 *
 * 覆盖：
 *   1. VaultCore.mergeVaultDocs 确定性 LWW + 墓碑 + 历史密码并集合并
 *   2. /api/manage/vault + vault-store.js 的 D1 原子 CAS（0 → 1 → 2 → 409 冲突 → 3）
 *   3. Device A / Device B 并发编辑离线收敛（零丢记录）
 *   4. 旧版 kvault-vault-v1 粘贴（即使埋在 60+ 普通粘贴之后）零损自动迁移
 *   5. D1 写入失败绝不静默返回 200/201（同步失败必报错）
 *   6. 主密码在 Device A 变更后，Device B 收到 reauth_required 且不覆盖云端
 *   7. 纯 KV 兜底模式（无 D1）下的双端同步与冲突合并
 *
 * 运行：node scripts/test-vault-sync.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { onRequestGet, onRequestPut, onRequestDelete } from '../functions/api/manage/vault.js';
import { resetSchemaCache } from '../functions/utils/schema.js';
import { createPaste } from '../functions/utils/paste-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

/* ---------- 加载浏览器端 IIFE 模块（vault-core.js + vault-sync.js） ---------- */
function loadClientModules() {
  const sandbox = {
    crypto: globalThis.crypto,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
    URL: globalThis.URL,
    Date: Date,
    Math: Math,
    JSON: JSON,
    Promise: Promise,
    Array: Array,
    Object: Object,
    Number: Number,
    String: String,
    Boolean: Boolean,
    Error: Error,
    RegExp: RegExp,
    Uint8Array: Uint8Array,
    Uint32Array: Uint32Array,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(REPO, 'assets/js/vault-core.js'), 'utf8'), sandbox, { filename: 'vault-core.js' });
  vm.runInContext(fs.readFileSync(path.join(REPO, 'assets/js/vault-sync.js'), 'utf8'), sandbox, { filename: 'vault-sync.js' });
  return { VaultCore: sandbox.VaultCore, VaultSync: sandbox.VaultSync };
}

function createMemoryStorage() {
  const map = new Map();
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
  };
}

/* ---------- 轻量内存 KV Mock ---------- */
function createMockKv() {
  const store = new Map();
  return {
    async get(key, opts) {
      const entry = store.get(key);
      if (!entry) return null;
      if (opts && opts.type === 'json') return JSON.parse(entry.value);
      return entry.value;
    },
    async put(key, value, opts = {}) {
      store.set(key, { value: String(value), metadata: opts.metadata || {} });
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      const all = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([name, entry]) => ({ name, metadata: entry.metadata }));
      const start = cursor ? Number(cursor) : 0;
      const slice = all.slice(start, start + limit);
      const next = start + limit < all.length ? String(start + limit) : undefined;
      return { keys: slice, list_complete: !next, cursor: next };
    },
    _store: store,
  };
}

/* ---------- 轻量内存 D1 Mock（支持 vault_records + pastes + schema_migrations） ---------- */
function createMockD1({ failWrites = false } = {}) {
  const migrations = new Set();
  const vaultRows = new Map();
  const pasteRows = new Map();

  function prepare(sql) {
    const clean = sql.replace(/\s+/g, ' ').trim();
    let params = [];
    const stmt = {
      bind(...args) { params = args; return stmt; },
      async first() {
        if (/SELECT\s+version.*FROM\s+schema_migrations/i.test(clean)) return null;
        if (/SELECT\s+.*FROM\s+vault_records\s+WHERE\s+vault_key\s*=\s*\?/i.test(clean)) {
          return vaultRows.get(params[0]) || null;
        }
        if (/SELECT\s+1\s+AS\s+x\s+FROM\s+pastes/i.test(clean)) {
          return pasteRows.has(params[0]) ? { x: 1 } : null;
        }
        return null;
      },
      async all() {
        if (/SELECT\s+version.*FROM\s+schema_migrations/i.test(clean)) {
          return { results: [...migrations].map((v) => ({ version: v })) };
        }
        if (/PRAGMA\s+table_info/i.test(clean)) {
          return { results: [{ name: 'is_folder' }, { name: 'file_type' }, { name: 'share_title' }, { name: 'share_description' }, { name: 'title' }, { name: 'description' }, { name: 'files_json' }, { name: 'sender_ip' }, { name: 'tag' }, { name: 'trashed_at' }] };
        }
        if (/SELECT\s+paste_id,\s*content,\s*created_at\s+FROM\s+pastes\s+WHERE\s+language\s*=\s*\?/i.test(clean)) {
          const [lang, nowTs] = params;
          const results = [...pasteRows.values()]
            .filter((r) => r.language === lang && (r.expires_at === 0 || r.expires_at > nowTs))
            .sort((a, b) => b.created_at - a.created_at);
          return { results };
        }
        return { results: [] };
      },
      async run() {
        if (/CREATE\s+TABLE|CREATE\s+INDEX|CREATE\s+UNIQUE\s+INDEX|ALTER\s+TABLE|DROP\s+INDEX/i.test(clean)) {
          return { meta: { changes: 0 } };
        }
        if (/INSERT\s+OR\s+IGNORE\s+INTO\s+schema_migrations/i.test(clean)) {
          migrations.add(params[0]);
          return { meta: { changes: 1 } };
        }
        if (failWrites && /INSERT|UPDATE|DELETE/i.test(clean)) {
          throw new Error('Simulated D1 write outage');
        }
        if (/INSERT\s+OR\s+IGNORE\s+INTO\s+vault_records/i.test(clean)) {
          const hasExplicitRev = /VALUES\s*\(\?,\s*1,/i.test(clean);
          const key = params[0];
          if (vaultRows.has(key)) return { meta: { changes: 0 } };
          if (hasExplicitRev) {
            vaultRows.set(key, {
              vault_key: key, revision: 1, envelope: params[1],
              updated_at: params[2], updated_by: params[3], byte_size: params[4],
            });
          } else {
            vaultRows.set(key, {
              vault_key: key, revision: params[1], envelope: params[2],
              updated_at: params[3], updated_by: params[4], byte_size: params[5],
            });
          }
          return { meta: { changes: 1 } };
        }
        if (/INSERT\s+INTO\s+vault_records.*ON\s+CONFLICT/i.test(clean)) {
          const [key, envelope, updated_at, updated_by, byte_size] = params;
          const prev = vaultRows.get(key);
          vaultRows.set(key, {
            vault_key: key,
            revision: prev ? prev.revision + 1 : 1,
            envelope, updated_at, updated_by, byte_size,
          });
          return { meta: { changes: 1 } };
        }
        if (/UPDATE\s+vault_records\s+SET\s+revision\s*=\s*revision\s*\+\s*1/i.test(clean)) {
          const [envelope, updated_at, updated_by, byte_size, key, expected] = params;
          const prev = vaultRows.get(key);
          if (!prev || prev.revision !== expected) return { meta: { changes: 0 } };
          vaultRows.set(key, {
            vault_key: key,
            revision: prev.revision + 1,
            envelope, updated_at, updated_by, byte_size,
          });
          return { meta: { changes: 1 } };
        }
        if (/DELETE\s+FROM\s+vault_records/i.test(clean)) {
          const existed = vaultRows.delete(params[0]);
          return { meta: { changes: existed ? 1 : 0 } };
        }
        if (/INSERT\s+INTO\s+pastes/i.test(clean)) {
          const [paste_id, content, language, size, password_hash, password_salt, expires_at, created_at] = params;
          pasteRows.set(paste_id, { paste_id, content, language, size, password_hash, password_salt, expires_at, created_at });
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
    };
    return stmt;
  }

  return { prepare, _vaultRows: vaultRows, _pasteRows: pasteRows };
}

function createVaultFetch(env) {
  return async (url, init = {}) => {
    const fullUrl = url.startsWith('http') ? url : new URL(url.replace(/^\.\//, '/'), 'https://vault.test').toString();
    const req = new Request(fullUrl, {
      method: init.method || 'GET',
      headers: init.headers,
      body: init.body,
    });
    const method = req.method.toUpperCase();
    if (method === 'GET') return onRequestGet({ request: req, env });
    if (method === 'PUT') return onRequestPut({ request: req, env });
    if (method === 'DELETE') return onRequestDelete({ request: req, env });
    throw new Error('Unexpected method: ' + method);
  };
}

function makeDoc(items = [], extra = {}) {
  return {
    schema: 1,
    vaultId: 'v-main',
    createdAt: 1000,
    updatedAt: 2000,
    settings: { autoLockMinutes: 15, passwordHistoryLimit: 5 },
    folders: [],
    deletedFolders: [],
    items,
    deleted: [],
    purged: [],
    ...extra,
  };
}

async function run() {
  const { VaultCore, VaultSync } = loadClientModules();
  const FAST_ITERS = 1000; // 单测加速

  // 1) 纯函数多端合并测试
  {
    const docA = makeDoc(
      [
        { id: '1', type: 'login', name: 'GitHub A', updatedAt: 200, login: { username: 'a', password: 'new', totp: '', uris: [] }, passwordHistory: [{ password: 'old1', updatedAt: 100 }] },
        { id: '2', type: 'login', name: 'Only A', updatedAt: 300, login: { username: 'a2', password: 'p2', totp: '', uris: [] }, passwordHistory: [] },
        { id: '3', type: 'login', name: 'Will Trash', updatedAt: 100, login: { username: 'u3', password: 'p3', totp: '', uris: [] }, passwordHistory: [] },
      ],
      { folders: [{ id: 'f1', name: 'Work', createdAt: 10, updatedAt: 10 }] }
    );
    const docB = makeDoc(
      [
        { id: '1', type: 'login', name: 'GitHub B', updatedAt: 150, login: { username: 'b', password: 'mid', totp: '', uris: [] }, passwordHistory: [{ password: 'old2', updatedAt: 90 }] },
        { id: '4', type: 'login', name: 'Only B', updatedAt: 310, folderId: 'f1', login: { username: 'b4', password: 'p4', totp: '', uris: [] }, passwordHistory: [] },
      ],
      {
        deleted: [{ id: '3', type: 'login', name: 'Will Trash', updatedAt: 250, deletedAt: 250, login: { username: 'u3', password: 'p3', totp: '', uris: [] }, passwordHistory: [] }],
        deletedFolders: [{ id: 'f1', deletedAt: 500 }],
      }
    );

    const merged = VaultCore.mergeVaultDocs(docA, docB);
    const ids = Array.from(merged.items, (x) => x.id).sort();
    assert.deepEqual(ids, ['1', '2', '4'], '并发新增条目必须全部保留，较新回收站删除生效');
    assert.equal(merged.items.find((x) => x.id === '1').name, 'GitHub A', '同条目取 updatedAt 较新者');
    assert.equal(merged.items.find((x) => x.id === '1').passwordHistory.length, 2, 'passwordHistory 取去重并集');
    assert.equal(merged.deleted.length, 1);
    assert.equal(merged.deleted[0].id, '3');
    assert.equal(merged.folders.length, 0, '较新文件夹墓碑生效');
    assert.equal(merged.items.find((x) => x.id === '4').folderId, null, '已删除文件夹的悬空引用应归零');
    console.log('[OK] 1. mergeVaultDocs 并发增删改与墓碑合并通过');
  }

  // 2) Device A & Device B 端到端 D1 CAS 同步 + 409 冲突自动合并
  {
    resetSchemaCache();
    const env = { DB: createMockD1(), img_url: createMockKv() };
    const fetchImpl = createVaultFetch(env);
    const devA = VaultSync.createClient({ endpoint: './api/manage/vault', storage: createMemoryStorage(), fetchImpl, core: VaultCore, deviceId: 'device-A' });
    const devB = VaultSync.createClient({ endpoint: './api/manage/vault', storage: createMemoryStorage(), fetchImpl, core: VaultCore, deviceId: 'device-B' });

    const baseDoc = makeDoc([{ id: 'init', type: 'login', name: 'Initial', createdAt: 100, updatedAt: 100, login: { username: 'u', password: 'p', totp: '', uris: [] }, passwordHistory: [] }]);
    const sealed = await VaultCore.sealVault(baseDoc, 'MasterPass!2026', FAST_ITERS);

    // Device A 建库推送 → v1
    const r1 = await devA.sync({ doc: baseDoc, key: sealed.key, kdf: sealed.kdf, revision: 0, hasLocalChanges: true });
    assert.equal(r1.action, 'pushed');
    assert.equal(r1.revision, 1);

    // Device B 全新打开拉取 v1 并解锁
    const pulledB = await devB.pull({ metaOnly: false });
    assert.equal(pulledB.exists, true);
    assert.equal(pulledB.revision, 1);
    const openedB = await VaultCore.openVault('MasterPass!2026', pulledB.envelope);
    assert.equal(openedB.doc.items.length, 1);
    assert.equal(openedB.doc.items[0].name, 'Initial');

    // Device A 新增条目 A → 推送 v2
    const docA2 = structuredClone(baseDoc);
    docA2.items.unshift({ id: 'from-A', type: 'login', name: 'From A', createdAt: 200, updatedAt: 200, login: { username: 'ua', password: 'pa', totp: '', uris: [] }, passwordHistory: [] });
    const r2 = await devA.sync({ doc: docA2, key: sealed.key, kdf: sealed.kdf, revision: 1, hasLocalChanges: true });
    assert.equal(r2.action, 'pushed');
    assert.equal(r2.revision, 2);

    // Device B 仍在旧版本 v1 时新增条目 B → 触发 409 → 自动解密合并 → 推进至 v3（双端条目均在！）
    const docB2 = structuredClone(openedB.doc);
    docB2.items.unshift({ id: 'from-B', type: 'login', name: 'From B', createdAt: 210, updatedAt: 210, login: { username: 'ub', password: 'pb', totp: '', uris: [] }, passwordHistory: [] });
    const r3 = await devB.sync({ doc: docB2, key: openedB.key, kdf: openedB.kdf, revision: 1, hasLocalChanges: true });
    assert.equal(r3.action, 'merged');
    assert.equal(r3.revision, 3);
    assert.deepEqual(Array.from(r3.doc.items, (x) => x.id).sort(), ['from-A', 'from-B', 'init']);

    // Device A 静默拉取 → 从 v2 自动收敛到 v3，立刻看到 Device B 新增的条目
    const r4 = await devA.sync({ doc: docA2, key: sealed.key, kdf: sealed.kdf, revision: 2, hasLocalChanges: false });
    assert.equal(r4.action, 'pulled');
    assert.equal(r4.revision, 3);
    assert.deepEqual(Array.from(r4.doc.items, (x) => x.id).sort(), ['from-A', 'from-B', 'init']);

    // 再次检查无变更 → noop
    const r5 = await devA.sync({ doc: r4.doc, key: sealed.key, kdf: sealed.kdf, revision: 3, hasLocalChanges: false });
    assert.equal(r5.action, 'noop');
    console.log('[OK] 2. D1 双端 CAS 同步与 409 冲突无损收敛通过');

    // 3) 主密码在 Device A 变更后，Device B 拉取返回 reauth_required 且不覆盖云端
    const reSealed = await VaultCore.sealVault(r4.doc, 'NewMasterPass!999', FAST_ITERS);
    const r6 = await devA.sync({ doc: r4.doc, key: reSealed.key, kdf: reSealed.kdf, revision: 3, hasLocalChanges: true, force: true });
    assert.equal(r6.action, 'pushed');
    assert.equal(r6.revision, 4);

    const r7 = await devB.sync({ doc: r3.doc, key: openedB.key, kdf: openedB.kdf, revision: 3, hasLocalChanges: false });
    assert.equal(r7.action, 'reauth_required');
    assert.equal(r7.revision, 4);
    console.log('[OK] 3. 主密码变更触发另一端安全重新解锁通过');
  }

  // 4) 旧版 kvault-vault-v1 粘贴（即使埋在 60 条普通粘贴之后）自动零损迁移
  {
    resetSchemaCache();
    const kv = createMockKv();
    const env = { DB: createMockD1(), img_url: kv };
    const legacyDoc = makeDoc([{ id: 'legacy-1', type: 'login', name: 'Legacy Bank', createdAt: 50, updatedAt: 50, login: { username: 'old', password: 'pw', totp: '', uris: [] }, passwordHistory: [] }]);
    const sealed = await VaultCore.sealVault(legacyDoc, 'LegacyPass!123', FAST_ITERS);
    // 写入旧版 KV paste + 60 条普通 paste 干扰项
    await kv.put('paste:oldvault01', JSON.stringify({ id: 'oldvault01', content: JSON.stringify(sealed.envelope), language: 'kvault-vault-v1', createdAt: 1000 }), { metadata: { id: 'oldvault01', language: 'kvault-vault-v1', createdAt: 1000 } });
    for (let i = 0; i < 60; i += 1) {
      await kv.put('paste:noise' + i, JSON.stringify({ id: 'noise' + i, content: 'hello ' + i, language: 'text', createdAt: 2000 + i }), { metadata: { id: 'noise' + i, language: 'text', createdAt: 2000 + i } });
    }

    const fetchImpl = createVaultFetch(env);
    const devB = VaultSync.createClient({ endpoint: './api/manage/vault', storage: createMemoryStorage(), fetchImpl, core: VaultCore, deviceId: 'device-B' });
    const migrated = await devB.pull({ metaOnly: false });
    assert.equal(migrated.exists, true);
    assert.equal(migrated.revision, 1);
    const opened = await VaultCore.openVault('LegacyPass!123', migrated.envelope);
    assert.equal(opened.doc.items[0].name, 'Legacy Bank');
    assert.equal(env.DB._vaultRows.has('default'), true, '应已迁移落入规范表 vault_records');
    console.log('[OK] 4. 旧版 Pastebin 密码库自动发现与零损迁移通过');
  }

  // 5) D1 写入失败绝不假报成功（vault-store 与 paste-store 均必抛错）
  {
    resetSchemaCache();
    const failEnv = { DB: createMockD1({ failWrites: true }), img_url: createMockKv() };
    const fetchImpl = createVaultFetch(failEnv);
    const devA = VaultSync.createClient({ endpoint: './api/manage/vault', storage: createMemoryStorage(), fetchImpl, core: VaultCore });
    const doc = makeDoc([]);
    const sealed = await VaultCore.sealVault(doc, 'MasterPass!2026', FAST_ITERS);

    await assert.rejects(
      () => devA.sync({ doc, key: sealed.key, kdf: sealed.kdf, revision: 0, hasLocalChanges: true }),
      /Simulated D1 write outage/,
      'D1 写失败必须向上抛错，绝不能显示同步成功'
    );
    await assert.rejects(
      () => createPaste({ content: 'test', language: 'text' }, failEnv),
      /Simulated D1 write outage/,
      'paste-store D1 写失败同样必须抛错'
    );
    console.log('[OK] 5. D1 写入失败诚实报错（杜绝假同步成功）通过');
  }

  // 6) 纯 KV 兜底模式（未绑定 D1）双端同步与冲突合并
  {
    resetSchemaCache();
    const kvEnv = { img_url: createMockKv() };
    const fetchImpl = createVaultFetch(kvEnv);
    const devA = VaultSync.createClient({ endpoint: './api/manage/vault', storage: createMemoryStorage(), fetchImpl, core: VaultCore, deviceId: 'kv-A' });
    const devB = VaultSync.createClient({ endpoint: './api/manage/vault', storage: createMemoryStorage(), fetchImpl, core: VaultCore, deviceId: 'kv-B' });

    const doc = makeDoc([{ id: 'k1', type: 'note', name: 'KV Note', createdAt: 10, updatedAt: 10, note: {}, passwordHistory: [] }]);
    const sealed = await VaultCore.sealVault(doc, 'KvOnlyPass!2026', FAST_ITERS);
    const r1 = await devA.sync({ doc, key: sealed.key, kdf: sealed.kdf, revision: 0, hasLocalChanges: true });
    assert.equal(r1.revision, 1);

    const pB = await devB.pull({ metaOnly: false });
    assert.equal(pB.exists, true);
    assert.equal(pB.revision, 1);
    const openedB = await VaultCore.openVault('KvOnlyPass!2026', pB.envelope);
    assert.equal(openedB.doc.items[0].name, 'KV Note');
    console.log('[OK] 6. 纯 KV 兜底模式双端同步通过');
  }

  console.log('\n全部密码库同步回归测试通过（6/6）！');
}

run().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
