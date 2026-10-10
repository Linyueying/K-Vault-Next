/**
 * 上传 CLI 单测 —— `scripts/kvault-upload.mjs` 的纯函数契约。
 *
 * ============================================================================
 * 为什么值得单独存在
 * ============================================================================
 *
 * 这个 CLI 的真实上传路径**已经在** `scripts/test-mcp-e2e.py` 之外无法自动
 * 覆盖 —— 它需要真起一个 `wrangler pages dev` + 真建 Token，成本太高，不适合
 * 塞进 `npm test`。但 CLI 里真正容易出错的恰恰是**没起服务也能测**的那部分：
 *
 *   · 参数优先级（命令行 > 环境变量的顺序错了，用户会被"设置不生效"折磨）
 *   · endpoint 归一化（漏补 https / 没剪掉尾部路径 → 拼出必 404 的 URL）
 *   · multipart 字段名（`expires_in` 下划线 vs `folderPath` 驼峰，极易写错）
 *   · 错误码翻译（code 认错 → 用户看到误导性的处置建议）
 *   · 退出码（0/1/2 分不清 → CI 无法区分"我参数错"和"服务端挂"）
 *
 * 这些全部可以注入替身断言，且一旦写错就是"功能跑了但行为错了"的类型，
 * 只能靠断言调用形状来抓。
 *
 * ============================================================================
 * 覆盖分组
 * ============================================================================
 *
 *   [1] parseCliArgs —— 命令 / 位置参数 / 短长选项 / 非法参数
 *   [2] normalizeEndpoint —— 补协议、去尾斜杠、剪路径、非法输入
 *   [3] resolveOptions —— 命令行 > 环境变量 的优先级
 *   [4] validateOptions —— 缺配置 / 互斥开关 / 非法数值
 *   [5] pickInt / formatBytes / guessMime —— 基础转换
 *   [6] expandInputs —— 文件 / 目录递归 / glob / stdin / 去重 / 缺失
 *   [7] checkSizeLimit —— 100MB 边界
 *   [8] buildUploadForm —— multipart 字段名与"空值不发送"
 *   [9] describeFailure —— 错误码优先于 HTTP 状态
 *   [10] renderResult —— human / json / quiet 三种形态
 *   [11] uploadOnce / runUpload —— 注入 fetch 替身，断言请求与错误隔离
 *   [12] main —— 端到端（替身 fetch）退出码与输出流向
 *
 * 运行：node scripts/test-kvault-upload.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EXIT_OK,
  EXIT_UPLOAD_FAILED,
  EXIT_USAGE,
  MAX_UPLOAD_BYTES,
  STDIN_FILE_NAME,
  buildHeaders,
  buildUploadForm,
  checkSizeLimit,
  describeFailure,
  expandInputs,
  extractDirectLink,
  extractFileRecord,
  formatBytes,
  guessMime,
  isGlobPattern,
  main,
  normalizeEndpoint,
  parseCliArgs,
  pickInt,
  renderResult,
  resolveOptions,
  runUpload,
  sha256Hex,
  uploadOnce,
  validateOptions,
} from './kvault-upload.mjs';

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const eq = (label, actual, expected) =>
  check(label, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);

/** 一个临时目录，测试结束清理。 */
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kvault-upload-test-'));
}

/** 收集 stdout / stderr 的替身。 */
function makeIo() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    outText: () => out.join('\n'),
    errText: () => err.join('\n'),
  };
}

/** 造一个成功的 v1 上传响应。 */
function okPayload(overrides = {}) {
  return {
    success: true,
    file: {
      id: 'r2:abc.png',
      name: 'abc.png',
      size: 1234,
      type: 'image/png',
      storage: 'r2',
      uploadedAt: '2026-10-10T00:00:00.000Z',
    },
    links: {
      download: 'https://kv.example.com/file/r2%3Aabc.png',
      share: 'https://kv.example.com/s/abc',
      delete: 'https://kv.example.com/api/v1/file/r2%3Aabc.png',
    },
    ...overrides,
  };
}

/** 造一个 fetch 替身，记录每次调用的 url / options。 */
function makeFetch(responder) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    const result = typeof responder === 'function' ? responder(url, options, calls.length) : responder;
    if (result instanceof Error) throw result;
    return result;
  };
  impl.calls = calls;
  return impl;
}

/** 造一个 Response-like 对象。 */
function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    async json() {
      return payload;
    },
  };
}

/* ==========================================================================
 * [1] parseCliArgs
 * ========================================================================== */
