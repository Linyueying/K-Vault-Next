/**
 * 合集分享（bundle share）—— 把多个文件聚合成**一个**分享链接。
 *
 * ## 为什么需要独立实体
 *
 * 单文件分享（见 `share-options.js`）把 `shareSlug` / `shareExpiresAt` /
 * `shareMaxDownloads` / `sharePasswordHash` 直接写进**该文件自己的 KV
 * metadata**，由 `functions/file/[[path]].js` 在每次读取时按文件自身字段校验。
 *
 * 合集**不能**照搬这套做法。如果把合集密码写到每个成员文件的 metadata 上，
 * 那么用户之后单独访问该文件（走 `/file/<id>` 或它自己的单文件分享）也会被
 * 合集的密码拦住 —— 文件级分享语义就被污染了。反之若只写到一个"代表文件"
 * 上，又会让合集的删除/改密牵动文件本身。
 *
 * 因此合集是**独立实体**，独占下列 KV key 空间，与文件完全解耦：
 *
 *   · `bundle:<slug>`      —— 合集定义 + 有效期 + 密码 hash + 下载计数
 *   · `bundle_slug:<slug>` —— 存在性索引，O(1) 判 slug 冲突
 *
 * `file/[[path]].js` 与 `share-options.js` 均**零改动**。
 *
 * ## slug 命名空间
 *
 * 合集短链与文件短链共用 `/s/:slug` 这一个入口（见 `functions/s/[slug].js`），
 * 所以两者必须共享同一套 slug 命名空间。创建合集前要同时查
 * `share_slug:` 与 `bundle_slug:`，任一被占用即冲突 —— 否则 `/s/:slug`
 * 的解析会产生歧义。{@link isBundleSlugAvailable} 负责这层校验。
 *
 * ## 下载计数为什么独立
 *
 * 文件级的计数落在 `dlc:<fileKey>`，语义是"这个文件被下载了几次"。合集的
 * 配额语义是"这个**链接**被下载了几次"，两者不是一回事：同一个文件可以既在
 * 合集里、又有自己的单文件分享，两条配额线各算各的。所以计数直接存在
 * `bundle:<slug>` 的 metadata 上。
 *
 * @module share-bundle
 */

import { getRecordWithKey } from './file-record.js';
import {
  listAllKeys,
  shouldIncludeKey,
  normalizeKey,
  normalizeFolderPath,
} from './file-list.js';

/** 合集定义的 KV 前缀。 */
export const BUNDLE_KEY_PREFIX = 'bundle:';

/** 合集 slug 存在性索引的 KV 前缀。 */
export const BUNDLE_SLUG_KEY_PREFIX = 'bundle_slug:';

/** 文件级短链索引前缀。与 `share-options.js` 保持一致，用于跨命名空间查重。 */
const SHARE_SLUG_KEY_PREFIX = 'share_slug:';

/**
 * 与 `share-options.js` / `share/[id].js` 的上限保持一致。
 * 三处必须同值，否则同一份参数在两条路径上会得到不同的校验结果。
 */
const MAX_EXPIRES_IN_SECONDS = 3650 * 24 * 3600;
const MAX_DOWNLOADS = 1000000000;

/** 单个合集允许包含的最大文件数。 */
export const MAX_BUNDLE_FILES = 100;

/** 合集 slug 的最大长度，与 `sanitizeShareSlug` 一致。 */
const MAX_SLUG_LENGTH = 64;

/**
 * 合集类型。
 *   · `files`  —— 文件快照（默认）：成员写死进 `fileIds`，创建后不随目录变化。
 *   · `folder` —— 实时文件夹分享：不持有 `fileIds`，只记 `folderPath`，
 *                列举时按目录前缀实时扫 KV，因此上传/删除会立即反映到分享页。
 */
export const BUNDLE_TYPE_FILES = 'files';
export const BUNDLE_TYPE_FOLDER = 'folder';

/* ============================================================
 * slug
 * ============================================================ */

/**
 * 归一化合集短链标识：小写字母、数字、下划线、短横线，最多 64 字符。
 *
 * 刻意不直接 import `share-options.js` 的 `sanitizeShareSlug`：那个函数是
 * 文件分享的公开契约，合集若与之耦合，将来文件侧调整字母表会静默改变合集
 * 行为。这里保留一份独立实现，并在测试里断言两者对同一输入结果相同。
 *
 * @param rawValue - 候选 slug。
 * @returns 归一化后的 slug；无可用字符时为空串。
 */
export function sanitizeBundleSlug(rawValue = '') {
  return String(rawValue || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, MAX_SLUG_LENGTH);
}

