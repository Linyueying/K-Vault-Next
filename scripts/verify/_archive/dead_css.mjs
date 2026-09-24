import { chromium } from 'playwright-core';

const BASE = 'http://127.0.0.1:8788';
const b = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const PAGES = ['index', 'admin', 'gallery', 'paste', 'share', 'preview', 'webdav', 'login'];
const SELECTORS = ['.header-content', '.nav-links', '.home-btn', '.header-actions', '.header-title', '.title'];

console.log('运行时实际匹配数（0 = 死选择器）');
console.log('page     ' + SELECTORS.map((s) => s.padEnd(17)).join(''));
console.log('-'.repeat(120));

for (const p of PAGES) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const pg = await ctx.newPage();
  await pg.goto(`${BASE}/${p}.html`, { waitUntil: 'load' });
  await pg.waitForTimeout(900);
  const counts = await pg.evaluate(
    (sels) => sels.map((s) => document.querySelectorAll(s).length),
    SELECTORS
  );
  console.log(p.padEnd(9) + counts.map((c) => String(c).padEnd(17)).join(''));
  await ctx.close();
}

/* 再看移动端视口下是否出现（有些元素靠媒体查询才插入 DOM） */
console.log('\n移动端视口 390x844（部分元素可能仅在小屏渲染）');
for (const p of PAGES) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const pg = await ctx.newPage();
  await pg.goto(`${BASE}/${p}.html`, { waitUntil: 'load' });
  await pg.waitForTimeout(1000);
  const counts = await pg.evaluate(
    (sels) => sels.map((s) => document.querySelectorAll(s).length),
    SELECTORS
  );
  console.log(p.padEnd(9) + counts.map((c) => String(c).padEnd(17)).join(''));
  await ctx.close();
}

await b.close();
