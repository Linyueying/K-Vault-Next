/**
 * 运行时设置读写 API
 *
 *   GET    /api/manage/settings            → 读取当前设置（含来源标记：kv / env）
 *   POST   /api/manage/settings            → 保存设置（写入 KV，覆盖环境变量基线）
 *   DELETE /api/manage/settings            → 清除 guest 组的 KV 覆盖，回退环境变量
 *   DELETE /api/manage/settings?group=cors → 清除指定分组（cors / upload）
 *
 * 可管理分组见 runtime-config.js 的 CONFIG_GROUPS：
 *   - guest   访客上传开关 / 单文件大小 / 每日上限
 *   - cors    API CORS 来源白名单（替代环境变量 API_CORS_ORIGINS）
 *   - upload  分片上传暂存后端（替代环境变量 CHUNK_BACKEND）
 *
 * 这些分组写入 KV 后即时生效，不必改环境变量并重新部署。
 *
 * 鉴权由 api/manage/_middleware.js 统一兜底（要求 BASIC_USER/BASIC_PASS，
 * 未配置时 fail-closed 返回 503），因此这里不再重复校验。
 */
import {
    getRuntimeConfig,
    saveRuntimeConfig,
    resetRuntimeConfig,
    readGuestConfigFromEnv,
    CONFIG_GROUPS
} from '../../utils/runtime-config.js';

const MAX_FILE_SIZE_LIMIT = 100 * 1024 * 1024; // 与直传上限对齐，避免设出无意义的巨值
const MAX_DAILY_LIMIT = 10000;

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
        }
    });
}

/** 组装给前端的完整视图 */
async function buildView(env) {
    const [guest, cors, upload] = await Promise.all([
        getRuntimeConfig(env, 'guest'),
        getRuntimeConfig(env, 'cors'),
        getRuntimeConfig(env, 'upload')
    ]);

    return {
        guest: {
            enabled: guest.enabled,
            maxFileSize: guest.maxFileSize,
            dailyLimit: guest.dailyLimit,
            source: guest.source
        },
        cors: {
            origins: Array.isArray(cors.origins) ? cors.origins : [],
            source: cors.source
        },
        upload: {
            chunkBackend: upload.chunkBackend,
            source: upload.source
        },
        // 兼容既有前端：它只认 guest 的环境变量基线
        envBaseline: readGuestConfigFromEnv(env),
        hasKvBinding: Boolean(env?.img_url)
    };
}

function validateGuest(input) {
    if (!input || typeof input !== 'object') return { error: 'guest 必须是对象。' };
    // 数值字段校验：拒绝 NaN / 负数 / 超上限，避免把访客限制设成无效值
    if (input.maxFileSize !== undefined) {
        const size = Number(input.maxFileSize);
        if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_SIZE_LIMIT) {
            return { error: `单文件上限需为 1 字节 ~ ${MAX_FILE_SIZE_LIMIT / 1024 / 1024}MB 之间的数值。` };
        }
    }
    if (input.dailyLimit !== undefined) {
        const limit = Number(input.dailyLimit);
        if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_DAILY_LIMIT) {
            return { error: `每日次数需为 1 ~ ${MAX_DAILY_LIMIT} 之间的整数。` };
        }
    }
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
        return { error: 'enabled 必须是布尔值。' };
    }
    return { ok: true };
}

function validateCors(input) {
    if (!input || typeof input !== 'object') return { error: 'cors 必须是对象。' };
    if (input.origins === undefined) return { ok: true, value: {} };

    if (!Array.isArray(input.origins)) return { error: 'cors.origins 必须是数组。' };

    const origins = [];
    for (const item of input.origins) {
        const value = String(item ?? '').trim();
        if (!value) continue;
        if (value === '*') { origins.push('*'); continue; }
        if (!/^https?:\/\/[^\s/]+$/i.test(value)) {
            return { error: `无效的来源「${value}」：需为 https://domain 形式，或 * 表示任意来源。` };
        }
        origins.push(value);
    }
    return { ok: true, value: { origins } };
}

function validateUpload(input) {
    if (!input || typeof input !== 'object') return { error: 'upload 必须是对象。' };
    if (input.chunkBackend === undefined) return { ok: true, value: {} };

    const mode = String(input.chunkBackend).trim().toLowerCase();
    if (!['auto', 'r2', 'kv'].includes(mode)) {
        return { error: 'upload.chunkBackend 必须是 auto / r2 / kv 之一。' };
    }
    return { ok: true, value: { chunkBackend: mode } };
}

export async function onRequestGet(context) {
    const { env } = context;
    try {
        return json(await buildView(env));
    } catch (error) {
        console.error('Settings read error:', error);
        return json({ error: error.message || '读取设置失败' }, 500);
    }
}

export async function onRequestPost(context) {
    const { request, env } = context;

    let body;
    try {
        body = await request.json();
    } catch {
        return json({ error: '请求体必须是 JSON。' }, 400);
    }

    const guestInput = body?.guest;
    const corsInput = body?.cors;
    const uploadInput = body?.upload;

    if (!guestInput && !corsInput && !uploadInput) {
        return json({ error: '缺少要保存的配置分组（guest / cors / upload）。' }, 400);
    }

    // 先做全量校验，避免「前半组写进去、后半组校验失败」的半更新状态
    const checks = [];
    if (guestInput) checks.push(['guest', validateGuest(guestInput), guestInput]);
    if (corsInput) checks.push(['cors', validateCors(corsInput), corsInput]);
    if (uploadInput) checks.push(['upload', validateUpload(uploadInput), uploadInput]);

    for (const [, result] of checks) {
        if (result.error) return json({ error: result.error }, 400);
    }

    if (!env?.img_url) {
        return json({ error: '当前部署缺少 KV 绑定 img_url，无法保存运行时设置。' }, 503);
    }

    try {
        for (const [group, result, input] of checks) {
            await saveRuntimeConfig(env, group, result.value || input);
        }
        return json({ success: true, ...(await buildView(env)) });
    } catch (error) {
        console.error('Settings save error:', error);
        return json({ error: error.message || '保存设置失败' }, 500);
    }
}

export async function onRequestDelete(context) {
    const { request, env } = context;

    // 兼容既有前端：不带 group 时重置 guest（原语义就是「恢复访客上传默认设置」）
    const group = new URL(request.url).searchParams.get('group') || 'guest';
    if (!CONFIG_GROUPS.includes(group)) {
        return json({ error: `未知的配置分组：${group}` }, 400);
    }

    try {
        await resetRuntimeConfig(env, group);
        return json({ success: true, ...(await buildView(env)) });
    } catch (error) {
        console.error('Settings reset error:', error);
        return json({ error: error.message || '重置设置失败' }, 500);
    }
}
