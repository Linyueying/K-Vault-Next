#!/usr/bin/env node
/**
 * anim-perf.mjs —— 动画 / 渲染性能量化采样器
 *
 * 用途：给「动画性能优化」提供可复现的数字证据。改动画前后各跑一次，对比四个维度：
 *   1. 长帧数 longFrames：连续 rAF 间隔 > 50ms 的帧数（跟 design-system.css:1538
 *      注释里「34 帧里有 9 帧超过 50ms」同一口径）
 *   2. p95Frame / maxFrame：帧间隔分位与峰值
 *   3. 强制布局计数 gBCR / gCS：monkey-patch Element.prototype.getBoundingClientRect
 *      与 window.getComputedStyle 计数。这是直接证明「<transition-group> 在 render 期
 *      对每个子节点调 getBoundingClientRect」这笔开销的硬指标
 *   4. CDP Performance ：LayoutCount / LayoutDuration / RecalcStyleCount /
 *      RecalcStyleDuration 的前后差值
 *
 * 用法（先起本地全栈，见 scripts/verify/README.md）：
 *   BASE=http://127.0.0.1:8080 CHROME_PATH=/usr/bin/chromium node scripts/verify/anim-perf.mjs
 *   # 凭据默认 admin/admin，可用 ADMIN_USER / ADMIN_PASS 覆盖
 *   # S4 依赖后台有文件数据；没有数据会跳过（不算失败）
 *   # REPEAT=n 每个场景跑 n 轮取各指标中位数（默认 3，务必别用 1，见下方说明）
 *
 * ⚠️ 刻意打开 reducedMotion:'no-preference' —— 本脚本要测的就是动画期间的开销，
 *    与 visual-snapshot.mjs（reducedMotion:'reduce'，为了快照稳定）正好相反。
 *
 * ---------------------------------------------------------------------------
 * BASELINE（改造前，2026-10-09 测于本 Sandbox / Chromium / 视口 1280×800）
 * 见文件底部 BASELINE_JSON 常量，由 `npm run perf:baseline` 写入。改完后跑
 * `node scripts/verify/anim-perf.mjs --compare` 输出下降百分比。
 * ---------------------------------------------------------------------------
 */

import { loadPlaywright, findChrome } from './_playwright.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_FILE = path.join(HERE, 'anim-perf-baseline.json');

const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';
const VIEWPORT = { width: 1280, height: 800 };
const LONG_FRAME_MS = 50;

/* ---------------------------------------------------------------- 工具 */

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))].toFixed(1);
};

const frameStats = (deltas) => ({
  frames: deltas.length,
  longFrames: deltas.filter((d) => d > LONG_FRAME_MS).length,
  p95Frame: pct(deltas, 0.95),
  maxFrame: +Math.max(0, ...deltas).toFixed(1),
});

/* 页面内取 Vue 根实例。项目用的是全局 Vue 3，没走 __vue_app__._instance 那套，
   与 scripts/verify/select-bar.mjs 保持一致。 */
const APP_PROBE = 'document.querySelector("#app")?._vnode?.component?.proxy';

/* ⚠️ 刻意不用 page.waitForFunction：默认 polling 是 'raf'，在「500 条历史卡片 +
   常驻无限动画」把主线程压满时，它的轮询观察不到 DOM 变化，会一直等到超时 ——
   而同一时刻 page.evaluate 能正常读到 DOM。手动轮询更稳也更可控。 */
const pollUntil = async (page, expr, timeout = 30000, gap = 250) => {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    try {
      last = await page.evaluate(expr);
    } catch {
      last = null;
    }
    if (last) return last;
    await page.waitForTimeout(gap);
  }
  return last;
};

const waitApp = (page, extra = 'true', timeout = 30000) =>
  pollUntil(page, `(() => { const app = ${APP_PROBE}; return !!app && (${extra}); })()`, timeout);

/* ------------------------------------------------------------ 采样器 */

/** 连续 rAF 采样 ms 毫秒，返回相邻帧间隔数组（丢弃第一帧的启动抖动） */
const sampleFrames = (page, ms) =>
  page.evaluate(
    (ms) =>
      new Promise((res) => {
        const out = [];
        const t0 = performance.now();
        let last = t0;
        const tick = (now) => {
          out.push(now - last);
          last = now;
          if (now - t0 < ms) requestAnimationFrame(tick);
          else res(out.slice(1));
        };
        requestAnimationFrame(tick);
      }),
    ms
  );

