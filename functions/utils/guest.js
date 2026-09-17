/**
 * 访客上传工具模块
 * 提供访客上传的权限检查和速率限制
 */

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
 * @returns {{ allowed: boolean, reason?: string, status?: number, remaining?: number }}
 */
export async function checkGuestUpload(request, env, fileSize) {
    // 检查是否启用了访客上传
    if (env.GUEST_UPLOAD !== 'true') {
        return { allowed: false, reason: '未启用访客上传，请登录后操作', status: 401 };
    }

    // 检查文件大小限制
    const maxSize = parseInt(env.GUEST_MAX_FILE_SIZE) || 5 * 1024 * 1024; // 默认 5MB
    if (fileSize > maxSize) {
        const maxMB = (maxSize / 1024 / 1024).toFixed(0);
        return { allowed: false, reason: `访客上传限制：文件大小不能超过 ${maxMB}MB`, status: 413 };
    }

    // 检查每日上传次数
    const dailyLimit = parseInt(env.GUEST_DAILY_LIMIT) || 10;
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
                    status: 429,
                    remaining: 0
                };
            }

            return { allowed: true, remaining: dailyLimit - currentCount };
        } catch (e) {
            console.error('Guest rate limit check error:', e);
            // KV 出错时放行，不阻塞用户
            return { allowed: true };
        }
    }

    return { allowed: true };
}

/**
 * 增加访客上传计数
 */
export async function incrementGuestCount(request, env) {
    if (!env.img_url || env.GUEST_UPLOAD !== 'true') return;

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
 */
export function getGuestConfig(env) {
    const enabled = env.GUEST_UPLOAD === 'true';
    return {
        enabled,
        maxFileSize: enabled ? (parseInt(env.GUEST_MAX_FILE_SIZE) || 5 * 1024 * 1024) : 0,
        dailyLimit: enabled ? (parseInt(env.GUEST_DAILY_LIMIT) || 10) : 0
    };
}
