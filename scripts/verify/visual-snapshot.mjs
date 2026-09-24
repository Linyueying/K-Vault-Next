// 视觉回归快照 —— 用「改前 / 改后比对」证明重构没有改变渲染结果
//
// 这是本次清理 mobile-refactor.css（781 -> 433 行）的安全证明方法：
//   1) 改之前：node scripts/verify/visual-snapshot.mjs /tmp/before.json
//   2) 改之后：node scripts/verify/visual-snapshot.mjs /tmp/after.json
//   3) 比对：  node scripts/verify/visual-diff.mjs /tmp/before.json /tmp/after.json
//
// 它拍的不是截图，而是【关键元素的计算样式】——比截图更严格：
// 截图靠肉眼、会漏掉 1px 差异；计算样式是精确字符串比对。
//
// 用法：
//   python3 -m http.server 8788 --bind 127.0.0.1 &
//   node scripts/verify/visual-snapshot.mjs /tmp/before.json
//   ... 改 CSS ...
//   node scripts/verify/visual-snapshot.mjs /tmp/after.json
//   node scripts/verify/visual-diff.mjs /tmp/before.json /tmp/after.json
import { loadPlaywright, findChrome } from './_playwright.mjs';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8788';

const { chromium } = await loadPlaywright();

const PAGES = ['index', 'admin', 'gallery', 'paste', 'share', 'preview', 'webdav', 'login'];

// 多个视口：覆盖移动端覆盖层（mobile-refactor.css）的各个断点
const VIEWPORTS = [
  { name: 'mobile390', width: 390, height: 844 },
  { name: 'mobile560', width: 560, height: 800 },
  { name: 'tablet900', width: 900, height: 800 },
  { name: 'tablet1100', width: 1100, height: 800 },
  { name: 'desktop1440', width: 1440, height: 900 },
];

// 参与比对的关键元素。改样式后如果这里覆盖不到你改的地方，
// 请把对应选择器加进来 —— 否则"没差异"可能是假阴性。
const TARGETS = [
  '.card', '.btn', '.action-btn', 'body', '.title', '.header-title',
  '.header-actions', '.toolbar', '.login-card', '.preview-card',
  '.modal', '.toast', '.btn--primary',
];

// 参与比对的 CSS 属性。取的都是最容易被重构改动的那些。
//
// ⚠️ 这里用 camelCase，在页面里通过 cs[name] 直接读（不能用
// cs.getPropertyValue(name) —— 那个只认 kebab-case，传 camelCase 会
// 静默返回空串，导致"一切都没变"的假阴性。这个坑踩过一次，见下方 assertNonEmpty）。
//
// ⚠️ 刻意排除 opacity / transform / filter —— 本仓库有多个无限动画
// （.orb-1/.orb-2 的 orbFloat、.status-pill__pulse 的 pulseRing 等），
// 它们的 opacity/transform 每帧都在变，两次快照必然不同，会产生假阳性。
const PROPS = [
  'borderRadius', 'fontFamily', 'fontSize', 'padding', 'margin',
  'minHeight', 'minWidth', 'display', 'gridTemplateColumns', 'flexWrap',
  'overflow', 'letterSpacing', 'backgroundColor', 'boxShadow',
  'position', 'top', 'right', 'textOverflow', 'whiteSpace', 'lineHeight',
  'color', 'borderColor', 'zIndex',
];

const outPath = process.argv[2];
if (!outPath) {
  console.error('用法：node scripts/verify/visual-snapshot.mjs <输出 json 路径>');
  process.exit(2);
}

const b = await chromium.launch({
  executablePath: findChrome(),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const snapshot = {};
for (const vp of VIEWPORTS) {
  // reduceMotion: 'reduce' —— 本仓库有 @media (prefers-reduced-motion: reduce)
  // 把动画压到 0.01ms，这样动画不会在两次快照间漂移。
  const ctx = await b.newContext({
    viewport: { width: vp.width, height: vp.height },
    reducedMotion: 'reduce',
  });
  for (const p of PAGES) {
    const page = await ctx.newPage();
    try {
      await page.goto(`${BASE}/${p}.html`, { waitUntil: 'load', timeout: 15000 });
    } catch {
      snapshot[`${vp.name}|${p}|__NAV_FAILED__`] = 'nav-timeout';
      await page.close();
      continue;
    }
    await page.waitForTimeout(400);
    const data = await page.evaluate(({ sels, props }) => {
      const out = {};
      for (const s of sels) {
        const el = document.querySelector(s);
        if (!el) { out[s] = null; continue; }
        const cs = getComputedStyle(el);
        // 用 cs[name] 直接读。不要用 cs.getPropertyValue(name)：
        // 那个 API 只接受 kebab-case（'border-radius'），传 camelCase 会
        // 静默返回空串 —— 会让所有属性都变成 ""，比对永远"0 差异"。
        out[s] = props.map((pr) => {
          const v = cs[pr];
          return v === undefined ? '' : String(v);
        }).join('|');
      }
      return out;
    }, { sels: TARGETS, props: PROPS });
    for (const [s, v] of Object.entries(data)) {
      snapshot[`${vp.name}|${p}|${s}`] = v;
    }
    await page.close();
  }
  await ctx.close();
}
await b.close();

// 自检：如果大量属性读出来是空串，说明读取方式错了（典型是误用
// getPropertyValue 传 camelCase）。宁可报错，也不要产出一份"全是空"的
// 快照 —— 那种快照跟任何东西比对都会显示"0 差异"，是最危险的假阴性。
const empties = Object.values(snapshot).filter(
  (v) => typeof v === 'string' && v.replace(/\|/g, '') === ''
).length;
const total = Object.values(snapshot).filter((v) => v !== null).length;
if (total > 0 && empties / total > 0.5) {
  console.error(`自检失败：${empties}/${total} 项属性为空，快照不可信。`);
  console.error('多半是读取属性名的方式有问题（camelCase vs kebab-case）。');
  process.exit(3);
}

fs.writeFileSync(outPath, JSON.stringify({ props: PROPS, targets: TARGETS, data: snapshot }, null, 2));
console.log(`快照已写入 ${outPath}（${Object.keys(snapshot).length} 项，${VIEWPORTS.length} 视口 × ${PAGES.length} 页 × ${TARGETS.length} 元素）`);