const readCounters = (page) => page.evaluate(() => ({ ...window.__perfCounters }));

const diff = (a, b) => ({
  LayoutCount: +(b.LayoutCount - a.LayoutCount).toFixed(0),
  LayoutDuration: +((b.LayoutDuration - a.LayoutDuration) * 1000).toFixed(1),
  RecalcStyleCount: +(b.RecalcStyleCount - a.RecalcStyleCount).toFixed(0),
  RecalcStyleDuration: +((b.RecalcStyleDuration - a.RecalcStyleDuration) * 1000).toFixed(1),
  gBCR: b.gBCR - a.gBCR,
  gCS: b.gCS - a.gCS,
});

/* --------------------------------------------------------- 场景定义 */

const scenarios = [];
const scenario = (id, title, fn) => scenarios.push({ id, title, fn });

/* S1 —— 上传队列 100 项：最热路径，队列 View 合帧 + 逐行 transition 开销 */
scenario('S1', '首页上传队列（100 个小文件）', async (page, ctxClient) => {
  await waitApp(page, '!app.authChecking');
  await page.evaluate(() => {
    const app = document.querySelector('#app')._vnode.component.proxy;
    app.setStorageMode('r2', true);
  });
  await page.waitForTimeout(300);

  const c0 = await readCounters(page);
  const m0 = await ctxClient.metrics();

  await page.evaluate(() => {
    const app = document.querySelector('#app')._vnode.component.proxy;
    const files = [];
    for (let i = 0; i < 100; i++) {
      files.push(new File([new Uint8Array(2048).fill(65 + (i % 26))], `perf-s1-${i}.png`, { type: 'image/png' }));
    }
    app.processFiles(files);
  });

  const frames = await sampleFrames(page, 3000);
  const m1 = await ctxClient.metrics();
  const c1 = await readCounters(page);

  return { ...frameStats(frames), ...diff({ ...c0, ...m0 }, { ...c1, ...m1 }) };
});

/* S2 —— 交付结果列表：直接注入 100 条已完成条目，量化列表整体重渲染的成本。
   不走真实上传：本地 telegram 不可达、r2 未开，真实上传会全部失败导致
   uploadedFiles 始终为空。注入的是 processFiles 成功后真正写入的对象形状
   （index.js:2638 { name, fileName, url, size, selected }），渲染路径完全一致。 */
scenario('S2', '交付结果列表 100 条（切换选择模式全量重渲染）', async (page, ctxClient) => {
  await waitApp(page, '!app.authChecking');
  await page.evaluate(() => {
    const app = document.querySelector('#app')._vnode.component.proxy;
    const items = [];
    for (let i = 0; i < 100; i++) {
      items.push({
        name: `perf-r-${i}.png`,
        fileName: `perf-r-${i}.png`,
        url: `/file/perf-r-${i}.png`,
        size: 2048 * (i + 1),
        selected: false,
      });
    }
    app.uploadedFiles = items;
  });
  await page.waitForSelector('.list--card > .row', { timeout: 15000 });
  const rows = await page.evaluate(() => document.querySelectorAll('.list--card > .row').length);
  await page.waitForTimeout(600);

  const c0 = await readCounters(page);
  const m0 = await ctxClient.metrics();

  const t0 = Date.now();
  const frames = await sampleFrames(page, 1600);
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => {
      const app = document.querySelector('#app')._vnode.component.proxy;
      app.resultSelectMode = !app.resultSelectMode;
    });
    await page.waitForTimeout(300);
  }

  const m1 = await ctxClient.metrics();
  const c1 = await readCounters(page);

  return { ...frameStats(frames), ...diff({ ...c0, ...m0 }, { ...c1, ...m1 }), rows, wallMs: Date.now() - t0 };
});

/* S3 —— 本地历史 500 条：全站最大单点（每个日期分组一个 transition-group） */
const HIST_READY =
  '(() => { const a = document.querySelector("#app")?._vnode?.component?.proxy; return a && a.uploadHistory.length >= 500; })()';
