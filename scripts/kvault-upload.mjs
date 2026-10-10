#!/usr/bin/env node
/**
 * K-Vault 上传 CLI —— 把「本地文件 → 直链」压缩成一条命令。
 *
 * ============================================================================
 * 为什么需要它
 * ============================================================================
 *
 * 网页上传要开浏览器、MCP 的 `kvault_upload_file` 要求把文件内容编码成 base64
 * 塞进 JSON —— 两者对「我本地就有一个文件，给我个链接」这件事都太绕。
 *
 *   网页：点开 → 登录 → 拖拽 → 复制链接        （4 步 + 一个浏览器）
 *   MCP ：base64 编码（体积 +33%）→ 塞进 1MiB 请求体（实际上限 ~750KB）
 *   CLI ：node scripts/kvault-upload.mjs upload ./a.png   （1 步）
 *
 * 本脚本**零 npm 依赖**：只用 Node 22 内置的
 * `util.parseArgs` + 全局 `fetch`/`FormData`/`Blob`/`File` + `fs.globSync`。
 * 所以它可以直接扔进 CI、塞进任何装了 Node 的机器，不需要 `npm install`。
 *
 * ============================================================================
 * 为什么不做流式上传
 * ============================================================================
 *
 * Node 原生的 `FormData`/`Blob` 要求内容全量驻留内存。手写一个 multipart
 * 流式编码器并不难，但会引入「boundary 生成 / 分块拼接 / 背压处理 / 错误回溯」
 * 一整套复杂度 —— 为了一个「零依赖小工具」不值得。
 *
 * 代价被显式地圈在 100MB：这是服务端 `capabilities.maxUploadSize` 的默认值，
 * 也是本项目「小文件随手传」的定位上限。更大的文件请走网页端的**分片上传**
 * （R2 原生 multipart，最高 10GB）—— 那条链路需要 Cookie/Basic 会话，
 * 不接受 API Token，本 CLI 刻意不碰。
 *
 * ============================================================================
 * 覆盖的调用形态
 * ============================================================================
 *
 *   kvault-upload upload ./a.png                   单文件
 *   kvault-upload upload ./a.png ./b.jpg           多文件（逐个上传，互不影响）
 *   kvault-upload upload './shots/*.png'           glob（含 ** 递归）
 *   kvault-upload upload ./dist/                   目录（递归展开）
 *   cat a.png | kvault-upload upload -             标准输入
 *
 * ============================================================================
 * 退出码
 * ============================================================================
 *
 *   0  全部成功
 *   1  有文件上传失败（批量模式下只要有一个失败就是 1）
 *   2  用法 / 配置错误（参数非法、缺 Token、路径不存在、超过 100MB）
 *
 * ============================================================================
 * 用法速查
 * ============================================================================
 *
 *   export KVAULT_ENDPOINT="https://your-kvault-domain"
 *   export KVAULT_TOKEN="kvault_<id>_<secret>"
 *   node scripts/kvault-upload.mjs upload ./cover.png
 *
 * 完整参数见 `--help`。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

/* ==========================================================================
 * 常量
 * ========================================================================== */

/**
 * 客户端预检上限。与服务端 `capabilities.maxUploadSize` 的默认值一致。
 *
 * 为什么在客户端就拦：服务端要等你把 100MB 传完才可能返回 413，白烧流量和时间。
 * 提前拒绝能立刻给出「改用网页端分片上传」的可执行建议。
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** 退出码。集中定义，避免各处散落魔法数字。 */
export const EXIT_OK = 0;
export const EXIT_UPLOAD_FAILED = 1;
export const EXIT_USAGE = 2;

/** stdin 兜底文件名。服务端会用扩展名推断 MIME，所以给一个中性的 .bin。 */
export const STDIN_FILE_NAME = 'stdin.bin';

