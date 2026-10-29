/**
 * perf 配置组回归测试（后台「性能优化」面板）。
 *
 * ============================================================================
 * 为什么单独一个套件
 * ============================================================================
 *
 * 这一组开关的特性有两个，都容易被写错且**不会报错**：
 *
 *   1. **默认全开**。写错成默认关，优化会静默失效，用户只是觉得"好像没变快"；
 *      反过来若某项不该默认开却写成了开，又会悄悄引入一致性窗口。
 *   2. **部分更新不能重置其它字段**。后台一次只提交整组，但 KV 可能被手改，
 *      一个只写了 `recordCache:false` 的记录不该顺手把字节缓存也关掉。
 *
 * ============================================================================
 * 覆盖
 * ============================================================================
 *
 *   [1] 默认值全开且正确
 *   [2] 环境变量向后兼容：=1 / =0 / =on / =off / =yes / =no 都能识别
 *   [3] 部分更新不重置未提交的字段
 *   [4] 数值夹取（TTL 上下限、字节上限）
 *   [5] KV 覆盖优先于环境变量；reset 后回落到环境变量
 *   [6] settings API：下发字段、校验规则、保存、重置
 *   [7] 失效联动：删除 / 改名 / 加密码必须清边缘副本
 *
 * 运行：node scripts/test-perf-settings.mjs
 */
import {
  normalizePerfConfig,
  readPerfConfigFromEnv,
  getPerfConfig,
  invalidateRuntimeConfigCache,
  CONFIG_GROUPS,
} from '../functions/utils/runtime-config.js';
import {
  validatePerf,
  onRequestGet,
  onRequestPost,
  onRequestDelete,
} from '../functions/api/manage/settings.js';
import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** 带计数的最小 KV 替身。 */
function makeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  const stats = { get: 0, put: 0, delete: 0 };
  return {
    _store: store,
    _stats: stats,
    async get(key, opts) {
      stats.get += 1;
      if (!store.has(key)) return null;
      const value = store.get(key);
      return opts?.type === 'json' ? value : String(value);
    },
    async put(key, value) {
      stats.put += 1;
      store.set(key, JSON.parse(value));
    },
    async delete(key) {
      stats.delete += 1;
      store.delete(key);
    },
  };
}

const makeEnv = (vars = {}, kvData = {}) => ({ img_url: makeKv(kvData), ...vars });

/**
 * 每个用例前清缓存。
 *
 * 配置缓存是模块级的、不区分 env 实例（生产上一个 isolate 一份），
 * 不清会让上一个用例的配置泄漏到下一个。
 */
const fresh = () => invalidateRuntimeConfigCache();

const MB = 1024 * 1024;

// ============================================================================
console.log('[1] 默认值：四项全部开启（开箱即用，无需配置）');
{
  const base = readPerfConfigFromEnv({});
  check('Telegram 路径缓存默认开', base.tgFilePathPersist === true);
  check('记录定位缓存默认开', base.recordCache === true);
  check('字节缓存默认开', base.publicByteCache === true);
  check('上传预热默认开', base.warmOnUpload === true);
  check('记录缓存时长默认 60s', base.recordCacheTtl === 60);
  check('字节缓存时长默认 3600s', base.publicByteCacheTtl === 3600);
  check('单文件上限默认 64MB', base.publicByteCacheMaxBytes === 64 * MB);
}

// ============================================================================
console.log('[2] 环境变量向后兼容（=1 / =0 / =on 等写法）');
{
  // 这一组开关最早就是按 `=1` 上线的，许多人已经在 Dashboard 配好了。
  // 若这里退化成只认 'true' / 'false'，升级会把已配好的开关静默反转。
  const cases = [
    ['RECORD_CACHE', '1', true],
    ['RECORD_CACHE', 'true', true],
    ['RECORD_CACHE', 'on', true],
    ['RECORD_CACHE', 'yes', true],
    ['RECORD_CACHE', '0', false],
    ['RECORD_CACHE', 'false', false],
    ['RECORD_CACHE', 'off', false],
    ['RECORD_CACHE', 'no', false],
  ];
  for (const [key, val, expected] of cases) {
    const cfg = readPerfConfigFromEnv({ [key]: val });
    check(`${key}=${val} → ${expected}`, cfg.recordCache === expected, String(cfg.recordCache));
  }

  // 关键方向：文档里给出的关闭示例是 TG_FILE_PATH_PERSIST=0。
  // 若 '0' 没被识别为 false，就会出现"管理员以为关了实际还开着"。
  const turnedOff = readPerfConfigFromEnv({ TG_FILE_PATH_PERSIST: '0' });
  check('TG_FILE_PATH_PERSIST=0 真的关掉了', turnedOff.tgFilePathPersist === false);
  const bogus = readPerfConfigFromEnv({ TG_FILE_PATH_PERSIST: 'maybe' });
  check('未识别的取值回落默认（开）', bogus.tgFilePathPersist === true);
}

