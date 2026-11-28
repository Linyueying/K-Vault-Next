import assert from 'node:assert/strict';
import { findChrome, loadPlaywright } from './_playwright.mjs';

const base = process.env.BASE || 'http://127.0.0.1:8788';
const uploadPath = '/upload.html?source=test';
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });

try {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let guestEnabled = true;
  let authenticated = false;

  // Match the API contract: guest upload settings come from status, not auth/check.
  await page.route('**/api/auth/check', (route) => route.fulfill({
    json: { authRequired: true, authenticated },
  }));
  await page.route('**/api/status', (route) => route.fulfill({
    status: guestEnabled || authenticated ? 200 : 401,
    json: authenticated ? { telegram: { enabled: true } } : guestEnabled
      ? { guestUpload: { enabled: true, maxFileSize: 5 * 1024 * 1024, dailyLimit: 10 } }
      : { requireLogin: true },
  }));
  await page.route('**/api/auth/login', (route) => {
    authenticated = true;
    return route.fulfill({ json: { success: true } });
  });
  await page.route('**/api/site-branding', (route) => route.fulfill({
    json: { siteName: '示例网盘', siteTitle: '示例站点' },
  }));

  await page.goto(base + uploadPath);
  await page.getByText('访客上传每日最多 10 次').waitFor();
  assert.equal(await page.getByRole('button', { name: '选择文件' }).isEnabled(), true);
  await page.getByRole('link', { name: '登录账户' }).click();
  await page.waitForURL('**/login.html?*');
  assert.equal(new URL(page.url()).searchParams.get('redirect'), uploadPath);

  guestEnabled = false;
  await page.goto(base + uploadPath);
  await page.getByRole('heading', { name: '访客上传已关闭，请登录后上传' }).waitFor();
  const login = page.getByRole('link', { name: '去登录' });
  assert.equal(await login.evaluate((element) => element.tabIndex), 0);
  await login.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: '示例网盘' }).waitFor();
  assert.equal(await page.title(), '登录 · 示例站点');
  assert.equal(new URL(page.url()).searchParams.get('redirect'), uploadPath);

  await page.locator('#username').fill('test-admin');
  await page.locator('#password').fill('test-password');
  await page.locator('#loginBtn').click();
  await page.waitForURL(base + uploadPath);
  await page.getByRole('link', { name: '我的文件' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('访客上传允许、上传关闭、键盘登录、品牌和登录回跳均通过');
} finally {
  await browser.close();
}
