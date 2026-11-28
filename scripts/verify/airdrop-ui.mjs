// Start a static server in the repository root before running this browser check.
import assert from 'node:assert/strict';
import { findChrome, loadPlaywright } from './_playwright.mjs';

const base = process.env.BASE || 'http://127.0.0.1:8788';
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
const nodes = [
  { key: 'telegram', label: 'Telegram', maxBytes: 1024 * 1024 },
  { key: 'r2', label: 'Cloudflare R2', maxBytes: 10 * 1024 * 1024 },
];

async function openPanel(viewport, { guest = false, dark = false, reducedMotion = 'no-preference', risky = false } = {}) {
  const page = await browser.newPage({ viewport, reducedMotion });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(dark => {
    if (dark) localStorage.setItem('theme', 'dark');
    window.noteStarts = [];
    const native = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      const node = native.call(this);
      const start = node.start.bind(node);
      node.start = (...args) => {
        window.noteStarts.push(node.frequency.value);
        return start(...args);
      };
      return node;
    };
  }, dark);
  let sessionStatus = 'waiting';
  const downloadHeaders = [];
  let cancellations = 0;
  const file = { name: risky ? 'invoice.pdf.exe' : 'sample.txt', size: 7, type: 'text/plain' };
  let allowUpload;
  const uploadGate = new Promise(resolve => { allowUpload = resolve; });
  let allowDownload;
  const downloadGate = new Promise(resolve => { allowDownload = resolve; });
  await page.route('**/api/**', async route => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/api/auth/check') return route.fulfill({ json: {
      authenticated: !guest,
      authRequired: true,
      airdrop: { enabled: true, guestAllowed: false, guestReceiveAllowed: true, nodes },
    } });
    if (pathname === '/api/status') return route.fulfill({ json: { guestUpload: { enabled: true }, r2: { enabled: true } } });
    if (pathname === '/api/airdrop/create') return route.fulfill({ json: {
      code: '012345', senderToken: 'sender', expiresAt: Date.now() + 300000,
    } });
    if (pathname === '/api/airdrop/join') {
      if (route.request().postDataJSON().code !== '012345') return route.fulfill({ status: 400, json: {} });
      sessionStatus = 'linked';
      return route.fulfill({ json: { code: '012345', receiverToken: 'receiver', expiresAt: Date.now() + 300000 } });
    }
    if (pathname === '/api/airdrop/status') {
      const session = { status: sessionStatus };
      if (guest && sessionStatus === 'uploaded') Object.assign(session, {
        fileCount: 1, totalSize: 7, files: [file], risks: risky ? [{ name: file.name, reasons: ['active'] }] : [],
      });
      return route.fulfill({ json: { session } });
    }
    if (pathname === '/api/airdrop/download') {
      downloadHeaders.push(route.request().headers()['x-kvault-accept-risk']);
      await downloadGate;
      return route.fulfill({ body: 'example', contentType: 'text/plain' });
    }
    if (pathname === '/api/airdrop/cancel') {
      cancellations += 1;
      return route.fulfill({ json: { ok: true } });
    }
    if (pathname === '/api/airdrop/complete') return route.fulfill({ json: { success: true } });
    if (pathname === '/api/airdrop/upload') {
      await uploadGate;
      sessionStatus = 'uploaded';
      return route.fulfill({ json: { success: true } });
    }
    if (pathname === '/api/manage/list') return route.fulfill({ json: { keys: [
      { name: 'r2:file.txt', metadata: { fileName: '云端样例.txt', fileSize: 23 } },
    ] } });
    return route.fulfill({ json: {} });
  });
  await page.goto(base + '/upload.html');
  await page.getByRole('button', { name: '隔空投送', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '隔空投送', exact: true });
  await panel.waitFor();
  return { page, panel, errors, changeStatus: value => { sessionStatus = value; }, allowUpload, allowDownload, downloadHeaders, cancellationCount: () => cancellations };
}

async function pairReceiver(receiver) {
  const { panel } = receiver;
  await panel.getByRole('button', { name: /接收/ }).click();
  const input = panel.getByRole('textbox', { name: '连接码' });
  assert.equal(await input.getAttribute('inputmode'), 'numeric');
  await input.fill('０12-345');
  assert.equal(await input.inputValue(), '012345');
  await panel.getByRole('button', { name: '连接', exact: true }).click();
  await panel.getByText('等待对方发送文件').waitFor();
}

