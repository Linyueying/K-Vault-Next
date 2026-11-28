// Run against a static server at the repo root (BASE defaults to http://127.0.0.1:8788).
import assert from 'node:assert/strict';
import { findChrome, loadPlaywright } from './_playwright.mjs';

const base = process.env.BASE || 'http://127.0.0.1:8788';
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] });
const preview = { type: 'native-image', url: '/assets/img/logo-64.png', fileName: '示例图片' };

const cases = [
  { page: 'upload', mask: '.modal-mask', field: 'showDrawer', value: true, closed: false, watch: '.dock' },
  { page: 'upload', mask: '.modal-mask', field: 'shareDialogVisible', value: true, closed: false, watch: '.dock' },
  { page: 'upload', mask: '.modal-mask', field: 'airdropVisible', value: true, closed: false, watch: '.dock' },
  { page: 'gallery', mask: '.preview-backdrop', field: 'previewData', value: preview, closed: null },
  { page: 'share', mask: '.overlay', field: 'qrVisible', value: true, closed: false },
  { page: 'vault', mask: '.modal-backdrop', field: 'showGenerator', value: true, closed: false },
  { page: 'admin', mask: '.overlay', field: 'qrVisible', value: true, closed: false, watch: '.dock' },
  { page: 'admin', mask: '.ui-sheet-mask', field: 'accessSheet', value: 'webdav', closed: '', watch: '.dock' },
  { page: 'webdav', mask: '#sheetMask', panel: '#sheet-dav-test', open: '[data-open-sheet="dav-test"]' },
];

async function sample(page, test, opening) {
  return page.evaluate(async ({ test, opening }) => {
    const app = document.querySelector('#app')?.__vue_app__?._container?._vnode?.component?.proxy;
    if (test.field) app[test.field] = opening ? test.value : test.closed;
    else document.querySelector(opening ? test.open : `${test.panel} [data-close-sheet]`).click();

    const frames = [];
    const start = performance.now();
    do {
      await new Promise(requestAnimationFrame);
      const mask = document.querySelector(test.mask);
      const style = mask && getComputedStyle(mask);
      const watched = test.watch && document.querySelector(test.watch);
      frames.push({
        filter: style?.backdropFilter,
        opacity: !style || style.visibility === 'hidden' ? 0 : Number(style.opacity),
        watched: watched && getComputedStyle(watched).backdropFilter,
      });
    } while (performance.now() - start < 570);
    return frames;
  }, { test, opening });
}

try {
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (width === 1440) await page.addInitScript(() => localStorage.setItem('theme', 'dark'));
    await page.route('**/api/**', route => {
      const { pathname } = new URL(route.request().url());
      if (pathname === '/api/auth/check') return route.fulfill({ json: { authenticated: true, authRequired: true } });
      if (pathname === '/api/status') return route.fulfill({ json: { telegram: { enabled: true } } });
      return route.fulfill({ json: {} });
    });
    for (const test of cases) {
      const url = test.page === 'share' ? '/share.html?id=test' : `/${test.page}.html`;
      await page.goto(base + url);
      if (test.field) await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__);
      if (test.page === 'admin') await page.evaluate(() => {
        document.querySelector('#app').__vue_app__._container._vnode.component.proxy.goSection('access');
      });
      if (test.watch) await page.locator(test.watch).waitFor({ state: 'visible' });
      await page.waitForLoadState('networkidle');

      const opened = await sample(page, test, true);
      const closed = await sample(page, test, false);
      const label = `${width}px ${test.page} ${test.field || 'WebDAV'}`;
      const end = opened.at(-1);
      assert.equal(end.opacity, 1, label);
      assert.match(end.filter, /blur\([1-9]/, label);
      assert.equal(closed.at(-1).opacity, 0, label);
      for (const [phase, frames] of [['open', opened], ['close', closed]]) {
        const moving = frames.filter(({ opacity }) => opacity > 0 && opacity < 0.99);
        assert(moving.length > 1, `${label} ${phase}: expected intermediate opacity`);
        assert(moving.every(({ filter }) => filter === end.filter), `${label} ${phase}: blur changed during transition`);
      }
      if (test.watch) {
        assert.match(end.watched, /blur\(/, label);
        assert([...opened, ...closed].every(frame => frame.watched === end.watched), `${label}: dock filter changed`);
      }
      console.log(`OK ${label}`);
    }
    assert.deepEqual(errors, []);
    await page.close();
  }

  const page = await browser.newPage({ reducedMotion: 'reduce' });
  await page.goto(base + '/webdav.html');
  await page.evaluate(() => { document.documentElement.dataset.perf = 'low'; });
  const opened = await sample(page, cases.at(-1), true);
  assert.equal(opened.at(-1).opacity, 1);
  assert.equal(opened.at(-1).filter, 'none');
  const closed = await sample(page, cases.at(-1), false);
  assert.equal(closed.at(-1).opacity, 0);
  console.log('OK reduced motion and low performance');
} finally {
  await browser.close();
}