// ============================================================================
console.log('[3] 部分更新不重置未提交的字段');
{
  fresh();
  const base = readPerfConfigFromEnv({});
  // 后台一次可能只提交一个开关（尤其将来做局部保存时）。
  // 关键方向：单独关掉一项，**不能**把另外三项一起带下去。
  const only = normalizePerfConfig({ publicByteCache: false }, base);
  check('提交的字段生效', only.publicByteCache === false);
  check('未提交的开关保持开启',
    only.tgFilePathPersist === true && only.recordCache === true && only.warmOnUpload === true);
  check('数值字段保持基线', only.recordCacheTtl === 60 && only.publicByteCacheTtl === 3600);

  // 空对象应完整回落 base，而不是变成全 false —— 否则"没传"就等于"全关"
  const empty = normalizePerfConfig({}, base);
  check('空提交回落基线而非全关',
    empty.tgFilePathPersist === true &&
    empty.recordCache === true &&
    empty.publicByteCache === true &&
    empty.warmOnUpload === true);
}

// ============================================================================
console.log('[4] 数值夹取');
{
  const base = readPerfConfigFromEnv({});
  const low = normalizePerfConfig({ recordCacheTtl: 1 }, base);
  check('记录缓存时长下界夹到 10', low.recordCacheTtl === 10);
  const high = normalizePerfConfig({ recordCacheTtl: 99999 }, base);
  check('记录缓存时长上界夹到 3600', high.recordCacheTtl === 3600);
  const byteLow = normalizePerfConfig({ publicByteCacheTtl: 1 }, base);
  check('字节缓存时长下界夹到 60', byteLow.publicByteCacheTtl === 60);
  const byteHigh = normalizePerfConfig({ publicByteCacheTtl: 999999 }, base);
  check('字节缓存时长上界夹到 86400', byteHigh.publicByteCacheTtl === 86400);
  const sizeHigh = normalizePerfConfig({ publicByteCacheMaxBytes: 10 * 1024 * MB }, base);
  check('单文件上限不超过 512MB', sizeHigh.publicByteCacheMaxBytes === 512 * MB);
  const junk = normalizePerfConfig({ recordCacheTtl: 'abc' }, base);
  check('非法数值回落基线', junk.recordCacheTtl === 60);
}

// ============================================================================
console.log('[5] KV 覆盖优先于环境变量，reset 后回落');
{
  fresh();
  const env = makeEnv({ RECORD_CACHE: '0' }, {
    'config:perf': {
      recordCache: true,
      recordCacheTtl: 120,
      // 只存一部分字段：缺失的应该由环境变量基线补上，
      // 而不是变成 undefined 或 false
    },
  });
  const cfg = await getPerfConfig(env);
  check('KV 覆盖生效（环境变量是 0）', cfg.recordCache === true);
  check('KV 的 TTL 生效', cfg.recordCacheTtl === 120);
  check('缺失字段由基线补齐（默认开启而非关闭）',
    cfg.tgFilePathPersist === true && cfg.publicByteCache === true);

  // 重置后应回落到环境变量基线
  fresh();
  const { resetRuntimeConfig } = await import('../functions/utils/runtime-config.js');
  await resetRuntimeConfig(env, 'perf');
  fresh();
  const afterReset = await getPerfConfig(env);
  check('reset 后回落环境变量基线', afterReset.recordCache === false);
  check('reset 后 TTL 回落到 60', afterReset.recordCacheTtl === 60);
  check('perf 已在 CONFIG_GROUPS 中（后台可重置）', CONFIG_GROUPS.includes('perf'));
}