scenario('S3', '本地历史 500 条（切视图 + 滚动）', async (page, ctxClient) => {
  // 必须等 #app.is-booted —— 挂载期间 app 会用自己的 loadHistory() 回填，
  // 在这之前赋值会被整体覆盖掉（表现为 uploadHistory 变回 0 条）。
  await page.waitForSelector('#app.is-booted', { timeout: 30000 });
  await page.waitForTimeout(1200);
  // 赋值后可能仍被回填覆盖，用带重试的等待把最终状态钉住
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.evaluate(() => {
      const app = document.querySelector('#app')._vnode.component.proxy;
      if (app.uploadHistory.length >= 500) return;
      const items = [];
      for (let i = 0; i < 500; i++) {
        items.push({
          id: 'perf-h-' + i,
          name: '历史文件-' + i + '.png',
          fileName: '历史文件-' + i + '.png',
          url: '/file/perf-h-' + i + '.png',
          size: 1024 * (i % 90 + 1),
          storageMode: 'r2',
          folderPath: '',
          uploadTime: Date.now() - i * 60000,
          selected: false,
        });
      }
      app.uploadHistory = items;
    });
    if (await pollUntil(page, HIST_READY, 4000)) break;
    await page.waitForTimeout(600);
  }
  if (!(await pollUntil(page, HIST_READY, 20000))) throw new Error('uploadHistory 未达到 500 条');
  await page.evaluate(() => {
    document.querySelector('#app')._vnode.component.proxy.openDrawer('history');
  });
  // ⚠️ 不能用 waitForSelector('.drawer-pane') 的默认 visible 判定 —— 抽屉容器在
  // 转场期间高度为 0，playwright 会一直等到超时，尽管 500 张卡片早已渲染完毕。
  const cardCount = await pollUntil(page, 'document.querySelectorAll(".hist-card, .hist-row").length', 30000);
  if (!cardCount) {
    const dump = await page.evaluate(() => {
      const a = document.querySelector('#app')?._vnode?.component?.proxy;
      return {
        histLen: a?.uploadHistory?.length, showDrawer: a?.showDrawer, tab: a?.activeDrawerTab,
        view: a?.historyView, sorted: a?.historySorted?.length, groups: a?.historyGroups?.length,
        panes: document.querySelectorAll('.drawer-pane').length,
        cards: document.querySelectorAll('.hist-card').length,
        rows: document.querySelectorAll('.hist-row').length,
      };
    });
    throw new Error('历史卡片未渲染，现场=' + JSON.stringify(dump));
  }
  await page.waitForTimeout(900);

  const c0 = await readCounters(page);
  const m0 = await ctxClient.metrics();

  // 采样与「触发动作」并发发起（Promise.all）：既保证 rAF 采样窗口覆盖动作本身，
  // 也避免悬空 Promise 在场景失败后变成 unhandled rejection 拖垮整个进程。
  const [framesToggle] = await Promise.all([
    sampleFrames(page, 1800),
    page
      .evaluate(() => {
        const app = document.querySelector('#app')._vnode.component.proxy;
        app.historyView = app.historyView === 'grid' ? 'list' : 'grid';
      })
      .catch(() => {}),
  ]);
  await page.waitForTimeout(500);

  const [framesScroll] = await Promise.all([
    sampleFrames(page, 1800),
    page
      .evaluate(() => {
        const pane = document.querySelector('.drawer-pane');
        if (pane) pane.scrollTop = pane.scrollHeight;
      })
      .catch(() => {}),
  ]);

  // ⚠️ 第二个快照必须在「所有动作结束 + 静置」之后读，不能直接跟在最后一段
  // 采样后面。原因：transition-group 会让一部分渲染工作推迟到动画真正跑完之后
  // （leave 节点延迟移除、enter 类延迟添加），取消动画的实现则把工作一次性做完。
  // 如果紧贴着采样窗口读数，测到的其实是「谁把活拖到了窗口外」，而不是真实总量，
  // 会让无动画版本显得比有动画版本更贵 —— 这是个假信号。静置后读总账才公平。
  await page.waitForTimeout(2500);
  const m1 = await ctxClient.metrics();
  const c1 = await readCounters(page);

  return {
    ...frameStats([...(framesToggle || []), ...(framesScroll || [])]),
    ...diff({ ...c0, ...m0 }, { ...c1, ...m1 }),
    rows: 500,
  };
});

