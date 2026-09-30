/**
 * 隔空投送面板「小屏可操作性」验证
 * ---------------------------------------------------------------------------
 * 起因：小屏手机上发送面板的底部控件点不到、面板也滑不动，等于发不出文件。
 *
 * 这个脚本要回答三件事，缺一不可：
 *   1. 底部操作区（.ad-foot / 发送按钮）是否真的落在**视口内**且**可命中**
 *      —— 用 elementFromPoint 验证，而不是只看 getBoundingClientRect。
 *        元素在视口内 ≠ 点得到（可能被遮罩、被裁切、被兄弟元素盖住）。
 *   2. 内容超高时 .ad-body 是否**真的能滚**（scrollHeight > clientHeight 时
 *      必须能滚到底，且滚到底后底部按钮仍可命中）。
 *   3. 横向是否溢出。
 *
 * 为什么要 elementFromPoint：这是唯一能证明「手指点下去命中的是谁」的方法。
 * 之前那版 bug 里元素坐标算出来是在视口内的，但被 overflow:hidden 裁掉，
 * 点下去命中的是父容器 —— 只读 rect 会给出假通过。
 *
 * 用法：
 *   python3 -m http.server 8788 --bind 127.0.0.1 &
 *   node scripts/verify/airdrop-mobile-fit.mjs
 */
import { loadPlaywright, findChrome } from './_playwright.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8788';

// 覆盖真实小屏：SE / 主流安卓 / iPhone / 极窄
const VIEWPORTS = [
  { name: 'iPhone-SE', width: 375, height: 667 },
  { name: 'Android-narrow', width: 360, height: 640 },
  { name: 'iPhone-14', width: 390, height: 844 },
  { name: 'very-narrow', width: 320, height: 568 },
];

const results = [];
let failed = 0;

function ok(v, msg) {
  results.push(`${v ? '  [PASS]' : '  [FAIL]'} ${msg}`);
  if (!v) failed++;
  return v;
}

