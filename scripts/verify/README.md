# scripts/verify/ —— 浏览器验证脚本

`scripts/check_*.py` 那四道守卫是**静态**检查（读源码）。这里的是**运行时**检查：
真的开浏览器、真的渲染、真的读计算样式。静态检查查不出的东西（选择器是否真死、
重构有没有改变渲染结果）由它们兜底。

## 为什么这些脚本值得留在仓库里

历史上它们是写在 `/tmp` 里的一次性脚本，任务做完就没了。结果是每次做同类改造
（清理死 CSS、统一组件）都要从零再写一遍——而且**这次就因此漏掉了一次误删**。

## 前置：起服务 + 装依赖

```bash
# 1) 静态服务（仓库根目录）
python3 -m http.server 8788 --bind 127.0.0.1 &

# 2) playwright-core（任选其一）
npm i -D playwright-core          # 装进本仓库
npm i -g playwright-core          # 或装成全局
# 找不到时脚本会打印所有试过的路径，可用 PW_CORE=/path/to/playwright-core 指定

# 3) Chromium（一般已有；没有的话）
npx playwright install chromium
# 或用 CHROME_PATH=/path/to/chrome 指定
```

端口不是 8788 时：`BASE=http://127.0.0.1:8099 node scripts/verify/xxx.mjs`

## 活跃脚本（直接用这些）

> `scripts/verify/_archive/` 是历史归档，**不要直接运行**（详见该目录
> `_HEADER_NOTE.txt`）。下面是当前在用的脚本。

### `smoke.mjs` —— 8 页冒烟测试（改完前端必跑）

```bash
node scripts/verify/smoke.mjs
```

每页在桌面(1440×900)/移动(390×844)两种视口下检查：

- **JS 报错**（`pageerror`）必须为 0
- **死选择器节点**必须为 0（`DEAD_SELECTORS` 里那批已确认全站不存在的类）
- **主题切换**可用（能改 `data-theme`）

退出码 0 = 全过。

### `folder-ops.mjs` —— 目录新建/删除：乐观更新与「耗时与网络延迟解耦」回归

```bash
# 前置：wrangler pages dev 跑在 8099（脚本自己用请求建前置目录）
BASE=http://localhost:8099 node scripts/verify/folder-ops.mjs

# 加强版：叠加 800ms/请求的网络延迟，证明界面耗时**不随延迟增长**
BASE=http://localhost:8099 SIM_LATENCY=1 LAT_MS=800 node scripts/verify/folder-ops.mjs
```

覆盖 **admin.html 与 index.html 两个页面** × 新建/删除/失败回滚，共 24 项
（基础 12 项 + 延迟对照 12 项）。断言：目录树节点出现/消失耗时在阈值内、
后端确实落库、失败能回滚、无 JS 报错。

> **这个脚本的由来**：目录增删都要走 `/api/manage/folders`，两边页面各有一套
> 实现（这正是 `check_shared.py` 要防的漂移）。早期都有同一个毛病：
> **本地状态变更写在 `await fetch` 之后** —— 等于没有乐观更新，UI 全程等后端。
> index 甚至会显示「创建中」转圈。
>
> 实测（人为网络延迟）证明了这个 bug 的真实性：
>
> | 操作 | 无限速 | 限速 300ms |
> | :--- | ---: | ---: |
> | index 新建目录 | 26ms | **335ms** |
> | admin 新建目录 | 79ms | **646ms** |
>
> 耗时 ≈ `网络延迟 × 请求数 + 30ms`，说明 UI 完全卡在等后端往返。修复后
> （乐观更新提前到 `await` 之前 + 失败回滚），**耗时恒为 1-4ms，与延迟无关**。
>
> 移除目录的语义是「把目录内文件移回根目录」（文件不删、直链不失效），
> 后端需逐个改写目录内所有文件的 metadata，故 `functions/api/manage/folders.js`
> 的串行 `for...await` 也一并改为 `Promise.allSettled` 分批并发（16/批）——
> 同样 300 文件在 30ms/次往返的模型下 9042ms → 573ms（**15.8×**）。
>
> ⚠️ **本地验证的局限**：本地 KV 是 SQLite 同步写，"并发 vs 串行"几乎没有差异。
> **不要用本地 DELETE 耗时去证明并发优化有效**；并发收益要看微基准或线上。

