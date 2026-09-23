/**
 * 运行时配置存储
 *
 * Cloudflare Pages 的环境变量只能在 Dashboard 修改、且改完必须重新部署。
 * 为了让后台（admin.html）能直接调节「访客上传」这类高频开关，这里提供一层
 * 「KV 优先、环境变量兜底」的配置读取：
 *
 *   1. KV 中保存了该分组配置  → 以 KV 为准（后台点一下即时生效，无需重新部署）
 *   2. KV 中没有（从未在后台保存过）→ 回退到环境变量（保持既有部署行为不变）
 *
 * 存储形态：单个 KV key（`config:<group>`）存一份 JSON，整组读写，
 * 避免多 key 分散导致部分字段写入失败时出现「半新半旧」的配置。
 */

/** 访客上传配置在 KV 中的 key */
export const GUEST_CONFIG_KEY = 'config:guest';

/** 各字段的环境变量兜底名 */
const GUEST_ENV_MAP = {
    enabled: 'GUEST_UPLOAD',
    maxFileSize: 'GUEST_MAX_FILE_SIZE',
    dailyLimit: 'GUEST_DAILY_LIMIT'
};

const DEFAULT_GUEST_MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const DEFAULT_GUEST_DAILY_LIMIT = 10;

function toPositiveInt(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 从环境变量读取访客配置（部署期设定的基线） */
export function readGuestConfigFromEnv(env) {
    return {
        enabled: env?.[GUEST_ENV_MAP.enabled] === 'true',
        maxFileSize: toPositiveInt(env?.[GUEST_ENV_MAP.maxFileSize], DEFAULT_GUEST_MAX_FILE_SIZE),
        dailyLimit: toPositiveInt(env?.[GUEST_ENV_MAP.dailyLimit], DEFAULT_GUEST_DAILY_LIMIT)
    };
}

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

/**
 * 读取访客上传配置：KV 覆盖 > 环境变量。
 *
 * @param {object} env - Pages 环境（需要 img_url KV 绑定）
 * @returns {Promise<{ enabled: boolean, maxFileSize: number, dailyLimit: number, source: 'kv'|'env' }>}
 */
export async function getGuestConfigResolved(env) {
    const fromEnv = readGuestConfigFromEnv(env);
    if (!env?.img_url?.get) {
        return { ...fromEnv, source: 'env' };
    }
    try {
        const stored = await env.img_url.get(GUEST_CONFIG_KEY, { type: 'json' });
        if (stored && typeof stored === 'object') {
            return { ...normalizeGuestConfig(stored, fromEnv), source: 'kv' };
        }
    } catch (e) {
        // KV 读取异常时回退环境变量：配置读取失败不该让整个站点不可用，
        // 真正的上传门禁另有 fail-closed 保护。
        console.error('Runtime config read error:', e);
    }
    return { ...fromEnv, source: 'env' };
}

/**
 * 写入访客上传配置到 KV。
 *
 * 注意：不写 `expirationTtl`，配置需要长期有效；后台每次保存都会整组覆盖。
 *
 * @param {object} env - Pages 环境
 * @param {object} config - 待保存的配置（部分字段亦可，会与环境变量基线合并）
 */
export async function saveGuestConfig(env, config) {
    if (!env?.img_url?.put) {
        throw new Error('缺少 KV 绑定 img_url，无法保存运行时配置。');
    }
    const current = await getGuestConfigResolved(env);
    const next = normalizeGuestConfig(config, current);
    await env.img_url.put(GUEST_CONFIG_KEY, JSON.stringify(next));
    return next;
}

/** 清除 KV 覆盖，回退到环境变量基线 */
export async function resetGuestConfig(env) {
    if (!env?.img_url?.delete) return readGuestConfigFromEnv(env);
    await env.img_url.delete(GUEST_CONFIG_KEY);
    return readGuestConfigFromEnv(env);
}
