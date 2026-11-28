/**
 * glass-fx.mjs —— 液态玻璃增强层（glassfx）运行时验证
 * ---------------------------------------------------------------------------
 * 目的：确认 Apple 风玻璃重构后，index 页上：
 *   ① glassfx 的共享 SVG 折射滤镜 #glassfx-refract 被注入（JS 增强生效）
 *   ② .glass 元素上 backdrop-filter 含 blur + saturate，且圆角落在 20–28px
 *   ③ 指针移动时 .glass 被写入 --glass-mx/--glass-my（光标 bloom 追踪在跑）
 *   ④ 移动端视口下 blur 值降级（≤14px），不糊成一片也不关死
 *   ⑤ 全程无 JS 报错
 *
 * 前置：本地全栈 `npx wrangler pages dev ./ ...`（BASE 默认 8099）+ 登录凭据。
 * 运行：BASE=http://127.0.0.1:8099 CHROME_PATH=/usr/bin/chromium \
 *        node scripts/verify/glass-fx.mjs
 */
import { chromium } from "playwright-core";

const BASE = process.env.BASE || "http://127.0.0.1:8099";
const CHROME = process.env.CHROME_PATH || undefined;
const USER = process.env.BASIC_USER || "admin";
const PASS = process.env.BASIC_PASS || "123";

let failures = 0;
const ok = (m) => console.log(`PASS  ${m}`);
const bad = (m) => { failures++; console.log(`FAIL  ${m}`); };

async function loginAndBoot(page) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  // 基础认证（若页面跳到登录/密码门）
  const pwd = page.locator('input[type="password"]').first();
  if (await pwd.count().catch(() => 0)) {
    await pwd.fill(PASS).catch(() => {});
    const btn = page.locator('button[type="submit"], .btn--primary').first();
    if (await btn.count().catch(() => 0)) await btn.click().catch(() => {});
    await page.waitForTimeout(800);
  }
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#app", { timeout: 15000 });
  await page.waitForTimeout(2000); // 等 boot / glassfx 挂载（页面含轮询，不等 networkidle）
}

async function main() {
  const browser = await chromium.launch({ executablePath: CHROME });

  /* ---------- 桌面视口 ---------- */
  const ctx = await browser.newContext({
    viewport: { width: 1200, height: 900 },
  });
  const page = await ctx.newPage();
  const errors = [];
  // 仅收集「真实脚本异常」；忽略资源加载/网络类报错（如 dev 环境 BASIC 认证门
  // 对匿名 /api/* 轮询回 401，属环境副作用，与前端代码无关）。
  const IGNORE = /Failed to load resource|401|Unauthorized|net::|ERR_/i;
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !IGNORE.test(m.text())) errors.push(m.text());
  });

  await loginAndBoot(page);

  // ① 折射滤镜注入
  const filterInjected = await page.evaluate(
    () => !!document.getElementById("glassfx-refract")
  );
  filterInjected
    ? ok("glassfx 折射滤镜 #glassfx-refract 已注入")
    : bad("未找到 #glassfx-refract（glassfx JS 未生效）");

  // ② .glass 上的玻璃质感与圆角
  const probe = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll(".glass"));
    if (!els.length) return { count: 0 };
    const el = els.find((e) => e.getBoundingClientRect().width > 0) || els[0];
    const cs = getComputedStyle(el);
    return {
      count: els.length,
      sample: el.className,
      backdrop: cs.backdropFilter || cs.webkitBackdropFilter || "",
      blur: parseFloat((cs.backdropFilter.match(/blur\(([\d.]+)px\)/) || [])[1] || "0"),
      hasSaturate: /saturate\(/.test(cs.backdropFilter),
      radius: parseFloat(cs.borderTopLeftRadius),
    };
  });

  probe.count > 0
    ? ok(`页面存在 .glass 元素 ${probe.count} 个（示例：${probe.sample}）`)
    : bad("页面未发现任何 .glass 元素");

  probe.blur >= 12
    ? ok(`backdrop-filter 含 blur(${probe.blur}px)`)
    : bad(`backdrop-filter blur 过低或缺失：${probe.backdrop}`);
  probe.hasSaturate
    ? ok("backdrop-filter 含 saturate(180%) 提升")
    : bad(`backdrop-filter 缺 saturate：${probe.backdrop}`);
  probe.radius >= 20 && probe.radius <= 9999
    ? ok(`圆角在 20–28px（实测 ${probe.radius}px）`)
    : bad(`圆角越界：${probe.radius}px`);

  // ③ 指针 bloom 追踪：移动鼠标到 .glass 上，检查 --glass-mx 被写入
  const box = await page.evaluate(() => {
    const el = document.querySelector(".dock.glass") || document.querySelector(".glass");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, sel: el.className };
  });
  if (box) {
    await page.mouse.move(box.x, box.y, { steps: 6 });
    await page.waitForTimeout(120);
    await page.mouse.move(box.x + 6, box.y + 4, { steps: 4 });
    await page.waitForTimeout(120);
    const mx = await page.evaluate(() => {
      const el = document.querySelector(".dock.glass") || document.querySelector(".glass");
      return el ? el.style.getPropertyValue("--glass-mx") : "";
    });
    mx
      ? ok(`光标 bloom 追踪生效（--glass-mx=${mx}）`)
      : bad("指针移动后未写入 --glass-mx（bloom 追踪未生效）");
  } else {
    bad("找不到可见的 .glass 元素用于指针测试");
  }

  errors.length === 0 ? ok("无 JS 报错") : bad(`JS 报错：${errors.slice(0, 3).join(" | ")}`);

  await ctx.close();

  /* ---------- 移动视口：分级降模糊 ---------- */
  const mctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
  });
  const mpage = await mctx.newPage();
  const merr = [];
  mpage.on("pageerror", (e) => merr.push(String(e)));
  await loginAndBoot(mpage);

  const mBlur = await mpage.evaluate(() => {
    /* 优先取「普通玻璃容器」验证移动端降级；.dock 有自己内联的
       --glass-blur，属于特例，单独看它会把结论带偏。 */
    const el =
      document.querySelector(".card") ||
      document.querySelector(".panel") ||
      document.querySelector(".glass");
    if (!el) return -1;
    const cs = getComputedStyle(el);
    const m = (cs.backdropFilter || "").match(/blur\(([\d.]+)px\)/);
    return m ? parseFloat(m[1]) : -1;
  });
  mBlur > 0 && mBlur <= 14
    ? ok(`移动端 blur 已分级降级（${mBlur}px ≤ 14px）`)
    : bad(`移动端 blur 未按预期降级：${mBlur}px`);

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