/* S4 —— 后台文件列表：每卡 backdrop-filter 的合成开销（无数据则跳过） */
scenario('S4', '后台文件列表滚动（毛玻璃卡片）', async (page, ctxClient) => {
  // 后台有 780ms bootDelay，还要等列表接口返回（本地数据多时更慢）。
  // 用轮询而不是 waitForSelector —— 后者默认等 visible，容器可能始终判定不可见。
  const cardCount = await pollUntil(page, 'document.querySelectorAll(".vault-card, .vault-row").length', 30000);
  if (!cardCount) return null; // 无数据：跳过，不算失败

  const c0 = await readCounters(page);
  const m0 = await ctxClient.metrics();

  const [frames] = await Promise.all([
    sampleFrames(page, 2400),
    (async () => {
      for (let i = 0; i < 6; i++) {
        await page.evaluate((v) => window.scrollTo({ top: v, behavior: 'instant' }), i % 2 ? 0 : 900);
        await page.waitForTimeout(240);
      }
    })().catch(() => {}),
  ]);

  const m1 = await ctxClient.metrics();
  const c1 = await readCounters(page);

  return { ...frameStats(frames || []), ...diff({ ...c0, ...m0 }, { ...c1, ...m1 }), rows: cardCount };
});

/* ------------------------------------------------------------ 主流程 */

const { chromium: core } = await loadPlaywright();
const exe = findChrome();
const browser = await core.launch({
  executablePath: exe,
  args: ['--no-sandbox', '--force-device-scale-factor=1'],
});

const results = {};
const failures = [];

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
});
if (!login.ok) console.error(`[warn] 登录失败 HTTP ${login.status}，S1 可能因权限受限`);
const setCookie = login.headers.getSetCookie?.() || [];

/* ⚠️ 单次采样的抖动远大于层间差异，必须多次取中位数。
   实测（同一份代码、同一台机器、S3 场景，2026-10-09）：
     RecalcStyleDuration 三次跑出 622.8 / 245.8 / 111.3 ms —— 相差 5.6 倍
     LayoutDuration      三次跑出  61.3 /  29.1 /  15.7 ms —— 相差 3.9 倍
   也就是说：CDP 那几个 Duration 指标在满负载下是「噪声主导」的，单次结果完全
   不能用于判定某一层优化是收益还是回归（曾据此误判 S3 回归 +349%，实为同比噪声）。
   默认 REPEAT=3 取中位数；要更稳用 REPEAT=5。想看单次原始值用 REPEAT=1。 */
const REPEAT = Math.max(1, Number(process.env.REPEAT || 3));

const median = (arr) => {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return +(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2).toFixed(1);
};

const collectMedian = (runs) => {
  const out = {};
  for (const k of new Set(runs.flatMap((r) => Object.keys(r)))) {
    const vals = runs.map((r) => r[k]).filter((v) => typeof v === 'number');
    out[k] = vals.length ? median(vals) : runs[0][k];
  }
  return out;
};