### `sync-status.mjs` —— 同步状态点：三态 + 失败自动重试 + KV 证据验证 + 点击说明

```bash
# 前置：wrangler pages dev 跑在 8099
BASE=http://localhost:8099 node scripts/verify/sync-status.mjs
```

覆盖 **admin.html 与 index.html 两个页面**，共 39 项。验证目录管理区的同步状态圆点
（admin 在目录面板头部按钮组、index 在上传抽屉的目录栏；**无同步动作时圆点隐藏**）。

语义（v3，KV 证据验证）：**绿点 = 已从云端 KV 亲眼读到你的变更（确切证据），不是「请求成功」**。
- 只有【写操作】驱动状态点；读操作（目录/文件列表刷新）不驱动 ——
  否则写完成后的静默校正会再黄再绿一次，稀释「我的操作已同步」的语义，
  甚至给过期数据"背书"（回刷的旧数据 + 绿点 = 用户误以为同步成功）。
- 写请求成功（`settle: 'evidence'`）只保持黄点；绿点由
  `KVault.createSyncVerifier()`（app-core.js，唯一实现）点亮：写成功后周期性
  `fresh=1` 读回目录列表，直到「确凿证据」到手——新建的路径真的出现、
  删除的路径真的消失、重命名的新旧路径同时满足。没有证据，黄点一直亮。
- 证据到手的那一轮读回数据就是云端真实状态，直接应用到界面（所见即所存）；
  验证读失败（网络抖动）不是写失败——不转红，静默继续验证。
- 高频验证持续 90s（覆盖 KV 最长约 60s 的最终一致窗口）后转 12s 低频轮询，
  黄点仍常亮，不放弃确认；一旦证据到手立即变绿。
- 防回退登记（rememberFolderOp）窗口与验证期对齐（95s）：验证期间普通刷新
  拿到的旧数据同样被丢弃，乐观界面不被冲掉。

- **黄点**（`.is-syncing`）：目录写入进行中可被捕获；写成功后（验证期）持续亮着
- **绿点**（`.is-synced`）：拿到确切 KV 证据后到达（成功链路 + B2 传播延迟链路）
- **红点**（`.is-failed`）+ **自动重试**：把 POST/PUT/DELETE 拦成 500 后，
  必须观察到**恰好 3 次写请求**（1 次原始 + 2 次重试，退避 600/1500ms），
  红点约 2.1s 后亮起且**常驻不自动消失**，并弹出「同步失败」toast
- **点击圆点**弹出说明弹窗，文案含「网络往返」等延迟不可避免的核心解释

> **实现分层**（防止两页漂移）：`.sync-dot` 四态样式与三条关键帧只在
> `design-system.css`；状态机 / 重试 / 说明文案只在 `app-core.js` 的
> `KVault.createSyncTracker()`；证据判定只在 `KVault.createSyncVerifier()`；
> 两页只把网络动作包进 `track()`、登记 `queueVerify(expected)` 并绑定 class。
>
> **一个值得记住的坑**：HTTP 500 不会让 `fetch` reject。若「成功判定」写在
> 被 `track()` 包装的函数**外面**（如 `const r = await track(() => fetch(...).then(r=>r.json())); if (!r.success) throw`），
> tracker 视角全是成功 —— 不重试、不亮红点。成功判定必须在追踪函数**内部**抛错。
>
> **另一个坑（v3 踩过）**：tracker 新增的低层方法（holdPending/confirmSynced）
> 若只定义、**忘了在 return 对象里导出**，verifier 一调用就抛 TypeError，
> 写操作的 catch 会把乐观状态回滚 —— 表面上「乐观更新失效」，实际是导出遗漏。
> node 冒烟（`window.KVault.createSyncTracker` 全链路）可在改共享层后先跑一把。
>
> 另外 `k_vault_session` cookie 带 `Secure` 属性：浏览器对 localhost 有豁免，
> 但 playwright 的 APIRequestContext 在 http:// 下不会自动携带 —— 服务端校验
> 类请求要显式带登录拿到的 Cookie 头（folder-ops.mjs 的 `AUTH` 即此用法）。
> 本脚本用 `SIM_LATENCY` 证明的是「前端乐观更新」，这一点本地完全可测；
> B2 用例的「KV 传播延迟」是 route 层模拟（`staleFreshMs`：写后 N ms 内
> fresh 读一律返回写前旧快照），本地 SQLite KV 本身写后立即可见，模拟是必要的。

