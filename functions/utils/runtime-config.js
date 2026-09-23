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
 *   - guest   访客上传开关 / 单文件大小 / 每日上限
 *   - cors    API CORS 允许的来源白名单
 *   - upload  分片上传暂存后端（auto / r2 / kv）
 */

/** 访客上传配置在 KV 中的 key（保持旧导出名兼容） */
export const GUEST_CONFIG_KEY = 'config:guest';

/** 所有配置组的名字，供后台设置接口遍历 */
export const CONFIG_GROUPS = ['guest', 'cors', 'upload'];

const DEFAULT_GUEST_MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const DEFAULT_GUEST_DAILY_LIMIT = 10;

/**
 * 进程内短 TTL 缓存：这些配置会在每个 API 请求 / 每次上传时读取，
 * 若每次都回源 KV 会带来可观的读放大。配置变更极少，5 秒窗口足够，
 * 且保存/重置时会主动失效，后台改完基本即时生效。
 */
const CACHE_TTL_MS = 5000;
const configCache = new Map(); // group -> { ts, value, source }

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
      return { ...value, source: 'kv' };
    }
  } catch (e) {
    // KV 读取异常时回退环境变量：配置读取失败不该让整个站点不可用，
    // 真正的上传门禁另有 fail-closed 保护。
    console.error('Runtime config read error:', e);
  }

  configCache.set(group, { ts: Date.now(), value: fromEnv, source: 'env' });
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
  return def.fromEnv(env);
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
