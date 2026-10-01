/**
 * 隔空投送（Airdrop）核心逻辑
 *
 * ============================================================================
 * 这个模块只管「房间状态机 + 临时文件周转」，不管 HTTP 细节（那是
 * functions/api/airdrop/*.js 的事），也不管界面（那是 assets/js/airdrop.js
 * 的事）。分层是为了让状态机的每一次跃迁都能被单独推理和单独测试。
 *
 * 一次投递的完整状态机：
 *
 *   waiting ──收端凭连接码加入──▶ linked ──发端逐文件上传──▶ uploading
 *      │                            │                        │
 *      │                            │                        └──全部上传完成──▶ uploaded
 *      └──超时/取消──▶ expired / cancelled                        │
 *                                                                 └──收端逐文件下载──▶ done（删临时文件）
 *
 * 两端都靠轮询 /api/airdrop/status 推进，不用 WebSocket：Cloudflare Pages
 * Functions 目前没有长连接能力，而隔空投送的状态跃迁频率极低（秒级），
 * 轮询的成本（每次一个 D1 查询）远低于引入额外基础设施的复杂度。
 *
 * ============================================================================
 * 中转节点（v2：删掉 KV，仅保留 R2 + Telegram）
 * ============================================================================
 *
 * KV 是最终一致的键值库，做"私密临时传输"既不可靠（写后读可能短暂读不到）
 * 也不经济（按读计量、25MB 硬顶）。隔空投送的中转只需要「写→读→删」闭环，
 * 所以只保留两种真正合适的中转：
 *   · R2       —— 私有对象存储，读写删即时，100MB
 *   · Telegram —— 频道消息，file_id 索引、deleteMessage 清理，20MB
 *
 * 具体用哪个节点由**发端在界面上选**（默认沿用 index 页当前选的节点），
 * 后端只做可用性与上限校验，不替用户做主。
 *
 * ============================================================================
 * 多文件模型
 * ============================================================================
 *
 * 一个房间（airdrop_sessions）可以传送多个文件。文件清单存在
 * files_json 列里（一组条目，每条带自己的 storage_backend/key/meta）。
 * 发端逐文件上传，每个文件落地后追加一条；最后一个带 final 标记，
 * 房间从 uploading 翻到 uploaded，收端才开始逐文件下载。
 * ============================================================================
 *
 * 为什么需要一个「收端凭证」
 * ============================================================================
 *
 * 8 位连接码是**给人看的**，不是给机器做鉴权的：它的熵只有约 39 bit，而且
 * 会出现在二维码里、可能被旁人看到、可能被口述。仅凭连接码就能下载，等于
 * 任何看到二维码的人都能截走文件。
 *
 * 所以加入房间时后端会签发一个 192 bit 的 receiver_token，下载必须带它。
 * 连接码负责「找到房间」，凭证负责「证明你是那个房间的人」。
 * ============================================================================
 */
import { ensureSchema } from './schema.js';
import { getAirdropConfig } from './runtime-config.js';
import { getClientIp } from './ratelimit.js';
import { checkAuthentication, isAuthRequired } from './auth.js';
import { envValue } from './env-config.js';
import {
  getTelegramUploadMethodAndField,
  buildTelegramBotApiUrl,
  buildTelegramFileUrl,
  pickTelegramFileId
} from './telegram.js';

// ── 连接码 ──────────────────────────────────────────────────
// 去掉了 0/O、1/I/L 三个视觉上容易混的字符。连接码是要被念出来或被手打的，
// 「看起来像什么」比「熵高多少」更重要。
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_MAX_ATTEMPTS = 6;

// ── 存储节点能力上限 ────────────────────────────────────────
// Telegram 网页上传路径（浏览器 → Worker → Bot API）与项目主上传保持一致，
// 保守按 20MB 处理：真正的 Bot API 文档上限虽更高，但经由 Worker 转发时
// 受请求体大小与超时约束，20MB 是稳妥的边界。
const TG_MAX_FILE_SIZE = 20 * 1024 * 1024;
// R2 单对象理论上限很高，但真正卡住的是 Pages Functions 的请求体大小：
// 文件必须先完整进入 Worker 才能落地，超过这个数请求会被平台直接拒。
const R2_MAX_FILE_SIZE = 100 * 1024 * 1024;