### `guest-banner-login.mjs` —— 访客横幅「登录账户」跳转回归

```bash
node scripts/verify/guest-banner-login.mjs
```

把首页 Vue 实例的访客状态强开（黄色横幅渲染出来），点击右侧「登录账户」，
断言最终 URL 落到 `/login.html` 且带 `redirect` 回跳参数。

> **这个脚本的由来**：该链接曾误绑 `openDrawer('menu')` —— 点了打开「系统导航」
> 抽屉，而不是跳登录页（用户报的「点到系统导航界面」就是这个）。
>
> 注入方式：Vue 3 生产构建下 `app._instance` 为 `null`，根实例要从容器 vnode 取：
> `document.getElementById('app').__vue_app__._container._vnode.component.proxy`。
> 后续要构造其它登录态/访客态前置条件时，照这个路径取 proxy。

### `share-bundle.mjs` —— 合集分享全链路（必须跑在全栈上）

```bash
# 先按 AI-OPERATIONS.md §0 起本地全栈（--kv img_url --port 8099 --persist-to /tmp/kvdata）
node scripts/verify/share-bundle.mjs
```

覆盖「一个链接带多个文件」从建到废的每一道门（41 项断言）：

| 环节 | 断言要点 |
| --- | --- |
| 创建 | 空列表拒绝；非法有效期/次数拒绝（**不能静默忽略**）；正常创建返回 3 成员 |
| 分享信息 | `bundle:true`；成员文件名正确；不返回 `passwordHash/Salt` |
| 短链 | `/s/<slug>` 落到分享页且带 `b=?` |
| 密码 | 未带密码 **401**；密码错误 **403**；两者都不许泄漏成员地址；正确放行 |
| 计次/配额 | 下载后 `downloadCount +1`；超上限后 **410** |
| 过期 | `expiresIn:1` 的合集到期后 **410** |
| 撤销 | 分享信息 404、`/s/` 不再跳转、列表里消失 |
| 文件级无回归 | 旧的 `?s=` 分享仍可建可读，且未被误标成合集 |

> **这个脚本的由来**：合集后端写完、四道静态守卫全 PASS 之后，第一次跑真实链路
> 就炸出两个静态检查看不见的洞：
> 1. **短链从不自动生成** —— `buildBundleSlug` 被 import 了却从未调用，
>    创建请求一律 500「合集短链标识无效」。前端界面上根本没有短链输入框
>    （合集不暴露自定义短链），所以「留空」是正常路径，必须服务端自动分配。
> 2. **合集配额是死代码** —— `incrementBundleDownloadCount` 定义了但全仓无调用点，
>    `/file/...` 也完全不认 `?b=`。结果是 maxDownloads 只校验不记账：
>    「上限 1 次」能下无限次。
>
> 两条都属于「四道守卫查语法、查共享层、查 token，但不查链路是否真的接通」。
> 所以本脚本的定位是**链路完整性**，不是回归。

**前置条件与坑**：

- 需要 `node:sqlite`（Node 22+）。本地 wrangler 没有 telegram 出口，
  `upload-from-url` 又被 SSRF 防护挡住回环地址，所以文件记录由
  `_seed-kv.mjs` 直接写进 `--persist-to` 的 KV 库（形状与真实上传一致）。
- **会话 cookie 带 `Secure; SameSite=Strict`**，在 `http://127.0.0.1` 上
  Chromium 的网络栈不持久化它 —— 所以请求统一用**页面内的 fetch**
  （非安全上下文豁免），不能用 `context.request`。
- Pages 会把 `/share.html` 规范化成无扩展名的 `/share`，断言 URL 时两种形态都要认。
- `fetch(redirect:'manual')` 拿到的是 opaque-redirect，读不到 `Location`；
  要看跳转目标只能用 `page.goto()`。
- 本地测不出「下载内容对不对」（上游不可达会 500）。配额闸门发生在取字节**之前**，
  所以「超次数 410」可以验证；「首次下载 HTTP 500」属预期，断言写成
  「未被配额拦截」而不是「下载成功」。
- **上游 500 也计入配额**，这是刻意的：分享页已通过 `share-info` 确认过文件存在，
  说明是真实访问尝试；不计数等于给出「反复请求让它 500」的绕过入口。
  真正不计数的是 401/403/404/410（闸门拦下或路径不存在）。

