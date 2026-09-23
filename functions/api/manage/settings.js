/**
 * 运行时设置读写 API
 *
 *   GET  /api/manage/settings  → 读取当前设置（含来源标记：kv / env）
 *   POST /api/manage/settings  → 保存设置（写入 KV，覆盖环境变量基线）
 *   DELETE /api/manage/settings → 清除 KV 覆盖，回退环境变量
 *
 * 鉴权由 api/manage/_middleware.js 统一兜底（要求 BASIC_USER/BASIC_PASS，
 * 未配置时 fail-closed 返回 503），因此这里不再重复校验。
 */
import {
    getGuestConfigResolved,
    readGuestConfigFromEnv,
    saveGuestConfig,
    resetGuestConfig
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
    const [guest, envBaseline] = [await getGuestConfigResolved(env), readGuestConfigFromEnv(env)];
    return {
        guest: {
            enabled: guest.enabled,
            maxFileSize: guest.maxFileSize,
            dailyLimit: guest.dailyLimit,
            source: guest.source
        },
        envBaseline,
        hasKvBinding: Boolean(env?.img_url)
    };
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
    if (!guestInput || typeof guestInput !== 'object') {
        return json({ error: '缺少 guest 配置对象。' }, 400);
    }

    // 数值字段校验：拒绝 NaN / 负数 / 超上限，避免把访客限制设成无效值
    if (guestInput.maxFileSize !== undefined) {
        const size = Number(guestInput.maxFileSize);
        if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_SIZE_LIMIT) {
            return json({ error: `单文件上限需为 1 字节 ~ ${MAX_FILE_SIZE_LIMIT / 1024 / 1024}MB 之间的数值。` }, 400);
        }
    }
    if (guestInput.dailyLimit !== undefined) {
        const limit = Number(guestInput.dailyLimit);
        if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_DAILY_LIMIT) {
            return json({ error: `每日次数需为 1 ~ ${MAX_DAILY_LIMIT} 之间的整数。` }, 400);
        }
    }
    if (guestInput.enabled !== undefined && typeof guestInput.enabled !== 'boolean') {
        return json({ error: 'enabled 必须是布尔值。' }, 400);
    }

    if (!env?.img_url) {
        return json({ error: '当前部署缺少 KV 绑定 img_url，无法保存运行时设置。' }, 503);
    }

    try {
        await saveGuestConfig(env, guestInput);
        return json({ success: true, ...(await buildView(env)) });
    } catch (error) {
        console.error('Settings save error:', error);
        return json({ error: error.message || '保存设置失败' }, 500);
    }
}

export async function onRequestDelete(context) {
    const { env } = context;
    try {
        await resetGuestConfig(env);
        return json({ success: true, ...(await buildView(env)) });
    } catch (error) {
        console.error('Settings reset error:', error);
        return json({ error: error.message || '重置设置失败' }, 500);
    }
}