const R2_PREFIX = 'airdrop/';

/** 终态：进入这些状态后房间不再接受任何写操作 */
const TERMINAL_STATUSES = ['done', 'failed', 'cancelled', 'expired'];

// ============================================================================
// 响应
// ============================================================================

/**
 * 统一 JSON 响应。
 *
 * 隔空投送的接口全部由本站点页面同源调用，不需要（也不该）加 CORS 头 ——
 * 加了反而把接口开放给任意站点。no-store 是必须的：房间状态是实时数据，
 * 被任何一层缓存住都会让两端看到不同的进度。
 */
export function jsonResponse(data, status = 200, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(extraHeaders || {})
    }
  });
}

// ============================================================================
// 随机量
// ============================================================================

/**
 * 生成 8 位连接码。
 *
 * 取模会有微小偏置（256 不是 31 的整数倍），对连接码这种「撞了就重试」
 * 的场景无影响 —— 它不是密钥，不做拒绝采样以免代码复杂化。
 */
export function generateCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

/** 生成房间凭证（192 bit，十六进制） */
export function generateToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function nowMs() {
  return Date.now();
}

/** 当天日期键（UTC），与 guest.js 的口径一致 */
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// ============================================================================
// 存储节点
// ============================================================================

/**
 * 当前环境可用的中转节点列表。
 *
 * 只有真正能完成「写→读→删」闭环的节点才计入：
 *   · R2       —— 私有对象存储，即时读写删，100MB
 *   · Telegram —— 频道消息，file_id 索引、deleteMessage 清理，20MB
 *
 * KV 已移除：最终一致 + 25MB 硬顶，不适合私密临时传输。
 */
export function availableBackends(env) {
  const out = [];
  if (env?.R2_BUCKET && typeof env.R2_BUCKET.put === 'function') {
    out.push({ key: 'r2', label: 'R2', maxBytes: R2_MAX_FILE_SIZE });
  }
  // 必须走 envValue（而不是裸读 env.TG_BOT_TOKEN）：Telegram 的主用名是混合
  // 大小写 TG_Bot_Token，TG_BOT_TOKEN 只是历史别名。裸读会让"按文档填了主用名"
  // 的部署在这里判成未配置 —— 主上传正常、隔空投送却说没有中转节点。
  if (envValue(env, 'TG_BOT_TOKEN') && envValue(env, 'TG_CHAT_ID')) {
    out.push({ key: 'telegram', label: 'Telegram', maxBytes: TG_MAX_FILE_SIZE });
  }
  return out;
}

/** 校验某个具体节点在当前环境是否可用，可用则返回 {key,label,maxBytes} */
export function nodeInfo(env, node) {
  return availableBackends(env).find((b) => b.key === node) || null;
}

/**
 * 向后兼容的「挑一个节点」：取可用列表里的第一个。
 * 新逻辑里节点由发端显式选择，这个函数只给统计/能力探测等不需要指定
 * 节点的场景用（返回主节点用于显示标签）。
 */
export function resolveBackend(env) {
  const list = availableBackends(env);
  if (!list.length) return { backend: null, maxBytes: 0, label: '未配置' };
  const b = list[0];
  return { backend: b.key, maxBytes: b.maxBytes, label: b.label };
}

function storageKeyFor(code, seq, fileName) {
  const safe = String(fileName || 'file').replace(/[^\w.\-一-龥]/g, '_').slice(0, 64);
  return `${R2_PREFIX}${code}/${String(seq).padStart(3, '0')}-${safe}`;
}

// ============================================================================
// 访客判定与门禁
// ============================================================================

/**
 * 当前请求是否是访客。
 *
 * 站点根本没开认证时（isAuthRequired=false），所有人都能用全部功能，
 * 此时把所有人当访客会误伤 —— 那种部署形态下"访客"这个概念不存在。
 */
export async function isGuestRequest(request, env) {
  if (!isAuthRequired(env)) return false;
  try {
    const result = await checkAuthentication({ request, env });
    return !result?.authenticated;
  } catch {
    // 认证检查自身出错时按访客处理：宁可多拦一次，不可误放行
    return true;
  }
}

