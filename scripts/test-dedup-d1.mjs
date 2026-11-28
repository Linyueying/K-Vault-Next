/**
 * P4 测试：内容去重索引从 KV（`sha_dup:`）迁到 D1（`files.content_sha`）。
 *
 * 背景：原实现每次带 `deduplicate=true` 的上传都要**写一次 + 读一次** KV，
 * 而 KV 免费写额度只有 **1000 次/天** —— 全站最窄的一份额度，却被一个
 * 本质上是"缓存"的索引占着。D1 侧本来就有 `idx_files_content_sha` 唯一索引，
 * 文件记录随上传落库时去重信息已就位，**不需要任何额外写入**。
 *
 * 本套件锁住三件事：
 *
 *   1. 查重结果与 KV 版逐字段一致（迁移不能改变对外行为）
 *   2. **D1 可用时一次 KV 都不读、不写**（否则等于没优化）
 *   3. **TTL 窗口语义被保住** —— KV 版带 90 天 `expirationTtl`，窗口过后
 *      允许重传；D1 的列没有 TTL，若不管就变成永久去重，语义会悄悄变严
 *
 * 第 3 条最容易漏：功能测试（"重复上传能秒传"）全绿，但窗口语义已经变了。
 *
 * 覆盖：
 *   [1] findByContentSha（含 TTL 窗口）
 *   [2] findDuplicate 统一形状
 *   [3] recordDuplicate 在 D1 可用时不得写 KV
 *   [4] D1 未绑定 → 完整回落 KV
 *
 * 运行：node scripts/test-dedup-d1.mjs
 */
import { findByContentSha, putFileRecord } from '../functions/utils/metadata-d1.js';
import { findDuplicate, recordDuplicate, DEDUP_KEY_PREFIX } from '../functions/utils/dedup-index.js';
import { makeMigratedEnv } from './test-utils.mjs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
};

const DAY = 24 * 3600 * 1000;

/** 带读写计数的 KV 替身。 */
function makeKv(initial = {}, options = {}) {
  const store = new Map(Object.entries(initial));
  const stats = { get: 0, put: 0 };
  return {
    _store: store,
    _stats: stats,
    async get(key, opts) {
      stats.get += 1;
      if (options.failGet) throw new Error('kv-down');
      if (!store.has(key)) return null;
      return opts?.type === 'json' ? store.get(key) : JSON.stringify(store.get(key));
    },
    async put(key, value, opts) {
      stats.put += 1;
      if (options.failPut) throw new Error('kv-down');
      store.set(key, opts?.type === 'json' ? JSON.parse(value) : JSON.parse(value));
    },
  };
}

/** 给 env 套一层 D1 查询计数器。 */
function countedEnv(base, extra = {}) {
  const stats = { queries: 0 };
  const env = { ...base, ...extra };
  env.DB = {
    prepare(sql) { stats.queries += 1; return base.DB.prepare(sql); },
  };
  env._d1Stats = stats;
  return env;
}

/** 写一条文件记录（走真实索引写入路径，ID 是剥离前缀后的裸 ID）。 */
async function seedFile(env, kvKey, over = {}) {
  const id = String(kvKey).replace(/^(r2|s3|img|vid|aud|doc|discord|hf|webdav|github):/, '');
  const ts = over.uploadedAt ?? (Date.now() - 1000);
  await putFileRecord(env, id, kvKey, {
    fileName: over.fileName || 'a.png',
    fileSize: over.fileSize ?? 1234,
    mime: over.mime || 'image/png',
    TimeStamp: ts,
    storageType: 'r2',
    storage: 'r2',
    r2Key: 'o/a.png',
    contentSha: over.contentSha ?? 'sha-abc',
  });
  // uploaded_at 由 metadataToColumns 从 TimeStamp 取，这里显式确认
  env._db.prepare('UPDATE files SET uploaded_at = ? WHERE id = ?').run(ts, id);
}

const TTL = 90 * 24 * 3600;

/* ============================================================
 * [1] findByContentSha
 * ============================================================ */

console.log('[1] findByContentSha（D1 直查）');
{
  const env = countedEnv(makeMigratedEnv());
  await seedFile(env, 'r2:a.png', { contentSha: 'sha-hit', fileName: 'a.png', mime: 'image/png' });

  const hit = await findByContentSha(env, 'sha-hit');
  check('命中 → 返回记录', Boolean(hit?.record?.metadata));
  check('命中 → kvKey 正确', hit?.kvKey === 'r2:a.png', `实际 ${hit?.kvKey}`);
  check('命中 → mime 已还原（原先只写不读，缺少回填）',
    hit?.record?.metadata?.mime === 'image/png', `实际 ${hit?.record?.metadata?.mime}`);
  check('未命中 → null', (await findByContentSha(env, 'sha-miss')) === null);
  check('空 sha → null', (await findByContentSha(env, '')) === null);
  check('D1 未绑定 → null', (await findByContentSha({}, 'sha-hit')) === null);

  // ---- TTL 窗口 ----
  check('TTL 窗口内 → 命中（刚上传）',
    Boolean(await findByContentSha(env, 'sha-hit', { ttlSeconds: TTL })));

  const oldEnv = countedEnv(makeMigratedEnv());
  await seedFile(oldEnv, 'r2:old.png', { contentSha: 'sha-old' });
  oldEnv._db.prepare('UPDATE files SET uploaded_at = ?').run(Date.now() - 200 * DAY);

  check('★ 超出 TTL 窗口 → 不命中（复刻 KV 的 expirationTtl）',
    (await findByContentSha(oldEnv, 'sha-old', { ttlSeconds: TTL })) === null);
  check('★ 同一条记录，不限窗口 → 仍命中',
    Boolean(await findByContentSha(oldEnv, 'sha-old')));
  check('边界：窗口内 1 天 → 命中',
    Boolean(await findByContentSha(oldEnv, 'sha-old', { ttlSeconds: 0 })));
}

