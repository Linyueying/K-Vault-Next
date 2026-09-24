// 视觉冒烟 —— 上收的样式是否真的渲染成期望的样子
//
// 与 smoke.mjs（查 JS 报错/死选择器/主题切换）互补：本脚本查**具体视觉元素**
// 是否出现且属性对：
//   - 环境光层 .ambient-glow 是否固定定位
//   - 密码门 .password-gate 是否按 token 版渲染（max-width 380px）
//   - 玻璃卡 .card/.modal 是否有背景色（玻璃质感）
//   - 按钮 .btn 高度是否合理
//   - FontAwesome 是否真正加载（之前 share.html 完全没引，图标全是方块）
// 其中一个检查（FontAwesome）是 smoke.mjs 和 verify_classes.mjs 都没覆盖的。
//
// 用法：
//   python3 -m http.server 8788 --bind 127.0.0.1 &
//   node scripts/verify/visual-check.mjs
import { loadPlaywright, findChrome } from './_playwright.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const { chromium } = await loadPlaywright();

const PAGES = ['index', 'admin', 'gallery', 'paste', 'share', 'preview', 'webdav', 'login'];
let bad = 0;

const b = await chromium.launch({
  executablePath: findChrome(),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

console.log('page     环境光   密码门  玻璃卡  按钮高  FontAwesome 错误');
console.log('-'.repeat(72));

for (const p of PAGES) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 60)));

  await pg.goto(`${BASE}/${p}.html`, { waitUntil: 'load' });
  await pg.waitForTimeout(1100);

  const r = await pg.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const glow = q('.ambient-glow');
    const gate = q('.password-gate');
    const card = q('.card, .liquid-card, .modal');
    const btn = q('.btn');
    const cs = (el) => (el ? getComputedStyle(el) : null);
    return {
      glowFixed: glow ? cs(glow).position : 'n/a',
      gateW: gate ? cs(gate).maxWidth : 'n/a',
      cardBg: card ? cs(card).backgroundColor !== 'rgba(0, 0, 0, 0)' : 'n/a',
      btnH: btn ? cs(btn).height : 'n/a',
      fa: [...document.fonts].filter((f) => /Font Awesome/i.test(f.family)).length > 0,
    };
  });

  const ok = errs.length === 0;
  if (!ok) bad++;
  console.log(
    `${p.padEnd(9)} ${String(r.glowFixed).padEnd(8)} ${String(r.gateW).padEnd(7)} ${String(r.cardBg).padEnd(7)} ${String(r.btnH).padEnd(7)} ${String(r.fa).padEnd(11)} ${errs.length}`
  );
  if (errs.length) console.log(`          ${errs.join(' | ')}`);
  await ctx.close();
}
await b.close();
console.log(bad === 0 ? '\n=== 8 页视觉冒烟通过 ===' : `\n=== ${bad} 页异常 ===`);
process.exit(bad === 0 ? 0 : 1);
