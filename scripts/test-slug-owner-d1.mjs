/**
 * P3 准入测试：停止 KV 双写之前，必须先证明「读侧已不依赖那些键」。
 *
 * ============================================================================
 * 为什么 P3 需要一道准入检查
 * ============================================================================
 *
 * P3 要停掉的是**写**（不再往 KV 写 `share_slug:` 等键）。它不可逆 ——
 * 一旦停写，KV 里那些键就永久停在最后一次写入的状态。
 *
 * 危险之处在于：**停写之后，功能不会立刻坏**。存量键还在，读侧照常命中，
 * 一切看起来正常；只有当用户**新**建一个短链时才会出问题 —— 而那时
 * 唯一性校验会以为"这个短链没人用"（因为它只读 KV，而新短链没写 KV），
 * 于是两个用户拿到同一个短链，后写的把先写的映射覆盖掉。
 *
 * 这类"上线时全绿、几天后偶发"的问题最难查。所以顺序必须是：
 *
 *   1. 先证明所有读侧路径都已 D1 优先（本套件）
 *   2. 再停写
 *
 * ============================================================================
 * 覆盖
 * ============================================================================
 *
 *   [1] findShareSlugOwner 在 D1 可用时走 D1，KV 零读
 *   [2] ★ 唯一性校验必须能发现已被占用的短链（否则会放开重复短链）
 *   [3] ★ D1 查询失败时回落 KV，**不得**当作"短链空闲"
 *   [4] D1 未绑定 → 完整回落 KV（等价回滚）
 *   [5] 与 bundle 侧的 isSlugTaken 语义对称（跨表占用也能被发现）
 *   [6] 端到端：建短链 → 唯一性校验 → 换短链 → 旧短链释放
 *
 * 运行：node scripts/test-slug-owner-d1.mjs
 */
import { findShareSlugOwner, sanitizeShareSlug } from '../functions/utils/share-options.js';
import { findFileOwnerBySlug } from '../functions/utils/metadata-d1.js';
import { putRecordIndex } from '../functions/utils/file-record.js';
import { isSlugTaken } from '../functions/utils/bundle-store.js';
import { makeMigratedEnv } from './test-utils.mjs';

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/**
 * 带读写计数的 KV 替身。
 *
 * 存储语义与真实 KV 一致：**底层一律存字符串**。
 *   · put(key, value)        → 存 String(value)
 *   · get(key)               → 返回字符串
 *   · get(key, {type:'json'}) → JSON.parse 后返回
 *
 * ⚠️ 第一版把 put 写成了 `JSON.parse(value)`（假设调用方传 JSON 字符串），
 * 于是 get 读到的是**已经对象化的值**，{type:'json'} 再 parse 就报错，
 * 表现为 findShareSlugOwner 拿到带引号的 `"r2:x.png"`。
 * 替身必须忠实模拟存储介质，否则测的是替身的 bug。
 */