/* ============================================================
 * [2] findDuplicate 统一形状
 * ============================================================ */

console.log('[2] findDuplicate 统一形状');
{
  const env = countedEnv(makeMigratedEnv());
  const uploadedAt = Date.now() - 5000;
  await seedFile(env, 'r2:pic.jpg', {
    contentSha: 'sha-uni', fileName: 'pic.jpg', fileSize: 999, mime: 'image/jpeg', uploadedAt,
  });

  const d1 = await findDuplicate(env, 'sha-uni', { ttlSeconds: TTL });
  check('source=d1', d1?.source === 'd1');
  check('kvKey 正确', d1?.kvKey === 'r2:pic.jpg');
  check('fileName 正确', d1?.fileName === 'pic.jpg');
  check('size 正确', d1?.size === 999);
  check('mime 正确', d1?.mime === 'image/jpeg');
  check('storage 正确', d1?.storage === 'r2');
  check('uploadedAt 是 ISO 串', /^\d{4}-\d{2}-\d{2}T/.test(d1?.uploadedAt || ''), d1?.uploadedAt);

  check('未命中 → null', (await findDuplicate(env, 'sha-none')) === null);

  // ---- KV 兜底形状必须一致 ----
  const kvEnv = { img_url: makeKv({
    [`${DEDUP_KEY_PREFIX}sha-kv`]: {
      publicId: 'r2:kv.png', fileName: 'kv.png', size: 7,
      mime: 'image/png', storage: 'r2', uploadedAt: '2026-01-01T00:00:00.000Z',
    },
  }) };
  const kv = await findDuplicate(kvEnv, 'sha-kv', { ttlSeconds: TTL });
  check('KV 回落 source=kv', kv?.source === 'kv');
  check('KV 回落 kvKey 正确（取 publicId）', kv?.kvKey === 'r2:kv.png');
  check('KV 回落 fileName 正确', kv?.fileName === 'kv.png');
  check('★ 两种来源的字段名完全一致（调用方无需分支）',
    JSON.stringify(Object.keys(d1).sort()) === JSON.stringify(Object.keys(kv).sort()),
    `${Object.keys(d1).sort()} vs ${Object.keys(kv).sort()}`);

  // ---- import 路径的存量键形状：只有 directId ----
  const importEnv = { img_url: makeKv({
    [`${DEDUP_KEY_PREFIX}sha-imp`]: {
      fileId: 'o/x.png', directId: 'r2:o/x.png', fileName: 'x.png',
      size: 3, mime: 'image/png', storage: 'r2',
    },
  }) };
  const imp = await findDuplicate(importEnv, 'sha-imp', {});
  check('KV 存量键只有 directId 时也能取到 kvKey', imp?.kvKey === 'r2:o/x.png');
}

/* ============================================================
 * [3] recordDuplicate：D1 可用时不写 KV
 * ============================================================ */

console.log('[3] recordDuplicate 写入策略');
{
  const kv = makeKv();
  const env = countedEnv(makeMigratedEnv(), { img_url: kv });

  const res = await recordDuplicate(env, 'sha-new', { publicId: 'r2:new.png' }, { ttlSeconds: TTL });
  check('★ D1 可用 → 不写 KV', kv._stats.put === 0, `实际写 ${kv._stats.put} 次`);
  check("★ 返回 written=false, reason='d1-indexed'",
    res.written === false && res.reason === 'd1-indexed', JSON.stringify(res));

  // D1 未绑定 → 必须写
  const kv2 = makeKv();
  const env2 = { img_url: kv2 };
  const res2 = await recordDuplicate(env2, 'sha-new', { publicId: 'r2:new.png' }, { ttlSeconds: TTL });
  check('D1 未绑定 → 写 KV', kv2._stats.put === 1);
  check('D1 未绑定 → written=true', res2.written === true);

  const kv3 = makeKv({}, { failPut: true });
  const res3 = await recordDuplicate({ img_url: kv3 }, 'sha-x', { a: 1 }, {});
  check('KV 写失败 → 不抛异常（去重失败不阻断上传）', res3.written === false);

  check('空 sha → 不写', (await recordDuplicate(makeEnvKv(), '', { a: 1 })).written === false);
  function makeEnvKv() { return { img_url: makeKv() }; }
}

/* ============================================================
 * [4] D1 未绑定：完整回落
 * ============================================================ */

console.log('[4] D1 未绑定 → 完整回落 KV');
{
  const kv = makeKv({
    [`${DEDUP_KEY_PREFIX}sha-legacy`]: {
      publicId: 'r2:legacy.png', fileName: 'legacy.png', size: 42,
      mime: 'image/png', storage: 'r2', uploadedAt: '2025-06-01T00:00:00.000Z',
    },
  });
  const env = { img_url: kv };

  const hit = await findDuplicate(env, 'sha-legacy', { ttlSeconds: TTL });
  check('D1 未绑定 → 回落 KV 并命中', hit?.kvKey === 'r2:legacy.png');
  check('D1 未绑定 → 字段完整', hit?.size === 42 && hit?.mime === 'image/png');
  check('D1 未绑定 → 确实读了 KV', kv._stats.get === 1);

  const kvFail = makeKv({}, { failGet: true });
  check('KV 读失败 → 返回 null 而非抛异常',
    (await findDuplicate({ img_url: kvFail }, 'sha-legacy', {})) === null);

  check('两条路都不可用 → null', (await findDuplicate({}, 'sha-legacy', {})) === null);
}

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
