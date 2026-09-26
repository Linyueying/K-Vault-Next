// 同步状态点 —— 三态 + 失败重试 2 次 + 点击说明（admin.html + index.html）
//
// 背景：用户需要明确的「数据同步进度」反馈。
//   黄点 = 同步中，绿点 = 已同步，红点 = 同步失败（自动重试 2 次后仍失败）。
//   点击圆点弹出「为什么延迟不可避免」的说明。
//
// 实现分层（刻意这样做，避免两页漂移）：
//   - design-system.css : .sync-dot 四态样式 + 三条关键帧（唯一一份）
//   - app-core.js       : KVault.createSyncTracker() 状态机 / 重试 / 说明文案（唯一一份）
//   - admin.html / index.html : 只绑定 state 到 class，并把网络动作包进 track()
//
// 本脚本断言：
//   A. 两个页面都存在 .sync-dot，且初始为 idle（无 is-* 类）
//   B. 目录写入进行中 -> 黄点（is-syncing）；成功后 -> 绿点（is-synced）
//   C. 失败时自动重试 2 次（观察到的请求次数 = 3），最终 -> 红点（is-failed）
//   D. 红点常驻 + 弹出一条「同步失败」的 toast
//   E. 点击圆点弹出说明弹窗，且文案包含「为什么延迟不可避免」的核心说法
//   F. 全过程无 JS 报错
//   G. 延迟对照：注入 800ms 网络延迟后，圆点仍会进入黄点态（说明它反映的是真实链路）
//
// 前置：wrangler pages dev（带 KV + R2 绑定）跑在 BASE。
// 用法：
//   BASE=http://localhost:8099 node scripts/verify/sync-status.mjs
//
// 依赖：playwright-core（解析逻辑见 _playwright.mjs）
import { loadPlaywright, findChrome } from './_playwright.mjs';

const BASE = process.env.BASE || 'http://localhost:8099';
const USER = process.env.BASIC_USER || 'admin';
const PASS = process.env.BASIC_PASS || '123';

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  executablePath: findChrome(),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const results = [];
const log = (ok, name, detail) => {
  results.push({ ok, name, detail });
  console.log(`${ok ? '  [OK]  ' : '[FAIL] '} ${name}${detail ? '  — ' + detail : ''}`);
};

/**
 * 打开页面并登录。
 * @param {string} path
 * @param {{ latency?: number, failFolderWrite?: boolean }} opts
 *   - latency         : 给 /api/manage/folders 注入的延迟（ms）
 *   - failFolderWrite : 让 POST/PUT/DELETE 一律 500（用于验证失败重试）
 */
