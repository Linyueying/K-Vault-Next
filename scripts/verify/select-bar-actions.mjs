// 端到端验证：选择条「功能选项」改造后的真实行为
//   交付结果条：下载 / 分享 / 复制链接 / 移动到 / 删除（真删云端）
//   历史记录条：下载 / 复制链接 / 加入结果 / 移动到 / 删除（真删云端）
//   旧「移除」（只清本地列表）已从两处移除；未登录时云端操作按钮置灰。
//
// 用法：先起本地全栈（AI-OPERATIONS.md §本地起全栈，BASIC_USER=admin BASIC_PASS=123）
//   CHROME_PATH=<chromium> node scripts/verify/select-bar-actions.mjs
import { chromium } from 'playwright-core';

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const ADMIN_USER = 'admin', ADMIN_PASS = '123';
const exe = process.env.CHROME_PATH;
if (!exe) { console.error('需要 CHROME_PATH 指向 chromium 可执行文件'); process.exit(1); }

let pass = 0, fail = 0;
/* KV 是跨次运行的共享状态：目标目录带时间戳后缀，避免上轮残留的文件
   把「moved 数量」这条断言污染成 4（上一轮成功 + 这一轮）。 */
const MOVE_TARGET = 'moved/by-bar-' + Date.now().toString(36);
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const errors = [];

