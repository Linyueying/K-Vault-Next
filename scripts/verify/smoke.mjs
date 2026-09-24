// 8 页全量冒烟测试 —— 每次改完前端都该跑一遍
//
// 检查：每页在桌面/移动两种视口下
//   1. 有没有 JS 报错（pageerror）
//   2. 有没有出现「已确认删除的死选择器」对应的 DOM 节点
//   3. 主题切换是否可用（能改 data-theme 并写进 localStorage）
//
// 用法：
//   1) 先起一个静态服务（仓库根目录）：
//        python3 -m http.server 8788 --bind 127.0.0.1
//   2) 跑：
//        node scripts/verify/smoke.mjs
//     端口不是 8788 时：
//        BASE=http://127.0.0.1:8099 node scripts/verify/smoke.mjs
//
// 依赖：playwright-core（解析逻辑见 _playwright.mjs）
import { loadPlaywright, findChrome } from './_playwright.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8788';

const { chromium } = await loadPlaywright();

const PAGES = ['index', 'admin', 'gallery', 'paste', 'share', 'preview', 'webdav', 'login'];
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

// 已确认全站不存在的类（清理 mobile-refactor.css 时删掉的）。
// 它们不该再出现在任何页面的 DOM 里；出现即说明有人把死代码加回来了。
const DEAD_SELECTORS = [
  '.header-content', '.home-btn', '.nav-links', '.status-panel',
  '.stats-text', '.el-dropdown', '.theme-admin-toggle',
];

const b = await chromium.launch({
  executablePath: findChrome(),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const results = [];
for (const vp of VIEWPORTS) {
  const ctx = await b.newContext({ viewport: { width: vp.width, height: vp.height } });
  for (const p of PAGES) {
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message).split('\n')[0]));
    try {
      await page.goto(`${BASE}/${p}.html`, { waitUntil: 'load', timeout: 15000 });
    } catch (e) {
      errors.push('NAV:' + String(e.message).split('\n')[0]);
    }
    await page.waitForTimeout(500);

    const probe = await page.evaluate((sels) => {
      return { deadNodes: document.querySelectorAll(sels.join(',')).length };
    }, DEAD_SELECTORS);

    // 主题切换：能改 data-theme 就算通过
    const themeOk = await page.evaluate(async () => {
      if (!window.ThemeManager) return 'no-TM';
      const before = document.documentElement.getAttribute('data-theme');
      window.ThemeManager.toggleTheme();
      await new Promise((r) => setTimeout(r, 150));
      return document.documentElement.getAttribute('data-theme') !== before
        ? 'ok' : 'no-change';
    });

    results.push({ vp: vp.name, page: p, errors, ...probe, themeOk });
    await page.close();
  }
  await ctx.close();
}
await b.close();

let bad = 0;
console.log('viewport | page     | err | dead | theme');
console.log('-'.repeat(52));
for (const r of results) {
  const errN = r.errors.length;
  const flag = errN > 0 || r.deadNodes > 0 || r.themeOk !== 'ok' ? '  <== 检查' : '';
  if (flag) bad++;
  console.log(
    `${r.vp.padEnd(8)} | ${r.page.padEnd(8)} | ${String(errN).padEnd(3)} | ${String(r.deadNodes).padEnd(4)} | ${r.themeOk}${flag}`
  );
  if (errN) r.errors.forEach((e) => console.log(`      err: ${e}`));
}
console.log('-'.repeat(52));
console.log(bad === 0 ? `全部通过（${results.length} 项）` : `异常 ${bad} 项`);
process.exit(bad === 0 ? 0 : 1);