/**
 * 生成一个随机合集 slug。
 *
 * 与前端 `submitShareDialog()` 里生成单文件短链的算法同形（时间戳后 4 位 +
 * 4 位随机），保持用户观感一致。碰撞概率极低，但**不依赖**这一点：调用方
 * 仍须走 {@link isBundleSlugAvailable} 校验。
 */
export function buildBundleSlug() {
  const timestamp = Date.now().toString(36).slice(-4);
  const random = Math.random().toString(36).substring(2, 6);
  return sanitizeBundleSlug(timestamp + random);
}

/**
 * 检查 slug 是否可用于新建合集。
 *
 * 同时检查文件短链（`share_slug:`）与合集短链（`bundle_slug:`）两个命名
 * 空间 —— 见模块头部关于命名空间共享的说明。
 *
 * @param env - Pages 环境（需要 `img_url` KV 绑定）。
 * @param slug - 候选 slug。
 * @param options.excludeBundleSlug - 更新合集时传入自身 slug，避免自撞。
 * @returns `true` 表示可用。
 */
export async function isBundleSlugAvailable(env, slug, options = {}) {
  const normalized = sanitizeBundleSlug(slug);
  if (!normalized || !env?.img_url) return false;

  const excluding = sanitizeBundleSlug(options.excludeBundleSlug || '');
  if (excluding && excluding === normalized) return true;

  try {
    const [fileOwner, bundleOwner] = await Promise.all([
      env.img_url.get(`${SHARE_SLUG_KEY_PREFIX}${normalized}`),
      env.img_url.get(`${BUNDLE_SLUG_KEY_PREFIX}${normalized}`),
    ]);
    return !fileOwner && !bundleOwner;
  } catch {
    // 读失败时保守判为不可用：宁可让用户换个短链，也不要冒覆盖别人映射的风险。
    return false;
  }
}

