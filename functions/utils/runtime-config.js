/**
 * 运行时配置存储 —— 通用分组版
 *
 * Cloudflare Pages 的环境变量只能在 Dashboard 修改、且改完必须重新部署。
 * 为了让后台（admin.html）能直接调节这类高频开关，这里提供一层
 * 「KV 优先、环境变量兜底」的配置读取：
 *
 *   1. KV 中保存了该分组配置  → 以 KV 为准（后台保存即时生效，无需重新部署）
 *   2. KV 中没有（从未在后台保存过）→ 回退到环境变量（保持既有部署行为不变）
 *
 * 存储形态：每个分组一个 KV key（`config:<group>`）存一份 JSON，整组读写，
 * 避免多 key 分散导致部分字段写入失败时出现「半新半旧」的配置。
 *
 * 已接入分组（新增分组只需在 GROUPS 里加一条 { key, fromEnv, normalize }）：
 *   - guest    访客上传开关 / 单文件大小 / 每日上限
 *   - cors     API CORS 允许的来源白名单
 *   - upload   分片上传暂存后端（auto / r2 / kv）
 *   - storage  存储回滚模式（是否继续把文件元数据写进 KV）
 *
 * ============================================================================
 * storage 组：为什么它是一个「回滚模式」而不是「迁移开关」
 * ============================================================================
 *
 * D1 已经接管全部读侧（getRecordWithKey / 短链解析 / 统计 / 令牌 / Paste
 * / 审计），KV 上的文件元数据写入退化为**纯冗余的双写**。理论上可以直接删掉，
 * 但那样做是不可逆的代码改动 —— 一旦线上 D1 出问题，没有退路。
 *
 * storage 组把这件事变成**运行时可切换**的：
 *
 *   writeKvLegacy = true （默认）→ 维持双写，行为与迁移前逐字节一致
 *   writeKvLegacy = false        → 跳过 KV 元数据写入，D1 成为唯一数据源
 *
 * 默认必须是 true：这样合入本改动**不会改变任何现网行为**，停写是运维
 * 在后台主动做出的、可随时撤销的决定。任何时候把开关拨回 true，KV 立刻
 * 重新开始接收写入（无需重新部署，也不用回滚代码）。
 *
 * 注意这里**只管文件元数据记录**（`img_url.put(kvKey, '', {metadata})`
 * 这一类）。登录态 session、限流计数、分片上传暂存、幂等重放缓存这些
 * KV 键各有独立语义，不随本开关启停 —— 详见 utils/file-record.js 的
 * shouldWriteKvLegacy()。
 */

/** 访客上传配置在 KV 中的 key（保持旧导出名兼容） */
export const GUEST_CONFIG_KEY = 'config:guest';

/** 存储策略配置在 KV 中的 key */
export const STORAGE_CONFIG_KEY = 'config:storage';

/** 所有配置组的名字，供后台设置接口遍历 */
export const CONFIG_GROUPS = ['guest', 'cors', 'upload', 'storage'];

const DEFAULT_GUEST_MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const DEFAULT_GUEST_DAILY_LIMIT = 10;

/**
 * 进程内短 TTL 缓存。
 *
 * ============================================================================
 * 为什么是 30 秒（而不是更长或更短）
 * ============================================================================
 *
 * 这些配置在每个 API 请求 / 每次上传时都会被读一次，若每次都回源 KV
 * 会带来读放大。但**缓存只在同 isolate 内连续请求时才有用**：
 * 请求间隔 ≥ TTL 的话，每次请求进来缓存都已过期，等于没有缓存。
 *
 * 实测口径（scripts/bench-p6-config.mjs）：
 *   · 访客上传间隔约 30s → 5s 与 30s **回源次数相同**，这个场景不省
 *   · CORS 预检间隔约 2s → 5s 合并 2.5x 请求，30s 合并 15x
 *
 * 也就是说收益只出现在秒级间隔的高频路径上。而代价是**跨 isolate 的
 * 配置生效延迟**：后台改完开关，最坏 30 秒后其他 isolate 才看到。
 *
 * 之所以敢拉长，是因为 `saveRuntimeConfig` / `resetRuntimeConfig`
 * **主动删缓存**，所以「后台改完即时生效」在同 isolate 内始终成立；
 * 跨 isolate 的那点延迟用户感知不到（改配置本就是低频人工操作）。
 *
 * 如果将来发现某个配置组的变更必须全局即时生效，正确做法是给那一组
 * 单独设 TTL，而不是把全局 TTL 调回 5s —— 那会让高频路径重新读放大。
 */
