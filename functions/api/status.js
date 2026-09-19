import { createS3Client } from '../utils/s3client.js';
import { checkDiscordConnection } from '../utils/discord.js';
import { checkHuggingFaceConnection, hasHuggingFaceConfig } from '../utils/huggingface.js';
import { checkWebDAVConnection, hasWebDAVConfig } from '../utils/webdav.js';
import { checkGitHubConnection, hasGitHubConfig } from '../utils/github.js';
import { getGuestConfig } from '../utils/guest.js';
import { checkAuthentication } from '../utils/auth.js';
import { buildTelegramBotApiUrl, getTelegramApiBase } from '../utils/telegram.js';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const DIRECT_UPLOAD_THRESHOLD = 20 * MB;
const CHUNK_UPLOAD_LIMIT = 100 * MB;
const OBJECT_STORAGE_LIMIT = 2048 * MB; // 2GB

function storageCapability(type, label, layer = 'direct') {
  return {
    type,
    label,
    layer,
    enableHint: 'Configure this storage backend first.',
  };
}

export async function onRequestGet(context) {
  const { env } = context;

  // The public upload UI needs to know which storage backends are offered
  // (index.html derives its storage selector from these flags), so the
  // `enabled`/`configured` pair stays public. The live connectivity probes and
  // the backend messages/details are diagnostics and are admin-only.
  const auth = await checkAuthentication(context);
  const isAdmin = Boolean(auth?.authenticated);

  const configuredMap = {
    telegram: Boolean(env.TG_Bot_Token && env.TG_Chat_ID),
    kv: Boolean(env.img_url),
    r2: Boolean(env.R2_BUCKET),
    s3: Boolean(env.S3_ENDPOINT && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY && env.S3_BUCKET),
    discord: Boolean(env.DISCORD_WEBHOOK_URL || env.DISCORD_BOT_TOKEN),
    huggingface: hasHuggingFaceConfig(env),
    webdav: hasWebDAVConfig(env),
    github: hasGitHubConfig(env),
  };

  // `enabled` mirrors `configured` here so index.html's isEnabled() check
  // (connected || configured || enabled, with enabled !== false) still resolves
  // for anonymous visitors without running any network probe.
  const configuredItem = (key, layer = 'direct') => ({
    connected: false,
    enabled: Boolean(configuredMap[key]),
    configured: Boolean(configuredMap[key]),
    layer,
  });

  const status = {
    telegram: configuredItem('telegram'),
    kv: configuredItem('kv'),
    r2: configuredItem('r2'),
    s3: configuredItem('s3'),
    discord: configuredItem('discord'),
    huggingface: configuredItem('huggingface'),
    webdav: configuredItem('webdav', 'mounted'),
    github: configuredItem('github'),
    auth: { enabled: Boolean(env.BASIC_USER && env.BASIC_PASS) },
    guestUpload: getGuestConfig(env),
    uploadLimits: getUploadLimits(),
    capabilities: [
      storageCapability('telegram', 'Telegram', 'direct'),
      storageCapability('r2', 'R2', 'direct'),
      storageCapability('s3', 'S3', 'direct'),
      storageCapability('discord', 'Discord', 'direct'),
      storageCapability('huggingface', 'HuggingFace', 'direct'),
      storageCapability('webdav', 'WebDAV', 'mounted'),
      storageCapability('github', 'GitHub', 'direct'),
    ],
  };

  // Anonymous callers stop here: no outbound connectivity probes are triggered
  // by unauthenticated requests, and no backend messages, upstream error
  // details, bucket/repo identifiers or bot identity are disclosed.
  if (!isAdmin) {
    return new Response(JSON.stringify(status, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
    });
  }

  const checks = [];

  if (env.TG_Bot_Token && env.TG_Chat_ID) {
    status.telegram.configured = true;
    checks.push(
      fetch(buildTelegramBotApiUrl(env, 'getMe'))
        .then((res) => res.json())
        .then((data) => {
          if (data?.ok) {
            status.telegram = {
              connected: true,
              enabled: true,
              configured: true,
              layer: 'direct',
              message: `Connected: @${data.result.username}`,
              botName: data.result.first_name,
              botUsername: data.result.username,
              apiBase: getTelegramApiBase(env),
            };
          } else {
            status.telegram = {
              connected: false,
              enabled: true,
              configured: true,
              layer: 'direct',
              message: data?.description || 'Telegram API check failed',
            };
          }
        })
        .catch((error) => {
          status.telegram = {
            connected: false,
            enabled: true,
            configured: true,
            layer: 'direct',
            message: error.message || 'Telegram API check failed',
          };
        })
    );
  }

  if (env.img_url) {
    status.kv.configured = true;
    checks.push(
      env.img_url.list({ limit: 1 })
        .then((result) => {
          status.kv = {
            connected: true,
            enabled: true,
            configured: true,
            layer: 'direct',
            message: 'Connected',
            hasData: Array.isArray(result?.keys) && result.keys.length > 0,
          };
        })
        .catch((error) => {
          status.kv = {
            connected: false,
            enabled: false,
            configured: true,
            layer: 'direct',
            message: error.message || 'KV check failed',
          };
        })
    );
  }

  if (env.R2_BUCKET) {
    status.r2.configured = true;
    checks.push(
      env.R2_BUCKET.list({ limit: 1 })
        .then((result) => {
          status.r2 = {
            connected: true,
            enabled: true,
            configured: true,
            layer: 'direct',
            message: 'Connected',
            hasData: Array.isArray(result?.objects) && result.objects.length > 0,
          };
        })
        .catch((error) => {
          status.r2 = {
            connected: false,
            enabled: true,
            configured: true,
            layer: 'direct',
            message: error.message || 'R2 check failed',
          };
        })
    );
  }

  if (env.S3_ENDPOINT && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY && env.S3_BUCKET) {
    status.s3.configured = true;
    checks.push(
      (async () => {
        try {
          const s3 = createS3Client(env);
          const connected = await s3.checkConnection();
          status.s3 = {
            connected,
            enabled: connected,
            configured: true,
            layer: 'direct',
            message: connected ? `Connected: ${env.S3_BUCKET}` : 'S3 check failed',
          };
        } catch (error) {
          status.s3 = {
            connected: false,
            enabled: true,
            configured: true,
            layer: 'direct',
            message: error.message || 'S3 check failed',
          };
        }
      })()
    );
  }

  if (env.DISCORD_WEBHOOK_URL || env.DISCORD_BOT_TOKEN) {
    status.discord.configured = true;
    checks.push(
      checkDiscordConnection(env)
        .then((result) => {
          status.discord = {
            connected: Boolean(result?.connected),
            enabled: Boolean(result?.connected),
            configured: true,
            layer: 'direct',
            message: result?.connected
              ? `Connected (${result.mode || 'unknown'})`
              : 'Discord check failed',
            mode: result?.mode,
          };
        })
        .catch((error) => {
          status.discord = {
            connected: false,
            enabled: true,
            configured: true,
            layer: 'direct',
            message: error.message || 'Discord check failed',
          };
        })
    );
  }

  if (hasHuggingFaceConfig(env)) {
    status.huggingface.configured = true;
    checks.push(
      checkHuggingFaceConnection(env)
        .then((result) => {
          status.huggingface = {
            connected: Boolean(result?.connected),
            enabled: Boolean(result?.connected),
            configured: true,
            layer: 'direct',
            message: result?.connected
              ? `Connected: ${result.repoId}${result.isPrivate ? ' (private)' : ''}`
              : (result?.error || 'HuggingFace check failed'),
          };
        })
        .catch((error) => {
          status.huggingface = {
            connected: false,
            enabled: true,
            configured: true,
            layer: 'direct',
            message: error.message || 'HuggingFace check failed',
          };
        })
    );
  }

  if (hasWebDAVConfig(env)) {
    status.webdav.configured = true;
    checks.push(
      checkWebDAVConnection(env)
        .then((result) => {
          status.webdav = {
            connected: Boolean(result?.connected),
            enabled: Boolean(result?.connected),
            configured: true,
            layer: 'mounted',
            message: result?.connected ? 'Connected' : (result?.message || 'WebDAV check failed'),
            detail: result?.detail,
            status: result?.status,
          };
        })
        .catch((error) => {
          status.webdav = {
            connected: false,
            enabled: true,
            configured: true,
            layer: 'mounted',
            message: error.message || 'WebDAV check failed',
          };
        })
    );
  }

  if (hasGitHubConfig(env)) {
    status.github.configured = true;
    checks.push(
      checkGitHubConnection(env)
        .then((result) => {
          status.github = {
            connected: Boolean(result?.connected),
            enabled: Boolean(result?.connected),
            configured: true,
            layer: 'direct',
            message: result?.connected ? 'Connected' : (result?.message || 'GitHub check failed'),
            mode: result?.mode,
            status: result?.status,
            detail: result?.detail,
          };
        })
        .catch((error) => {
          status.github = {
            connected: false,
            enabled: true,
            configured: true,
            layer: 'direct',
            message: error.message || 'GitHub check failed',
          };
        })
    );
  }

  if (env.BASIC_USER && env.BASIC_PASS) {
    status.auth = {
      enabled: true,
      message: 'Enabled',
    };
  }

  await Promise.allSettled(checks);

  return new Response(JSON.stringify(status, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
    },
  });
}

