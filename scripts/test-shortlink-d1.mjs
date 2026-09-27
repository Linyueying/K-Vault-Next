/**
 * P2 测试：短链解析从 KV 迁到 D1。
 *
 * 背景：`/s/:slug` 与 `/api/share-info` 原先每次访问都要读一次 KV
 * （`bundle_slug:<slug>` / `share_slug:<slug>`）。而免费额度里
 * **KV 读 10 万/天，D1 rows read 500 万/天** —— 短链是分享链路的第一跳，
 * 每一次外部点击都要走一次判定，是最该从 KV 上挪走的高频路径。
 *
 * D1 侧已有现成的索引：`bundles.slug` 是主键，`files.share_slug` 有唯一索引。
 * 本套件锁住三件事：
 *
 *   1. 解析结果正确（合集 → ?b=，文件 → ?s=，未知 → ?s=）
 *   2. **D1 可用时不再碰 KV**（只读次数必须为 0，否则等于没优化）
 *   3. D1 不可用（未绑定 / 报错）时正确回落 KV，行为与改动前一致
 *
 * 第 2 条是本套件存在的理由：功能正确但偷偷多读一次 KV，是最容易蒙混过关的回归。
 *
 * 覆盖：
 *   [1] bundleSlugExists
 *   [2] getFileRecordByShareSlug
 *   [3] /s/:slug 重定向分支
 *   [4] /api/share-info 单文件短链解析
 *
 * 运行：node scripts/test-shortlink-d1.mjs
 */
import { bundleSlugExists, writeBundleRecord, deleteBundleRecord } from '../functions/utils/bundle-store.js';
import { getFileRecordByShareSlug } from '../functions/utils/metadata-d1.js';
import { putRecordIndex } from '../functions/utils/file-record.js';
import { makeMigratedEnv } from './test-utils.mjs';
import { onRequest as shortLinkRequest } from '../functions/s/[slug].js';
import { onRequest as shareInfoRequest } from '../functions/api/share-info.js';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/* ============================================================
 * 测试替身
 * ============================================================ */

/** 带读写计数的 KV 替身 —— 计数是本套件的核心断言依据。 */
function makeKv(initial = {}, options = {}) {
  const store = new Map(Object.entries(initial));
  const stats = { get: 0, put: 0, delete: 0 };
  return {
    _store: store,
    _stats: stats,
    async get(key) {
      stats.get += 1;
      if (options.failGet) throw new Error('kv-down');
      return store.has(key) ? store.get(key) : null;
    },
    async getWithMetadata(key) {
      stats.get += 1;
      if (options.failGet) throw new Error('kv-down');
      if (!store.has(key)) return null;
      return { value: '', metadata: store.get(key) };
    },
    async put(key, value, opts) {
      stats.put += 1;
      store.set(key, opts?.metadata ?? value);
    },
    async delete(key) {
      stats.delete += 1;
      store.delete(key);
    },
  };
}

/** 给 env 套一层 D1 查询计数器。 */
function countedEnv(base, extra = {}) {
  const stats = { queries: 0 };
  const env = { ...base, ...extra };
  env.DB = {
    prepare(sql) {
      stats.queries += 1;
      return base.DB.prepare(sql);
    },
  };
  env._d1Stats = stats;
  return env;
}

/** D1 绑定存在但每次查询都抛错。 */
function brokenD1() {
  return { DB: { prepare() { throw new Error('d1-down'); } } };
}

/**
 * 写一个带完整分享字段的文件记录。
 *
 * 刻意走 `putRecordIndex()` 而不是直接 `putFileRecord()`：索引 ID 是
 * **剥离存储前缀后的裸 ID**（`r2:plain.png` → `plain.png`），只有真实写入
 * 路径才会做这一步转换。手写 ID 会得到「D1 里有行、但按 ID 查不到」的假数据。
 */
