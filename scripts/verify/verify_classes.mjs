// 验证「上收到 design-system.css 的类」确实在 8 页都生效
//
// 背景：本次改造把 .ambient-glow / .ambient-orb / .mono / .grow / .password-gate*
// / .modal 等从各页面内联 <style> 上收到了唯一共享样式层。这些类如果在某页
// 没生效（比如漏了 <link>，或哪页把定义删了），页面会退回到默认值，肉眼难查。
//
// 本脚本**就地构造带这些类的元素**，读它的计算样式，逐属性核对：
//   - 值正确（证明规则来自共享层）
//   - 不会因「页面删了定义」就变默认值
//
// 与 smoke.mjs 的区别：smoke 查 JS 报错 / 死选择器 / 主题切换；
// 本脚本查的是「这些**特定的共享类**渲染出来是不是对的」——smoke 不覆盖这一项。
//
// 用法：
//   python3 -m http.server 8788 --bind 127.0.0.1 &
//   node scripts/verify/verify_classes.mjs
//   端口非 8788：BASE=http://127.0.0.1:8099 node scripts/verify/verify_classes.mjs
import { loadPlaywright, findChrome } from './_playwright.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8788';
const { chromium } = await loadPlaywright();

// 期望：类名 -> { 属性: 期望值 }。期望值是规范化后的计算值字符串（或正则）。
// 这些值是按 design-system.css / 本次上收的定义填的，改了共享层要同步改这里。
const EXPECT = {
  '.ambient-glow':     { position: 'fixed', pointerEvents: 'none', overflow: 'hidden' },
  '.ambient-orb':      { position: 'absolute', borderRadius: '50%' },
  '.mono':             { fontFamily: /JetBrains Mono/ },
  '.grow':             { flexGrow: '1' },
  '.password-gate':    { flexDirection: 'column', maxWidth: '380px' },
  '.password-gate-icon': { width: '52px', height: '52px', borderRadius: '50%' },
  '.password-gate-form': { display: 'flex', gap: '8px' },
  '.modal':            { overflowY: 'auto' },
};

const PAGES = ['index', 'admin', 'gallery', 'paste', 'share', 'preview', 'webdav', 'login'];
let pass = 0, fail = 0;

const b = await chromium.launch({
  executablePath: findChrome(),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

for (const p of PAGES) {
  const ctx = await b.newContext();
  const pg = await ctx.newPage();
  await pg.goto(`${BASE}/${p}.html`, { waitUntil: 'load' });
  await pg.waitForTimeout(800);
  const r = await pg.evaluate((exp) => {
    const out = {};
    for (const [cls, props] of Object.entries(exp)) {
      const el = document.createElement('div');
      el.className = cls.slice(1);
      // 不设 inline 几何，避免盖掉类里的值；挂到屏幕外隐藏
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:-99999px;top:0;width:0;height:0;overflow:hidden;';
      host.appendChild(el);
      document.body.appendChild(host);
      const cs = getComputedStyle(el);
      const got = {};
      for (const k of Object.keys(props)) got[k] = cs[k];
      out[cls] = got;
      host.remove();
    }
    return out;
  }, EXPECT);

  const errs = [];
  for (const [cls, props] of Object.entries(EXPECT)) {
    for (const [k, want] of Object.entries(props)) {
      const got = r[cls]?.[k];
      const ok = want instanceof RegExp ? want.test(got) : String(got).startsWith(String(want));
      if (!ok) errs.push(`${cls} ${k}: 期望 ${want instanceof RegExp ? want : String(want)} 实际 ${got}`);
    }
  }
  if (errs.length === 0) { pass++; console.log(`${p.padEnd(9)} OK`); }
  else { fail++; console.log(`${p.padEnd(9)} <<< ${errs.join(' ; ')}`); }
  await ctx.close();
}
await b.close();
console.log(`\n=== ${pass} 页通过 / ${fail} 页失败 ===`);
process.exit(fail === 0 ? 0 : 1);
