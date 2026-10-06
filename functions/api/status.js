import { envValue } from '../utils/env-config.js';
import { createS3Client } from '../utils/s3client.js';
import { checkDiscordConnection } from '../utils/discord.js';
import { checkHuggingFaceConnection, hasHuggingFaceConfig } from '../utils/huggingface.js';
import { checkWebDAVConnection, hasWebDAVConfig } from '../utils/webdav.js';
import { getWebdavServerConfig } from '../utils/runtime-config.js';
import { checkGitHubConnection, hasGitHubConfig } from '../utils/github.js';
import { getGuestConfig } from '../utils/guest.js';
import { checkAuthentication, isAuthRequired } from '../utils/auth.js';
import { buildTelegramBotApiUrl, getTelegramApiBase } from '../utils/telegram.js';
import {
  MAX_IN_MEMORY_ASSEMBLY,
  TELEGRAM_WEB_UPLOAD_LIMIT,
  DISCORD_UPLOAD_LIMIT,
  HUGGINGFACE_UPLOAD_LIMIT,
} from '../utils/chunk-limits.js';

const MB = 1024 * 1024;
const GB = 1024 * MB;
const DIRECT_UPLOAD_THRESHOLD = 20 * MB;
const R2_OBJECT_STORAGE_LIMIT = 10 * GB;   // R2：10GB（原生 multipart）
// 非 R2 存储（S3 / WebDAV / GitHub）走 KV 中转 + 内存拼装，
// 上限由 chunk-limits.js 的 MAX_IN_MEMORY_ASSEMBLY 统一约束
const NON_R2_UPLOAD_LIMIT = MAX_IN_MEMORY_ASSEMBLY;

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

  // 谁能看「管理诊断」（连通性探测 / 桶名 / 仓库名 / bot 身份 / 上游错误详情）：
  //   - 配置了认证（BASIC_USER + BASIC_PASS）的实例：必须是真实登录用户；
  //   - 完全没配认证的「开放实例」：**默认也不再对匿名放行**。以前这里写成
  //     `isAuthRequired(env) ? authenticated : true`，于是开放实例下 isAdmin
  //     恒为 true —— 匿名访客能拿到 bot 用户名、S3 桶名、HuggingFace 仓库名，
  //     并且每次匿名请求都会触发一轮对外连通性探测。
  //     现在默认关闭，仅当显式设置 PUBLIC_STATUS_DIAGNOSTICS=true 才恢复
  //     （自建/内网排障用）。
  const auth = await checkAuthentication(context);
  const authConfigured = isAuthRequired(env);
  const isAdmin = authConfigured
    ? Boolean(auth?.authenticated)
    : envValue(env, 'PUBLIC_STATUS_DIAGNOSTICS') === 'true';

  // 已开启认证的实例：未登录访客本就被 checkAuth 置为 guestBlocked（无权上传），
  // 因此后端清单与限额表一律不下发 —— 那是纯架构信息。
  //
  // 状态码同样收紧：修复前这里无论发生什么都返回 **200 + 67B**
  // （`{"auth":{"enabled":true},"authenticated":false,"requireLogin":true}`），
  // 于是「这是个私有实例、要登录」这件内部事实，成了匿名也能读到的公开情报。
  // 现在未登录一律 **401**，让这次访问在语义上就是一次失败的鉴权。
  //
  // 唯一例外是开了访客上传的实例：访客确实要用本接口读自己的配额，此时只
  // 下发它自己的那一小份，其余一概不给。
  if (authConfigured && !auth?.authenticated) {
    const guest = await getGuestConfig(env);
    const body = guest?.enabled
      ? {
          auth: { enabled: true },
          authenticated: false,
          guestUpload: guest,
          uploadLimits: { telegram: publicLimit(getUploadLimits().telegram) },
        }
      : {
          error: 'LOGIN_REQUIRED',
          auth: { enabled: true },
          authenticated: false,
          requireLogin: true,
        };
    return jsonResponse(body, guest?.enabled ? 200 : 401);
  }

  const configuredMap = {
    telegram: Boolean(envValue(env, 'TG_BOT_TOKEN') && envValue(env, 'TG_CHAT_ID')),
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
    guestUpload: await getGuestConfig(env),
    uploadLimits: getUploadLimits(),
  };

  // WebDAV **服务端**状态（与本项目作为 WebDAV「客户端」的 webdav 字段无关）。
  // 供 webdav.html 展示连接信息。**只下发启用状态与后端，绝不含用户名/密码**。
  {
    const webdavServer = await getWebdavServerConfig(env);
    status.webdavServer = {
      enabled: webdavServer.enabled === true,
      readOnly: webdavServer.readOnly === true,
      backend: webdavServer.backend || 'telegram',
      mountPath: '/dav',
    };
  }

  // Anonymous callers stop here: no outbound connectivity probes are triggered
  // by unauthenticated requests, and no backend messages, upstream error
  // details, bucket/repo identifiers or bot identity are disclosed.
  //
  // 匿名响应再砍两刀：
  //   · `capabilities` —— 无论是否配置都把七种后端列全，是纯粹的架构清单，
  //     前端并不消费它（index.js 只读每个后端的 enabled/configured/connected
  //     和 uploadLimits），所以只留给管理员。
  //   · `uploadLimits[*].message` —— 给运维看的中文说明，跟上传能力无关，
  //     占掉匿名响应的大半体积。
  if (!isAdmin) {
    const limits = status.uploadLimits || {};
    status.uploadLimits = {};
    for (const [key, value] of Object.entries(limits)) {
      status.uploadLimits[key] = publicLimit(value);
    }
    return jsonResponse(status);
  }

  status.capabilities = [
    storageCapability('telegram', 'Telegram', 'direct'),
    storageCapability('r2', 'R2', 'direct'),
    storageCapability('s3', 'S3', 'direct'),
    storageCapability('discord', 'Discord', 'direct'),
    storageCapability('huggingface', 'HuggingFace', 'direct'),
    storageCapability('webdav', 'WebDAV', 'mounted'),
    storageCapability('github', 'GitHub', 'direct'),
  ];

  const checks = [];

  if (envValue(env, 'TG_BOT_TOKEN') && envValue(env, 'TG_CHAT_ID')) {
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

  return jsonResponse(status);
}