// ============================================================================
console.log('[6] 设置接口校验');
{
  check('非对象被拒', validatePerf(null).error !== undefined);
  check('开关必须是真布尔（不接受字符串）',
    validatePerf({ recordCache: 'true' }).error !== undefined);
  check('开关必须是真布尔（不接受 1）',
    validatePerf({ publicByteCache: 1 }).error !== undefined);
  check('TTL 超上界被拒', validatePerf({ recordCacheTtl: 99999 }).error !== undefined);
  check('TTL 低于下界被拒', validatePerf({ recordCacheTtl: 1 }).error !== undefined);
  check('字节上限超 512MB 被拒',
    validatePerf({ publicByteCacheMaxBytes: 10 * 1024 * MB }).error !== undefined);

  const ok = validatePerf({
    tgFilePathPersist: false,
    recordCache: true,
    recordCacheTtl: 90.4,
    publicByteCache: true,
    publicByteCacheTtl: 600,
    publicByteCacheMaxBytes: 32 * MB,
    warmOnUpload: true,
  });
  check('合法输入通过', ok.ok === true, ok.error || '');
  check('数值被取整', ok.value.recordCacheTtl === 90);
  check('布尔被收敛', ok.value.tgFilePathPersist === false && ok.value.warmOnUpload === true);
}

// ============================================================================
console.log('[7] 设置接口：读取 / 保存 / 重置');
{
  fresh();
  const env = makeEnv({ PUBLIC_BYTE_CACHE: '1' });
  const ctxGet = { request: new Request('https://x.dev/api/manage/settings'), env };
  const readRes = await onRequestGet(ctxGet);
  const view = await readRes.json();
  check('GET 返回 200', readRes.status === 200);
  check('下发 perf 分组', view.perf !== undefined);
  check('下发环境变量基线', view.perfEnvBaseline !== undefined);
  check('下发的值反映环境变量', view.perf.publicByteCache === true);
  check('默认开的项正确下发', view.perf.tgFilePathPersist === true);
  check('来源标记为 env', view.perf.source === 'env');

  // 保存：整组写入
  fresh();
  const ctxPost = {
    request: new Request('https://x.dev/api/manage/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        perf: {
          tgFilePathPersist: true,
          recordCache: true,
          recordCacheTtl: 120,
          publicByteCache: true,
          publicByteCacheTtl: 600,
          publicByteCacheMaxBytes: 32 * MB,
          warmOnUpload: true,
        },
      }),
    }),
    env,
  };
  const postRes = await onRequestPost(ctxPost);
  const saved = await postRes.json();
  check('POST 返回 200', postRes.status === 200, JSON.stringify(saved).slice(0, 200));
  check('保存后来源变为 kv', saved.perf?.source === 'kv');
  check('保存后值已生效', saved.perf?.recordCache === true);
  check('KV 里确实写了 config:perf', env.img_url._store.has('config:perf'));

  // 保存必须整组持久，不能丢字段
  fresh();
  const reload = await onRequestGet({ request: new Request('https://x.dev/api/manage/settings'), env });
  const reloaded = await reload.json();
  check('重新读取仍是全部字段',
    reloaded.perf.recordCache === true &&
    reloaded.perf.warmOnUpload === true &&
    reloaded.perf.publicByteCacheMaxBytes === 32 * MB);

  // 非法值被 400 拦下
  const badRes = await onRequestPost({
    request: new Request('https://x.dev/api/manage/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ perf: { recordCacheTtl: 999999 } }),
    }),
    env,
  });
  check('非法数值被 400 拒绝', badRes.status === 400);

  // 重置 group=perf
  fresh();
  const delRes = await onRequestDelete({
    request: new Request('https://x.dev/api/manage/settings?group=perf'),
    env,
  });
  const deleted = await delRes.json();
  check('DELETE 返回 200', delRes.status === 200);
  check('重置后回落到环境变量基线', deleted.perf?.source === 'env');
  check('环境变量里的开关恢复可见', deleted.perf?.publicByteCache === true);
  check('其余字段回到默认值（全开）',
    deleted.perf?.recordCache === true && deleted.perf?.warmOnUpload === true);
}