async function main() {
for (const sc of scenarios) {
  const only = process.env.SCENARIOS;
  if (only && !only.split(',').includes(sc.id)) continue;
  const runs = [];
  let skipped = false;
  for (let round = 0; round < REPEAT; round++) {
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    reducedMotion: 'no-preference',
  });
  if (setCookie.length) await ctx.addCookies(setCookie.map((c) => parseCookie(c, BASE)));
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  const client = await ctx.newCDPSession(page);
  await client.send('Performance.enable');
  const metrics = async () => {
    const { metrics: arr } = await client.send('Performance.getMetrics');
    const m = {};
    for (const x of arr) m[x.name] = x.value;
    return m;
  };

  await page.addInitScript(() => {
    window.__perfCounters = { gBCR: 0, gCS: 0 };
    const ob = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (...a) {
      window.__perfCounters.gBCR++;
      return ob.apply(this, a);
    };
    const og = window.getComputedStyle;
    window.getComputedStyle = function (...a) {
      window.__perfCounters.gCS++;
      return og.apply(this, a);
    };
  });

  try {
    const url = sc.id === 'S4' ? `${BASE}/admin` : `${BASE}/index.html`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);
    const r = await sc.fn(page, { metrics });
    if (r === null) {
      skipped = true;
    } else {
      runs.push(r);
      if (REPEAT > 1) console.log(`      #${round + 1}/${REPEAT}  RecalcStyle=${r.RecalcStyleDuration ?? '-'}  Layout=${r.LayoutDuration ?? '-'}  long=${r.longFrames ?? '-'}  p95=${r.p95Frame ?? '-'}  max=${r.maxFrame ?? '-'}`);
    }
  } catch (e) {
    failures.push(`${sc.id}#${round + 1}: ${e.message.split('\n')[0]}`);
    console.log(`FAIL  ${sc.id}  ${sc.title}  —— 第 ${round + 1} 轮：${e.message.split('\n')[0]}`);
  } finally {
    if (pageErrors.length) console.log(`      [pageerror] ${pageErrors.slice(0, 3).join(' | ')}`);
    await ctx.close();
  }
  if (skipped) break; // 缺数据的话多跑几轮也一样，直接跳过
  }
  if (skipped) {
    console.log(`SKIP  ${sc.id}  ${sc.title}  —— 缺少数据`);
  } else if (runs.length) {
    const merged = collectMedian(runs);
    results[sc.id] = { id: sc.id, title: sc.title, ...merged };
    console.log(`OK    ${sc.id}  ${sc.title}  （${runs.length}/${REPEAT} 轮取中位数）`);
    console.table([results[sc.id]]);
  }
}
}

await main();

await browser.close();

/* ------------------------------------------------------- 输出 / 落盘 */

console.log('\n================ 汇总 ================');
console.log(JSON.stringify(results, null, 2));

if (process.argv.includes('--compare')) {
  if (!fs.existsSync(BASELINE_FILE)) {
    console.error(`\n缺少基线文件 ${BASELINE_FILE}`);
    process.exit(1);
  }
  const base = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
  console.log('\n================ 与基线对比 ================');
  for (const id of Object.keys(results)) {
    const b = base[id];
    const a = results[id];
    if (!b) continue;
    const row = {};
    for (const k of ['longFrames', 'maxFrame', 'p95Frame', 'gBCR', 'LayoutDuration', 'RecalcStyleDuration']) {
      if (typeof b[k] !== 'number' || typeof a[k] !== 'number') continue;
      const d = b[k] === 0 ? 0 : +(((a[k] - b[k]) / b[k]) * 100).toFixed(1);
      row[k] = `${b[k]} → ${a[k]}  (${d > 0 ? '+' : ''}${d}%)`;
    }
    console.log(`\n[${id}] ${a.title}`);
    console.table([row]);
  }
} else if (process.argv.includes('--write-baseline')) {
  // 合并写入：允许用 SCENARIOS=S3 单独补跑某个场景，不会把其它场景的数据抹掉
  const prev = fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')) : {};
  fs.writeFileSync(BASELINE_FILE, JSON.stringify({ ...prev, ...results }, null, 2));
  console.log(`\n基线已写入 ${BASELINE_FILE}（场景：${Object.keys(results).join(', ')}）`);
}

// 多轮采样下，只要该场景至少有一轮成功就出结果；只有「一轮都没成功」才算致命失败。
const fatal = failures.filter((f) => !results[f.split(/[:#]/)[0]]);
if (fatal.length) {
  console.error(`\n${fatal.length} 个场景失败（其余偶发失败已在中位数里稀释）：`);
  fatal.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}

/* 简易 Set-Cookie 解析（Node 22 的 getSetCookie 返回完整 cookie 串） */
function parseCookie(str, base) {
  const [pair, ...rest] = str.split(';');
  const [name, value] = pair.split('=');
  const u = new URL(base);
  const out = { name: name.trim(), value: (value || '').trim(), domain: u.hostname, path: '/' };
  for (const seg of rest) {
    const [k, v] = seg.split('=');
    if (k.trim().toLowerCase() === 'path') out.path = v.trim();
    if (k.trim().toLowerCase() === 'domain') out.domain = v.trim();
  }
  return out;
}