function makeKv(initial = {}, options = {}) {
  const store = new Map();
  // 预置数据按"已是字符串"处理（与真实 KV 一致）
  for (const [k, v] of Object.entries(initial)) {
    store.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  const stats = { get: 0, put: 0, delete: 0, list: 0 };
  return {
    _store: store,
    _stats: stats,
    async get(key, opts) {
      stats.get += 1;
      if (options.failGet) throw new Error('kv-down');
      if (!store.has(key)) return null;
      const raw = store.get(key);
      if (opts?.type === 'json') {
        try { return JSON.parse(raw); } catch { return null; }
      }
      return raw;
    },
    async put(key, value) {
      stats.put += 1;
      store.set(key, String(value));
    },
    async delete(key) { stats.delete += 1; store.delete(key); },
    async list({ prefix = '' } = {}) {
      stats.list += 1;
      return {
        keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      };
    },
  };
}

/**
 * 写一条带 share_slug 的文件记录。
 *
 * 走 `putRecordIndex` 而不是 `putFileRecord`：索引 ID 是**剥离存储前缀后的
 * 裸 ID**（`r2:photo.png` → `photo.png`），只有真实写入路径才做这一步。
 * 手写 ID 会造出「D1 里有行、但按 slug 查到的 kv_key 与预期不符」的假数据。
 */
async function seedFile(env, { kvKey, shareSlug = null, fileName = 'f.png' }) {
  await putRecordIndex(env, kvKey, {
    metadata: {
      fileName,
      fileSize: 1024,
      TimeStamp: 1700000000000,
      storageType: 'r2',
      storage: 'r2',
      r2Key: `obj/${fileName}`,
      shareSlug: shareSlug ?? '',
    },
  });
}

const SHARE_SLUG_PREFIX = 'share_slug:';

// ============================================================================
console.log('[1] findShareSlugOwner 在 D1 可用时走 D1，KV 零读');
{
  const base = makeMigratedEnv();
  const kv = makeKv();
  const env = { ...base, img_url: kv };

  await seedFile(env, { kvKey: 'r2:photo.png', shareSlug: 'holiday' });
  kv._stats.get = 0;

  const owner = await findShareSlugOwner(env, 'holiday');
  check('[1] 能查到占用者', owner === 'r2:photo.png', owner);
  check('[1] ★ 全程未读 KV（原先必读一次 share_slug:）', kv._stats.get === 0,
    `get=${kv._stats.get}`);

  const free = await findShareSlugOwner(env, 'nobody-uses-this');
  check('[1] 未被占用返回空串', free === '', JSON.stringify(free));
  check('[1] 查空闲也不读 KV', kv._stats.get === 0, `get=${kv._stats.get}`);
}

// ============================================================================
console.log('[2] ★ 唯一性校验必须能发现已占用的短链');
{
  const base = makeMigratedEnv();
  const env = { ...base, img_url: makeKv() };

  await seedFile(env, { kvKey: 'r2:a.png', shareSlug: 'taken' });

  // 这是 P3 之后最容易坏的那个判断：如果它读不到占用者，
  // 就会认为 'taken' 可用，于是放行重复短链。
  const owner = await findShareSlugOwner(env, 'taken');
  check('[2] ★ D1 里的占用能被发现（不是空串）', owner === 'r2:a.png',
    `owner=${JSON.stringify(owner)}`);

  // 关键点：**KV 里没有这个映射**，仍必须发现占用 —— 这正是 P3 之后的常态
  check('[2] ★ 该短链在 KV 里并不存在（模拟 P3 停写后的状态）',
    ![...env.img_url._store.keys()].some((k) => k === `${SHARE_SLUG_PREFIX}taken`),
    [...env.img_url._store.keys()].join(','));

  const free = await findShareSlugOwner(env, 'still-free');
  check('[2] 真正空闲的短链仍返回空串（没有误判为占用）', free === '');

  // 相邻短链不应互相干扰
  await seedFile(env, { kvKey: 'r2:b.png', shareSlug: 'taken-2' });
  check('[2] taken-2 独立识别', (await findShareSlugOwner(env, 'taken-2')) === 'r2:b.png');
  check('[2] taken 未被 taken-2 影响', (await findShareSlugOwner(env, 'taken')) === 'r2:a.png');
}

// ============================================================================
console.log('[3] ★ D1 查询失败时回落 KV，不得当作"空闲"');
{
  // 造一个 prepare 会抛的 D1
  const brokenD1 = {
    prepare() { throw new Error('d1-down'); },
  };
  const kv = makeKv({ [`${SHARE_SLUG_PREFIX}legacy`]: 'r2:legacy.png' });
  const env = { DB: brokenD1, img_url: kv };

  const owner = await findShareSlugOwner(env, 'legacy');
  check('[3] ★ D1 挂了 → 回落 KV 拿到占用者', owner === 'r2:legacy.png',
    JSON.stringify(owner));

  const freeInKv = await findShareSlugOwner(env, 'not-in-kv');
  check('[3] KV 里也没有 → 返回空串', freeInKv === '');

  // 反例：如果实现把"查不了"当成"空闲"，那么 D1 抖动期间就会放开重复短链。
  // 这里直接断言 findFileOwnerBySlug 用 disabled 标记了这种情况。
  const probe = await findFileOwnerBySlug(env, 'legacy');
  check('[3] ★ findFileOwnerBySlug 用 disabled 标记"查不了"（而非 owner=""）',
    probe.disabled === true, JSON.stringify(probe));
}

// ============================================================================
console.log('[4] D1 未绑定 → 完整回落 KV（等价回滚）');
{
  const kv = makeKv({ [`${SHARE_SLUG_PREFIX}vintage`]: 'r2:vintage.png' });
  const env = { img_url: kv };

  const owner = await findShareSlugOwner(env, 'vintage');
  check('[4] 无 D1 时读 KV 映射', owner === 'r2:vintage.png', owner);
  check('[4] 确实读了 KV', kv._stats.get > 0, `get=${kv._stats.get}`);

  check('[4] 无 D1 无映射 → 空串', (await findShareSlugOwner(env, 'other')) === '');

  // 无 KV 也无 D1
  check('[4] 完全无绑定时返回空串（不抛）',
    (await findShareSlugOwner({}, 'anything')) === '');

  // KV 读异常
  const badKv = makeKv({}, { failGet: true });
  let threw = false;
  let result = null;
  try { result = await findShareSlugOwner({ img_url: badKv }, 'x'); } catch { threw = true; }
  check('[4] KV 读异常时不抛，返回空串', threw === false && result === '', JSON.stringify(result));
}

// ============================================================================
console.log('[5] 与 bundle 侧语义对称（跨表占用也能被发现）');
{
  const base = makeMigratedEnv();
  const env = { ...base, img_url: makeKv() };

  await seedFile(env, { kvKey: 'r2:x.png', shareSlug: 'clash' });
  await env.DB.prepare(
    'INSERT INTO bundles (slug, created_at) VALUES (?, ?)'
  ).bind('bundle-slug', Date.now()).run();

  const took = await isSlugTaken(env, 'clash');
  check('[5] isSlugTaken 能发现文件侧占用', took.taken === true, JSON.stringify(took));

  const tookBundle = await isSlugTaken(env, 'bundle-slug');
  check('[5] isSlugTaken 能发现合集侧占用', tookBundle.taken === true, JSON.stringify(tookBundle));

  const free = await isSlugTaken(env, 'nobody');
  check('[5] 空闲短链 taken=false 且未被标记 disabled',
    free.taken === false && free.disabled !== true, JSON.stringify(free));

  // 文件侧函数只看 files 表 —— 合集占用由 isSlugTaken 负责，两者互补
  const fileOnly = await findShareSlugOwner(env, 'bundle-slug');
  check('[5] findShareSlugOwner 只管文件侧（合集短链不属于它）', fileOnly === '',
    JSON.stringify(fileOnly));
}

// ============================================================================
console.log('[6] 端到端：建短链 → 校验 → 换短链 → 旧短链释放');
{
  const base = makeMigratedEnv();
  const kv = makeKv();
  const env = { ...base, img_url: kv };

  // 1) 建一个带短链的文件
  await seedFile(env, { kvKey: 'r2:one.png', shareSlug: 'first' });
  check('[6] 新建后短链被占用', (await findShareSlugOwner(env, 'first')) === 'r2:one.png');

  // 2) 第二个文件想抢同一个短链 —— 校验必须拦住
  const clash = await findShareSlugOwner(env, 'first');
  check('[6] ★ 抢重复短链会被拦下（owner 非空）', clash === 'r2:one.png', clash);

  // 3) 换短链：first → second
  // ⚠️ files.id 是**剥离存储前缀后的裸 ID**（putRecordIndex 做的转换），
  //    即 'one.png' 而非 'r2:one.png'。用 kvKey 当主键会更新 0 行 ——
  //    而这种失败是静默的（UPDATE 不报错），断言才会发现。
  const changed = await base.DB.prepare('UPDATE files SET share_slug = ? WHERE id = ?')
    .bind('second', 'one.png').run();
  check('[6] 换短链更新到 1 行（确认用的是裸 ID）',
    Number(changed.changes) === 1, `changes=${changed.changes}`);
  check('[6] 新短链可用', (await findShareSlugOwner(env, 'second')) === 'r2:one.png');
  check('[6] ★ 旧短链已释放（可被他人使用）',
    (await findShareSlugOwner(env, 'first')) === '', 'first 仍被占用');

  // 4) 关闭分享（slug 置空）后短链释放
  await base.DB.prepare('UPDATE files SET share_slug = NULL WHERE id = ?')
    .bind('one.png').run();
  check('[6] 关闭分享后短链释放', (await findShareSlugOwner(env, 'second')) === '');

  check('[6] 全程 KV 零读（D1 可用）', kv._stats.get === 0, `get=${kv._stats.get}`);
  check('[6] 全程 KV 零写（这是 P3 的前提）', kv._stats.put === 0, `put=${kv._stats.put}`);
}

// ============================================================================
console.log('[7] 归一化：非法/特殊短链不产生误判');
{
  const base = makeMigratedEnv();
  const env = { ...base, img_url: makeKv() };
  await seedFile(env, { kvKey: 'r2:a.png', shareSlug: 'valid-slug' });

  check('[7] 空值 → 空串', (await findShareSlugOwner(env, '')) === '');
  check('[7] null → 空串', (await findShareSlugOwner(env, null)) === '');
  // 归一化由 sanitizeShareSlug 负责，非法值一律视为"无短链"
  const illegal = sanitizeShareSlug('bad slug!');
  check('[7] 非法短链被归一化掉（不会误伤合法记录）',
    (await findShareSlugOwner(env, 'bad slug!')) === '', `normalized=${JSON.stringify(illegal)}`);
  check('[7] 合法短链仍能查到', (await findShareSlugOwner(env, 'valid-slug')) === 'r2:a.png');
}

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