async function openPage(path, opts = {}) {
  const { latency = 0, failFolderWrite = false } = opts;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.request.post(`${BASE}/api/auth/login`, {
    data: { username: USER, password: PASS },
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).split('\n')[0]));

  let writeCount = 0;
  await page.route('**/api/manage/folders**', async (route) => {
    const m = route.request().method();
    if (m !== 'GET') writeCount += 1;
    if (failFolderWrite && m !== 'GET') {
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

  await page.goto(`${BASE}/${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);
  return { ctx, page, errors, writeCount: () => writeCount };
}

/* 读取 .sync-dot 当前的语义态（由 class 推导，与实现解耦） */
async function dotState(page) {
  return page.evaluate(() => {
    const el = document.querySelector('.sync-dot');
    if (!el) return 'missing';
    if (el.classList.contains('is-syncing')) return 'syncing';
    if (el.classList.contains('is-synced')) return 'synced';
    if (el.classList.contains('is-failed')) return 'failed';
    return 'idle';
  });
}

/* 轮询等待圆点达到某个态，返回耗时（-1 = 超时） */
async function waitDot(page, want, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((await dotState(page)) === want) return Date.now() - t0;
    await page.waitForTimeout(30);
  }
  return -1;
}

/* 观察圆点是否在 timeout 内「出现过」某态（用于捕获转瞬即逝的黄点） */
async function sawDot(page, want, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((await dotState(page)) === want) return true;
    await page.waitForTimeout(15);
  }
  return false;
}

// ============================== admin.html ==============================
async function testAdmin() {
  console.log('\n=== admin.html ===');

  // --- A. 存在 + 初始 idle ---
  {
    const { ctx, page, errors } = await openPage('admin.html');
    const has = await page.locator('.sync-dot').count();
    log(has > 0, 'admin 存在同步状态点', has > 0 ? `找到 ${has} 个` : '未找到');
    // 初始应为 idle 或 syncing（首屏会自动拉一次列表，可能已经在同步）
    const st = await dotState(page);
    log(st === 'idle' || st === 'syncing' || st === 'synced',
        'admin 初始态合法', st);
    log(errors.length === 0, 'admin 首屏无 JS 报错', errors.join(' | ') || '无');
    await ctx.close();
  }

  // --- B. 成功链路：黄 -> 绿 ---
  {
    const { ctx, page, errors } = await openPage('admin.html', { latency: 700 });
    // 等首屏安静下来，避免首屏同步干扰
    await page.waitForTimeout(1500);
    const name = `sync-admin-${Date.now()}`;
    await page.locator('button[title="新建目录"]').first().click({ force: true });
    await page.waitForTimeout(400);
    await page.locator('.dialog-input').fill(name);
    await page.locator('.dialog-actions .btn--primary').click({ force: true });

    const sawYellow = await sawDot(page, 'syncing', 4000);
    log(sawYellow, 'admin 写入中显示黄点(is-syncing)', sawYellow ? '已捕获' : '未捕获');

    const ms = await waitDot(page, 'synced', 12000);
    log(ms >= 0, 'admin 成功后显示绿点(is-synced)', ms < 0 ? '未达到' : `${ms}ms`);
    log(errors.length === 0, 'admin 成功链路无 JS 报错', errors.join(' | ') || '无');
    await ctx.close();
  }

  // --- C/D. 失败链路：重试 2 次 -> 红点 + toast ---
  {
    const { ctx, page, errors, writeCount } = await openPage('admin.html', { failFolderWrite: true });
    await page.waitForTimeout(1500);
    const name = `sync-adminfail-${Date.now()}`;
    await page.locator('button[title="新建目录"]').first().click({ force: true });
    await page.waitForTimeout(400);
    await page.locator('.dialog-input').fill(name);
    await page.locator('.dialog-actions .btn--primary').click({ force: true });

    const ms = await waitDot(page, 'failed', 15000);
    log(ms >= 0, 'admin 失败后显示红点(is-failed)', ms < 0 ? '未达到' : `${ms}ms`);

    /* toast 随「转为失败」一起弹出，只停留约 3s —— 必须紧接着读，
       放到后面的长等待之后读就过期了 */
    const toastText = await page.evaluate(() =>
      [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '));
    log(/同步失败/.test(toastText), 'admin 失败弹出 toast 提示', toastText || '无 toast');

    // 关键：自动重试 2 次 => 总请求次数应为 3（1 次原始 + 2 次重试）
    await page.waitForTimeout(1200);
    const n = writeCount();
    log(n === 3, 'admin 失败自动重试共 3 次尝试', `观察到 ${n} 次写请求`);

    // 红点常驻：再等 2.5s 仍应为 failed（不能自动变绿/消失）
    await page.waitForTimeout(2500);
    const still = await dotState(page);
    log(still === 'failed', 'admin 红点常驻不自动消失', still);
    log(errors.length === 0, 'admin 失败链路无 JS 报错', errors.join(' | ') || '无');
    await ctx.close();
  }

  // --- E. 点击圆点 -> 说明弹窗 ---
  {
    const { ctx, page, errors } = await openPage('admin.html');
    await page.waitForTimeout(1500);
    await page.locator('.sync-dot-btn').first().click({ force: true });
    await page.waitForTimeout(600);
    const body = await page.evaluate(() => document.body.innerText);
    const dialogVisible = await page.locator('.dialog-overlay').count();
    log(dialogVisible > 0, 'admin 点击圆点弹出说明弹窗', dialogVisible > 0 ? '已弹出' : '未弹出');
    log(/同步/.test(body) && /网络往返/.test(body),
        'admin 说明文案含「延迟不可避免」的解释',
        /网络往返/.test(body) ? '含网络往返说明' : '缺少关键说明');
    log(errors.length === 0, 'admin 弹窗无 JS 报错', errors.join(' | ') || '无');
    await ctx.close();
  }
}

// ============================== index.html ==============================
async function testIndex() {
  console.log('\n=== index.html ===');

  // index 的目录管理在上传抽屉里，先展开
  const openFolderTab = async (page) => {
    await page.locator('[data-dock-slot="2"]').first().click({ force: true }).catch(() => {});
    await page.waitForTimeout(900);
  };

  // --- A ---
  {
    const { ctx, page, errors } = await openPage('index.html');
    const has = await page.locator('.sync-dot').count();
    log(has > 0, 'index 存在同步状态点', has > 0 ? `找到 ${has} 个` : '未找到');
    log(errors.length === 0, 'index 首屏无 JS 报错', errors.join(' | ') || '无');
    await ctx.close();
  }

  // --- B ---
  {
    const { ctx, page, errors } = await openPage('index.html', { latency: 700 });
    await openFolderTab(page);
    await page.waitForTimeout(1200);
    const name = `sync-index-${Date.now()}`;
    await page.locator('.folder-new-trigger').click({ force: true });
    await page.waitForTimeout(300);
    await page.locator('.folder-new input').first().fill(name);
    await page.locator('.folder-new .btn--primary').click({ force: true });

    const sawYellow = await sawDot(page, 'syncing', 4000);
    log(sawYellow, 'index 写入中显示黄点(is-syncing)', sawYellow ? '已捕获' : '未捕获');
    const ms = await waitDot(page, 'synced', 12000);
    log(ms >= 0, 'index 成功后显示绿点(is-synced)', ms < 0 ? '未达到' : `${ms}ms`);
    log(errors.length === 0, 'index 成功链路无 JS 报错', errors.join(' | ') || '无');
    await ctx.close();
  }

  // --- C/D ---
  {
    const { ctx, page, errors, writeCount } = await openPage('index.html', { failFolderWrite: true });
    await openFolderTab(page);
    await page.waitForTimeout(1200);
    const name = `sync-indexfail-${Date.now()}`;
    await page.locator('.folder-new-trigger').click({ force: true });
    await page.waitForTimeout(300);
    await page.locator('.folder-new input').first().fill(name);
    await page.locator('.folder-new .btn--primary').click({ force: true });

    const ms = await waitDot(page, 'failed', 15000);
    log(ms >= 0, 'index 失败后显示红点(is-failed)', ms < 0 ? '未达到' : `${ms}ms`);

    /* toast 随「转为失败」一起弹出，只停留约 3s —— 必须紧接着读 */
    const toastText = await page.evaluate(() =>
      [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '));
    log(/同步失败/.test(toastText), 'index 失败弹出 toast 提示', toastText || '无 toast');

    await page.waitForTimeout(1200);
    const n = writeCount();
    log(n === 3, 'index 失败自动重试共 3 次尝试', `观察到 ${n} 次写请求`);
    await page.waitForTimeout(2500);
    const still = await dotState(page);
    log(still === 'failed', 'index 红点常驻不自动消失', still);
    log(errors.length === 0, 'index 失败链路无 JS 报错', errors.join(' | ') || '无');
    await ctx.close();
  }

  // --- E ---
  {
    const { ctx, page, errors } = await openPage('index.html');
    await page.waitForTimeout(1500);
    await page.locator('.sync-dot-btn').first().click({ force: true });
    await page.waitForTimeout(600);
    const body = await page.evaluate(() => document.body.innerText);
    const dialogVisible = await page.locator('.modal--dialog').count();
    log(dialogVisible > 0, 'index 点击圆点弹出说明弹窗', dialogVisible > 0 ? '已弹出' : '未弹出');
    log(/同步/.test(body) && /网络往返/.test(body),
        'index 说明文案含「延迟不可避免」的解释',
        /网络往返/.test(body) ? '含网络往返说明' : '缺少关键说明');
    log(errors.length === 0, 'index 弹窗无 JS 报错', errors.join(' | ') || '无');
    await ctx.close();
  }
}

await testAdmin();
await testIndex();

await browser.close();

const bad = results.filter((r) => !r.ok).length;
console.log('-'.repeat(64));
console.log(bad === 0 ? `全部通过（${results.length} 项）` : `异常 ${bad} / ${results.length} 项`);
process.exit(bad === 0 ? 0 : 1);
