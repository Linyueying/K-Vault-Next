import { createS3Client } from '../utils/s3client.js';
import { getDiscordFileUrl } from '../utils/discord.js';
import { getHuggingFaceFile } from '../utils/huggingface.js';
import { getWebDAVFile } from '../utils/webdav.js';
import { getGitHubFile } from '../utils/github.js';
import {
  getRecordWithKey as findRecordWithKey,
  readDownloadCount,
  incrementDownloadCount,
  putRecordIndex,
  consumeDownloadQuota,
} from '../utils/file-record.js';
import {
  buildTelegramBotApiUrl,
  buildTelegramFileUrl,
  parseSignedTelegramFileId,
  shouldWriteTelegramMetadata,
} from '../utils/telegram.js';
import {
  incrementBundleDownloadCount,
  isBundleExpired,
  isBundleExhausted,
  readBundle,
  verifyBundlePassword,
} from '../utils/share-bundle.js';

const MIME_TYPES = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'video/ogg',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  m4v: 'video/x-m4v',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  '3gp': 'video/3gpp',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  wma: 'audio/x-ms-wma',
  opus: 'audio/opus',
  oga: 'audio/ogg',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  json: 'application/json',
  xml: 'application/xml',
  md: 'text/markdown',
  zip: 'application/zip',
  rar: 'application/x-rar-compressed',
  '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar',
  gz: 'application/gzip',
};

/**
 * 对外入口。
 *
 * 这里做两件额外的事：
 *   1. 把「显式下载」请求的响应后处理一遍（详见 `applyDownloadDisposition`）。
 *      放在最外层统一处理，而不是改 7 个存储分支 —— 分支各自实现一遍
 *      attachment 头，早晚会漏掉一两个。
 *   2. 数字节 = 计次数（详见 `maybeCountBundleDownload`）。文件级的计数
 *      由内层在「拿到响应」后就发起，但那种写法要求响应本身成功（200/206）；
 *      合集这条路径上，上游存储不可用时会返回 500，配额就永远不动 ——
 *      而「请求确实打到了上游、只是上游挂了」并不该让访问者白嫖一次。
 *      所以连同文件级一起挪到最外层，用同一把尺子量。
 */
export async function onRequest(context) {
  const response = await handleRequest(context);
  /* HEAD 在进计次之前就脱掉 body：下游的 trackDownloadsIfNeeded 拿不到流，
     也就不会为一次「只问在不在」的探测去做流包装。 */
  const headless = stripBodyForHead(context.request, response);
  const tracked = await trackDownloadsIfNeeded(context, headless);
  return applyDownloadDisposition(context, tracked);
}

/**
 * HEAD 响应收敛：只保留状态行与响应头，不带 body。
 *
 * 每个存储分支都是照着 GET 写的（拉对象 / 拉上游），对 HEAD 也原样跑一遍。
 * 与其让分支各自判断 method，不如在最外层统一脱 body —— 顺带保证 workerd
 * 不再去 pull 那条流。
 *
 * 注意这只能省掉「边缘 → 客户端」这一段的开销；真正省掉上游读取的，是
 * R2 分支里改用 `head()` 的短路（见 handleR2File）。
 *
 * @param request - 原始请求。
 * @param response - 待收敛的响应。
 * @returns 无 body 的响应（非 HEAD 或本来就没 body 时原样返回）。
 */