### `dead-selectors.mjs` —— 删 CSS 之前必须先跑（防误删）

```bash
node scripts/verify/dead-selectors.mjs .header-content .nav-links .toolbar
# 不带参数时用内置的 DEFAULT_SELECTORS
```

输出每个选择器在每页的运行时匹配数，并给出「死 · 可删」/「在用(N) 勿删」的判定。

> **这个脚本的由来**：清理 `mobile-refactor.css` 时，第一遍静态判断误删了
> `.header-title` / `.header-actions` —— grep 看着像没人用，其实 `webdav.html` 里
> 有一个。跑这个脚本会立刻显示 `webdav: 1`，一眼就知道不能删。
>
> **判据是两条，缺一不可**：
> 1. 全量 HTML/JS 的 `class` 属性做**精确 token 匹配**（静态，防 grep 子串误判）
> 2. 真实浏览器 `querySelectorAll` 的匹配数（运行时，本脚本）
>
> 两个都说 0 才算真死。`grep 'class="[^"]*\bcard\b'` 会把 `photo-card` 算进去，
> 又会把 `class="toolbar-card"` 误认为 `.toolbar` 存在——别用 grep 下结论。

### `visual-snapshot.mjs` + `visual-diff.mjs` —— 重构前后比对（安全证明）

```bash
# 改之前
node scripts/verify/visual-snapshot.mjs /tmp/before.json
# ... 改 CSS ...
# 改之后
node scripts/verify/visual-snapshot.mjs /tmp/after.json
# 比对
node scripts/verify/visual-diff.mjs /tmp/before.json /tmp/after.json
```

拍的不是截图，而是**关键元素的计算样式**（5 视口 × 8 页 × 13 元素 × 23 属性 = 520 项）。
比截图严格：肉眼会漏 1px，字符串比对不会。

### `queue-collapse.mjs` —— 队列/结果面板高度收起动画（真实上传全链路）

```bash
# 先按 AI-OPERATIONS.md §2.2 起带凭据的本地全栈（开放实例 /upload 会 401）
BASE=http://127.0.0.1:8099 node scripts/verify/queue-collapse.mjs
```

登录（应用层 /api/auth/login）→ 预置 r2 → 页面内构造 File 走**真实上传** →
逐帧采样两个面板的高度曲线：队列 enter 必须从 0 渐开、leave（2.5s 清理器
移除任务后）必须平滑收起到 0、结果头部「选择/清空」必须在。
背景：这两个面板原用 `rise`（不插值高度），任务完成瞬间塌陷、布局弹跳；
已统一改共享层 `collapse` 过渡（`0fr↔1fr` 真插值 + `--ease-apple`）。
**坑**：清理器清空 `uploadingFiles` 是同步的、leave 动画是异步的——采样
面板消失要用元素引用（`el.isConnected`），不能用 `uploadingFiles.length`。

### `queue-node-badge.mjs` —— 上传队列「储存位置」标签落位回归

```bash
# 先按 AI-OPERATIONS.md §0 起本地全栈（需登录态）
BASE=http://127.0.0.1:8099 node scripts/verify/queue-node-badge.mjs
```

真实入队 + 真实暂停（让 3 个按钮渲染出来），在 5 个视口（360/390/430/768/1440）
× 2 种节点（r2 / telegram）上断言 9~10 项：标签在右侧操作列内且**已移出文字区**、
位于按钮组正上方、右缘与操作列对齐且不溢出、窄屏显示短名而宽屏显示完整名、
**可见文本唯一**（完整名与短名不会同时显示）、窄屏操作列维持 94px 不被撑宽。

> **这个脚本的由来**：该标签**连续返工三轮**，每次都是「静态守卫全绿、看着也对，
> 用户一截图还是错位」。三轮分别是：
> 1. 留在文件名行右端 → 中文长文件名被压成「6 字 + 省略号」；
> 2. 移到元信息行末尾 → 移动端内容列仅 100~130px，而「大小」(80) +「状态」(78)
>    已占 158px，标签(96)被挤到第 3 行、左侧空 34px，观感就是「错位」；
> 3. 元信息行改两列网格 → 标签虽钉在右列，左列却被压到只剩 30px、每行一个字。
>
> 根因：**移动端文字区放不下第三样东西**，在那里换任何排法都无解。
> 前两轮之所以没发现，是因为我当时只断言了「标签位置」而没量「文字区可用宽度」
> 和「标签是否与左侧内容争空间」。本脚本补上了这两条判据。
>
> 另有两个测试自身的坑值得记住：
> - 首例冷启动时 `setStorageMode` 是**异步**的，不等它落定就入队会用默认的
>   telegram 入队 —— 表现为「r2 用例却显示 Telegram」，是测试竞态而非产品 bug；
> - 逐用例调 `/api/auth/login` 会触发**频次限制（429）**，必须整个脚本只登录一次、
>   用 `storageState` 把 cookie 复用给各 context。