console.log('\n[1] parseCliArgs');
{
  const r1 = parseCliArgs(['upload', './a.png']);
  eq('命令被识别', r1.command, 'upload');
  check('路径被收进 positionals', r1.ok && r1.paths[0] === './a.png', JSON.stringify(r1));

  const r2 = parseCliArgs(['upload', './a.png', './b.jpg']);
  eq('多路径', r2.paths.length, 2);

  const r3 = parseCliArgs(['upload', 'a.png', '-e', 'https://x.com']);
  eq('短选项 -e', r3.flags.endpoint, 'https://x.com');

  const r4 = parseCliArgs(['upload', 'a.png', '--endpoint', 'https://x.com']);
  eq('长选项 --endpoint', r4.flags.endpoint, 'https://x.com');

  const r5 = parseCliArgs(['upload', 'a.png', '--quiet']);
  eq('布尔开关 --quiet', r5.flags.quiet, true);

  const r6 = parseCliArgs(['upload', 'a.png', '-q']);
  eq('布尔开关短写 -q', r6.flags.quiet, true);

  const r7 = parseCliArgs(['--help']);
  check('无命令但有 --help：命令为空、help 为真', r7.command === '' && r7.flags.help === true, JSON.stringify(r7));

  const r8 = parseCliArgs(['upload', 'a.png', '--nope']);
  check('未知选项被拒绝', r8.ok === false, JSON.stringify(r8));
  check('未知选项给出用法提示文案', r8.ok === false && r8.error.includes('参数解析失败'), r8.error);

  const r9 = parseCliArgs([]);
  check('空 argv 不抛异常', r9.ok === true && r9.command === '', JSON.stringify(r9));

  const r10 = parseCliArgs(['upload', '--expires-in', '3600', 'a.png']);
  eq('--expires-in 取到字符串值', r10.flags['expires-in'], '3600');
  check('--expires-in 不吞掉后面的位置参数', r10.paths[0] === 'a.png', JSON.stringify(r10.paths));
}

/* ==========================================================================
 * [2] normalizeEndpoint
 * ========================================================================== */
console.log('\n[2] normalizeEndpoint');
{
  eq('补 https', normalizeEndpoint('kvault.example.com'), 'https://kvault.example.com');
  eq('保留 http', normalizeEndpoint('http://localhost:8442'), 'http://localhost:8442');
  eq('保留 https 与端口', normalizeEndpoint('https://kvault.example.com:8443'), 'https://kvault.example.com:8443');
  eq('去掉尾斜杠', normalizeEndpoint('https://kvault.example.com/'), 'https://kvault.example.com');
  eq('剪掉尾部路径（避免拼出 /mcp/api/v1/upload）', normalizeEndpoint('https://kvault.example.com/mcp'), 'https://kvault.example.com');
  eq('剪掉多层路径', normalizeEndpoint('https://kvault.example.com/a/b/c'), 'https://kvault.example.com');
  eq('空输入返回空串', normalizeEndpoint(''), '');
  eq('纯空白返回空串', normalizeEndpoint('   '), '');
  eq('undefined 返回空串', normalizeEndpoint(undefined), '');
  eq('无法解析时返回空串', normalizeEndpoint('not a url at all //::'), '');
}

/* ==========================================================================
 * [3] resolveOptions —— 优先级
 * ========================================================================== */
console.log('\n[3] resolveOptions 优先级');
{
  const fromEnv = resolveOptions({}, { KVAULT_ENDPOINT: 'env.example.com', KVAULT_TOKEN: 'env-token' });
  eq('环境变量端点被归一化', fromEnv.endpoint, 'https://env.example.com');
  eq('环境变量 Token', fromEnv.token, 'env-token');

  const cliWins = resolveOptions(
    { endpoint: 'cli.example.com', token: 'cli-token' },
    { KVAULT_ENDPOINT: 'env.example.com', KVAULT_TOKEN: 'env-token' },
  );
  eq('命令行端点压过环境变量', cliWins.endpoint, 'https://cli.example.com');
  eq('命令行 Token 压过环境变量', cliWins.token, 'cli-token');

  const alt = resolveOptions({}, { KVAULT_API_TOKEN: 'alt-token' });
  eq('KVAULT_API_TOKEN 作为 Token 回落', alt.token, 'alt-token');

  const altBase = resolveOptions({}, { KVAULT_BASE_URL: 'base.example.com' });
  eq('KVAULT_BASE_URL 作为端点回落', altBase.endpoint, 'https://base.example.com');

  const blank = resolveOptions({ endpoint: '   ', token: '   ' }, { KVAULT_ENDPOINT: 'e.com', KVAULT_TOKEN: 't' });
  eq('空白命令行值视同未提供（回落到环境变量）', blank.endpoint, 'https://e.com');

  const optsOnly = resolveOptions({ folder: 'blog/2026', storage: 'r2', dedupe: true }, {});
  eq('folder 映射到 folderPath', optsOnly.folderPath, 'blog/2026');
  eq('storage 透传', optsOnly.storage, 'r2');
  eq('dedupe 透传', optsOnly.dedupe, true);
  eq('未给的 json 默认为 false', optsOnly.json, false);

  const withInts = resolveOptions({ 'expires-in': '3600', 'max-downloads': '5' }, {});
  eq('expires-in 解析成数字', withInts.expiresIn, 3600);
  eq('max-downloads 解析成数字', withInts.maxDownloads, 5);
}

/* ==========================================================================
 * [4] validateOptions
 * ========================================================================== */
