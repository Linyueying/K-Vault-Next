#!/usr/bin/env node
/**
 * queue-collapse.mjs —— 上传队列 / 交付结果面板「高度收起动画」端到端验证
 *
 * 背景（2026-09）：
 *   队列与结果面板原先用 <transition name="rise">（只做位移+透明度、不插值高度），
 *   任务完成清理 / 面板 v-if 消失的瞬间高度塌掉，观感是「瞬间没掉、布局弹跳」。
 *   现已统一改为共享层 collapse 过渡（grid-template-rows 0fr↔1fr 真插值 +
 *   --ease-apple 非线性缓动）。本脚本用**真实上传**验证整条链路：
 *
 *     队列面板渐开 → 上传成功 → 结果面板出现（含 选择/清空 头部）
 *     → 2.5s 清理器移除任务 → 队列面板高度平滑收起到 0
 *
 * 用法（先按 README 起本地全栈 + chromium，见 scripts/verify/README.md）：
 *   # 本地全栈须带凭据绑定（开放实例 /upload 会 401 GUEST_UPLOAD_DISABLED）：
 *   npx wrangler pages dev ./ --kv "img_url" --r2=R2_BUCKET \
 *     --compatibility-date=2026-05-03 --port 8099 --persist-to /tmp/kvdata \
 *     --binding BASIC_USER=admin --binding BASIC_PASS=123
 *
 *   BASE=http://127.0.0.1:8099 node scripts/verify/queue-collapse.mjs
 *   # 凭据默认 admin/123，可用 ADMIN_USER / ADMIN_PASS 覆盖
 *
 * 判据（全过退出码 0）：
 *   1. 队列面板 enter：首帧 < 10px，末帧 > 100px，中间 ≥ 5 个不同高度（渐进插值）
 *   2. 真实上传成功：uploadedFiles ≥ 1
 *   3. 结果面板头部含「选择 / 清空」
 *   4. 队列面板 leave：末值 0，中间 ≥ 6 个不同高度（渐进收起，不允许瞬间塌陷）
 */

import { loadPlaywright, findChrome } from './_playwright.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '123';

const { chromium: core } = await loadPlaywright();
const exe = findChrome();
const browser = await core.launch({ executablePath: exe, args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —— ' + detail : ''}`);
  if (!ok) failed++;
};

// 1) 应用层登录（会话 cookie 进 context）
const login = await ctx.request.post(`${BASE}/api/auth/login`, {
  data: { username: ADMIN_USER, password: ADMIN_PASS },
});
check('登录 /api/auth/login', login.status() === 200, `HTTP ${login.status()}`);

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

// 3) 真实上传：页面内构造 File → processFiles（走真实调度器 + 真实 /upload）
await page.evaluate(() => {
  const app = document.querySelector('#app')._vnode.component.proxy;
  const f = new File([new Uint8Array(300 * 1024).fill(7)], 'queue-collapse-check.png', { type: 'image/png' });
  app.processFiles([f]);
});

// 4) 队列面板 enter 采样（上传开始即渐开）
const enterSeq = await page.evaluate(async () => {
  const out = [];
  const t0 = performance.now();
  await new Promise((res) => {
    const tick = () => {
      const el = document.querySelectorAll('.collapse')[0]; // 队列面板在结果面板之前
      out.push(el ? Math.round(el.getBoundingClientRect().height) : -1);
      if (performance.now() - t0 < 800) requestAnimationFrame(tick); else res();
    };
    requestAnimationFrame(tick);
  });
  return out;
});
const enterUniq = [...new Set(enterSeq)].filter((v) => v >= 0);
check(
  '队列面板 enter 渐开（0fr→1fr 插值）',
  enterSeq[0] < 10 && enterSeq[enterSeq.length - 1] > 100 && enterUniq.length >= 5,
  `高度序列去重 ${enterUniq.length} 点: ${enterUniq.slice(0, 8).join('→')}…`
);

// 5) 等真实上传完成
await page.waitForFunction(() => {
  const app = document.querySelector('#app')._vnode.component.proxy;
  return app.uploadedFiles.length > 0;
}, { timeout: 30000 });
const results = await page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.uploadedFiles.length);
check('真实上传成功（结果面板有条目）', results > 0, `results=${results}`);

const headerBtns = await page.evaluate(() =>
  [...document.querySelectorAll('.result-actions .text-btn')].map((b) => b.textContent.trim())
);
check('结果面板头部含 选择/清空', headerBtns.includes('选择') && headerBtns.includes('清空'), JSON.stringify(headerBtns));

// 6) 队列 leave 采样：抓队列面板元素引用，采到它被 DOM 移除为止。
//    注意清理器把 uploadingFiles 清空是同步的，leave 动画是异步的——
//    不要用 uploadingFiles.length 判定面板消失（那是采样器 bug，不是动画 bug）。
const leaveSeq = await page.evaluate(async () => {
  const out = [];
  const t0 = performance.now();
  await new Promise((res) => {
    const tick = () => {
      const el = out.el || (out.el = document.querySelectorAll('.collapse')[0]);
      if (!el || !el.isConnected) { out.push(0); res(); return; }
      out.push(Math.round(el.getBoundingClientRect().height));
      if (performance.now() - t0 < 5000) requestAnimationFrame(tick); else res();
    };
    requestAnimationFrame(tick);
  });
  return out;
});
const leaveUniq = [...new Set(leaveSeq)];
check(
  '队列面板 leave 平滑收起到 0（清理器移除任务后）',
  leaveSeq[leaveSeq.length - 1] === 0 && leaveUniq.length >= 6,
  `高度序列去重 ${leaveUniq.length} 点: ${leaveUniq.slice(0, 10).join('→')}${leaveUniq.length > 10 ? '…→0' : ''}`
);

const queueGone = await page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.uploadingFiles.length === 0);
check('队列任务已清空', queueGone);

check('无 JS 报错', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200));

await browser.close();
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} 项 FAIL`);
process.exit(failed === 0 ? 0 : 1);