### `select-bar.mjs` —— 选择模式操作条高度动画（真实上传全链路）

```bash
BASE=http://127.0.0.1:8099 node scripts/verify/select-bar.mjs
```

登录 → 预置 r2 → 真实上传 → 结果出现后点「选择」/「完成」切换选择模式，
逐帧采样操作条外层 `.collapse` 容器的高度曲线：enter 必须从 0 渐开、
leave 必须平滑收起到 0（ease-apple 曲线）。背景：selection-bar 原用 `bar`
过渡（不插值高度），操作条出现/消失瞬间撑开/塌掉面板高度——即
「选择模式 ↔ 普通模式瞬间弹回」的根源；已改共享层 `collapse` 包裹。
**坑**：`.selection-bar` 自身内容高度不变（被裁切的是外层 `.collapse`），
要采样 `closest('.collapse')` 而不是操作条本身；容器终高 = 内容高 + margin-top。

### `select-bar-actions.mjs` —— 选择条「功能选项」改造后的行为回归

```bash
BASE=http://127.0.0.1:8099 node scripts/verify/select-bar-actions.mjs
```

四组、27 条断言，全部走真实上传（预置 r2）：

1. **交付结果条**：按钮集合 = 下载 / 分享 / 复制链接 / 移动到 / 删除；只有「删除」
   是 danger；未选中时前三个置灰、已登录且已选中时五个全可用。
2. **移动到**确实弹出 prompt 对话框、确认后真的 POST `move-folder`，并用
   `/api/manage/list` 反查云端 `folderPath` 已改（**坑**：该接口返回的是
   `keys[]`，`folderPath` 挂在 `metadata` 上，不是 `files[]`）。
3. **删除**确实弹 danger 确认框、逐个调 `manage/delete/<id>`，删除后再 HEAD
   文件 URL 必须是 404/410，且本地历史同一条同步失效（不留死链）。
4. **未登录**时 移动到/删除 置灰且 tooltip 提示需要登录；**历史条**按钮集合与
   云端删除行为；**批量下载**用探针替换 `_doNativeDownload` 计数（headless
   里真下载落不了地），断言逐个触发且间隔 ≥400ms（否则浏览器判为滥用而静默拦截）。

**坑（都踩过）**：
- `page.evaluate(fn)` 会 **await 返回的 Promise**。写成 `() => app.deleteSelected()`
  这种「箭头直接返回」的形式，evaluate 会一直挂到弹窗被确认为止——而确认动作
  在下一个 evaluate 里，死锁。必须写成 `{ app.deleteSelected(); }`（返回 undefined）。
- `page.waitForFunction(fn, options)` 的第二个参数是 **arg 不是 options**。
  写成 `waitForFunction(fn, { timeout: 5000 })` 时超时仍是默认 30s。
- 本部署**访客上传是关闭的**，未登录上传会被 `redirectToLogin()` 弹去登录页，
  `#app` 随之变 null。要测「未登录」分支就先登录传完文件，再把
  `isAuthenticated` 置回 false 来验证模板绑定。
- `selectedFiles` 是**计算属性**不是方法，写成 `this.selectedFiles()` 会抛
  `is not a function`（页面错误，按钮点了没反应）。

### `share-page.mjs` —— 分享详情页（share.html）改写后的行为回归

```bash
BASE=http://127.0.0.1:8099 node scripts/verify/share-page.mjs

# 故障注入（证明脚本能抓到故障）
BREAK_TONE=1    BASE=http://127.0.0.1:8099 node scripts/verify/share-page.mjs
BREAK_ALLPICK=1 BASE=http://127.0.0.1:8099 node scripts/verify/share-page.mjs
```

六组、65 条断言，走真实分享（单文件 + 6 文件合集 + 带密码合集）：

