const DISCORD_API_BASE = 'https://discord.com/api/v10';

/**
 * 上传文件到 Discord。
 * 策略：优先 Bot（与读取链路一致），失败时自动回退 Webhook。
 */
export async function uploadToDiscord(fileBuffer, filename, contentType, env) {
    const errors = [];

    if (env.DISCORD_BOT_TOKEN && env.DISCORD_CHANNEL_ID) {
        const botResult = await uploadViaBot(
            fileBuffer,
            filename,
            contentType,
            env.DISCORD_BOT_TOKEN,
            env.DISCORD_CHANNEL_ID
        );
        if (botResult.success) return { ...botResult, mode: 'bot' };
        errors.push(`Bot: ${botResult.error}`);
    }

    if (env.DISCORD_WEBHOOK_URL) {
        const webhookResult = await uploadViaWebhook(fileBuffer, filename, contentType, env.DISCORD_WEBHOOK_URL);
        if (webhookResult.success) return { ...webhookResult, mode: 'webhook' };
        errors.push(`Webhook: ${webhookResult.error}`);
    }

    if (errors.length > 0) {
        return { success: false, error: errors.join(' | ') };
    }

    return { success: false, error: 'Discord 未配置（需要 Bot 或 Webhook）' };
}

function buildWebhookMessageUrl(webhookUrl, messageId = null) {
    const base = new URL(webhookUrl);
    const path = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname;
    const target = messageId
        ? new URL(`${base.origin}${path}/messages/${messageId}`)
        : new URL(`${base.origin}${path}`);

    // 保留 thread_id 等参数，移除 wait，避免污染消息查询请求。
    base.searchParams.forEach((value, key) => {
        if (key !== 'wait') target.searchParams.set(key, value);
    });
    return target;
}

function getAttachmentInfo(message) {
    const attachment = message?.attachments?.[0];
    if (!attachment) return null;

    return {
        url: attachment.url,
        filename: attachment.filename,
        size: attachment.size,
        contentType: attachment.content_type,
        attachmentId: attachment.id
    };
}