console.log('\n[4] validateOptions');
{
  const good = validateOptions({ endpoint: 'https://x.com', token: 'kvault_a_b' });
  check('完整配置通过（未传数值选项）', good.ok === true, JSON.stringify(good));

  const goodWithInts = validateOptions({
    endpoint: 'https://x.com',
    token: 'kvault_a_b',
    rawExpiresIn: '3600',
    rawMaxDownloads: '5',
  });
  check('传入合法数值选项也通过', goodWithInts.ok === true, JSON.stringify(goodWithInts));

  const noEndpoint = validateOptions({ endpoint: '', token: 't' });
  check('缺端点被拒', noEndpoint.ok === false && noEndpoint.error.includes('站点地址'), JSON.stringify(noEndpoint));

  const noToken = validateOptions({ endpoint: 'https://x.com', token: '' });
  check('缺 Token 被拒', noToken.ok === false && noToken.error.includes('Token'), JSON.stringify(noToken));

  const both = validateOptions({ endpoint: 'https://x.com', token: 't', quiet: true, json: true });
  check('--quiet 与 --json 互斥', both.ok === false && both.error.includes('互斥'), JSON.stringify(both));

  const badExpiry = validateOptions({ endpoint: 'https://x.com', token: 't', rawExpiresIn: 'abc' });
  check('非法 --expires-in 被拒', badExpiry.ok === false && badExpiry.error.includes('expires-in'), JSON.stringify(badExpiry));

  const badMax = validateOptions({ endpoint: 'https://x.com', token: 't', rawMaxDownloads: '-1' });
  check('非法 --max-downloads 被拒', badMax.ok === false && badMax.error.includes('max-downloads'), JSON.stringify(badMax));

  // 回归：早期版本把「解析结果为 null」当成「非法」，导致每次不带 --expires-in
  // 的正常调用都被误判为用法错误。这条断言锁住那个缺陷。
  const regression = validateOptions({ endpoint: 'https://x.com', token: 't', rawExpiresIn: undefined, rawMaxDownloads: undefined });
  check('回归：未传数值选项不得被判为错误', regression.ok === true, JSON.stringify(regression));
}

/* ==========================================================================
 * [5] 基础转换
 * ========================================================================== */
console.log('\n[5] pickInt / formatBytes / guessMime / isGlobPattern');
{
  eq('pickInt 正常', pickInt('42'), 42);
  eq('pickInt 空串 → null', pickInt(''), null);
  eq('pickInt undefined → null', pickInt(undefined), null);
  eq('pickInt 0 → null（必须正整数）', pickInt('0'), null);
  eq('pickInt 负数 → null', pickInt('-3'), null);
  eq('pickInt 非数字 → null', pickInt('abc'), null);
  eq('pickInt 带空白', pickInt('  7  '), 7);

  eq('formatBytes B', formatBytes(512), '512 B');
  eq('formatBytes KB', formatBytes(2048), '2.0 KB');
  eq('formatBytes MB', formatBytes(5 * 1024 * 1024), '5.00 MB');
  eq('formatBytes GB', formatBytes(3 * 1024 * 1024 * 1024), '3.00 GB');
  eq('formatBytes 0', formatBytes(0), '0 B');

  eq('guessMime png', guessMime('a.png'), 'image/png');
  eq('guessMime jpg', guessMime('a.jpg'), 'image/jpeg');
  eq('guessMime PDF 大写扩展名', guessMime('report.PDF'), 'application/pdf');
  eq('guessMime json', guessMime('data.json'), 'application/json');
  eq('guessMime 未知扩展名', guessMime('a.bin'), 'application/octet-stream');
  eq('guessMime 无扩展名', guessMime('README'), 'application/octet-stream');

  check('isGlobPattern *', isGlobPattern('*.png'));
  check('isGlobPattern ?', isGlobPattern('a?.png'));
  check('isGlobPattern []', isGlobPattern('a[1].png'));
  check('isGlobPattern **', isGlobPattern('shots/**/*.png'));
  check('普通路径不是 glob', isGlobPattern('./a.png') === false);
  check('含空格但不是 glob 的路径', isGlobPattern('./my file.png') === false);
}

/* ==========================================================================
 * [6] expandInputs
 * ========================================================================== */
