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
> `_HEADER_NOTE.txt`）。下面是当前在用的 6 个。

### `smoke.mjs` —— 8 页冒烟测试（改完前端必跑）

```bash
node scripts/verify/smoke.mjs
```

每页在桌面(1440×900)/移动(390×844)两种视口下检查：

- **JS 报错**（`pageerror`）必须为 0
- **死选择器节点**必须为 0（`DEAD_SELECTORS` 里那批已确认全站不存在的类）
- **主题切换**可用（能改 `data-theme`）

退出码 0 = 全过。

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