async function seedFile(env, kvKey, overrides = {}) {
  await putRecordIndex(env, kvKey, {
    metadata: {
      fileName: overrides.fileName || String(kvKey).split('/').pop(),
      fileSize: 1024,
      TimeStamp: 1700000000000,
      storageType: 'r2',
      storage: 'r2',
      r2Key: 'obj/photo.png',
      shareSlug: overrides.shareSlug ?? '',
      sharePasswordHash: overrides.sharePasswordHash ?? '',
      shareExpiresAt: overrides.shareExpiresAt ?? 0,
      shareMaxDownloads: overrides.shareMaxDownloads ?? 0,
    },
  });
}

async function seedBundle(env, slug) {
  await writeBundleRecord(env, {
    slug,
    type: 'files',
    fileIds: ['r2:a.png'],
    createdAt: 1700000000000,
  });
}

/** 让 ensureSchema 的模块级缓存生效，避免迁移查询污染后续计数。 */
async function warmSchema(env) {
  await bundleSlugExists(env, '__warm__');
}

/* ============================================================
 * [1] bundleSlugExists
 * ============================================================ */

console.log('[1] bundleSlugExists');
{
  const env = countedEnv(makeMigratedEnv());
  await seedBundle(env, 'team2024');

  const hit = await bundleSlugExists(env, 'team2024');
  check('合集存在 → exists=true', hit.exists === true);
  check('合集存在 → disabled 未设（结果可采信）', !hit.disabled);

  const miss = await bundleSlugExists(env, 'nope');
  check('合集不存在 → exists=false', miss.exists === false);
  check('合集不存在 → disabled 未设（不回落 KV）', !miss.disabled);

  check('空 slug → disabled=true', (await bundleSlugExists(env, '')).disabled === true);
  check('D1 未绑定 → disabled=true', (await bundleSlugExists({}, 'x')).disabled === true);
  check('D1 报错 → disabled=true', (await bundleSlugExists(brokenD1(), 'x')).disabled === true);

  // TEXT 主键默认 BINARY 比较，slug 是大小写敏感的
  check('slug 大小写敏感（Team2024 ≠ team2024）',
    (await bundleSlugExists(env, 'Team2024')).exists === false);

  await deleteBundleRecord(env, 'team2024');
  check('删除后 → exists=false', (await bundleSlugExists(env, 'team2024')).exists === false);
}

/* ============================================================
 * [2] getFileRecordByShareSlug
 * ============================================================ */

console.log('[2] getFileRecordByShareSlug');
{
  const env = countedEnv(makeMigratedEnv());
  await seedFile(env, 'r2:photo.png', {
    shareSlug: 'holiday',
    sharePasswordHash: 'hash-abc',
    shareExpiresAt: 1893456000000,
    shareMaxDownloads: 5,
  });

  const hit = await getFileRecordByShareSlug(env, 'holiday');
  check('命中 → 返回记录', Boolean(hit?.record?.metadata));
  check('命中 → kvKey 正确', hit?.kvKey === 'r2:photo.png', `实际 ${hit?.kvKey}`);
  check('命中 → shareSlug 还原', hit?.record?.metadata?.shareSlug === 'holiday');
  check('命中 → sharePasswordHash 还原', hit?.record?.metadata?.sharePasswordHash === 'hash-abc');
  check('命中 → shareExpiresAt 还原', Number(hit?.record?.metadata?.shareExpiresAt) === 1893456000000);
  check('命中 → shareMaxDownloads 还原', Number(hit?.record?.metadata?.shareMaxDownloads) === 5);
  check('命中 → 存储定位字段还原（r2Key）', hit?.record?.metadata?.r2Key === 'obj/photo.png');

  check('未命中 → null', (await getFileRecordByShareSlug(env, 'nothing')) === null);
  check('空 slug → null', (await getFileRecordByShareSlug(env, '')) === null);
  check('D1 未绑定 → null', (await getFileRecordByShareSlug({}, 'holiday')) === null);
  check('D1 报错 → null', (await getFileRecordByShareSlug(brokenD1(), 'holiday')) === null);
}

/* ============================================================
 * [3] /s/:slug 重定向分支
 * ============================================================ */

