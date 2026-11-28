// 端到端验证：重写后的 share.html 分享详情页
//
// 覆盖「单文件分享」与「合集分享」两条形态在真实页面上的表现：
//   A. 双栏骨架：桌面左右并排 / 窄屏上下堆叠 / 三档视口不横向溢出
//   B. 单文件：hero 概览、FontAwesome 图标、无 emoji、完整元信息面板
//   C. 单文件：有效期与配额的「阻断态」（不是点了下载才失败）
//   D. 合集：清单图标按类型分色、搜索、排序、多选批量下载
//   E. 合集：静默刷新保留勾选
//   F. 密码门 / 失效态 / 无 JS 报错
//
// 为什么必须跑在 wrangler pages dev 上：
//   分享的有效期 / 次数 / 密码校验全在 Functions 侧，静态服务器 + mock 接口
//   测不出任何真实语义；清单成员也要由服务端按 bundle.fileIds 真实解析。
//
// 为什么在页面里发请求而不是 context.request：
//   会话 cookie 带 Secure; SameSite=Strict，在 http://127.0.0.1 上 Chromium
//   的网络栈不会持久化它；页面内的 fetch 走「非安全上下文豁免」路径能正常带上。
//
// 用法：
//   1) 起本地全栈（见 AI-OPERATIONS.md §0）：
//        npx wrangler pages dev ./ \
//          --kv "img_url" --r2=R2_BUCKET \
//          --compatibility-date=2026-05-03 \
//          --port 8099 --persist-to /tmp/kvdata \
//          --binding BASIC_USER=admin --binding BASIC_PASS=123
//   2) node scripts/verify/share-page.mjs
//
// 故障注入（证明脚本能抓到故障，见 README 的铁律）：
//   BREAK_TONE=1    node scripts/verify/share-page.mjs   # 抹掉类型配色
//   BREAK_ALLPICK=1 node scripts/verify/share-page.mjs   # 「全选」不受搜索限制
//
// 依赖：playwright-core（解析逻辑见 _playwright.mjs）+ node:sqlite（预置数据）
import { loadPlaywright, findChrome } from './_playwright.mjs';
import { ensureSeedFiles } from './_seed-kv.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const USER = process.env.BASIC_USER || 'admin';
const PASS = process.env.BASIC_PASS || '123';

const BREAK_TONE = process.env.BREAK_TONE === '1';
const BREAK_ALLPICK = process.env.BREAK_ALLPICK === '1';

const { chromium } = await loadPlaywright();