/**
 * 发端门禁：这个请求能不能**发起/发送**一次投递（create）。
 *
 * 检查顺序是「便宜的先做」：功能总开关 → 节点可用性 → 访客权限 → 每日次数。
 *
 * ⚠️ 本函数是**发端语义**。收端加入（join）请用 checkAirdropReceiveAccess ——
 * 访客能不能当收端由独立开关 guestReceiveAllowed 决定，与这里的
 * guestAllowed（访客能否发起）不是一回事。曾经 join 复用了本函数，
 * 导致授权用户开的房间、访客扫码也收不了文件。
 */
export async function checkAirdropAccess(request, env) {
  const cfg = await getAirdropConfig(env);
  if (!cfg.enabled) {
    return { allowed: false, status: 403, code: 'AIRDROP_DISABLED', reason: '隔空投送已关闭' };
  }

  const nodes = availableBackends(env);
  if (!nodes.length) {
    return {
      allowed: false,
      status: 503,
      code: 'AIRDROP_NO_STORAGE',
      reason: '未绑定 R2 或 Telegram，隔空投送没有可用的中转节点'
    };
  }

  const isGuest = await isGuestRequest(request, env);
  if (isGuest && !cfg.guestAllowed) {
    return {
      allowed: false,
      status: 401,
      code: 'AIRDROP_GUEST_DENIED',
      reason: '当前未开放访客发起投送，请先登录'
    };
  }

  const ip = getClientIp(request);
  const used = await readDailyCount(env, ip);
  if (used >= cfg.dailyLimit) {
    return {
      allowed: false,
      status: 429,
      code: 'AIRDROP_DAILY_LIMIT',
      reason: `今日隔空投送次数已达上限（${cfg.dailyLimit} 次）`
    };
  }

  return { allowed: true, isGuest, ip, config: cfg, nodes };
}

/**
 * 收端门禁：这个请求能不能**加入房间 / 接收**一次投递（join）。
 *
 * 与发端门禁的关键区别 —— 这里**只校验功能总开关与节点可用性**：
 *   · 不看 guestAllowed —— 那是"访客能否发起"的开关。授权用户已经开好房间、
 *     把连接码/二维码递到对方手里，对方能不能收就是这次投递的全部意义。
 *     若拿发起开关去卡接收，就会出现「发端能用、收端连不上」的割裂。
 *   · 不计每日次数 —— 接收不消耗中转节点的发起额度，它只是把已落地的
 *     临时文件取走，拿发起配额卡它既不合理也会误伤正常接收。
 *
 * 访客能否当收端由 guestReceiveAllowed 决定（默认开启）。真正的安全锚点是
 * join 之后签发的 192bit receiver_token，而不是这道门禁 —— 门禁只负责
 * 「这个部署此刻要不要开放接收」，不负责「证明你是谁」（那是 token 的事）。
 */
export async function checkAirdropReceiveAccess(request, env) {
  const cfg = await getAirdropConfig(env);
  if (!cfg.enabled) {
    return { allowed: false, status: 403, code: 'AIRDROP_DISABLED', reason: '隔空投送已关闭' };
  }

  const nodes = availableBackends(env);
  if (!nodes.length) {
    return {
      allowed: false,
      status: 503,
      code: 'AIRDROP_NO_STORAGE',
      reason: '未绑定 R2 或 Telegram，隔空投送没有可用的中转节点'
    };
  }

  const isGuest = await isGuestRequest(request, env);
  if (isGuest && !cfg.guestReceiveAllowed) {
    return {
      allowed: false,
      status: 401,
      code: 'AIRDROP_GUEST_RECEIVE_DENIED',
      reason: '当前未开放访客接收投送，请先登录'
    };
  }

  return { allowed: true, isGuest, ip: getClientIp(request), config: cfg, nodes };
}

async function readDailyCount(env, ip) {
  if (!env?.img_url?.get) return 0;
  try {
    const raw = await env.img_url.get(`airdrop:count:${ip}:${todayKey()}`);
    return parseInt(raw || '0', 10) || 0;
  } catch {
    return 0;
  }
}

