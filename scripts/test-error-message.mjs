/**
 * 共享层 `KVault.errorMessage` 的契约测试。
 *
 * ============================================================================
 * 为什么值得单独测
 * ============================================================================
 *
 * 线上真实症状：后台点「保存修改」弹出 **「提交失败：[object Object]」**。
 *
 * 因为服务端的失败形状是 `{success:false, error:{code, message}}` —— `error`
 * 是**对象**。写成 `new Error(data.error)` 时，`String(obj)` 立刻把它变成
 * "[object Object]"，真实原因（比如"短链已被占用"）被抹掉，而且对象一旦
 * 进了 Error 就再也拿不回来。用户只能看到一句无信息量的提示，完全无从下手。
 *
 * 这个 bug 曾经散落在 38 处（admin.html 33 + paste.html 4 + app-core.js 1），
 * 所以修法是集中到 `KVault.errorMessage`，由调用方传入整个 payload。
 *
 * 本套件把「绝不能出现 [object Object]」变成一条断言，防止以后有人又写成
 * `new Error(xxx.error)`。
 *
 * 运行：node scripts/test-error-message.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

// app-core.js 是 IIFE，只依赖 window；用最小替身把它求值出来，
// 就能在 node 里直接测共享层（无需浏览器、无需构建）。
globalThis.window = { addEventListener() {}, matchMedia: () => ({ matches: false }) };
globalThis.document = undefined;
const coreSrc = fs.readFileSync(path.join(import.meta.dirname, '../assets/js/app-core.js'), 'utf8');
new Function(coreSrc)();
const { errorMessage } = globalThis.window.KVault;

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const eq = (label, actual, expected) =>
  check(label, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);

console.log('\n[1] 服务端真实失败形状');
{
  // 这就是 apiError() 实际返回的形状
  const payload = { success: false, error: { code: 'TOKEN_NOT_FOUND', message: 'API Token not found.' } };
  eq('取出 error.message', errorMessage(payload, '兜底'), 'API Token not found.');
  check('★ 结果不含 [object Object]', !errorMessage(payload, '兜底').includes('object Object'));
  // 对照：修复前的写法会得到什么
  const before = new Error(payload.error).message;
  eq('★ 修复前写法确实得到 [object Object]（说明 helper 有必要）', before, '[object Object]');
}

console.log('\n[2] 各种降级路径');
{
  eq('只有 error.code 时退回 code',
    errorMessage({ error: { code: 'SLUG_CONFLICT' } }, '兜底'), 'SLUG_CONFLICT');
  eq('error 本身是字符串时直接用',
    errorMessage({ error: '短链已被占用' }, '兜底'), '短链已被占用');
  eq('error.message 优先于 error.code',
    errorMessage({ error: { code: 'X', message: '真实原因' } }, '兜底'), '真实原因');
  eq('没有 error 时用顶层 message',
    errorMessage({ message: '顶层消息' }, '兜底'), '顶层消息');
  eq('error.message 优先于顶层 message',
    errorMessage({ message: '顶层', error: { message: '内层' } }, '兜底'), '内层');
}

console.log('\n[3] 兜底');
{
  eq('null → 兜底文案', errorMessage(null, '请求失败'), '请求失败');
  eq('undefined → 兜底文案', errorMessage(undefined, '请求失败'), '请求失败');
  eq('空对象 → 兜底文案', errorMessage({}, '请求失败'), '请求失败');
  eq('非对象 → 兜底文案', errorMessage('字符串', '请求失败'), '请求失败');
  eq('无参兜底有默认值', errorMessage(null), '请求失败');
  eq('error 为空对象 → 兜底', errorMessage({ error: {} }, '请求失败'), '请求失败');
  eq('error.message 为空串 → 继续降级', errorMessage({ error: { message: '' }, message: '顶层' }, '兜底'), '顶层');
}

console.log('\n[4] 任意输入都不会产出 [object Object]');
{
  const cases = [
    null,
    undefined,
    {},
    { error: {} },
    { error: { code: 'A', message: 'B' } },
    { error: [1, 2] },
    { error: 42 },
    { error: () => {} },
    { message: { nested: true } },
  ];
  let dirty = 0;
  for (const c of cases) {
    const out = String(errorMessage(c, '兜底'));
    if (out.includes('[object Object]')) dirty += 1;
  }
  check(`★ ${cases.length} 种输入均未产出 [object Object]`, dirty === 0, `${dirty} 种出现`);
}

console.log('\n[5] 页面已不再直接拼接 error 对象');
{
  const root = path.join(import.meta.dirname, '..');
  for (const f of ['admin.html', 'paste.html', 'index.html', 'upload.html']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    // 匹配 new Error(xxx.error) / new Error(a.error || ...) —— 都应改走 helper
    const bad = src.match(/new Error\((\w+)\.error(\s*\|\||\s*\))/g) || [];
    check(`${f} 无 new Error(x.error) 残留`, bad.length === 0, bad.join(', '));
  }
  const admin = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  check('admin.html 已改用 KVault.errorMessage',
    admin.includes('KVault.errorMessage'), '未找到调用');
}

console.log('');
if (fail === 0) {
  console.log(`✅ 错误信息提取测试全部通过：${pass} 项断言，0 失败。`);
  process.exit(0);
} else {
  console.log(`❌ 错误信息提取测试失败：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）。`);
  process.exit(1);
}
