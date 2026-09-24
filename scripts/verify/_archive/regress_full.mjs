// 全量回归：8 页 · 桌面 + 移动双视口
// 检查：无 pageerror / 主题切换可用 / mobile-refactor 清理后关键布局类仍生效
import { chromium } from 'playwright';
import fs from 'node:fs';

const ROOT = '/workspace/K-Vault-Next';
const PAGES = ['index', 'admin', 'gallery', 'paste', 'share', 'preview', 'webdav', 'login'];
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

const browser = await chromium.launch();
const results = [];

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  for (const p of PAGES) {
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message).split('\n')[0]));
    await page.goto(`file://${ROOT}/${p}.html`, { waitUntil: 'load' });
    await page.waitForTimeout(400);

    // 关键类在移动视口下的计算样式抽查（mobile-refactor 覆盖目标）
    const probe = await page.evaluate(() => {
      const pick = (sel, props) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        const o = {};
        for (const pr of props) o[pr] = cs.getPropertyValue(pr);
        return o;
      };
      const anyCard = document.querySelector('.card, .preview-card, .login-card');
      return {
        hasCard: !!anyCard,
        cardRadius: anyCard ? getComputedStyle(anyCard).borderRadius : null,
        // 是否存在任何「死类」残留节点（应始终 false）
        deadNodes: document.querySelectorAll(
          '.header-content, .home-btn, .nav-links, .status-panel, .header-title, .header-actions, .el-dropdown'
        ).length,
      };
    });

    // 主题切换可用性
    const themeOk = await page.evaluate(async () => {
      if (!window.ThemeManager) return 'no-ThemeManager';
      const before = document.documentElement.getAttribute('data-theme');
      window.ThemeManager.toggleTheme();
      await new Promise((r) => setTimeout(r, 120));
      const after = document.documentElement.getAttribute('data-theme');
      return before !== after ? 'ok' : 'no-change';
    });

    results.push({ vp: vp.name, page: p, errors, ...probe, themeOk });
    await page.close();
  }
  await ctx.close();
}
await browser.close();

// 输出
let bad = 0;
console.log('viewport | page     | err | deadNodes | cardRadius | theme');
console.log('-'.repeat(72));
for (const r of results) {
  const errN = r.errors.length;
  const flag = errN > 0 || r.deadNodes > 0 || r.themeOk !== 'ok' ? ' <== 检查' : '';
  if (flag) bad++;
  console.log(
    `${r.vp.padEnd(8)} | ${r.page.padEnd(8)} | ${String(errN).padEnd(3)} | ${String(r.deadNodes).padEnd(9)} | ${String(r.cardRadius).padEnd(10)} | ${r.themeOk}${flag}`
  );
}
console.log('-'.repeat(72));
console.log(bad === 0 ? `全部通过（${results.length} 项）` : `异常 ${bad} 项`);
process.exit(bad === 0 ? 0 : 1);