// ============================================================================
console.log('[7] 失效联动：删除 / 改名 / 加密码必须清边缘副本');
{
  const { purgeByteCache } = await import('../functions/utils/byte-cache.js');

  // 字节缓存命中时不查元数据，因此「文件状态变了」只能靠写路径主动清。
  // 这里用一个假 cache 断言键展开的覆盖面，再用静态守卫确认调用点没被删掉。
  const removed = [];
  const originalCaches = globalThis.caches;
  globalThis.caches = {
    default: {
      async delete(req) {
        removed.push(decodeURIComponent(new URL(req.url).pathname));
        return true;
      },
    },
  };

  try {
    const count = await purgeByteCache('https://kv.example.com', ['c.png']);
    check('裸 ID 本身被清掉', removed.includes('/__kvault-bytecache/c.png'));
    check('带存储前缀的写法也被清掉',
      removed.includes('/__kvault-bytecache/r2:c.png') &&
      removed.includes('/__kvault-bytecache/s3:c.png'));
    check('返回值反映实际删除条数', count === removed.length, `${count} vs ${removed.length}`);

    removed.length = 0;
    await purgeByteCache('https://kv.example.com', ['', 'c.png']);
    check('空值被忽略（不产生无意义的删除）',
      removed.length === new Set(removed).size && !removed.includes('/__kvault-bytecache/'));

    removed.length = 0;
    check('缺少 origin 时直接跳过', (await purgeByteCache('', ['c.png'])) === 0);
  } finally {
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }

  // 默认开启后，"忘记清"是一个不会报错、只在线上表现为「删了还能下」的回归。
  const callSites = [
    ['删除', '../functions/api/manage/delete/[id].js'],
    ['改名', '../functions/api/manage/editName/[id].js'],
    ['分享设置', '../functions/api/manage/share/[id].js'],
    ['v1 分享设置', '../functions/api/v1/file/[[path]]/share.js'],
  ];
  for (const [label, file] of callSites) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf-8');
    check(`${label}路径调用了 purgeByteCache`,
      /import\s*\{[^}]*purgeByteCache[^}]*\}/.test(src) && /await purgeByteCache\(|purgeByteCache\(/.test(src),
      '写操作未清边缘副本 → 删了还能下');
  }
}

// ============================================================================
console.log('[8] 前后端字段一致性（防漂移）');
{
  // 后台向.perf 写的字段、接口下发的字段、admin.html 里 perfForm 引用的字段，
  // 三者必须一致。任一侧改名而另一侧没跟上，后台会静默失真 —— 表现为
  // 「开关看起来在动，实际上后端读不到」，是最难排查的一类回归。
  const admin = readFileSync(new URL('../admin.html', import.meta.url), 'utf-8');

  const formBlock = admin.match(/perfForm: \{([\s\S]*?)\n    \},/);
  check('admin.html 里能取到 perfForm 定义', Boolean(formBlock));
  const frontendFields = new Set(
    (formBlock?.[1] || '').matchAll(/^\s*(\w+):/gm)
  );
  const frontend = [...frontendFields].map((m) => m[1]).sort();

  const spy = await getViewFields();
  check('perfForm 与接口字段完全一致',
    JSON.stringify(frontend) === JSON.stringify(spy),
    `前端 ${JSON.stringify(frontend)} vs 接口 ${JSON.stringify(spy)}`);

  // 前端必须引用四个开关 —— 少一个就是面板漏做了入口
  for (const field of ['tgFilePathPersist', 'recordCache', 'publicByteCache', 'warmOnUpload']) {
    check(`后台面板包含 ${field} 开关`, admin.includes(`perfForm.${field}`));
  }
  // 方法接线：三个按钮 + 面板存在
  for (const method of ['loadPerfSettings', 'savePerfSettings', 'resetPerfSettings', 'applyPerfView']) {
    check(`已定义 ${method}`, new RegExp(`${method}\\s*\\(`).test(admin));
  }
  check('进入「存储」分区时会加载该面板', admin.includes('this.loadPerfSettings();'));
}

/** 从真实接口取一遍 perf 字段清单（排除 source 这种元字段）。 */
async function getViewFields() {
  fresh();
  const env = makeEnv();
  const res = await onRequestGet({ request: new Request('https://x.dev/api/manage/settings'), env });
  const view = await res.json();
  return Object.keys(view.perf).filter((key) => key !== 'source').sort();
}

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
if (fail > 0) process.exit(1);
