// 主题开关盘点 —— 确认每页都有「可点的主题切换」入口
//
// 背景：8 页的主题开关路径各不相同：
//   index/admin 自带按钮、gallery 自绘 theme-toggle-round、paste/share/preview/login
//   浮动按钮、webdav 的 .btn action-btn。排查时不能只"找 fa-moon 图标按钮"——
//   会把别的按钮误判成开关。本脚本精确统计每页的 data-theme-toggle 元素与各路径。
//
// 用途：改了主题系统后，确认 8 页全都 still 有开关、且不重复（body 上误挂
// data-theme-toggle 会让一次点击被处理两次，主题来回抵消）。
//
// 用法：
//   python3 -m http.server 8788 --bind 127.0.0.1 &
//   node scripts/verify/audit-theme-toggle.mjs
import { loadPlaywright, findChrome } from './_playwright.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const { chromium } = await loadPlaywright();

const PAGES = ['index', 'admin', 'gallery', 'paste', 'share', 'preview', 'webdav', 'login'];
let bad = 0;

const b = await chromium.launch({
  executablePath: findChrome(),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

console.log('页面级主题开关盘点');
console.log('='.repeat(96));
for (const p of PAGES) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const pg = await ctx.newPage();
  await pg.goto(`${BASE}/${p}.html`, { waitUntil: 'load' });
  await pg.waitForTimeout(1000);
  const r = await pg.evaluate(() => {
    const t = [...document.querySelectorAll('[data-theme-toggle]')];
    const moonBtns = [...document.querySelectorAll('button')]
      .filter((x) => /fa-moon|fa-sun/.test(x.innerHTML));
    return {
      nToggle: t.length,
      toggleCls: t.map((x) => x.className).join('|') || '-',
      nMoomBtns: moonBtns.length,
      moonCls: moonBtns.map((x) => x.className).join('|') || '-',
      hasOwnAttr: document.documentElement.hasAttribute('data-own-theme-toggle'),
      theme: document.documentElement.getAttribute('data-theme'),
    };
  });
  // 诊断规则：自带开关页(data-own-theme-toggle)不应再被 theme.js 造浮动按钮；
  // 没自带开关的页，浮动按钮上的 data-theme-toggle 必须=1。
  const expectToggle = r.hasOwnAttr ? 0 : 1;
  const ok = r.nToggle === expectToggle;
  if (!ok) bad++;
  const flag = ok ? '' : '<<<';
  console.log(p.padEnd(9)
    + ' data-theme-toggle=' + String(r.nToggle).padEnd(3)
    + ' (期望' + expectToggle + ')'
    + ' own=' + String(r.hasOwnAttr).padEnd(6)
    + ' 图标按钮=' + String(r.nMoomBtns).padEnd(3)
    + ' theme=' + r.theme + ' ' + flag);
  console.log(`           toggle类名: ${r.toggleCls}`);
  console.log(`           图标按钮类名: ${r.moonCls}`);
  await ctx.close();
}
await b.close();
console.log(bad === 0 ? '\n=== 8 页主题开关均符合预期 ===' : `\n=== ${bad} 页异常 ===`);
process.exit(bad === 0 ? 0 : 1);