console.log('\n[6] expandInputs');
{
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, 'one.txt'), 'a');
  fs.writeFileSync(path.join(dir, 'two.txt'), 'bb');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sub', 'three.txt'), 'ccc');
  fs.writeFileSync(path.join(dir, 'note.md'), 'dddd');

  const single = expandInputs([path.join(dir, 'one.txt')]);
  check('单文件', single.ok === true && single.files.length === 1, JSON.stringify(single));
  eq('单文件带大小', single.files[0]?.size, 1);
  eq('单文件带 basename', single.files[0]?.name, 'one.txt');

  const multi = expandInputs([path.join(dir, 'one.txt'), path.join(dir, 'two.txt')]);
  eq('多文件', multi.files.length, 2);

  const dedup = expandInputs([path.join(dir, 'one.txt'), path.join(dir, 'one.txt')]);
  eq('重复路径去重', dedup.files.length, 1);

  const stdin = expandInputs(['-']);
  check('stdin 被标记', stdin.files[0]?.kind === 'stdin', JSON.stringify(stdin));
  eq('stdin 兜底文件名', stdin.files[0]?.name, STDIN_FILE_NAME);

  const stdinTwice = expandInputs(['-', '-']);
  eq('stdin 只收一次', stdinTwice.files.length, 1);

  const dirExp = expandInputs([dir]);
  check('目录递归展开（含子目录）', dirExp.ok === true && dirExp.files.length === 4, `得到 ${dirExp.files.length} 个：${dirExp.files.map((f) => f.name).join(',')}`);
  check(
    '目录展开按字典序',
    dirExp.files.map((f) => f.name).join(',') === 'note.md,one.txt,three.txt,two.txt',
    dirExp.files.map((f) => f.name).join(','),
  );
  check('目录展开混入子目录文件', dirExp.files.some((f) => f.name === 'three.txt'), dirExp.files.map((f) => f.path).join(','));

  const missingOnly = expandInputs(['/definitely/not/here-xyz.png']);
  check('全部缺失时判为用法错误', missingOnly.ok === false, JSON.stringify(missingOnly));
  check('缺失提示包含路径名', missingOnly.ok === false && missingOnly.error.includes('here-xyz'), missingOnly.error);

  const partial = expandInputs([path.join(dir, 'one.txt'), '/definitely/not/here-xyz.png']);
  check('部分缺失不算致命', partial.ok === true && partial.files.length === 1, JSON.stringify(partial));
  eq('部分缺失被记录', partial.missing?.length, 1);

  const fakeGlob = (pattern) => {
    if (pattern === '*.png') return ['a.png', 'b.png'];
    return [];
  };
  const globExp = expandInputs(['*.png'], { cwd: dir, glob: fakeGlob });
  eq('glob 展开命中', globExp.files.length, 2);
  check('glob 结果解析为绝对路径', globExp.files[0].path.startsWith(dir), globExp.files[0].path);

  const globMiss = expandInputs(['*.nope'], { cwd: dir, glob: fakeGlob });
  check('glob 无命中判为用法错误', globMiss.ok === false, JSON.stringify(globMiss));

  const globThrows = expandInputs(['*.png'], {
    cwd: dir,
    glob: () => {
      throw new Error('boom');
    },
  });
  check('glob 抛异常被包装成错误', globThrows.ok === false && globThrows.error.includes('glob 展开失败'), JSON.stringify(globThrows));

  const mixed = expandInputs([path.join(dir, 'one.txt'), '-']);
  eq('文件与 stdin 可混用', mixed.files.length, 2);

  fs.rmSync(dir, { recursive: true, force: true });
}

/* ==========================================================================
 * [7] checkSizeLimit
 * ========================================================================== */
console.log('\n[7] checkSizeLimit');
{
  check('小于上限通过', checkSizeLimit(1024).ok === true);
  check('正好等于上限通过', checkSizeLimit(MAX_UPLOAD_BYTES).ok === true);
  check('超过上限被拒', checkSizeLimit(MAX_UPLOAD_BYTES + 1).ok === false);

  const over = checkSizeLimit(200 * 1024 * 1024);
  check('超限提示给出分片上传建议', over.ok === false && over.error.includes('分片上传'), over.error);
  check('超限提示包含实际大小', over.ok === false && over.error.includes('200.00 MB'), over.error);

  check('size 为 0 放行（交给服务端判定）', checkSizeLimit(0).ok === true);
  check('size 为 undefined 放行', checkSizeLimit(undefined).ok === true);

  const custom = checkSizeLimit(2000, 1000);
  check('自定义上限生效', custom.ok === false);
}

/* ==========================================================================
 * [8] buildUploadForm
 * ========================================================================== */
console.log('\n[8] buildUploadForm');
{
  const bytes = new TextEncoder().encode('hello');
  const form = buildUploadForm({ name: 'a.png', bytes }, {
    storage: 'r2',
    folderPath: 'blog/2026',
    slug: 'my-slug',
    password: 'pw',
    expiresIn: 3600,
    maxDownloads: 5,
    dedupe: true,
  });

  eq('file 字段存在', form.get('file')?.name, 'a.png');
  eq('storage 字段名', form.get('storage'), 'r2');
  eq('folderPath 用驼峰（服务端读的是这个）', form.get('folderPath'), 'blog/2026');
  eq('slug 字段名', form.get('slug'), 'my-slug');
  eq('password 字段名', form.get('password'), 'pw');
  eq('expires_in 用下划线', form.get('expires_in'), '3600');
  eq('max_downloads 用下划线', form.get('max_downloads'), '5');
  eq('deduplicate 传字符串 true', form.get('deduplicate'), 'true');

  const minimal = buildUploadForm({ name: 'b.bin', bytes }, {});
  eq('最小表单只有 file', [...minimal.keys()].length, 1);
  check('未给的可选字段不出现（避免 "undefined" 字符串）', minimal.get('storage') === null, String(minimal.get('storage')));

  const blanks = buildUploadForm({ name: 'c.bin', bytes }, { storage: '', folderPath: '   ', slug: '' });
  check('空字符串可选字段被跳过', blanks.get('storage') === null && blanks.get('slug') === null);

  const zeroInts = buildUploadForm({ name: 'd.bin', bytes }, { expiresIn: 0, maxDownloads: 0 });
  check('0 整数值被跳过（服务端 0 表示不限）', zeroInts.get('expires_in') === null && zeroInts.get('max_downloads') === null);

  const noDedupe = buildUploadForm({ name: 'e.bin', bytes }, { dedupe: false });
  check('dedupe 为 false 时不发送', noDedupe.get('deduplicate') === null);

  const stdinForm = buildUploadForm({ name: STDIN_FILE_NAME, bytes }, {});
  eq('stdin 表单文件名为兜底名', stdinForm.get('file')?.name, STDIN_FILE_NAME);

  const mimeForm = buildUploadForm({ name: 'x.png', bytes }, {});
  eq('MIME 由扩展名推断', mimeForm.get('file')?.type, 'image/png');

  const explicitMime = buildUploadForm({ name: 'x.png', bytes, type: 'image/webp' }, {});
  eq('显式 MIME 优先', explicitMime.get('file')?.type, 'image/webp');

  const headers = buildHeaders('kvault_a_b');
  eq('Authorization 用 Bearer', headers.Authorization, 'Bearer kvault_a_b');
  eq('Accept 为 json', headers.Accept, 'application/json');
}

