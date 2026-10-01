/**
 * 统一环境变量读取层
 *
 * 背景：Cloudflare Pages 的环境变量**区分大小写**。历史上同一配置出现过两套
 * 写法（例如 `TG_Bot_Token` 与 `TG_BOT_TOKEN`），而不同模块各自只认其中一种：
 * 按文档填了大写的别名，主上传路径却读混合大小写的主用名，结果「填了但不生效」，
 * 且没有任何报错。此前文档只能建议「两个都写上」，等于一个值要填两遍。
 *
 * 解法：这里为每个逻辑变量声明它可接受的写法（按优先级），读取时取第一个非空值。
 * 于是**填任意一种写法都能生效**，部署时只需填一次。
 *
 * 未登记在 ALIASES 里的变量名按原样读取（透传），因此可安全用于任意变量。
 */

/** 逻辑变量名 → 可接受的写法（按优先级取第一个非空值） */
const ALIASES = {
  // Telegram 主用名是混合大小写，大写是历史别名
  TG_BOT_TOKEN: ['TG_Bot_Token', 'TG_BOT_TOKEN'],
  TG_CHAT_ID: ['TG_Chat_ID', 'TG_CHAT_ID'],

  TG_UPLOAD_NOTIFY: ['TG_UPLOAD_NOTIFY', 'TELEGRAM_UPLOAD_NOTIFY'],
  TELEGRAM_WEBHOOK_SECRET: ['TELEGRAM_WEBHOOK_SECRET', 'TG_WEBHOOK_SECRET'],

  // 签名直链密钥：FILE_URL_SECRET 为主用名，TG_FILE_URL_SECRET 为兼容名
  FILE_URL_SECRET: ['FILE_URL_SECRET', 'TG_FILE_URL_SECRET'],

  // WebDAV Bearer：优先完整名，兼容短名
  WEBDAV_BEARER_TOKEN: ['WEBDAV_BEARER_TOKEN', 'WEBDAV_TOKEN'],
};

/**
 * 读取一个环境变量（自动兼容大小写 / 历史别名）。
 *
 * @param {object} env - Pages 环境
 * @param {string} name - 逻辑变量名（见 ALIASES；未登记则按原样读）
 * @returns {string} 去空白后的值；全都没配则返回空字符串
 */
export function envValue(env, name) {
  const keys = ALIASES[name] || [name];
  for (const key of keys) {
    const raw = env?.[key];
    if (raw == null) continue;
    const text = String(raw).trim();
    if (text) return text;
  }
  return '';
}

/** 该变量是否已配置（非空） */
export function envHas(env, name) {
  return Boolean(envValue(env, name));
}
