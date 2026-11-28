#!/usr/bin/env node
/**
 * tg-chunked-ratelimit.mjs —— Telegram 虚拟分片尾片 429 频控冷却 + 状态指示浏览器回归
 *
 * 验证（真实 Chromium 渲染 upload.html + assets/js/index.js + assets/css/index.css）：
 *   1. Retry-After 长退避透传（95s 不被截断到 30s，含正向抖动与 JSON body 回落）
 *   2. Telegram 分片最小超时下限（90s），防止末片小块被 30s 误杀
 *   3. 尾片 48/49 同时撞 429 FloodWait：
 *      - 429 前保留 2 路并行（保持高吞吐速度）
 *      - 429 触发后：所有路共享 cooldownUntil 冷静期（不提前抢跑重传）
 *      - 冷却后强制单路串行 + 自适应节流（maxConcurrentAfter429 === 1），零双路互撞
 *      - 48/49 冷却后一次过关（不再出现 8~9 次重试风暴）
 *   4. 状态指示器：
 *      - 429 期间展示「Telegram 频控等待 Xs · N/49 片」+ 琥珀色 warn 态 + 次行提示
 *      - 503 瞬态错误后降为单路（activeLimit === 1）时，分片恢复成功后状态立即清回「上传中」（不再卡死「重试」）
 *      - 进度条全程单调递增（重试不倒退、complete 阶段保持 99% 不回退到 96%）
 *   5. 360px 窄屏在最长频控倒计时文案下无横向溢出（scrollWidth === clientWidth），零 pageerror
 *
 * 用法：
 *   python3 -m http.server 8788 --bind 127.0.0.1 &
 *   BASE=http://127.0.0.1:8788 node scripts/verify/tg-chunked-ratelimit.mjs
 */

import { loadPlaywright, findChrome } from './_playwright.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const { chromium } = await loadPlaywright();
const exe = findChrome();

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —— ' + detail : ''}`);
  if (!ok) failed += 1;
};

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });

