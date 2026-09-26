// admin.html 目录删除 —— 乐观更新 + 秒级响应回归
//
// 背景：删除目录会把目录内文件「移回根目录」（文件不删、直链不失效）。
// 后端需要逐个改写目录内所有文件的 metadata，文件多时耗时随数量线性增长
// （线上 Cloudflare KV 每次写是跨网络往返，300 个文件曾达约 9 秒）。
// 早期实现前端没有任何乐观更新，目录项要等「后端删完 + 两次全量刷新」全部
// 完成才从界面消失 —— 用户感受就是「点了删除，目录一直挂在界面上不动」。
//
// 修复后：
//   1. 前端乐观更新：确认后目录项立即从侧栏消失，请求在后台进行，失败回滚
//   2. 后端分批并发：串行 for-await 改为 Promise.allSettled 分批（默认 16/批）
//   3. 去掉删除后的 list?limit=1000 全量重拉
//
// 本脚本断言：
//   A. 点确认后目录项从【目录树】消失的耗时（乐观更新生效，应 < 300ms）
//   B. 删除后不再发出 list 全量请求（冗余刷新已消除）
//   C. 后端失败时目录项能正确回滚到界面（乐观更新的安全网）
//   D. 全过程无 JS 报错
//
// 前置：wrangler pages dev（带 KV + R2 绑定）跑在 BASE，且已登录可用。
// 用法：
//   BASE=http://localhost:8099 node scripts/verify/folder-delete.mjs
//
// 依赖：playwright-core（解析逻辑见 _playwright.mjs）
import { loadPlaywright, findChrome } from './_playwright.mjs';

const BASE = process.env.BASE || 'http://localhost:8099';
const USER = process.env.BASIC_USER || 'admin';
const PASS = process.env.BASIC_PASS || '123';
const FOLDER = process.env.TEST_FOLDER || 'verify-deltest';
// 回滚用例需要独立数据：成功用例会把目录删掉，不能复用同一个
const FOLDER_ROLLBACK = process.env.TEST_FOLDER_RB || 'verify-deltest-rb';

// 乐观更新消失阈值：本地实测 2ms，给足余量（含渲染与轮询间隔）
const OPTIMISTIC_MAX_MS = 300;

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

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.request.post(`${BASE}/api/auth/login`, {
    data: { username: USER, password: PASS },
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).split('\n')[0]));
  const api = [];
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/api/manage/')) api.push({ method: r.method(), url: u.replace(BASE, '') });
  });
  await page.goto(`${BASE}/admin.html`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  return { ctx, page, errors, api };
}

// 目录树里是否存在某节点
const hasFolderNode = (page, name) => page.evaluate(
  (n) => [...document.querySelectorAll('.folder-tree-name')].some((e) => e.textContent.trim() === n),
  name,
);

// ---------- 场景 1：成功路径（乐观更新 + 无冗余刷新） ----------
{
  const { ctx, page, errors, api } = await newPage();
  const row = page.locator('.folder-tree-row').filter({ hasText: FOLDER }).first();
  if (!(await row.count())) {
    log(false, '目录存在性', `目录树里找不到「${FOLDER}」（请先用 _seed-kv.mjs 造数据）`);
  } else {
    await row.click();
    await page.waitForTimeout(600);

    api.length = 0;
    await page.locator('button[title*="删除当前目录"]').first().click({ force: true });
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: '确认删除' }).last().click({ force: true });

    // A. 乐观更新耗时
    const t0 = Date.now();
    let gone = -1;
    for (let i = 0; i < 200; i++) {
      if (!(await hasFolderNode(page, FOLDER))) { gone = Date.now() - t0; break; }
      await page.waitForTimeout(10);
    }
    log(
      gone >= 0 && gone <= OPTIMISTIC_MAX_MS,
      'A. 乐观更新：目录项立即消失',
      gone < 0 ? '未消失' : `${gone}ms（阈值 ${OPTIMISTIC_MAX_MS}ms）`,
    );

    await page.waitForTimeout(2500);

    // B. 不应再有 list 全量重拉
    const listCalls = api.filter((x) => x.url.includes('/api/manage/list'));
    log(listCalls.length === 0, 'B. 无冗余 list 全量刷新', listCalls.length ? JSON.stringify(listCalls) : '未发出');

    // 删除请求确实发出，且带 recursive
    const delCall = api.find((x) => x.method === 'DELETE' && x.url.includes('/api/manage/folders'));
    log(!!delCall && delCall.url.includes('recursive=1'), 'C. DELETE 请求正确发出',
      delCall ? delCall.url : '未见 DELETE 请求');

    // 后端状态：目录已从列表移除
    const after = await ctx.request.get(`${BASE}/api/manage/folders`);
    const fj = await after.json().catch(() => ({}));
    const stillThere = (fj.folders || []).some((f) => f.path === FOLDER);
    log(!stillThere, 'D. 后端目录已删除', stillThere ? '后端仍返回该目录' : '已从后端列表移除');

    log(errors.length === 0, 'E. 无 JS 报错', errors.length ? errors.join(' | ') : '无');
  }
  await ctx.close();
}

// ---------- 场景 2：失败回滚 ----------
{
  const { ctx, page } = await newPage();
  // 拦截 DELETE 强制失败
  await page.route('**/api/manage/folders**', async (route) => {
    if (route.request().method() === 'DELETE') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'verify: simulated failure' }),
      });
    } else {
      await route.continue();
    }
  });

  const row = page.locator('.folder-tree-row').filter({ hasText: FOLDER_ROLLBACK }).first();
  if (!(await row.count())) {
    log(false, '失败回滚', `目录「${FOLDER_ROLLBACK}」不存在，跳过`);
  } else {
    await row.click();
    await page.waitForTimeout(600);
    await page.locator('button[title*="删除当前目录"]').first().click({ force: true });
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: '确认删除' }).last().click({ force: true });

    await page.waitForTimeout(2500);
    const rolledBack = await hasFolderNode(page, FOLDER_ROLLBACK);
    log(rolledBack, 'F. 后端失败时目录项回滚到界面', rolledBack ? '已回滚' : '未回滚（目录消失在界面上）');
  }
  await ctx.close();
}

await browser.close();

const bad = results.filter((r) => !r.ok).length;
console.log('-'.repeat(60));
console.log(bad === 0 ? `全部通过（${results.length} 项）` : `异常 ${bad} / ${results.length} 项`);
process.exit(bad === 0 ? 0 : 1);