/** 计数自增。仅在实际创建房间成功后调用，失败的请求不该消耗额度。 */
export async function incrementDailyCount(env, ip) {
  if (!env?.img_url) return;
  const key = `airdrop:count:${ip}:${todayKey()}`;
  try {
    const current = await readDailyCount(env, ip);
    await env.img_url.put(key, String(current + 1), { expirationTtl: 86400 });
  } catch (e) {
    // 计数失败不该阻断投递本身：宁可少记一次，不可让用户传不了文件
    console.error('Airdrop count error:', e);
  }
}

// ============================================================================
// 房间读写
// ============================================================================

/**
 * 建房间（发端）。
 *
 * 连接码可能撞上现有房间，撞了就换一个重试 —— 8 位码在活跃房间量级下
 * 碰撞概率极低，重试比引入全局计数器便宜得多。
 */
export async function createSession(env, request) {
  await ensureSchema(env);
  const cfg = await getAirdropConfig(env);
  const ttlMs = Math.max(1, cfg.ttlMinutes) * 60 * 1000;
  const now = nowMs();

  // 顺手清理过期房间，避免表无限膨胀。放在建房间时做，是因为这是唯一
  // 一个「反正要写一次库」的时机，额外一条 DELETE 几乎不增加成本。
  await cleanupExpired(env, now);

  for (let attempt = 0; attempt < CODE_MAX_ATTEMPTS; attempt += 1) {
    const code = generateCode();
    const senderToken = generateToken();
    const expiresAt = now + ttlMs;
    try {
      await env.DB.prepare(
        `INSERT INTO airdrop_sessions
         (code, status, sender_token, receiver_token, progress, files_json, created_at, expires_at)
         VALUES (?, 'waiting', ?, NULL, 0, '[]', ?, ?)`
      ).bind(code, senderToken, now, expiresAt).run();

      return { ok: true, code, senderToken, expiresAt, ttlMs };
    } catch (e) {
      const msg = String(e?.message || '');
      // 只有主键冲突才重试，其他错误（表不存在、D1 超时）重试没有意义
      if (msg.includes('UNIQUE') || msg.includes('PRIMARY KEY')) continue;
      return { ok: false, error: msg || '创建房间失败' };
    }
  }
  return { ok: false, error: '连接码生成冲突，请重试' };
}

/**
 * 加入房间（收端）。
 *
 * 一个房间只允许一个收端：第二个拿着同一个连接码的人进来会被拒绝，
 * 否则先到的人会在文件落地的瞬间被顶掉，而他自己毫不知情。
 */
export async function joinSession(env, code) {
  await ensureSchema(env);
  const session = await getSession(env, code);
  if (!session) return { ok: false, status: 404, error: '连接码不存在或已过期' };
  if (session.status === 'expired') return { ok: false, status: 410, error: '该连接码已过期' };
  if (TERMINAL_STATUSES.includes(session.status)) {
    return { ok: false, status: 409, error: '该房间已结束' };
  }
  if (session.receiver_token) {
    return { ok: false, status: 409, error: '该房间已有接收方' };
  }

  const receiverToken = generateToken();
  await env.DB.prepare(
    `UPDATE airdrop_sessions SET receiver_token = ?, status = 'linked', linked_at = ?
     WHERE code = ? AND receiver_token IS NULL`
  ).bind(receiverToken, nowMs(), code).run();

  // 上面这条 UPDATE 带了 receiver_token IS NULL 条件，若返回 0 行说明
  // 并发下被别人抢先加入了 —— 以数据库为准再查一次确认
  const after = await getSession(env, code);
  if (after?.receiver_token !== receiverToken) {
    return { ok: false, status: 409, error: '该房间已有接收方' };
  }
  return { ok: true, code, receiverToken, expiresAt: session.expires_at };
}

/** 读一条房间记录；过期的自动标记并返回 null */
export async function getSession(env, code) {
  await ensureSchema(env);
  if (!code) return null;
  const row = await env.DB.prepare(
    'SELECT * FROM airdrop_sessions WHERE code = ?'
  ).bind(String(code).toUpperCase()).first();

  if (!row) return null;
  if (row.expires_at && row.expires_at < nowMs() && !TERMINAL_STATUSES.includes(row.status)) {
    await cleanupExpired(env, nowMs(), row.code);
    return null;
  }
  return row;
}

