/**
 * 缩略图管线的契约测试。
 *
 * ============================================================================
 * 这套件守的是四件容易在改动中悄悄失效的事
 * ============================================================================
 *   1. **key 派生**：缩略图不写元数据，全靠「原文件 key → 附属键」这条纯函数
 *      关系定位。它一旦漂移，缩略图就会静默变成孤儿（写进去、读不到）。
 *   2. **后端选择**：kv / d1 / r2 三者平级且由用户显式指定，**不自动降级**；
 *      未绑定的后端写入必须直接失败，而不是换个地方偷偷写。
 *   3. **读取的免配置读**：单后端部署（默认 kv）的图片热路径不应回源配置 ——
 *      这既省一次 KV 往返，也避免依赖 30 秒 isolate 缓存这种运气。
 *   4. **前端 URL 转换**：/file/ → /thumb/ 且**保留 query**（分享密码靠它
 *      透传给 /file/ 做鉴权），同时对外部链接与已转换过的地址保持幂等。
 *
 * 运行：node scripts/test-thumb.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  putThumb,
  getThumb,
  deleteThumb,
  thumbKvKey,
  thumbR2Key,
  parseFileKey,
  availableThumbBackends,
  THUMB_MAX_BYTES,
  THUMB_D1_TABLE,
} from '../functions/utils/thumb-store.js';
import { saveRuntimeConfig } from '../functions/utils/runtime-config.js';
import { validateThumb } from '../functions/api/manage/settings.js';

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const eq = (label, actual, expected) =>
  check(label, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);

/* ---------------------------------------------------------------- mock 绑定 */
let kvReads = 0;

function makeKv() {
  const store = new Map();
  return {
    _store: store,
    async put(key, value, opts) { store.set(key, { value, metadata: opts?.metadata }); },
    async delete(key) { store.delete(key); },
    async get(key, opts) {
      kvReads += 1;
      const hit = store.get(key);
      if (!hit) return null;
      if (opts && opts.type === 'json' && typeof hit.value === 'string') {
        try { return JSON.parse(hit.value); } catch { return null; }
      }
      return hit.value;
    },
    async getWithMetadata(key) {
      kvReads += 1;
      const hit = store.get(key);
      return hit ? { value: hit.value, metadata: hit.metadata } : { value: null, metadata: null };
    },
  };
}

function makeR2() {
  const store = new Map();
  return {
    _store: store,
    async put(key, value, opts) { store.set(key, { value, httpMetadata: opts?.httpMetadata }); },
    async delete(key) { store.delete(key); },
    async get(key) {
      const hit = store.get(key);
      return hit ? { body: hit.value, size: 0, httpMetadata: hit.httpMetadata } : null;
    },
  };
}

/** 极简 D1 替身：只认本模块实际发出的那几条语句。 */
function makeD1() {
  const rows = new Map();
  return {
    _rows: rows,
    prepare(sql) {
      const stmt = {
        _sql: sql,
        _params: [],
        bind(...args) { stmt._params = args; return stmt; },
        async run() {
          if (new RegExp(`INSERT INTO ${THUMB_D1_TABLE}`, 'i').test(stmt._sql)) {
            const [id, thumb, contentType, updatedAt] = stmt._params;
            rows.set(id, { thumb, content_type: contentType, updated_at: updatedAt });
            return { success: true };
          }
          if (new RegExp(`DELETE FROM ${THUMB_D1_TABLE}`, 'i').test(stmt._sql)) {
            rows.delete(stmt._params[0]);
            return { success: true };
          }
          throw new Error(`unexpected statement: ${stmt._sql}`);
        },
        async first() {
          return rows.get(stmt._params[0]) || null;
        },
      };
      return stmt;
    },
  };
}

const bytes = (n) => new Uint8Array(n).fill(7);

/** 建一个环境并**显式设定**缩略图后端（走真实的运行时配置写入）。 */
async function makeEnv({ kv = true, d1 = false, r2 = false, backend = 'kv' } = {}) {
  const env = {};
  if (kv) env.img_url = makeKv();
  if (d1) env.DB = makeD1();
  if (r2) env.R2_BUCKET = makeR2();
  if (kv) await saveRuntimeConfig(env, 'thumb', { backend });
  return env;
}

/* ------------------------------------------------------------------- [1] */
console.log('\n[1] 附属 key 由原文件 key 纯派生');
{
  eq('KV 键前缀', thumbKvKey('r2:r2_1_ab.png'), 'thumb:r2:r2_1_ab.png');
  eq('R2 对象键前缀', thumbR2Key('r2:r2_1_ab.png'), 'thumb/r2:r2_1_ab.png');
  eq('Telegram 无前缀 key 同样适用', thumbKvKey('12345.jpg'), 'thumb:12345.jpg');
  eq('空 key 不炸', thumbKvKey(undefined), 'thumb:');
}