/* ============================================================
 * 密码
 * ============================================================ */

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(input)));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function randomSalt() {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 构造密码字段对。
 *
 * 与 `share-options.js` 的 `buildPasswordFields` 算法一致（`salt:password`
 * 的 SHA-256），使合集密码与文件密码在同一套校验语义下工作。
 *
 * @param password - 明文密码。
 * @returns `{ passwordSalt, passwordHash }`。
 */
export async function buildBundlePasswordFields(password) {
  const salt = randomSalt();
  return {
    passwordSalt: salt,
    passwordHash: await sha256Hex(`${salt}:${password}`),
  };
}

/**
 * 校验合集密码。
 *
 * 返回值语义与 `share-options.js` 的 `verifySharePassword` 一致，
 * 便于 `share-info.js` 用同一套分支映射状态码。
 *
 * @param bundle - 合集定义。
 * @param password - 访问者提交的密码。
 * @returns `'ok'` | `'missing'` | `'invalid'`。
 */
export async function verifyBundlePassword(bundle = {}, password = '') {
  if (!bundle?.passwordHash) return 'ok';
  const candidate = String(password || '');
  if (!candidate) return 'missing';

  const expected = await sha256Hex(`${String(bundle.passwordSalt || '')}:${candidate}`);
  return timingSafeEqual(String(bundle.passwordHash || ''), expected) ? 'ok' : 'invalid';
}

/** 定长比较，避免通过响应耗时差推断 hash。 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/* ============================================================
 * 读写
 * ============================================================ */

/**
 * 读取合集定义。
 *
 * @param env - Pages 环境。
 * @param slug - 合集 slug（会自动归一化）。
 * @returns 合集对象，或 `null`（不存在 / slug 非法 / KV 未配置）。
 */
export async function readBundle(env, slug) {
  const normalized = sanitizeBundleSlug(slug);
  if (!normalized || !env?.img_url) return null;

  try {
    const record = await env.img_url.getWithMetadata(`${BUNDLE_KEY_PREFIX}${normalized}`);
    const metadata = record?.metadata;
    if (!metadata || typeof metadata !== 'object') return null;

    // 判定合集类型：默认 `files`（文件快照）；`folder` 为实时文件夹分享。
    const type = metadata.type === BUNDLE_TYPE_FOLDER ? BUNDLE_TYPE_FOLDER : BUNDLE_TYPE_FILES;

    // fileIds 是「文件快照」型合集的存在基础；但「文件夹分享」型合集
    // 不持有 fileIds（成员按目录实时列举），因此只在 type==='files' 时
    // 把空 fileIds 视为无效，避免渲染出"零文件"空壳页面。
    const fileIds = Array.isArray(metadata.fileIds)
      ? metadata.fileIds.map((id) => String(id || '')).filter(Boolean)
      : [];
    if (type === BUNDLE_TYPE_FILES && !fileIds.length) return null;

    return {
      slug: normalized,
      type,
      fileIds,
      folderPath: type === BUNDLE_TYPE_FOLDER ? normalizeFolderPath(metadata.folderPath || '') : '',
      includeSubfolders: type === BUNDLE_TYPE_FOLDER ? Boolean(metadata.includeSubfolders) : false,
      expiresAt: Number(metadata.expiresAt) || 0,
      maxDownloads: Number(metadata.maxDownloads) || 0,
      downloadCount: Number(metadata.downloadCount) || 0,
      passwordSalt: String(metadata.passwordSalt || ''),
      passwordHash: String(metadata.passwordHash || ''),
      createdAt: Number(metadata.createdAt) || 0,
      label: String(metadata.label || ''),
    };
  } catch (error) {
    console.warn('Failed to read bundle:', error?.message || error);
    return null;
  }
}

/**
 * 写入合集定义，并同步维护 slug 索引键。
 *
 * 索引键的价值：`isBundleSlugAvailable` 判断冲突时只需一次 `get`，
 * 不必反序列化合集本体。
 *
 * @param env - Pages 环境。
 * @param bundle - 合集对象（`slug` 与 `fileIds` 必填）。
 * @returns 实际写入的合集对象。
 * @throws 当 `env` 未配置 KV 绑定。
 */
export async function writeBundle(env, bundle) {
  if (!env?.img_url) throw new Error('KV binding img_url is not configured.');

  const slug = sanitizeBundleSlug(bundle?.slug);
  if (!slug) throw new Error('合集短链标识无效。');

  const type = bundle?.type === BUNDLE_TYPE_FOLDER ? BUNDLE_TYPE_FOLDER : BUNDLE_TYPE_FILES;

  // ---------- 实时文件夹分享：不持有 fileIds，只记 folderPath ----------
  if (type === BUNDLE_TYPE_FOLDER) {
    const folderPath = normalizeFolderPath(bundle?.folderPath || '');
    const metadata = {
      slug,
      type,
      fileIds: [],
      folderPath,
      includeSubfolders: Boolean(bundle?.includeSubfolders),
      expiresAt: Number(bundle.expiresAt) || 0,
      maxDownloads: Number(bundle.maxDownloads) || 0,
      downloadCount: Number(bundle.downloadCount) || 0,
      passwordSalt: String(bundle.passwordSalt || ''),
      passwordHash: String(bundle.passwordHash || ''),
      createdAt: Number(bundle.createdAt) || Date.now(),
      label: String(bundle.label || ''),
    };

    await env.img_url.put(`${BUNDLE_KEY_PREFIX}${slug}`, '', { metadata });
    await env.img_url.put(`${BUNDLE_SLUG_KEY_PREFIX}${slug}`, slug, {
      metadata: { slug, updatedAt: Date.now() },
    });

    return { ...metadata };
  }

  // ---------- 文件快照型合集：fileIds 必填且非空 ----------
  const fileIds = Array.isArray(bundle?.fileIds)
    ? bundle.fileIds.map((id) => String(id || '')).filter(Boolean)
    : [];
  if (!fileIds.length) throw new Error('合集至少需要包含一个文件。');

  const metadata = {
    slug,
    type,
    fileIds,
    folderPath: '',
    includeSubfolders: false,
    expiresAt: Number(bundle.expiresAt) || 0,
    maxDownloads: Number(bundle.maxDownloads) || 0,
    downloadCount: Number(bundle.downloadCount) || 0,
    passwordSalt: String(bundle.passwordSalt || ''),
    passwordHash: String(bundle.passwordHash || ''),
    createdAt: Number(bundle.createdAt) || Date.now(),
    label: String(bundle.label || ''),
  };

  await env.img_url.put(`${BUNDLE_KEY_PREFIX}${slug}`, '', { metadata });
  await env.img_url.put(`${BUNDLE_SLUG_KEY_PREFIX}${slug}`, slug, {
    metadata: { slug, updatedAt: Date.now() },
  });

  return { ...metadata };
}

/**
 * 删除合集定义与其 slug 索引。
 *
 * 创建流程中途失败时也用它做回滚 —— 因此对「索引键不存在」是幂等的。
 *
 * @param env - Pages 环境。
 * @param slug - 合集 slug。
 */
export async function deleteBundle(env, slug) {
  const normalized = sanitizeBundleSlug(slug);
  if (!normalized || !env?.img_url) return;

  try {
    await env.img_url.delete(`${BUNDLE_KEY_PREFIX}${normalized}`);
  } catch (error) {
    console.warn('Failed to delete bundle:', error?.message || error);
  }
  try {
    await env.img_url.delete(`${BUNDLE_SLUG_KEY_PREFIX}${normalized}`);
  } catch (error) {
    console.warn('Failed to delete bundle index:', error?.message || error);
  }
}

/**
 * 实时列举某个目录下的文件成员 —— 「文件夹分享」实现实时同步的核心。
 *
 * 与 `share-bundle.js` 写入端点里「目录来源」的扫 KV 逻辑完全一致：
 * 按 `folderPath` 前缀过滤 `folderPath` 元数据，支持「仅本目录」或「含子目录」。
 * 区别在于**不落盘、不快照**——每次调用都反映 KV 当前真实状态，
 * 因此分享页/管理面板看到的就是文件夹此刻的内容，上传新文件后会自动出现。
 *
 * `listAllKeys` 带 2 秒短缓存，故上传后最多 2 秒即在列举中可见，足以满足
 * 分享场景的"实时"预期，同时避免高频全量扫 KV 造成的成本。
 *
 * @param env - Pages 环境。
 * @param folderPath - 目录路径（空串表示根目录）。
 * @param includeSubfolders - 是否包含子目录。
 * @returns 归一化后的文件条目数组（每条含 `name` 与 `metadata`）。
 */
export async function listFolderMembersLive(env, folderPath, includeSubfolders = false) {
  if (!env?.img_url) return [];
  const normalized = normalizeFolderPath(folderPath || '');

  const all = await listAllKeys(env);
  return all
    .filter(shouldIncludeKey)
    .map(normalizeKey)
    .filter((entry) => {
      const fp = entry.metadata.folderPath || '';
      if (normalized === '') {
        // 根目录：folderPath 为空的文件；勾选「包含子目录」时涵盖全部文件。
        return includeSubfolders ? true : fp === '';
      }
      return includeSubfolders
        ? fp === normalized || fp.startsWith(`${normalized}/`)
        : fp === normalized;
    });
}

/* ============================================================
 * 成员文件校验
 * ============================================================ */

/**
 * 逐个校验合集成员文件是否存在。
 *
 * 采取「部分成功」语义：不存在的文件进 `missing`，**不**让整批创建失败。
 * 这样"选中 10 个文件，其中 1 个刚好被删了"仍然能建出含 9 个文件的合集，
 * 并把那 1 个明确回报给前端汇总展示 —— 静默丢弃才是真正危险的行为。
 *
 * 并发分批（每批 10）而非一次性全发：管理员可能一次选中上百个文件，
 * 不限并发会把 KV 打到限流。
 *
 * @param env - Pages 环境。
 * @param fileIds - 候选文件 ID 数组。
 * @returns `{ resolved, missing }`；`resolved` 为 `{ fileId, kvKey, metadata }`。
 */
export async function resolveBundleFileIds(env, fileIds) {
  const list = Array.isArray(fileIds)
    ? fileIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];

  const resolved = [];
  const missing = [];
  const BATCH = 10;

  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (fileId) => {
        try {
          const { record, kvKey } = await getRecordWithKey(env, fileId);
          if (!record?.metadata) return { fileId, ok: false };
          return { fileId, ok: true, kvKey, metadata: record.metadata };
        } catch (error) {
          console.warn('Failed to resolve bundle file:', error?.message || error);
          return { fileId, ok: false };
        }
      })
    );
    for (const item of results) {
      if (item.ok) resolved.push(item);
      else missing.push(item.fileId);
    }
  }

  return { resolved, missing };
}

