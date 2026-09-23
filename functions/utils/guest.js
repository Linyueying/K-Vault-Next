/**
 * 访客上传工具模块
 * 提供访客上传的权限检查和速率限制
 *
 * 配置来源：后台可写的 KV 运行时配置优先，未保存过时回退环境变量。
 * 见 ./runtime-config.js
 */
import { getGuestConfigResolved } from './runtime-config.js';

/**
 * 获取客户端 IP
 */
function getClientIP(request) {
    return request.headers.get('CF-Connecting-IP')
        || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
        || request.headers.get('X-Real-IP')
        || '0.0.0.0';
}

/**
 * 获取今日日期字符串 (YYYY-MM-DD)
 */
function getTodayKey() {
    return new Date().toISOString().split('T')[0];
}

/**
 * 检查访客上传权限
 *
 * `fileSize` 传 0 表示「只做前置门禁」（是否启用 / 是否超每日次数），
 * 用于上传入口在解析 multipart 之前就短路被禁的访客；文件大小限制在读到
 * 文件对象之后再补一次。
 *
 * @returns {{ allowed: boolean, reason?: string, code?: string, status?: number, remaining?: number }}
 */
export async function checkGuestUpload(request, env, fileSize) {
    const config = await getGuestConfigResolved(env);

    // 检查是否启用了访客上传。未开启 = 访客一律不允许上传，前端应引导登录。
    if (!config.enabled) {
        return {
            allowed: false,
            reason: '访客上传已关闭，请登录后上传',
            code: 'GUEST_UPLOAD_DISABLED',
            status: 401
        };
    }

    // 前置门禁（fileSize 为 0）时跳过文件大小校验，交由调用方在拿到文件后补做。
    const maxSize = config.maxFileSize;
    if (Number(fileSize) > 0 && fileSize > maxSize) {
        const maxMB = (maxSize / 1024 / 1024).toFixed(0);
        return {
            allowed: false,
            reason: `访客上传限制：文件大小不能超过 ${maxMB}MB`,
            code: 'GUEST_FILE_TOO_LARGE',
            status: 413
        };
    }

    // 检查每日上传次数
    const dailyLimit = config.dailyLimit;
    const ip = getClientIP(request);
    const today = getTodayKey();
    const kvKey = `guest:${ip}:${today}`;

    if (env.img_url) {
        try {
            const countStr = await env.img_url.get(kvKey);
            const currentCount = parseInt(countStr) || 0;

            if (currentCount >= dailyLimit) {
                return {
                    allowed: false,
                    reason: `访客每日上传上限 ${dailyLimit} 次，今日已用完`,
                    code: 'GUEST_DAILY_LIMIT_REACHED',
                    status: 429,
                    remaining: 0
                };
            }

            return { allowed: true, remaining: dailyLimit - currentCount };
        } catch (e) {
            console.error('Guest rate limit check error:', e);
            // KV 异常时按 fail-closed 处理：访客上传是可选能力，
            // 读不到计数就不放行，避免绕过每日限额无限上传。
            return {
                allowed: false,
                reason: '访客限额校验暂不可用，请登录后上传',
                code: 'GUEST_LIMIT_UNAVAILABLE',
                status: 503
            };
        }
    }

    return { allowed: true };
}

/**
 * 增加访客上传计数
 */
export async function incrementGuestCount(request, env) {
    if (!env.img_url) return;
    const config = await getGuestConfigResolved(env);
    if (!config.enabled) return;

    const ip = getClientIP(request);
    const today = getTodayKey();
    const kvKey = `guest:${ip}:${today}`;

    try {
        const countStr = await env.img_url.get(kvKey);
        const currentCount = parseInt(countStr) || 0;
        await env.img_url.put(kvKey, String(currentCount + 1), {
            expirationTtl: 86400 // 24 小时后自动过期
        });
    } catch (e) {
        console.error('Guest count increment error:', e);
    }
}

/**
 * 获取访客配置信息（供前端展示）
 *
 * 访问路径按「高频公开接口」对待：getGuestConfigResolved 读的是 KV，
 * 这里保留该语义，不做缓存以免后台改完开关前台不生效。
 */
export async function getGuestConfig(env) {
    const config = await getGuestConfigResolved(env);
    return {
        enabled: config.enabled,
        maxFileSize: config.enabled ? config.maxFileSize : 0,
        dailyLimit: config.enabled ? config.dailyLimit : 0
    };
}