/* ------------------------------------------------------------------- [2] */
console.log('\n[2] 路由参数 → 文件 key');
{
  eq('单段路径', parseFileKey({ path: 'r2:abc.png' }), 'r2:abc.png');
  eq('数组路径按 / 拼接', parseFileKey({ path: ['a', 'b.png'] }), 'a/b.png');
  eq('百分号编码被还原', parseFileKey({ path: 'r2%3Aabc.png' }), 'r2:abc.png');
  eq('前导斜杠被剥掉', parseFileKey({ path: '/abc.png' }), 'abc.png');
  eq('缺失参数返回空串', parseFileKey({}), '');
}

/* ------------------------------------------------------------------- [3] */
console.log('\n[3] 冷起点：单后端读取不回源配置');
{
  /* 必须放在所有 saveRuntimeConfig 之前 —— 本进程的 thumb 配置此刻还没被读过，
     缓存为空，因此「读没读配置」能被 KV 读数如实反映出来。
     缩略图直接用 kv.put 塞进去（不走 putThumb），避免顺带填充配置缓存。 */
  const kv = makeKv();
  await kv.put(thumbKvKey('img:cold.jpg'), bytes(500), { metadata: { contentType: 'image/webp' } });
  kvReads = 0;
  const hit = await getThumb({ img_url: kv }, 'img:cold.jpg');
  eq('读得到', Boolean(hit), true);
  eq('★ 只花 1 次 KV 读（若回源配置会是 2 次）', kvReads, 1);
}

/* ------------------------------------------------------------------- [4] */
console.log('\n[4] 可用后端探测（未绑定的不进列表）');
{
  eq('只有 KV', JSON.stringify(availableThumbBackends({ img_url: makeKv() })), '["kv"]');
  eq('KV + D1', JSON.stringify(availableThumbBackends({ img_url: makeKv(), DB: makeD1() })), '["kv","d1"]');
  eq('三者齐全', JSON.stringify(availableThumbBackends({ img_url: makeKv(), DB: makeD1(), R2_BUCKET: makeR2() })), '["kv","d1","r2"]');
  eq('什么都没有', JSON.stringify(availableThumbBackends({})), '[]');
}

/* ------------------------------------------------------------------- [5] */
console.log('\n[5] 三后端各自的写入与读取');
{
  // KV（默认）
  const kvEnv = await makeEnv({ backend: 'kv' });
  const r1 = await putThumb(kvEnv, 'img:a.jpg', bytes(1000), { contentType: 'image/webp' });
  eq('默认后端写入落到 KV', r1.backend, 'kv');
  eq('读回 Content-Type', (await getThumb(kvEnv, 'img:a.jpg'))?.contentType, 'image/webp');

  // D1
  const d1Env = await makeEnv({ d1: true, backend: 'd1' });
  const r2 = await putThumb(d1Env, 'img:b.jpg', bytes(1200), { contentType: 'image/webp' });
  eq('指定 d1 落到 D1', r2.backend, 'd1');
  eq('D1 表里有一行', d1Env.DB._rows.size, 1);
  const h2 = await getThumb(d1Env, 'img:b.jpg');
  eq('从 D1 读回', Boolean(h2), true);
  eq('D1 读回的字节数', h2?.size, 1200);

  // R2
  const r2Env = await makeEnv({ r2: true, backend: 'r2' });
  const r3 = await putThumb(r2Env, 'r2:c.jpg', bytes(900));
  eq('指定 r2 落到 R2', r3.backend, 'r2');
  eq('R2 对象存在', r2Env.R2_BUCKET._store.size, 1);
  eq('从 R2 读回', Boolean(await getThumb(r2Env, 'r2:c.jpg')), true);
}

/* ------------------------------------------------------------------- [6] */
console.log('\n[6] 显式指定，不静默降级');
{
  // 配置说 r2，但这套部署没绑 R2 → 写入必须直接失败，而不是改用 KV
  const env = await makeEnv({ r2: false, backend: 'r2' });
  const res = await putThumb(env, 'k.png', bytes(500));
  eq('未绑定的后端 → no-backend', res.reason, 'no-backend');
  eq('★ 没有偷偷写进 KV', env.img_url._store.has(thumbKvKey('k.png')), false);
  eq('读取也读不到', await getThumb(env, 'k.png'), null);

  eq('无任何可用后端 → no-backend', (await putThumb({}, 'k', bytes(10))).reason, 'no-backend');
  eq('无任何可用后端时读取返回 null', await getThumb({}, 'k'), null);
}

/* ------------------------------------------------------------------- [7] */
console.log('\n[7] 多后端时按配置选择');
{
  const env = await makeEnv({ d1: true, r2: true, backend: 'd1' });
  await putThumb(env, 'img:multi.jpg', bytes(700));
  eq('按配置落 D1', env.DB._rows.has('img:multi.jpg'), true);
  eq('R2 里没有', env.R2_BUCKET._store.size, 0);
  eq('读回正确', Boolean(await getThumb(env, 'img:multi.jpg')), true);

  /* 配置的后端被解绑 → 读取回落到第一个可用项（KV）。
     刻意**不做跨后端探测**：探测会把「配置改过一次」的代价转嫁给此后每一次
     图片读取。读不到就 302 回原图，下次上传自然写到新后端。 */
  await saveRuntimeConfig(env, 'thumb', { backend: 'r2' });
  delete env.R2_BUCKET;
  eq('配置后端解绑后回落到 KV（文件不在 KV，故读不到）', await getThumb(env, 'img:multi.jpg'), null);
}