/** 匿名可见的上传限额字段：只留上传必需的三个，`message` 是运维说明，不下发 */
function publicLimit(limit = {}) {
  return {
    maxBytes: limit.maxBytes,
    directThreshold: limit.directThreshold,
    supportsChunkUpload: Boolean(limit.supportsChunkUpload),
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      // 曾用 null,2 美化输出，白吃掉一半体积；状态本身也不该进任何缓存
      'Cache-Control': 'no-store',
    },
  });
}

function getUploadLimits() {
  return {
    telegram: {
      maxBytes: TELEGRAM_WEB_UPLOAD_LIMIT, // 20MB
      directThreshold: TELEGRAM_WEB_UPLOAD_LIMIT,
      supportsChunkUpload: false,
      message: 'Cloudflare Pages 上的 Telegram 网页上传限制为 20MB。较大的浏览器上传请使用 R2、S3、WebDAV 或 GitHub，或直接把文件发到 Telegram 后使用 Webhook 回链。',
    },
    r2: {
      maxBytes: R2_OBJECT_STORAGE_LIMIT, // 10GB
      directThreshold: DIRECT_UPLOAD_THRESHOLD,
      supportsChunkUpload: true,
    },
    s3: {
      maxBytes: NON_R2_UPLOAD_LIMIT, // 40MB
      directThreshold: DIRECT_UPLOAD_THRESHOLD,
      supportsChunkUpload: true,
      message: 'S3 走 KV 中转分片上传，单文件上限 40MB。需要传大文件请选 R2（10GB）。',
    },
    discord: {
      maxBytes: DISCORD_UPLOAD_LIMIT, // 25MB
      directThreshold: DIRECT_UPLOAD_THRESHOLD,
      supportsChunkUpload: true,
      message: 'Discord 上传上限受服务器加成影响，K-Vault 默认按 25MB 保守处理。',
    },
    huggingface: {
      maxBytes: HUGGINGFACE_UPLOAD_LIMIT, // 35MB
      directThreshold: DIRECT_UPLOAD_THRESHOLD,
      supportsChunkUpload: true,
    },
    webdav: {
      maxBytes: NON_R2_UPLOAD_LIMIT, // 40MB
      directThreshold: DIRECT_UPLOAD_THRESHOLD,
      supportsChunkUpload: true,
      message: 'WebDAV 走 KV 中转分片上传，单文件上限 40MB。需要传大文件请选 R2（10GB）。',
    },
    github: {
      maxBytes: NON_R2_UPLOAD_LIMIT, // 40MB
      directThreshold: DIRECT_UPLOAD_THRESHOLD,
      supportsChunkUpload: true,
      message: 'GitHub 走 KV 中转分片上传，单文件上限 40MB。需要传大文件请选 R2（10GB）。',
    },
  };
}