const CACHE_TTL_MS = 30000;
const configCache = new Map(); // group -> { ts, value, source }

/**
 * ============================================================================
 * 「分组配置镜像」缓存 —— 让写入侧零 KV 读就能判断回滚模式
 * ============================================================================
 *
 * 为什么需要它：
 *
 * 回滚模式的判定点在**写路径**（每个上传请求都要问一次「要不要写 KV」）。
 * 而写路径本身就是一个 KV 写额度稀缺的地方 —— 如果为了判断「能不能写 KV」
 * 先多做一次 KV 读，那就是用读额度换写额度，账面上并不划算。
 *
 * 解决办法：`getRuntimeConfig(env,'storage')` 既然已经把整组配置读回来了，
 * 就**顺手把结果挂在这个索引键上**。之后任何拿得到 env 的代码，只要索引键的
 * 值里带 `writeKvLegacy`，就可以直接读它、跳过 KV 往返（命中率 100%，
 * 因为热路径上 storage 组配置总是先被 settings 页或前一个请求填过）。
 *
 * 这里存的是**群组配置的镜像**（`{...value}`），而不是群组名的一对一映射 ——
 * 目的是让判定函数在镜像未命中时能安全地退回 `getRuntimeConfig` 回源，
 * 而不用猜组名。
 *
 * 索引键的**值**不参与业务语义（KV 里真实存的一直是 img_url 上的
 * `config:storage`），它只是同一份数据在本进程内的另一份引用。
 * 因此镜像丢失没有任何正确性影响，只是多一次回源。
 */
const GROUP_INDEX_KEY = 'config:__index__';

/**
 * 取某个 KV 绑定对象的稳定身份。
 *
 * 为什么镜像必须按绑定区分：
 *
 * `configCache` 是**模块级单例**，同一进程里所有 env 共用。生产环境下
 * 一个 isolate 只服务一个部署，env 恒定，看不出问题；但测试里每个用例
 * 会 new 一个 KV 替身，此时"A 用例缓存的 storage 配置"会被"B 用例"读到，
 * 表现为「B 明明没关开关，却被判定成已关闭」—— 这类串味测试最难排查。
 *
 * 更值得警惕的是**跨绑定复用**这个可能性本身：只要存在两个不同的
 * KV 绑定（多环境、多租户、或将来引入第二份 KV），共用缓存就会让
 * 「A 的配置」泄漏成「B 的配置」。写路径的开关判定一旦泄漏，后果是
 * 该写的不写（或不该写的写），属于静默错配。
 *
 * 因此这里用绑定对象身份做缓存分区，而不是假设"进程内只有一个部署"。
 */
function bindingId(env) {
  const kv = env?.img_url;
  if (!kv) return 'none';
  // 注意：WeakMap 没有 size 属性（`map.size` 是 undefined，
  // `undefined + 1` 会得到 NaN），因此必须自己维护单调计数器 ——
  // 否则所有绑定都会被命名成同一个 "kv:NaN"，分区形同虚设。
  const map = bindingId._map || (bindingId._map = new WeakMap());
  if (!map.has(kv)) {
    const n = (bindingId._seq || 0) + 1;
    bindingId._seq = n;
    map.set(kv, `kv:${n}`);
  }
  return map.get(kv);
}

/** 把某一组配置镜像到索引键上，供零 KV 读判定使用 */
function mirrorGroupConfig(group, value, source, env) {
  const id = bindingId(env);
  const key = `${GROUP_INDEX_KEY}@${id}`;
  configCache.set(key, {
    ts: Date.now(),
    value: { [group]: { ...value, source } },
    source
  });
}

/** 读取已镜像的某组配置（未命中/过期返回 null） */
function readMirroredGroupConfig(group, env) {
  const key = `${GROUP_INDEX_KEY}@${bindingId(env)}`;
  const entry = configCache.get(key);
  if (!entry || Date.now() - entry.ts >= CACHE_TTL_MS) return null;
  const mirrored = entry.value?.[group];
  return mirrored && typeof mirrored === 'object' ? mirrored : null;
}