/* ============================================================
 * 状态判定
 * ============================================================ */

/** 合集是否已过期。 */
export function isBundleExpired(bundle = {}) {
  const expiresAt = Number(bundle?.expiresAt) || 0;
  return expiresAt > 0 && Date.now() > expiresAt;
}

/** 合集是否已用尽下载次数。 */
export function isBundleExhausted(bundle = {}) {
  const maxDownloads = Number(bundle?.maxDownloads) || 0;
  if (maxDownloads <= 0) return false;
  return (Number(bundle?.downloadCount) || 0) >= maxDownloads;
}

/**
 * 合集是否仍可访问（未过期且未超限）。
 * 与 `share-options.js` 的 `hasActiveShare` 语义对齐。
 */
export function isBundleActive(bundle = {}) {
  return !isBundleExpired(bundle) && !isBundleExhausted(bundle);
}

/**
 * 累计一次合集下载。
 *
 * 读-改-写而非原子自增：KV 本身不提供原子操作，而合集下载的并发强度远低于
 * 文件级下载（后者有 `dlc:` 键与 TTL 机制）。轻微超发会放宽配额，但不会
 * 出现负数或计数倒退，属于可接受误差。要严格串行化只能引入 Durable Object，
 * 对一个分享计数而言不值得。
 *
 * @param env - Pages 环境。
 * @param slug - 合集 slug。
 * @returns 自增后的计数；读取失败时返回原值。
 */