console.log('[3] /s/:slug 重定向');
{
  const base = makeMigratedEnv();
  await seedBundle(base, 'team2024');
  await seedFile(base, 'r2:photo.png', { shareSlug: 'holiday' });
  await warmSchema(base);

  const open = async (slug, kvOptions = {}, kvSeed = {}) => {
    const env = countedEnv(base, { img_url: makeKv(kvSeed, kvOptions) });
    const request = new Request(`https://x.dev/s/${slug}`);
    const res = await shortLinkRequest({ request, params: { slug }, env });
    const location = res.headers.get('location') || '';
    return { res, location, env };
  };

  const bundle = await open('team2024');
  check('合集 slug → 302', bundle.res.status === 302);
  check('合集 slug → ?b=', bundle.location.includes('?b=team2024'), bundle.location);
  check('★ 合集命中时不读 KV', bundle.env.img_url._stats.get === 0,
    `实际读 ${bundle.env.img_url._stats.get} 次`);

  const file = await open('holiday');
  check('文件短链 → ?s=', file.location.includes('?s=holiday'), file.location);
  check('★ D1 判为「非合集」时不读 KV', file.env.img_url._stats.get === 0,
    `实际读 ${file.env.img_url._stats.get} 次`);

  const unknown = await open('ghost');
  check('未知 slug → ?s=', unknown.location.includes('?s=ghost'), unknown.location);

  // 大小写：入口先 lowerCase 再查，D1 里存的是小写 slug
  const upper = await open('TEAM2024');
  check('大写 slug 归一化后命中合集', upper.location.includes('?b=TEAM2024'), upper.location);

  check('空 slug → 不带参数', (await open('')).location.endsWith('/share.html'));
  check('超长 slug → 不带参数', (await open('a'.repeat(200))).location.endsWith('/share.html'));

  // ---- 回落路径：D1 未绑定 ----
  const noD1 = countedEnv({ img_url: makeKv({ 'bundle_slug:legacy': 'legacy' }) });
  const legacyRes = await shortLinkRequest({
    request: new Request('https://x.dev/s/legacy'),
    params: { slug: 'legacy' },
    env: noD1,
  });
  check('D1 未绑定 → 回落 KV 并命中合集',
    (legacyRes.headers.get('location') || '').includes('?b=legacy'));
  check('D1 未绑定 → 确实读了 KV', noD1.img_url._stats.get === 1);

  // ---- 回落路径：D1 未绑定 + KV 也挂了 ----
  const bothDown = countedEnv({ img_url: makeKv({}, { failGet: true }) });
  const downRes = await shortLinkRequest({
    request: new Request('https://x.dev/s/legacy'),
    params: { slug: 'legacy' },
    env: bothDown,
  });
  check('D1 + KV 同时不可用 → 按单文件处理（不抛 500）',
    (downRes.headers.get('location') || '').includes('?s=legacy'));
}

/* ============================================================
 * [4] /api/share-info 单文件短链解析
 * ============================================================ */

