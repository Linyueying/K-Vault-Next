// 端到端验证：合集分享（bundle share）全链路
//
// 覆盖「一个链接带多个文件」从创建到访问的每一道门：
//   创建 → 分享信息 → /s/:slug 跳转 → 无密码访问 → 密码 401 → 次数用尽 410
//        → 过期 410 → revoke 后 404 → 列表接口 → 旧的文件级分享无回归
//
// 为什么必须跑在 wrangler pages dev 上：
//   合集的密码/次数/过期校验全部在 Functions 侧，静态服务器 + mock 接口
//   测不出任何真实语义。
//
// 为什么用页面里的 fetch 而不是 context.request：
//   会话 cookie 带 Secure; SameSite=Strict，在 http://127.0.0.1 上
//   Chromium 的网络栈不会持久化它，但页面内的 document.cookie / fetch
//   走的是「非安全上下文豁免」路径，能正常带上。所以统一在页面里发请求。
//
// 用法：
//   1) 起本地全栈（见 AI-OPERATIONS.md §0）：
//        npx wrangler pages dev ./ \
//          --kv "img_url" --r2=R2_BUCKET \
//          --compatibility-date=2026-05-03 \
//          --port 8099 --persist-to /tmp/kvdata \
//          --binding BASIC_USER=admin --binding BASIC_PASS=123
//   2) node scripts/verify/share-bundle.mjs
//
// 依赖：playwright-core（解析逻辑见 _playwright.mjs）+ node:sqlite（预置数据）
import { loadPlaywright, findChrome } from './_playwright.mjs';
import { ensureSeedFiles } from './_seed-kv.mjs';

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const USER = process.env.BASIC_USER || 'admin';
const PASS = process.env.BASIC_PASS || '123';

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

const seedNames = ['verify-bundle-a.txt', 'verify-bundle-b.txt', 'verify-bundle-c.txt'];

let page;
/**
 * 在页面上下文里发请求，返回真实状态码 + 解析后的 body。
 * redirect:'manual' 是为了观察 /s/:slug 的 302 目标。
 */
const call = (path, { method = 'GET', body, headers = {}, manual = false } = {}) =>
  page.evaluate(
    async ({ path, method, body, headers, manual, base }) => {
      const res = await fetch(base + path, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: manual ? 'manual' : 'follow',
        cache: 'no-store',
      });
      const text = await res.text().catch(() => '');
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { parsed = text; }
      return { status: res.status, location: res.headers.get('location'), body: parsed };
    },
    { path, method, body, headers, manual, base: BASE }
  );