/**
 * 错误码 → 中文人话。
 *
 * 为什么要在客户端翻译：这些码是给程序看的（稳定、可分支），但 CLI 的输出
 * 是给**人**看的。把 `POLICY_FILE_TOO_LARGE` 直接抛给用户，他还得回来翻文档。
 * 翻译表只做「加一句解释」，原始 code 依然保留在 `--json` 输出里。
 */
export const ERROR_HINTS = {
  TOKEN_MISSING: '请求没带 Token。用 -t/--token 或设置环境变量 KVAULT_TOKEN。',
  TOKEN_INVALID: 'Token 无效或已失效。到管理后台 → API Token 管理确认，或重新创建一个。',
  TOKEN_EXPIRED: 'Token 已过期。请重新创建或延长有效期。',
  TOKEN_DISABLED: 'Token 已被禁用。到管理后台重新启用。',
  SCOPE_REQUIRED: 'Token 缺少 upload scope。到管理后台编辑该 Token，勾选 upload。',
  POLICY_DENIED: '被 Token 策略拦截（allowedStorages / folderPrefix）。检查该 Token 的策略配置。',
  POLICY_FILE_TOO_LARGE: '超过该 Token 的 maxFileSize 策略上限。换一个 Token 或调高策略。',
  FILE_TOO_LARGE: '超过服务端单文件上限。大文件请用网页端的分片上传（R2，最高 10GB）。',
  SLUG_CONFLICT: '自定义 slug 已被占用。换一个 --slug，或去掉它自动生成。',
  UPLOAD_FAILED: '服务端上传失败。可能是存储后端未配置或临时不可用，看 message 详情。',
  UPLOAD_METADATA_FAILED: '文件已上传，但分享元数据写入失败（slug/密码/有效期）。',
  VALIDATION_ERROR: '参数不合法。检查文件字段与各分享参数。',
  BAD_REQUEST: '请求格式不对，需要 multipart/form-data。',
  RATE_LIMITED: '触发 Token 限流，稍后重试。',
};

/** HTTP 状态兜底提示（响应体里没有可识别的 error.code 时使用）。 */
export const STATUS_HINTS = {
  401: '鉴权失败：Token 缺失、无效或已过期。',
  403: '权限不足：Token 缺少 scope 或被策略拦截。',
  409: '冲突：slug 已被占用。',
  413: '文件超过服务端上限。',
  429: '请求过于频繁，触发限流。',
  500: '服务端内部错误。',
  502: '上游响应异常。',
  503: '服务不可用（可能是后台未配置鉴权）。',
};

/* ==========================================================================
 * 参数解析
 * ========================================================================== */

/** `--help` 正文。写在这里而不是散在打印语句里，方便测试断言关键片段。 */
export const HELP_TEXT = `K-Vault 上传 CLI —— 本地文件直接换直链

用法:
  kvault-upload upload <路径...> [选项]

路径可以是文件、目录（递归）、glob（如 './shots/*.png'）或 '-'（读标准输入）。
可一次给多个，逐个上传、互不影响。

选项:
  -e, --endpoint <url>     站点地址，如 https://kvault.example.com
                           也可用环境变量 KVAULT_ENDPOINT
  -t, --token <token>      API Token（kvault_<id>_<secret>）
                           也可用环境变量 KVAULT_TOKEN / KVAULT_API_TOKEN
  -s, --storage <name>     存储后端（telegram/r2/s3/discord/huggingface/webdav/github）
  -f, --folder <path>      存储目录前缀，如 blog/2026
  -p, --password <pass>    分享链接密码
      --expires-in <sec>   分享链接有效期（秒），缺省永久
      --max-downloads <n>  分享链接最大下载次数，缺省不限
      --slug <slug>        自定义分享短链标识（字母/数字/下划线/短横线）
      --dedupe             请求服务端按内容去重（相同内容返回已有文件）
      --json               以 JSON 输出结果（便于脚本消费）
  -q, --quiet              只输出直链，每行一个
  -h, --help               显示本帮助
  -v, --version            显示版本

环境变量:
  KVAULT_ENDPOINT          站点地址
  KVAULT_TOKEN              API Token（KVAULT_API_TOKEN 亦可）

退出码:
  0 成功   1 有文件上传失败   2 用法或配置错误

示例:
  export KVAULT_ENDPOINT=https://kvault.example.com
  export KVAULT_TOKEN=kvault_xxx_yyy
  node scripts/kvault-upload.mjs upload ./cover.png
  node scripts/kvault-upload.mjs upload ./shots/*.png --folder blog/2026 --quiet
  cat report.pdf | node scripts/kvault-upload.mjs upload - --slug q3-report
`;

