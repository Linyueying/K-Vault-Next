/**
 * P7 测试：D1 可用时，目录接口不得触碰任何 KV 全表操作。
 *
 * ## 背景
 *
 * `folders.js` 里残留着大量 KV 时代的全表逻辑：`listAllKeys()` 翻遍整个
 * KV 命名空间、`fstat:__index__` 快照的读写失效。D1 分支按理都提前 return
 * 了，但这类"理应走不到"的代码最危险 —— 一次提前 return 被重构掉、一次
 * 判断写反，就会在生产上悄悄开始全表扫描，且**功能完全正常**，
 * 只有 KV 读/写额度在飞速见底。
 *
 * 功能断言抓不到这种回归，所以本套件断言的是**调用次数**：
 *
 *   D1 可用 → kv.list() === 0, fstat: 的 get/put/delete === 0
 *
 * ## 顺带锁住的语义坑
 *
 * `fresh=1` 是"写操作后的校正读"，语义是**不信任快照**。所以它必须
 * **同时**跳过读快照与写快照。只跳读、仍照写的话，等于把此刻正处于
 * KV 传播中的旧状态固化成"新鲜"快照 —— 语义自相矛盾，且会让错误状态
 * 活得更久。这条只在 D1 未绑定的降级态下可观察，因此单独一组用例。
 *
 * 覆盖：
 *   [1] GET 列表（D1 可用）→ 零 KV 全表操作
 *   [2] POST 建目录（D1 可用）→ 零 KV 写
 *   [3] PUT 移动目录（D1 可用）→ 零 KV 全表操作
 *   [4] DELETE 清空目录（D1 可用）→ 零 KV 全表操作
 *   [5] 降级态：fresh=1 不得写回快照
 *
 * 运行：node scripts/test-folder-kv-guard.mjs
 */
import { makeMigratedEnv } from './test-utils.mjs';
import {
  onRequestGet,
  onRequestPost,
  onRequestPut,
  onRequestDelete,
} from '../functions/api/manage/folders.js';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
};

const FSTAT_KEY = 'fstat:__index__';

/**
 * 监控型 KV 替身：记录 list() 调用与对 fstat: 键的读写。
 *
 * `list()` 是重点 —— 它是全表扫描的唯一入口，一次调用就是 N 次 KV 读。
 */
function makeWatchKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  const watch = { list: 0, fstatGet: 0, fstatPut: 0, fstatDelete: 0, get: 0, put: 0, del: 0 };
  const isFstat = (k) => String(k) === FSTAT_KEY;
  return {
    _store: store,
    _watch: watch,
    async list() {
      watch.list += 1;
      return { keys: [...store.entries()].map(([name, metadata]) => ({ name, metadata })), list_complete: true };
    },
    async get(key, opts) {
      watch.get += 1;
      if (isFstat(key)) watch.fstatGet += 1;
      if (!store.has(key)) return null;
      return opts?.type === 'json' ? store.get(key) : JSON.stringify(store.get(key));
    },
    async getWithMetadata(key) {
      watch.get += 1;
      if (isFstat(key)) watch.fstatGet += 1;
      if (!store.has(key)) return null;
      return { value: '', metadata: store.get(key) };
    },
    async put(key, value, opts) {
      watch.put += 1;
      if (isFstat(key)) watch.fstatPut += 1;
      store.set(key, opts?.metadata ?? value);
    },
    async delete(key) {
      watch.del += 1;
      if (isFstat(key)) watch.fstatDelete += 1;
      store.delete(key);
    },
  };
}

function makeEnv() {
  const d1 = makeMigratedEnv();
  const kv = makeWatchKv();
  return { _db: d1._db, DB: d1.DB, img_url: kv };
}

const get = (env, query = '') =>
  onRequestGet({ request: new Request(`https://x.dev/api/manage/folders${query}`), env });

const post = (env, body) =>
  onRequestPost({ request: new Request('https://x.dev/api/manage/folders', { method: 'POST', body: JSON.stringify(body) }), env });

const put = (env, body) =>
  onRequestPut({ request: new Request('https://x.dev/api/manage/folders', { method: 'PUT', body: JSON.stringify(body) }), env });

const del = (env, query = '') =>
  onRequestDelete({ request: new Request(`https://x.dev/api/manage/folders${query}`, { method: 'DELETE' }), env });

/** 断言该次请求全程未触碰 KV 全表操作。 */
function checkClean(label, kv) {
  const w = kv._watch;
  check(`${label} → kv.list() 为 0`, w.list === 0, `实际 ${w.list} 次`);
  check(`${label} → 未读 fstat:`, w.fstatGet === 0, `实际 ${w.fstatGet} 次`);
  check(`${label} → 未写 fstat:`, w.fstatPut === 0, `实际 ${w.fstatPut} 次`);
  check(`${label} → 未删 fstat:`, w.fstatDelete === 0, `实际 ${w.fstatDelete} 次`);
}

/* ============================================================
 * [1] GET 列表
 * ============================================================ */