1. **A 双栏骨架**：桌面 1280 左右并排且顶部对齐、右栏 ≥292px；窄屏 390 上下堆叠；
   390/768/1440 三档都不横向溢出。
2. **B 单文件概览**：hero 文件名 / 类型 / 大小 / 相对时间；图标是 FontAwesome
   （class + `::before` 的 font-family 双重确认）；**正文无 emoji**；元信息面板
   6 行齐全；下载主按钮的 href 带 `dl=1`。
3. **C 阻断态**：过期 / 次数用尽时先出阻断条 + 换成 disabled 的「无法下载」，
   而不是放一条点了才 410 的链接。
4. **D 合集**：图标按类型分色（≥5 种实际渲染色）、按扩展名细分标签（PDF / 压缩包 /
   表格）、搜索（含空态）、按名称 / 大小 / 类型排序、多选批量下载（探针计数 +
   间隔 ≥400ms）、「全选」只作用于当前筛选结果。
5. **E**：静默刷新（下载后回查剩余次数）不能清掉已勾选项。
6. **F**：密码门（错密码留在门内并报错、对密码放行）、失效态有重试按钮、无参数
   时明确提示、全程无 JS 报错。

**坑（都踩过）**：
- **不能把 Vue 根实例 evaluate 出来**。`document.querySelector('#app')._vnode
  .component.proxy` 带着整棵树的循环引用，直接 return 会报
  `object reference chain is too long`。统一在页面内取好原始值再回传
  （本脚本的 `peek()` / `peekAll()`）。
- **入场动画期间量位置会得到假偏差**。`.layout .card` 挂 `riseIn`（含 translateY），
  动画没跑完时主栏 rect 比侧栏低 16px，「两栏顶部对齐」会误判失败。落地后要等
  ≈800ms 再量。
- **Vue 的 options methods 是 `bind(publicThis)` 过的**，而模板里
  `@click="methodName"` 走的是裸调用。故障注入时若直接
  `app.method = function(){ this.xxx }`，`this` 会落到 `window` 上（非严格模式），
  症状是 handler 静默抛 `Cannot read properties of undefined`。注入必须**闭包捕获
  实例**，不能依赖 `this`。
- **排序断言要防假通过**：种子文件的名称序、大小序、类型序必须互相错开，
  否则「按名称」和「按大小」会给出同一个顺序，脚本永远绿。
- **中文标签排序**在 `localeCompare(…, 'zh-Hans-CN')` 下的绝对次序依赖 ICU 版本，
  不要钉死；只断言「同标签聚在一起」+「结果确实不同于按名称」。
- 服务端在 `share-info` 上就已经拦了过期 / 超次（410 → 页面进 error 态），所以
  `blockReason` 那条路径要**推进 `app.now`** 才能走到 —— 它对应的正是「页面开着
  的时候走到临界点」这个真实场景（30s tick 会重算同一个 computed）。

### `overflow-x.mjs` —— 移动端横向溢出验证（真实上传全链路）

```bash
BASE=http://127.0.0.1:8099 node scripts/verify/overflow-x.mjs
```

登录 → 预置 r2 → 用**长文件名**真实上传（贴近真机 `IMG_2026…_1.jpg`）→
等 collapse 进场动画结束 → 量两层：① `scrollWidth === clientWidth`
（无横向滚动，absolute/fixed 的真实溢出也由这层兜底）；② 逐个**在流元素**
（static/relative）右边界不得越出视口。背景：结果面板改 collapse 后真机出现
整页横向溢出（清空按钮/底部导航被截出右边界）——grid 子项默认
`min-width:auto`，行内容 min-content 把轨道撑宽 11px；已修
`.collapse > * { min-height:0; min-width:0 }`。
**坑**：Playwright 测溢出**别开 `isMobile:true`** —— Chrome 移动端会把布局视口
自动撑宽（390→401）去"容纳"超宽内容，`innerWidth` 跟着变大，溢出全部漏检。

### `dock-indicator.mjs` —— 底部 Dock 液态玻璃 + 滑动指示器 + 跟手拖拽

```bash
BASE=http://127.0.0.1:8099 CHROME_PATH=/usr/bin/chromium \
  BASIC_USER=admin BASIC_PASS=123 node scripts/verify/dock-indicator.mjs
```