/** 参数规范。导出供测试直接断言 parseArgs 的行为。 */
export const OPTION_SPEC = {
  endpoint: { type: 'string', short: 'e' },
  token: { type: 'string', short: 't' },
  storage: { type: 'string', short: 's' },
  folder: { type: 'string', short: 'f' },
  password: { type: 'string', short: 'p' },
  'expires-in': { type: 'string' },
  'max-downloads': { type: 'string' },
  slug: { type: 'string' },
  dedupe: { type: 'boolean' },
  json: { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

/**
 * 解析 argv。
 *
 * 刻意**不**用 `allowPositionals` 之外的花活：把「命令 + 路径」当位置参数处理，
 * 与 git / docker 的肌肉记忆一致。唯一的特殊性是 glob —— 但那是 shell 展开的，
 * 与本函数无关。
 *
 * @returns {{ok: true, command: string, paths: string[], flags: object}
 *          | {ok: false, error: string}}
 */
export function parseCliArgs(argv = []) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: OPTION_SPEC,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    // parseArgs 抛的是英文 TypeError（如 "Unknown option '--nope'"）。
    // 包一层，让用户看到的是「用法错误」而不是一段栈。
    return { ok: false, error: `参数解析失败：${error?.message || error}` };
  }

  const positionals = parsed.positionals || [];
  const command = positionals[0] || '';
  const paths = positionals.slice(1);

  return { ok: true, command, paths, flags: parsed.values || {} };
}

/**
 * 把原始 flags 规整成配置对象（含环境变量回落）。
 *
 * 优先级：**显式命令行参数 > 环境变量**。这是 CLI 的通行约定 ——
 * 环境变量负责「这台机器上的默认值」，命令行负责「这次调用要覆盖」。
 *
 * @param {object} flags        parseCliArgs 的 flags
 * @param {object} env          环境变量（默认 process.env）
 * @param {Function} [fileExists] 注入用：判定路径是否存在（测试替身）
 */
export function resolveOptions(flags = {}, env = process.env) {
  const endpointRaw =
    pickString(flags.endpoint) ||
    pickString(env.KVAULT_ENDPOINT) ||
    pickString(env.KVAULT_BASE_URL) ||
    '';

  const tokenRaw =
    pickString(flags.token) ||
    pickString(env.KVAULT_TOKEN) ||
    pickString(env.KVAULT_API_TOKEN) ||
    '';

  return {
    endpoint: normalizeEndpoint(endpointRaw),
    token: tokenRaw,
    storage: pickString(flags.storage),
    folderPath: pickString(flags.folder),
    password: pickString(flags.password),
    expiresIn: pickInt(flags['expires-in']),
    maxDownloads: pickInt(flags['max-downloads']),
    // 保留原始字符串供 validateOptions 区分「没传」与「传了非法值」。
    rawExpiresIn: flags['expires-in'],
    rawMaxDownloads: flags['max-downloads'],
    slug: pickString(flags.slug),
    dedupe: flags.dedupe === true,
    json: flags.json === true,
    quiet: flags.quiet === true,
  };
}

/** 空字符串视同未提供（`--folder ""` 与不写等价）。 */
function pickString(value) {
  const text = String(value ?? '').trim();
  return text || '';
}