/** token 对应的角色；不匹配返回 null */
export function roleOf(session, token) {
  if (!session || !token) return null;
  if (session.sender_token && session.sender_token === token) return 'sender';
  if (session.receiver_token && session.receiver_token === token) return 'receiver';
  return null;
}

/** 从 files_json 列解析文件清单（永远返回数组，坏数据也不抛） */
export function parseManifest(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * 组装给前端的房间视图。
 *
 * 凭证绝不外泄：即使是本人，回包里也不带任何 token —— 前端已经持有它了，
 * 多返回一份只会增加被日志/代理捕获的面。
 *
 * 隐私：文件名 / 大小属于"对方不该提前知道"的信息。在文件全部落地之前
 * （status 还是 linked / uploading），收端只能看到房间状态和"对方在传"，
 * 看不到任何文件名；只有发端（自己知道）或文件已 uploaded/done 时才揭开。
 */
export function sessionView(session, role) {
  const base = {
    code: session.code,
    status: session.status,
    role,
    progress: session.progress || 0,
    createdAt: session.created_at,
    linkedAt: session.linked_at,
    uploadedAt: session.uploaded_at,
    completedAt: session.completed_at,
    expiresAt: session.expires_at,
    error: session.error
  };

  const reveal = role === 'sender' || session.status === 'uploaded' || session.status === 'done';
  if (reveal) {
    const files = parseManifest(session.files_json);
    base.files = files;
    base.fileCount = files.length;
    base.totalSize = files.reduce((a, f) => a + (Number(f.size) || 0), 0);
    base.downloadedCount = files.filter((f) => f.status === 'downloaded').length;
  }
  return base;
}

// ── 状态跃迁 ────────────────────────────────────────────────

/**
 * 追加一个已落地的文件到清单。
 *
 * 发端逐文件上传，每成功一个就追加一条；最后一个带 isFinal 时把房间从
 * uploading 翻到 uploaded，收端轮询到 uploaded 才开始逐文件下载。
 *
 * 写入是「读现有清单 → 追加 → 写回」，发端是顺序上传的（前端保证同一时刻
 * 只发一个），所以不存在并发覆盖清单的竞态。
 */
export async function addManifestFile(env, code, file, isFinal) {
  const session = await getSession(env, code);
  if (!session) return null;
  const files = parseManifest(session.files_json);
  const entry = {
    idx: files.length,
    name: String(file.name || 'file'),
    size: Number(file.size) || 0,
    type: file.type || null,
    backend: file.backend,
    key: file.key,
    meta: file.meta || null,
    status: 'uploaded'
  };
  files.push(entry);

  const status = isFinal ? 'uploaded' : 'uploading';
  await env.DB.prepare(
    `UPDATE airdrop_sessions
     SET files_json = ?, status = ?, file_count = ?, total_size = ?, uploaded_at = ?
     WHERE code = ?`
  ).bind(
    JSON.stringify(files),
    status,
    files.length,
    files.reduce((a, f) => a + (Number(f.size) || 0), 0),
    isFinal ? nowMs() : (session.uploaded_at || null),
    code
  ).run();

  return { idx: entry.idx, status };
}

/** 收端下载完一个文件后，把该条目标记为 downloaded */
export async function markFileDownloaded(env, code, idx) {
  const session = await getSession(env, code);
  if (!session) return;
  const files = parseManifest(session.files_json);
  if (!files[idx]) return;
  files[idx] = { ...files[idx], status: 'downloaded' };
  await env.DB.prepare(
    `UPDATE airdrop_sessions SET files_json = ? WHERE code = ?`
  ).bind(JSON.stringify(files), code).run();
}

/** 收端是否把所有文件都下载完了 */
export function allDownloaded(session) {
  const files = parseManifest(session.files_json);
  if (!files.length) return false;
  return files.every((f) => f.status === 'downloaded');
}

/** 收端下载完成（全部文件已取回） */
export async function markCompleted(env, code) {
  await env.DB.prepare(
    `UPDATE airdrop_sessions SET status = 'done', completed_at = ? WHERE code = ?`
  ).bind(nowMs(), code).run();
}

/** 失败 / 取消 */
export async function markFailed(env, code, message) {
  await env.DB.prepare(
    `UPDATE airdrop_sessions SET status = 'failed', error = ? WHERE code = ?`
  ).bind(String(message || '传输失败').slice(0, 200), code).run();
}

export async function cancelSession(env, code) {
  await env.DB.prepare(
    `UPDATE airdrop_sessions SET status = 'cancelled' WHERE code = ?`
  ).bind(code).run();
}

/**
 * 清理过期房间：先删临时文件，再删记录。
 *
 * 只处理「有 files_json 且未进入终态」的房间 —— 已进入终态的房间在
 * 跃迁时就已经删过文件了，重复删只是浪费一次 R2 请求。
 */
export async function cleanupExpired(env, now, onlyCode) {
  try {
    const sql = onlyCode
      ? 'SELECT code, files_json, status FROM airdrop_sessions WHERE code = ?'
      : `SELECT code, files_json, status FROM airdrop_sessions
         WHERE expires_at < ? AND status NOT IN ('done', 'failed', 'cancelled', 'expired') LIMIT 50`;
    const stmt = env.DB.prepare(sql);
    const bound = onlyCode ? stmt.bind(onlyCode) : stmt.bind(now);
    const rows = await bound.all();
    for (const row of rows.results || []) {
      for (const f of parseManifest(row.files_json)) {
        await deleteTempFile(env, f);
      }
    }
    if (onlyCode) {
      await env.DB.prepare(
        `UPDATE airdrop_sessions SET status = 'expired' WHERE code = ?`
      ).bind(onlyCode).run();
    } else {
      await env.DB.prepare(
        `UPDATE airdrop_sessions SET status = 'expired'
         WHERE expires_at < ? AND status NOT IN ('done', 'failed', 'cancelled', 'expired')`
      ).bind(now).run();
    }
  } catch (e) {
    console.error('Airdrop cleanup error:', e);
  }
}

// ============================================================================
// 临时文件存取
// ============================================================================

/** 写入中转节点。返回 { key, meta }。
 *  R2 走流式直传；Telegram 经由 Bot API 发到频道，
 *  meta 里带回 message_id 供完成后删除消息。 */
export async function writeTempFile(env, code, backend, fileName, body, size, seq) {
  if (backend === 'r2') {
    const key = storageKeyFor(code, seq, fileName);
    await env.R2_BUCKET.put(key, body);
    return { key, meta: null };
  }
  if (backend === 'telegram') {
    return sendToTelegramTemp(env, fileName, body, size);
  }
  throw new Error('不支持的存储节点：' + backend);
}

/**
 * 把文件发到 Telegram 频道作为临时中转。
 *
 * 与主上传 uploadToTelegramStorage 同一条链路：FormData + sendDocument/
 * sendAudio/sendVideo，拿回 file_id（索引键）与 message_id（删除用）。
 * Telegram 的 20MB 上限在 API 层已经拦过，这里再兜底一次。
 */
async function sendToTelegramTemp(env, fileName, body, size) {
  if (size && size > TG_MAX_FILE_SIZE) {
    throw new Error('文件超出 Telegram 节点上限');
  }
  const buf = await new Response(body).arrayBuffer();
  if (buf.byteLength > TG_MAX_FILE_SIZE) {
    throw new Error('文件超出 Telegram 节点上限');
  }
  const contentType = guessContentType(fileName);
  const file = new File([buf], String(fileName || 'airdrop-file'), { type: contentType });
  const { method, field } = getTelegramUploadMethodAndField(contentType);
  const form = new FormData();
  form.append('chat_id', envValue(env, 'TG_CHAT_ID'));
  form.append(field, file, file.name);

  const apiUrl = buildTelegramBotApiUrl(env, method);
  let response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      response = await fetch(apiUrl, { method: 'POST', body: form, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  } catch (e) {
    throw new Error('连接 Telegram 失败：' + (e?.message || '网络错误'));
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) {
    throw new Error('上传到 Telegram 失败：' + (data?.description || `HTTP ${response.status}`));
  }
  const fileId = pickTelegramFileId(data);
  const messageId = data?.result?.message_id;
  if (!fileId) {
    throw new Error('Telegram 已接收文件，但未返回可用的文件 ID。');
  }
  return { key: fileId, meta: { messageId: messageId || null } };
}

/** 粗略推断 MIME：Telegram 据此决定走 document / audio / video 字段 */
function guessContentType(fileName) {
  const ext = String(fileName || '').split('.').pop()?.toLowerCase();
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
    pdf: 'application/pdf', zip: 'application/zip', '7z': 'application/x-7z-compressed',
    rar: 'application/x-rar-compressed', json: 'application/json', txt: 'text/plain'
  };
  return map[ext] || 'application/octet-stream';
}

/** 调 Bot API 的 getFile 拿到真实下载路径（再交给 buildTelegramFileUrl） */
async function getTelegramFilePath(env, fileId) {
  const url = `${buildTelegramBotApiUrl(env, 'getFile')}?file_id=${encodeURIComponent(fileId)}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.ok || !data?.result?.file_path) return null;
  return data.result.file_path;
}

/** 从中转节点读出单个文件条目对应的字节流。file 是 files_json 里的一条。 */
export async function readTempFile(env, file) {
  if (!file || !file.key) return null;
  if (file.backend === 'r2') {
    const obj = await env.R2_BUCKET.get(file.key);
    if (!obj) return null;
    return { body: obj.body, size: obj.size || file.size || 0 };
  }
  if (file.backend === 'telegram') {
    if (!envValue(env, 'TG_BOT_TOKEN')) return null;
    const filePath = await getTelegramFilePath(env, file.key);
    if (!filePath) return null;
    const upstream = await fetch(buildTelegramFileUrl(env, filePath));
    if (!upstream.ok || !upstream.body) return null;
    return {
      body: upstream.body,
      size: Number(upstream.headers.get('content-length')) || file.size || 0
    };
  }
  return null;
}

/** 删除单个文件条目对应的临时文件 */
export async function deleteTempFile(env, file) {
  if (!file || !file.key) return;
  try {
    if (file.backend === 'r2' && env?.R2_BUCKET) {
      await env.R2_BUCKET.delete(file.key);
    } else if (file.backend === 'telegram' && envValue(env, 'TG_BOT_TOKEN')) {
      const msgId = file.meta?.messageId;
      if (msgId) {
        await fetch(buildTelegramBotApiUrl(env, 'deleteMessage'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: envValue(env, 'TG_CHAT_ID'),
            message_id: Number(msgId)
          })
        }).catch(() => {});
      }
    }
  } catch (e) {
    console.error('Airdrop temp file delete error:', e);
  }
}

/**
 * Content-Disposition：ASCII 回退名 + RFC 5987 原名。
 *
 * 只写 filename= 会让中文名变成乱码；只写 filename*= 又有老浏览器不认。
 * 两个都给，由客户端挑它能用的那个。
 */
export function contentDisposition(fileName) {
  const original = String(fileName || 'airdrop-file');
  const ascii = original.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_').slice(0, 120);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(original)}`;
}

// ============================================================================
// 使用统计
// ============================================================================

/**
 * 记一条使用记录。
 *
 * 统计是「尽力而为」的：它服务于管理员看用量，写失败不该让投递失败，
 * 所以这里吞掉异常，只打日志。
 */
export async function recordStat(env, entry) {
  try {
    await ensureSchema(env);
    await env.DB.prepare(
      `INSERT INTO airdrop_stats (code, role, is_guest, file_name, file_size, outcome, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      String(entry.code || ''),
      String(entry.role || 'sender'),
      entry.isGuest ? 1 : 0,
      String(entry.fileName || '').slice(0, 255),
      Number(entry.fileSize) || 0,
      String(entry.outcome || 'completed'),
      nowMs()
    ).run();
  } catch (e) {
    console.error('Airdrop stat error:', e);
  }
}

/**
 * 管理后台的使用情况。
 *
 * 全部走 D1 聚合，不在 JS 里翻列表 —— 数据量一大就必须让数据库算。
 */
export async function getUsageStats(env, days) {
  await ensureSchema(env);
  const since = nowMs() - Math.max(1, Number(days) || 7) * 86400000;

  const [totals, byDay, recent] = await Promise.all([
    env.DB.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN outcome = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN outcome <> 'completed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN is_guest = 1 THEN 1 ELSE 0 END) AS guestCount,
         SUM(CASE WHEN outcome = 'completed' THEN file_size ELSE 0 END) AS bytes,
         MAX(created_at) AS lastAt
       FROM airdrop_stats WHERE created_at >= ?`
    ).bind(since).first(),
    env.DB.prepare(
      `SELECT date(created_at / 1000, 'unixepoch') AS day,
              COUNT(*) AS total,
              SUM(CASE WHEN outcome = 'completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN outcome = 'completed' THEN file_size ELSE 0 END) AS bytes
       FROM airdrop_stats WHERE created_at >= ?
       GROUP BY day ORDER BY day DESC LIMIT 14`
    ).bind(since).all(),
    env.DB.prepare(
      `SELECT code, role, is_guest, file_name, file_size, outcome, created_at
       FROM airdrop_stats ORDER BY created_at DESC LIMIT 20`
    ).all()
  ]);

  const total = Number(totals?.total) || 0;
  return {
    range: days,
    total,
    completed: Number(totals?.completed) || 0,
    failed: Number(totals?.failed) || 0,
    guestCount: Number(totals?.guestCount) || 0,
    bytes: Number(totals?.bytes) || 0,
    lastAt: Number(totals?.lastAt) || 0,
    successRate: total ? Math.round(((Number(totals?.completed) || 0) / total) * 1000) / 10 : 0,
    byDay: (byDay?.results || []).map((r) => ({
      day: r.day,
      total: Number(r.total) || 0,
      completed: Number(r.completed) || 0,
      bytes: Number(r.bytes) || 0
    })),
    recent: (recent?.results || []).map((r) => ({
      code: r.code,
      role: r.role,
      isGuest: Boolean(r.is_guest),
      fileName: r.file_name,
      fileSize: Number(r.file_size) || 0,
      outcome: r.outcome,
      createdAt: Number(r.created_at) || 0
    })),
    // 活跃房间数：管理员需要知道"现在有多少人正在传"
    activeSessions: await countActive(env)
  };
}

