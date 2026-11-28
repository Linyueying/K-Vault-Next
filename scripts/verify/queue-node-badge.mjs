#!/usr/bin/env node
/**
 * queue-node-badge.mjs —— 上传队列「储存位置」标签的落位回归
 *
 * 背景（2026-09，三轮返工）：
 *   1) 原位置：文件名行右端（.task__header 内）→ 中文长文件名被压成 6 字+省略号。
 *   2) 改到元信息行末尾 → 移动端内容列仅 100~130px，「大小」(80) +「状态」(78)
 *      已占 158px，标签(96)被挤到第 3 行、左侧空 34px，看着像「错位」。
 *   3) 元信息行改两列网格 → 标签虽钉在右列，左列却被压到只剩 30px、每行一个字。
 *   结论：移动端文字区放不下第三样东西，在文字区里换任何排法都无解。
 *   最终落到右侧操作列顶部（.task__actions 竖排第一行），与文字区彻底解耦。
 *
 * 本脚本把这些实测结论钉成断言，防止后续再退回到上面任一种排法。
 *
 * 用法（先按 scripts/verify/README.md 起本地全栈）：
 *   CHROME_PATH=/path/to/chrome node scripts/verify/queue-node-badge.mjs
 *   BASE=http://127.0.0.1:8099 node scripts/verify/queue-node-badge.mjs
 *
 * 判据（全过退出码 0）：
 *   1. 标签在 .task__actions 内，且不在文字区（.task__header / .task__meta）内
 *   2. 标签位于按钮组正上方（底缘 ≤ 按钮组顶缘）
 *   3. 标签右缘与操作列右缘对齐，且不溢出操作列
 *   4. 窄屏（≤680px）显示短名、宽屏显示完整名，可见文本唯一（不重复）
 *   5. 操作列不被标签撑宽到挤压文件名（窄屏维持 94px 按钮槽宽）
 *   6. 无 JS 报错
 */

import { loadPlaywright, findChrome } from './_playwright.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '123';

const { chromium: core } = await loadPlaywright();
const exe = findChrome();

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —— ' + detail : ''}`);
  if (!ok) failed++;
};

// 整个脚本只登录一次（登录接口有频次限制），cookie 用 storageState 复用
const probe = await core.launch({ executablePath: exe, args: ['--no-sandbox'] });
const pctx = await probe.newContext();
const login = await pctx.request.post(`${BASE}/api/auth/login`, {
  data: { username: ADMIN_USER, password: ADMIN_PASS },
});
if (login.status() !== 200) {
  console.error(`登录失败 HTTP ${login.status()}（429 = 限流，稍后重试）`);
  await probe.close();
  process.exit(2);
}
const STORAGE = await pctx.storageState();
await probe.close();

const CASES = [
  // mode, 完整名, 短名
  ['r2', 'Cloudflare R2', 'R2'],
  ['telegram', 'Telegram', 'TG'],
];

const VIEWPORTS = [
  ['360x800', { width: 360, height: 800 }, true],   // true = 窄屏（应显示短名）
  ['390x844', { width: 390, height: 844 }, true],
  ['430x932', { width: 430, height: 932 }, true],
  ['768x1024', { width: 768, height: 1024 }, false],
  ['1440x900', { width: 1440, height: 900 }, false],
];

const FILE_NAME = '27届14班通讯录.xlsx';