function stripBodyForHead(request, response) {
  if (!response) return response;
  if (String(request?.method || '').toUpperCase() !== 'HEAD') return response;
  if (!response.body) return response;

  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * 核销一次分享下载（乐观计数）。
 *
 * 判断只有一条：`shouldCountAsDownload` —— 是不是一次真正的下载请求。
 * 命中就用 `waitUntil` 落账，响应**原样放行**，不碰响应体。
 *
 * 为什么不再「等字节发完再记」：那需要在响应流上挂钩子（旧实现是把 body
 * 包进自定义 ReadableStream 数字节），而 workerd 一旦发现 body 被重新包装，
 * 就会剥掉显式设置的 Content-Length、退化成 chunked —— 浏览器（尤其手机端）
 * 拿不到长度，下载框显示 0 B、进度条不动，看起来和卡死没区别。
 * 保住长度，比「数完字节才算数」重要得多。
 *
 * 计次语义因此从「字节交付完成」放宽为「字节开始交付」：用户中途取消也会
 * 记一次。这与「上游 5xx 仍计次」是同一个取舍（见下）—— 宁可多记一次，
 * 也不留下一个反复重放就能绕过配额的入口。
 *
 * @param context - Pages 请求上下文。
 * @param response - 已生成的响应（HEAD 在进这里之前已是无 body 响应）。
 * @returns 原响应。
 */
async function trackDownloadsIfNeeded(context, response) {
  const pending = context.__kvTrackPending;
  // 无待记账目标 → 不是分享链接，直接放行（绝大多数请求走这条）。
  if (!pending || !response) return response;
  if (!pending.file && !pending.bundle) return response;

  // 关于上游 5xx 的取舍：它同样计入配额。理由是这个 500 来自「拿不到上游
  // 文件路径」，而分享页此时已经通过 /api/share-info 确认过文件存在，
  // 也就是说这是一次针对有效文件的、真实的访问尝试 —— 与「链接猜错了」
  // 不同。不计数等于给出一个绕过配额的入口：反复请求让它 500 即可无限访问，
  // 上游一旦恢复就白拿。宁可让偶发的上游抖动消耗一次配额。
  //
  // 真正不该计数的是「响应都没生成」的情况（404 文件不存在、401/403/410
  // 被闸门拦下、OPTIONS 预检）—— 那些在 shouldCountAsDownload 里已排除。
  const counting = shouldCountAsDownload(context.request, response);

  // ---------------------------------------------------------------------------
  // 预占回滚：D1 原子预占发生在响应生成之前，若最终响应属于「不该计数」的
  // 情况（404 路径不存在 / 上游 5xx），预占的那一次配额必须补回 ——
  // 否则用户会为一次失败的访问白付配额。
  //
  // 注意这与旧实现的一个细微差异：旧实现是「成功才计数」，天然不会白吃；
  // 新实现是「先占后核」，因此需要显式回滚。回滚失败只告警，不影响响应。
  // ---------------------------------------------------------------------------
  if (context.__kvQuotaConsumed && !counting) {
    if (typeof context.waitUntil === 'function') {
      context.waitUntil(refundCheckout(context, pending).catch(() => {}));
    }
  }

  if (counting && typeof context.waitUntil === 'function') {
    context.waitUntil(settleTrackCounts(context, pending));
  }

  // 原生流必须原样直达：任何包装都会让 Content-Length 丢失（见函数头注释）。
  return response;
}

/**
 * 补回一次被预占但最终未成立的配额。
 *
 * 只在「D1 已原子预占」+「最终响应不该计数」的交叉情况下调用。
 * D1 里做 -1（下限 0），避免负数。
 *
 * @param context - Pages 请求上下文。
 * @param pending - 暂存对象（需带 file.kvKey）。
 */
async function refundCheckout(context, pending) {
  const kvKey = pending?.file?.kvKey;
  if (!kvKey) return;

  const env = pending.env || context.env;
  if (!env?.DB || typeof env.DB.prepare !== 'function') return;

  try {
    const { refundQuota } = await import('../utils/file-record.js');
    await refundQuota(env, kvKey);
  } catch (error) {
    console.warn('Failed to refund download quota:', error?.message || error);
  }
}

/**
 * 把「这一请求该记在哪本账上」暂存到 context，交给外层计次。
 *
 * 为什么不在当前层直接计次：计次要同时看到「是不是一次下载请求」和最终的
 * 响应状态（闸门可能在这一层之后才把它判成 401/403/410），这两样只有
 * 最外层才拿得全。内层只登记、不落账。
 *
 * `shareAccess` 必须是原始对象，不能是可能为 null 的中间值：
 * 这里只在它带 `trackDownload` 时才记，语义与旧的 inline 判断一致。
 *
 * @param context - Pages 请求上下文。
 * @param shareAccess - `verifyShareAccess()` 的返回值（可为 null）。
 * @param bundleAccess - `verifyBundleAccess()` 的返回值。
 */
function rememberTrackTargets(context, shareAccess, bundleAccess = {}) {
  const file =
    shareAccess?.trackDownload && shareAccess.kvKey
      ? { kvKey: shareAccess.kvKey, metadata: shareAccess.metadata }
      : null;
  const bundle = bundleAccess?.trackDownload && bundleAccess.slug ? { slug: bundleAccess.slug } : null;
  // 两个目标都不存在时不要设置 pending：普通（非分享）下载占绝大多数，
  // 没有记账目标就没有理由让它们多走一层判断。
  if (!file && !bundle) return;
  context.__kvTrackPending = { env: context.env, file, bundle };
}

/**
 * 真正落账：文件级与合集级各记一次。
 *
 * 只在响应体读完（字节确实交付完）之后调用。放在这里而不是发起时，
 * 是为了让「上游失败」不消耗配额。
 *
 * @param context - Pages 请求上下文。
 * @param pending - {@link rememberTrackTargets} 写入的暂存对象。
 */
async function settleTrackCounts(context, pending) {
  const env = pending.env || context.env;

  const jobs = [];
  // 文件级：若 verifyShareAccess 已用 D1 原子预占过配额，这里不再重复落账。
  // （D1 未绑定时不会设置该标记，仍走旧的 increment 路径。）
  if (pending.file && !context.__kvQuotaConsumed) {
    jobs.push(incrementShareDownloadCount(env, pending.file.kvKey, pending.file.metadata));
  }
  if (pending.bundle) {
    jobs.push(incrementBundleDownloadCount(env, pending.bundle.slug));
  }
  if (!jobs.length) return;

  await Promise.allSettled(jobs);
}

async function handleRequest(context) {
  const { request, env, params } = context;

  if (request.method === 'OPTIONS') {
    return handleOptions();
  }

  try {
    let fileId = params.path;
if (Array.isArray(fileId)) {
  fileId = fileId.join('/');
}
if (!fileId) {
  return errorResponse('Missing file id', 400);
}

  try {
      fileId = decodeURIComponent(fileId);
    } catch (e) {}

    // 合集成员链接（`?b=<slug>`）先过合集这道闸门。放在最前面是因为合集
    // 自带密码与独立配额：过期/超次/密码不对时，没必要再去读文件元数据。
    const bundleAccess = await verifyBundleAccess(context);
    if (bundleAccess.response) return bundleAccess.response;

    const signedTelegramMeta = await parseSignedTelegramFileId(fileId, env);
    if (signedTelegramMeta) {
      // Signed links must go through the same share controls as the regular
      // path. Previously this branch returned before any of them ran, so
      // expiry / password / download cap were all silently bypassed.
      const signedRecord = await getRecordWithKey(
        env,
        `${signedTelegramMeta.fileId}.${signedTelegramMeta.fileExtension || 'bin'}`
      );
      const signedMetadata = signedRecord?.metadata || null;

      let signedShareAccess = null;
      if (signedMetadata) {
        signedShareAccess = await verifyShareAccess(context, signedMetadata, signedRecord.kvKey);
        if (signedShareAccess?.response) {
          return signedShareAccess.response;
        }
      }

      const signedResponse = await handleSignedTelegramFile(context, signedTelegramMeta);

      // 计次不在分支里做：等外层确认「字节真的开始流出」再计。
      rememberTrackTargets(context, signedShareAccess, bundleAccess);

      return signedResponse;
    }

    const recordResult = await getRecordWithKey(env, fileId);
    const record = recordResult?.record;
    const kvKey = recordResult?.kvKey || fileId;

    if (env.img_url && !record?.metadata) {
      return errorResponse('File not found', 404);
    }

    let shareAccess = null;
    if (record?.metadata) {
      shareAccess = await verifyShareAccess(context, record.metadata, kvKey);
      if (shareAccess?.response) {
        return shareAccess.response;
      }
    }

    const storageType = inferStorageType(fileId, record?.metadata || {});
    let response;
    if (storageType === 'r2') {
  const r2Key = record?.metadata?.r2Key || String(fileId).replace(/^r2:/, '');
  response = await handleR2File(context, r2Key, record);
} else if (storageType === 's3') {
      response = await handleS3File(context, fileId, record);
    } else if (storageType === 'discord') {
      response = await handleDiscordFile(context, fileId, record);
    } else if (storageType === 'huggingface') {
      response = await handleHFFile(context, fileId, record);
    } else if (storageType === 'webdav') {
      response = await handleWebDAVFile(context, fileId, record);
    } else if (storageType === 'github') {
      response = await handleGitHubFile(context, fileId, record);
    } else {
      response = await handleTelegramFile(context, fileId, record);
    }

    rememberTrackTargets(context, shareAccess, bundleAccess);

    return response;
  } catch (error) {
    console.error('file route error:', error);
    return errorResponse(`File proxy error: ${error?.message || 'Unknown error'}`, 502);
  }
}

function inferStorageType(name, metadata = {}) {
  const explicit = metadata.storageType || metadata.storage;
  if (explicit) return String(explicit).toLowerCase();

  const keyName = String(name || '');
  if (keyName.startsWith('r2:')) return 'r2';
  if (keyName.startsWith('s3:')) return 's3';
  if (keyName.startsWith('discord:')) return 'discord';
  if (keyName.startsWith('hf:')) return 'huggingface';
  if (keyName.startsWith('webdav:')) return 'webdav';
  if (keyName.startsWith('github:')) return 'github';
  return 'telegram';
}

function getMimeType(fileName = '') {
  const ext = String(fileName).split('.').pop()?.toLowerCase() || '';
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function addCorsHeaders(headers) {
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Range, Content-Type, Accept, Origin');
  headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type, Content-Disposition');
  headers.set('CDN-Cache-Control', 'no-store');
  return headers;
}

function addResponseHeaders(headers, fileName, mimeType, upstream = null) {
  addCorsHeaders(headers);
  headers.set('Content-Type', mimeType || 'application/octet-stream');
  headers.set('Cache-Control', 'no-store, max-age=0');
  headers.set('Accept-Ranges', 'bytes');

  if (fileName) {
    const encoded = encodeURIComponent(fileName);
    headers.set('Content-Disposition', `inline; filename="${encoded}"; filename*=UTF-8''${encoded}`);
  }

  if (upstream) {
    const contentLength = upstream.headers.get('Content-Length');
    const contentRange = upstream.headers.get('Content-Range');
    // 只做一件事：过滤掉上游的 `Content-Length: 0`。
    // 上游（尤其中转 CDN）在拿不到大小时会退化成 0，浏览器会把
    // 「大小未知」当成「空文件」，直接标记下载完成 —— 这正是用户
    // 看到的「0b 下载」。其余情况一律沿用上游原值，绝不自造长度：
    // 自造长度一旦与实际发出的字节数不符，整个响应会被判定为损坏。
    if (contentLength && contentLength !== '0') headers.set('Content-Length', contentLength);
    if (contentRange) headers.set('Content-Range', contentRange);
  }
}

function handleOptions() {
  const headers = new Headers();
  addCorsHeaders(headers);
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(null, { status: 204, headers });
}

function errorResponse(message, status = 500) {
  const headers = new Headers();
  addCorsHeaders(headers);
  headers.set('Cache-Control', 'no-store, max-age=0');
  return new Response(message, { status, headers });
}

async function getRecordWithKey(env, fileId) {
  // 统一走 utils/file-record.js：带前缀 ID 行为不变，裸 ID 走索引加速
  return findRecordWithKey(env, fileId);
}

function getSharePassword(request) {
  const url = new URL(request.url);
  return String(
    url.searchParams.get('password')
    || request.headers.get('X-File-Password')
    || request.headers.get('X-Share-Password')
    || ''
  );
}

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(String(input || ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function verifyShareAccess(context, metadata = {}, kvKey = '') {
  const expiresAt = Number(metadata.shareExpiresAt || 0);
  if (Number.isFinite(expiresAt) && expiresAt > 0 && Date.now() > expiresAt) {
    return { response: errorResponse('File link has expired', 410) };
  }

  const maxDownloads = Number(metadata.shareMaxDownloads || 0);
  const hasLimit = Number.isFinite(maxDownloads) && maxDownloads > 0;

  // 密码先于配额校验：密码不对不应消耗任何配额。
  if (metadata.sharePasswordHash) {
    const providedPassword = getSharePassword(context.request);
    if (!providedPassword) {
      return { response: errorResponse('File password required', 401) };
    }
    const expected = await sha256Hex(`${String(metadata.sharePasswordSalt || '')}:${providedPassword}`);
    if (!timingSafeEqual(String(metadata.sharePasswordHash || ''), expected)) {
      return { response: errorResponse('File password invalid', 403) };
    }
  }

  // ---------------------------------------------------------------------------
  // 配额校验：D1 走「原子预占」，KV 走「读-判断」（旧行为）
  //
  // 只有显式下载（`?dl=1`）才消耗配额 —— 预览（视频拖拽产生的 Range 请求）
  // 不应吃配额。判断在 URL 上就能得出，无需等响应，因此可以在此预占。
  //
  // D1 路径把「是否超限」与「计数 +1」压成一条 UPDATE，从根上消除并发超发
  // （旧 KV 实现两步分离：并发下两个请求可以同时通过「未超限」判断）。
  // 预占成功后在 context 上标记，外层 trackDownloadsIfNeeded 会跳过重复计次。
  // ---------------------------------------------------------------------------
  if (hasLimit) {
    const counting = isExplicitDownload(context.request);

    if (counting) {
      const quota = await consumeDownloadQuota(context.env, kvKey);
      if (quota.limited) {
        // D1 明确判定已达上限
        return { response: errorResponse('File download limit reached', 410) };
      }
      if (quota.ok) {
        // 原子预占成功：标记已计次，外层不再重复落账
        context.__kvQuotaConsumed = true;
      } else {
        // D1 未绑定 / 记录不在 D1 → 回落旧的「读-判断」逻辑
        const currentDownloads = await readDownloadCount(context.env, kvKey, metadata);
        if (currentDownloads >= maxDownloads) {
          return { response: errorResponse('File download limit reached', 410) };
        }
      }
    } else {
      // 非显式下载（预览）：只做只读校验，不消耗配额
      const currentDownloads = await readDownloadCount(context.env, kvKey, metadata);
      if (currentDownloads >= maxDownloads) {
        return { response: errorResponse('File download limit reached', 410) };
      }
    }
  }

  return {
    response: null,
    trackDownload: hasLimit,
    kvKey,
    metadata,
  };
}

/**
 * 校验「这次请求是否来自一个合集」。
 *
 * 分享页的合集成员链接会带上 `?b=<slug>`，于是同一个文件可以经由两条完全
 * 独立的配额体系被下载：
 *   · 文件自身的分享属性（`shareMaxDownloads` 等）
 *   · 所属合集的配额与密码
 *
 * 合集是**独立实体**，它的配额不能靠文件元数据推断，必须回查合集体。
 * 两套校验都要跑：文件级管「这个文件自己被限制了多少次」，
 * 合集级管「这个链接整体被限制了多少次」。
 *
 * 状态码与 `/api/share-info` 的合集分支保持一致（410 过期 / 410 超次 /
 * 401 缺密码 / 403 密码错误），免得同一个链接在不同入口给出不同解释。
 *
 * 只有显式带 `dl=1` 的请求才计次，理由与文件级计数相同：预览不该吃配额。
 *
 * @returns `{ response, trackDownload, slug }`；`response` 非空表示应直接返回。
 */
async function verifyBundleAccess(context) {
  const url = new URL(context.request.url);
  const slug = String(url.searchParams.get('b') || '').trim().toLowerCase();
  if (!slug) return { response: null, trackDownload: false, slug: '' };

  const bundle = await readBundle(context.env, slug);
  if (!bundle) return { response: errorResponse('Bundle not found', 404), trackDownload: false, slug };

  if (isBundleExpired(bundle)) {
    return { response: errorResponse('Bundle link has expired', 410), trackDownload: false, slug };
  }
  if (isBundleExhausted(bundle)) {
    return { response: errorResponse('Bundle download limit reached', 410), trackDownload: false, slug };
  }

  const verdict = await verifyBundlePassword(bundle, getSharePassword(context.request));
  if (verdict === 'missing') {
    return { response: errorResponse('Bundle password required', 401), trackDownload: false, slug };
  }
  if (verdict === 'invalid') {
    return { response: errorResponse('Bundle password invalid', 403), trackDownload: false, slug };
  }

  // 无条件计次：配额的比较发生在下一次请求，所以只要放行就必须记一笔，
  // 否则「上限 1 次」会变成「上限 1 次 + 若干次免费」。
  return { response: null, trackDownload: true, slug };
}

/**
 * 是否应计入一次分享下载。
 *
 * ## 语义变更
 *
 * 改造前：GET 且响应 200/206 就计数。问题在于分享页要提供「预览」——
 * 视频拖动进度条会发出一串 Range 请求，每个都是 206，于是一次预览就把
 * 下载配额吃光；图片预览、PDF 翻页同理。
 *
 * 改造后：**只有显式带 `dl=1` 的请求才计数**。分享页的下载按钮会带这个
 * 参数，预览用的 iframe 不会。
 *
 * `dl=1` 的 Range 请求（大文件续传）仍算一次下载 —— 用户点的是下载。
 *
 * 实际判定落在 `trackDownloadsIfNeeded()` 里（那里拿得到状态码与响应体），
 * 保留本函数是为了让「什么叫一次下载」这件事只有一处定义。
 *
 * @param request - 原始请求。
 * @param response - 已生成的响应。
 * @returns 是否计数。
 */
function shouldCountAsDownload(request, response) {
  if (String(request?.method || '').toUpperCase() !== 'GET') return false;
  if (!response) return false;
  if (!isExplicitDownload(request)) return false;
  // 只排除「闸门拦下」与「路径本来就不存在」：那些不是访问尝试，
  // 计数等于把猜链接的代价转嫁给分享者。
  return ![401, 403, 404, 410].includes(Number(response.status));
}

/** 请求是否显式要求下载（`?dl=1`）。 */
function isExplicitDownload(request) {
  try {
    return new URL(request.url).searchParams.get('dl') === '1';
  } catch {
    return false;
  }
}

/**
 * 显式下载时把 `Content-Disposition` 从 `inline` 改成 `attachment`。
 *
 * `addResponseHeaders()` 里恒定写 `inline`（那是 7 个存储分支共用的），
 * 分享页的下载按钮需要浏览器直接保存文件而不是内联打开，因此在最外层
 * 统一改写响应头，避免动 7 处调用点。
 *
 * 两个必须小心的点：
 *   1. **只在 `!response.bodyUsed` 时重建响应**。body 已被消费时再构造
 *      `new Response(oldResponse.body)` 会抛错。
 *   2. **跳过重定向响应**。302 的 `Content-Disposition` 没有意义，
 *      而且 `Response.redirect()` 的响应是 immutable 的，改头会抛
 *      `TypeError: immutable`。
 *
 * @param context - Pages 请求上下文。
 * @param response - 内层处理函数返回的响应。
 * @returns 改写后的响应（无需改写时原样返回）。
 */
function applyDownloadDisposition(context, response) {
  try {
    if (!response || !isExplicitDownload(context?.request)) return response;

    // 重定向 / 无内容 / 错误响应无需（也不能）改写
    if (response.status < 200 || response.status >= 300) return response;
    if (response.status === 204 || response.status === 304) return response;
    // 空 body（如 204/HEAD）无需改写
    if (!response.body || response.bodyUsed) return response;

    const headers = new Headers(response.headers);
    const fileName = extractFileNameFromDisposition(headers.get('Content-Disposition'));
    if (fileName) {
      const encoded = encodeURIComponent(fileName);
      // 同时给 `filename` 与 `filename*`：前者兼容老浏览器，后者保证
      // 中文文件名在各浏览器下不乱码。与 addResponseHeaders 的写法一致。
      headers.set('Content-Disposition', `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    // 头改写属于锦上添花：失败时退回原响应，不要让下载整个挂掉
    console.warn('Failed to apply download disposition:', error?.message || error);
    return response;
  }
}

/**
 * 从已有的 `Content-Disposition` 里抠出文件名。
 * 优先读 RFC 5987 的 `filename*`（UTF-8 编码），退回 `filename`。
 * @param header - 原响应头值。
 * @returns 解码后的文件名，取不到时为空串。
 */
function extractFileNameFromDisposition(header) {
  const value = String(header || '');
  if (!value) return '';

  const starMatch = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (starMatch) {
    try {
      return decodeURIComponent(starMatch[1].trim());
    } catch {
      /* 落到下面的 filename */
    }
  }

  const plainMatch = value.match(/filename="([^"]*)"/i) || value.match(/filename=([^;]+)/i);
  if (plainMatch) {
    const raw = plainMatch[1].trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return '';
}

async function incrementShareDownloadCount(env, kvKey, metadata = {}) {
  // 只写独立计数键（几字节），不再重写整个 metadata，写入体积大幅下降。
  await incrementDownloadCount(env, kvKey, metadata);
}

async function handleTelegramFile(context, fileId, record = null) {
  const { request, env } = context;
  const url = new URL(request.url);

  const metadata = record?.metadata || {};
  const fileName = metadata.fileName || fileId;
  const mimeType = getMimeType(fileName);

  const telegramFileId = String(fileId).split('.')[0];
  const filePath = await getTelegramFilePath(env, telegramFileId);
  if (!filePath) {
    return errorResponse('Failed to get file path from Telegram', 500);
  }

  const rangeHeader = request.headers.get('Range');
  const fetchHeaders = new Headers();
  if (rangeHeader) fetchHeaders.set('Range', rangeHeader);

  const upstream = await fetch(buildTelegramFileUrl(env, filePath), {
    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: fetchHeaders,
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  if (!upstream.ok && upstream.status !== 206) {
    return errorResponse('Failed to fetch file from Telegram', upstream.status);
  }

  const headers = new Headers();
  addResponseHeaders(headers, fileName, mimeType, upstream);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function handleSignedTelegramFile(context, signedMeta) {
  const { request, env } = context;

  const filePath = await getTelegramFilePath(env, signedMeta.fileId);
  if (!filePath) {
    return errorResponse('Failed to get file path from Telegram', 500);
  }

  await backfillSignedTelegramMetadata(env, signedMeta);

  const fileName = signedMeta.fileName || `${signedMeta.fileId}.${signedMeta.fileExtension || 'bin'}`;
  const mimeType = signedMeta.mimeType || getMimeType(fileName);

  const rangeHeader = request.headers.get('Range');
  const fetchHeaders = new Headers();
  if (rangeHeader) fetchHeaders.set('Range', rangeHeader);

  const upstream = await fetch(buildTelegramFileUrl(env, filePath), {
    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: fetchHeaders,
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  if (!upstream.ok && upstream.status !== 206) {
    return errorResponse('Failed to fetch file from Telegram', upstream.status);
  }

  const headers = new Headers();
  addResponseHeaders(headers, fileName, mimeType, upstream);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

async function backfillSignedTelegramMetadata(env, signedMeta) {
  if (!env.img_url || !shouldWriteTelegramMetadata(env)) {
    return;
  }

  const fileExtension = signedMeta.fileExtension || 'bin';
  const kvKey = `${signedMeta.fileId}.${fileExtension}`;

  try {
    // 先查索引：命中说明该记录已登记，无需再读记录本体即可判定"已存在"。
    // 索引未命中（老数据）才回落到 getWithMetadata 做精确判断，
    // "已存在则不覆盖"的语义完全保留。
    const existing = await getRecordWithKey(env, kvKey);
    if (existing?.record?.metadata) return;

    await env.img_url.put(kvKey, '', {
      metadata: {
        TimeStamp: signedMeta.timestamp || Date.now(),
        ListType: 'None',
        Label: 'None',
        liked: false,
        fileName: signedMeta.fileName || `${signedMeta.fileId}.${fileExtension}`,
        fileSize: signedMeta.fileSize || 0,
        storageType: 'telegram',
        telegramFileId: signedMeta.fileId,
        telegramMessageId: signedMeta.messageId || undefined,
        signedLink: true,
        source: 'signed-backfill',
      },
    });
    // 回填后登记索引，后续同 ID 请求走快路径
    await putRecordIndex(env, kvKey);
  } catch (error) {
    console.warn('Signed metadata backfill skipped:', error.message);
  }
}

async function handleR2File(context, r2Key, record = null) {
  const { request, env } = context;

  if (!env.R2_BUCKET) {
    return errorResponse('R2 storage not configured', 500);
  }

  if (!record?.metadata) {
    const resolved = await getR2RecordFromKV(env, r2Key);
    record = resolved;
  }

  if (!record?.metadata) {
    return errorResponse('File not found', 404);
  }

  const fileName = record.metadata.fileName || r2Key;
  const mimeType = getMimeType(fileName);

  const rangeHeader = request.headers.get('Range');
  let object;
  let responseStatus = 200;
  let contentLength = null;
  let contentRange = null;

  if (rangeHeader) {
    const head = await env.R2_BUCKET.head(r2Key);
    if (!head) return errorResponse('File not found in R2', 404);

    const range = parseSimpleRange(rangeHeader, head.size);
    if (range) {
      if (range.unsatisfiable) {
        const headers = new Headers();
        addCorsHeaders(headers);
        headers.set('Accept-Ranges', 'bytes');
        headers.set('Content-Range', `bytes */${head.size}`);
        return new Response('Range Not Satisfiable', { status: 416, headers });
      }

      const { start, end } = range;
      object = await env.R2_BUCKET.get(r2Key, {
        range: { offset: start, length: end - start + 1 },
      });
      responseStatus = 206;
      contentLength = end - start + 1;
      contentRange = `bytes ${start}-${end}/${head.size}`;
    }
  }

  if (!object) {
    /* HEAD 只要元数据，用 head() 而不是 get()。
       旧实现在这里也走 get() —— 于是每个 HEAD 探测都要把整个对象从 R2
       读一遍，只为回答「在不在」。前端的失效探测、以及「清理失效历史」
       那条 5 并发的 HEAD 批量，都被放大成了一次次全文读取。 */
    if (String(request.method || '').toUpperCase() === 'HEAD') {
      const meta = await env.R2_BUCKET.head(r2Key);
      if (!meta) return errorResponse('File not found in R2', 404);

      const headHeaders = new Headers();
      addResponseHeaders(headHeaders, fileName, mimeType);
      headHeaders.set('Content-Length', String(meta.size));

      return new Response(null, { status: 200, headers: headHeaders });
    }

    object = await env.R2_BUCKET.get(r2Key);
  }

  if (!object) {
    return errorResponse('File not found in R2', 404);
  }

  const headers = new Headers();
  addResponseHeaders(headers, fileName, mimeType);
  headers.set('Content-Length', String(contentLength ?? object.size));
  if (contentRange) headers.set('Content-Range', contentRange);

  return new Response(object.body, {
    status: responseStatus,
    headers,
  });
}

async function getR2RecordFromKV(env, r2Key) {
  if (!env.img_url) return null;

  const candidateKeys = r2Key.startsWith('r2:') ? [r2Key, r2Key.slice(3)] : [`r2:${r2Key}`, r2Key];

  for (const key of candidateKeys) {
    const record = await env.img_url.getWithMetadata(key);
    if (record?.metadata) return record;
  }

  return null;
}

function parseSimpleRange(rangeHeader, size = null) {
  const match = String(rangeHeader || '').match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  const hasStart = match[1] !== '';
  const hasEnd = match[2] !== '';
  if (!hasStart && !hasEnd) return null;

  let start;
  let end;

  if (!hasStart) {
    const suffixLength = parseInt(match[2], 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    if (size == null) return { start: null, end: suffixLength };
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = parseInt(match[1], 10);
    end = hasEnd ? parseInt(match[2], 10) : (size == null ? null : size - 1);
  }

  if (!Number.isFinite(start) || (end != null && !Number.isFinite(end))) return null;

  if (size != null) {
    if (start >= size || (end != null && start > end)) {
      return { unsatisfiable: true };
    }
    end = Math.min(end ?? size - 1, size - 1);
  }

  return { start, end };
}

async function handleS3File(context, fileId, record = null) {
  const { request, env } = context;

  if (!record?.metadata) {
    record = await findRecordByPrefixes(env, fileId, ['s3:', 'img:', 'vid:', 'aud:', 'doc:', '']);
  }
  if (!record?.metadata) return errorResponse('File not found', 404);

  const s3Key = record.metadata.s3Key || fileId.replace(/^s3:/, '');
  const fileName = record.metadata.fileName || fileId;
  const mimeType = getMimeType(fileName);

  const s3 = createS3Client(env);
  const rangeHeader = request.headers.get('Range');
  const upstream = await s3.getObject(s3Key, rangeHeader ? { range: rangeHeader } : {});

  if (!upstream) return errorResponse('File not found in S3', 404);

  const headers = new Headers();
  addResponseHeaders(headers, fileName, mimeType, upstream);

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

async function handleDiscordFile(context, fileId, record = null) {
  const { request, env } = context;

  if (!record?.metadata) {
    record = await findRecordByPrefixes(env, fileId, ['discord:', 'img:', 'vid:', 'aud:', 'doc:', '']);
  }
  if (!record?.metadata) return errorResponse('File not found', 404);

  const { discordChannelId, discordMessageId } = record.metadata;
  if (!discordChannelId || !discordMessageId) {
    return errorResponse('Discord metadata incomplete', 500);
  }

  const fileInfo = await getDiscordFileUrl(discordChannelId, discordMessageId, env);
  if (!fileInfo) return errorResponse('File not found on Discord', 404);

  const rangeHeader = request.headers.get('Range');
  const upstream = await fetch(fileInfo.url, {
    headers: rangeHeader ? { Range: rangeHeader } : {},
  });

  if (!upstream.ok && upstream.status !== 206) {
    return errorResponse('Error fetching file from Discord', 502);
  }

  const fileName = record.metadata.fileName || fileInfo.filename || fileId;
  const mimeType = getMimeType(fileName);

  const headers = new Headers();
  addResponseHeaders(headers, fileName, mimeType, upstream);

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

async function handleHFFile(context, fileId, record = null) {
  const { request, env } = context;

  if (!record?.metadata) {
    record = await findRecordByPrefixes(env, fileId, ['hf:', 'img:', 'vid:', 'aud:', 'doc:', '']);
  }
  if (!record?.metadata) return errorResponse('File not found', 404);

  const hfPath = record.metadata.hfPath;
  if (!hfPath) return errorResponse('HuggingFace path missing', 500);

  const rangeHeader = request.headers.get('Range');
  const upstream = await getHuggingFaceFile(hfPath, env, rangeHeader ? { range: rangeHeader } : {});

  if (!upstream.ok && upstream.status !== 206) {
    return errorResponse('File not found on HuggingFace', upstream.status || 404);
  }

  const fileName = record.metadata.fileName || fileId;
  const mimeType = getMimeType(fileName);

  const headers = new Headers();
  addResponseHeaders(headers, fileName, mimeType, upstream);

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

async function handleWebDAVFile(context, fileId, record = null) {
  const { request, env } = context;

  if (!record?.metadata) {
    record = await findRecordByPrefixes(env, fileId, ['webdav:', 'img:', 'vid:', 'aud:', 'doc:', '']);
  }
  if (!record?.metadata) return errorResponse('File not found', 404);

  const webdavPath = record.metadata.webdavPath || fileId.replace(/^webdav:/, '');
  if (!webdavPath) return errorResponse('WebDAV path missing', 500);

  const rangeHeader = request.headers.get('Range');
  const upstream = await getWebDAVFile(webdavPath, env, rangeHeader ? { range: rangeHeader } : {});
  if (!upstream) return errorResponse('File not found on WebDAV', 404);

  const fileName = record.metadata.fileName || fileId;
  const mimeType = getMimeType(fileName);

  const headers = new Headers();
  addResponseHeaders(headers, fileName, mimeType, upstream);

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

async function handleGitHubFile(context, fileId, record = null) {
  const { request, env } = context;

  if (!record?.metadata) {
    record = await findRecordByPrefixes(env, fileId, ['github:', 'img:', 'vid:', 'aud:', 'doc:', '']);
  }
  if (!record?.metadata) return errorResponse('File not found', 404);

  const githubStorageKey = record.metadata.githubStorageKey || fileId.replace(/^github:/, '');
  const rangeHeader = request.headers.get('Range');
  const upstream = await getGitHubFile(
    githubStorageKey,
    record.metadata || {},
    env,
    rangeHeader ? { range: rangeHeader } : {}
  );

  if (!upstream) return errorResponse('File not found on GitHub', 404);

  const fileName = record.metadata.fileName || fileId;
  const mimeType = getMimeType(fileName);

  const headers = new Headers();
  addResponseHeaders(headers, fileName, mimeType, upstream);

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

async function findRecordByPrefixes(env, fileId, prefixes = []) {
  if (!env.img_url) return null;

  // 并发探测：串行版本最坏要把 prefixes.length 次 KV 往返叠起来。
  // 命中判定仍按 prefixes 的原顺序取第一个，语义与串行版一致。
  const keys = prefixes.map((prefix) => `${prefix}${fileId}`);
  const probed = await Promise.all(
    keys.map((key) => env.img_url.getWithMetadata(key).catch(() => null))
  );
  return probed.find((record) => record?.metadata) || null;
}

async function getTelegramFilePath(env, fileId) {
  try {
    const url = `${buildTelegramBotApiUrl(env, 'getFile')}?file_id=${encodeURIComponent(fileId)}`;
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) return null;

    const data = await response.json();
    if (!data?.ok || !data?.result?.file_path) return null;
    return data.result.file_path;
  } catch (error) {
    console.error('getTelegramFilePath failed:', error);
    return null;
  }
}