/** 清掉某 KD 绑定下所有分组镜像 */
function clearMirrorsFor(env) {
  const suffix = `@${bindingId(env)}`;
  for (const key of [...configCache.keys()]) {
    if (key.startsWith(GROUP_INDEX_KEY) && key.endsWith(suffix)) configCache.delete(key);
  }
}

function toPositiveInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 解析逗号分隔的来源白名单（CORS） */
export function parseOriginsFromString(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  return text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 分片暂存后端归一化：非 r2/kv 一律回落 auto（有 R2 就用 R2） */
function normalizeChunkBackend(raw) {
  const mode = String(raw ?? '').trim().toLowerCase();
  return mode === 'kv' || mode === 'r2' ? mode : 'auto';
}

/** 各字段的环境变量兜底名 */
const GUEST_ENV_MAP = {
  enabled: 'GUEST_UPLOAD',
  maxFileSize: 'GUEST_MAX_FILE_SIZE',
  dailyLimit: 'GUEST_DAILY_LIMIT'
};

/**
 * 布尔值宽松解析。
 *
 * 环境变量只有字符串，KV 里却可能是真布尔。历史上 guest.enabled 用的是
 * `String(v) === 'true'`（即只认字面量 'true'），这里保持同样的严格度：
 * 不把 '1' / 'yes' 当 true，避免出现「写了 1 以为开了其实没开」。
 */
function toBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

const GROUPS = {
  guest: {
    key: GUEST_CONFIG_KEY,
    fromEnv: (env) => ({
      enabled: String(env?.[GUEST_ENV_MAP.enabled] || '') === 'true',
      maxFileSize: toPositiveInt(env?.[GUEST_ENV_MAP.maxFileSize], DEFAULT_GUEST_MAX_FILE_SIZE),
      dailyLimit: toPositiveInt(env?.[GUEST_ENV_MAP.dailyLimit], DEFAULT_GUEST_DAILY_LIMIT)
    }),
    normalize: (raw, base) => normalizeGuestConfig(raw, base)
  },
  cors: {
    key: 'config:cors',
    fromEnv: (env) => ({ origins: parseOriginsFromString(env?.API_CORS_ORIGINS) }),
    normalize: (raw, base) => ({
      origins: Array.isArray(raw?.origins)
        ? raw.origins.map((item) => String(item).trim()).filter(Boolean)
        : (base?.origins ?? [])
    })
  },
  upload: {
    key: 'config:upload',
    fromEnv: (env) => ({ chunkBackend: normalizeChunkBackend(env?.CHUNK_BACKEND) }),
    normalize: (raw, base) => ({
      chunkBackend: normalizeChunkBackend(raw?.chunkBackend ?? base?.chunkBackend)
    })
  },
  storage: {
    key: STORAGE_CONFIG_KEY,
    // 环境变量基线：缺省即 true（保持双写），只有显式写 'false' 才停写。
    fromEnv: (env) => ({
      writeKvLegacy: toBool(env?.KV_LEGACY_WRITE, true)
    }),
    normalize: (raw, base) => normalizeStorageConfig(raw, base)
  }
};

/** 归一化一份访客配置，保证字段类型与取值范围可控 */
export function normalizeGuestConfig(raw, fallback) {
  const base = fallback || {
    enabled: false,
    maxFileSize: DEFAULT_GUEST_MAX_FILE_SIZE,
    dailyLimit: DEFAULT_GUEST_DAILY_LIMIT
  };
  if (!raw || typeof raw !== 'object') return { ...base };
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled,
    maxFileSize: toPositiveInt(raw.maxFileSize, base.maxFileSize),
    dailyLimit: toPositiveInt(raw.dailyLimit, base.dailyLimit)
  };
}

/** 从环境变量读取访客配置（部署期设定的基线） */
export function readGuestConfigFromEnv(env) {
  return GROUPS.guest.fromEnv(env);
}

