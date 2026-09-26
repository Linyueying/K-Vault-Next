// 目录操作（新建 / 删除）—— 乐观更新与秒级响应回归（admin.html + index.html）
//
// 背景：目录的增删都要走 /api/manage/folders。移除目录的语义是「把目录内文件
// 移回根目录」（文件不删、直链不失效），后端需逐个改写目录内所有文件的 metadata，
// 文件多时耗时随数量线性增长（线上 Cloudflare KV 每次写是跨网络往返，
// 300 个文件曾达约 9 秒）。
//
// 早期实现有三处叠加，导致用户感受为「点了之后界面一直挂着不动」：
//   1. 前端零乐观更新 —— 目录项要等「后端处理完 + 全量刷新」全部完成才变化
//   2. 后端串行 for...await —— 每个文件一次完整 KV 网络往返
//   3. 删除/创建后 refresh() 重拉 list?limit=1000 + includeStats
//
// 修复后：
//   - admin.html：createFolder / deleteFolder / renameFolder 均改为乐观更新
//   - index.html：createUploadFolder / handleDeleteFolder / handleRenameFolder
//     同样把本地状态变更提到 await 之前（原先是在 await 之后才补状态，
//     等于没有乐观更新），失败回滚
//   - functions/api/manage/folders.js：串行 for-await 改 Promise.allSettled 分批并发
//
// 本脚本断言（**核心是「耗时与网络延迟解耦」**）：
//   A. 新建目录：确认后目录出现在界面（admin 目录树 / index 目录树）
//   B. 删除目录：确认后目录从界面消失
//   C. 关键回归 —— 叠加人为网络延迟后，A/B 的界面响应耗时**不应随之增长**
//      （乐观更新的定义：UI 不等后端）。延迟翻倍而耗时不变才算通过。
//   D. 后端失败时能回滚（乐观更新的安全网）
//   E. 全过程无 JS 报错
//
// 前置：wrangler pages dev（带 KV + R2 绑定）跑在 BASE，已登录可用。
// 用法：
//   BASE=http://localhost:8099 node scripts/verify/folder-ops.mjs
//   加 SIM_LATENCY=1 可启用网络延迟对照（更慢，但证明力更强）
//
// 依赖：playwright-core（解析逻辑见 _playwright.mjs）
import { loadPlaywright, findChrome } from './_playwright.mjs';

const BASE = process.env.BASE || 'http://localhost:8099';
const USER = process.env.BASIC_USER || 'admin';
const PASS = process.env.BASIC_PASS || '123';
const SIM_LATENCY = process.env.SIM_LATENCY === '1';

// 乐观更新阈值：本地实测 2-5ms，给足余量与渲染时间
const OPTIMISTIC_MAX_MS = 400;
// 模拟网络延迟（ms）。用它证明「界面耗时不随延迟变化」。
const LAT = Number(process.env.LAT_MS || 600);

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  executablePath: findChrome(),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

// 会话 cookie：wrangler 签发的 k_vault_session 带 Secure 属性，
// playwright 的 APIRequestContext 在 http:// 下不会自动携带（浏览器对
// localhost 有豁免、独立 request 上下文没有），导致建目录/查询悄悄 401。
// 这里登录一次显式读出来，凡「服务端校验」类请求手动带上。
const AUTH = await (async () => {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('登录失败：拿不到会话 cookie');
  return { Cookie: cookie };
})();