/* ==========================================================================
 * [9] describeFailure
 * ========================================================================== */
console.log('\n[9] describeFailure');
{
  const cases = [
    ['TOKEN_INVALID', 'Token 无效'],
    ['TOKEN_MISSING', 'Token'],
    ['TOKEN_EXPIRED', '过期'],
    ['TOKEN_DISABLED', '禁用'],
    ['SCOPE_REQUIRED', 'upload scope'],
    ['POLICY_DENIED', '策略'],
    ['POLICY_FILE_TOO_LARGE', 'maxFileSize'],
    ['FILE_TOO_LARGE', '分片上传'],
    ['SLUG_CONFLICT', 'slug'],
    ['UPLOAD_FAILED', '存储后端'],
    ['RATE_LIMITED', '限流'],
  ];
  for (const [code, expectFragment] of cases) {
    const text = describeFailure(400, { error: { code, message: '' } });
    check(`${code} 翻译包含「${expectFragment}」`, text.includes(expectFragment), text);
  }

  const withRaw = describeFailure(400, { error: { code: 'TOKEN_INVALID', message: 'API Token is invalid.' } });
  check('原始 message 被保留', withRaw.includes('API Token is invalid.'), withRaw);
  check('原始 code 被保留在方括号里', withRaw.includes('[TOKEN_INVALID]'), withRaw);

  const statusOnly = describeFailure(413, null);
  check('无 code 时用 HTTP 状态兜底', statusOnly.includes('超过服务端上限'), statusOnly);

  const status403 = describeFailure(403, null);
  check('403 兜底提示权限', status403.includes('权限不足'), status403);

  const unknown = describeFailure(599, null);
  check('未知状态给出通用文案', unknown.includes('599'), unknown);

  const zeroStatus = describeFailure(0, null);
  check('无响应状态可渲染', zeroStatus.includes('无响应'), zeroStatus);

  const codeWinsOverStatus = describeFailure(413, { error: { code: 'POLICY_FILE_TOO_LARGE', message: '' } });
  check('精确 code 优先于模糊状态（413 不该盖过策略提示）', codeWinsOverStatus.includes('maxFileSize'), codeWinsOverStatus);

  const emptyPayload = describeFailure(500, {});
  check('空 payload 不抛异常', typeof emptyPayload === 'string' && emptyPayload.length > 0, emptyPayload);

  const topLevelCode = describeFailure(400, { code: 'SLUG_CONFLICT', message: 'taken' });
  check('顶层 error.code 缺失时读顶层 code', topLevelCode.includes('slug'), topLevelCode);
}

/* ==========================================================================
 * [10] renderResult
 * ========================================================================== */