try {
  const ctx = await browser.newContext();
  page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(String(e.message).split('\n')[0]));

  await page.goto(`${BASE}/login.html`, { waitUntil: 'load', timeout: 20000 });

  /* ---------------- 0. 登录 ---------------- */
  const login = await call('/api/auth/login', { method: 'POST', body: { username: USER, password: PASS } });
  rec('管理员登录', login.status === 200 && login.body?.success === true,
    `HTTP ${login.status} ${JSON.stringify(login.body).slice(0, 120)}`);
  if (login.status !== 200) throw new Error('登录失败，后续用例无意义');

  const whoami = await call('/api/manage/list?limit=1');
  rec('会话已生效（管理接口可读）', whoami.status === 200, `HTTP ${whoami.status} ${JSON.stringify(whoami.body).slice(0, 120)}`);

  /* ---------------- 1. 预置文件 ---------------- */
  // 本地 wrangler 没有 telegram 出口，upload-from-url 又被 SSRF 挡回环地址，
  // 所以直接按真实上传的 metadata 形状写 KV。
  const seeded = await ensureSeedFiles(seedNames);
  rec('预置 3 个文件到 KV', seeded.ok === true, seeded.reason || '');
  if (!seeded.ok) throw new Error('预置文件失败：' + (seeded.reason || ''));

  const list = await call('/api/manage/list?limit=50');
  const listed = (list.body?.keys || []).map((k) => k.name);
  rec('列表接口能读到预置文件', seedNames.every((n) => listed.includes(n)), JSON.stringify(listed));

  /* ---------------- 2. 非法入参 ---------------- */
  // 注意："至少 2 个文件" 是 UI 层的产品约束（frontend 会劝阻），
  // API 层允许单文件合集是刻意的：它把「链接带不带文件」和「列表带几个文件」
  // 解耦，未来做批量短链不必回头改后端契约。这里只钉住「空集合」必须被拒。
  const noFiles = await call('/api/manage/share-bundle', {
    method: 'POST', body: { action: 'create', fileIds: [] },
  });
  rec('空文件列表：拒绝创建',
    noFiles.status === 400 && noFiles.body?.success === false,
    `HTTP ${noFiles.status} ${JSON.stringify(noFiles.body).slice(0, 140)}`);

  const bogus = await call('/api/manage/share-bundle', {
    method: 'POST',
    body: { action: 'create', fileIds: seedNames.slice(0, 2), expiresIn: 'abc', maxDownloads: 'xyz' },
  });
  rec('非法有效期/次数：拒绝创建（不静默忽略）',
    bogus.status === 400,
    `HTTP ${bogus.status} ${JSON.stringify(bogus.body).slice(0, 140)}`);

  const noAuth = await call('/api/manage/share-bundle', {
    method: 'POST', body: { action: 'create', fileIds: seedNames },
  });
  rec('合法前提下的建合集请求确实通过鉴权', noAuth.status !== 401, `HTTP ${noAuth.status}`);

  /* ---------------- 3. 正常创建 ---------------- */
  const created = await call('/api/manage/share-bundle', {
    method: 'POST', body: { action: 'create', fileIds: seedNames },
  });
  const slug = created.body?.slug;
  rec('创建合集成功', created.status === 200 && created.body?.success === true,
    `HTTP ${created.status} ${JSON.stringify(created.body).slice(0, 160)}`);
  rec('返回 3 个文件全部收录', created.body?.fileCount === 3, `fileCount=${created.body?.fileCount}`);
  rec('无失效文件', Array.isArray(created.body?.missing) && created.body.missing.length === 0,
    JSON.stringify(created.body?.missing));
  rec('分享路径为 /s/<slug>', /^\/s\/[A-Za-z0-9_-]+$/.test(String(created.body?.sharePath || '')),
    String(created.body?.sharePath));
  if (!slug) throw new Error('没有拿到 slug，后续用例无法继续');

  /* ---------------- 4. 分享信息 ---------------- */
  const info = await call(`/api/share-info?b=${encodeURIComponent(slug)}`);
  rec('合集分享信息可读', info.status === 200 && info.body?.success === true,
    `HTTP ${info.status} ${JSON.stringify(info.body).slice(0, 160)}`);
  rec('标记为合集', info.body?.bundle === true, `bundle=${info.body?.bundle}`);
  rec('返回 3 个成员', Array.isArray(info.body?.files) && info.body.files.length === 3,
    `files=${info.body?.files?.length}`);
  const memberNames = (info.body?.files || []).map((f) => f.fileName).sort();
  rec('成员文件名正确', JSON.stringify(memberNames) === JSON.stringify([...seedNames].sort()),
    JSON.stringify(memberNames));
  rec('未设密码', info.body?.passwordProtected === false, `passwordProtected=${info.body?.passwordProtected}`);
  rec('不返回任何密码摘要字段',
    info.body?.passwordHash === undefined && info.body?.passwordSalt === undefined,
    JSON.stringify(Object.keys(info.body || {}).filter((k) => /password/i.test(k))));

  const singleInfo = await call('/api/share-info?s=' + encodeURIComponent(slug));
  rec('单文件路径查合集 slug：明确失败而非 500',
    singleInfo.status === 404 || singleInfo.status === 400,
    `HTTP ${singleInfo.status} ${JSON.stringify(singleInfo.body).slice(0, 120)}`);

  /* ---------------- 5. /s/:slug 跳转 ---------------- */
  // fetch(redirect:'manual') 拿到的是 opaque-redirect，读不到 location。
  // 所以用 document 导航观察真实跳转目标 —— 这也更接近用户实际点击的路径。
  // Pages 会把 /share.html 规范化成无扩展名的 /share，所以两种形态都要认。
  const jump = await page.goto(`${BASE}/s/${encodeURIComponent(slug)}`, { waitUntil: 'load' });
  const landed = page.url();
  rec('/s/<slug> 落到分享页且带 b= 参数',
    /\/share(\.html)?\?b=/.test(landed) && /^2/.test(String(jump?.status() || '2')),
    `status=${jump?.status()} url=${landed}`);

  /* ---------------- 6. 密码门 ---------------- */
  const setPw = await call('/api/manage/share-bundle', {
    method: 'POST',
    body: { action: 'update', slug, fileIds: seedNames, password: 'vfy-123456' },
  });
  rec('为合集设置密码', setPw.status === 200 && setPw.body?.success === true,
    `HTTP ${setPw.status} ${JSON.stringify(setPw.body).slice(0, 160)}`);

  const locked = await call(`/api/share-info?b=${encodeURIComponent(slug)}`);
  // 401 = 尚未提供密码；403 = 提供了但不对。两者都不许泄漏成员地址。
  rec('未带密码：401 且不泄漏成员地址',
    locked.status === 401 && !locked.body?.files?.length,
    `HTTP ${locked.status} files=${JSON.stringify(locked.body?.files)}`);
  rec('未带密码：声明需要密码',
    locked.body?.passwordRequired === true || locked.body?.passwordProtected === true,
    JSON.stringify(locked.body).slice(0, 160));

  const wrong = await call(`/api/share-info?b=${encodeURIComponent(slug)}`, {
    headers: { 'X-Share-Password': 'totally-wrong' },
  });
  rec('密码错误：403 且不泄漏成员地址',
    wrong.status === 403 && !wrong.body?.files?.length,
    `HTTP ${wrong.status} ${JSON.stringify(wrong.body).slice(0, 140)}`);

  const right = await call(`/api/share-info?b=${encodeURIComponent(slug)}`, {
    headers: { 'X-Share-Password': 'vfy-123456' },
  });
  rec('密码正确：放行且返回成员',
    right.status === 200 && (right.body?.files || []).length === 3,
    `HTTP ${right.status} files=${right.body?.files?.length}`);

  /* ---------------- 7. 计次与次数上限 ---------------- */
  const clearPw = await call('/api/manage/share-bundle', {
    method: 'POST', body: { action: 'update', slug, fileIds: seedNames, password: '' },
  });
  rec('清空密码', clearPw.status === 200 && clearPw.body?.success === true, `HTTP ${clearPw.status}`);

  const limited = await call('/api/manage/share-bundle', {
    method: 'POST', body: { action: 'create', fileIds: seedNames.slice(0, 2), maxDownloads: 1 },
  });
  const lslug = limited.body?.slug;
  rec('创建限次合集（上限 1）', limited.status === 200 && !!lslug,
    JSON.stringify(limited.body).slice(0, 160));

  const lInfo = await call(`/api/share-info?b=${encodeURIComponent(lslug)}`);
  rec('限次合集：初始剩余次数正确',
    lInfo.body?.remainingDownloads === 1 && lInfo.body?.downloadCount === 0,
    `remaining=${lInfo.body?.remainingDownloads} count=${lInfo.body?.downloadCount}`);

  // 本地没有 telegram 出口，文件字节取不回来（/file 会 500）。
  // 所以这里不验「下得下来」，只验计次与配额这道闸门本身：
  // 配额的判定发生在取字节之前，不受上游不可达影响。
  const dl = await call(`/file/${encodeURIComponent(seedNames[0])}?dl=1&b=${encodeURIComponent(lslug)}`);
  const upstreamDown = dl.status === 500 && /telegram/i.test(String(dl.body?.message || dl.body?.error || dl.body || ''));
  rec('首次下载未被配额拦截', dl.status !== 410 && dl.status !== 403,
    `HTTP ${dl.status}${upstreamDown ? '（上游 telegram 不可达，属预期）' : ''}`);

  const after = await call(`/api/share-info?b=${encodeURIComponent(lslug)}`);
  rec('下载动作后计次 +1', after.body?.downloadCount === 1,
    `count=${after.body?.downloadCount} remaining=${after.body?.remainingDownloads}`);

  const dl2 = await call(`/file/${encodeURIComponent(seedNames[1])}?dl=1&b=${encodeURIComponent(lslug)}`);
  rec('超次数：配额闸门拦截（410）', dl2.status === 410,
    `HTTP ${dl2.status} ${JSON.stringify(dl2.body).slice(0, 140)}`);

  /* ---------------- 8. 过期 ---------------- */
  const expired = await call('/api/manage/share-bundle', {
    method: 'POST', body: { action: 'create', fileIds: seedNames.slice(0, 2), expiresIn: 1 },
  });
  const eslug = expired.body?.slug;
  if (eslug) {
    await page.waitForTimeout(1500);
    const eInfo = await call(`/api/share-info?b=${encodeURIComponent(eslug)}`);
    rec('过期合集：410', eInfo.status === 410, `HTTP ${eInfo.status} ${JSON.stringify(eInfo.body).slice(0, 140)}`);
  } else {
    rec('过期合集：410', false, '未能创建 1 秒有效期的合集');
  }

  /* ---------------- 9. revoke ---------------- */
  const revoked = await call('/api/manage/share-bundle', {
    method: 'POST', body: { action: 'revoke', slug },
  });
  rec('撤销合集', revoked.status === 200 && revoked.body?.success === true,
    `HTTP ${revoked.status} ${JSON.stringify(revoked.body).slice(0, 160)}`);

  const gone = await call(`/api/share-info?b=${encodeURIComponent(slug)}`);
  rec('撤销后：分享信息 404', gone.status === 404, `HTTP ${gone.status} ${JSON.stringify(gone.body).slice(0, 120)}`);

  const jumpGone = await page.goto(`${BASE}/s/${encodeURIComponent(slug)}`, { waitUntil: 'load' });
  rec('撤销后：/s/<slug> 不再跳转到分享页',
    !/\/share(\.html)?\?b=/.test(page.url()),
    `status=${jumpGone?.status()} url=${page.url()}`);

  /* ---------------- 10. 列表接口 ---------------- */
  const bundles = await call('/api/manage/share-bundles');
  rec('合集列表接口可用', bundles.status === 200 && bundles.body?.success === true,
    `HTTP ${bundles.status} ${JSON.stringify(bundles.body).slice(0, 160)}`);
  rec('列表含统计字段', !!bundles.body?.stats, JSON.stringify(bundles.body?.stats));
  const slugs = (bundles.body?.bundles || []).map((x) => x.slug);
  rec('撤销后：不再出现在合集列表', !slugs.includes(slug), JSON.stringify(slugs));

  /* ---------------- 11. 旧的文件级分享无回归 ---------------- */
  // 文件级分享是「给某个 key 打分享属性」，端点在 /api/manage/share/<id>。
  // 单文件分享的短链由前端生成后随请求体带过来（`body.slug`），
  // 不像合集那样由服务端分配 —— 所以这里也要显式给一个。
  const fileId = created.body?.fileIds?.[0] || seedNames[0];
  const fileSlug = 'vfyfile' + Date.now().toString(36).slice(-4);
  const fileShare = await call(`/api/manage/share/${encodeURIComponent(fileId)}`, {
    method: 'POST', body: { action: 'create', expiresIn: 0, slug: fileSlug },
  });
  rec('文件级分享仍可创建',
    fileShare.status === 200 && fileShare.body?.success !== false,
    `HTTP ${fileShare.status} ${JSON.stringify(fileShare.body).slice(0, 160)}`);
  const fsSlug = fileShare.body?.slug || fileShare.body?.shareSlug || fileShare.body?.share?.slug;
  if (fsSlug) {
    const fsInfo = await call(`/api/share-info?s=${encodeURIComponent(fsSlug)}`);
    rec('文件级分享信息仍可读', fsInfo.status === 200 && fsInfo.body?.success === true, `HTTP ${fsInfo.status}`);
    rec('文件级分享未被标成合集', fsInfo.body?.bundle !== true, `bundle=${fsInfo.body?.bundle}`);
  } else {
    rec('文件级分享信息仍可读', false, '未拿到文件级 slug');
  }

  /* ---------------- 12. 分享目录（folderPath 来源） ---------------- */
  // 与「多选文件」平行的另一条合集来源：直接传 folderPath，由服务端按目录解析成员。
  // 见 functions/api/manage/share-bundle.js 的 handleWrite 分支 (c)。
  const dirSeeds = ['verify-dir-a.txt', 'verify-dir-b.txt'];
  const dirSeeded = await ensureSeedFiles(dirSeeds, { folder: 'verify-share-dir' });
  rec('预置 2 个目录文件到 KV', dirSeeded.ok === true, dirSeeded.reason || '');
  if (!dirSeeded.ok) throw new Error('预置目录文件失败：' + (dirSeeded.reason || ''));

  const dirCreated = await call('/api/manage/share-bundle', {
    method: 'POST', body: { action: 'create', folderPath: 'verify-share-dir' },
  });
  const dslug = dirCreated.body?.slug;
  rec('按目录创建合集成功', dirCreated.status === 200 && dirCreated.body?.success === true,
    `HTTP ${dirCreated.status} ${JSON.stringify(dirCreated.body).slice(0, 160)}`);
  rec('目录合集收录 2 个文件', dirCreated.body?.fileCount === 2, `fileCount=${dirCreated.body?.fileCount}`);

  if (dslug) {
    const dInfo = await call(`/api/share-info?b=${encodeURIComponent(dslug)}`);
    rec('目录合集分享信息可读且标记为合集', dInfo.status === 200 && dInfo.body?.bundle === true,
      `HTTP ${dInfo.status} ${JSON.stringify(dInfo.body).slice(0, 120)}`);
    rec('目录合集返回 2 个成员', Array.isArray(dInfo.body?.files) && dInfo.body.files.length === 2,
      `files=${dInfo.body?.files?.length}`);
    const dNames = (dInfo.body?.files || []).map((f) => f.fileName).sort();
    rec('目录成员文件名正确', JSON.stringify(dNames) === JSON.stringify([...dirSeeds].sort()),
      JSON.stringify(dNames));
  } else {
    rec('目录成员文件名正确', false, '未拿到目录合集 slug');
  }

  const dirEmpty = await call('/api/manage/share-bundle', {
    method: 'POST', body: { action: 'create', folderPath: 'verify-nonexistent-dir' },
  });
  rec('空目录/不存在目录：明确拒绝（400）',
    dirEmpty.status === 400 && dirEmpty.body?.success === false,
    `HTTP ${dirEmpty.status} ${JSON.stringify(dirEmpty.body).slice(0, 120)}`);

  rec('无 JS 报错', jsErrors.length === 0, jsErrors.join(' | '));
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
