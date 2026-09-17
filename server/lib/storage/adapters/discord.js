const DISCORD_API_BASE = 'https://discord.com/api/v10';

function buildWebhookMessageUrl(webhookUrl, messageId = null) {
  const base = new URL(webhookUrl);
  const path = base.pathname.endsWith('/') ? base.pathname.slice(0, -1) : base.pathname;
  const target = messageId
    ? new URL(`${base.origin}${path}/messages/${messageId}`)
    : new URL(`${base.origin}${path}`);

  base.searchParams.forEach((value, key) => {
    if (key !== 'wait') target.searchParams.set(key, value);
  });

  return target;
}

function getAttachment(message) {
  const attachment = message?.attachments?.[0];
  if (!attachment) return null;
  return {
    id: attachment.id,
    url: attachment.url,
    filename: attachment.filename,
    size: attachment.size,
    contentType: attachment.content_type,
  };
}

async function uploadViaWebhook({ webhookUrl, buffer, fileName, mimeType }) {
  const formData = new FormData();
  formData.append('files[0]', new File([buffer], fileName, { type: mimeType || 'application/octet-stream' }));
  formData.append('payload_json', JSON.stringify({
    content: '',
    attachments: [{ id: 0, filename: fileName }],
  }));

  const target = buildWebhookMessageUrl(webhookUrl);
  target.searchParams.set('wait', 'true');

  const response = await fetch(target.toString(), {
    method: 'POST',
    body: formData,
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.message || `Discord webhook upload failed (${response.status})`);
  }

  const attachment = getAttachment(json);
  if (!attachment) {
    throw new Error('Discord upload missing attachment metadata.');
  }

  return {
    channelId: json.channel_id,
    messageId: json.id,
    attachmentId: attachment.id,
    sourceUrl: attachment.url,
  };
}

async function uploadViaBot({ botToken, channelId, buffer, fileName, mimeType }) {
  const formData = new FormData();
  formData.append('files[0]', new File([buffer], fileName, { type: mimeType || 'application/octet-stream' }));
  formData.append('payload_json', JSON.stringify({
    content: '',
    attachments: [{ id: 0, filename: fileName }],
  }));

  const response = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${botToken}` },
    body: formData,
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.message || `Discord bot upload failed (${response.status})`);
  }

  const attachment = getAttachment(json);
  if (!attachment) {
    throw new Error('Discord upload missing attachment metadata.');
  }

  return {
    channelId: json.channel_id,
    messageId: json.id,
    attachmentId: attachment.id,
    sourceUrl: attachment.url,
  };
}

async function fetchMessageViaBot({ botToken, channelId, messageId }) {
  const response = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages/${messageId}`, {
    headers: { Authorization: `Bot ${botToken}` },
  });

  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`Discord bot message lookup failed (${response.status})`);
  }

  const json = await response.json();
  return getAttachment(json);
}

async function fetchMessageViaWebhook({ webhookUrl, messageId }) {
  const response = await fetch(buildWebhookMessageUrl(webhookUrl, messageId).toString());
  if (!response.ok) {
    if (response.status === 404) return null;
    throw new Error(`Discord webhook message lookup failed (${response.status})`);
  }

  const json = await response.json();
  return getAttachment(json);
}

class DiscordStorageAdapter {
  constructor(config) {
    this.type = 'discord';
    this.config = {
      webhookUrl: config.webhookUrl,
      botToken: config.botToken,
      channelId: config.channelId,
    };
  }

  validate() {
    if (!this.config.webhookUrl && !(this.config.botToken && this.config.channelId)) {
      throw new Error('Discord storage requires webhookUrl or botToken + channelId.');
    }
  }

  async testConnection() {
    this.validate();

    if (this.config.botToken) {
      const botResponse = await fetch(`${DISCORD_API_BASE}/users/@me`, {
        headers: { Authorization: `Bot ${this.config.botToken}` },
      });
      if (botResponse.ok) {
        return { connected: true, mode: 'bot' };
      }
    }

    if (this.config.webhookUrl) {
      const webhookResponse = await fetch(this.config.webhookUrl);
      if (webhookResponse.ok) {
        return { connected: true, mode: 'webhook' };
      }
    }

    return { connected: false };
  }

  async upload({ buffer, fileName, mimeType, fileSize }) {
    this.validate();

    // Discord upload size depends on boost tier. Use conservative default.
    const maxSize = 25 * 1024 * 1024;
    if (fileSize > maxSize) {
      throw new Error('Discord upload limit exceeded (25MB).');
    }

    let result;
    let mode = null;

    if (this.config.botToken && this.config.channelId) {
      try {
        result = await uploadViaBot({
          botToken: this.config.botToken,
          channelId: this.config.channelId,
          buffer,
          fileName,
          mimeType,
        });
        mode = 'bot';
      } catch (error) {
        if (!this.config.webhookUrl) throw error;
      }
    }

    if (!result && this.config.webhookUrl) {
      result = await uploadViaWebhook({
        webhookUrl: this.config.webhookUrl,
        buffer,
        fileName,
        mimeType,
      });
      mode = 'webhook';
    }

    if (!result) {
      throw new Error('Discord upload failed.');
    }

    return {
      storageKey: `${result.channelId}:${result.messageId}`,
      metadata: {
        discordChannelId: result.channelId,
        discordMessageId: result.messageId,
        discordAttachmentId: result.attachmentId,
        discordMode: mode,
      },
    };
  }

  async download({ metadata = {}, storageKey, range }) {
    this.validate();

    const [fallbackChannelId, fallbackMessageId] = String(storageKey || '').split(':');
    const channelId = metadata.discordChannelId || fallbackChannelId;
    const messageId = metadata.discordMessageId || fallbackMessageId;

    let attachment = null;

    if (this.config.botToken && channelId && messageId) {
      attachment = await fetchMessageViaBot({
        botToken: this.config.botToken,
        channelId,
        messageId,
      });
    }

    if (!attachment && this.config.webhookUrl && messageId) {
      attachment = await fetchMessageViaWebhook({
        webhookUrl: this.config.webhookUrl,
        messageId,
      });
    }

    if (!attachment?.url) return null;

    const headers = {};
    if (range) headers.Range = range;

    const response = await fetch(attachment.url, { headers });
    if (!response.ok && response.status !== 206) {
      throw new Error(`Discord attachment fetch failed (${response.status}).`);
    }

    return response;
  }

  async delete({ metadata = {}, storageKey }) {
    const [fallbackChannelId, fallbackMessageId] = String(storageKey || '').split(':');
    const channelId = metadata.discordChannelId || fallbackChannelId;
    const messageId = metadata.discordMessageId || fallbackMessageId;

    if (!messageId) return false;

    if (this.config.botToken && channelId) {
      const response = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages/${messageId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bot ${this.config.botToken}` },
      });
      if (response.ok || response.status === 204 || response.status === 404) return true;
    }

    if (this.config.webhookUrl) {
      const response = await fetch(buildWebhookMessageUrl(this.config.webhookUrl, messageId).toString(), {
        method: 'DELETE',
      });
      return Boolean(response.ok || response.status === 204 || response.status === 404);
    }

    return false;
  }
}

module.exports = {
  DiscordStorageAdapter,
};