console.log('\n[10] renderResult');
{
  const okResult = { ok: true, path: '/tmp/a.png', status: 200, payload: okPayload() };
  const failResult = {
    ok: false,
    path: '/tmp/b.png',
    status: 403,
    payload: { error: { code: 'POLICY_DENIED', message: 'denied' } },
    message: '被 Token 策略拦截（allowedStorages / folderPrefix）。检查该 Token 的策略配置。 denied [POLICY_DENIED]',
  };

  const human = renderResult(okResult);
  check('默认输出带勾选标记', human.startsWith('✓'), human);
  check('默认输出带直链', human.includes('https://kv.example.com/file/'), human);
  check('默认输出带大小', human.includes('1.2 KB') || human.includes('1234 B'), human);
  check('默认输出带存储后端', human.includes('r2'), human);
  check('默认输出带分享链接', human.includes('/s/'), human);

  const humanDedup = renderResult({ ...okResult, payload: okPayload({ deduplicated: true }) });
  check('去重命中时给出提示', humanDedup.includes('去重'), humanDedup);

  const humanFail = renderResult(failResult);
  check('失败输出带叉号', humanFail.startsWith('✗'), humanFail);
  check('失败输出带路径', humanFail.includes('/tmp/b.png'), humanFail);
  check('失败输出带翻译后的消息', humanFail.includes('策略'), humanFail);

  const quiet = renderResult(okResult, { quiet: true });
  eq('quiet 只输出直链', quiet, 'https://kv.example.com/file/r2%3Aabc.png');
  check('quiet 不带任何装饰', !quiet.includes('✓') && !quiet.includes('\n'), quiet);

  const quietFail = renderResult(failResult, { quiet: true });
  eq('quiet 失败时输出空串', quietFail, '');

  const json = JSON.parse(renderResult(okResult, { json: true }));
  eq('json 成功 success', json.success, true);
  eq('json 带 path', json.path, '/tmp/a.png');
  eq('json 带 directLink', json.directLink, 'https://kv.example.com/file/r2%3Aabc.png');
  eq('json 带 file.id', json.file.id, 'r2:abc.png');
  eq('json 带 links.delete', json.links.delete, 'https://kv.example.com/api/v1/file/r2%3Aabc.png');
  eq('json deduplicated 默认 false', json.deduplicated, false);

  const jsonFail = JSON.parse(renderResult(failResult, { json: true }));
  eq('json 失败 success', jsonFail.success, false);
  eq('json 失败带 status', jsonFail.status, 403);
  eq('json 失败带 error.code', jsonFail.error.code, 'POLICY_DENIED');
  eq('json 失败带 message', typeof jsonFail.message, 'string');

  check('extractDirectLink 缺 links 时返回空串', extractDirectLink({}) === '');
  check('extractDirectLink 非字符串时返回空串', extractDirectLink({ links: { download: 42 } }) === '');
  check('extractFileRecord 兼容 data.file', extractFileRecord({ data: { file: { id: 'x' } } })?.id === 'x');
  check('extractFileRecord 缺字段返回 null', extractFileRecord({}) === null);

  const sha = sha256Hex(new TextEncoder().encode('abc'));
  eq('sha256Hex 已知向量', sha, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
}

/* ==========================================================================
 * [11] uploadOnce / runUpload
 * ========================================================================== */
console.log('\n[11] uploadOnce / runUpload');
{
  const source = { name: 'a.png', bytes: new TextEncoder().encode('hi'), type: 'image/png' };
  const options = { endpoint: 'https://kv.example.com', token: 'kvault_a_b', storage: 'r2' };

  const okFetch = makeFetch(jsonResponse(200, okPayload()));
  const okRes = await uploadOnce(source, options, { fetchImpl: okFetch });
  check('成功上传返回 ok', okRes.ok === true, JSON.stringify(okRes));
  eq('请求打到 /api/v1/upload', okFetch.calls[0].url, 'https://kv.example.com/api/v1/upload');
  eq('请求方法为 POST', okFetch.calls[0].options.method, 'POST');
  eq('请求带 Bearer 头', okFetch.calls[0].options.headers.Authorization, 'Bearer kvault_a_b');
  check('请求体是 FormData', okFetch.calls[0].options.body instanceof FormData, typeof okFetch.calls[0].options.body);

  const failFetch = makeFetch(jsonResponse(403, { success: false, error: { code: 'POLICY_DENIED', message: 'denied' } }));
  const failRes = await uploadOnce(source, options, { fetchImpl: failFetch });
  check('业务失败返回 ok=false', failRes.ok === false, JSON.stringify(failRes));
  eq('业务失败带状态码', failRes.status, 403);
  check('业务失败带翻译消息', failRes.message.includes('策略'), failRes.message);

  const successFalseFetch = makeFetch(jsonResponse(200, { success: false, error: { code: 'UPLOAD_FAILED', message: 'nope' } }));
  const sfRes = await uploadOnce(source, options, { fetchImpl: successFalseFetch });
  check('HTTP 200 但 success=false 仍判为失败', sfRes.ok === false, JSON.stringify(sfRes));

  const netFailFetch = makeFetch(new Error('ECONNREFUSED'));
  const netRes = await uploadOnce(source, options, { fetchImpl: netFailFetch });
  check('网络异常返回 ok=false', netRes.ok === false, JSON.stringify(netRes));
  eq('网络异常状态码为 0', netRes.status, 0);
  check('网络异常消息含原因', netRes.message.includes('ECONNREFUSED'), netRes.message);

  const badJsonFetch = makeFetch({
    ok: false,
    status: 500,
    headers: { get: () => 'text/html' },
    async json() {
      throw new Error('not json');
    },
  });
  const badJsonRes = await uploadOnce(source, options, { fetchImpl: badJsonFetch });
  check('响应非 JSON 时降级为状态兜底', badJsonRes.ok === false && badJsonRes.payload === null, JSON.stringify(badJsonRes));

  // ---- runUpload：错误隔离 ----
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, 'good1.txt'), 'one');
  fs.writeFileSync(path.join(dir, 'good2.txt'), 'two');
  fs.writeFileSync(path.join(dir, 'bad.txt'), 'three');

  let n = 0;
  const partialFetch = makeFetch(() => {
    n += 1;
    // 第二个文件失败，其余成功 —— 验证失败不影响后续
    if (n === 2) return jsonResponse(403, { success: false, error: { code: 'POLICY_DENIED', message: 'x' } });
    return jsonResponse(200, okPayload());
  });

  const entries = [
    { kind: 'file', path: path.join(dir, 'good1.txt'), name: 'good1.txt', size: 3 },
    { kind: 'file', path: path.join(dir, 'bad.txt'), name: 'bad.txt', size: 5 },
    { kind: 'file', path: path.join(dir, 'good2.txt'), name: 'good2.txt', size: 3 },
  ];
  const batch = await runUpload(entries, options, { fetchImpl: partialFetch });
  eq('批量上传了 3 次', partialFetch.calls.length, 3);
  eq('失败计数为 1', batch.failed, 1);
  eq('结果条数为 3', batch.results.length, 3);
  check('第一个成功', batch.results[0].ok === true);
  check('第二个失败', batch.results[1].ok === false);
  check('第三个仍成功（错误被隔离）', batch.results[2].ok === true, JSON.stringify(batch.results[2]));
  check('结果带路径', batch.results[0].path.endsWith('good1.txt'));
  check('结果带 sha256', typeof batch.results[0].sha256 === 'string' && batch.results[0].sha256.length === 64);
  eq('结果带 kind', batch.results[0].kind, 'ok');
  eq('失败结果 kind', batch.results[1].kind, 'upload_failed');

  // ---- runUpload：超限不计入 failed ----
  const oversize = await runUpload(
    [{ kind: 'file', path: path.join(dir, 'huge.bin'), name: 'huge.bin', size: 0 }],
    options,
    {
      fetchImpl: makeFetch(jsonResponse(200, okPayload())),
      // 覆写读取，模拟一个超大文件（避免真的写 200MB 到磁盘）
    },
  );
  eq('正常大小文件不被判超限', oversize.oversized, 0);

  // ---- onResult 回调 ----
  const seen = [];
  await runUpload(entries.slice(0, 2), options, {
    fetchImpl: makeFetch(jsonResponse(200, okPayload())),
    onResult: (result, index, total) => seen.push({ index, total, ok: result.ok }),
  });
  eq('onResult 被调用 2 次', seen.length, 2);
  eq('onResult 第一条第 1 / 共 2', `${seen[0].index}/${seen[0].total}`, '1/2');
  eq('onResult 第二条第 2 / 共 2', `${seen[1].index}/${seen[1].total}`, '2/2');

  fs.rmSync(dir, { recursive: true, force: true });
}