async function countActive(env) {
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM airdrop_sessions
       WHERE status NOT IN ('done', 'failed', 'cancelled', 'expired') AND expires_at > ?`
    ).bind(nowMs()).first();
    return Number(row?.n) || 0;
  } catch {
    return 0;
  }
}

/**
 * 把一次已上传的投递标记为「已完成」。
 *
 * 统计刻意分成两笔写：上传落地时先记一条 outcome='uploaded'（此时才知道
 * 发端是不是访客、文件多大），收端确实下载完成后再把 outcome 改成
 * 'completed'。这样管理员看到的数字有明确语义 ——
 *   total     = 发起过多少次投递
 *   completed = 其中真正送达的
 *   两者之差  = 半途而废的（发端传了但收端没取、或中途取消）
 *
 * 如果在 complete 时才第一次写库，就只能记下调用方（收端）的身份，
 * 而"谁在用这个功能"真正有意义的是发起方。
 */
export async function markStatCompleted(env, code) {
  try {
    await ensureSchema(env);
    await env.DB.prepare(
      `UPDATE airdrop_stats SET outcome = 'completed' WHERE code = ? AND outcome = 'uploaded'`
    ).bind(String(code || '')).run();
  } catch (e) {
    console.error('Airdrop stat complete error:', e);
  }
}

/** 标记一次投递未送达（取消 / 失败 / 过期） */
export async function markStatFailed(env, code, outcome) {
  try {
    await ensureSchema(env);
    await env.DB.prepare(
      `UPDATE airdrop_stats SET outcome = ? WHERE code = ? AND outcome = 'uploaded'`
    ).bind(String(outcome || 'failed'), String(code || '')).run();
  } catch (e) {
    console.error('Airdrop stat fail error:', e);
  }
}

/**
 * 清掉历史统计（后台"清空记录"用） */
export async function clearStats(env) {
  await ensureSchema(env);
  await env.DB.prepare('DELETE FROM airdrop_stats').run();
}
