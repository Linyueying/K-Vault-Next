/**
 * 回归测试：内容指纹（`contentSha`）必须随上传元数据落库。
 *
 * ============================================================================
 * 这个缺陷长什么样，以及为什么很难被发现
 * ============================================================================
 *
 * 症状：`POST /api/v1/upload` 带 `deduplicate=true` 时，**同一份内容反复上传
 * 永远不会秒传**，每次都实实在在存一份新的。
 *
 * 根因链：
 *
 *   · `v1/upload.js` 原先只在「需要查重」时才计算 SHA-256，且**算完即弃**；
 *   · D1 的 `files.content_sha` 列取自 `metadata.contentSha || metadata.sha256`
 *     （metadata-d1.js 的 metadataToColumns）；
 *   · 指纹从未写进元数据 → **首次上传的 D1 行 content_sha 恒为 NULL**；
 *   · 第二次上传查 `content_sha = <hash>`，自然一无所获。
 *
 * 为什么测试套件此前没抓住：`test-dedup-d1.mjs` 是直接往数据库里塞
 * `contentSha: 'sha-hit'` 的记录，再验证「能查出来」—— 它测的是**查询侧**，
 * 而缺口在**写入侧**。两侧各自都对，链起来才断。这正是本次要补的那一环。
 *
 * ============================================================================
 * 覆盖
 * ============================================================================
 *
 *   [1] 指纹写入：contentSha 必须出现在 KV 元数据里
 *   [2] D1 投影：写入后 content_sha 列不再为 NULL
 *   [3] ★ 端到端闭环：写一次 → 查得到 → 第二次能命中（缺陷的直接回归）
 *   [4] 不倒退：没传 contentSha 时不得把已有指纹擦掉
 *   [5] 分享字段与指纹可以同时写入（互不干扰）
 *
 * 运行：node scripts/test-kvault-upload.mjs 已含 CLI 侧；
 *       本文件：node scripts/test-upload-dedup-write.mjs
 */
import { applyApiUploadMetadata } from '../functions/api/v1/upload.js';
import { findDuplicate } from '../functions/utils/dedup-index.js';
import { getRecordWithKey } from '../functions/utils/file-record.js';
import { makeMigratedEnv, wrapAsD1, openMigratedDb } from './test-utils.mjs';

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

/** 带读写计数的 KV 替身（与项目其它测试同一套约定）。 */
function makeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    _store: store,
    async get(key, opts) {
      if (!store.has(key)) return null;
      const value = store.get(key);
      return opts?.type === 'json' ? value : JSON.stringify(value);
    },
    async getWithMetadata(key) {
      if (!store.has(key)) return null;
      const entry = store.get(key);
      return { metadata: entry?.metadata ?? null };
    },
    async put(key, value, opts) {
      const metadata = opts?.metadata ?? JSON.parse(value || '{}');
      store.set(key, { value, metadata });
    },
    async delete(key) {
      store.delete(key);
    },
    async list() {
      return { keys: [...store.keys()].map((name) => ({ name })), list_complete: true };
    },
  };
}

/** 组装一个「KV + D1 都在」的环境，并把某条文件记录预置好。 */
async function makeEnv(kvKey, initialMetadata = {}) {
  const base = makeMigratedEnv();
  const imgUrl = makeKv();
  const env = { ...base, img_url: imgUrl };
  // 预置 KV 记录，模拟「底层存储已把文件传完、元数据已就位」。
  await imgUrl.put(kvKey, '', { metadata: { ...initialMetadata } });
  return { env, imgUrl };
}

/* ============================================================
 * [1] 指纹写入 KV 元数据
 * ============================================================ */
console.log('\n[1] 指纹写入 KV 元数据');
{
  const kvKey = 'r2:r2_1_aaa.png';
  const { env, imgUrl } = await makeEnv(kvKey, {
    fileName: 'a.png',
    fileSize: 100,
    storageType: 'r2',
    TimeStamp: Date.now(),
  });

  await applyApiUploadMetadata(env, kvKey, { fileName: 'a.png', fileSize: 100 }, {
    contentSha: 'sha-target',
  });

  const stored = (await imgUrl.getWithMetadata(kvKey))?.metadata || {};
  check('contentSha 出现在 KV 元数据里', stored.contentSha === 'sha-target', JSON.stringify(stored.contentSha));
  check('原有字段未被破坏', stored.fileName === 'a.png' && stored.fileSize === 100, JSON.stringify(stored));
}

/* ============================================================
 * [2] D1 投影：content_sha 不再为 NULL
 * ============================================================ */