try {
  // =========================================================================
  // 场景 1：360px 窄屏 + 49 片尾片（46/47 正常 2 路并行 → 48/49 触发 429 FloodWait）
  // =========================================================================
  {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    const TOTAL_CHUNKS = 49;
    const CHUNK_SIZE = 18 * 1024 * 1024;
    const FILE_SIZE = 48 * CHUNK_SIZE + 5 * 1024 * 1024; // 49 chunks (~869MB)
    const RESUMED_COUNT = 45; // 跳过 0..44，真实上传 45, 46, 47, 48（第 46~49 片）
    const UPLOAD_ID = 'abcdef0123456789abcdef0123456789';

    let inFlightNow = 0;
    let maxConcurrentBefore429 = 0;
    let maxConcurrentAfter429 = 0;
    let rateLimitedSeen = false;
    let first429At = 0;
    let retryAfter429At = 0;
    let chunk47SuccessAt = 0;
    let chunk48Post429StartAt = 0;
    const chunkAttempts = new Map();
    const injected429 = new Set();

    await page.route('**/api/auth/check*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          authenticated: true,
          authRequired: true,
          user: { username: 'admin' },
          airdrop: { enabled: false, nodes: [] },
        }),
      })
    );

    await page.route('**/api/status*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          storage: {
            telegram: {
              configured: true,
              available: true,
              maxFileSize: 2 * 1024 * 1024 * 1024,
              directThreshold: 20 * 1024 * 1024,
              supportsChunkUpload: true,
            },
            r2: { configured: false, available: false },
          },
          defaultStorage: 'telegram',
        }),
      })
    );

    await page.route('**/api/manage/folders*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, folders: [] }),
      })
    );

    await page.route('**/api/chunked-upload/init', (route) => {
      const doneIndices = Array.from({ length: RESUMED_COUNT }, (_, idx) => idx);
      const doneParts = doneIndices.map((idx) => ({
        partNumber: idx + 1,
        etag: `tg:${JSON.stringify({ f: `fid_${idx}`, m: 1000 + idx })}`,
      }));
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          uploadId: UPLOAD_ID,
          storageMode: 'telegram',
          telegramChunked: true,
          chunkSize: CHUNK_SIZE,
          totalChunks: TOTAL_CHUNKS,
          resumed: true,
          uploadedChunks: doneIndices,
          parts: doneParts,
        }),
      });
    });

    await page.route('**/api/chunked-upload/chunk*', async (route) => {
      const url = new URL(route.request().url());
      const idx = Number(url.searchParams.get('chunkIndex'));
      const count = (chunkAttempts.get(idx) || 0) + 1;
      chunkAttempts.set(idx, count);

      inFlightNow += 1;
      if (!rateLimitedSeen) {
        maxConcurrentBefore429 = Math.max(maxConcurrentBefore429, inFlightNow);
      } else {
        if (!retryAfter429At) retryAfter429At = Date.now();
        if (idx === 48) chunk48Post429StartAt = Date.now();
        maxConcurrentAfter429 = Math.max(maxConcurrentAfter429, inFlightNow);
      }

      // 给 45/46 稍长一点响应时间，确保 2 路并发必然重叠
      const delayMs = idx <= 46 ? 180 : 120;
      await new Promise((r) => setTimeout(r, delayMs));

      // 模拟尾片 48（idx=47）与 49（idx=48）首次触发 Telegram 429（Retry-After: 2s）
      if ((idx === 47 || idx === 48) && !injected429.has(idx)) {
        injected429.add(idx);
        if (!rateLimitedSeen) {
          rateLimitedSeen = true;
          first429At = Date.now();
        }
        inFlightNow -= 1;
        return route.fulfill({
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '2',
          },
          body: JSON.stringify({
            error: 'Telegram 触发频控限流，将在 2 秒后重试',
            code: 'TG_RATE_LIMITED',
            retryable: true,
            retryAfter: 2,
          }),
        });
      }

      inFlightNow -= 1;
      if (idx === 47) chunk47SuccessAt = Date.now();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          chunkIndex: idx,
          partNumber: idx + 1,
          etag: `tg:${JSON.stringify({ f: `fid_${idx}`, m: 1000 + idx })}`,
          size: idx === TOTAL_CHUNKS - 1 ? 5 * 1024 * 1024 : CHUNK_SIZE,
          chunkBackend: 'telegram',
        }),
      });
    });

    await page.route('**/api/chunked-upload/complete', async (route) => {
      await new Promise((r) => setTimeout(r, 150));
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          src: '/file/telegram:tg_mock_49.bin',
          fileName: 'big-video-869mb.mp4',
          size: FILE_SIZE,
        }),
      });
    });

    await page.addInitScript(() => {
      localStorage.setItem('storageMode', 'telegram');
    });

    await page.goto(`${BASE}/upload.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => {
      const app = document.querySelector('#app')?._vnode?.component?.proxy;
      return app && !app.authChecking;
    }, { timeout: 20000 });

    // 先验证核心重试、超时与 ETA 函数契约
    const helperAudit = await page.evaluate(() => {
      const app = document.querySelector('#app')._vnode.component.proxy;
      const ra95 = app.parseRetryAfterMs('95');
      const ra300 = app.parseRetryAfterMs('300');
      const raCap = app.parseRetryAfterMs('4000');
      const delay240 = app.computeRetryDelay(1, 500, 15000, 240000);
      const errBody = app.uploadResponseError(429, { code: 'TG_RATE_LIMITED', retryAfter: 600 }, 'fallback', 0);
      const tgSmallTimeout = app.estimateTimeout(1024 * 1024, 50 * 1024 * 1024, 90000);
      const etaShort = app.formatEta(42);
      const etaMin = app.formatEta(135);
      const countMin = app.formatCountdownSec(135);
      const speedEta = app.formatSpeedWithEta(5 * 1024 * 1024, 50 * 1024 * 1024);
      return {
        ra95,
        ra300,
        raCap,
        delay240,
        bodyRetryAfterMs: errBody.retryAfterMs,
        tgSmallTimeout,
        etaShort,
        etaMin,
        countMin,
        speedEta,
      };
    });

    check('parseRetryAfterMs 透传 95s / 300s 不被截断', helperAudit.ra95 === 95000 && helperAudit.ra300 === 300000, `got ${helperAudit.ra95} / ${helperAudit.ra300}`);
    check('parseRetryAfterMs 上限封顶 3600s', helperAudit.raCap === 3600000, `got ${helperAudit.raCap}`);
    check(
      'computeRetryDelay 尊重 240s Retry-After 且带正向抖动',
      helperAudit.delay240 >= 240600 && helperAudit.delay240 <= 241500,
      `got ${helperAudit.delay240}ms`
    );
    check(
      'uploadResponseError 在响应头缺失时透传长 JSON retryAfter (600s)',
      helperAudit.bodyRetryAfterMs === 600000,
      `got ${helperAudit.bodyRetryAfterMs}`
    );
    check(
      'estimateTimeout 为 Telegram 小末片保留 90s 下限',
      helperAudit.tgSmallTimeout >= 90000,
      `got ${helperAudit.tgSmallTimeout}ms`
    );
    check(
      'formatEta / formatCountdownSec / formatSpeedWithEta 正确输出',
      helperAudit.etaShort === '剩余 42s' && helperAudit.etaMin === '剩余 2分15秒' && helperAudit.countMin === '2分15秒' && helperAudit.speedEta === '5.0 MB/s · 剩余 10s',
      `got ${helperAudit.etaShort} / ${helperAudit.etaMin} / ${helperAudit.countMin} / ${helperAudit.speedEta}`
    );

    // 构造虚拟 869MB File（仅切小块字节送出，避免真实分配 869MB 内存）并观察全过程 UI 状态
    const result = await page.evaluate(async ({ fileSize }) => {
      const app = document.querySelector('#app')._vnode.component.proxy;
      app.computeFileId = async () => 'mock-fp-49-chunks';

      const tinySlice = new Blob([new Uint8Array(64)]);
      const fakeFile = {
        name: 'big-video-869mb.mp4',
        size: fileSize,
        type: 'video/mp4',
        lastModified: Date.now(),
        slice() {
          return tinySlice;
        },
      };

      const snapshots = [];
      let sawCooldownText = false;
      let sawWarnClass = false;
      let sawHintWarn = false;
      let sawProgressWarn = false;
      let sawRecoveredAfterCooldown = false;
      let sawCompletePhase = false;
      let completeProgress = null;
      let maxOverflowPx = 0;
      let progressDropped = false;
      let prevProgress = 0;

      const sampler = setInterval(() => {
        const task = app.uploadingFiles[0];
        if (!task) return;
        const statusText = String(task.statusText || '');
        const p = Number(task.progress || 0);
        if (p < prevProgress && task.status !== 'waiting') {
          progressDropped = true;
        }
        prevProgress = Math.max(prevProgress, p);

        if (statusText.includes('Telegram 频控等待')) {
          sawCooldownText = true;
          const warnEl = document.querySelector('.task__status--warn');
          const hintEl = document.querySelector('.task__hint--warn');
          const barEl = document.querySelector('.progress__val--warn');
          if (warnEl) sawWarnClass = true;
          if (hintEl) sawHintWarn = true;
          if (barEl) sawProgressWarn = true;
          const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
          if (overflow > maxOverflowPx) maxOverflowPx = overflow;
        } else if (sawCooldownText && (statusText.startsWith('上传中') || statusText.startsWith('写入 Telegram'))) {
          sawRecoveredAfterCooldown = true;
        }
        if (task.status === 'processing') {
          sawCompletePhase = true;
          completeProgress = p;
        }
        if (!snapshots.length || snapshots[snapshots.length - 1] !== `${task.status}:${statusText}:${p}`) {
          snapshots.push(`${task.status}:${statusText}:${p}`);
        }
      }, 40);

      try {
        const task = app.createUploadTask(fakeFile, 'telegram');
        app.uploadingFiles.push(task);
        app.requestUploadScheduling();

        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) {
          if (task.status === 'success' || task.status === 'error' || task.status === 'blocked') break;
          await new Promise((r) => setTimeout(r, 80));
        }

        return {
          finalStatus: task.status,
          finalProgress: task.progress,
          finalError: task.error,
          uploadedCount: app.uploadedFiles.length,
          sawCooldownText,
          sawWarnClass,
          sawHintWarn,
          sawProgressWarn,
          sawRecoveredAfterCooldown,
          sawCompletePhase,
          completeProgress,
          progressDropped,
          maxOverflowPx,
          snapshots,
        };
      } finally {
        clearInterval(sampler);
      }
    }, { fileSize: FILE_SIZE });

    check('49 片尾片遇 429 后顺利完成上传', result.finalStatus === 'success' && result.uploadedCount === 1, `status=${result.finalStatus}, err=${result.finalError}`);
    check('429 触发前保留 2 路并行（保持高吞吐）', maxConcurrentBefore429 === 2, `maxConcurrentBefore429=${maxConcurrentBefore429}`);
    check('429 触发后严格切换单路串行（零双路互撞）', maxConcurrentAfter429 === 1, `maxConcurrentAfter429=${maxConcurrentAfter429}`);
    const waitedAfter429 = retryAfter429At - first429At;
    check('共享冷却栅栏严格等足 Retry-After（不提前抢跑）', waitedAfter429 >= 2000, `waited=${waitedAfter429}ms`);
    const pacingGap = chunk48Post429StartAt - chunk47SuccessAt;
    check('触限后分片 48→49 启用自适应节流间隔（>=1.2s）', pacingGap >= 1200, `gap=${pacingGap}ms`);
    check(
      '分片 48/49 仅需冷却后 1 次重试即成功（非 8~9 次风暴）',
      chunkAttempts.get(47) === 2 && chunkAttempts.get(48) === 2,
      `chunk48=${chunkAttempts.get(47)}次, chunk49=${chunkAttempts.get(48)}次`
    );
    check('UI 展示「Telegram 频控等待」倒计时与 warn 样式', result.sawCooldownText && result.sawWarnClass && result.sawHintWarn && result.sawProgressWarn);
    check('冷却结束后状态立即恢复正常（未卡死在重试/频控文案）', result.sawRecoveredAfterCooldown, `snapshots=${JSON.stringify(result.snapshots.slice(-6))}`);
    check('进度条全程单调递增，无倒退抖动', !result.progressDropped, `snapshots=${JSON.stringify(result.snapshots)}`);
    check('complete 合并阶段保持 99%（修复旧版回退到 96% 的缺陷）', !result.sawCompletePhase || result.completeProgress >= 99, `completeProgress=${result.completeProgress}`);
    check('360px 窄屏在最长频控倒计时文案下零横向溢出', result.maxOverflowPx === 0, `overflow=${result.maxOverflowPx}px`);
    check('场景 1 全程零 JS pageerror', pageErrors.length === 0, pageErrors.join('; '));

    await ctx.close();
  }

  // =========================================================================
  // 场景 2：503 瞬态错误触发降级到 activeLimit === 1 后，状态必须清回「上传中」
  // =========================================================================
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    const TOTAL_CHUNKS = 49;
    const CHUNK_SIZE = 18 * 1024 * 1024;
    const FILE_SIZE = 48 * CHUNK_SIZE + 2 * 1024 * 1024;
    const UPLOAD_ID = '11223344556677881122334455667788';
    let failed503Once = false;

    await page.route('**/api/auth/check*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ authenticated: true, authRequired: true, user: { username: 'admin' }, airdrop: { enabled: false, nodes: [] } }),
      })
    );
    await page.route('**/api/status*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          storage: {
            telegram: { configured: true, available: true, maxFileSize: 2 * 1024 * 1024 * 1024, directThreshold: 20 * 1024 * 1024, supportsChunkUpload: true },
          },
          defaultStorage: 'telegram',
        }),
      })
    );
    await page.route('**/api/manage/folders*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, folders: [] }) })
    );
    await page.route('**/api/chunked-upload/init', (route) => {
      const doneIndices = Array.from({ length: 47 }, (_, idx) => idx);
      const doneParts = doneIndices.map((idx) => ({ partNumber: idx + 1, etag: `tg:${JSON.stringify({ f: `fid_${idx}`, m: 2000 + idx })}` }));
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          uploadId: UPLOAD_ID,
          storageMode: 'telegram',
          telegramChunked: true,
          chunkSize: CHUNK_SIZE,
          totalChunks: TOTAL_CHUNKS,
          resumed: true,
          uploadedChunks: doneIndices,
          parts: doneParts,
        }),
      });
    });
    await page.route('**/api/chunked-upload/chunk*', async (route) => {
      const idx = Number(new URL(route.request().url()).searchParams.get('chunkIndex'));
      if (idx === 47 && !failed503Once) {
        failed503Once = true;
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Telegram 分片上传暂时失败，请重试', code: 'TG_PART_RETRY', retryable: true }),
        });
      }
      await new Promise((r) => setTimeout(r, 200));
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          chunkIndex: idx,
          partNumber: idx + 1,
          etag: `tg:${JSON.stringify({ f: `fid_${idx}`, m: 2000 + idx })}`,
          size: idx === 48 ? 2 * 1024 * 1024 : CHUNK_SIZE,
          chunkBackend: 'telegram',
        }),
      });
    });
    await page.route('**/api/chunked-upload/complete', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ src: '/file/telegram:tg_mock_503.bin', fileName: 'recover-503.bin', size: FILE_SIZE }),
      })
    );

    await page.addInitScript(() => localStorage.setItem('storageMode', 'telegram'));
    await page.goto(`${BASE}/upload.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => {
      const app = document.querySelector('#app')?._vnode?.component?.proxy;
      return app && !app.authChecking;
    }, { timeout: 20000 });

    const r2 = await page.evaluate(async ({ fileSize }) => {
      const app = document.querySelector('#app')._vnode.component.proxy;
      app.computeFileId = async () => 'mock-fp-503';
      const tiny = new Blob([new Uint8Array(64)]);
      const fakeFile = { name: 'recover-503.bin', size: fileSize, type: 'application/octet-stream', lastModified: Date.now(), slice: () => tiny };
      let saw503Reason = false;
      let clearedAfterRetry = false;
      const seen = [];
      const timer = setInterval(() => {
        const t = app.uploadingFiles[0];
        if (!t) return;
        const txt = String(t.statusText || '');
        if (!seen.length || seen[seen.length - 1] !== txt) seen.push(txt);
        if (txt.includes('服务端繁忙') && txt.includes('重试第 48 片')) saw503Reason = true;
        if (saw503Reason && (txt.startsWith('上传中') || txt.startsWith('写入 Telegram') || txt.includes('文件清单'))) {
          clearedAfterRetry = true;
        }
      }, 30);
      try {
        const task = app.createUploadTask(fakeFile, 'telegram');
        app.uploadingFiles.push(task);
        app.requestUploadScheduling();
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          if (task.status === 'success' || task.status === 'error') break;
          await new Promise((r) => setTimeout(r, 60));
        }
        return { finalStatus: task.status, saw503Reason, clearedAfterRetry, seen };
      } finally {
        clearInterval(timer);
      }
    }, { fileSize: FILE_SIZE });

    check('503 故障清晰展示原因与重试计数', r2.saw503Reason, `seen=${JSON.stringify(r2.seen)}`);
    check('单路降级（activeLimit=1）后重试成功立即清回正常状态', r2.clearedAfterRetry && r2.finalStatus === 'success', `seen=${JSON.stringify(r2.seen)}`);
    check('场景 2 全程零 JS pageerror', pageErrors.length === 0, pageErrors.join('; '));

    await ctx.close();
  }

  // =========================================================================
  // 场景 3：KVault.downloadResumable 对 Telegram 虚拟分片的 1:1 分片对齐 + 3 路收敛 + 429 共享冷却
  // =========================================================================
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    const TG_CHUNK = 6 * 1024 * 1024; // 6MB × 3 = 18MB（正常 18MB 文件原逻辑会按 4MB 分 5 段，全部错位）
    const TOTAL_DL = 3 * TG_CHUNK;
    const requestedRanges = [];
    let injectedDl429 = false;
    let dlInFlight = 0;
    let dlMaxLanesObserved = 0;

    await page.route('**/api/auth/check*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated: true, authRequired: true }) })
    );
    await page.route('**/api/status*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ storage: {}, defaultStorage: 'telegram' }) })
    );
    await page.route('**/api/manage/folders*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, folders: [] }) })
    );

    const chunkPayloadCache = new Map();
    const getChunkBuf = (len) => {
      if (!chunkPayloadCache.has(len)) {
        chunkPayloadCache.set(len, Buffer.alloc(len, 0x5a));
      }
      return chunkPayloadCache.get(len);
    };

    await page.route('**/file/telegram:mock_aligned.bin', async (route) => {
      const req = route.request();
      if (req.method() === 'HEAD') {
        return route.fulfill({
          status: 200,
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(TOTAL_DL),
            'Accept-Ranges': 'bytes',
            ETag: '"tg-aligned-etag-1"',
            'X-KVault-Storage': 'telegram-chunked',
            'X-KVault-Chunk-Size': String(TG_CHUNK),
          },
          body: '',
        });
      }

      const range = req.headers()['range'] || '';
      requestedRanges.push(range);
      dlInFlight += 1;
      dlMaxLanesObserved = Math.max(dlMaxLanesObserved, dlInFlight);
      await new Promise((r) => setTimeout(r, 120));

      const m = range.match(/^bytes=(\d+)-(\d+)$/);
      if (!m) {
        dlInFlight -= 1;
        return route.fulfill({ status: 400, body: 'missing range' });
      }
      const start = Number(m[1]);
      const end = Number(m[2]);

      if (start === TG_CHUNK && !injectedDl429) {
        injectedDl429 = true;
        dlInFlight -= 1;
        return route.fulfill({
          status: 429,
          headers: { 'Retry-After': '1', 'Content-Type': 'text/plain' },
          body: 'rate limited',
        });
      }

      const len = end - start + 1;
      dlInFlight -= 1;
      return route.fulfill({
        status: 206,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(len),
          'Content-Range': `bytes ${start}-${end}/${TOTAL_DL}`,
          'Accept-Ranges': 'bytes',
          ETag: '"tg-aligned-etag-1"',
          'X-KVault-Storage': 'telegram-chunked',
          'X-KVault-Chunk-Size': String(TG_CHUNK),
        },
        body: getChunkBuf(len),
      });
    });

    await page.goto(`${BASE}/upload.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => typeof window.KVault?.downloadResumable === 'function', { timeout: 15000 });

    const dlRes = await page.evaluate(async ({ url }) => {
      let sawCooldown = false;
      let maxCooldownSec = 0;
      let dropped = false;
      let maxPct = 0;
      const job = window.KVault.downloadResumable(url, {
        fileName: 'mock_aligned.bin',
        maxConcurrency: 6,
        autoSave: false,
        onProgress(p) {
          if (p.percent < maxPct) dropped = true;
          maxPct = Math.max(maxPct, p.percent || 0);
          if (p.status === 'cooldown') {
            sawCooldown = true;
            maxCooldownSec = Math.max(maxCooldownSec, p.cooldownSec || 0);
          }
        },
      });
      const out = await job.promise;
      return {
        ok: out.ok,
        size: out.size,
        blobSize: out.blob ? out.blob.size : 0,
        lanes: out.lanes,
        alignedChunkSize: out.alignedChunkSize,
        sawCooldown,
        maxCooldownSec,
        dropped,
      };
    }, { url: `${BASE}/file/telegram:mock_aligned.bin` });

    const uniqueRanges = Array.from(new Set(requestedRanges)).sort();
    const expectedRanges = [
      `bytes=0-${TG_CHUNK - 1}`,
      `bytes=${TG_CHUNK}-${2 * TG_CHUNK - 1}`,
      `bytes=${2 * TG_CHUNK}-${3 * TG_CHUNK - 1}`,
    ].sort();

    check('downloadResumable 1:1 对齐 Telegram 虚拟分片大小', dlRes.alignedChunkSize === TG_CHUNK, `aligned=${dlRes.alignedChunkSize}`);
    check(
      'downloadResumable 全部 Range 精确命中分片边界（零跨片切片）',
      JSON.stringify(uniqueRanges) === JSON.stringify(expectedRanges),
      `ranges=${JSON.stringify(uniqueRanges)}`
    );
    check('telegram-chunked 下载并发智能收敛至 <=3 路', dlRes.lanes <= 3 && dlMaxLanesObserved <= 3, `lanes=${dlRes.lanes}, observed=${dlMaxLanesObserved}`);
    check('下载遇到 429 时触发共享冷却倒计时并完整恢复', dlRes.sawCooldown && dlRes.maxCooldownSec >= 1 && dlRes.ok && dlRes.blobSize === TOTAL_DL, `cooldown=${dlRes.maxCooldownSec}s, blobSize=${dlRes.blobSize}`);
    check('下载进度全程单调递增（重试不倒退）', !dlRes.dropped);
    check('场景 3 全程零 JS pageerror', pageErrors.length === 0, pageErrors.join('; '));

    await ctx.close();
  }

  // =========================================================================
  // 场景 4：>300s 超长 FloodWait（600s）优雅暂停并保留断点 + downloadFile 大 TG 文件分片路由
  // =========================================================================
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    const CHUNK_SIZE = 18 * 1024 * 1024;
    const FILE_SIZE = 2 * CHUNK_SIZE;
    let chunk0Calls = 0;

    await page.route('**/api/auth/check*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          authenticated: true,
          authRequired: true,
          user: { username: 'admin' },
          airdrop: { enabled: false, nodes: [] },
        }),
      })
    );
    await page.route('**/api/status*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          storage: {
            telegram: {
              configured: true,
              available: true,
              maxFileSize: 2 * 1024 * 1024 * 1024,
              directThreshold: 20 * 1024 * 1024,
              supportsChunkUpload: true,
            },
            r2: { configured: false, available: false },
          },
          defaultStorage: 'telegram',
        }),
      })
    );
    await page.route('**/api/manage/folders*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, folders: [] }) })
    );
    await page.route('**/api/chunked-upload/init', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          uploadId: 'longwait0123456789abcdef01234567',
          storageMode: 'telegram',
          telegramChunked: true,
          chunkSize: CHUNK_SIZE,
          totalChunks: 2,
          resumed: false,
          uploadedChunks: [0],
          parts: [{ partNumber: 1, etag: 'tg:{"f":"fid_0","m":2001}' }],
        }),
      })
    );
    await page.route('**/api/chunked-upload/chunk*', (route) => {
      chunk0Calls += 1;
      return route.fulfill({
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '600' },
        body: JSON.stringify({
          error: 'Telegram 触发频控限流，将在 600 秒后重试',
          code: 'TG_RATE_LIMITED',
          retryable: true,
          retryAfter: 600,
        }),
      });
    });

    await page.addInitScript(() => {
      localStorage.setItem('storageMode', 'telegram');
    });

    await page.goto(`${BASE}/upload.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => {
      const app = document.querySelector('#app')?._vnode?.component?.proxy;
      return app && !app.authChecking;
    }, { timeout: 20000 });

    const longWaitRes = await page.evaluate(async ({ fileSize }) => {
      const app = document.querySelector('#app')._vnode.component.proxy;
      const fp = 'mock-fp-long-cooldown';
      app.computeFileId = async () => fp;
      const tinySlice = new Blob([new Uint8Array(64)]);
      const fakeFile = {
        name: 'long-wait-36mb.bin',
        size: fileSize,
        type: 'application/octet-stream',
        lastModified: Date.now(),
        slice() { return tinySlice; },
      };

      const started = Date.now();
      const task = app.createUploadTask(fakeFile, 'telegram');
      app.uploadingFiles.push(task);
      app.requestUploadScheduling();

      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (task.status === 'error' || task.status === 'success' || task.status === 'blocked') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const elapsedMs = Date.now() - started;
      const savedResume = app.readResumeState(fp);

      // 同时验证 downloadFile 对大 Telegram 文件（60MB）走 startResumableDownload，对普通小文件/R2 走 triggerDownload
      let routedResumable = 0;
      let routedNative = 0;
      const origResumable = app.startResumableDownload;
      const origTrigger = app.triggerDownload;
      app.startResumableDownload = () => { routedResumable += 1; };
      app.triggerDownload = () => { routedNative += 1; };
      app.downloadFile({ url: '/file/telegram:tg_big.bin', fileName: 'tg_big.bin', size: 60 * 1024 * 1024, storageMode: 'telegram' });
      app.downloadFile({ url: '/file/r2_big.bin', fileName: 'r2_big.bin', size: 60 * 1024 * 1024, storageMode: 'r2' });
      app.downloadFile({ url: '/file/telegram:tg_small.jpg', fileName: 'tg_small.jpg', size: 5 * 1024 * 1024, storageMode: 'telegram' });
      app.startResumableDownload = origResumable;
      app.triggerDownload = origTrigger;

      return {
        status: task.status,
        statusTone: task.statusTone,
        statusText: task.statusText,
        error: task.error,
        autoRetryExhausted: task.autoRetryExhausted,
        elapsedMs,
        savedUploadId: savedResume?.uploadId || null,
        savedDoneCount: savedResume?.doneIndices?.length || 0,
        routedResumable,
        routedNative,
      };
    }, { fileSize: FILE_SIZE });

    check(
      '>300s FloodWait 立即优雅暂停（不空等 600s、不自动重试风暴）',
      longWaitRes.status === 'error' &&
        longWaitRes.statusTone === 'warn' &&
        longWaitRes.autoRetryExhausted === true &&
        longWaitRes.elapsedMs < 3000 &&
        chunk0Calls === 1,
      `status=${longWaitRes.status}, tone=${longWaitRes.statusTone}, exhausted=${longWaitRes.autoRetryExhausted}, elapsed=${longWaitRes.elapsedMs}ms, calls=${chunk0Calls}`
    );
    check(
      '>300s FloodWait 保留断点并输出明确提示文案',
      String(longWaitRes.statusText).includes('已保存断点') &&
        String(longWaitRes.error).includes('10 分钟') &&
        longWaitRes.savedUploadId === 'longwait0123456789abcdef01234567' &&
        longWaitRes.savedDoneCount === 1,
      `text="${longWaitRes.statusText}", savedDone=${longWaitRes.savedDoneCount}`
    );
    check(
      'downloadFile 仅将 >20MB Telegram 文件路由到 Range 分片下载，普通/R2 文件保持原生下载',
      longWaitRes.routedResumable === 1 && longWaitRes.routedNative === 2,
      `resumable=${longWaitRes.routedResumable}, native=${longWaitRes.routedNative}`
    );
    check('场景 4 全程零 JS pageerror', pageErrors.length === 0, pageErrors.join('; '));

    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(`\n结果：${failed === 0 ? '全部通过' : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