export async function incrementBundleDownloadCount(env, slug) {
  const bundle = await readBundle(env, slug);
  if (!bundle) return 0;

  const next = (Number(bundle.downloadCount) || 0) + 1;
  try {
    await writeBundle(env, { ...bundle, downloadCount: next });
  } catch (error) {
    console.warn('Failed to increment bundle download count:', error?.message || error);
  }
  return next;
}

/* ============================================================
 * 参数解析
 * ============================================================ */

/**
 * 解析并校验合集参数。
 *
 * 上限常量与 `share/[id].js` 逐一对齐，使同一份表单参数在单文件与合集两条
 * 路径上得到完全相同的校验结果。
 *
 * 注意这里**不直接依赖 `parsePositiveInt` 做校验**：那个函数是"宽容"语义，
 * 非法输入返回 `defaultValue`、越界值夹到边界，全程不报错。拿它的返回值判
 * 空会把 `"abc"` 静默当成 0（= 不限次数），把一个明显的输入错误变成"永久
 * 不限量分享"。所以这里先显式解析、显式判非法，再把值夹进边界。
 *
 * @param body - 请求体对象。
 * @returns `{ errors: string[], options: object }`；`options` 仅含出现的字段。
 */
export function parseBundleOptions(body = {}) {
  const errors = [];
  const options = {};

  /** 字段是否出现在请求体里（`null` 也算出现 —— 表示「清除」）。 */
  const has = (target, name) => Object.prototype.hasOwnProperty.call(target, name);

  /** `-1` / `null` / `''` / `0` 都表示「清除该项」，与 share/[id].js 的哨兵语义一致。 */
  const isClear = (raw) =>
    raw === null || raw === '' || raw === 0 || raw === '0' || raw === -1 || raw === '-1';

  /**
   * 显式解析一个非负整数字段。
   * @returns 合法值；非法时返回 null，并把原因压入 errors。
   */
  const parseCount = (raw, { label, unitHint, max }) => {
    const text = String(raw).trim();
    if (!/^\d+$/.test(text)) {
      errors.push(`${label}必须是整数${unitHint}。`);
      return null;
    }
    const parsed = Number.parseInt(text, 10);
    if (!Number.isFinite(parsed)) {
      errors.push(`${label}必须是整数${unitHint}。`);
      return null;
    }
    if (parsed > max) {
      errors.push(`${label}超出允许范围。`);
      return null;
    }
    return parsed;
  };

  if (has(body, 'expiresIn')) {
    if (isClear(body.expiresIn)) {
      options.expiresIn = 0;
    } else {
      const parsed = parseCount(body.expiresIn, {
        label: '有效期',
        unitHint: '（秒，0 表示永久）',
        max: MAX_EXPIRES_IN_SECONDS,
      });
      if (parsed !== null) options.expiresIn = parsed;
    }
  }

  if (has(body, 'maxDownloads')) {
    if (isClear(body.maxDownloads)) {
      options.maxDownloads = 0;
    } else {
      const parsed = parseCount(body.maxDownloads, {
        label: '下载次数上限',
        unitHint: '（0 表示不限）',
        max: MAX_DOWNLOADS,
      });
      if (parsed !== null) options.maxDownloads = parsed;
    }
  }

  if (has(body, 'password')) {
    const password = String(body.password ?? '');
    if (password.length > 200) errors.push('访问密码过长（最多 200 个字符）。');
    else options.password = password;
  }

  if (has(body, 'slug')) {
    const rawSlug = String(body.slug ?? '').trim();
    if (rawSlug) {
      const normalized = sanitizeBundleSlug(rawSlug);
      if (!normalized) errors.push('短链标识只能包含字母、数字、下划线或短横线。');
      else options.slug = normalized;
    } else {
      options.slug = '';
    }
  }

  return { errors, options };
}

/**
 * 读取并去重请求体里的 `fileIds`。
 *
 * 去重是必要的：前端多选列表可能因为分页/重渲染出现重复项，同一个文件在
 * 合集里出现两次会让访客看到重复条目，也会让计数统计失去意义。
 *
 * @param body - 请求体对象。
 * @returns 去重后的文件 ID 数组（保持首次出现顺序）。
 */
export function readBundleFileIds(body = {}) {
  const raw = Array.isArray(body?.fileIds) ? body.fileIds : [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const id = String(item || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