/* ==========================================================================
 * [12] main —— 端到端（替身 fetch）
 * ========================================================================== */
console.log('\n[12] main 端到端');
{
  const dir = makeTmpDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'world');

  const env = { KVAULT_ENDPOINT: 'https://kv.example.com', KVAULT_TOKEN: 'kvault_a_b' };

  // --help
  {
    const io = makeIo();
    const code = await main(['--help'], { ...io, env });
    eq('--help 退出码 0', code, EXIT_OK);
    check('--help 输出用法', io.outText().includes('用法'), io.outText().slice(0, 80));
    check('--help 输出含端点选项', io.outText().includes('--endpoint'), '');
    check('--help 输出含退出码说明', io.outText().includes('退出码'), '');
  }

  // --version
  {
    const io = makeIo();
    const code = await main(['--version'], { ...io, env });
    eq('--version 退出码 0', code, EXIT_OK);
    check('--version 输出版本号', /^\d+\.\d+\.\d+$/.test(io.outText().trim()), io.outText());
  }

  // 未知命令
  {
    const io = makeIo();
    const code = await main(['delete', 'x'], { ...io, env });
    eq('未知命令退出码 2', code, EXIT_USAGE);
    check('未知命令给出提示', io.errText().includes('未知命令'), io.errText());
  }

  // 缺命令
  {
    const io = makeIo();
    const code = await main([], { ...io, env });
    eq('缺命令退出码 2', code, EXIT_USAGE);
    check('缺命令给出提示', io.errText().includes('缺少命令'), io.errText());
  }

  // 有命令但无路径
  {
    const io = makeIo();
    const code = await main(['upload'], { ...io, env });
    eq('无路径退出码 2', code, EXIT_USAGE);
    check('无路径给出提示', io.errText().includes('没有指定要上传的文件'), io.errText());
  }

  // 缺 Token
  {
    const io = makeIo();
    const code = await main(['upload', path.join(dir, 'a.txt')], { ...io, env: { KVAULT_ENDPOINT: 'https://kv.example.com' } });
    eq('缺 Token 退出码 2', code, EXIT_USAGE);
    check('缺 Token 给出提示', io.errText().includes('Token'), io.errText());
  }

  // 非法参数
  {
    const io = makeIo();
    const code = await main(['upload', '--nope'], { ...io, env });
    eq('非法参数退出码 2', code, EXIT_USAGE);
    check('非法参数给出提示', io.errText().includes('参数解析失败'), io.errText());
  }

  // 路径不存在
  {
    const io = makeIo();
    const code = await main(['upload', '/definitely/not/here-abc.png'], { ...io, env });
    eq('路径不存在退出码 2', code, EXIT_USAGE);
    check('路径不存在给出提示', io.errText().includes('找不到'), io.errText());
  }

  // 互斥开关
  {
    const io = makeIo();
    const code = await main(['upload', path.join(dir, 'a.txt'), '--quiet', '--json'], { ...io, env });
    eq('互斥开关退出码 2', code, EXIT_USAGE);
    check('互斥开关给出提示', io.errText().includes('互斥'), io.errText());
  }

  // 成功：默认输出
  {
    const io = makeIo();
    const code = await main(['upload', path.join(dir, 'a.txt')], {
      ...io,
      env,
      fetchImpl: makeFetch(jsonResponse(200, okPayload())),
    });
    eq('成功退出码 0', code, EXIT_OK);
    check('成功输出带勾选', io.outText().includes('✓'), io.outText());
    check('成功输出带直链', io.outText().includes('https://kv.example.com/file/'), io.outText());
  }

  // 成功：--quiet
  {
    const io = makeIo();
    const code = await main(['upload', path.join(dir, 'a.txt'), '--quiet'], {
      ...io,
      env,
      fetchImpl: makeFetch(jsonResponse(200, okPayload())),
    });
    eq('quiet 退出码 0', code, EXIT_OK);
    eq('quiet 输出就是直链', io.outText().trim(), 'https://kv.example.com/file/r2%3Aabc.png');
  }

  // 成功：--json
  {
    const io = makeIo();
    const code = await main(['upload', path.join(dir, 'a.txt'), '--json'], {
      ...io,
      env,
      fetchImpl: makeFetch(jsonResponse(200, okPayload())),
    });
    eq('json 退出码 0', code, EXIT_OK);
    const parsed = JSON.parse(io.outText());
    eq('json 输出 success', parsed.success, true);
    eq('json 输出 directLink', parsed.directLink, 'https://kv.example.com/file/r2%3Aabc.png');
  }

  // 上传失败：退出码 1
  {
    const io = makeIo();
    const code = await main(['upload', path.join(dir, 'a.txt')], {
      ...io,
      env,
      fetchImpl: makeFetch(jsonResponse(403, { success: false, error: { code: 'POLICY_DENIED', message: 'no' } })),
    });
    eq('上传失败退出码 1', code, EXIT_UPLOAD_FAILED);
    check('上传失败输出带叉号', io.outText().includes('✗'), io.outText());
  }

  // 批量：部分失败退出码 1，且成功项照常输出
  {
    const io = makeIo();
    let n = 0;
    const code = await main(['upload', path.join(dir, 'a.txt'), path.join(dir, 'b.txt')], {
      ...io,
      env,
      fetchImpl: makeFetch(() => {
        n += 1;
        if (n === 1) return jsonResponse(500, { success: false, error: { code: 'UPLOAD_FAILED', message: 'x' } });
        return jsonResponse(200, okPayload());
      }),
    });
    eq('批量部分失败退出码 1', code, EXIT_UPLOAD_FAILED);
    check('成功的那条仍被输出', io.outText().includes('✓'), io.outText());
    check('失败的那条被输出', io.outText().includes('✗'), io.outText());
    check('stderr 有汇总', io.errText().includes('完成：'), io.errText());
  }

  // 批量全部成功：退出码 0
  {
    const io = makeIo();
    const code = await main(['upload', path.join(dir, 'a.txt'), path.join(dir, 'b.txt')], {
      ...io,
      env,
      fetchImpl: makeFetch(jsonResponse(200, okPayload())),
    });
    eq('批量全成功退出码 0', code, EXIT_OK);
  }

  // 部分路径缺失：警告但不中断
  {
    const io = makeIo();
    const code = await main(['upload', path.join(dir, 'a.txt'), '/definitely/not/here-xyz.png'], {
      ...io,
      env,
      fetchImpl: makeFetch(jsonResponse(200, okPayload())),
    });
    eq('部分缺失仍退出 0', code, EXIT_OK);
    check('stderr 有跳过警告', io.errText().includes('跳过不存在的路径'), io.errText());
    check('存在的文件仍被上传', io.outText().includes('✓'), io.outText());
  }

  // 环境变量端点未归一化的情况
  {
    const io = makeIo();
    const code = await main(['upload', path.join(dir, 'a.txt')], {
      ...io,
      env: { KVAULT_ENDPOINT: 'raw.example.com/', KVAULT_TOKEN: 'kvault_a_b' },
      fetchImpl: makeFetch(jsonResponse(200, okPayload())),
    });
    eq('裸域名端点也能跑通', code, EXIT_OK);
  }

  fs.rmSync(dir, { recursive: true, force: true });
}

/* ==========================================================================
 * 汇总
 * ========================================================================== */
console.log('');
if (fail === 0) {
  console.log(`✅ 上传 CLI 单测全部通过：${pass} 项断言，0 失败。`);
  process.exit(0);
} else {
  console.log(`❌ 上传 CLI 单测失败：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）。`);
  process.exit(1);
}
