// 死选择器运行时探测 —— 删 CSS 之前必须先跑这个（防误删）
//
// 背景：本次清理 mobile-refactor.css 时，第一遍差点误删 .header-title /
// .header-actions —— 静态 grep 看着像没人用，其实 webdav.html 里有。
// 教训：「这个类是不是死的」不能靠 grep 子串判断，必须两边都验：
//   (a) 全量 HTML/JS 的 class 属性做精确 token 匹配（静态）
//   (b) 真实浏览器里 querySelectorAll 的匹配数（运行时，本脚本）
// 两个都说 0，才算真死。
//
// 用法：
//   1) python3 -m http.server 8788 --bind 127.0.0.1 &
//   2) node scripts/verify/dead-selectors.mjs .header-content .nav-links ...
//      不带参数时用下面 DEFAULT_SELECTORS。
//
// 输出：每个选择器在每页的匹配数。任一页 > 0 即说明它在用，不能删。
import { loadPlaywright, findChrome } from './_playwright.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8788';

const { chromium } = await loadPlaywright();

const PAGES = ['index', 'admin', 'gallery', 'paste', 'share', 'preview', 'webdav', 'login'];

const DEFAULT_SELECTORS = [
  '.header-content', '.nav-links', '.home-btn', '.status-panel',
  '.stats-text', '.stats-loaded', '.header-theme-toggle', '.theme-toggle-btn',
  '.el-dropdown', '.el-select-dropdown', '.el-card', '.el-dialog',
];

const selectors = process.argv.slice(2).length
  ? process.argv.slice(2)
  : DEFAULT_SELECTORS;

const b = await chromium.launch({
  executablePath: findChrome(),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const perPage = {};
for (const p of PAGES) {
  const page = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${BASE}/${p}.html`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForTimeout(300);
  perPage[p] = await page.evaluate((sels) => {
    const out = {};
    for (const s of sels) {
      try { out[s] = document.querySelectorAll(s).length; }
      catch { out[s] = 'BAD-SELECTOR'; }
    }
    return out;
  }, selectors);
  await page.close();
}
await b.close();

// 表格输出：行=选择器，列=页面
const pages = PAGES.map((p) => p.replace('.html', ''));
const W = 24;
console.log('选择器'.padEnd(W) + ' | ' + pages.map((p) => p.slice(0, 7).padEnd(7)).join(' ') + ' | 判定');
console.log('-'.repeat(W + 2 + pages.length * 8 + 8));

let anyAlive = false;
for (const s of selectors) {
  const counts = PAGES.map((p) => perPage[p][s]);
  const total = counts.reduce((a, c) => a + (typeof c === 'number' ? c : 0), 0);
  const alive = total > 0;
  if (alive) anyAlive = true;
  const verdict = counts.some((c) => c === 'BAD-SELECTOR')
    ? '选择器非法'
    : alive ? `在用(${total}) 勿删` : '死 · 可删';
  console.log(
    s.padEnd(W) + ' | ' +
    counts.map((c) => String(c).padEnd(7)).join(' ') + ' | ' + verdict
  );
}
console.log('-'.repeat(W + 2 + pages.length * 8 + 8));
console.log(anyAlive
  ? '注意：有选择器仍在用（见「勿删」列），删除会破坏布局。'
  : '全部 0 匹配 —— 运行时确认均为死选择器。');