/* ------------------------------------------------------------------- [8] */
console.log('\n[8] 删除清理所有已配置后端（防止改配置后留下孤儿）');
{
  const env = await makeEnv({ d1: true, r2: true, backend: 'kv' });
  const key = 'img:x.jpg';
  // 模拟「历史上换过后端，三个地方都留了副本」
  await env.img_url.put(thumbKvKey(key), bytes(10));
  await env.DB.prepare(`INSERT INTO ${THUMB_D1_TABLE} (id, thumb, content_type, updated_at) VALUES (?,?,?,?)`)
    .bind(key, bytes(10), 'image/webp', Date.now()).run();
  await env.R2_BUCKET.put(thumbR2Key(key), bytes(10));

  await deleteThumb(env, key);
  eq('KV 侧已删', env.img_url._store.has(thumbKvKey(key)), false);
  eq('D1 侧已删', env.DB._rows.has(key), false);
  eq('R2 侧已删', env.R2_BUCKET._store.has(thumbR2Key(key)), false);
}

/* ------------------------------------------------------------------- [9] */
console.log('\n[9] 防御性拒绝');
{
  const env = await makeEnv({ backend: 'kv' });
  eq('空 body 被拒', (await putThumb(env, 'k', new Uint8Array(0))).reason, 'empty');
  eq('超过体积上限被拒', (await putThumb(env, 'k', bytes(THUMB_MAX_BYTES + 1))).reason, 'too-large');
  eq('空 key 被拒', (await putThumb(env, '', bytes(10))).reason, 'invalid');
  eq('空 key 读取返回 null', await getThumb(env, ''), null);
}

/* ------------------------------------------------------------------ [10] */
console.log('\n[10] 后台保存校验：未绑定的后端必须被拒');
{
  const onlyKv = { img_url: makeKv() };
  eq('可用后端之外的取值被拒', Boolean(validateThumb({ backend: 'r2' }, onlyKv).error), true);
  eq('白名单外的取值被拒', Boolean(validateThumb({ backend: 'ftp' }, onlyKv).error), true);
  eq('可用后端被接受', validateThumb({ backend: 'kv' }, onlyKv).ok, true);
  eq('只改尺寸时不校验后端', validateThumb({ maxEdge: 600 }, onlyKv).ok, true);
  eq('尺寸越界被拒', Boolean(validateThumb({ maxEdge: 9999 }, onlyKv).error), true);
  eq('质量越界被拒', Boolean(validateThumb({ quality: 2 }, onlyKv).error), true);
  eq('绑了 D1 后可选 d1', validateThumb({ backend: 'd1' }, { img_url: makeKv(), DB: makeD1() }).ok, true);
  eq('绑了 R2 后可选 r2', validateThumb({ backend: 'r2' }, { img_url: makeKv(), R2_BUCKET: makeR2() }).ok, true);
}

/* ------------------------------------------------------------------ [11] */
console.log('\n[11] 前端共享层：URL 转换与缩略图生成前检');
{
  // app-core.js 是 IIFE，只依赖 window；用最小替身求值即可在 node 里测。
  globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
  globalThis.document = undefined;
  const coreSrc = fs.readFileSync(path.join(import.meta.dirname, '../assets/js/app-core.js'), 'utf8');
  new Function(coreSrc)();
  const { thumbUrl, makeThumbnail } = globalThis.window.KVault;

  eq('相对直链被换成缩略图', thumbUrl('/file/r2:abc.png'), '/thumb/r2:abc.png');
  eq('绝对直链同样处理', thumbUrl('https://x.dev/file/a.png'), 'https://x.dev/thumb/a.png');
  eq('★ query 被保留（分享密码靠它透传）', thumbUrl('/file/a.png?password=p1'), '/thumb/a.png?password=p1');
  eq('★ 已转换过的地址保持幂等', thumbUrl('/thumb/a.png'), '/thumb/a.png');
  eq('外部链接原样返回', thumbUrl('https://cdn.example.com/a.png'), 'https://cdn.example.com/a.png');
  eq('空值不炸', thumbUrl(null), '');

  eq('非图片不生成缩略图', await makeThumbnail({ type: 'application/pdf', size: 1 << 20 }), null);
  eq('SVG 不生成（矢量缩放无意义）', await makeThumbnail({ type: 'image/svg+xml', size: 1 << 20 }), null);
  eq('GIF 不生成（缩放会丢动画）', await makeThumbnail({ type: 'image/gif', size: 1 << 20 }), null);
  eq('小图不生成（生成物可能反而更大）', await makeThumbnail({ type: 'image/png', size: 1024 }), null);
}

/* ------------------------------------------------------------------ 汇总 */
console.log(`\n${'='.repeat(60)}`);
console.log(`结果：${fail === 0 ? '全部通过' : '有失败'}`);
console.log(`  通过 ${pass} / 失败 ${fail}`);
console.log('='.repeat(60));
process.exit(fail === 0 ? 0 : 1);
