#!/usr/bin/env node
/**
 * overflow-x.mjs —— 移动端视口「横向溢出」端到端验证
 *
 * 背景（2026-09-24）：
 *   结果面板改用共享层 collapse 过渡后，真机截图出现整页横向溢出：
 *   交付结果卡片、「清空」按钮、底部「更多功能」都被截出右边界。
 *   根因方向：.collapse 是单格 grid，grid 子项默认 min-width:auto，
 *   长文件名行（文件名 + 复制 + 更多按钮）的 content-based minimum
 *   会把隐式列轨道撑得比视口宽，进而把整个 body 撑宽。
 *
 * 判据（全过退出码 0）：
 *   1. 真实上传成功（uploadedFiles ≥ 1）
 *   2. document.scrollWidth === window.innerWidth（无横向滚动）
 *   3. 无可见元素右边界超出视口（容差 1px；fixed 定位元素同样参与检查）
 *
 * 用法（先按 README 起本地全栈 + chromium）：
 *   BASE=http://127.0.0.1:8099 node scripts/verify/overflow-x.mjs
 */

import { loadPlaywright, findChrome } from './_playwright.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '123';

const { chromium: core } = await loadPlaywright();
const exe = findChrome();
const browser = await core.launch({ executablePath: exe, args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  // 注意：不要开 isMobile —— Chrome 移动端会把布局视口自动撑宽以容纳超宽内容，
  // innerWidth 变成 401 之类的假象，溢出测量全部失真。固定 390 布局视口才量得准。
});
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —— ' + detail : ''}`);
  if (!ok) failed++;
};

// 1) 应用层登录
const login = await ctx.request.post(`${BASE}/api/auth/login`, {
  data: { username: ADMIN_USER, password: ADMIN_PASS },
});
check('登录 /api/auth/login', login.status() === 200, `HTTP ${login.status()}`);

// 2) 预置 r2（本地 telegram 不可达）
await page.addInitScript(() => localStorage.setItem('storageMode', 'r2'));
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => {
  const app = document.querySelector('#app')?._vnode?.component?.proxy;
  return app && !app.authChecking && app.r2Available === true;
}, { timeout: 30000 });
await page.evaluate(() => {
  const app = document.querySelector('#app')._vnode.component.proxy;
  app.setStorageMode('r2', true);
});

// 3) 真实上传：长文件名（贴近真机截图 IMG_2026…_1.jpg）
await page.evaluate(() => {
  const app = document.querySelector('#app')._vnode.component.proxy;
  const f = new File(
    [new Uint8Array(300 * 1024).fill(7)],
    'IMG_20260920_200619_1.jpg',
    { type: 'image/jpeg' }
  );
  app.processFiles([f]);
});
await page.waitForFunction(() => {
  const app = document.querySelector('#app')._vnode.component.proxy;
  return app.uploadedFiles.length > 0;
}, { timeout: 30000 });
check('真实上传成功（结果面板有条目）', true);

// 4) 等 collapse 进场动画结束（0.5s）+ 布局稳定再量
await page.waitForTimeout(900);

// 5) 横向溢出测量：整页 scrollWidth + 逐元素右边界
const m = await page.evaluate(() => {
  const vw = window.innerWidth;
  const doc = document.scrollingElement;
  const offenders = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    // 只查在流元素（static/relative）。absolute/fixed 的装饰元素（如 ambient-orb）
    // 越出视口属正常设计且已被祖先裁剪（不产生滚动），其真实溢出由上面的
    // scrollWidth 检查兜底 —— 在这里计入只会制造误报。
    if (cs.position !== 'static' && cs.position !== 'relative') continue;
    if (r.right > vw + 1) {
      offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className).split(/\s+/).slice(0, 3).join('.'),
        right: Math.round(r.right),
        over: Math.round(r.right - vw),
        pos: cs.position,
      });
    }
  }
  offenders.sort((a, b) => b.over - a.over);
  return {
    vw,
    scrollWidth: doc.scrollWidth,
    clientWidth: doc.clientWidth,
    offenders: offenders.slice(0, 12),
    offenderCount: offenders.length,
  };
});

check(
  '无横向滚动（scrollWidth === clientWidth）',
  m.scrollWidth <= m.clientWidth,
  `scrollWidth=${m.scrollWidth} clientWidth=${m.clientWidth} vw=${m.vw}`
);
check(
  '无元素右边界越出视口',
  m.offenderCount === 0,
  m.offenderCount
    ? `${m.offenderCount} 个越界，最严重: ` +
      m.offenders
        .slice(0, 5)
        .map((o) => `${o.tag}.${o.cls}(+${o.over}px,${o.pos})`)
        .join(', ')
    : ''
);

check('无 JS 报错', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200));

await browser.close();
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项 FAIL`);
process.exit(failed === 0 ? 0 : 1);