/** 正整数解析；非法值返回 null（由校验阶段报错，而不是静默变成 NaN）。 */
export function pickInt(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

/**
 * 归一化站点地址。
 *
 * 用户很容易写成 `kvault.example.com`（缺协议）或 `.../mcp`（多带了路径）。
 * 这里统一补 https、去掉尾斜杠与尾部路径，避免拼出
 * `https://host/mcp/api/v1/upload` 这种必然 404 的 URL。
 */
export function normalizeEndpoint(raw) {
  let text = pickString(raw);
  if (!text) return '';
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  try {
    const url = new URL(text);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '';
  }
}

/**
 * 校验配置，返回第一条错误。
 *
 * 分开做（而不是在 resolveOptions 里直接抛）是为了让单测能逐个分支断言，
 * 也让 `--help` 之类的无副作用分支不受牵连。
 *
 * 数值类选项的校验必须基于**原始字符串**（`options.rawExpiresIn`），
 * 而不是解析后的 `expiresIn`。原因：解析后的值是 `null` 既有可能是
 * 「用户没传」（合法）也有可能是「用户传了 'abc'」（非法），单看结果分不清。
 * 早期版本正是这么写的，导致每次不带 `--expires-in` 的正常调用都被误判为用法错误。
 */
export function validateOptions(options) {
  if (!options.endpoint) {
    return { ok: false, error: '缺少站点地址。用 -e/--endpoint 或将 KVAULT_ENDPOINT 设为你的部署地址。' };
  }
  if (!options.token) {
    return { ok: false, error: '缺少 API Token。用 -t/--token 或设置环境变量 KVAULT_TOKEN。' };
  }
  if (options.quiet && options.json) {
    return { ok: false, error: '--quiet 与 --json 互斥：前者只输出链接，后者输出完整结构化结果。' };
  }
  // 传了值但解析不出正整数才算错；没传（空串/undefined）一律放行。
  if (!isAbsentOrPositiveInt(options.rawExpiresIn)) {
    return { ok: false, error: '--expires-in 需要正整数（秒）。' };
  }
  if (!isAbsentOrPositiveInt(options.rawMaxDownloads)) {
    return { ok: false, error: '--max-downloads 需要正整数。' };
  }
  return { ok: true };
}

/** 「没传」或「是个正整数」——两种都算合法。 */
function isAbsentOrPositiveInt(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return true;
  return pickInt(raw) !== null;
}

/* ==========================================================================
 * 路径展开
 * ========================================================================== */

/** 判断一个路径是不是「glob 模式」（含 * ? [ ] { } 之一）。 */
export function isGlobPattern(input) {
  return /[*?[\]{}]/.test(String(input ?? ''));
}

/**
 * 把一串位置参数展开成待上传文件清单。
 *
 * 支持四类输入，且可以混用：
 *   · `-`             → 读标准输入，标记为 stdin
 *   · glob 模式        → fs.globSync（支持 **）
 *   · 目录             → 递归展开
 *   · 普通文件路径      → 原样
 *
 * 行为取舍：
 *   · **去重**：`./a.png ./a.png` 只上传一次，避免误传两次。
 *   · **保持顺序**：按参数顺序输出，glob/目录内部按字典序，结果可预测。
 *   · **单文件失败不致命**：某个路径不存在只有它是唯一输入时才算用法错误；
 *     批量场景下其余文件照常上传，最后统一报告（见 runUpload）。
 *
 * @returns {{ok: true, files: Array<{kind:'file'|'stdin', path:string, name:string, size:number}>,
 *            missing: string[]}
 *          | {ok: false, error: string}}
 */
export function expandInputs(inputs = [], { cwd = process.cwd(), glob = defaultGlob } = {}) {
  const files = [];
  const seen = new Set();
  const missing = [];
  let hasStdin = false;

  for (const input of inputs) {
    if (input === '-') {
      if (!hasStdin) {
        hasStdin = true;
        files.push({ kind: 'stdin', path: '-', name: STDIN_FILE_NAME, size: 0 });
      }
      continue;
    }

    if (isGlobPattern(input)) {
      let matched = [];
      try {
        matched = glob(input, { cwd }) || [];
      } catch (error) {
        return { ok: false, error: `glob 展开失败（${input}）：${error?.message || error}` };
      }
      if (matched.length === 0) {
        missing.push(input);
        continue;
      }
      for (const hit of matched) {
        const resolved = path.resolve(cwd, hit);
        if (seen.has(resolved)) continue;
        seen.add(resolved);
        files.push({ kind: 'file', path: resolved, name: path.basename(resolved), size: safeSize(resolved) });
      }
      continue;
    }

    const resolved = path.resolve(cwd, input);
    if (!fs.existsSync(resolved)) {
      missing.push(input);
      continue;
    }
    if (fs.statSync(resolved).isDirectory()) {
      // 目录递归。`**/*` 会命中文件，过滤掉目录本身。
      let entries = [];
      try {
        entries = fs.readdirSync(resolved, { recursive: true, withFileTypes: true }) || [];
      } catch (error) {
        return { ok: false, error: `读取目录失败（${input}）：${error?.message || error}` };
      }
      const found = entries
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(entry.parentPath || entry.path || resolved, entry.name))
        .sort((a, b) => a.localeCompare(b));
      if (found.length === 0) {
        missing.push(input);
        continue;
      }
      for (const filePath of found) {
        const abs = path.resolve(filePath);
        if (seen.has(abs)) continue;
        seen.add(abs);
        files.push({ kind: 'file', path: abs, name: path.basename(abs), size: safeSize(abs) });
      }
      continue;
    }

    if (seen.has(resolved)) continue;
    seen.add(resolved);
    files.push({ kind: 'file', path: resolved, name: path.basename(resolved), size: safeSize(resolved) });
  }

  if (files.length === 0 && missing.length > 0) {
    return { ok: false, error: `找不到要上传的文件：${missing.join(', ')}` };
  }
  return { ok: true, files, missing };
}

