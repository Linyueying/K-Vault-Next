// 回归验证：访客横幅「登录账户」必须跳登录页
//
// 历史 bug：黄色访客横幅右侧的「登录账户」误绑 openDrawer('menu')，
// 点了会打开「系统导航」抽屉，而不是跳 /login.html。
//
// 本脚本在真实浏览器里把 Vue 实例的访客状态打开，点击该链接，
// 断言最终 URL 落到 /login.html（且带 redirect 回跳参数）。
//
// 用法：
//   1) 先起静态服务（仓库根目录）：
//        python3 -m http.server 8788 --bind 127.0.0.1
//   2) 跑：
//        node scripts/verify/guest-banner-login.mjs
//     端口不是 8788 时：
//        BASE=http://127.0.0.1:8099 node scripts/verify/guest-banner-login.mjs
//
// 依赖：playwright-core（解析逻辑见 _playwright.mjs）
import { loadPlaywright, findChrome } from './_playwright.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8788';

const { chromium } = await loadPlaywright();

// 与 index.html 的 data() 形状保持一致的最小访客配置
const GUEST_CONFIG = { maxFileSize: 50 * 1024 * 1024, maxDailyUploads: 10, enabled: true };

const results = [];
const record = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  [${pass ? 'OK  ' : 'FAIL'}] ${name}${pass ? '' : ' -> ' + detail}`);
};

const b = await chromium.launch({
  executablePath: findChrome(),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).split('\n')[0]));

  await page.goto(`${BASE}/index.html`, { waitUntil: 'load', timeout: 20000 });

  // 等 Vue 挂载完成。Vue 3 生产构建下 app._instance 为 null，
  // 根实例要从容器 vnode 上取：el.__vue_app__._container._vnode.component.proxy
  await page
    .waitForFunction(() => {
      const el = document.getElementById('app');
      const app = el && el.__vue_app__;
      const vnode = app && app._container && app._container._vnode;
      return !!(vnode && vnode.component && vnode.component.proxy);
    }, { timeout: 15000 })
    .catch(() => {});

  // 强行打开访客状态，让黄色横幅渲染出来
  const forced = await page.evaluate((cfg) => {
    const el = document.getElementById('app');
    const app = el && el.__vue_app__;
    const vnode = app && app._container && app._container._vnode;
    const proxy = vnode && vnode.component && vnode.component.proxy;
    if (!proxy) return 'no root proxy';
    try {
      proxy.authChecking = false;
      proxy.isGuest = true;
      proxy.guestUploadConfig = cfg;
      proxy.guestBlocked = false;
    } catch (e) {
      return 'assign failed: ' + e.message;
    }
    return 'ok';
  }, GUEST_CONFIG);
  record('访客状态注入成功', forced === 'ok', forced);

  const banner = page.locator('.guest-banner').first();
  await banner.waitFor({ state: 'visible', timeout: 5000 });
  record('访客横幅已渲染', true);

  const link = banner.locator('text=登录账户').first();
  await link.waitFor({ state: 'visible', timeout: 5000 });
  record('「登录账户」入口可见', true);

  // 关键断言：点击后必须离开首页去 /login.html，不能停在首页弹抽屉
  await Promise.all([
    page.waitForURL(/login\.html/, { timeout: 8000 }).catch(() => {}),
    link.click(),
  ]);

  const url = page.url();
  record('点击后跳转至 /login.html', /\/login\.html/.test(url), `实际 URL = ${url}`);
  record('携带 redirect 回跳参数', /redirect=/.test(url), `实际 URL = ${url}`);
  record('未停留在首页（回归点）', /\/login\.html/.test(url), `实际 URL = ${url}`);
  record('无 JS 报错', pageErrors.length === 0, pageErrors.join(' | '));

  await ctx.close();
} finally {
  await b.close();
}

const failed = results.filter((r) => !r.pass);
console.log('-'.repeat(58));
if (failed.length === 0) {
  console.log(`全部通过（${results.length} 项）`);
  process.exit(0);
} else {
  console.log(`异常 ${failed.length} 项 / 共 ${results.length} 项`);
  failed.forEach((f) => console.log(`  - ${f.name}: ${f.detail}`));
  process.exit(1);
}