// 建目录（不经 UI，保证前置数据存在），返回是否成功
async function apiCreateFolder(path) {
  const r = await fetch(`${BASE}/api/manage/folders`, {
    method: 'POST',
    headers: { ...AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  }).catch(() => null);
  return !!(r && r.ok);
}

// 查询目录列表（带会话），失败返回 {}
async function apiListFolders() {
  return fetch(`${BASE}/api/manage/folders`, { headers: AUTH })
    .then((r) => r.json())
    .catch(() => ({}));
}

// 清理测试目录
async function apiDeleteFolder(path) {
  await fetch(`${BASE}/api/manage/folders?path=${encodeURIComponent(path)}&recursive=1`, {
    method: 'DELETE', headers: AUTH,
  }).catch(() => {});
}

const results = [];
const log = (ok, name, detail) => {
  results.push({ ok, name, detail });
  console.log(`${ok ? '  [OK]  ' : '[FAIL] '} ${name}${detail ? '  — ' + detail : ''}`);
};

async function newPage(path, { latency = 0, failMethods = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.request.post(`${BASE}/api/auth/login`, { data: { username: USER, password: PASS } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).split('\n')[0]));

  if (latency > 0 || failMethods.length) {
    await page.route('**/api/manage/folders**', async (route) => {
      const m = route.request().method();
      if (failMethods.includes(m)) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: 'verify: simulated failure' }),
        });
        return;
      }
      if (latency > 0) await new Promise((r) => setTimeout(r, latency));
      await route.continue();
    });
  }
  await page.goto(`${BASE}/${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  return { ctx, page, errors };
}

// 轮询等待：目录树出现/消失某节点，返回耗时（-1 = 超时）
async function waitFolderInTree(page, name, want, timeoutMs = 12000) {
  const sel = '.folder-tree-name, .tree-row__name';
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const has = await page.evaluate(
      ([s, n]) => [...document.querySelectorAll(s)].some((e) => e.textContent.trim() === n),
      [sel, name],
    );
    if (has === want) return Date.now() - t0;
    await page.waitForTimeout(5);
  }
  return -1;
}

// ============ admin.html ============
async function testAdmin({ latency = 0, label = '' } = {}) {
  // --- 新建目录 ---
  {
    const { ctx, page, errors } = await newPage('admin.html', { latency });
    const name = `vfy-admin-${Date.now()}`;
    await page.locator('button[title="新建目录"]').first().click({ force: true });
    await page.waitForTimeout(400);
    await page.locator('.dialog-input').fill(name);
    await page.locator('.dialog-actions .btn--primary').click({ force: true });
    const ms = await waitFolderInTree(page, name, true);
    log(
      ms >= 0 && ms <= OPTIMISTIC_MAX_MS,
      `admin 新建目录${label}`,
      ms < 0 ? '未出现' : `${ms}ms`,
    );
    log(errors.length === 0, `admin 新建目录无 JS 报错${label}`, errors.join(' | ') || '无');
    // 落库校验
    await page.waitForTimeout(1200);
    const fj = await apiListFolders();
    const persisted = (fj.folders || []).some((f) => f.path === name);
    log(persisted, `admin 新建目录已落库${label}`, persisted ? '后端可见' : '后端不可见');
    if (persisted) await apiDeleteFolder(name);
    await ctx.close();
  }

  // --- 删除目录（乐观 + 回滚）---
  {
    const created = `vfy-admindel-${Date.now()}`;
    // 直接用请求建目录（不经 UI，保证前置数据存在）
    const createdOk = await apiCreateFolder(created);
    if (!createdOk) {
      log(false, `admin 删除目录${label}`, '前置建目录失败（API 401/500）');
    } else {
    const { ctx, page, errors } = await newPage('admin.html', { latency });
    const row = page.locator('.folder-tree-row').filter({ hasText: created }).first();
    if (!(await row.count())) {
      log(false, `admin 删除目录${label}`, `目录树找不到「${created}」`);
    } else {
      await row.click();
      await page.waitForTimeout(500);
      await page.locator('button[title*="删除当前目录"]').first().click({ force: true });
      await page.waitForTimeout(400);
      await page.getByRole('button', { name: '确认删除' }).last().click({ force: true });
      const ms = await waitFolderInTree(page, created, false);
      log(ms >= 0 && ms <= OPTIMISTIC_MAX_MS, `admin 删除目录${label}`, ms < 0 ? '未消失' : `${ms}ms`);
      log(errors.length === 0, `admin 删除目录无 JS 报错${label}`, errors.join(' | ') || '无');
    }
    await ctx.close();
    }
  }

  // --- 失败回滚 ---
  // 注：回滚是纯前端逻辑（本地状态还原），与网络快慢无关，
  //    故这里不叠加 latency —— 叠加反而会引入 `networkidle` 等竞态。
  {
    const { ctx, page } = await newPage('admin.html', { failMethods: ['POST'] });
    const name = `vfy-adminrb-${Date.now()}`;
    await page.locator('button[title="新建目录"]').first().click({ force: true });
    await page.waitForTimeout(400);
    await page.locator('.dialog-input').fill(name);
    await page.locator('.dialog-actions .btn--primary').click({ force: true });
    // 乐观出现
    const appeared = await waitFolderInTree(page, name, true, 4000);
    await page.waitForTimeout(2500);
    const rolledBack = !(await page.evaluate(
      ([s, n]) => [...document.querySelectorAll(s)].some((e) => e.textContent.trim() === n),
      ['.folder-tree-name, .tree-row__name', name],
    ));
    log(appeared >= 0 && rolledBack, 'admin 新建目录失败回滚', rolledBack ? '已回滚' : '未回滚');
    await ctx.close();
  }
}

// ============ index.html ============
async function testIndex({ latency = 0, label = '' } = {}) {
  // --- 新建目录 ---
  {
    const { ctx, page, errors } = await newPage('index.html', { latency });
    await page.locator('[data-dock-slot="2"]').first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(800);
    const name = `vfy-index-${Date.now()}`;
    await page.locator('.folder-new-trigger').click({ force: true });
    await page.waitForTimeout(300);
    await page.locator('.folder-new input').first().fill(name);
    await page.locator('.folder-new .btn--primary').click({ force: true });
    const ms = await waitFolderInTree(page, name, true);
    log(ms >= 0 && ms <= OPTIMISTIC_MAX_MS, `index 新建目录${label}`, ms < 0 ? '未出现' : `${ms}ms`);
    log(errors.length === 0, `index 新建目录无 JS 报错${label}`, errors.join(' | ') || '无');
    await page.waitForTimeout(1200);
    const fj = await apiListFolders();
    const persisted = (fj.folders || []).some((f) => f.path === name);
    log(persisted, `index 新建目录已落库${label}`, persisted ? '后端可见' : '后端不可见');
    if (persisted) await apiDeleteFolder(name);
    await ctx.close();
  }

  // --- 删除目录 ---
  {
    const created = `vfy-indexdel-${Date.now()}`;
    const createdOk = await apiCreateFolder(created);
    if (!createdOk) {
      log(false, `index 删除目录${label}`, '前置建目录失败（API 401/500）');
    }

    const { ctx, page, errors } = await newPage('index.html', { latency });
    await page.locator('[data-dock-slot="2"]').first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(800);
    const row = page.locator('.tree-row').filter({ hasText: created }).first();
    if (!(await row.count())) {
      log(false, `index 删除目录${label}`, `目录树找不到「${created}」`);
    } else {
      // 目录节点上的删除按钮：hover 显现的 tree-row__actions 里的垃圾桶
      const delBtn = page.locator('.tree-row').filter({ hasText: created }).locator('button[title*="删除"], button[title*="删除目录"]').first();
      if (!(await delBtn.count())) {
        log(false, `index 删除目录${label}`, '未找到删除按钮');
      } else {
        await delBtn.click({ force: true });
        await page.waitForTimeout(500);
        // 危险确认弹窗
        const okBtn = page.getByRole('button', { name: /删除目录|确认|删除/ }).last();
        await okBtn.click({ force: true });
        const ms = await waitFolderInTree(page, created, false);
        log(ms >= 0 && ms <= OPTIMISTIC_MAX_MS, `index 删除目录${label}`, ms < 0 ? '未消失' : `${ms}ms`);
        log(errors.length === 0, `index 删除目录无 JS 报错${label}`, errors.join(' | ') || '无');
      }
    }
    await ctx.close();
  }

  // --- 失败回滚 ---
  // 回滚是纯前端逻辑，与网络快慢无关，不叠加 latency（避免引入竞态）。
  {
    const { ctx, page } = await newPage('index.html', { failMethods: ['POST'] });
    await page.locator('[data-dock-slot="2"]').first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(800);
    const name = `vfy-indexrb-${Date.now()}`;
    await page.locator('.folder-new-trigger').click({ force: true });
    await page.waitForTimeout(300);
    await page.locator('.folder-new input').first().fill(name);
    await page.locator('.folder-new .btn--primary').click({ force: true });
    const appeared = await waitFolderInTree(page, name, true, 4000);
    await page.waitForTimeout(2500);
    const rolledBack = !(await page.evaluate(
      ([s, n]) => [...document.querySelectorAll(s)].some((e) => e.textContent.trim() === n),
      ['.folder-tree-name, .tree-row__name', name],
    ));
    log(appeared >= 0 && rolledBack, 'index 新建目录失败回滚', rolledBack ? '已回滚' : '未回滚');
    await ctx.close();
  }
}

console.log('=== 基础场景（无网络延迟）===');
await testAdmin();
await testIndex();

if (SIM_LATENCY) {
  console.log(`\n=== 网络延迟对照（${LAT}ms/请求）—— 界面耗时应不变，证明 UI 不等后端 ===`);
  await testAdmin({ latency: LAT, label: ` [延迟${LAT}ms]` });
  await testIndex({ latency: LAT, label: ` [延迟${LAT}ms]` });
} else {
  console.log('\n（加 SIM_LATENCY=1 可跑网络延迟对照，验证界面耗时与延迟解耦）');
}

await browser.close();

const bad = results.filter((r) => !r.ok).length;
console.log('-'.repeat(64));
console.log(bad === 0 ? `全部通过（${results.length} 项）` : `异常 ${bad} / ${results.length} 项`);
process.exit(bad === 0 ? 0 : 1);
