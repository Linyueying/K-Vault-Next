// 用 node:sqlite 模拟 D1，验证 file-record.js 的 D1 优先 + KV 回落行为
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { makeMigratedEnv } from './test-utils.mjs';

// ---- 构造 D1 兼容壳 ----
// 迁移按序全量应用（0001 + 0002 + ...），避免新增迁移后此处 schema 落后
const db = makeMigratedEnv()._db;

function makeD1(db) {
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      let bound = [];
      return {
        bind(...args) { bound = args; return this; },
        async first() {
          const r = stmt.get(...bound);
          return r === undefined ? null : r;
        },
        async all() {
          const rows = stmt.all(...bound);
          return { results: rows };
        },
        async run() {
          const info = stmt.run(...bound);
          return { meta: { changes: info.changes } };
        },
      };
    },
  };
}

// ---- 构造 KV 兼容壳 ----
function makeKV() {
  const store = new Map();
  return {
    async put(k, v, o) { store.set(k, { value: v, metadata: o?.metadata }); },
    async get(k) { const e = store.get(k); return e ? e.value : null; },
    async getWithMetadata(k) { const e = store.get(k); return e ? { value: e.value, metadata: e.metadata } : null; },
    async delete(k) { store.delete(k); },
    async list() { return { keys: [...store.keys()].map(n => ({ name: n })), list_complete: true }; },
    _store: store,
  };
}

const { getRecordWithKey, registerFileRecord, readDownloadCount, incrementDownloadCount, consumeDownloadQuota } =
  await import('/workspace/K-Vault-Next/functions/utils/file-record.js');

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name); } }

// ===== 场景 1：D1 已绑定，记录在 D1 =====
console.log('\n[场景1] D1 已绑定，记录在 D1');
{
  const env = { DB: makeD1(db), img_url: makeKV() };
  await registerFileRecord(env, 'r2:abc.png', { fileName: 'abc.png', fileSize: 100, storageType: 'r2', TimeStamp: 1000, r2Key: 'abc.png' });
  const r = await getRecordWithKey(env, 'r2:abc.png');
  check('D1 命中，返回 record', !!r.record?.metadata);
  check('fileName 正确', r.record?.metadata?.fileName === 'abc.png');
  check('kvKey 正确', r.kvKey === 'r2:abc.png');
  check('r2Key 还原', r.record?.metadata?.r2Key === 'abc.png');
}

// ===== 场景 2：裸 ID 查 D1 =====
console.log('\n[场景2] 用裸 ID 查（D1 主键直达）');
{
  const env = { DB: makeD1(db), img_url: makeKV() };
  const r = await getRecordWithKey(env, 'abc.png');
  check('裸 ID 命中 D1', !!r.record?.metadata);
  check('kvKey 回填为 r2:abc.png', r.kvKey === 'r2:abc.png');
}

// ===== 场景 3：D1 未绑定 → 回落 KV =====
console.log('\n[场景3] D1 未绑定，回落 KV');
{
  const kv = makeKV();
  await kv.put('r2:xyz.png', '', { metadata: { fileName: 'xyz.png', fileSize: 50, storageType: 'r2' } });
  const env = { img_url: kv };   // 无 DB
  const r = await getRecordWithKey(env, 'r2:xyz.png');
  check('KV 命中', r.record?.metadata?.fileName === 'xyz.png');
  const r2 = await getRecordWithKey(env, 'xyz.png');  // 裸 ID 前缀探测
  check('裸 ID 前缀探测命中', r2.record?.metadata?.fileName === 'xyz.png');
}

// ===== 场景 4：D1 miss → 回落 KV（D1 写失败兜底）=====
console.log('\n[场景4] D1 绑定但记录只在 KV（写失败兜底）');
{
  const kv = makeKV();
  await kv.put('s3:only-kv.bin', '', { metadata: { fileName: 'only-kv.bin', storageType: 's3' } });
  const env = { DB: makeD1(db), img_url: kv };
  const r = await getRecordWithKey(env, 's3:only-kv.bin');
  check('D1 miss 后 KV 兜住', r.record?.metadata?.fileName === 'only-kv.bin');
}

// ===== 场景 5：原子计数 =====
console.log('\n[场景5] 原子计数（D1 路径）');
{
  const env = { DB: makeD1(db), img_url: makeKV() };
  await registerFileRecord(env, 'r2:cnt.png', { fileName: 'cnt.png', storageType: 'r2', TimeStamp: 2000, shareMaxDownloads: 2 });
  const c1 = await consumeDownloadQuota(env, 'r2:cnt.png');
  const c2 = await consumeDownloadQuota(env, 'r2:cnt.png');
  const c3 = await consumeDownloadQuota(env, 'r2:cnt.png');
  check('第1次消费成功', c1.ok === true);
  check('第2次消费成功', c2.ok === true);
  check('第3次被拒（超限）', c3.ok === false && c3.limited === true);
  const n = await readDownloadCount(env, 'r2:cnt.png');
  check('计数停在 2（未超发）', n === 2);
}

// ===== 场景 6：putRecordIndex 变 no-op =====
console.log('\n[场景6] putRecordIndex 兼容 no-op');
{
  const env = { DB: makeD1(db), img_url: makeKV() };
  const { putRecordIndex, deleteRecordIndex, deleteDownloadCount } = await import('/workspace/K-Vault-Next/functions/utils/file-record.js');
  await putRecordIndex(env, 'r2:whatever.png');           // 无 metadata → no-op
  await deleteRecordIndex(env, 'r2:whatever.png');        // no-op
  await deleteDownloadCount(env, 'r2:whatever.png');      // D1 模式 no-op
  check('三个兼容函数均不抛错', true);
}

// ===== 场景 7：putRecordIndex 带 metadata 时顺手写 D1 =====
console.log('\n[场景7] putRecordIndex 传 metadata → 写 D1');
{
  const env = { DB: makeD1(db), img_url: makeKV() };
  const { putRecordIndex } = await import('/workspace/K-Vault-Next/functions/utils/file-record.js');
  await putRecordIndex(env, 'r2:viaput.png', { metadata: { fileName: 'viaput.png', storageType: 'r2', TimeStamp: 3000 } });
  const r = await getRecordWithKey(env, 'r2:viaput.png');
  check('通过 putRecordIndex 写入 D1 成功', r.record?.metadata?.fileName === 'viaput.png');
}

// ===== 场景 8：metadata 缺 storageKey 字段 → 从 kvKey 兜底推导 =====
console.log('\n[场景8] metadata 无 r2Key，从 kvKey 兜底推导');
{
  const env = { DB: makeD1(db), img_url: makeKV() };
  await registerFileRecord(env, 'r2:fallback.png', { fileName: 'fallback.png', storageType: 'r2', TimeStamp: 4000 });
  const r = await getRecordWithKey(env, 'r2:fallback.png');
  check('storage_key 从 kvKey 推导成功', r.record?.metadata?.r2Key === 'fallback.png');
}

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