/**
 * 归一化存储策略。
 *
 * `writeKvLegacy` 未传入时**保持 base 原值**（与 updateFileMetadataFields
 * 的「只改显式传入的字段」同源），这样后台只提交 `{storage:{writeKvLegacy}}`
 * 一个字段时不会顺手把未来新增的字段抹掉。
 */
export function normalizeStorageConfig(raw, fallback) {
  const base = fallback || { writeKvLegacy: true };
  if (!raw || typeof raw !== 'object') return { ...base };
  return {
    writeKvLegacy: toBool(raw.writeKvLegacy, toBool(base.writeKvLegacy, true))
  };
}

/** 从环境变量读取存储策略（部署期设定的基线，缺省 true） */
export function readStorageConfigFromEnv(env) {
  return GROUPS.storage.fromEnv(env);
}

/**
 * 读取任意配置组：KV 覆盖 > 环境变量基线。
 *
 * @param {object} env - Pages 环境（需要 img_url KV 绑定）
 * @param {string} group - 分组名（见 CONFIG_GROUPS）
 * @returns {Promise<object>} 配置值并附带 `source: 'kv' | 'env'`
 */
export async function getRuntimeConfig(env, group) {
  const def = GROUPS[group];
  if (!def) throw new Error(`未知的配置组: ${group}`);

  const fromEnv = def.fromEnv(env);
  if (!env?.img_url?.get) {
    return { ...fromEnv, source: 'env' };
  }

  const cached = configCache.get(group);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { ...cached.value, source: cached.source };
  }

  try {
    const stored = await env.img_url.get(def.key, { type: 'json' });
    if (stored && typeof stored === 'object') {
      const value = def.normalize(stored, fromEnv);
      configCache.set(group, { ts: Date.now(), value, source: 'kv' });
      mirrorGroupConfig(group, value, 'kv', env);
      return { ...value, source: 'kv' };
    }
  } catch (e) {
    // KV 读取异常时回退环境变量：配置读取失败不该让整个站点不可用，
    // 真正的上传门禁另有 fail-closed 保护。
    console.error('Runtime config read error:', e);
  }

  configCache.set(group, { ts: Date.now(), value: fromEnv, source: 'env' });
  mirrorGroupConfig(group, fromEnv, 'env', env);
  return { ...fromEnv, source: 'env' };
}

/**
 * 写入任意配置组到 KV（整组覆盖），并立即失效进程内缓存。
 *
 * 注意：不写 `expirationTtl`，配置需要长期有效。
 */
export async function saveRuntimeConfig(env, group, patch) {
  const def = GROUPS[group];
  if (!def) throw new Error(`未知的配置组: ${group}`);
  if (!env?.img_url?.put) {
    throw new Error('缺少 KV 绑定 img_url，无法保存运行时配置。');
  }

  const current = await getRuntimeConfig(env, group);
  const { source: _ignored, ...currentValue } = current;
  const next = def.normalize(patch, currentValue);
  await env.img_url.put(def.key, JSON.stringify(next));
  configCache.delete(group);
  // 保存后立刻刷新镜像，避免同 isolate 内后续写路径仍按旧值判定。
  mirrorGroupConfig(group, next, 'kv', env);
  return next;
}

/** 清除某组的 KV 覆盖，回退到环境变量基线 */
export async function resetRuntimeConfig(env, group) {
  const def = GROUPS[group];
  if (!def) throw new Error(`未知的配置组: ${group}`);
  if (env?.img_url?.delete) {
    await env.img_url.delete(def.key);
  }
  configCache.delete(group);
  const baseline = def.fromEnv(env);
  mirrorGroupConfig(group, baseline, 'env', env);
  return baseline;
}

/**
 * 仅失效进程内缓存，**不触碰 KV**。
 *
 * 与 resetRuntimeConfig 的区别：reset 会删 KV 键（回退到 env 基线），
 * 而本函数只把缓存丢掉，下次读会重新回源 KV 取到真实值。
 *
 * 存在理由：测试需要让每个用例从"干净缓存"开始，但又不能删掉预置的
 * KV 数据。生产代码也可以用它来在已知外部变更后强制刷新。
 *
 * @param {string} [group] - 省略则失效全部组
 * @param {object} [env]   - 省略则失效**所有绑定**的同名分组镜像
 */