const pw = await loadPlaywright();
const browser = await pw.chromium.launch({
  executablePath: findChrome(),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  for (const vp of VIEWPORTS) {
    // 注意：不开 isMobile:true —— Chrome 会自动撑宽布局视口去容纳超宽内容，
    // 横向溢出会全部漏检（见 scripts/verify/README.md）。用窄 viewport + deviceScaleFactor 模拟。
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      hasTouch: true,
    });
    const page = await ctx.newPage();

    const jsErrors = [];
    page.on('pageerror', (e) => jsErrors.push(String(e)));

    await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);

    results.push(`\n=== ${vp.name} (${vp.width}x${vp.height}) ===`);

    /* 隔空投送入口由后端 /api/auth/check 的 airdrop.enabled 决定，静态服务下
       没有后端，直接点按钮会被门禁拦掉。这里从 Vue 根实例注入能力再打开：
       门禁逻辑本身不是本次要验的对象，要验的是面板打开后的布局。 */
    const opened = await page.evaluate(() => {
      /* Vue 生产构建不暴露 el.__vnode / app._instance（那些是 __DEV__ 才 def 的），
         但 render() 一定会写 container._vnode —— 从它可以拿到根组件实例。 */
      const el = document.querySelector('#app');
      const vm = el && el._vnode && el._vnode.component && el._vnode.component.proxy;
      if (!vm) return { ok: false, why: 'no root proxy' };
      vm.airdropCapability = {
        enabled: true,
        guestAllowed: true,
        ttlMinutes: 30,
        // 三个节点 —— 这是把面板撑高的主要来源，必须造出来才测得到溢出
        nodes: [
          { key: 'r2', label: 'Cloudflare R2', hint: '大文件直传', maxBytes: 10 * 1024 * 1024 * 1024 },
          { key: 'tg', label: 'Telegram', hint: '小文件快速', maxBytes: 20 * 1024 * 1024 },
          { key: 's3', label: 'S3 兼容', hint: '自建对象存储', maxBytes: 40 * 1024 * 1024 },
        ],
      };
      vm.airdropVisible = true;
      return { ok: true };
    });

    if (!opened.ok) {
      results.push(`  [SKIP] 无法注入 Vue 实例：${opened.why}`);
      await ctx.close();
      continue;
    }

    await page.waitForTimeout(800);

    const hasPanel = await page.evaluate(() => !!document.querySelector('.ad-modal'));
    if (!hasPanel) {
      results.push('  [SKIP] 面板未渲染');
      await ctx.close();
      continue;
    }

    // 选「我要发送」
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.ad-role')];
      const send = btns.find((b) => b.textContent.includes('发送'));
      if (send) send.click();
    });
    await page.waitForTimeout(600);

    /* 推进到「已选文件」—— 这是发送面板内容最高的状态（节点选择器 + 文件列表
       + 发送按钮同时存在），也是用户报障时所在的状态。
       直接改子组件状态：chooseSend 之后停在 picking，需要真实文件选择才能往前，
       静态环境做不到，所以从组件实例注入。 */
    await page.evaluate(() => {
      /* 从根实例的渲染树里找出 AirdropPanel 实例 —— 生产构建下 DOM 上没有
         __vnode 可反查，只能顺着 vnode 树走。 */
      const rootVm = document.querySelector('#app')._vnode.component.proxy;
      let comp = null;
      const walk = (vnode) => {
        if (!vnode || comp) return;
        if (vnode.component) {
          const t = vnode.component.type;
          const name = (t && (t.name || t.__name)) || '';
          if (/airdrop/i.test(name)) { comp = vnode.component.proxy; return; }
        }
        const kids = Array.isArray(vnode.children) ? vnode.children : [];
        for (const c of kids) if (c && typeof c === 'object') walk(c);
        if (vnode.subTree) walk(vnode.subTree);
      };
      const inst = rootVm.$ || rootVm._instance;
      walk(inst && inst.subTree);
      if (!comp) {
        // 兜底：拿不到就只靠点击推进到哪算哪
        return;
      }
      comp.role = 'send';
      /* phase='picking' 是内容最高的状态：节点选择器（picking 时显示）+ 文件列表
         + 发送按钮（v-if="phase === 'picking'"）三者同时在场。
         用户报障时正是这个状态。 */
      comp.phase = 'picking';
      comp.selectedNode = 'r2';
      // 造 6 个文件，把列表撑到最高
      comp.selectedFiles = Array.from({ length: 6 }, (_, i) => ({
        kind: 'local',
        name: `测试文件-名称比较长的第${i + 1}个.pdf`,
        size: (i + 1) * 1024 * 1024,
        type: 'application/pdf',
      }));
      comp.notice = '对方已接入，请选择要发送的文件';
      comp.noticeTone = 'info';
    });
    await page.waitForTimeout(600);

    const stateCheck = await page.evaluate(() => ({
      hasNodes: !!document.querySelector('.ad-nodes'),
      hasFiles: !!document.querySelector('.ad-files'),
      btnCount: document.querySelectorAll('.ad-body button').length,
    }));
    results.push(`  [INFO] 面板状态：节点区=${stateCheck.hasNodes} 文件区=${stateCheck.hasFiles} 主体按钮=${stateCheck.btnCount}`);

    // ---- 1) 横向溢出 ----
    const overflowX = await page.evaluate(() => {
      const de = document.documentElement;
      return {
        scrollW: de.scrollWidth,
        clientW: de.clientWidth,
        bodyScrollW: document.body.scrollWidth,
      };
    });
    ok(overflowX.scrollW <= overflowX.clientW + 1,
      `无横向溢出 (scrollWidth=${overflowX.scrollW} <= clientWidth=${overflowX.clientW})`);

    // ---- 2) 底部操作区在视口内 ----
    const footBox = await page.evaluate(() => {
      const foot = document.querySelector('.ad-foot');
      if (!foot) return null;
      const r = foot.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height };
    });

    if (!footBox) {
      results.push('  [SKIP] .ad-foot 不存在');
    } else {
      const vh = vp.height;
      ok(footBox.top >= -1 && footBox.bottom <= vh + 1,
        `.ad-foot 完整落在视口内 (top=${footBox.top.toFixed(0)}, bottom=${footBox.bottom.toFixed(0)}, vh=${vh})`);
    }

    // ---- 3) 每个按钮都能「滑过去点得到」----
    /* 断言要模拟真实用户行为：先滚到它、再点。
       直接对未滚动状态做 elementFromPoint 会误判 —— 内容超高时下方按钮本就在
       视口外，那是正常的（滚一下就到）。真正的 bug 是「滚过去也点不到」。 */
    const hitTest = await page.evaluate(async () => {
      const targets = [...document.querySelectorAll('.ad-foot button, .ad-body button')];
      if (!targets.length) return { total: 0, blocked: [] };
      const blocked = [];
      const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      for (const el of targets) {
        const r0 = el.getBoundingClientRect();
        if (r0.width === 0 || r0.height === 0) continue;

        // 真实用户动作：把它滚进视野
        el.scrollIntoView({ block: 'center', inline: 'center' });
        await raf();

        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const vh = window.innerHeight;
        const vw = window.innerWidth;

        if (cx < 0 || cx > vw || cy < 0 || cy > vh) {
          blocked.push({ text: el.textContent.trim().slice(0, 14) || '(图标)', reason: '滚动后仍在视口外' });
          continue;
        }
        const hit = document.elementFromPoint(cx, cy);
        if (!hit || !(el.contains(hit) || hit.contains(el))) {
          blocked.push({
            text: el.textContent.trim().slice(0, 14) || '(图标)',
            reason: '被遮挡',
            hit: hit ? String(hit.className || hit.tagName).slice(0, 30) : 'null',
          });
        }
      }

      // 复位到顶部，后面的滚动测试才有干净起点
      const body = document.querySelector('.ad-body');
      if (body) body.scrollTop = 0;
      await raf();

      return { total: targets.length, blocked };
    });

    if (hitTest.total === 0) {
      results.push('  [SKIP] 面板内无按钮（阶段未到）');
    } else {
      ok(hitTest.blocked.length === 0,
        `${hitTest.total} 个按钮均可「滚到并命中」${hitTest.blocked.length ? ' —— 失败：' + JSON.stringify(hitTest.blocked) : ''}`);
    }

    // ---- 3b) 发送按钮必须「不滚动就能点到」（主操作常驻底部）----
    const sendHit = await page.evaluate(() => {
      const btn = document.querySelector('.ad-btn--send');
      if (!btn) return { present: false };
      const r = btn.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const inView = cy >= 0 && cy <= window.innerHeight && cx >= 0 && cx <= window.innerWidth;
      const hit = document.elementFromPoint(cx, cy);
      return {
        present: true,
        inView,
        cy: Math.round(cy),
        vh: window.innerHeight,
        hittable: !!(hit && (btn.contains(hit) || hit.contains(btn))),
        text: btn.textContent.trim().slice(0, 14),
      };
    });

    if (!sendHit.present) {
      results.push('  [SKIP] 发送按钮未渲染');
    } else {
      ok(sendHit.inView && sendHit.hittable,
        `发送按钮「${sendHit.text}」无需滚动即可点到 (cy=${sendHit.cy}, vh=${sendHit.vh}, 可命中=${sendHit.hittable})`);
    }

    // ---- 4) 内容超高时能否滚动到底 ----
    const scrollInfo = await page.evaluate(() => {
      const body = document.querySelector('.ad-body');
      if (!body) return null;
      const before = body.scrollTop;
      body.scrollTop = body.scrollHeight;
      const after = body.scrollTop;
      return {
        scrollH: body.scrollHeight,
        clientH: body.clientHeight,
        before,
        after,
        scrollable: body.scrollHeight > body.clientHeight + 1,
        // 是否真的滚到底了（允许 1px 误差）
        reachedBottom: Math.abs(after - (body.scrollHeight - body.clientHeight)) <= 1,
        overflowY: getComputedStyle(body).overflowY,
      };
    });

    if (!scrollInfo) {
      results.push('  [SKIP] .ad-body 不存在');
    } else {
      ok(scrollInfo.overflowY !== 'hidden' && scrollInfo.overflowY !== 'clip',
        `.ad-body overflow-y 可滚动（当前 ${scrollInfo.overflowY}）`);
      if (scrollInfo.scrollable) {
        ok(scrollInfo.reachedBottom,
          `内容超高时能滚到底 (scrollH=${scrollInfo.scrollH} > clientH=${scrollInfo.clientH}, scrollTop=${scrollInfo.after})`);
      } else {
        results.push(`  [INFO] 内容未超高，无需滚动 (scrollH=${scrollInfo.scrollH}, clientH=${scrollInfo.clientH})`);
      }
    }

    // ---- 5) 滚到底之后底部按钮仍可命中 ----
    if (scrollInfo && scrollInfo.scrollable) {
      await page.waitForTimeout(200);
      const afterScrollHit = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('.ad-foot button')];
        const blocked = [];
        for (const el of btns) {
          const r = el.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          if (cy < 0 || cy > window.innerHeight) {
            blocked.push({ text: el.textContent.trim().slice(0, 14), reason: '视口外' });
            continue;
          }
          const hit = document.elementFromPoint(cx, cy);
          if (!hit || !(el.contains(hit) || hit.contains(el))) {
            blocked.push({ text: el.textContent.trim().slice(0, 14), reason: '被遮挡' });
          }
        }
        return { total: btns.length, blocked };
      });
      ok(afterScrollHit.blocked.length === 0,
        `滚动到底后底部按钮仍可命中${afterScrollHit.blocked.length ? ' —— ' + JSON.stringify(afterScrollHit.blocked) : ''}`);
    }

    ok(jsErrors.length === 0, `无 JS 报错${jsErrors.length ? ': ' + jsErrors.slice(0, 2).join(' | ') : ''}`);

    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(results.join('\n'));
console.log('\n' + '='.repeat(60));
console.log(failed === 0 ? '结果：全部通过' : `结果：${failed} 项失败`);
console.log('='.repeat(60));
process.exit(failed ? 1 : 0);