/** fs.globSync 的薄包装：Node 22 上它还是 experimental，缺了要能优雅降级到 null。 */
function defaultGlob(pattern, options) {
  if (typeof fs.globSync !== 'function') {
    throw new Error('当前 Node 版本不支持 fs.globSync（需要 Node 22+）。请把 glob 交给 shell 展开，或直接传目录。');
  }
  return fs.globSync(pattern, options);
}

/** stat 失败当作 0，交给服务端判定，不让本地权限问题阻断整个批量任务。 */
function safeSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * 单文件体积预检。
 *
 * `size` 为 0 时放行：那可能真的是个空文件（合法），也可能是 stat 失败 ——
 * 两种都交给服务端给权威结论，客户端不越权判定。
 */
export function checkSizeLimit(size, limit = MAX_UPLOAD_BYTES) {
  const bytes = Number(size) || 0;
  if (bytes > limit) {
    return {
      ok: false,
      error: `文件 ${formatBytes(bytes)} 超过 ${formatBytes(limit)} 上限。大文件请用网页端的分片上传（R2，最高 10GB）。`,
    };
  }
  return { ok: true };
}

/* ==========================================================================
 * 请求构造
 * ========================================================================== */

/** 极简 MIME 表。与服务端 `mapMimeType` 的扩展名列表保持一致。 */
const MIME_BY_EXTENSION = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  pdf: 'application/pdf',
  zip: 'application/zip',
};

/** 按扩展名推断 MIME；认不出时用 octet-stream（服务端会再兜一层）。 */
export function guessMime(fileName = '') {
  const ext = String(fileName).split('.').pop()?.toLowerCase() || '';
  return MIME_BY_EXTENSION[ext] || 'application/octet-stream';
}

/**
 * 构造 multipart 表单。
 *
 * 字段名必须与 `functions/api/v1/upload.js` 读取的一致 —— 特别注意
 * **`expires_in` / `max_downloads` 是下划线**（`folderPath` 又是驼峰），
 * 这是历史遗留的不一致，服务端两种都读，这里按下划线的规范写法发。
 *
 * 只 append 真正有值的字段：服务端对 `String(undefined)` 会得到字符串
 * "undefined"，进而当成一个「设了值」的选项。
 */