核对 index 底部 Dock 改造（iOS 27 式）：① 指示器玻璃化（渐变底 + inset 高光 +
spring 过渡）；② 点击 0→3 指示器**真实渲染位**逐格右移；③ 「更多功能」与抽屉内
「系统导航」都停在**第 4 格**（menu/history 两个 tab 共用一格）；④ 跟手拖拽
**全程无瞬移**（2px 步长采 188 点，断言相邻位移 ≤ 8px —— 旧的双变量叠加 bug
实测突跳 125.5px，必被抓住）并吸附到最近格、落点与目标格重合、执行对应抽屉
行为、不误触发点击；⑤ 容器高透（alpha≈0.42）+ `blur + saturate`；⑥ 无横向溢出；
⑦ 移动端 padding 收紧、blur 降级到 14px、指示器 4 格右缘与 dock 内地缘对齐。
**坑**：
1. 验证必须读 `getBoundingClientRect().left`，**不能读 `--dock-pos`**（那只是
   输入，读它会得到"永远不动"或假阳性）。
2. 抽屉打开时 `modal-mask`(z-index 2000) 覆盖 dock(z-index 100)，点 dock 前
   须先关抽屉（既有产品行为）。
3. 「无瞬移」阈值**不能**按槽宽定（槽宽≈102px，取 2.5×=309px 会放过 125px 的
   瞬移）。要按**手指步长**定，取 4×（=8px）。改动本断言后，建议临时注入
   旧架构（`--dock-i` + `--dock-drag-x` 叠加）自证它**能检出** —— 铁律 14。

### `glass-fx.mjs` —— 液态玻璃增强层（glassfx）运行时验证

```bash
# 先按 AI-OPERATIONS.md §2.2 起带凭据的本地全栈
BASE=http://127.0.0.1:8099 CHROME_PATH=/usr/bin/chromium \
  BASIC_USER=admin BASIC_PASS=123 node scripts/verify/glass-fx.mjs
```

桌面 + 移动两种视口下核对：① glassfx 的共享折射滤镜 `#glassfx-refract`
确已注入（JS 增强生效）；② `.glass` 元素上 `backdrop-filter` 含
`blur(20px)` + `saturate(180%)`；③ 指针移入后 `.glass` 被写入
`--glass-mx/--glass-my`（光标 bloom 追踪在跑）；④ 移动端按 `@media(max-width:680px)`
把 `--glass-blur` 降级到 14px（不关模糊）。背景：本轮 Apple 风玻璃重构
（统一 `--glass-blur:20px`/`saturate(180%)`/`--ease-out`，接入 vendored
glassfx，清理入场 `filter:blur`）。
**坑**：本地 wrangler dev 带 `BASIC_USER/PASS` 时，页面匿名轮询 `/api/manage/*`
会回 401，被 `page.on('console')` 当成 error —— 脚本用 `IGNORE` 正则
过滤资源/网络类报错，只对**真实 script 异常**报警。

### `verify_classes.mjs` —— 上收类渲染验证

```bash
node scripts/verify/verify_classes.mjs
```
就地构造带这些类的元素，读计算样式，逐属性核对：`.ambient-glow` / `.ambient-orb`
/ `.mono` / `.grow` / `.password-gate*` / `.modal`（都是本次从各页面内联 `<style>`
上收到 `design-system.css` 的）。**确认共享层真的在 8 页生效**，而不是因某页漏了
`<link>` 或删了定义就退回默认值。smoke 不覆盖这一项。

### `audit-theme-toggle.mjs` —— 每页主题开关盘点

```bash
node scripts/verify/audit-theme-toggle.mjs
```

精确统计每页的 `data-theme-toggle` 元素与各开关路径（自带按钮 / gallery 自绘 /
浮动按钮 / webdav 的 `.btn action-btn`）。诊断「自带开关页不该再被造浮动按钮、
其余页浮动按钮必须恰好 1 个」——防 `data-theme-toggle` 被误挂在 `<body>` 上导致
一次点击被处理两次、主题来回抵消。

### `visual-check.mjs` —— 视觉冒烟（具体元素）

```bash
node scripts/verify/visual-check.mjs
```

查**具体视觉元素**是否出现且属性对：环境光层 `.ambient-glow` 是否固定定位、
密码门 `.password-gate` 是否按 token 版渲染（max-width 380px）、玻璃卡是否有背景色、
`.btn` 高度是否合理、以及 **FontAwesome 是否真正加载**（之前 share.html 没引，
图标全是方块；smoke 和 verify_classes 都没覆盖这项）。