const results = [];
const rec = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  [${pass ? 'OK  ' : 'FAIL'}] ${name}${pass ? '' : ' -> ' + detail}`);
};

const browser = await chromium.launch({
  executablePath: findChrome(),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

/* 6 个成员：类型、大小、名称三者各自独立成序 ——
   否则「按名称排序」和「按大小排序」会给出同一个顺序，排序断言会假通过。 */
const SEEDS = [
  { name: 'sp-a-alpha.png',    fileType: 'image',    fileSize: 100000 },
  { name: 'sp-b-beta.mp4',     fileType: 'video',    fileSize: 900000 },
  { name: 'sp-c-gamma.mp3',    fileType: 'audio',    fileSize: 300000 },
  { name: 'sp-d-delta.pdf',    fileType: 'document', fileSize: 700000 },
  { name: 'sp-e-epsilon.zip',  fileType: 'document', fileSize: 200000 },
  { name: 'sp-f-zeta.xlsx',    fileType: 'document', fileSize: 500000 },
];
const NAMES = SEEDS.map((s) => s.name);
// 名称升序（拉丁字母在 zh-Hans-CN 下同样 a<b<c…）
const BY_NAME = [...NAMES];
// 大小升序：100k 200k 300k 500k 700k 900k
const BY_SIZE_ASC = ['sp-a-alpha.png', 'sp-e-epsilon.zip', 'sp-c-gamma.mp3', 'sp-f-zeta.xlsx', 'sp-d-delta.pdf', 'sp-b-beta.mp4'];

let page;
const call = (path, { method = 'GET', body } = {}) =>
  page.evaluate(
    async ({ path, method, body, base }) => {
      const res = await fetch(base + path, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
      const text = await res.text().catch(() => '');
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      return { status: res.status, body: parsed };
    },
    { path, method, body, base: BASE }
  );

/**
 * 读取 Vue 根实例上的若干字段。
 *
 * 注意：不能把 proxy 本身 evaluate 出来 —— 它带着整棵组件树的循环引用，
 * Playwright 序列化时会直接报 "object reference chain is too long"。
 * 所以一律在页面内取好需要的原始值再回传。
 */

/** 读一个字段：`peek('state')` / `peek('isBundle')` */
const peek = (field) =>
  page.evaluate(
    (f) => document.querySelector('#app')._vnode.component.proxy[f],
    field
  );

/** 读一组字段：`peekAll(['state', 'isBundle'])` → `{state, isBundle}` */
const peekAll = (fields) =>
  page.evaluate(
    (fs) => {
      const a = document.querySelector('#app')._vnode.component.proxy;
      const out = {};
      fs.forEach((f) => { out[f] = a[f]; });
      return out;
    },
    fields
  );

/** 等到页面离开 loading 态（ready / error / password 都算落地）。 */
const settled = (timeout = 20000) =>
  page.waitForFunction(
    () => {
      const el = document.querySelector('#app');
      if (!el || !el._vnode) return false;
      const s = el._vnode.component.proxy.state;
      return s === 'ready' || s === 'error' || s === 'password';
    },
    null,
    { timeout }
  );

/**
 * 打开分享页并等它落地。
 *
 * 之后还要等入场动画跑完才能量位置：`.layout .card` 挂着 riseIn
 * （含 translateY），动画期间 getBoundingClientRect 读到的是位移后的盒子，
 * 量「左右两栏顶部是否对齐」会得到 16px 的假偏差。
 */
const open = async (qs, viewport) => {
  if (viewport) await page.setViewportSize(viewport);
  await page.goto(`${BASE}/share.html?${qs}`, { waitUntil: 'load', timeout: 20000 });
  await settled();
  await page.waitForTimeout(800);
};

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e.message).split('\n')[0]));

  await page.goto(`${BASE}/login.html`, { waitUntil: 'load', timeout: 20000 });

  /* ---------------- 0. 登录 + 预置数据 ---------------- */
  const login = await call('/api/auth/login', { method: 'POST', body: { username: USER, password: PASS } });
  rec('管理员登录', login.status === 200 && login.body?.success === true,
    `HTTP ${login.status} ${JSON.stringify(login.body).slice(0, 120)}`);
  if (login.status !== 200) throw new Error('登录失败，后续用例无意义');

  const seeded = await ensureSeedFiles(SEEDS);
  rec('预置 6 个不同类型的文件到 KV', seeded.ok === true, seeded.reason || '');
  if (!seeded.ok) throw new Error('预置文件失败：' + (seeded.reason || ''));

  /* ---------------- 1. 建两种分享 ---------------- */
  const fileSlug = 'spfile' + Date.now().toString(36).slice(-5);
  const fileShare = await call(`/api/manage/share/${encodeURIComponent(NAMES[0])}`, {
    method: 'POST', body: { action: 'create', expiresIn: 0, slug: fileSlug },
  });
  const sSlug = fileShare.body?.slug || fileShare.body?.shareSlug || fileShare.body?.share?.slug;
  rec('创建单文件分享', !!sSlug,
    `HTTP ${fileShare.status} ${JSON.stringify(fileShare.body).slice(0, 160)}`);

  const bundle = await call('/api/manage/share-bundle', {
    method: 'POST', body: { action: 'create', fileIds: NAMES },
  });
  const bSlug = bundle.body?.slug;
  rec('创建 6 文件合集', bundle.status === 200 && bundle.body?.fileCount === 6,
    `HTTP ${bundle.status} fileCount=${bundle.body?.fileCount}`);

  const pwBundle = await call('/api/manage/share-bundle', {
    method: 'POST', body: { action: 'create', fileIds: NAMES.slice(0, 3), password: 'sp-secret' },
  });
  const pwSlug = pwBundle.body?.slug;
  rec('创建带密码的合集', !!pwSlug && pwBundle.body?.passwordProtected === true,
    `HTTP ${pwBundle.status} ${JSON.stringify(pwBundle.body).slice(0, 140)}`);

  if (!sSlug || !bSlug) throw new Error('缺少分享标识，后续用例无法继续');

  /* ================= A. 双栏骨架 ================= */
  await open(`s=${encodeURIComponent(sSlug)}`, { width: 1280, height: 900 });
  const s1 = await peek('state');
  rec('A1 单文件分享进入 ready 态', s1 === 'ready', String(s1));

  const twoCol = await page.evaluate(() => {
    const main = document.querySelector('.layout > section.card');
    const side = document.querySelector('.layout > aside.side');
    if (!main || !side) return null;
    const a = main.getBoundingClientRect();
    const b = side.getBoundingClientRect();
    return { ax: Math.round(a.x), ay: Math.round(a.y), aw: Math.round(a.width),
             bx: Math.round(b.x), by: Math.round(b.y), bw: Math.round(b.width) };
  });
  rec('A2 桌面 1280：左右并排（右栏在主栏右侧、顶部对齐）',
    !!twoCol && twoCol.bx >= twoCol.ax + twoCol.aw - 2 && Math.abs(twoCol.by - twoCol.ay) <= 4,
    JSON.stringify(twoCol));
  rec('A3 桌面 1280：右栏有最小宽度（内容不被压扁）',
    !!twoCol && twoCol.bw >= 292, `side width=${twoCol?.bw}`);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(120);
  const oneCol = await page.evaluate(() => {
    const main = document.querySelector('.layout > section.card');
    const side = document.querySelector('.layout > aside.side');
    if (!main || !side) return null;
    const a = main.getBoundingClientRect();
    const b = side.getBoundingClientRect();
    return { ax: Math.round(a.x), ay: Math.round(a.y), bx: Math.round(b.x), by: Math.round(b.y) };
  });
  rec('A4 窄屏 390：上下堆叠（右栏落到主栏下方、左对齐）',
    !!oneCol && oneCol.by > oneCol.ay && Math.abs(oneCol.bx - oneCol.ax) <= 2,
    JSON.stringify(oneCol));

  for (const vp of [{ width: 390, height: 844 }, { width: 768, height: 900 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(vp);
    await page.waitForTimeout(120);
    const over = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
    }));
    rec(`A5 ${vp.width}px 无横向溢出`, over.sw <= over.cw + 1, JSON.stringify(over));
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  /* ================= B. 单文件：概览 + 元信息 ================= */
  const hero = await page.evaluate(() => {
    const el = document.querySelector('.hero__name');
    const sub = document.querySelector('.hero__sub');
    const thumb = document.querySelector('.hero__thumb i');
    return {
      name: el ? el.textContent.trim() : '',
      sub: sub ? sub.textContent.replace(/\s+/g, ' ').trim() : '',
      iconClass: thumb ? thumb.className : '',
      iconFont: thumb ? getComputedStyle(thumb, '::before').fontFamily : '',
      tone: document.querySelector('.hero__thumb')
        ? getComputedStyle(document.querySelector('.hero__thumb')).color : '',
    };
  });
  rec('B1 hero 显示文件名', hero.name === NAMES[0], hero.name);
  rec('B2 hero 副行有类型 / 大小 / 相对时间',
    /图片/.test(hero.sub) && /KB|MB|B/.test(hero.sub) && /(刚刚|分钟前|小时前|天前)/.test(hero.sub),
    hero.sub);
  rec('B3 图标是 FontAwesome（class + 字体族都对）',
    /fa-image/.test(hero.iconClass) && /Font Awesome/i.test(hero.iconFont),
    `${hero.iconClass} | ${hero.iconFont}`);
  rec('B4 缩略图按类型着色（不是默认主色）',
    !!hero.tone && hero.tone !== 'rgb(2, 132, 199)', hero.tone);

  const noEmoji = await page.evaluate(() => {
    const t = document.body.innerText || '';
    // 常见 emoji 区段：杂项符号 / 表情 / 交通地图 / 补充符号
    const m = t.match(/[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu);
    return m ? m.slice(0, 8) : [];
  });
  rec('B5 页面正文无 emoji', noEmoji.length === 0, JSON.stringify(noEmoji));

  const meta = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.meta__row')].map((r) => ({
      k: r.querySelector('.meta__k')?.textContent.trim() || '',
      v: r.querySelector('.meta__v')?.textContent.replace(/\s+/g, ' ').trim() || '',
    }));
    return rows;
  });
  const metaKeys = meta.map((r) => r.k);
  rec('B6 元信息面板含 6 行（类型/大小/分享时间/有效期/下载次数/访问密码）',
    ['类型', '大小', '分享时间', '有效期', '下载次数', '访问密码'].every((k) => metaKeys.includes(k)),
    JSON.stringify(metaKeys));
  const rowOf = (k) => meta.find((r) => r.k === k)?.v || '';
  rec('B7 类型行给出细分标签而非笼统「文件」', rowOf('类型') === '图片', rowOf('类型'));
  rec('B8 未设限：有效期=永久有效、次数=不限次数',
    /永久有效/.test(rowOf('有效期')) && /不限次数/.test(rowOf('下载次数')),
    `${rowOf('有效期')} | ${rowOf('下载次数')}`);
  rec('B9 分享时间同时给出绝对时间与相对时间',
    /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(rowOf('分享时间')) && /(刚刚|分钟前|小时前|天前)/.test(rowOf('分享时间')),
    rowOf('分享时间'));
  rec('B10 访问密码行标明公开/需密码', /公开访问|需要密码/.test(rowOf('访问密码')), rowOf('访问密码'));

  const dlBtn = await page.evaluate(() => {
    const a = document.querySelector('.side__actions a.btn');
    return a ? { href: a.getAttribute('href'), dl: a.getAttribute('download'), text: a.textContent.trim() } : null;
  });
  rec('B11 右栏主按钮是带 dl=1 的下载链接',
    !!dlBtn && /dl=1/.test(dlBtn.href) && dlBtn.dl === NAMES[0] && /下载文件/.test(dlBtn.text),
    JSON.stringify(dlBtn));

  /* ================= C. 阻断态 ================= */
  // 说明：服务端在 share-info 上就已经拦了过期 / 超次，页面拿到的是 410 → error 态。
  // 下面这条路径是「页面开着的时候走到临界点」：30 秒一次的 now 刷新会重算
  // expiryInfo，于是 blockReason 生效、下载按钮提前变灰。这里直接推进 app.now，
  // 走的正是那个 tick 会触发的同一套 computed。
  const blocked0 = await page.evaluate(() => !!document.querySelector('.blocked'));
  rec('C1 正常态不显示阻断条', blocked0 === false, String(blocked0));

  await page.evaluate(() => {
    const a = document.querySelector('#app')._vnode.component.proxy;
    a.info.expiresAt = Date.now() + 60 * 60 * 1000;
    a.now = Date.now();
  });
  await page.waitForTimeout(80);
  const liveExp = await page.evaluate(() => {
    const v = [...document.querySelectorAll('.meta__row')]
      .find((r) => r.querySelector('.meta__k')?.textContent.trim() === '有效期');
    return {
      text: v?.querySelector('.meta__v')?.textContent.replace(/\s+/g, ' ').trim() || '',
      meter: !!v?.querySelector('.meta__meter .progress__val'),
    };
  });
  rec('C2 有剩余有效期：显示「还剩 …」+ 截止日期',
    /还剩/.test(liveExp.text) && /截止 \d{4}-/.test(liveExp.text), liveExp.text);

  await page.evaluate(() => {
    const a = document.querySelector('#app')._vnode.component.proxy;
    a.now = Date.now() + 2 * 60 * 60 * 1000; // 推过有效期
  });
  await page.waitForTimeout(80);
  const expiredState = await page.evaluate(() => ({
    blocked: document.querySelector('.blocked')?.textContent.trim() || '',
    hasLink: !!document.querySelector('.side__actions a.btn'),
    btnText: document.querySelector('.side__actions button')?.textContent.trim() || '',
    btnDisabled: !!document.querySelector('.side__actions button')?.disabled,
    rowTone: [...document.querySelectorAll('.meta__row')]
      .find((r) => r.querySelector('.meta__k')?.textContent.trim() === '有效期')?.className || '',
  }));
  rec('C3 过期：出现阻断条且写明已过期', /已过期/.test(expiredState.blocked), expiredState.blocked);
  rec('C4 过期：下载链接撤掉，换成 disabled 的「无法下载」',
    expiredState.hasLink === false && /无法下载/.test(expiredState.btnText) && expiredState.btnDisabled === true,
    JSON.stringify(expiredState));
  rec('C5 过期：有效期行转为 danger 色', /meta__row--danger/.test(expiredState.rowTone), expiredState.rowTone);

  // 恢复有效期，再验次数用尽
  await page.evaluate(() => {
    const a = document.querySelector('#app')._vnode.component.proxy;
    a.info.expiresAt = 0;
    a.now = Date.now();
    a.info.maxDownloads = 2;
    a.info.downloadCount = 2;
    a.info.remainingDownloads = 0;
  });
  await page.waitForTimeout(80);
  const quotaState = await page.evaluate(() => ({
    blocked: document.querySelector('.blocked')?.textContent.trim() || '',
    btnText: document.querySelector('.side__actions button')?.textContent.trim() || '',
    btnDisabled: !!document.querySelector('.side__actions button')?.disabled,
    quotaV: [...document.querySelectorAll('.meta__row')]
      .find((r) => r.querySelector('.meta__k')?.textContent.trim() === '下载次数')
      ?.querySelector('.meta__v')?.textContent.replace(/\s+/g, ' ').trim() || '',
    quotaTone: [...document.querySelectorAll('.meta__row')]
      .find((r) => r.querySelector('.meta__k')?.textContent.trim() === '下载次数')?.className || '',
  }));
  rec('C6 次数用尽：阻断条写明次数已用尽', /次数已用尽/.test(quotaState.blocked), quotaState.blocked);
  rec('C7 次数用尽：按钮 disabled', /无法下载/.test(quotaState.btnText) && quotaState.btnDisabled === true,
    JSON.stringify(quotaState));
  rec('C8 次数用尽：配额行显示「已用尽」且转 danger',
    /已用尽/.test(quotaState.quotaV) && /meta__row--danger/.test(quotaState.quotaTone),
    `${quotaState.quotaV} | ${quotaState.quotaTone}`);

  /* ================= D. 合集 ================= */
  await open(`b=${encodeURIComponent(bSlug)}`, { width: 1280, height: 900 });
  const bState = await peekAll(['state', 'isBundle']);
  rec('D1 合集页进入 ready 且 isBundle=true', bState.state === 'ready' && bState.isBundle === true,
    JSON.stringify(bState));

  const bHero = await page.evaluate(() => ({
    name: document.querySelector('.hero__name')?.textContent.trim() || '',
    sub: document.querySelector('.hero__sub')?.textContent.replace(/\s+/g, ' ').trim() || '',
    cls: document.querySelector('.hero')?.className || '',
  }));
  rec('D2 合集 hero 用数量概括标题', /6 个文件/.test(bHero.name), bHero.name);
  rec('D3 合集 hero 副行给出文件数 / 总大小 / 时间',
    /6 个文件/.test(bHero.sub) && /共/.test(bHero.sub) && /(刚刚|分钟前|小时前|天前)/.test(bHero.sub),
    bHero.sub);
  rec('D4 合集走 tone-bundle 配色', /tone-bundle/.test(bHero.cls), bHero.cls);

  if (BREAK_TONE) {
    // 故障注入：模拟「图标忘了挂类型配色」——所有图标回落成同一个颜色。
    await page.evaluate(() => {
      document.querySelectorAll('.bitem__icon').forEach((el) => { el.className = 'bitem__icon'; });
    });
  }

  const items = await page.evaluate(() => {
    return [...document.querySelectorAll('.bitem')].map((li) => {
      const icon = li.querySelector('.bitem__icon');
      const i = icon?.querySelector('i');
      return {
        name: li.querySelector('.bitem__name')?.textContent.trim() || '',
        sub: li.querySelector('.bitem__sub')?.textContent.replace(/\s+/g, ' ').trim() || '',
        tone: icon?.className.replace('bitem__icon', '').trim() || '',
        iconClass: i ? i.className : '',
        color: icon ? getComputedStyle(icon).color : '',
        hasCheck: !!li.querySelector('.check'),
        hasPreview: !!li.querySelector('.bitem__acts button'),
        dlHref: li.querySelector('.bitem__acts a')?.getAttribute('href') || '',
      };
    });
  });
  rec('D5 清单渲染 6 条', items.length === 6, `${items.length}`);
  rec('D6 默认按名称升序', JSON.stringify(items.map((x) => x.name)) === JSON.stringify(BY_NAME),
    JSON.stringify(items.map((x) => x.name)));
  rec('D7 每条都有勾选框 / 预览按钮 / 下载链接',
    items.every((x) => x.hasCheck && x.hasPreview && /dl=1/.test(x.dlHref)),
    JSON.stringify(items.map((x) => [x.hasCheck, x.hasPreview, /dl=1/.test(x.dlHref)])));

  const toneSet = [...new Set(items.map((x) => x.tone))].sort();
  const colorSet = [...new Set(items.map((x) => x.color))];
  rec('D8 图标按类型分色：至少 5 个色调类生效',
    toneSet.length >= 5, JSON.stringify(toneSet));
  rec('D9 图标按类型分色：实际渲染出至少 5 种颜色',
    colorSet.length >= 5, JSON.stringify(colorSet));
  rec('D10 图标是 FontAwesome 且各不相同',
    items.every((x) => /^fas fa-/.test(x.iconClass)) && new Set(items.map((x) => x.iconClass)).size >= 5,
    JSON.stringify(items.map((x) => x.iconClass)));

  const expectLabel = {
    'sp-a-alpha.png': '图片', 'sp-b-beta.mp4': '视频', 'sp-c-gamma.mp3': '音频',
    'sp-d-delta.pdf': 'PDF', 'sp-e-epsilon.zip': '压缩包', 'sp-f-zeta.xlsx': '表格',
  };
  const labelOk = items.every((x) => (x.sub || '').includes(expectLabel[x.name]));
  rec('D11 类型标签按扩展名细分（PDF / 压缩包 / 表格 各自独立）',
    labelOk, JSON.stringify(items.map((x) => [x.name, x.sub])));

  /* ---- 搜索 ---- */
  await page.fill('.search .input', 'beta');
  await page.waitForTimeout(120);
  const searched = await page.evaluate(() => ({
    names: [...document.querySelectorAll('.bitem__name')].map((e) => e.textContent.trim()),
    stat: document.querySelector('.toolbar__stat')?.textContent.replace(/\s+/g, ' ').trim() || '',
  }));
  rec('D12 搜索按文件名过滤', JSON.stringify(searched.names) === JSON.stringify(['sp-b-beta.mp4']),
    JSON.stringify(searched.names));
  rec('D13 工具栏统计跟随筛选结果（显示 1 / 6）', /显示 1 \/ 6/.test(searched.stat), searched.stat);

  await page.fill('.search .input', 'zzz-nothing');
  await page.waitForTimeout(120);
  const emptyState = await page.evaluate(() => ({
    empty: !!document.querySelector('.blist-empty'),
    text: document.querySelector('.blist-empty')?.textContent.replace(/\s+/g, ' ').trim() || '',
    rows: document.querySelectorAll('.bitem').length,
  }));
  rec('D14 搜不到时给空态而不是空白列表',
    emptyState.empty && emptyState.rows === 0 && /zzz-nothing/.test(emptyState.text),
    JSON.stringify(emptyState));

  await page.fill('.search .input', '');
  await page.waitForTimeout(120);

  /* ---- 排序 ---- */
  await page.selectOption('.toolbar select.select', 'size');
  await page.waitForTimeout(120);
  const bySize = await page.evaluate(() =>
    [...document.querySelectorAll('.bitem__name')].map((e) => e.textContent.trim()));
  rec('D15 按大小升序', JSON.stringify(bySize) === JSON.stringify(BY_SIZE_ASC), JSON.stringify(bySize));

  await page.click('.toolbar button[title*="改降序"]').catch(async () => {
    await page.click('.toolbar button.btn--icon');
  });
  await page.waitForTimeout(120);
  const bySizeDesc = await page.evaluate(() => ({
    names: [...document.querySelectorAll('.bitem__name')].map((e) => e.textContent.trim()),
    dir: document.querySelector('#app')._vnode.component.proxy.bundleSortDir,
  }));
  rec('D16 点击方向按钮切降序',
    bySizeDesc.dir === 'desc' && JSON.stringify(bySizeDesc.names) === JSON.stringify([...BY_SIZE_ASC].reverse()),
    JSON.stringify(bySizeDesc));

  await page.selectOption('.toolbar select.select', 'type');
  await page.waitForTimeout(120);
  const byType = await page.evaluate(() => ({
    names: [...document.querySelectorAll('.bitem__name')].map((e) => e.textContent.trim()),
    labels: [...document.querySelectorAll('.bitem__sub')].map((e) =>
      e.textContent.replace(/\s+/g, ' ').trim().split(' ').pop()),
  }));
  // 中文标签在 zh-Hans-CN 下的确切次序依赖 ICU 版本，这里不钉死绝对顺序，
  // 只钉住「同标签聚在一起」和「确实和名称序不同」两件事。
  const contiguous = byType.labels.every((l, i) => i === 0 || byType.labels.indexOf(l) >= byType.labels.lastIndexOf(byType.labels[i - 1]));
  rec('D17 按类型排序：同类型聚在一起', contiguous, JSON.stringify(byType.labels));
  rec('D18 按类型排序：结果确实不同于按名称',
    JSON.stringify(byType.names) !== JSON.stringify(BY_NAME), JSON.stringify(byType.names));

  await page.selectOption('.toolbar select.select', 'name');
  await page.evaluate(() => {
    document.querySelector('#app')._vnode.component.proxy.bundleSortDir = 'asc';
  });
  await page.waitForTimeout(120);

  /* ---- 多选批量下载 ---- */
  const btnBefore = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.side__actions button')][0];
    return { text: b?.textContent.trim() || '', disabled: !!b?.disabled };
  });
  rec('D19 未勾选时「下载所选」按钮 disabled',
    btnBefore.disabled === true && /下载所选/.test(btnBefore.text), JSON.stringify(btnBefore));

  await page.evaluate(() => {
    [...document.querySelectorAll('.bitem')].slice(0, 2).forEach((li) => li.querySelector('.check').click());
  });
  await page.waitForTimeout(120);
  const btnAfter = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.side__actions button')][0];
    return {
      text: b?.textContent.trim() || '', disabled: !!b?.disabled,
      picked: document.querySelector('#app')._vnode.component.proxy.pickedCount,
      stat: document.querySelector('.toolbar__stat')?.textContent.replace(/\s+/g, ' ').trim() || '',
    };
  });
  rec('D20 勾选 2 个后按钮可点且带计数',
    btnAfter.picked === 2 && btnAfter.disabled === false && /下载所选（2）/.test(btnAfter.text),
    JSON.stringify(btnAfter));
  rec('D21 工具栏统计显示已选数', /已选 2/.test(btnAfter.stat), btnAfter.stat);

  /* 侧栏的「已选 N 个 · 共 X」—— X 必须是真的总量，不能回落到「未知大小」。
     这条是补出来的：pickedTotalSize 一开始漏了定义，页面显示「共 未知大小」，
     但其它断言全绿，差点漏过去。 */
  const pickedFlow = await page.evaluate(() => {
    const a = document.querySelector('#app')._vnode.component.proxy;
    return {
      size: a.pickedTotalSize,
      hints: [...document.querySelectorAll('.side__hint')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()),
    };
  });
  // 前两条被勾的是 alpha.png(100000) + beta.mp4(900000) = 1000000
  rec('D21b 侧栏「已选」行给出真实合计体积（不是未知大小）',
    pickedFlow.size === 1000000 && pickedFlow.hints.some((h) => /已选 2 个 · 共 976\.56 KB/.test(h)),
    JSON.stringify(pickedFlow));
  rec('D21c 侧栏说明文案不出现「未知大小」',
    pickedFlow.hints.every((h) => !/未知大小/.test(h)), JSON.stringify(pickedFlow.hints));

  // 批量下载：钩住 <a download>.click()，只记录不真的导航
  await page.evaluate(() => {
    window.__dl = [];
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) window.__dl.push({ href: this.href, name: this.download, t: Date.now() });
    };
  });
  await page.evaluate(() => { document.querySelector('#app')._vnode.component.proxy.downloadPicked(); });
  await page.waitForTimeout(1400);
  const dl = await page.evaluate(() => window.__dl || []);
  const gaps = dl.slice(1).map((x, i) => x.t - dl[i].t);
  rec('D22 批量下载依次触发 2 个文件', dl.length === 2, JSON.stringify(dl.map((x) => x.name)));
  rec('D23 批量下载带 ≥400ms 间隔（不被浏览器合并/拦截）',
    gaps.length === 1 && gaps[0] >= 400, JSON.stringify(gaps));
  rec('D24 批量下载的地址都带 dl=1',
    dl.length === 2 && dl.every((x) => /dl=1/.test(x.href)), JSON.stringify(dl.map((x) => x.href)));

  /* ---- 全选只对筛选结果生效 ---- */
  if (BREAK_ALLPICK) {
    // 故障注入：模拟「全选忘了限制在当前筛选结果内」。
    // 注意：Vue 的 options methods 在 applyOptions 里被 `bind(publicThis)` 过，
    // 模板里的 `@click="methodName"` 又是裸调用（不经过 proxy），所以直接
    // 赋值一个普通函数进去，`this` 会落到 window 上而不是组件实例。
    // 注入必须闭包捕获实例，不能依赖 this。
    await page.evaluate(() => {
      const a = document.querySelector('#app')._vnode.component.proxy;
      a.toggleSelectAllFiltered = function () {
        const t = !a.allFilteredPicked;
        a.bundleFiles.forEach((f) => { f.selected = t; });
      };
    });
  }
  // 先把前面勾的清掉：这条要验的是「全选的作用域」，
  // 留着旧勾选会让 pickedCount 变成 旧勾选 + 筛选结果，断言就测不到点子上了。
  await page.evaluate(() => {
    document.querySelector('#app')._vnode.component.proxy.bundleFiles.forEach((f) => { f.selected = false; });
  });
  await page.fill('.search .input', 'gamma');
  await page.waitForTimeout(120);
  await page.click('.pickline');
  await page.waitForTimeout(120);
  const pickFiltered = await page.evaluate(() => ({
    picked: document.querySelector('#app')._vnode.component.proxy.pickedCount,
    shown: document.querySelectorAll('.bitem').length,
  }));
  rec('D25 搜索后「全选」只勾当前筛选结果（1 个，不是 6 个）',
    pickFiltered.picked === 1 && pickFiltered.shown === 1, JSON.stringify(pickFiltered));

  await page.fill('.search .input', '');
  await page.waitForTimeout(120);
  await page.click('.pickline');
  await page.waitForTimeout(120);
  const pickAll = await page.evaluate(() =>
    document.querySelector('#app')._vnode.component.proxy.pickedCount);
  rec('D26 清空搜索后「全选」勾满 6 个', pickAll === 6, String(pickAll));

  /* ================= E. 静默刷新保留勾选 ================= */
  await page.evaluate(() => {
    const a = document.querySelector('#app')._vnode.component.proxy;
    a.bundleFiles.forEach((f, i) => { f.selected = i < 2; });
  });
  await page.waitForTimeout(80);
  await page.evaluate(() => {
    document.querySelector('#app')._vnode.component.proxy.loadInfo({ silent: true });
  });
  await page.waitForTimeout(900);
  const kept = await page.evaluate(() => {
    const a = document.querySelector('#app')._vnode.component.proxy;
    return { picked: a.pickedCount, total: a.bundleFiles.length, state: a.state };
  });
  rec('E1 静默刷新后勾选状态保留',
    kept.picked === 2 && kept.total === 6 && kept.state === 'ready', JSON.stringify(kept));

  /* ================= F. 密码门 / 失效态 ================= */
  if (pwSlug) {
    await open(`b=${encodeURIComponent(pwSlug)}`, { width: 1280, height: 900 });
    const pwState = await page.evaluate(() => ({
      state: document.querySelector('#app')._vnode.component.proxy.state,
      gate: !!document.querySelector('.password-gate'),
      rows: document.querySelectorAll('.bitem').length,
    }));
    rec('F1 带密码合集：先落到密码门',
      pwState.state === 'password' && pwState.gate && pwState.rows === 0, JSON.stringify(pwState));

    await page.fill('.password-gate input', 'wrong-one');
    await page.click('.password-gate button[type="submit"]');
    await page.waitForTimeout(900);
    const wrongPw = await page.evaluate(() => ({
      state: document.querySelector('#app')._vnode.component.proxy.state,
      err: document.querySelector('.password-gate-error')?.textContent.trim() || '',
    }));
    rec('F2 密码错误：留在密码门并给出提示',
      wrongPw.state === 'password' && /不正确/.test(wrongPw.err), JSON.stringify(wrongPw));

    await page.fill('.password-gate input', 'sp-secret');
    await page.click('.password-gate button[type="submit"]');
    await page.waitForTimeout(1200);
    const rightPw = await page.evaluate(() => ({
      state: document.querySelector('#app')._vnode.component.proxy.state,
      rows: document.querySelectorAll('.bitem').length,
      pwRow: [...document.querySelectorAll('.meta__row')]
        .find((r) => r.querySelector('.meta__k')?.textContent.trim() === '访问密码')
        ?.querySelector('.meta__v')?.textContent.replace(/\s+/g, ' ').trim() || '',
    }));
    rec('F3 密码正确：进入详情且列出 3 个成员',
      rightPw.state === 'ready' && rightPw.rows === 3, JSON.stringify(rightPw));
    rec('F4 元信息标明该分享需要密码', /需要密码/.test(rightPw.pwRow), rightPw.pwRow);
  } else {
    rec('F1 带密码合集：先落到密码门', false, '未拿到带密码合集的 slug');
  }

  await open(`s=${encodeURIComponent('no-such-share-' + Date.now().toString(36))}`, { width: 1280, height: 900 });
  const missing = await page.evaluate(() => ({
    state: document.querySelector('#app')._vnode.component.proxy.state,
    title: document.querySelector('.state-title')?.textContent.trim() || '',
    retry: !!document.querySelector('.state-box .btn'),
  }));
  rec('F5 不存在的分享：落到失效态且给重试按钮',
    missing.state === 'error' && missing.title.length > 0 && missing.retry, JSON.stringify(missing));

  await page.goto(`${BASE}/share.html`, { waitUntil: 'load', timeout: 20000 });
  await settled();
  const noParam = await page.evaluate(() => ({
    state: document.querySelector('#app')._vnode.component.proxy.state,
    title: document.querySelector('.state-title')?.textContent.trim() || '',
  }));
  rec('F6 缺少分享参数：明确提示而不是空白页',
    noParam.state === 'error' && /链接不完整/.test(noParam.title), JSON.stringify(noParam));

  rec('F7 全程无 JS 报错', jsErrors.length === 0, jsErrors.join(' | '));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log('-'.repeat(58));
if (!failed.length) {
  console.log(`全部通过（${results.length} 项）`);
  process.exit(0);
} else {
  console.log(`异常 ${failed.length} 项 / 共 ${results.length} 项`);
  failed.forEach((f) => console.log(`  - ${f.name}: ${f.detail}`));
  process.exit(1);
}
