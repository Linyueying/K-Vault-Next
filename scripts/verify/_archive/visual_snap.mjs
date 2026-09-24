// 视觉回归：mobile-refactor.css 清理前后，4 个受影响页面的关键元素计算样式应完全一致
import { chromium } from 'playwright-core';

const BASE = 'http://127.0.0.1:8788';
const PAGES = ['gallery', 'preview', 'webdav', 'login'];
const VPS = [
  { name: 'mobile390', width: 390, height: 844 },
  { name: 'tablet900', width: 900, height: 800 },
  { name: 'tablet1100', width: 1100, height: 800 },
];

// 需要比对的关键元素（覆盖 mobile-refactor 里保留下来的规则）
const TARGETS = [
  '.card', '.btn', '.action-btn', 'body', '.title', '.stats',
  '.header-title', '.header-actions', '.toolbar', '.login-card', '.preview-card',
];

const b = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const snapshot = {};   // key: vp|page|sel -> style dict

for (const vp of VPS) {
  const ctx = await b.newContext({ viewport: { width: vp.width, height: vp.height } });
  for (const p of PAGES) {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/${p}.html`, { waitUntil: 'load', timeout: 15000 });
    await page.waitForTimeout(400);
    const data = await page.evaluate((sels) => {
      const out = {};
      for (const s of sels) {
        const el = document.querySelector(s);
        if (!el) { out[s] = null; continue; }
        const cs = getComputedStyle(el);
        out[s] = [
          cs.borderRadius, cs.fontFamily.slice(0, 40), cs.padding, cs.margin,
          cs.minHeight, cs.minWidth, cs.display, cs.gridTemplateColumns,
          cs.flexWrap, cs.overflow, cs.letterSpacing, cs.fontSize,
          cs.backgroundColor, cs.boxShadow.slice(0, 60), cs.position,
          cs.top, cs.right, cs.textOverflow, cs.whiteSpace, cs.lineHeight,
        ].join('|');
      }
      return out;
    }, TARGETS);
    for (const [s, v] of Object.entries(data)) snapshot[`${vp.name}|${p}|${s}`] = v;
    await page.close();
  }
  await ctx.close();
}
await b.close();

import fs from 'node:fs';
const outPath = process.argv[2] || '/tmp/visual_snapshot.json';
fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
console.log(`快照已写入 ${outPath}（${Object.keys(snapshot).length} 项）`);