`visual-diff.mjs` 退出码 0 = 完全一致，1 = 有差异（逐属性打印）。

**用途**：证明「这轮重构是纯删死代码，没有改变任何渲染结果」。本次清理
`mobile-refactor.css`（781 → 433 行）就是用它证明的。

## 两个坑（都踩过，已在代码里修掉）

**1. `getPropertyValue()` 只认 kebab-case。**

```js
cs.getPropertyValue('borderRadius')  // ""  ← 静默返回空串
cs.getPropertyValue('border-radius') // "22px"
cs.borderRadius                      // "22px" ← 用这个
```

踩坑后果：快照里**所有属性都是空串**，于是"改前 vs 改后"永远显示 **0 差异**——
一个看起来完美、实际什么都没验的假阴性。现在脚本里用 `cs[name]` 直接读，
并且加了**自检**：若超过 50% 的属性为空，直接报错退出（退出码 3），不产出不可信的快照。

**2. 无限动画会让 `opacity` / `transform` 每次都不同。**

本仓库有 `.orb-1`/`.orb-2` 的 `orbFloat`、`.status-pill__pulse` 的 `pulseRing` 等
无限动画。它们让 `opacity` 在两次快照间漂移（实测 `0.975196` vs `0.975208`），
产生假阳性。所以：

- `PROPS` 里**刻意不含** `opacity` / `transform` / `filter`
- 快照用 `reducedMotion: 'reduce'` 上下文（本仓库有对应的 `@media` 把动画压到 0.01ms）

## 自检清单

改完前端后：

```bash
python3 scripts/check_style.py && \
python3 scripts/check_tokens.py && \
python3 scripts/check_functions.py && \
python3 scripts/check_shared.py && \
node scripts/verify/smoke.mjs
```

改动涉及后端链路（分享 / 上传 / 下载计次）时**额外**跑：
`node scripts/verify/share-bundle.mjs`（需本地全栈）。

改动涉及**选择条 / 批量操作**（删除、移动、批量下载）时**额外**跑：
`node scripts/verify/select-bar-actions.mjs`（需本地全栈）。它自带
`BREAK_DELETE=1` 故障注入开关，用来证明脚本确实能抓到「删除没真调接口」。

改动涉及**分享页**（share.html：布局 / 元信息 / 合集清单 / 下载）时**额外**跑：
`node scripts/verify/share-page.mjs`（需本地全栈）。它自带 `BREAK_TONE=1`
（抹掉类型配色）与 `BREAK_ALLPICK=1`（全选不受搜索限制）两个注入开关。

**新脚本的铁律：先证明它能捕捉故障。** 写完之后回退/注入一次对应 bug，
确认脚本确实变红 —— 一个永远绿的测试等于没有测试。`share-bundle.mjs`
就是靠这一步确认「slug 不生成」和「配额不计数」这两类故障都跑不掉；
`share-page.mjs` 靠 `BREAK_TONE` / `BREAK_ALLPICK` 确认「配色丢了」和
「全选越界」两类故障都跑不掉（各红 2 条）。

清理/重构 CSS 时**额外**做：`dead-selectors.mjs` 确认可删 → 改 → `visual-snapshot` + `visual-diff` 确认零差异。

## 历史归档：`_archive/`

上一轮「前端统一化」改造期间写过的脚本都收在 `scripts/verify/_archive/`
（详见该目录的 `_HEADER_NOTE.txt`）。分两类，**都不要直接运行**：

- **已被活跃版本取代**（只读测试）：`visual_snap.mjs`、`regress_full.mjs`、
  `dead_css.mjs`；以及已失效的 `check_toggle_link.mjs`（它查的死类已被删）。
- **一次性改造/分析工具**（会改动文件，**绝不可重跑**）：`prune2.py` / `prune3.py` /
  `prune_mobile.py` 用脚本改写过 `mobile-refactor.css`，该文件已是清理后最终状态，
  重跑会把它改坏；`analyze_pending.py` / `classify.py` / `classify2.py` /
  `dead_quant.py` 是当时取证「37 个重复类」用过的分析工具，仅供追溯。

> 归到这里是为了"工作不丢、可追溯"。要用测试请认准上面的 6 个活跃脚本。