export function invalidateRuntimeConfigCache(group, env) {
  if (group == null) {
    configCache.clear();
    return;
  }
  configCache.delete(group);

  // 镜像里也存着该组的副本，必须一起丢；否则下次判定会读到过期值。
  // 镜像按绑定分区（见 bindingId），所以要么精确丢某个绑定的，
  // 要么把所有绑定的都丢。
  if (env) {
    const suffix = `@${bindingId(env)}`;
    for (const key of [...configCache.keys()]) {
      if (!key.startsWith(GROUP_INDEX_KEY) || !key.endsWith(suffix)) continue;
      const entry = configCache.get(key);
      const nextValue = { ...entry.value };
      delete nextValue[group];
      if (Object.keys(nextValue).length === 0) configCache.delete(key);
      else entry.value = nextValue;
    }
    return;
  }

  for (const key of [...configCache.keys()]) {
    if (!key.startsWith(GROUP_INDEX_KEY)) continue;
    const entry = configCache.get(key);
    const nextValue = { ...entry.value };
    delete nextValue[group];
    if (Object.keys(nextValue).length === 0) configCache.delete(key);
    else entry.value = nextValue;
  }
}

/* ---------------- 分组便捷入口（保持旧签名兼容） ---------------- */

/** 访客上传配置（含 source 标记） */
export async function getGuestConfigResolved(env) {
  return getRuntimeConfig(env, 'guest');
}

export async function saveGuestConfig(env, config) {
  return saveRuntimeConfig(env, 'guest', config);
}

export async function resetGuestConfig(env) {
  return resetRuntimeConfig(env, 'guest');
}

/** CORS 允许的来源列表（含 source 标记） */
export async function getCorsConfigResolved(env) {
  return getRuntimeConfig(env, 'cors');
}

/** 分片上传暂存后端（含 source 标记） */
export async function getUploadConfigResolved(env) {
  return getRuntimeConfig(env, 'upload');
}

/** 存储回滚模式配置（含 source 标记） */
export async function getStorageConfigResolved(env) {
  return getRuntimeConfig(env, 'storage');
}

/**
 * 判定是否继续把文件元数据写进 KV（回滚模式）。
 *
 * 默认 true —— 任何读取异常、缺绑定、未知分组都**倾向于保持双写**：
 * 多写一次 KV 只是浪费额度，而错误地停写会让文件记录只剩 D1 一份，
 * 属于「宁可保守」的取舍。
 *
 * @param {object} env
 * @returns {Promise<boolean>}
 */
export async function shouldWriteKvLegacy(env) {
  try {
    const cfg = await getStorageConfigResolved(env);
    return toBool(cfg?.writeKvLegacy, true);
  } catch (e) {
    console.error('shouldWriteKvLegacy read error, defaulting to true:', e);
    return true;
  }
}

/**
 * 同步版本的判定 —— **零 KV 往返**。
 *
 * 命中「分组配置镜像」时直接返回，供写路径在每次上传时无成本地判断；
 * 未命中（镜像为空，例如本 isolate 还没读过任何运行时配置）返回 null，
 * 由调用方决定是 `await shouldWriteKvLegacy()` 回源，还是保守起来先写。
 *
 * 之所以不直接在这里 `await`：本函数的调用点都在
 * `env.img_url.put(...)` 的位置，调用方往往手里已经有 metadata、
 * 希望一次性决定写不写；把「异步回源」和「同步判定」拆成两个函数，
 * 调用方就能显式表达自己的取舍（常见做法是 `?? await ...`）。
 *
 * @param {object} env
 * @returns {boolean|null}
 */
export function shouldWriteKvLegacySync(env) {
  const mirrored = readMirroredGroupConfig('storage', env);
  if (mirrored) return toBool(mirrored.writeKvLegacy, true);
  // 未命中镜像：环境变量基线是免费且即时的，可以先用它兜一层。
  // 只有「基线存在且明确说了 false」时才可能返回 false —— 否则返回 null
  // 让调用方回源，避免在 KV 覆盖已关闭的情况下误判成「继续写」。
  const envValue = env?.KV_LEGACY_WRITE;
  if (envValue === 'false' || envValue === false) return false;
  return null;
}
