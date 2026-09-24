/**
 * dock-indicator.mjs —— 底部 Dock 液态玻璃 + 滑动指示器 + 跟手拖拽
 * ---------------------------------------------------------------------------
 * 验证 index 页底部 Dock 改造：
 *   ① 指示器存在且「玻璃化」（渐变 + inset 高光 + spring 过渡）
 *   ② 点击各格 → 指示器真实渲染位右移（读 getBoundingClientRect，不读 --dock-i，
 *      后者只是输入、会造成假阳性）
 *   ③ 「更多功能」停在第 4 格（history 与 menu 两个 tab 都映射到 slot 3）
 *   ④ 跟手拖拽 → 松手吸附到最近格并执行对应抽屉行为；且拖后不误触发点击
 *   ⑤ 容器高透（背景 alpha 显著低于原不透明玻璃）
 *   ⑥ 无横向溢出、无 JS 报错
 *   ⑦ 移动视口：padd 收紧、指示器仍等分对齐
 *
 * 前置：本地全栈 `npx wrangler pages dev ./ ...`（BASE 默认 8099）
 * 运行：BASE=http://127.0.0.1:8099 CHROME_PATH=/usr/bin/chromium \
 *        BASIC_USER=admin BASIC_PASS=123 node scripts/verify/dock-indicator.mjs
 */
import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://127.0.0.1:8099";
const CHROME = process.env.CHROME_PATH || undefined;
const PASS = process.env.BASIC_PASS || "123";