console.log('\n[2] D1 投影');
{
  const kvKey = 'r2:r2_2_bbb.png';
  const { env } = await makeEnv(kvKey, {
    fileName: 'b.png',
    fileSize: 200,
    storageType: 'r2',
    TimeStamp: Date.now(),
  });

  await applyApiUploadMetadata(env, kvKey, { fileName: 'b.png', fileSize: 200 }, {
    contentSha: 'sha-projected',
  });

  const row = env._db.prepare('SELECT content_sha FROM files WHERE content_sha IS NOT NULL').get();
  check('D1 里出现 content_sha 非空的记录', Boolean(row), '未找到任何非空 content_sha 行');
  check('content_sha 值正确', row?.content_sha === 'sha-projected', String(row?.content_sha));

  const nullCount = env._db
    .prepare('SELECT COUNT(*) AS c FROM files WHERE content_sha IS NULL')
    .get()?.c;
  check('不存在 content_sha 为 NULL 的文件行', Number(nullCount) === 0, `有 ${nullCount} 行为 NULL`);
}

/* ============================================================
 * [3] ★ 端到端闭环 —— 缺陷的直接回归
 * ============================================================ */
console.log('\n[3] 端到端闭环（写一次 → 查得到 → 能命中）');
{
  const kvKey = 'r2:r2_3_ccc.png';
  const { env } = await makeEnv(kvKey, {
    fileName: 'c.png',
    fileSize: 300,
    mime: 'image/png',
    storageType: 'r2',
    TimeStamp: Date.now(),
  });

  // 上传前：查不到（索引里还没有）
  const before = await findDuplicate(env, 'sha-loop');
  check('上传前查不到（对照）', before === null, JSON.stringify(before));

  // 走真实的元数据写入路径（这是修复点）
  await applyApiUploadMetadata(env, kvKey, { fileName: 'c.png', fileSize: 300, mime: 'image/png' }, {
    contentSha: 'sha-loop',
  });

  // 上传后：同一份内容应当查得到 —— 修复前这里必然返回 null
  const after = await findDuplicate(env, 'sha-loop', { ttlSeconds: 90 * 24 * 3600 });
  check('上传后能查到（★ 修复前此处失败）', Boolean(after?.kvKey), JSON.stringify(after));
  check('命中目标指向正确的文件', after?.kvKey === kvKey, String(after?.kvKey));
  check('命中带回了文件名', after?.fileName === 'c.png', String(after?.fileName));
  check('命中带回了大小', Number(after?.size) === 300, String(after?.size));
}

/* ============================================================
 * [4] 不倒退：未传 contentSha 时不得擦掉已有指纹
 * ============================================================ */
console.log('\n[4] 未传 contentSha 时的安全性');
{
  const kvKey = 'r2:r2_4_ddd.png';
  const { env, imgUrl } = await makeEnv(kvKey, {
    fileName: 'd.png',
    fileSize: 400,
    contentSha: 'sha-existing',
  });

  // 模拟「另一次不带指纹的上传」改动了分享设置
  await applyApiUploadMetadata(env, kvKey, (await imgUrl.getWithMetadata(kvKey)).metadata, {
    slug: 'my-slug',
  });

  const stored = (await imgUrl.getWithMetadata(kvKey))?.metadata || {};
  check('已有指纹被保留', stored.contentSha === 'sha-existing', JSON.stringify(stored.contentSha));
  check('分享 slug 写入成功', stored.shareSlug === 'my-slug', JSON.stringify(stored.shareSlug));

  const row = env._db.prepare('SELECT content_sha FROM files WHERE content_sha = ?').get('sha-existing');
  check('D1 侧指纹也仍在', Boolean(row), '指纹在 D1 丢失');
}

/* ============================================================
 * [5] 指纹与分享字段共存
 * ============================================================ */
console.log('\n[5] 指纹与分享字段共存');
{
  const kvKey = 'r2:r2_5_eee.png';
  const { env, imgUrl } = await makeEnv(kvKey, { fileName: 'e.png', fileSize: 500 });

  await applyApiUploadMetadata(env, kvKey, { fileName: 'e.png', fileSize: 500 }, {
    contentSha: 'sha-combo',
    slug: 'combo',
    expiresIn: 3600,
    maxDownloads: 5,
    password: 'pw123',
  });

  const stored = (await imgUrl.getWithMetadata(kvKey))?.metadata || {};
  check('指纹写入', stored.contentSha === 'sha-combo', JSON.stringify(stored.contentSha));
  check('slug 写入', stored.shareSlug === 'combo', JSON.stringify(stored.shareSlug));
  check('有效期写入', Number(stored.shareExpiresAt) > Date.now(), String(stored.shareExpiresAt));
  check('下载次数写入', Number(stored.shareMaxDownloads) === 5, String(stored.shareMaxDownloads));
  check('密码写入（哈希 + 盐）', Boolean(stored.sharePasswordHash) && Boolean(stored.sharePasswordSalt));

  const row = env._db.prepare('SELECT content_sha, share_slug FROM files WHERE content_sha = ?').get('sha-combo');
  check('D1 行上指纹与 slug 并存', row?.content_sha === 'sha-combo' && row?.share_slug === 'combo', JSON.stringify(row));
}

/* ============================================================
 * 汇总
 * ============================================================ */
console.log('');
if (fail === 0) {
  console.log(`✅ 上传指纹落库回归全部通过：${pass} 项断言，0 失败。`);
  process.exit(0);
} else {
  console.log(`❌ 上传指纹落库回归失败：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）。`);
  process.exit(1);
}