console.log('[1] GET 列表（D1 可用）');
{
  const env = makeEnv();
  await post(env, { path: 'photos' });
  await post(env, { path: 'photos/2024' });
  env.img_url._watch.list = 0;

  const res = await get(env, '');
  const body = await res.json();
  check('返回 200', res.status === 200);
  check('目录树非空', Array.isArray(body.folders) && body.folders.length >= 2);
  check('包含 photos/2024（父路径已补齐）',
    body.folders.some((f) => f.path === 'photos/2024'));
  checkClean('GET', env.img_url);

  // 显式点名 currentTime —— 顺带回归 0004 之后 schema 未漂移
  const env2 = makeEnv();
  await post(env2, { path: 'a' });
  env2.img_url._watch.list = 0;
  await get(env2, '?_t=' + Date.now());
  checkClean('GET+_t', env2.img_url);
}

/* ============================================================
 * [2] POST 建目录
 * ============================================================ */

console.log('[2] POST 建目录（D1 可用）');
{
  const env = makeEnv();
  const res = await post(env, { path: 'docs/reports' });
  const body = await res.json();
  check('返回 200', res.status === 200);
  check('回显路径', body.path === 'docs/reports');

  const rows = env._db.prepare('SELECT folder_path FROM files WHERE is_folder = 1').all();
  check('目录标记已落到 D1', rows.some((r) => r.folder_path === 'docs/reports'));

  checkClean('POST', env.img_url);

  check('缺 path → 400', (await post(makeEnv(), {})).status === 400);
}

/* ============================================================
 * [3] PUT 移动目录
 * ============================================================ */

console.log('[3] PUT 移动目录（D1 可用）');
{
  const env = makeEnv();
  await post(env, { path: 'old' });
  await post(env, { path: 'old/inner' });
  env.img_url._watch.list = 0;

  const res = await put(env, { sourcePath: 'old', targetPath: 'new' });
  const body = await res.json();
  check('返回 200', res.status === 200);
  check("source 标记为 d1", body.source === 'd1', JSON.stringify(body));

  const rows = env._db.prepare('SELECT folder_path FROM files WHERE is_folder = 1').all().map((r) => r.folder_path);
  check('子树已重写（old/inner → new/inner）', rows.includes('new/inner'), JSON.stringify(rows));
  check('旧路径已不存在', !rows.includes('old') && !rows.includes('old/inner'));

  checkClean('PUT', env.img_url);

  check('源=目标 → 400', (await put(makeEnv(), { sourcePath: 'x', targetPath: 'x' })).status === 400);
  check('目标在源内部 → 400',
    (await put(makeEnv(), { sourcePath: 'x', targetPath: 'x/y' })).status === 400);
}

/* ============================================================
 * [4] DELETE 清空目录
 * ============================================================ */

console.log('[4] DELETE 清空目录（D1 可用）');
{
  const env = makeEnv();
  await post(env, { path: 'trash' });
  await post(env, { path: 'trash/sub' });
  env.img_url._watch.list = 0;

  const res = await del(env, '?path=trash&recursive=1');
  const body = await res.json();
  check('返回 200', res.status === 200);
  check("source 标记为 d1", body.source === 'd1', JSON.stringify(body));

  const rows = env._db.prepare('SELECT folder_path FROM files WHERE is_folder = 1').all().map((r) => r.folder_path);
  check('递归时子目录标记一并删除', !rows.includes('trash/sub'), JSON.stringify(rows));

  checkClean('DELETE', env.img_url);

  check('缺 path → 400', (await del(makeEnv(), '')).status === 400);
}

/* ============================================================
 * [5] 降级态：fresh=1 不得写回快照
 * ============================================================ */

console.log('[5] 降级态（D1 未绑定）：fresh=1 的写侧语义');
{
  // 造一份"KV 里已存在的目录"数据，D1 缺席 → 走路径 B
  const kvSeed = {
    'r2:a.png': { fileName: 'a.png', folderPath: 'photos', storageType: 'r2' },
    'folder:photos': { folderMarker: true, folderPath: 'photos' },
  };

  // ---- 普通读：应重建快照 ----
  const kv1 = makeWatchKv(kvSeed);
  const res1 = await get({ img_url: kv1 }, '');
  const body1 = await res1.json();
  check('降级态返回目录树', body1.folders.some((f) => f.path === 'photos'), JSON.stringify(body1.folders));
  check('降级态确实做了全表扫描', kv1._watch.list >= 1);
  check('普通读 → 重建快照（fstat: 写入 1 次）', kv1._watch.fstatPut === 1,
    `实际 ${kv1._watch.fstatPut} 次`);

  // ---- fresh=1：既不该读快照，也不该写快照 ----
  const kv2 = makeWatchKv(kvSeed);
  const res2 = await get({ img_url: kv2 }, '?fresh=1');
  const body2 = await res2.json();
  check('fresh=1 仍返回正确目录树', body2.folders.some((f) => f.path === 'photos'));
  check('★ fresh=1 → 不读快照', kv2._watch.fstatGet === 0, `实际 ${kv2._watch.fstatGet} 次`);
  check('★ fresh=1 → 不写快照（否则把传播中状态固化成"新鲜"）',
    kv2._watch.fstatPut === 0, `实际 ${kv2._watch.fstatPut} 次`);

  // ---- 带 storage 筛选：快照不含该维度，同样不写回 ----
  const kv3 = makeWatchKv(kvSeed);
  await get({ img_url: kv3 }, '?storage=r2');
  check('★ storage 筛选 → 不写快照（快照无 storage 维度）',
    kv3._watch.fstatPut === 0, `实际 ${kv3._watch.fstatPut} 次`);
}

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