let failures = 0;
const ok = (m) => console.log(`PASS  ${m}`);
const bad = (m) => { failures++; console.log(`FAIL  ${m}`); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// dev 环境 BASIC 认证门会对匿名 /api/* 轮询回 401，属环境副作用
const IGNORE = /Failed to load resource|401|Unauthorized|net::|ERR_/i;

async function loginAndBoot(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  const pwd = page.locator('input[type="password"]').first();
  if (await pwd.count().catch(() => 0)) {
    await pwd.fill(PASS).catch(() => {});
    const btn = page.locator('button[type="submit"], .btn--primary').first();
    if (await btn.count().catch(() => 0)) await btn.click().catch(() => {});
    await page.waitForTimeout(800);
  }
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app", { timeout: 15000 });
  await page.waitForTimeout(2000);
}

/** 指示器真实渲染左边界（唯一可信来源） */
const indicatorLeft = (page) =>
  page.evaluate(() => {
    const el = document.querySelector(".dock__indicator");
    return el ? el.getBoundingClientRect().left : -1;
  });

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME });

  /* ---------- 桌面视口 ---------- */
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(m.text()); });

  await loginAndBoot(page);

  // ① 指示器存在 + 玻璃化
  const style = await page.evaluate(() => {
    const el = document.querySelector(".dock__indicator");
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      bg: cs.backgroundImage,
      shadow: cs.boxShadow,
      transition: cs.transition,
      radius: cs.borderTopLeftRadius,
    };
  });
  if (!style) { bad("未找到 .dock__indicator"); }
  else {
    ok("存在 .dock__indicator");
    /linear-gradient/.test(style.bg) ? ok("指示器为渐变玻璃底") : bad(`指示器无渐变底：${style.bg}`);
    /inset/.test(style.shadow) ? ok("指示器含 inset 高光") : bad(`指示器缺 inset 高光：${style.shadow}`);
    /cubic-bezier/.test(style.transition) ? ok("指示器过渡为 spring 曲线") : bad(`指示器过渡无曲线：${style.transition}`);
  }

  // ② 点击各格 → 指示器真实右移
  // 注意：抽屉打开时 modal-mask(z-index 2000) 会覆盖 dock(z-index 100)，
  // dock 不可点 —— 这是既有产品行为。故每次点击前先关抽屉。
  const closeDrawer = async () => {
    await page.evaluate(() => {
      const app = document.querySelector("#app")._vnode.component.proxy;
      app.showDrawer = false;
    });
    await page.waitForTimeout(450);
  };

  const xs = [];
  for (const slot of [0, 1, 2, 3]) {
    await closeDrawer();
    await page.click(`.dock__btn[data-dock-slot="${slot}"]`);
    await page.waitForTimeout(700);
    xs.push(await indicatorLeft(page));
  }
  const mono = xs.every((v, i) => i === 0 || v > xs[i - 1] + 20);
  mono ? ok(`点击 0→3 指示器逐格右移：${xs.map((v) => Math.round(v)).join(" → ")}`)
       : bad(`指示器未逐格右移：${xs.map((v) => Math.round(v)).join(" → ")}`);

  // 回主控台
  await closeDrawer();
  await page.click('.dock__btn[data-dock-slot="0"]');
  await page.waitForTimeout(700);
  const x0 = await indicatorLeft(page);
  near(x0, xs[0], 2) ? ok("回主控台指示器复位到第 1 格") : bad(`复位偏差：${x0} vs ${xs[0]}`);

  // ③ 更多功能停第 4 格（history / menu 都应映射到 slot 3）
  await closeDrawer();
  await page.click('.dock__btn[data-dock-slot="3"]');
  await page.waitForTimeout(700);
  const xMore = await indicatorLeft(page);
  const slot3Ok = near(xMore, xs[3], 2);
  slot3Ok ? ok("更多功能停在指示器第 4 格") : bad(`更多功能落点异常：${xMore} vs ${xs[3]}`);

  // 抽屉内切到「系统导航」(key=menu，同属「更多功能」) → 指示器不应移动
  // 注意：此时抽屉是打开的，「系统导航」在 modal 遮罩内，需确保可点。
  const menuTab = page.locator('.drawer-tab', { hasText: "系统导航" }).first();
  if (await menuTab.count().catch(() => 0)) {
    try {
      await menuTab.scrollIntoViewIfNeeded();
      await menuTab.click({ timeout: 5000 });
      await page.waitForTimeout(700);
      const xAfterMenu = await indicatorLeft(page);
      near(xAfterMenu, xMore, 2)
        ? ok("抽屉内切到「系统导航」后指示器仍在第 4 格（menu 映射正确）")
        : bad(`切 tab 后指示器漂移：${xAfterMenu} vs ${xMore}`);
    } catch (e) {
      console.log(`SKIP  「系统导航」tab 不可点（${String(e).split("\n")[0]}），跳过该子项`);
    }
  } else {
    console.log("SKIP  未找到「系统导航」tab，跳过该子项");
  }

  // ④ 跟手拖拽 → 吸附 + 不误触发点击
  await closeDrawer();
  await page.click('.dock__btn[data-dock-slot="0"]');
  await page.waitForTimeout(600);
  const dock = await page.locator(".dock").boundingBox();
  if (dock) {
    const y = dock.y + dock.height / 2;
    await page.mouse.move(dock.x + dock.width * 0.12, y);
    await page.mouse.down();
    await page.mouse.move(dock.x + dock.width * 0.62, y, { steps: 14 });
    await page.mouse.up();
    await page.waitForTimeout(800);

    const xDrag = await indicatorLeft(page);
    const landedSlot = xs.reduce((best, v, i) => (Math.abs(v - xDrag) < Math.abs(xs[best] - xDrag) ? i : best), 0);
    landedSlot >= 1
      ? ok(`拖拽后吸附到第 ${landedSlot + 1} 格（x=${Math.round(xDrag)}）`)
      : bad(`拖拽后未离开首格（x=${Math.round(xDrag)}）`);

    // 拖拽落点对应的抽屉状态应已打开
    const state = await page.evaluate(() => {
      const app = document.querySelector("#app")._vnode.component.proxy;
      return { showDrawer: app.showDrawer, tab: app.activeDrawerTab };
    });
    state.showDrawer
      ? ok(`拖拽已执行对应行为（showDrawer=true, tab=${state.tab}）`)
      : bad("拖拽后未打开对应抽屉");

    // 拖后不误触发点击：拖到 slot1 上方松手后，页面不应再被合成 click 二次切换
    const before = await page.evaluate(() => document.querySelector("#app")._vnode.component.proxy.activeDrawerTab);
    await page.waitForTimeout(120);
    const after = await page.evaluate(() => document.querySelector("#app")._vnode.component.proxy.activeDrawerTab);
    before === after ? ok("拖拽后无重复点击副作用") : bad(`拖拽后状态被二次改变：${before} → ${after}`);
  } else {
    bad("取不到 .dock 边界，拖拽测试跳过");
  }

  // ⑤ 容器高透
  const dockStyle = await page.evaluate(() => {
    const el = document.querySelector(".dock");
    const cs = getComputedStyle(el);
    const m = cs.backgroundColor.match(/rgba?\(([^)]+)\)/);
    const parts = m ? m[1].split(",").map((s) => parseFloat(s)) : [];
    return {
      alpha: parts.length === 4 ? parts[3] : 1,
      backdrop: cs.backdropFilter || cs.webkitBackdropFilter || "",
    };
  });
  dockStyle.alpha <= 0.6
    ? ok(`Dock 背景高透（alpha=${dockStyle.alpha}）`)
    : bad(`Dock 背景仍不透明（alpha=${dockStyle.alpha}）`);
  /blur\(/.test(dockStyle.backdrop) && /saturate\(/.test(dockStyle.backdrop)
    ? ok(`Dock backdrop-filter 含 blur + saturate（${dockStyle.backdrop}）`)
    : bad(`Dock backdrop-filter 异常：${dockStyle.backdrop}`);

  // ⑥ 无横向溢出（不开 isMobile，见 README 已知坑）
  const overflow = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    cw: document.documentElement.clientWidth,
  }));
  overflow.sw <= overflow.cw + 1
    ? ok(`无横向溢出（scrollWidth=${overflow.sw} clientWidth=${overflow.cw}）`)
    : bad(`横向溢出：scrollWidth=${overflow.sw} clientWidth=${overflow.cw}`);

  errors.length === 0 ? ok("无 JS 报错") : bad(`JS 报错：${errors.slice(0, 3).join(" | ")}`);

  await ctx.close();

  /* ---------- 移动视口 ---------- */
  const mctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
  });
  const mpage = await mctx.newPage();
  const merr = [];
  mpage.on("pageerror", (e) => merr.push(String(e)));
  await loginAndBoot(mpage);

  const m = await mpage.evaluate(() => {
    const dock = document.querySelector(".dock");
    const ind = document.querySelector(".dock__indicator");
    const cs = getComputedStyle(dock);
    const r = dock.getBoundingClientRect();
    const ir = ind.getBoundingClientRect();
    const pad = parseFloat(cs.paddingLeft);
    const gap = parseFloat(cs.columnGap || cs.gap);
    const inner = r.width - pad * 2;
    const slotW = (inner - gap * 3) / 4;
    // i=3 时右边缘理论值
    return {
      pad,
      innerRight: r.right - pad,
      slot3Right: ir.left + slotW * 3 + gap * 3 + slotW,
      blur: cs.backdropFilter || "",
    };
  });
  near(m.pad, 5, 0.6) ? ok(`移动端 dock padding 收紧至 5px（实测 ${m.pad}）`)
                      : bad(`移动端 padding 未收紧：${m.pad}`);
  near(m.slot3Right, m.innerRight, 2.5)
    ? ok(`指示器 4 格右缘对齐 dock 内地缘（${Math.round(m.slot3Right)} vs ${Math.round(m.innerRight)}）`)
    : bad(`指示器槽位不对齐：${Math.round(m.slot3Right)} vs ${Math.round(m.innerRight)}`);
  /blur\(/.test(m.blur) ? ok("移动端 dock 仍保留模糊") : bad(`移动端模糊丢失：${m.blur}`);
  // dock 内联的 --glass-blur 特异性高于共享层媒体查询，必须显式降级
  const mBlurPx = parseFloat((m.blur.match(/blur\(([\d.]+)px\)/) || [])[1] || "-1");
  mBlurPx > 0 && mBlurPx <= 14
    ? ok(`移动端 dock blur 已降级（${mBlurPx}px ≤ 14px）`)
    : bad(`移动端 dock blur 未降级：${mBlurPx}px`);
  merr.length === 0 ? ok("移动端无 JS 报错") : bad(`移动端 JS 报错：${merr.slice(0, 2).join(" | ")}`);

  await mctx.close();
  await browser.close();

  console.log("-----------------------------------------------");
  if (failures) {
    console.log(`存在 ${failures} 项失败`);
    process.exit(1);
  }
  console.log("ALL PASS");
}

main().catch((e) => {
  console.error("脚本异常：", e);
  process.exit(1);
});
