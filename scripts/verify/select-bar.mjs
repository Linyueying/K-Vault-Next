// 端到端验证：选择模式操作条（selection-bar）collapse 高度动画
// 链路：API 登录 → 预置 r2 → 真实上传 → 结果出现 → 点「选择」采样操作条渐开 → 点「完成」采样渐收至 0
// 用法：先起本地全栈（手册 §2.2，BASIC_USER=admin BASIC_PASS=123），
//       BASE=http://127.0.0.1:8099 CHROME_PATH=<chromium> node scripts/verify/select-bar.mjs
import { chromium } from 'playwright-core';

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const ADMIN_USER = 'admin', ADMIN_PASS = '123';
const exe = process.env.CHROME_PATH;
if (!exe) { console.error('需要 CHROME_PATH 指向 chromium 可执行文件'); process.exit(1); }

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

// 1) 应用层登录（会话 cookie 进 context）
const login = await ctx.request.post(`${BASE}/api/auth/login`, {
  data: { username: ADMIN_USER, password: ADMIN_PASS },
});
if (login.status() !== 200) { console.error('登录失败 HTTP ' + login.status()); process.exit(1); }
console.log('[登录] OK');

// 2) 预置 r2（本地 telegram 不可达），等鉴权与节点解析稳定
await page.addInitScript(() => localStorage.setItem('storageMode', 'r2'));
await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => {
  const app = document.querySelector('#app')?._vnode?.component?.proxy;
  return app && !app.authChecking && app.r2Available === true;
}, { timeout: 30000 });
await page.evaluate(() => {
  const app = document.querySelector('#app')._vnode.component.proxy;
  app.setStorageMode('r2', true);
});

// 3) 真实上传：页面内构造 File → processFiles
await page.evaluate(() => {
  const app = document.querySelector('#app')._vnode.component.proxy;
  const f = new File([new Uint8Array(200 * 1024).fill(7)], 'select-bar-check.png', { type: 'image/png' });
  app.processFiles([f]);
});
await page.waitForFunction(() => {
  const app = document.querySelector('#app')._vnode.component.proxy;
  return app.uploadedFiles.length > 0;
}, { timeout: 30000 });
console.log('[上传] OK，结果条数 =', await page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.uploadedFiles.length));

// 逐帧采样器：抓元素引用，采到从 DOM 移除为止。
// 同时采 box-shadow —— 见下方「外阴影不得硬跳变」一条。
async function sampleHeight(selector) {
  return page.evaluate(async (sel) => {
    const out = [];
    const t0 = performance.now();
    await new Promise((res) => {
      const tick = () => {
        const bar = out.bar || (out.bar = document.querySelector(sel));
        const el = bar ? bar.closest('.collapse') : null;
        if (!el || !el.isConnected) { res(); return; }
        out.push(Math.round(el.getBoundingClientRect().height));
        if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else res();
      };
      requestAnimationFrame(tick);
    });
    return out;
  }, selector);
}

// 一次采样同时拿到「高度」与「外阴影」。
// 必须同帧采：阴影的渐入发生在高度动画结束之后（约 500ms → 950ms），
// 若先跑完 2s 的高度采样再回头采阴影，动画早已结束，只会采到终值 1 个 ——
// 看起来像「硬跳」，其实是采样器自己的时序 bug。
async function sampleBoth(selector) {
  return page.evaluate(async (sel) => {
    const heights = [], shadows = [];
    const t0 = performance.now();
    await new Promise((res) => {
      const tick = () => {
        const bar = heights.bar || (heights.bar = document.querySelector(sel));
        const el = bar ? bar.closest('.collapse') : null;
        if (!el || !el.isConnected) { res(); return; }
        heights.push(Math.round(el.getBoundingClientRect().height));
        shadows.push(getComputedStyle(bar).boxShadow);
        if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else res();
      };
      requestAnimationFrame(tick);
    });
    return { heights, shadows };
  }, selector);
}

// ① 点「选择」→ 操作条渐开（.selection-bar 外层的 .collapse 高度插值）
//    同时采外阴影：collapse 的 overflow:hidden 会裁掉外阴影，若不处理，
//    动画结束那一帧阴影会硬蹦出来（用户报的「阴影抽搐」）。
await page.evaluate(() => {
  const app = document.querySelector('#app')._vnode.component.proxy;
  app.toggleSelectMode();
});
const grow = await sampleBoth('.selection-bar');
const growSeq = grow.heights;
const growUniq = [...new Set(growSeq)];
console.log('[选择→操作条渐开] 高度序列(去重):', growUniq.join('→'));
const growOk = growSeq[0] < 15 && growUniq[growUniq.length - 1] > 40 && growUniq.length >= 8;

// 阴影必须「渐入」而不是「硬跳」：终值之前应采到 >=5 个中间值。
// 硬跳时序列只有 [none, 终值] 两项，一眼可辨。
const shadowUniq = [...new Set(grow.shadows)];
console.log('[阴影渐入] 去重帧数:', shadowUniq.length,
  '| 首=', shadowUniq[0].slice(0, 34),
  '| 末=', shadowUniq[shadowUniq.length - 1].slice(0, 34));
const shadowSoft = shadowUniq.length >= 5;

// ② 点「完成」→ 操作条渐收至 0
await page.evaluate(() => {
  const app = document.querySelector('#app')._vnode.component.proxy;
  app.toggleSelectMode();
});
const shrinkSeq = await sampleHeight('.selection-bar');
const shrinkUniq = [...new Set(shrinkSeq)];
console.log('[完成→操作条渐收] 高度序列(去重):', shrinkUniq.join('→'));
const shrinkOk = shrinkUniq[shrinkUniq.length - 1] === 0 && shrinkUniq.length >= 6 && shrinkSeq.filter((h) => h > 0).length >= 5;

console.log('');
console.log('操作条渐开   :', growOk ? 'PASS' : 'FAIL');
console.log('操作条渐收至0:', shrinkOk ? 'PASS' : 'FAIL');
console.log('外阴影渐入   :', shadowSoft ? 'PASS' : 'FAIL');

// ③ 打开「…」上拉菜单（menu--up 会溢出面板顶部），验证 collapse 裁切层未把菜单裁掉
await page.waitForTimeout(600); // 等操作条 leave 结束、DOM 稳定
await page.evaluate(() => {
  const app = document.querySelector('#app')._vnode.component.proxy;
  app.toggleFileMenu(0); // 单文件时 index === length-1 → menu--up 向上弹出
});
await page.waitForTimeout(450); // 等 menu 入场过渡完成
const clip = await page.evaluate(() => {
  const menu = document.querySelector('.panel .menu');
  if (!menu) return { ok: false, why: 'menu 未打开' };
  const item = menu.querySelector('.menu__item'); // 菜单首项（最靠上、最易被顶部裁切）
  const r = item.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { ok: menu.contains(hit), why: hit ? hit.className || hit.tagName : 'null', menuTop: Math.round(menu.getBoundingClientRect().top) };
});
console.log('上拉菜单未被裁切:', clip.ok ? 'PASS' : `FAIL（elementFromPoint 命中 ${clip.why}，菜单顶 ${clip.menuTop}px）`);

console.log('页面 JS 报错 :', errors.length === 0 ? '无' : errors.join(' | '));
await browser.close();
if (!growOk || !shrinkOk || !shadowSoft || !clip.ok || errors.length) process.exit(1);
console.log('ALL PASS');