export function buildUploadForm(fileSource, options = {}) {
  const form = new FormData();
  const name = fileSource?.name || STDIN_FILE_NAME;
  const mime = fileSource?.type || guessMime(name);
  form.append('file', new File([fileSource.bytes], name, { type: mime }));

  const optional = [
    ['storage', options.storage],
    ['folderPath', options.folderPath],
    ['slug', options.slug],
    ['password', options.password],
  ];
  for (const [key, value] of optional) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      form.append(key, String(value));
    }
  }
  if (Number.isFinite(options.expiresIn) && options.expiresIn > 0) {
    form.append('expires_in', String(options.expiresIn));
  }
  if (Number.isFinite(options.maxDownloads) && options.maxDownloads > 0) {
    form.append('max_downloads', String(options.maxDownloads));
  }
  if (options.dedupe === true) {
    form.append('deduplicate', 'true');
  }
  return form;
}

/** 组装请求头。Authorization 用 Bearer，与 v1 契约一致。 */
export function buildHeaders(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    ...extra,
  };
}

/**
 * 上传一个已读入内存的文件。
 *
 * 依赖注入 `fetchImpl` 是为了单测能塞替身 —— 这样「请求怎么拼」与
 * 「响应怎么解读」都能在不起服务的前提下断言。
 *
 * @returns {{ok: true, status: number, payload: object}
 *          | {ok: false, status: number, payload: object|null, message: string}}
 */
export async function uploadOnce(fileSource, options, { fetchImpl = globalThis.fetch } = {}) {
  const url = `${options.endpoint}/api/v1/upload`;
  const form = buildUploadForm(fileSource, options);

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: buildHeaders(options.token),
      body: form,
    });
  } catch (error) {
    // 网络层失败：DNS / 连接被拒 / TLS / 超时。没有 HTTP 状态码可看。
    return {
      ok: false,
      status: 0,
      payload: null,
      message: `网络请求失败：${error?.message || error}`,
    };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok || payload?.success === false) {
    return {
      ok: false,
      status: response.status,
      payload,
      message: describeFailure(response.status, payload),
    };
  }
  return { ok: true, status: response.status, payload };
}

/**
 * 把失败响应翻译成一句中文人话。
 *
 * 顺序很重要：**先认 error.code（精确），再用 HTTP 状态兜底（模糊）**。
 * 反过来会出现「403 一律说权限不足」而掩盖掉 `POLICY_FILE_TOO_LARGE`
 * 这种其实需要完全不同处置方式的错误。
 */
export function describeFailure(status, payload) {
  const code = String(payload?.error?.code || payload?.code || '').trim();
  const rawMessage = String(payload?.error?.message || payload?.message || '').trim();

  const parts = [];
  if (code && ERROR_HINTS[code]) parts.push(ERROR_HINTS[code]);
  if (rawMessage) parts.push(rawMessage);
  if (parts.length === 0 && STATUS_HINTS[status]) parts.push(STATUS_HINTS[status]);
  if (parts.length === 0) parts.push(`上传失败（HTTP ${status || '无响应'}）。`);
  if (code) parts.push(`[${code}]`);

  return parts.join(' ');
}

/** 从成功响应里取直链（= `/file/<id>` 的绝对地址）。 */
export function extractDirectLink(payload) {
  const download = payload?.links?.download;
  return typeof download === 'string' && download ? download : '';
}

/** 从成功响应里取文件记录，兼容服务端把字段包在 `data` 里的历史形态。 */
export function extractFileRecord(payload) {
  return payload?.file || payload?.data?.file || null;
}

/* ==========================================================================
 * 输出
 * ========================================================================== */