try {
  const sender = await openPanel({ width: 360, height: 570 });
  const { page, panel } = sender;
  assert.equal(await panel.locator('.ad-orbit > span').evaluate(el => getComputedStyle(el).animationName), 'ad-arrive');
  await panel.getByRole('button', { name: /发送/ }).click();
  await panel.getByText('012345').waitFor();
  assert.equal(await panel.getByRole('img', { name: '投送连接二维码' }).locator('svg').count(), 1);
  assert.equal(await panel.locator('.ad-device__icon').last().evaluate(el => getComputedStyle(el, '::after').animationName), 'ad-signal-ripple');
  assert.equal(await panel.getByRole('button', { name: '从云端选取' }).count(), 0);
  sender.changeStatus('linked');
  await panel.getByRole('button', { name: '从云端选取' }).click();
  const picker = page.getByRole('dialog', { name: '从云端选取文件' });
  await picker.getByRole('button', { name: /云端样例/ }).click();
  await picker.getByRole('button', { name: '完成', exact: true }).click();
  await panel.locator('input[type="file"]').setInputFiles(Array.from({ length: 6 }, (_, i) => ({
    name: `很长的本地文件名-${i}.txt`, mimeType: 'text/plain', buffer: Buffer.alloc(400, i),
  })));
  const send = panel.getByRole('button', { name: '发送 7 个文件' });
  await send.waitFor();
  assert(await send.evaluate(el => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit && el.contains(hit) && box.bottom <= innerHeight;
  }));
  await send.click();
  const progress = panel.getByRole('progressbar', { name: '上传进度' });
  await progress.waitFor();
  assert(Number(await progress.getAttribute('value')) < 1);
  assert.equal(await panel.locator('.ad-flow__signal').evaluate(el => getComputedStyle(el).animationName), 'ad-travel');
  assert.equal(await panel.locator('.ad-flow__signal').evaluate(el => getComputedStyle(el).animationDirection), 'normal');
  sender.allowUpload();
  await panel.getByText('文件已就绪，等待对方接收。').waitFor();
  sender.changeStatus('done');
  await panel.getByText('对方已接收文件。').waitFor();
  assert.equal(await panel.locator('.ad-flow__bridge').evaluate(el => getComputedStyle(el, '::after').animationName), 'ad-signal-ripple');
  assert((await page.evaluate(() => window.noteStarts.length)) >= 10);
  assert.deepEqual(sender.errors, []);

  const receiver = await openPanel({ width: 1440, height: 900 }, { guest: true, dark: true });
  const recv = receiver.panel;
  assert(await recv.getByRole('button', { name: /发送/ }).isDisabled());
  const mute = recv.getByRole('button', { name: '提示音' });
  await mute.click();
  assert.equal(await mute.getAttribute('aria-pressed'), 'false');
  await pairReceiver(receiver);
  assert.deepEqual(await receiver.page.evaluate(() => window.noteStarts), []);
  receiver.changeStatus('failed');
  await recv.getByText('本次投送已中断').waitFor();
  await recv.getByRole('button', { name: '再来一次' }).click();
  await pairReceiver(receiver);
  const downloaded = receiver.page.waitForEvent('download');
  receiver.changeStatus('uploaded');
  await recv.getByRole('progressbar', { name: '接收进度' }).waitFor();
  assert.equal(await recv.locator('.ad-flow__signal').evaluate(el => getComputedStyle(el).animationDirection), 'reverse');
  receiver.allowDownload();
  assert.equal((await downloaded).suggestedFilename(), 'sample.txt');
  assert.deepEqual(receiver.downloadHeaders, [undefined]);
  await recv.getByText('文件已交给浏览器保存。').waitFor();
  assert.deepEqual(await receiver.page.evaluate(() => window.noteStarts), []);
  await recv.getByRole('button', { name: '关闭隔空投送' }).click();
  await recv.waitFor({ state: 'hidden' });
  await receiver.page.reload();
  await receiver.page.getByRole('button', { name: '隔空投送', exact: true }).click();
  assert.equal(await mute.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(receiver.errors, []);
  const risky = await openPanel({ width: 360, height: 570 }, { guest: true, risky: true });
  await pairReceiver(risky);
  risky.changeStatus('uploaded');
  const review = risky.page.getByRole('alertdialog', { name: '投送有风险提示' });
  await review.getByText('invoice.pdf.exe').waitFor();
  const cancelRisk = review.getByRole('button', { name: '取消接收' });
  assert.equal(await cancelRisk.evaluate(button => button === document.activeElement), true);
  assert.deepEqual(risky.downloadHeaders, []);
  await cancelRisk.click();
  await review.waitFor({ state: 'hidden' });
  assert.equal(risky.cancellationCount(), 1);
  assert.deepEqual(risky.downloadHeaders, []);

  await pairReceiver(risky);
  risky.changeStatus('uploaded');
  await review.getByRole('button', { name: '继续接收' }).waitFor();
  assert.deepEqual(risky.downloadHeaders, []);
  const riskyDownload = risky.page.waitForEvent('download');
  await review.getByRole('button', { name: '继续接收' }).click();
  risky.allowDownload();
  assert.equal((await riskyDownload).suggestedFilename(), 'invoice.pdf.exe');
  assert.deepEqual(risky.downloadHeaders, ['1']);
  assert.deepEqual(risky.errors, []);

  const still = await openPanel({ width: 390, height: 844 }, { reducedMotion: 'reduce' });
  assert.equal(await still.panel.locator('.ad-orbit > span').evaluate(el => getComputedStyle(el).animationName), 'none');
  await still.panel.getByRole('button', { name: /发送/ }).click();
  await still.panel.getByText('012345').waitFor();
  assert.equal(await still.panel.locator('.ad-device__icon').last().evaluate(el => getComputedStyle(el, '::after').animationName), 'none');
  assert.deepEqual(still.errors, []);
  console.log('OK small-screen send, cloud picker, directional transfer motion, reduced motion, Web Audio, numeric pairing and risk review');
} finally {
  await browser.close();
}