function getUploadLimits() {
  return {
    telegram: {
      maxBytes: DIRECT_UPLOAD_THRESHOLD,
      directThreshold: DIRECT_UPLOAD_THRESHOLD,
      supportsChunkUpload: false,
      message: 'Cloudflare Pages 上的 Telegram 网页上传限制为 20MB。较大的浏览器上传请使用 R2、S3、WebDAV 或 GitHub，或直接把文件发到 Telegram 后使用 Webhook 回链。',
    },
    r2: {
      maxBytes: OBJECT_STORAGE_LIMIT, // 提升至 2GB (2048MB)
      directThreshold: DIRECT_UPLOAD_THRESHOLD,
      supportsChunkUpload: true,
    },
    s3: {
      maxBytes: OBJECT_STORAGE_LIMIT, // 提升至 2GB (2048MB)
      directThreshold: DIRECT_UPLOAD_THRESHOLD,
      supportsChunkUpload: true,
    },
    discord: {
      maxBytes: 25 * MB,
      directThreshold: DIRECT_UPLOAD_THRESHOLD,
      supportsChunkUpload: true,
      message: 'Discord 上传上限受服务器加成影响，K-Vault 默认按 25MB 保守处理。',
    },
    huggingface: {
      maxBytes: 35 * MB,
      directThreshold: DIRECT_UPLOAD_THRESHOLD,
      supportsChunkUpload: true,
    },
    webdav: {
      maxBytes: CHUNK_UPLOAD_LIMIT,
      directThreshold: DIRECT_UPLOAD_THRESHOLD,
      supportsChunkUpload: true,
    },
    github: {
      maxBytes: CHUNK_UPLOAD_LIMIT,
      directThreshold: DIRECT_UPLOAD_THRESHOLD,
      supportsChunkUpload: true,
    },
  };
}