async function uploadViaWebhook(fileBuffer, filename, contentType, webhookUrl) {
    try {
        const formData = new FormData();
        formData.append('files[0]', new Blob([fileBuffer], { type: contentType }), filename);
        formData.append('payload_json', JSON.stringify({
            content: '',
            attachments: [{ id: 0, filename }]
        }));

        const uploadUrl = buildWebhookMessageUrl(webhookUrl);
        uploadUrl.searchParams.set('wait', 'true');

        const response = await fetch(uploadUrl.toString(), {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            return { success: false, error: err.message || `HTTP ${response.status}` };
        }

        const message = await response.json();
        const attachmentInfo = getAttachmentInfo(message);
        if (!attachmentInfo) {
            return { success: false, error: '未获取到 Discord 附件信息' };
        }

        return {
            success: true,
            channelId: message.channel_id,
            messageId: message.id,
            attachmentId: attachmentInfo.attachmentId,
            filename: attachmentInfo.filename,
            size: attachmentInfo.size,
            sourceUrl: attachmentInfo.url
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function uploadViaBot(fileBuffer, filename, contentType, botToken, channelId) {
    try {
        const formData = new FormData();
        formData.append('files[0]', new Blob([fileBuffer], { type: contentType }), filename);
        formData.append('payload_json', JSON.stringify({
            content: '',
            attachments: [{ id: 0, filename }]
        }));

        const response = await fetch(
            `${DISCORD_API_BASE}/channels/${channelId}/messages`,
            {
                method: 'POST',
                headers: { 'Authorization': `Bot ${botToken}` },
                body: formData
            }
        );

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            return { success: false, error: err.message || `HTTP ${response.status}` };
        }

        const message = await response.json();
        const attachmentInfo = getAttachmentInfo(message);
        if (!attachmentInfo) {
            return { success: false, error: '未获取到 Discord 附件信息' };
        }

        return {
            success: true,
            channelId: message.channel_id,
            messageId: message.id,
            attachmentId: attachmentInfo.attachmentId,
            filename: attachmentInfo.filename,
            size: attachmentInfo.size,
            sourceUrl: attachmentInfo.url
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function getDiscordFileViaBot(channelId, messageId, botToken) {
    const response = await fetch(
        `${DISCORD_API_BASE}/channels/${channelId}/messages/${messageId}`,
        { headers: { 'Authorization': `Bot ${botToken}` } }
    );

    if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`Discord Bot API error: ${response.status}`);
    }

    const message = await response.json();
    return getAttachmentInfo(message);
}

async function getDiscordFileViaWebhook(messageId, webhookUrl) {
    const messageUrl = buildWebhookMessageUrl(webhookUrl, messageId);
    const response = await fetch(messageUrl.toString());

    if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`Discord Webhook API error: ${response.status}`);
    }

    const message = await response.json();
    return getAttachmentInfo(message);
}

/**
 * 获取 Discord 文件可访问 URL。
 * 先尝试 Bot 查询，再回退到 Webhook 查询，解决“上传成功但读取失败”链路不一致问题。
 */
export async function getDiscordFileUrl(channelId, messageId, env) {
    const lookupErrors = [];
    let attempted = false;

    if (env.DISCORD_BOT_TOKEN && channelId) {
        attempted = true;
        try {
            const file = await getDiscordFileViaBot(channelId, messageId, env.DISCORD_BOT_TOKEN);
            if (file) return file;
        } catch (error) {
            lookupErrors.push(`bot=${error.message}`);
        }
    }

    if (env.DISCORD_WEBHOOK_URL) {
        attempted = true;
        try {
            const file = await getDiscordFileViaWebhook(messageId, env.DISCORD_WEBHOOK_URL);
            if (file) return file;
        } catch (error) {
            lookupErrors.push(`webhook=${error.message}`);
        }
    }

    if (!attempted) {
        throw new Error('未配置 DISCORD_BOT_TOKEN 或 DISCORD_WEBHOOK_URL，无法获取 Discord 文件');
    }

    if (lookupErrors.length > 0) {
        throw new Error(`Discord 文件查询失败: ${lookupErrors.join(' | ')}`);
    }

    return null;
}

/**
 * 删除 Discord 消息（附件随消息删除）。
 */
export async function deleteDiscordMessage(channelId, messageId, env) {
    const botToken = env.DISCORD_BOT_TOKEN;
    if (botToken) {
        try {
            const response = await fetch(
                `${DISCORD_API_BASE}/channels/${channelId}/messages/${messageId}`,
                {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bot ${botToken}` }
                }
            );
            return response.ok || response.status === 204;
        } catch (error) {
            console.error('Discord bot delete error:', error);
        }
    }

    if (env.DISCORD_WEBHOOK_URL) {
        try {
            const messageUrl = buildWebhookMessageUrl(env.DISCORD_WEBHOOK_URL, messageId);
            const response = await fetch(messageUrl.toString(), { method: 'DELETE' });
            return response.ok || response.status === 204;
        } catch (error) {
            console.error('Discord webhook delete error:', error);
        }
    }

    return false;
}

/**
 * 检查 Discord 连接状态。
 */
export async function checkDiscordConnection(env) {
    let webhookInfo = null;
    let botInfo = null;

    if (env.DISCORD_WEBHOOK_URL) {
        try {
            const response = await fetch(env.DISCORD_WEBHOOK_URL);
            if (response.ok) {
                const data = await response.json();
                webhookInfo = {
                    mode: 'webhook',
                    name: data.name,
                    channelId: data.channel_id
                };
            }
        } catch (e) {
            // ignore
        }
    }

    if (env.DISCORD_BOT_TOKEN) {
        try {
            const response = await fetch(`${DISCORD_API_BASE}/users/@me`, {
                headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}` }
            });
            if (response.ok) {
                const data = await response.json();
                botInfo = {
                    mode: 'bot',
                    name: data.username,
                    channelId: env.DISCORD_CHANNEL_ID
                };
            }
        } catch (e) {
            // ignore
        }
    }

    if (webhookInfo && botInfo) {
        return {
            connected: true,
            mode: 'bot+webhook',
            name: `${botInfo.name} / ${webhookInfo.name}`,
            channelId: botInfo.channelId || webhookInfo.channelId
        };
    }

    if (botInfo) return { connected: true, ...botInfo };
    if (webhookInfo) return { connected: true, ...webhookInfo };
    return { connected: false };
}