/** 人类可读的字节数。 */
export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 计算内容 SHA-256，用作 `--json` 输出与去重提示。 */
export function sha256Hex(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

/**
 * 渲染单个文件的上传结果。
 *
 * 三种输出形态，面向三类消费方：
 *   · `quiet` → 只有链接，`$(...)` 里能直接拿去用
 *   · `json`  → 完整结构，脚本 / jq 消费
 *   · 默认     → 人看的，带文件信息与可复制的链接
 */
export function renderResult(result, { json = false, quiet = false } = {}) {
  if (quiet) {
    return result.ok ? extractDirectLink(result.payload) : '';
  }
  if (json) {
    return JSON.stringify(
      result.ok
        ? {
            success: true,
            path: result.path,
            file: extractFileRecord(result.payload),
            links: result.payload?.links || null,
            directLink: extractDirectLink(result.payload),
            deduplicated: Boolean(result.payload?.deduplicated),
          }
        : {
            success: false,
            path: result.path,
            status: result.status,
            error: result.payload?.error || null,
            message: result.message,
          },
      null,
      2,
    );
  }

  if (!result.ok) {
    return `✗ ${result.path}\n  ${result.message}`;
  }

  const record = extractFileRecord(result.payload) || {};
  const directLink = extractDirectLink(result.payload);
  const lines = [
    `✓ ${record.name || result.path}`,
    `  大小  ${formatBytes(record.size)}`,
    `  存储  ${record.storage || '-'}`,
    `  直链  ${directLink || '(响应未返回 download 链接)'}`,
  ];
  if (result.payload?.deduplicated) {
    lines.push('  去重  命中已有文件（未重复占用存储）');
  }
  if (result.payload?.links?.share && result.payload.links.share !== directLink) {
    lines.push(`  分享  ${result.payload.links.share}`);
  }
  return lines.join('\n');
}

/* ==========================================================================
 * 主流程
 * ========================================================================== */

/**
 * 读入一个输入项的内容。
 *
 * 目录 / glob 已在 expandInputs 阶段展开成具体文件，这里只剩「stdin」与「文件」。
 */
export async function readSource(entry, { stdin = process.stdin } = {}) {
  if (entry.kind === 'stdin') {
    const bytes = await readStdin(stdin);
    return { name: entry.name, bytes, type: guessMime(entry.name), size: bytes.byteLength };
  }
  const bytes = fs.readFileSync(entry.path);
  return { name: entry.name, bytes, type: guessMime(entry.name), size: bytes.byteLength };
}

/** 读干标准输入。`for await` 对管道与 TTY 都成立（TTY 下靠 Ctrl-D 结束）。 */
export async function readStdin(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * 执行批量上传。
 *
 * 错误隔离是核心设计：**每个文件独立成败**。批量传 20 张图时，第 7 张
 * 因为策略被拒不应该让另外 19 张白传 —— 那会让人不敢用批量模式。
 *
 * `oversized` 单独计数（不计入 `failed`）：本地预检拒绝属于「用法问题」，
 * 与「服务端说不行」是两类。前者提示你改用分片上传，后者才是真的上传失败。
 * 退出码分别映射到 2 与 1，让 CI 能区分「我参数写错了」和「服务端挂了」。
 *
 * @returns {{results: object[], failed: number, oversized: number}}
 */
export async function runUpload(entries, options, { fetchImpl = globalThis.fetch, onResult = null } = {}) {
  const results = [];
  let failed = 0;
  let oversized = 0;

  for (const entry of entries) {
    let source;
    try {
      source = await readSource(entry);
    } catch (error) {
      const result = {
        ok: false,
        path: entry.path,
        status: 0,
        payload: null,
        kind: 'read_error',
        message: `读取文件失败：${error?.message || error}`,
      };
      results.push(result);
      failed += 1;
      if (onResult) onResult(result, results.length, entries.length);
      continue;
    }

    const sizeCheck = checkSizeLimit(source.size);
    if (!sizeCheck.ok) {
      const result = {
        ok: false,
        path: entry.path,
        status: 0,
        payload: null,
        kind: 'oversized',
        message: sizeCheck.error,
      };
      results.push(result);
      oversized += 1;
      if (onResult) onResult(result, results.length, entries.length);
      continue;
    }

    const result = await uploadOnce(source, options, { fetchImpl });
    result.path = entry.path;
    result.kind = result.ok ? 'ok' : 'upload_failed';
    result.sha256 = sha256Hex(source.bytes);
    results.push(result);
    if (!result.ok) failed += 1;
    if (onResult) onResult(result, results.length, entries.length);
  }

  return { results, failed, oversized };
}

/** 版本号从 package.json 读，避免两处各写一份。 */
export function readVersion({ cwd = process.cwd() } = {}) {
  try {
    const raw = fs.readFileSync(path.join(cwd, 'package.json'), 'utf8');
    return JSON.parse(raw).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** 主入口。返回退出码，由调用方 `process.exit`，便于测试断言。 */
export async function main(argv = process.argv.slice(2), io = {}) {
  const stderr = io.stderr || ((text) => process.stderr.write(`${text}\n`));
  const stdout = io.stdout || ((text) => process.stdout.write(`${text}\n`));
  const env = io.env || process.env;

  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    stderr(parsed.error);
    stderr('用 --help 查看用法。');
    return EXIT_USAGE;
  }

  const { command, paths, flags } = parsed;

  if (flags.help || command === 'help') {
    stdout(HELP_TEXT);
    return EXIT_OK;
  }
  if (flags.version) {
    stdout(readVersion(io));
    return EXIT_OK;
  }

  if (command !== 'upload') {
    stderr(command ? `未知命令：${command}` : '缺少命令。');
    stderr('目前只支持：upload <路径...>。用 --help 查看用法。');
    return EXIT_USAGE;
  }
  if (paths.length === 0) {
    stderr('没有指定要上传的文件。用法：kvault-upload upload <路径...>');
    return EXIT_USAGE;
  }

  const options = resolveOptions(flags, env);
  const validation = validateOptions(options);
  if (!validation.ok) {
    stderr(validation.error);
    return EXIT_USAGE;
  }

  const expanded = expandInputs(paths, io.expandOptions || {});
  if (!expanded.ok) {
    stderr(expanded.error);
    return EXIT_USAGE;
  }
  if (expanded.missing?.length) {
    // 部分命中：警告但不中断，剩余文件照传。
    stderr(`⚠ 跳过不存在的路径：${expanded.missing.join(', ')}`);
  }
  if (expanded.files.length === 0) {
    stderr('没有可上传的文件。');
    return EXIT_USAGE;
  }

  if (!options.quiet && !options.json && expanded.files.length > 1) {
    stderr(`准备上传 ${expanded.files.length} 个文件…`);
  }

  const { results, failed, oversized } = await runUpload(expanded.files, options, {
    fetchImpl: io.fetchImpl || globalThis.fetch,
    onResult: (result, index, total) => {
      const text = renderResult(result, options);
      if (text) stdout(text);
      if (!options.quiet && !options.json && total > 1 && index < total) {
        // 多文件之间留空行，人看着不挤。最后一条不补，避免输出尾部空行。
        stdout('');
      }
    },
  });

  if (!options.quiet && !options.json && results.length > 1) {
    const parts = [`成功 ${results.length - failed - oversized}`];
    if (failed > 0) parts.push(`失败 ${failed}`);
    if (oversized > 0) parts.push(`超限跳过 ${oversized}`);
    stderr(`完成：${parts.join(' / ')}（共 ${results.length}）。`);
  }

  // 用法问题优先：只要有一个文件是被本地预检拦下的，就按「参数错」报，
  // 因为它需要的是换一条上传通道，而不是重试。
  if (oversized > 0) return EXIT_USAGE;
  return failed > 0 ? EXIT_UPLOAD_FAILED : EXIT_OK;
}

// 仅在被直接执行时跑 main —— 被 import（测试）时不产生副作用。
const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`未预期的错误：${error?.stack || error}\n`);
      process.exit(EXIT_UPLOAD_FAILED);
    },
  );
}
