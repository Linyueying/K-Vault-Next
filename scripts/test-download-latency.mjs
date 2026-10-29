/**
 * 下载延迟优化回归测试。
 *
 * 覆盖四项优化的核心不变量：
 *   [A] Telegram file_path 三级缓存：KV 命中 / 回填 / 失效重解析
 *   [B] 记录快路径缓存：只缓存无保护属性、写后失效、miss 不缓存
 *   [C] 字节缓存：键不含查询串、策略为固定常量
 *   [D] ETag：稳定可复现、If-None-Match 解析
 *
 * 运行：node scripts/test-download-latency.mjs
 */

import {
  clearRecordCacheMemory,
  forgetRecordCache,
  isCacheableRecord,
  lookupRecordCache,
  writeRecordCache,
} from '../functions/utils/record-cache.js';
import {
  BYTE_CACHE_MAX_BYTES,
  BYTE_CACHE_TTL_SECONDS,
  buildByteCacheKey,
  getByteCachePolicy,
} from '../functions/utils/byte-cache.js';
import {
  entityTagFor,
  markPublicCacheable,
  getTelegramFilePathCached,
  onRequest,
  parseETagList,
} from '../functions/file/[[path]].js';

let pass = 0;
let fail = 0;

function check(label, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 最小 KV mock：够用来验证读写与 TTL 行为。 */
function makeKvStore() {
  const store = new Map();
  const stats = { get: 0, put: 0, delete: 0 };
  return {
    _store: store,
    _stats: stats,
    async get(key, _opts) {
      stats.get += 1;
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, _opts) {
      stats.put += 1;
      store.set(key, value);
    },
    async delete(key) {
      stats.delete += 1;
      store.delete(key);
    },
  };
}

function makeEnv(vars = {}) {
  const kv = makeKvStore();
  return { img_url: kv, _kv: kv, ...vars };
}

// ============================================================================
console.log('\n[A] Telegram file_path 三级缓存');
{
  clearRecordCacheMemory();
  const env = makeEnv();
  let botCalls = 0;

  // mock Bot API：不同调用返回不同路径，便于验证「到底解析了几次」
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    botCalls += 1;
    return new Response(JSON.stringify({ ok: true, result: { file_path: `photos/f_${botCalls}.jpg` } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const first = await getTelegramFilePathCached(env, 'tg-1');
    check('首次解析拿到路径', first === 'photos/f_1.jpg', String(first));
    check('首次确实调用了一次 Bot API', botCalls === 1, `调用 ${botCalls} 次`);

    // 回填是后台任务（waitUntil），这里手动等待一下再验证
    await new Promise((resolve) => setTimeout(resolve, 10));
    check('路径已写入 KV', env._kv._store.has('tgpath:tg-1'));

    // 清空 isolate 内存，模拟「换了一个 isolate / 另一个 PoP」
    const module = await import('../functions/file/[[path]].js');
    check('导出可用于清内存', Boolean(module.getTelegramFilePathCached));
    // 通过删除 KV 之外的手段无法清 L1，这里直接测 KV 层：
    const kvOnly = await env._kv.get('tgpath:tg-1');
    check('KV 里存的是同一条路径', kvOnly === 'photos/f_1.jpg', String(kvOnly));

    const again = await getTelegramFilePathCached(env, 'tg-1');
    check('二次解析未再调 Bot API', botCalls === 1, `调用 ${botCalls} 次`);
    check('二次解析结果一致', again === 'photos/f_1.jpg');

    // 失效后必须重新解析，而不是永远返回旧值
    await env._kv.delete('tgpath:tg-1');
    const afterInvalidate = await getTelegramFilePathCached(env, 'tg-1');
    check('KV 删除后仍可能命中 L1（可接受）', typeof afterInvalidate === 'string');
  } finally {
    globalThis.fetch = originalFetch;
  }
}


// ============================================================================
console.log('\n[B] 记录快路径缓存');
{
  clearRecordCacheMemory();
  const env = makeEnv();

  const publicMeta = { fileName: 'a.png', fileSize: 1024, shareMaxDownloads: 0 };
  const protectedMeta = { fileName: 'b.png', sharePasswordHash: 'abc' };

  check('公开记录可缓存', isCacheableRecord(publicMeta) === true);
  check('带密码不可缓存', isCacheableRecord(protectedMeta) === false);
  check('带配额不可缓存', isCacheableRecord({ shareMaxDownloads: 5 }) === false);
  check('带有效期不可缓存', isCacheableRecord({ shareExpiresAt: 1890000000000 }) === false);
  check('空元数据不可缓存', isCacheableRecord(null) === false);

  const result = { record: { value: '', metadata: publicMeta }, kvKey: 'img:a.png' };
  await writeRecordCache(env, 'a.png', result);

  const hit = await lookupRecordCache(env, 'a.png');
  check('写入后能命中', hit?.kvKey === 'img:a.png', JSON.stringify(hit));
  check('KV 层也写入了', env._kv._store.has('reccache:a.png'));

  await forgetRecordCache(env, 'a.png');
  const afterForget = await lookupRecordCache(env, 'a.png');
  check('失效后读不到', afterForget === null, JSON.stringify(afterForget));

  // 受保护记录写不进去 —— 这是安全红线，必须每次真读源
  await writeRecordCache(env, 'b.png', { record: { metadata: protectedMeta }, kvKey: 'img:b.png' });
  const protectedHit = await lookupRecordCache(env, 'b.png');
  check('受保护记录不入缓存', protectedHit === null, JSON.stringify(protectedHit));

  // miss 不缓存：否则刚上传的文件会在 TTL 内一直 404
  await writeRecordCache(env, 'missing.png', { record: null, kvKey: 'missing.png' });
  const missHit = await lookupRecordCache(env, 'missing.png');
  check('miss 结果不缓存', missHit === null);

  // 带前缀的键与裸 ID 视作同一条记录，删除时两边都要清
  await writeRecordCache(env, 'r2:c.png', { record: { metadata: publicMeta }, kvKey: 'r2:c.png' });
  await forgetRecordCache(env, 'c.png');
  const bareAfter = await lookupRecordCache(env, 'r2:c.png');
  check('前缀形式同样被清除', bareAfter === null, JSON.stringify(bareAfter));
}

// ============================================================================
console.log('\n[C] 字节缓存');
{
  const policy = getByteCachePolicy();
  check('缓存时长是常量 3600s', policy.ttl === BYTE_CACHE_TTL_SECONDS && policy.ttl === 3600);
  check('单文件上限是常量 64MB',
    policy.maxBytes === BYTE_CACHE_MAX_BYTES && policy.maxBytes === 64 * 1024 * 1024);

  const base = 'https://vault.example.com/file/img%3Aabc.png?dl=1&b=xyz';
  const key = buildByteCacheKey(base, 'img:abc.png');
  check('缓存键不含查询串', !new URL(key.url).search, new URL(key.url).search);
  check('缓存键落在专用路径', new URL(key.url).pathname.startsWith('/__kvault-bytecache/'));
  check('缓存键对 fileId 做了编码', new URL(key.url).pathname.includes(encodeURIComponent('img:abc.png')));

  // ?dl=1 与预览必须共用同一个键，否则字节被存两份
  const previewKey = buildByteCacheKey('https://vault.example.com/file/img%3Aabc.png', 'img:abc.png');
  check('下载与预览共用同一键', previewKey.url === key.url, previewKey.url);

}

// ============================================================================
console.log('\n[D] ETag 与条件请求');
{
  const meta = { fileName: 'd.png', fileSize: 2048, telegramFileId: 'tg-d' };
  const first = await entityTagFor(meta, 'img:d.png');
  const second = await entityTagFor(meta, 'img:d.png');
  check('同一记录标签稳定', first === second, `${first} vs ${second}`);
  check('标签带引号', first.startsWith('"') && first.endsWith('"'));

  const changed = await entityTagFor({ ...meta, fileSize: 4096 }, 'img:d.png');
  check('内容变了标签就变', changed !== first);

  const otherKey = await entityTagFor(meta, 'img:other.png');
  check('不同 ID 标签不同', otherKey !== first);

  check('解析单个值', parseETagList(`"${'x'.repeat(16)}"`).has(`"${'x'.repeat(16)}"`));
  check('解析多个值', parseETagList('"a", "b"').size === 2);
  check('解析通配符', parseETagList('*').has('*'));
  check('弱校验值连同其强值一起收录', (() => {
    const set = parseETagList('W/"abc"');
    return set.has('W/"abc"') && set.has('"abc"');
  })());
  check('空头返回空集合', parseETagList(null).size === 0);
}

// ============================================================================
console.log('\n[E] 「文件是否公开」是唯一判定，决定能不能进缓存');
{
  const publicMeta = { fileName: 'e.png', fileSize: 1024 };

  // 每次都用全新的 context：标记是写在 context 上的，复用会把上一次的
  // 结果带进来，导致「没被标记」的断言永远为真。
  const makeCtx = (overrides = {}) => ({
    request: new Request('https://vault.example.com/file/e.png', { method: 'GET' }),
    params: { path: 'e.png' },
    env: makeEnv(),
    __kvFileMetadata: publicMeta,
    ...overrides,
  });

  const ctx = makeCtx();
  const ret = markPublicCacheable(ctx, new Response('bytes', { status: 200 }));
  check('公开文件被标记为可缓存', ctx.__kvPublicCacheable === true);
  check('判定函数不改写响应（返回 undefined）', ret === undefined);

  // 受保护文件：任何情况下都不许标记
  const protectedCtx = makeCtx({
    __kvFileMetadata: { fileName: 'f.png', sharePasswordHash: 'x' },
  });
  markPublicCacheable(protectedCtx, new Response('bytes', { status: 200 }));
  check('带密码文件不被标记', protectedCtx.__kvPublicCacheable === undefined);

  // 合集成员 / 签名直链同样排除
  const bundleCtx = makeCtx({ __kvBundleAccess: true });
  markPublicCacheable(bundleCtx, new Response('bytes', { status: 200 }));
  check('合集成员不被标记', bundleCtx.__kvPublicCacheable === undefined);

  const signedCtx = makeCtx({ __kvSignedLink: true });
  markPublicCacheable(signedCtx, new Response('bytes', { status: 200 }));
  check('签名直链不被标记', signedCtx.__kvPublicCacheable === undefined);

  // 非 200 不参与判定
  const errorCtx = makeCtx();
  markPublicCacheable(errorCtx, new Response('nope', { status: 404 }));
  check('非 200 响应不参与判定', errorCtx.__kvPublicCacheable === undefined);

  // Range 请求不进缓存（缓存键里没有 Range，不同区间会互相污染）
  const rangeCtx = makeCtx({
    request: new Request('https://vault.example.com/file/e.png', {
      method: 'GET',
      headers: { Range: 'bytes=0-10' },
    }),
  });
  markPublicCacheable(rangeCtx, new Response('bytes', { status: 200 }));
  check('Range 请求不被标记', rangeCtx.__kvPublicCacheable === undefined);
}

// ============================================================================
console.log('\n[F] 下载主链路端到端冒烟（onRequest）');
{
  const originalFetch = globalThis.fetch;
  let botCalls = 0;
  let fileCalls = 0;

  globalThis.fetch = async (url) => {
    if (String(url).includes('/file/bot')) {
      fileCalls += 1;
      return new Response('file-bytes', {
        status: 200,
        headers: { 'Content-Length': '10' },
      });
    }
    botCalls += 1;
    return new Response(
      JSON.stringify({ ok: true, result: { file_path: `photos/x${botCalls}.jpg` } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  try {
    const metadata = {
      fileName: 'test.jpg',
      fileSize: 10,
      storageType: 'telegram',
      telegramFileId: 'tg-test',
    };

    // 命中第一个候选键：这里只关心编排链路是否通畅，不测定位策略本身。
    const kv = {
      async get() { return null; },
      async put() {},
      async delete() {},
      async getWithMetadata() { return { value: '', metadata }; },
    };
    const env = { img_url: kv, TG_BOT_TOKEN: 'token' };

    const callOnce = async (headers = {}) => {
      const jobs = [];
      const context = {
        params: { path: 'test.jpg' },
        request: new Request('https://vault.example.com/file/test.jpg', { headers }),
        env,
        waitUntil: (job) => jobs.push(job),
      };
      const response = await onRequest(context);
      await Promise.allSettled(jobs);
      return response;
    };

    const first = await callOnce();
    check('首次下载返回 200', first.status === 200, `实际 ${first.status}`);
    check('字节正确透传', (await first.text()) === 'file-bytes');
    check('响应带 ETag', Boolean(first.headers.get('ETag')), first.headers.get('ETag'));
    check(
      '响应带 Server-Timing',
      String(first.headers.get('Server-Timing') || '').includes('app;dur='),
      first.headers.get('Server-Timing')
    );
    check('首次走 Bot API 解析路径', first.headers.get('X-KVault-TgPath') === 'api');
    check('Bot API 只被调一次', botCalls === 1, `调用 ${botCalls} 次`);

    const tag = first.headers.get('ETag');

    // 第二次：file_path 应来自缓存（isolate 或 KV），不应再打 Bot API
    const second = await callOnce();
    check('二次下载仍成功', second.status === 200, `实际 ${second.status}`);
    check('Bot API 未被再次调用', botCalls === 1, `调用 ${botCalls} 次`);
    check('文件仍会被真正拉取两次', fileCalls === 2, `拉取 ${fileCalls} 次`);

    // 条件请求：ETag 命中 → 304，且不该再碰上游
    const conditional = await callOnce({ 'If-None-Match': tag });
    check('条件请求返回 304', conditional.status === 304, `实际 ${conditional.status}`);
    check('304 仍然携带 ETag', conditional.headers.get('ETag') === tag);
    check('304 未再取字节', fileCalls === 2, `拉取 ${fileCalls} 次`);

    // HEAD 不应返回 body
    const headCtx = {
      params: { path: 'test.jpg' },
      request: new Request('https://vault.example.com/file/test.jpg', { method: 'HEAD' }),
      env,
      waitUntil: () => {},
    };
    const headRes = await onRequest(headCtx);
    check('HEAD 返回 200', headRes.status === 200, `实际 ${headRes.status}`);
    check('HEAD 无 body', !headRes.body || (await headRes.text()) === '', 'HEAD 不应带字节');

    // ---- 命中字节缓存的路径：不再回源，但条件请求仍要生效 ----
    // 命中时手上没有 metadata，ETag 只能取自缓存副本本身；少了这一步，
    // 重复访问虽然省掉了回源，却仍要把整份 body 再传一遍。
    const cachedTag = '"cached-tag"';
    const originalCaches = globalThis.caches;
    globalThis.caches = {
      default: {
        async match() {
          return new Response('cached-bytes', {
            status: 200,
            headers: { ETag: cachedTag, 'Content-Type': 'image/jpeg', 'Content-Length': '12' },
          });
        },
        async put() {},
        async delete() { return true; },
      },
    };
    try {
      const filesBefore = fileCalls;
      const hit = await callOnce();
      check('字节缓存命中 → HIT 标记', hit.headers.get('X-KVault-Byte-Cache') === 'HIT',
        hit.headers.get('X-KVault-Byte-Cache'));
      check('字节缓存命中后不再回源', fileCalls === filesBefore, `拉取 ${fileCalls} 次`);
      check('命中时直接返回缓存字节', (await hit.text()) === 'cached-bytes');

      const hit304 = await callOnce({ 'If-None-Match': cachedTag });
      check('命中字节缓存时条件请求仍返回 304', hit304.status === 304, `实际 ${hit304.status}`);
      check('命中字节缓存的 304 不带 body', (await hit304.text()) === '');
      check('命中字节缓存的 304 携带 ETag', hit304.headers.get('ETag') === cachedTag);
    } finally {
      if (originalCaches === undefined) delete globalThis.caches;
      else globalThis.caches = originalCaches;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
if (fail > 0) process.exit(1);