for (const [mode, fullLabel, shortLabel] of CASES) {
  for (const [vpName, viewport, isNarrow] of VIEWPORTS) {
    const browser = await core.launch({ executablePath: exe, args: ['--no-sandbox'] });
    const ctx = await browser.newContext({ viewport, storageState: STORAGE });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.addInitScript((m) => localStorage.setItem('storageMode', m), mode);
    await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => {
      const app = document.querySelector('#app')?._vnode?.component?.proxy;
      return app && !app.authChecking;
    }, { timeout: 30000 });
    await page.evaluate((m) => {
      document.querySelector('#app')._vnode.component.proxy.setStorageMode(m, true);
    }, mode);
    // 等模式落定（未配置的节点会被拒绝，storageMode 不变，属正当校验）
    await page.waitForFunction((m) => {
      const app = document.querySelector('#app')._vnode.component.proxy;
      return app.storageMode === m || !app.nodeResolving;
    }, mode, { timeout: 15000 });
    await page.waitForTimeout(400);

    await page.evaluate((name) => {
      const app = document.querySelector('#app')._vnode.component.proxy;
      app.processFiles([new File([new Uint8Array(200 * 1024).fill(1)], name, { type: 'application/vnd.ms-excel' })]);
    }, FILE_NAME);
    await page.waitForSelector('.task', { timeout: 15000 });
    // 真实暂停 -> 渲染出 3 个按钮，才能验证「标签在按钮上方」
    await page.evaluate(() => {
      const app = document.querySelector('#app')._vnode.component.proxy;
      if (app.uploadingFiles[0]) app.pauseUpload(app.uploadingFiles[0]);
    });
    await page.waitForTimeout(700);

    const r = await page.evaluate(() => {
      const t = document.querySelector('.task');
      const R = (e) => e ? {
        l: Math.round(e.getBoundingClientRect().left),
        r: Math.round(e.getBoundingClientRect().right),
        w: Math.round(e.getBoundingClientRect().width),
        t: Math.round(e.getBoundingClientRect().top),
        b: Math.round(e.getBoundingClientRect().bottom),
        h: Math.round(e.getBoundingClientRect().height),
      } : null;
      const badge = t.querySelector('.task__node');
      const actions = t.querySelector('.task__actions');
      const btnGroup = t.querySelector('.taskAct');
      const header = t.querySelector('.task__header');
      const meta = t.querySelector('.task__meta');
      return {
        // innerText 会跳过 display:none 的节点，用来确认只显示一份文本
        visibleText: badge ? badge.innerText.trim() : null,
        btnCount: t.querySelectorAll('.taskAct button').length,
        inActions: badge ? actions.contains(badge) : false,
        inHeader: badge ? header.contains(badge) : false,
        inMeta: badge ? meta.contains(badge) : false,
        badge: R(badge), actions: R(actions), btnGroup: R(btnGroup),
        nameW: R(t.querySelector('.task__name')).w,
        cardH: R(t).h,
      };
    });

    const tag = `[${mode}/${vpName}]`;
    console.log(`\n── ${tag} 可见文本="${r.visibleText}" 按钮=${r.btnCount} 操作列=${r.actions.w}px`);

    check(`${tag} 标签在右侧操作列内`, r.inActions, `inActions=${r.inActions}`);
    check(`${tag} 标签已移出文字区（不在文件名行/元信息行）`, !r.inHeader && !r.inMeta,
      `inHeader=${r.inHeader} inMeta=${r.inMeta}`);
    check(`${tag} 标签位于按钮组正上方`,
      r.btnCount > 0 && r.badge.b <= r.btnGroup.t + 1,
      `badge.bottom=${r.badge.b} btnGroup.top=${r.btnGroup.t} btnCount=${r.btnCount}`);
    check(`${tag} 标签右缘与操作列右缘对齐`,
      Math.abs(r.badge.r - r.actions.r) <= 1, `badge.r=${r.badge.r} actions.r=${r.actions.r}`);
    check(`${tag} 标签未溢出操作列`, r.badge.w <= r.actions.w + 1,
      `badge.w=${r.badge.w} actions.w=${r.actions.w}`);
    check(`${tag} 显示${isNarrow ? '短名' : '完整名'}：${isNarrow ? shortLabel : fullLabel}`,
      r.visibleText === (isNarrow ? shortLabel : fullLabel),
      `实际="${r.visibleText}"`);
    check(`${tag} 可见文本唯一（完整名+短名未同时显示）`,
      r.visibleText === shortLabel || r.visibleText === fullLabel,
      `实际="${r.visibleText}"`);
    // 窄屏操作列必须维持 94px 按钮槽宽，不能被标签撑宽而挤压文字区
    if (isNarrow) {
      check(`${tag} 窄屏操作列维持 94px（未被标签撑宽）`, r.actions.w === 94, `实际 ${r.actions.w}px`);
    }
    check(`${tag} 无 JS 报错`, pageErrors.length === 0, pageErrors.join(' | ').slice(0, 160));

    await browser.close();
  }
}

console.log('');
console.log(failed === 0 ? 'ALL PASS' : `\n${failed} 项 FAIL`);
process.exit(failed === 0 ? 0 : 1);