console.log('[4] /api/share-info 短链解析');
{
  const base = makeMigratedEnv();
  await seedFile(base, 'r2:photo.png', { fileName: 'photo.png', shareSlug: 'holiday' });
  // 开了分享但没有自定义短链的文件：只能按文件 ID 访问
  await seedFile(base, 'r2:plain.png', { fileName: 'plain.png', shareExpiresAt: 4102444800000 });
  // 存在但从未开过分享：按 ID 访问也必须是 404
  await seedFile(base, 'r2:noslug.png', {});
  await warmSchema(base);

  const ask = async (query, kvSeed = {}, kvOptions = {}) => {
    const env = countedEnv(base, { img_url: makeKv(kvSeed, kvOptions) });
    const request = new Request(`https://x.dev/api/share-info?${query}`);
    const res = await shareInfoRequest({ request, env });
    let body = null;
    try { body = await res.json(); } catch { /* 非 JSON 忽略 */ }
    return { res, body, env };
  };

  // ---- 自定义短链，D1 命中 ----
  const bySlug = await ask('s=holiday');
  check('自定义短链 → 200', bySlug.res.status === 200, JSON.stringify(bySlug.body));
  check('自定义短链 → fileName 正确', bySlug.body?.fileName === 'photo.png');
  check('自定义短链 → fileUrl 用 kvKey', bySlug.body?.fileUrl === '/file/r2%3Aphoto.png',
    bySlug.body?.fileUrl);
  check('★ 短链命中时不读 KV', bySlug.env.img_url._stats.get === 0,
    `实际读 ${bySlug.env.img_url._stats.get} 次`);
  check('★ 短链命中时只查 1 次 D1（不再二次定位记录）',
    bySlug.env._d1Stats.queries === 1, `实际 ${bySlug.env._d1Stats.queries} 次`);

  // ---- 裸文件 ID ----
  // 此前这里是「2 次 D1 + 1 次 KV」的已知代价：D1 短链查询落空后回落一次
  // KV 读，兜住"D1 写入失败过的存量记录"。
  //
  // 现在 findShareSlugOwner 本身也接了 D1（P3 停止双写的前置条件）：
  // 它先查 files.share_slug，确认没有占用就直接返回空串，**不再读 KV**。
  // 于是这条路径变成 3 次 D1 + 0 次 KV —— 走的仍是同一条逻辑链，
  // 只是中间那一步从"读 KV 映射"换成了"读 D1 映射"，结果等价。
  const byId = await ask('s=r2%3Aplain.png');
  check('文件 ID 直查 → 200', byId.res.status === 200, JSON.stringify(byId.body));
  check('文件 ID 直查 → fileName 正确', byId.body?.fileName === 'plain.png');
  check('★ 文件 ID 直查 → KV 读为 0（映射查询已切 D1）',
    byId.env.img_url._stats.get === 0, `实际 ${byId.env.img_url._stats.get} 次`);

  // ---- 不存在 / 未开分享 ----
  check('不存在的短链 → 404', (await ask('s=ghost')).res.status === 404);
  check('文件存在但未开分享 → 404', (await ask('s=r2%3Anoslug.png')).res.status === 404);

  // ---- D1 未绑定，回落 KV 映射 ----
  const kvOnly = countedEnv(
    { img_url: makeKv({ 'share_slug:vintage': { value: '', metadata: {} } }) },
  );
  const fallbackEnv = countedEnv(
    { img_url: makeKv({ 'share_slug:vintage': 'r2:photo.png' }) },
  );
  // KV 里 share_slug: 存的是 kvKey 字符串，getWithMetadata 也走同一个 store。
  // 这里让 D1 缺席、KV 提供映射，记录本身由 KV 的 getWithMetadata 提供。
  const legacyKv = makeKv({ 'share_slug:vintage': 'r2:photo.png' });
  legacyKv.put('r2:photo.png', '', {
    metadata: { fileName: 'vintage.png', fileSize: 10, shareSlug: 'vintage', TimeStamp: 1 },
  });
  const legacy = countedEnv({ img_url: legacyKv });
  const legacyRes = await shareInfoRequest({
    request: new Request('https://x.dev/api/share-info?s=vintage'),
    env: legacy,
  });
  check('D1 未绑定 → 回落 KV 映射，仍然 200', legacyRes.status === 200);
  check('D1 未绑定 → 确实读了 KV', legacy.img_url._stats.get > 0);
  void kvOnly; void fallbackEnv;

  // ---- 过期 ----
  const expiredBase = makeMigratedEnv();
  await seedFile(expiredBase, 'r2:old.png', {
    shareSlug: 'oldlink',
    shareExpiresAt: 1000,
  });
  await warmSchema(expiredBase);
  const expiredEnv = countedEnv(expiredBase, { img_url: makeKv() });
  const expiredRes = await shareInfoRequest({
    request: new Request('https://x.dev/api/share-info?s=oldlink'),
    env: expiredEnv,
  });
  check('过期短链 → 410（不是 404）', expiredRes.status === 410, `实际 ${expiredRes.status}`);
}

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