/* ---------- 通用：登录 + 预置 r2 + 真实上传 ---------- */
async function boot(page, { authed }) {
  const ctx = page.context();
  if (authed) {
    const r = await ctx.request.post(`${BASE}/api/auth/login`, { data: { username: ADMIN_USER, password: ADMIN_PASS } });
    if (r.status() !== 200) throw new Error('登录失败 HTTP ' + r.status());
  }
  await page.addInitScript(() => localStorage.setItem('storageMode', 'r2'));
  await page.addInitScript((t) => { window.__MOVE_TARGET__ = t; }, MOVE_TARGET);
  if (process.env.BREAK_DELETE) await page.addInitScript(() => { window.__BREAK_DELETE__ = true; });
  await page.goto(`${BASE}/index.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => {
    const app = document.querySelector('#app')?._vnode?.component?.proxy;
    return app && !app.authChecking && app.r2Available === true;
  }, null, { timeout: 30000 });
  await page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.setStorageMode('r2', true));
}
const proxy = () => document.querySelector('#app')._vnode.component.proxy;

async function upload(page, names) {
  await page.evaluate((list) => {
    const app = document.querySelector('#app')._vnode.component.proxy;
    app.processFiles(list.map((n) => new File([new Uint8Array(64 * 1024).fill(3)], n, { type: 'image/png' })));
  }, names);
  await page.waitForFunction((n) => document.querySelector('#app')._vnode.component.proxy.uploadedFiles.length >= n,
    names.length, { timeout: 40000 });
}

/* 读取某条 selection-bar 的按钮（文案 + disabled） */
const readBar = (page, ordinal) => page.evaluate((idx) => {
  const bars = [...document.querySelectorAll('.selection-bar')];
  const bar = bars[idx];
  if (!bar) return null;
  return {
    info: bar.querySelector('.selection-bar__info')?.textContent.trim() || '',
    buttons: [...bar.querySelectorAll('.selection-bar__actions .btn')].map((b) => ({
      text: b.textContent.trim(),
      disabled: b.disabled,
      danger: b.classList.contains('btn--danger'),
      title: b.getAttribute('title') || '',
    })),
  };
}, ordinal);

/* ================= 1) 已登录：交付结果条 ================= */
console.log('\n[1] 交付结果选择条（已登录）');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await boot(page, { authed: true });
  await upload(page, ['bar-act-a.png', 'bar-act-b.png']);

  // 进入选择模式前不应有选择条
  ok('未进选择模式时无选择条', (await page.locator('.selection-bar').count()) === 0);

  await page.evaluate(() => { const a = document.querySelector('#app')._vnode.component.proxy; a.toggleSelectMode(); });
  await page.waitForSelector('.selection-bar');

  let bar = await readBar(page, 0);
  ok('按钮集合 = 下载/分享/复制链接/移动到/删除',
    JSON.stringify(bar.buttons.map((b) => b.text)) === JSON.stringify(['下载', '分享', '复制链接', '移动到', '删除']),
    bar.buttons.map((b) => b.text).join(' | '));
  ok('只有「删除」是危险样式', bar.buttons.filter((b) => b.danger).length === 1 && bar.buttons[4].danger);
  ok('未选中任何项 → 下载/分享/复制链接 置灰',
    bar.buttons[0].disabled && bar.buttons[1].disabled && bar.buttons[2].disabled);

  // 全选
  await page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.selectAll());
  await page.waitForFunction(() => document.querySelector('#app')._vnode.component.proxy.selectedCount === 2);
  bar = await readBar(page, 0);
  ok('已选 2 项 → 全部按钮可用', bar.buttons.every((b) => !b.disabled));
  ok('已登录且已选中 → 移动到/删除 可点', !bar.buttons[3].disabled && !bar.buttons[4].disabled,
    `isAuthenticated=${await page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.isAuthenticated)}`);
  ok('计数文案正确', /已选 2 项/.test(bar.info), bar.info);

  /* --- 移动到：弹输入框，确认后真的调 move-folder --- */
  await page.evaluate(() => {
    const app = document.querySelector('#app')._vnode.component.proxy;
    app.moveSelectedToFolder();
  });
  await page.waitForFunction(() => {
    const d = document.querySelector('#app')._vnode.component.proxy.dlg;
    return d && d.visible && d.mode === 'prompt';
  }, null, { timeout: 5000 });
  const dlgTitle = await page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.dlg.title);
  ok('「移动到」弹出输入框对话框', dlgTitle === '移动到目录', dlgTitle);

  const moveCalls = [];
  page.on('request', (r) => { if (r.url().includes('/api/manage/files/move-folder')) moveCalls.push(r); });
  await page.evaluate(() => {
    const app = document.querySelector('#app')._vnode.component.proxy;
    app.dlg.value = window.__MOVE_TARGET__;
    app.dlgConfirm();
  });
  await page.waitForFunction(() => {
    const app = document.querySelector('#app')._vnode.component.proxy;
    return !app.dlg.visible && app.resultBatchBusy === false;
  }, null, { timeout: 20000 });
  ok('确认后真的调用了 move-folder', moveCalls.length === 1, `调用 ${moveCalls.length} 次`);
  const moved = await page.evaluate(async () => {
    const r = await fetch('/api/manage/list?limit=100', { credentials: 'include' }).then((x) => x.json());
    // list 接口返回的是 keys[]，folderPath 挂在 metadata 上
    return (r.keys || []).filter((k) => k.metadata && k.metadata.folderPath === window.__MOVE_TARGET__).length;
  });
  ok('云端 folderPath 已改为目标目录', moved === 2, `${moved} 个文件在 ${MOVE_TARGET}`);

  /* --- 删除：弹危险确认框，确认后云端记录真的消失 --- */
  const urls = await page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.uploadedFiles.map((f) => f.url));
  const deleteCalls = [];
  page.on('request', (r) => { if (/\/api\/manage\/delete\//.test(r.url())) deleteCalls.push(r.url()); });
  // 注意：evaluate 会 await 返回的 Promise —— deleteSelected 要等弹窗确认，
  // 所以必须写成「不返回 Promise」的形式，否则这里会一直挂着。
  await page.evaluate(() => {
    document.querySelector('#app')._vnode.component.proxy.deleteSelected();
  });
  await page.waitForFunction(() => {
    const d = document.querySelector('#app')._vnode.component.proxy.dlg;
    return d && d.visible && d.mode === 'confirm';
  }, null, { timeout: 5000 });
  const dlg2 = await page.evaluate(() => {
    const d = document.querySelector('#app')._vnode.component.proxy.dlg;
    return { title: d.title, tone: d.tone, note: d.note };
  });
  ok('「删除」弹出危险确认框', dlg2.title === '删除云端文件' && dlg2.tone === 'danger', `${dlg2.title}/${dlg2.tone}`);
  ok('确认框说明了会清 KV 与短链', /KV/.test(dlg2.note), dlg2.note);

  await page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.dlgConfirm());
  await page.waitForFunction(() => {
    const app = document.querySelector('#app')._vnode.component.proxy;
    return app.uploadedFiles.length === 0 && app.resultBatchBusy === false;
  }, null, { timeout: 25000 });
  ok('确认后列表清空', true);
  ok('逐个调用了 delete 接口', deleteCalls.length === 2, `${deleteCalls.length} 次`);

  const gone = await page.evaluate(async (list) => {
    const out = [];
    for (const u of list) {
      const r = await fetch(u, { method: 'HEAD', credentials: 'include' });
      out.push(r.status);
    }
    return out;
  }, urls);
  ok('云端文件已不可访问（404/410）', gone.every((s) => s === 404 || s === 410), gone.join(','));

  const histGone = await page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.uploadHistory.length);
  ok('云端删除后历史同步失效（不留死链）', histGone === 0, `剩余 ${histGone} 条`);

  /* --- 行内 ⋯ 菜单不再有「移除」 --- */
  await page.evaluate(() => {
    const app = document.querySelector('#app')._vnode.component.proxy;
    app.toggleSelectMode();
    app.processFiles([new File([new Uint8Array(1024)], 'menu-check.png', { type: 'image/png' })]);
  });
  await page.waitForFunction(() => document.querySelector('#app')._vnode.component.proxy.uploadedFiles.length === 1, null, { timeout: 40000 });
  await page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.toggleFileMenu(0));
  await page.waitForSelector('.menu');
  const menuItems = await page.evaluate(() => [...document.querySelectorAll('.menu .menu__item')].map((b) => b.textContent.trim()));
  ok('行内菜单不再有「移除」', !menuItems.some((t) => /移除/.test(t)), menuItems.join(' | '));

  await ctx.close();
}

/* ================= 2) 未登录：云端操作应置灰 ================= */
console.log('\n[2] 未登录时云端操作置灰');
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  // 访客上传在本部署里是关闭的，未登录上传会被直接弹去登录页 —— 所以这里
  // 先登录把文件传上来，再把 isAuthenticated 置回 false，专门验证按钮的
  // disabled 绑定（模板里 移动到/删除 都带 !isAuthenticated）。
  await boot(page, { authed: true });
  await upload(page, ['guest-a.png']);
  await page.evaluate(() => {
    const app = document.querySelector('#app')._vnode.component.proxy;
    app.isAuthenticated = false;
    app.toggleSelectMode();
    app.selectAll();
  });
  await page.waitForSelector('.selection-bar');
  const bar = await readBar(page, 0);
  ok('未登录 → 移动到/删除 置灰', bar.buttons[3].disabled && bar.buttons[4].disabled,
    `移动到=${bar.buttons[3].disabled} 删除=${bar.buttons[4].disabled}`);
  ok('未登录 → 下载/分享/复制链接 仍可用', !bar.buttons[0].disabled && !bar.buttons[1].disabled && !bar.buttons[2].disabled);
  ok('置灰按钮给出登录提示', /需要登录/.test(bar.buttons[3].title) && /需要登录/.test(bar.buttons[4].title));
  await ctx.close();
}

/* ================= 3) 已登录：历史记录条 ================= */
console.log('\n[3] 历史记录选择条（已登录）');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await boot(page, { authed: true });
  await upload(page, ['hist-a.png', 'hist-b.png']);
  await page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.openDrawer('history'));
  await page.waitForFunction(() => document.querySelector('#app')._vnode.component.proxy.activeDrawerTab === 'history');
  await page.waitForSelector('.hist-toolbar');

  // 先清空结果列表，让选择条只剩历史那一条，索引 0 才稳定
  await page.evaluate(() => { document.querySelector('#app')._vnode.component.proxy.clearResults(); });
  await page.waitForFunction(() => document.querySelector('#app')._vnode.component.proxy.uploadedFiles.length === 0);

  await page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.toggleHistorySelectAll());
  await page.waitForSelector('.selection-bar');
  const bar = await readBar(page, 0);
  ok('按钮集合 = 下载/复制链接/加入结果/移动到/删除',
    JSON.stringify(bar.buttons.map((b) => b.text)) === JSON.stringify(['下载', '复制链接', '加入结果', '移动到', '删除']),
    bar.buttons.map((b) => b.text).join(' | '));
  ok('已登录 → 移动到/删除 可点', !bar.buttons[3].disabled && !bar.buttons[4].disabled);

  const deleteCalls = [];
  page.on('request', (r) => { if (/\/api\/manage\/delete\//.test(r.url())) deleteCalls.push(r.url()); });
  await page.evaluate(() => {
    document.querySelector('#app')._vnode.component.proxy.deleteHistorySelected();
  });
  await page.waitForFunction(() => {
    const d = document.querySelector('#app')._vnode.component.proxy.dlg;
    return d && d.visible && d.mode === 'confirm';
  }, null, { timeout: 5000 });
  const t = await page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.dlg.title);
  ok('历史「删除」改走云端删除确认', t === '删除云端文件', t);
  await page.evaluate(() => document.querySelector('#app')._vnode.component.proxy.dlgConfirm());
  await page.waitForFunction(() => {
    const app = document.querySelector('#app')._vnode.component.proxy;
    return app.uploadHistory.length === 0 && app.historyBatchBusy === false;
  }, null, { timeout: 25000 });
  ok('确认后云端删除 + 本地历史清空', deleteCalls.length === 2, `${deleteCalls.length} 次 delete`);
  await ctx.close();
}

/* ================= 4) 批量下载：逐个触发且带间隔 ================= */
console.log('\n[4] 批量下载');
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await boot(page, { authed: true });
  await upload(page, ['dl-a.png', 'dl-b.png', 'dl-c.png']);

  await page.evaluate(() => {
    const app = document.querySelector('#app')._vnode.component.proxy;
    app.toggleSelectMode();
    app.selectAll();
  });
  await page.waitForFunction(() => document.querySelector('#app')._vnode.component.proxy.selectedCount === 3);

  // 探针：拦住真正的浏览器下载（headless 里也落不了地），只记录调用次数与时间差
  await page.evaluate(() => {
    const app = document.querySelector('#app')._vnode.component.proxy;
    window.__dl = [];
    app._doNativeDownload = (url, name) => { window.__dl.push({ name, t: performance.now() }); };
  });
  await page.evaluate(() => {
    document.querySelector('#app')._vnode.component.proxy.downloadSelected();
  });
  await page.waitForFunction(() => window.__dl.length === 3, null, { timeout: 15000 });
  const dl = await page.evaluate(() => window.__dl);
  ok('3 个文件逐个触发下载', dl.length === 3, dl.map((d) => d.name).join(' | '));
  ok('带文件名（不是空的 download 属性）', dl.every((d) => /\.png$/.test(d.name || '')));
  const gaps = dl.slice(1).map((d, i) => Math.round(d.t - dl[i].t));
  ok('触发之间有间隔（不被浏览器判为滥用）', gaps.every((g) => g >= 400), gaps.join('ms, ') + 'ms');
  await ctx.close();
}

await browser.close();

console.log('\n========================================');
if (errors.length) { console.log('页面错误：'); errors.forEach((e) => console.log('  ! ' + e)); }
console.log(`结果：通过 ${pass} 项，失败 ${fail} 项，页面错误 ${errors.length} 条`);
console.log('========================================');
process.exit(fail || errors.length ? 1 : 0);
