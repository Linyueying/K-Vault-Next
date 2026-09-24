# AI-OPERATIONS.md

> **这份文档是写给 AI Agent / 自动化助手的，不是写给人类用户的。**
> 人类用户请读 [`README.md`](README.md)。
>
> 目的：让下一个接到这个仓库的 AI 不用重新踩一遍坑，能直接进入「改 → 验 → 推」的循环。
> 内容：环境怎么搭、怎么验证、怎么推送、怎么调试、已知的坑、历史事故复盘、写代码的硬约束。

---

## 0. 三十秒接手

```bash
# 1. 就位
cd <repo> && git branch --show-current      # 应为 Pre，不要动 main
git log --oneline -5                        # 确认基线

# 2. 装依赖（只为 wrangler，仓库无构建步骤）
npm install

# 3. 起本地全栈（KV + R2 绑定齐全，这是唯一可信的验证环境）
npx wrangler pages dev ./ \
  --kv "img_url" --r2=R2_BUCKET \
  --compatibility-date=2026-05-03 \
  --port 8099 --persist-to /tmp/kvdata \
  --binding BASIC_USER=admin --binding BASIC_PASS=123

# 4. 改完必跑四道静态守卫
python3 scripts/check_style.py
python3 scripts/check_tokens.py
python3 scripts/check_functions.py
python3 scripts/check_shared.py     # 跨页共享层：防「一次改动只生效一页」的漂移复发

# 5. 改动涉及前端渲染时，再跑运行时冒烟
python3 -m http.server 8788 --bind 127.0.0.1 &
node scripts/verify/smoke.mjs       # 8 页 × 双视口：JS 报错 / 死选择器 / 主题切换
#   （需要 playwright-core，见 scripts/verify/README.md）

# 6. 推
git push "https://<PAT>@ghfast.top/https://github.com/<owner>/<repo>.git" Pre
```

> 静态守卫查源码；`scripts/verify/` 查真实渲染。两者都过才算验证完。
> 清理 CSS 时**额外**先跑 `node scripts/verify/dead-selectors.mjs <选择器>`，
> 再改完用 `visual-snapshot` + `visual-diff` 证明零差异 —— 见 [3.4](#34-浏览器验证)。

> PAT 由用户在会话中提供；**同一个 token 可在同一条对话内反复使用，但严禁跨对话复用（新对话须换全新 token）**。**绝不写进任何文件、绝不提交、绝不回显在回复正文里**。
> 用法见 [第 5 节](#5-git-操作与推送)。

---

## 1. 项目形态（决定了一切约束）

| 事实 | 影响 |
| :--- | :--- |
| **Cloudflare Pages + Pages Functions** | 后端全部在 `functions/` 下，走 Web Standard `Request`/`Response`，**不是 Node 运行时** |
| **无构建步骤** | 根目录就是产物。**不要**引入打包器、TS 编译、`dist/` 输出 |
| **8 个单文件 HTML** | `index / admin / gallery / paste / share / preview / webdav / login`。每页 CSS、JS 全内联在 `<style>` / `<script>` 里 |
| **唯一共享样式层** | `design-system.css`。页面内联 `<style>` 只允许写「本页增量」 |
| **唯一共享 JS 层** | `app-core.js`（`window.KVault`）。`formatBytes` / `toast` / `copy` / `fetchJSON` / `formatTime` / `escapeHtml` / `debounce` 只有这一份实现 |
| **Vue 3（纯，无 `@vue/compat`）** | 前端框架已是 Vue 3，`createApp` 全局挂载 |
| **零运行时依赖** | 业务代码只用平台内置 API。**不要**加 `dependencies` |
| **工作分支 `Pre`** | **永远不推 `main`**。默认分支与本分支的人际约定由用户决定 |

**判断一个改动是否合规的最快方式**：跑那四道守卫脚本。它们就是这套约束的可执行版本。

---

## 2. 本地环境

### 2.1 依赖

```bash
npm install          # 只装 wrangler（devDependency）
```

Node 版本见 `.node-version`（22）。Python 3 用于守卫脚本（标准库即可，无需 pip）。

### 2.2 启动本地全栈

仓库的 `npm start` 用 8080 端口、`./data` 作持久化目录。**做调试时建议自己指定参数**，好处是端口固定、持久化目录干净、可以随时 `rm -rf` 重来：

```bash
npx wrangler pages dev ./ \
  --kv "img_url" \
  --r2=R2_BUCKET \
  --compatibility-date=2026-05-03 \
  --port 8099 \
  --persist-to /tmp/kvdata \
  --binding BASIC_USER=admin \
  --binding BASIC_PASS=123
```

关键点：

- `--kv "img_url"` —— KV 绑定名，**必须叫 `img_url`**，写别的名字整个项目跑不起来。
- `--r2=R2_BUCKET` —— R2 绑定名，**必须叫 `R2_BUCKET`**。不传这个参数，本地就是「没绑 R2」的状态，任何 R2 相关代码路径都验不到。
- `--persist-to` —— KV/R2 落到本地磁盘。**必须显式指定**，否则默认写到 `.wrangler/` 里，容易和真实项目状态混淆、也不好清理。
- `--binding` —— 这两个是**凭据**，本地用明文传即可。它们是 `BASIC_USER`/`BASIC_PASS` 环境变量。
- **想测「开放实例」**（无鉴权）：把两个 `--binding` 去掉重启即可。这条路径有独立的行为分支，见 [4.3](#43-鉴权语义有两套分支不要只测一套)。

> ⚠️ 后台起服务时用 `run_in_background`，不要用 `&` + 立即返回——非交互式运行会在主 agent 结束回合时把子进程一起带走。

### 2.3 `.env` 到底读不读

| 环境 | 读 `.env` / `.dev.vars` 吗 |
| :--- | :--- |
| **本地 `wrangler pages dev`** | ✅ **读**。本地调试把变量写这里有效 |
| **线上 Cloudflare Pages** | ❌ **不读**。线上只认 Dashboard 里的环境变量与绑定 |

`git` 里已忽略 `.env`（见 `.gitignore`）。仓库里的 `.env.example` 只是「需要配哪些」的清单，不是配置文件。

### 2.4 线上部署配置速查

| 项 | 值 |
| :--- | :--- |
| Build command | **留空** |
| Build output directory | **留空** |
| Root directory | **留空** |
| Framework preset | `None` |
| KV 绑定名 | `img_url`（Settings → **Functions**，不是 Environment variables） |
| R2 绑定名 | `R2_BUCKET`（同上） |

**最容易被 AI 搞错的点**：KV/R2 是 **Binding（绑定）**，不是 **Environment variable**。在 Settings → Environment variables 里填 `img_url = xxx` 是**无效的**，必须在 Settings → Functions → KV namespace bindings / R2 bucket bindings 里绑。

绑定与环境变量**都只在部署时注入**：改完必须 Retry deployment 或推一次新提交，运行中的部署不会自己读到新值。

---

## 3. 验证工具箱

### 3.1 四道守卫脚本（改完必跑）

```bash
python3 scripts/check_style.py       # 页面内联 <style> 合法性
python3 scripts/check_tokens.py      # 变量 / 动画名可解析 + 共享层无死关键帧
python3 scripts/check_functions.py   # functions/ 语法 + 未定义符号
python3 scripts/check_shared.py      # 跨页共享层一致性（防「一改只生效一页」）
```

各脚本具体查什么：

**`check_style.py`**
1. 每个 `<style>` 块花括号配平
2. 内联 `<style>` 里**禁止**定义 `@keyframes`（必须收口到 `design-system.css`）
3. 禁止页面重复定义全站 `prefers-reduced-motion` 冻结规则（只允许补充「豁免加载指示器」的局部规则）
4. 每个页面必须引入 `design-system.css`
5. 每个页面必须引入本地 FontAwesome（`vendor/fontawesome/css/all.min.css`）

**`check_tokens.py`**
1. 页面里 `var(--x)` 引用的变量，必须能在共享层或本页找到定义
2. `animation:` 里用到的动画名，必须能找到对应 `@keyframes`
3. 共享层里**定义了但全站无人引用**的 `@keyframes`（「死动画」）—— 这类残留会误导动效排查

**`check_functions.py`**
1. `functions/` 下每个 `.js` 做 `node --check`
2. 轻量标识符解析，抓「被当作函数调用、但既没 import、也没本地声明、也不是参数/内置」的名字

**`check_shared.py`**

这是「一次修改多前端生效」这条目标的守门人。它拦的是**漂移**——同一个能力在不同页面各写一份，改一处其余页不受影响。

| 检查 | 内容 |
| :--- | :--- |
| **A. 页面禁用** | 页面内不得再自行实现 `app-core.js` 已提供的能力（手写 `formatBytes`、`fallbackCopy`、`execCommand("copy")`、toast 图标映射） |
| **B. 加载顺序** | 8 页的样式表/脚本加载顺序必须与 `index.html` 一致（子序列语义） |
| **C. 属性级重写** | 页面若重写了 `design-system.css` 已有的**同名属性**才算违规；只追加原层没有的属性（如 `.card{padding}`）属无害增量 |
| **D. 组件类覆盖** | 页面不得**无条件**覆盖共享组件类；`@media` 内的响应式/触控适配属正当用法 |
| **E. 死选择器回潮** | `mobile-refactor.css` 里已确认清理的那批类不得再次出现（见 [3.6](#36-mobile-refactorcss-为什么不能整体上收)） |

**两类显式登记的例外**（都在脚本顶部常量里，必须写明理由）：

- `CRITICAL_EXCEPTIONS` —— 某页面有意保留独立外观的组件类
- `LATE_LOAD_CSS` —— 有意排在基础层之后、靠级联生效的覆盖层样式表（目前是 `mobile-refactor.css`）

检查 C/D/E 做了大量误报抑制，理解这几条能避免你白跑：

- **注释里的文件名**（`design-system.css`）不是类名
- **修饰/状态类**（`.danger` / `.is-active`）天然多页出现，不算漂移
- **后代限定**（`.dlg__actions .btn`）是页面作用域收敛，不是重写共享组件
- **`@media` 内的规则**是响应式适配，不是无条件覆盖
- **只在选择器区域取类名**，不扫声明体（否则 `url(...)` 里的点号会误判）
- **E 只拦「已确认清理过的类」**，不拦「当前无页面使用的防御性类」（如 `.toolbar`）—— 后者无害

**新增共享能力时的正确顺序**：先加进 `app-core.js` / `design-system.css`，再把各页调用点切过去，最后跑守卫确认 [A] 通过。**不要**先在页面里写一份「临时实现」——那正是这套检查要消灭的东西。

### 3.2 `check_functions.py` 为什么必须存在

**这是本仓库最重要的一条经验。**

`node --check` **只查语法，不做标识符解析**。ESM 里调用了忘记 `import` 的函数，语法完全合法，`node --check` 通过，wrangler 本地 dev 也正常启动 —— 只有在**真正请求到那条分支**时才抛 `ReferenceError`，返回 500。

历史事故（见 [6.1](#61-r2-永久显示未配置--apistatus-全量-500)）：一个漏掉的 import 让 `/api/status` 全量 500，前端因此把 R2 判定为「未配置」，表现为「绑好了 R2 却提示未配置」。这个 bug 在仓库里潜伏了多个提交才被用户发现。

**行为**：
- 递归扫描 `functions/` 下全部 `.js`（也可传具体文件）
- 允许的内置集合覆盖 JS 语言内置 + Cloudflare Workers 全局（`fetch`/`crypto`/`Request`/`Response`/`URL`/`TextEncoder` …）+ `escape`/`unescape`
- 做了充分的误报抑制：剥离注释、字符串、模板串、正则字面量；跳过对象简写方法、类方法定义、模板字符串内部
- **逃生开关**：在某行加 `// check_functions: ignore` 可豁免该行（用于刻意为之的动态引用）

**如果你要新增 `functions/` 下的文件，务必在提交前跑一次这个脚本。** 它是唯一能拦住这类事故的东西。

### 3.3 端到端验证 R2（改动了存储/状态相关代码时必须做）

光看 `/api/status` 返回 200 不够，要跑一次真实上传：

```bash
# 1) 状态检查
curl -s -u admin:123 http://localhost:8099/api/status | python3 -m json.tool
#    期望：r2 = {"connected": true, "configured": true, "message": "Connected"}

# 2) 真实分片上传（init → chunk → complete）
#    用 /api/chunked-upload/init 拿 uploadId 与分片方案，
#    逐片 POST /api/chunked-upload/chunk（带 ETag 回传），
#    最后 POST /api/chunked-upload/complete

# 3) 回读刚传的内容，确认字节一致（例如写入 "hello-r2-endtoend-test"）

# 4) 再查一次 /api/status，确认 hasData: false → true
```

**因果验证法**：如果怀疑某段代码导致了行为变化，**临时回退该文件再观察一次**。本次修复就是这样证明因果的——把修复前的 `status.js` 放回去 → 500；换成修复后的 → 200。不要只凭「改完之后好了」就下结论。

### 3.4 浏览器验证

**两个层次，都要用**：

| 场景 | 工具 |
| :--- | :--- |
| 看一眼真实渲染、抓张截图 | `agent-browser` skill |
| **要跑成可重复的检查、要出结论** | `scripts/verify/*.mjs`（见下） |

#### 3.4.1 `scripts/verify/` —— 运行时验证脚本

**别再往 `/tmp` 里写一次性脚本了。** 历史上就是这么干的，结果是：每次做同类改造
都要重写一遍，而且本次因此**漏掉一次误删**（详见 [3.4.2](#342-删-css-前的铁律先跑-dead-selectorsmjs)）。
现在这些脚本都收在仓库里，配套说明见 `scripts/verify/README.md`。

```bash
# 前置
python3 -m http.server 8788 --bind 127.0.0.1 &
npm i -D playwright-core        # 或用全局的；脚本会自动找

# ① 8 页冒烟（改完前端必跑）
node scripts/verify/smoke.mjs

# ② 删 CSS 之前先问「这个选择器真死吗」
node scripts/verify/dead-selectors.mjs .header-content .toolbar

# ③ 重构前后比对（证明"没改变渲染结果"）
node scripts/verify/visual-snapshot.mjs /tmp/before.json
#   ... 改 CSS ...
node scripts/verify/visual-snapshot.mjs /tmp/after.json
node scripts/verify/visual-diff.mjs /tmp/before.json /tmp/after.json
```

**6 个活跃脚本**（`scripts/verify/`，配套说明见该目录 `README.md`），各自解决一类问题：

- **`smoke.mjs`** —— 8 页 × 双视口，查 JS 报错 / 死选择器节点 / 主题切换
- **`dead-selectors.mjs`** —— 运行时 `querySelectorAll` 计数，给出「死·可删」/「在用·勿删」
- **`visual-snapshot.mjs` + `visual-diff.mjs`** —— 520 项计算样式快照比对
- **`verify_classes.mjs`** —— 验证上收到 `design-system.css` 的类（`.ambient-glow` / `.modal` / `.password-gate*` 等）确实在 8 页都渲染正确
- **`audit-theme-toggle.mjs`** —— 每页主题开关盘点，诊断「开关重复/缺失」
- **`visual-check.mjs`** —— 具体视觉元素冒烟（含 FontAwesome 是否真加载，smoke 没覆盖这项）

> `scripts/verify/_archive/` 是历史归档（被取代的版本 + 一次性改造工具），**不要直接运行**，详见该目录 `_HEADER_NOTE.txt`。

#### 3.4.2 删 CSS 前的铁律：先跑 `dead-selectors.mjs`

**判一个选择器是不是死的，必须两条都过：**

1. 全量 HTML/JS 的 `class` 属性做**精确 token 匹配**（静态）
2. 真实浏览器里 `querySelectorAll` 的匹配数（运行时）

**不能靠 grep 下结论。** 两个反例：

- `grep 'class="[^"]*\bcard\b'` 会把 `photo-card` / `state-card` 算成 `.card` 在用
- 反过来，`class="toolbar-card"` 会让人误以为 `.toolbar` 存在

**真实事故**：清理 `mobile-refactor.css` 时，第一遍静态判断误删了 `.header-title` /
`.header-actions` —— 看着像没人用，其实 `webdav.html` 里各有一个
（`<h1 class="header-title">` / `<div class="header-actions">`）。跑一下
`dead-selectors.mjs .header-title` 会立刻显示 `webdav: 1`。**删之前跑一次，能省一次回滚。**

#### 3.4.3 `agent-browser` 的已知故障

```bash
agent-browser open http://localhost:8099/
agent-browser screenshot /tmp/shot.png
```

daemon 有时会挂住，报 `CDP command timed out: Target.setDiscoverTargets` / `Target.getTargets`。恢复：

```bash
agent-browser close --all
rm -rf /tmp/org.chromium.Chromium.*
```

⚠️ **不要用 `pkill -f chrome`** —— 模式太宽会把自己的命令链一起 SIGTERM 掉（表现为输出为空、命令链静默中断）。

**量计算样式时注意**：`getComputedStyle` 拿到的是**计算值**，和源码写的可能不同。例如 flex 容器里的 `inline-block` 子元素，计算结果是 `block`（CSS Display §2.7 blockification）—— 这是正常的，`transform` 依然生效，不要误判成回归。

> ⚠️ **另一个必踩的坑**：`getPropertyValue()` 只接受 **kebab-case**。
> `cs.getPropertyValue('borderRadius')` 会**静默返回空串**（不是报错！）。
> 用它写视觉比对，会让所有属性都变空、比对永远显示「0 差异」——一个完美的假阴性。
> **用 `cs.borderRadius` 直接读**，或用 `getPropertyValue('border-radius')`。
> `visual-snapshot.mjs` 已修此 bug 并加了「空值超 50% 即报错」的自检。

---

### 3.5 共享层架构（「改一处，8 页生效」怎么做到的）

历史上 8 个页面各写各的：`formatBytes` 有 **6 份**实现、toast **5 份**、剪贴板 **5 份**，
样式表加载顺序有 **6 种**组合。结果是改一个页面另外 7 个不受影响，维护成本极高。

现在收敛成两个共享层，页面只写「本页增量」。

#### 3.5.1 `app-core.js` —— 跨页共享 JS（`window.KVault`）

无构建步骤，所以用 IIFE 挂全局，而不是 ESM。各页在 `<head>` 里按
`theme.js → app-core.js → 页面主脚本` 的顺序引入。

| 能力 | 说明 |
| :--- | :--- |
| `formatBytes(bytes, opts)` | `Intl.NumberFormat` 版。`opts.zero` 可定制 0 值的显示（share 页用「未知大小」）。别名 `formatSize` |
| `toastIcon(type)` | `error` / `success` / `undo` / 其余 → `info`，统一图标映射 |
| `toastDelay(message)` | 按时长自适应 `2600 ~ 6000ms`，长消息停久一点。别名 `toastDuration` |
| `copy(text)` | 返回 `Promise<boolean>`。`clipboard → execCommand → false` 三段降级。别名 `copyText` |
| `fetchJSON(url, opts)` | 统一 `credentials:'include'`、统一错误抛出、`401` 单独语义 |
| `formatTime(input, opts)` | 统一「本地化 `YYYY-MM-DD HH:mm`」，`opts.dateOnly` 只要日期 |
| `escapeHtml(str)` / `debounce(fn, wait)` | 小工具 |

**约定**：复制失败**不 reject**，而是 resolve `false` —— 复制失败很常见，调用方通常只想 toast 一句，
reject 会逼出无谓的 `.catch`。

#### 3.5.2 `design-system.css` —— 唯一共享样式层

| 层 | 职责 | 加载位置 |
| :--- | :--- | :--- |
| `design-system.css` | 变量、组件基类（`.btn` `.card` `.modal` `.toast` …）、动画 | 每个页面 |
| `theme.css` | 主题色与切换按钮外观 | 每个页面 |
| `mobile-refactor.css` | 移动端覆盖层（**有意后加载**，靠级联生效）。**注意它不是共享层**，见 [3.6](#36-mobile-refactorcss-为什么不能整体上收) | 仅 4 页 |
| 页面内联 `<style>` | **只写本页增量** | — |

**判断标准**：如果你在页面 `<style>` 里写的属性，`design-system.css` 里**已经有了同名属性**，
那你就是在覆盖共享组件，应该改共享层而不是改页面。只写它没有的属性（如 `.card{padding}`）才是增量。
`check_shared.py` 的 [C] 就是按这个标准做**属性级**比对的。

**`@keyframes` 一律收口到 `design-system.css`**，页面内联 `<style>` 里禁止定义（`check_style.py` 会拦）。

> **别被「同名」骗了**：`grep` 出「几十个重复类」时，先逐一核实**是不是同一个组件**。
> 实测 37 个候选里只有 1 个是逐字节重复，其余 26 个是「同名不同组件」
> （`.actions` 在 share 是按钮行、在 preview 是右对齐元信息行）。
> 盲目合并会把两套设计揉成一套。判据是**属性级比对**，不是类名相同。

#### 3.5.3 主题统一

- 全局唯一 localStorage key：`"theme"`（旧的 `"themeMode"` 已做一次性迁移）
- 统一入口：`window.ThemeManager`（`theme.js`）
- 页面自带的切换按钮：在 `<html>` 上加 `data-own-theme-toggle`，`theme.js` 就不会再造浮动按钮，
  按钮自身的 `@click` 委托给 `ThemeManager.toggleTheme()`

> ⚠️ **不要**用 `data-theme-toggle` 标记「页面自带按钮」。
> `theme.js` 的 `initDom()` 会对 `querySelectorAll('[data-theme-toggle]')` 一律绑定点击处理器；
> 若把它挂在 `<body>` 上，body 就成了第二个切换按钮，一次点击被处理两次、主题来回抵消。
> 这正是 `data-own-theme-toggle` 这个独立属性名存在的原因。

**已删除的死分支**：`ensureAutoToggle()` 里原本还有两条「把按钮插进页头」的分支，分别查找
`.header .nav-links` 和 `.header-content .actions` —— 这两组类在 8 个页面里**都不存在**，
永远匹配不到（伴随的 `.theme-auto-inline-toggle` / `.theme-admin-toggle` 样式也一并从
`theme.css` 删了）。实际一直在生效的只有「浮动按钮」那条，这也正是 `paste` / `share` /
`preview` / `login` 四页会看到浮动主题开关的原因。

> **推论**：改主题按钮相关代码前，先确认页面走的是哪条路径 —— 自带按钮（`index` / `admin`）、
> `gallery` 自绘的 `theme-toggle-round`、浮动按钮（`paste` / `share` / `preview` / `login`），
> 还是 `webdav` 的 `.btn action-btn`。四条路径的外观都不同。

#### 3.5.4 怎么扩展

**加一个跨页能力**：写进 `app-core.js` → 挂到 `window.KVault` → 各页调用点切过去 → 跑守卫。
**加一个共享组件**：写进 `design-system.css` → 页面只留站点特定的尺寸/布局增量。

```bash
# 自查：各页是否还有「自己实现」的痕迹（守卫 [A] 的可读版）
python3 scripts/check_shared.py
```

#### 3.6 `mobile-refactor.css` 为什么不能整体上收

这是本仓库最容易误判的一个文件，单独说清楚。

**它是什么**：781 行（已清理为 433 行）的移动端覆盖层，靠「在 `design-system.css` / `theme.css` 之后加载」赢得级联。仅 `gallery` / `preview` / `webdav` / `login` 四页引入。

**它不是什么**：**不是共享层**。逐类统计 8 页使用情况后发现，全文件 71 个类里：

| 使用页数 | 类数 | 例子 |
| :--- | :--- | :--- |
| ≥4 页 | **1** | `.btn` |
| 1~3 页 | ~24 | `.header-title`（仅 webdav）、`.preview-close`（仅 gallery） |
| 0 页 | ~31 | `.toolbar` / `.upload-item` / `.audio-card` …（防御性留着） |

**所以不能把它合进 `design-system.css`**：那会把 webdav 的头部布局规则、gallery 的预览抽屉规则一并强加给另外 6 页。它不是「重复」，是**四页各自移动端增量的合集**。

**已经做了什么**（2024 收敛）：

1. 删掉 348 行指向「8 页里从未出现过」的类的死规则 —— `.header-content` / `.nav-links` / `.home-btn` / `.status-panel` / `.stats-text` / `.el-dropdown*` 等
2. 安全证明：清理前后各拍 132 项计算样式快照，逐一比对，**不一致 0 项**
3. 在守卫里加检查 [E]，防止这些类回潮

**踩过的坑（务必记住）**：第一遍清理时误删了 `.header-title` / `.header-actions`。原因是初查只看了「这几个类是否在多数页面出现」，没做**全页精确 token 匹配**，漏掉了 `webdav.html` 里那唯一的 `<h1 class="header-title">`。

> **教训**：判断一个类是否死，唯一可靠的方法是「全部 HTML + JS 的 `class` 属性做精确 token 匹配」，不能靠 grep 子串，也不能靠抽样看几页。`grep 'class="[^"]*\bcard\b'` 会把 `photo-card` / `state-card` 也算进去，而 `class="toolbar-card"` 会被误认为 `.toolbar` 存在。

**将来要废弃这个文件的话**，正确做法是：按页拆分成 4 块，各自并入对应页面的 `<style>`，而不是上收到共享层。


### 4.1 Shell 陷阱

| 陷阱 | 症状 | 做法 |
| :--- | :--- | :--- |
| **默认 shell 是 zsh** | `grep --include=*.js` 报 `no matches found` | 给 glob 加引号，或干脆用 Python 脚本 / 专用检索工具 |
| `pkill -f chrome` | 自己的命令链被一起杀掉，输出为空 | 用 `agent-browser close --all` + 删临时 profile |
| 后台服务用 `&` | 非交互式运行结束时子进程被带走 | 用工具的 background 模式，或在同一回合内前台 await |

### 4.2 排查后端问题

`/api/status` 是**前端所有存储状态判断的来源**。它一旦异常，前端会整体降级，现象往往表现为**某个后端「未配置」**，而不是「接口报错」——很容易被误判成 Cloudflare 侧配置问题。

排查顺序：
1. 直接 `curl` `/api/status`，看 HTTP 码与响应体。**500 就说明是后端代码问题，不是配置问题。**
2. 500 时去本地 dev server 的日志里看堆栈。
3. `ReferenceError: xxx is not defined` → 就是漏 import，跑 `check_functions.py` 定位。
4. 前端 `checkStorageTarget()` 有 try/catch，**任何异常都会被吞掉并回落成「不可用」**。所以前端现象不能反推后端原因。

### 4.3 鉴权语义有两套分支，不要只测一套

`functions/utils/auth.js` 里：

```js
isAuthRequired(env) === Boolean(env.BASIC_USER && env.BASIC_PASS)
```

| 实例类型 | `isAuthRequired` | 管理接口 | 未登录用户看 `/api/status` |
| :--- | :--- | :--- | :--- |
| **配了账密** | `true` | Cookie 会话 / HTTP Basic，未登录拒绝 | 只返回「是否已配置」，**不触发连通性探测**（脱敏） |
| **开放实例**（未配账密） | `false` | **fail-closed**：`/api/manage/**`、`/api/admin/**` 一律 `503 ADMIN_AUTH_NOT_CONFIGURED` | 可以看到完整状态 |

> 关键：**开放实例不等于「谁都是管理员」**。管理面是 fail-closed 的。
> 写 `isAdmin` 这类判断时必须用「是否要求鉴权」来决定语义，不能直接 `auth.authenticated && ...`——
> 那样在开放实例上会恒为 `false`，连实例创建者都看不到真实状态。**这是真实事故，见 6.1。**

### 4.4 排查动效/闪烁问题（本仓库的高频任务）

**先记住这条物理事实**：

| 属性 | 类型 | 特点 |
| :--- | :--- | :--- |
| `transform` / `opacity` | **compositor（合成）** | 在 GPU 上跑，与主线程解耦，掉帧时依然平滑 |
| `filter: blur()` / `backdrop-filter` / `box-shadow` / `background` | **paint（绘制）** | 每帧重新栅格化，代价高，低端设备上会肉眼可见地抖 |
| `width` / `height` / `top` / `left` / `margin` | **layout（布局）** | 触发重排，最贵 |

**闪烁的通用根因**：**两套曲线争夺同一个 `transform` / `opacity` 轨道。**

GPU 空闲时两条曲线相位接近，肉眼看不出问题；低端设备一掉帧，两条曲线的差值就显现出来——元素在差值之间来回位移/明暗，这就是用户看到的「闪烁」。

**排查步骤（照做即可）**：

1. **定位元素**，然后**枚举它和它所有祖先**上的 `animation` 与 `transition`。
   - 别只看目标元素本身。抽屉闪烁的元凶就在**祖先** `.modal-mask` 上。
2. 找出**争同一轨道**的那两条（通常是「Vue `<transition>` 族」+「一条 `@keyframes`」）。
3. **删掉冗余的那条**（一般是 `@keyframes`，因为 Vue transition 更能表达进出场语义）。
4. **把被删那条的视觉参数并进保留的那条** —— 起始值、缓动、时长、节奏全部对齐，**外观必须零变化**。
5. 删掉随之变成孤儿的 `@keyframes`（`check_tokens.py` 会报「死动画」）。
6. **加合成层提升**：给元素加 `transform: translateZ(0)` / `will-change: transform, opacity`，把它提到独立合成层，进一步降低主线程抖动的影响。
7. 跑四道守卫，再实测确认 `animationName` 变成了 `none`、外观与修复前一致。

> **用户明确要求过：修复闪烁时不得降低动画质量。** 保留原样的缓动、时长、位移距离，只删掉重复的那条曲线。不要用「把动画变短变弱」来糊弄。

**降级策略**：低性能设备的降级写在 `design-system.css` 的 `html[data-perf="low"]` 下。**注意这里的历史教训**——早期版本粗暴地写 `animation: none !important` 冻结全站动画，那是错的。正确做法是只降级「贵的部分」：

- 关掉 `backdrop-filter`（paint 属性，最贵）
- 关掉装饰性动画（`.ambient-orb`、`[class*="pulse"]`、`[class*="float"]`）
- **保留**加载指示器（`.spinner` / `.fa-spin`）—— 转圈停下会让人以为卡死
- 去掉纯装饰的 `filter: blur()`，保留 `transform`/`opacity` 过渡
- 缩短而非删除过渡时长

### 4.5 修改样式的硬约束

1. **共享实现只准有一份**，放在 `design-system.css`。页面内联 `<style>` 只写本页增量。
2. 页面内联 `<style>` **禁止**定义 `@keyframes`（守卫会拦）。
3. 新组件用 BEM 风格 `--` 双连字符：`.btn--primary`。旧的 `.btn-primary` 保留为兼容别名，**新代码不要再用**。
4. 动效统一用 Apple HIG 令牌，不要裸写数字：
   - 缓动：`--ease-apple` / `--ease-fluid` / `--ease-spring` / `--ease-press`
   - 时长：`--dur-fast`(.16s) / `--dur-base`(.24s) / `--dur-slow`(.34s) / `--dur-enter`(.5s)
5. 新增 CSS 变量必须在共享层声明，否则 `check_tokens.py` 报错。
6. 删掉某处的 `animation` 后，**记得同步删掉对应的 `@keyframes`**。

### 4.6 修改 `functions/` 的硬约束

1. **每一个用到的 import 都要真的 import 进来**，然后跑 `check_functions.py`。
2. 环境变量统一走 `functions/utils/env-config.js` 的读取层（`envValue` / `envHas`），不要直接 `env.XXX`——读取层处理了大小写别名（`ALIASES` map）。
3. 需要「后台可改、即时生效」的配置走 `functions/utils/runtime-config.js`，优先级 **KV 覆盖 > 环境变量**。
4. 新增配置项时，同时更新：`.env.example`、`README.md` 的变量清单、`docs/README-full-reference.md`。
5. 改了 API 行为/字段，同步更新 `docs/openapi.yaml`。

---

## 5. Git 操作与推送

### 5.1 远端与镜像

```bash
git remote -v
# origin  https://ghfast.top/https://github.com/<owner>/<repo>.git
```

**直接访问 GitHub 在本环境不可达**，必须走 `ghfast.top` 镜像。远端 URL 里已带镜像前缀。

> ⚠️ **镜像 URL 形态陷阱**：`ghfast.top` 必须用**完整 GitHub 路径**形态 `https://ghfast.top/https://github.com/<owner>/<repo>.git`（ls-remote / clone / push 均如此）。裸形态 `https://ghfast.top/<owner>/<repo>.git` 会直接返回 **403**，下一个 AI 容易在此浪费时间。本仓库已 clone，origin 已是正确完整形态，直接 `git remote -v` 取用即可，勿照抄占位符。

### 5.2 PAT 处理铁律

- **同一个 token 可在同一条对话内反复使用** —— 用户在单会话里多次给出同一串属正常情况，直接复用即可，不必每次都要求换新。
- **同一个 token 严禁跨对话使用** —— 一旦开启新对话或重新接手本项目，旧 token 即作废，必须请用户从 GitHub 重新生成一个全新的 PAT 再用。跨对话复用等于把已在上一会话明文出现过的令牌继续暴露，违反安全底线。
- **绝不**写进任何文件（包括 `.git/config`、脚本、文档、README）。
- **绝不**在回复正文里回显完整 token。
- **绝不**提交到 git 历史。
- 只在当次 `git push` 命令里以 `https://<PAT>@ghfast.top/...` 的形式瞬时使用。

### 5.3 推送命令

```bash
git push "https://<PAT>@ghfast.top/https://github.com/<owner>/<repo>.git" Pre
```

**推完必须验证远端真的同步了**：

```bash
git ls-remote "https://<PAT>@ghfast.top/https://github.com/<owner>/<repo>.git" Pre
# 输出的 SHA 必须等于本地 git rev-parse HEAD
```

### 5.4 提交前检查清单

```bash
git status --short                      # 应无未预期改动
python3 scripts/check_style.py          # 四道守卫
python3 scripts/check_tokens.py
python3 scripts/check_functions.py
python3 scripts/check_shared.py
# 再确认没有把 PAT / .env / 临时文件带进去
git diff --cached --stat
```

### 5.5 提交信息风格

本仓库用**中文 Conventional Commits**，动效/样式类改动要写清「消除了什么、保留了什么」：

```
fix(ui): 消除抽屉/弹窗浮层的闪烁 —— 去掉与过渡重复的 @keyframes
fix(api): 修复 /api/status 全量 500 —— status.js 漏 import isAuthRequired
refactor(ui): 抽出 design-system.css 作为单一事实来源，统一全站动画与组件
```

### 5.6 分支纪律

**只推 `Pre`，永不推 `main`。** `Pre` 是长期工作分支，是否合并由用户决定。

---

## 6. 事故复盘（给下一个 AI 的警报）

### 6.1 R2 永久显示「未配置」— `/api/status` 全量 500

**这是本仓库最有价值的一次教训。**

**症状**：用户绑好了 R2 且一直正常，某次改动之后 R2 突然显示「未配置 / 灰色」。用户明确反馈「我有绑 r2，之前都没问题，自从你之前交的 PR 之后就不行了」。

**错误反应**：一开始我假设是用户的 Cloudflare 配置问题。**这是错的。** 用户的直觉（「之前好的，代码改了之后坏的」）才是对的线索。

**真正根因**：`functions/api/status.js` 第 44 行调用了 `isAuthRequired(env)`，但该文件**从未 import 它**。未定义标识符直接抛 `ReferenceError` → `/api/status` 每次请求都返回 **HTTP 500** → 前端 `checkStorageTarget()` 走进 catch 分支 → `r2Available` 永远为 `false` → R2 永久显示未配置。

**引入方式**：提交 `e8150bb`（「安全修复: 匿名=管理员越权」）把 `const isAdmin = Boolean(auth?.authenticated);` 改成了加 `&& isAuthRequired(env)` 的形式，但没补 import。同一提交正确地在 `functions/upload.js` 和 `functions/api/upload-from-url.js` 里加了该 import —— **只漏了 `status.js`**。

**为什么长期没被发现**：`node --check` 只查语法不做标识符解析，通过；wrangler 本地 dev 也能正常启动。只有真正请求 `/api/status` 时才炸。

**修复两处**：

```js
import { checkAuthentication, isAuthRequired } from '../utils/auth.js';
```
```js
const isAdmin = isAuthRequired(env) ? Boolean(auth?.authenticated) : true;
```

**顺带修的第二个缺陷**：开放实例（未配 `BASIC_USER`/`BASIC_PASS`）上，原来的 `auth?.authenticated && isAuthRequired(env)` 会让 `isAdmin` **恒为 `false`**，连实例创建者都看不到 R2 真实状态。改成三元后，开放实例上 `isAdmin = true`；配了鉴权的实例上，匿名调用者依然只拿到脱敏状态、不触发探测 —— **安全语义不变**。

**留下的防线**：`scripts/check_functions.py`。

**给下一个 AI 的启示**：
- 用户说「以前好的，你改了之后坏的」时，**优先去查自己的 diff**，不要先怀疑用户的配置。
- 改了某个模式，要**全仓 grep 一遍**同类调用点，别只改触发问题的那一处。
- 前端有 try/catch 的地方，后端异常会被静默吞成「不可用」状态 —— 排查时先直接 `curl` 后端接口。

### 6.2 FontAwesome 图标全站消失

**症状**：用户反馈「现在没有图标」。

**根因**：在提交 `4323b92` 里，我把 `index.html` / `preview.html` 里 FontAwesome 的 `<link>` **替换**成了 `design-system.css` 的 `<link>`，而不是**追加**。图标库没被引入，全站图标变成方块。

**修复**：`510a458` 补回两个 `<link>`。

**留下的防线**：`check_style.py` 第 5 项检查 —— 每个页面必须引入本地 FontAwesome。

**启示**：做「插入引用」这类编辑时，**不要用替换语义**。改完 `grep` 确认两个 `<link>` 都在。

### 6.3 三类闪烁 —— 同一个 bug 类别的三个实例

**症状**：用户先后报告三处闪烁 —— ① toast 通知在低性能设备上频繁闪烁；② 存储节点抽屉里的文字切换组件闪烁；③ 抽屉浮层（红圈区域）闪烁。

**统一根因**：**两套曲线争夺同一个 `transform`/`opacity` 轨道**。GPU 空闲时相位接近看不出问题；低端设备一掉帧，两条曲线差值就显现。

| 位置 | 冲突的两条曲线 | 修复 |
| :--- | :--- | :--- |
| Toast | `.toast` 的 `animation: toastIn` + Vue `<transition name="toast">` | 删 `toastIn`，加合成层提升（`translateZ(0)` + `backface-visibility` + `will-change`） |
| 内联文字 `.label` / `.morph` | 用了 `filter: blur()` —— **paint 属性**，每帧重新栅格化；且 `.label-leave-active` **漏了 `filter` 的 transition**，导致离开时 blur 是「瞬间归零」而非渐变 | 收口进 `design-system.css`，加 `will-change` 与宿主提升，补齐缺失的 `filter` 过渡；**仅在低性能档位**去掉 blur |
| 抽屉/弹窗浮层（红圈） | `.modal-mask` 的 `animation: maskIn` **和** `.modal--sheet` 的 `animation: sheetIn`，各自叠加在 `<transition name="sheet">` 之上 —— 两条曲线同时把 `translate3d(0,100%,0)` 拉回 `0` | 删除 4 处 `animation` 声明（mask / sheet / dialog / preview），删除随之孤立的 `@keyframes sheetIn` / `dialogIn`，把起始值并入 transition 族 |

**关键手法**：修复时**保留原样的起始值、缓动、时长、节奏**，只删重复的那条曲线。`dialogIn` 原有的「60% 处透明度已到 1」的节奏，是通过**拆分时长**保留的（opacity 0.26s vs transform 0.44s），而不是改缓动。

**贡献因素**：抽屉区域还有两个叠加源 —— `paneItemIn` 在每个直接子元素上做错峰入场（`.settings-group` 就是一个），以及 `.settings-row` 自身的 0.12s transform 过渡。同一视觉区域里有多个 transform 在跑。排查这类问题要**看整个祖先链**。

**实测验证**（每处都是这个套路）：

```js
getComputedStyle(el).animationName   // 期望：sheetIn → none
getComputedStyle(el).willChange      // 期望：auto → transform, opacity
getComputedStyle(el).transform       // 期望：起始值与修复前完全一致
```

再加截图比对，确认外观零变化。

**启示**：
- 看到闪烁，**第一反应就是找「重复的动画」**，不是去调帧率或缩短时长。
- **`filter: blur` 用在会动的元素上是性能陷阱** —— 它是 paint 属性。
- 排查时**必须枚举祖先链**，元凶经常不在元素自己身上。
- **用户说了不许降画质，就是真的不许。** 保留原本的动效质感，只删冗余。

---

## 7. 给下一个 AI 的工作流

```
收到需求
   │
   ├─ 涉及样式/动效？ → 先读 design-system.css 相关段 + 页面内联 <style>
   ├─ 涉及后端？      → 先读 functions/ 对应文件 + utils/env-config.js
   │
   ▼
改代码（遵守第 4 节的硬约束）
   │
   ▼
本地起 wrangler dev（带 KV + R2 绑定）
   │
   ├─ 后端改动 → curl 端到端验证（含真实上传/回读）
   ├─ 前端改动 → agent-browser 看渲染 + 量 getComputedStyle + 截图
   │
   ▼
四道守卫全过
   │
   ▼
git push 到 Pre（用 PAT，走 ghfast.top 镜像）
   │
   ▼
git ls-remote 验证远端 SHA == 本地 HEAD
   │
   ▼
向用户汇报：根因 / 修复 / 验证证据 / 产物路径
```

**汇报时要说清**：
- **根因是什么**（不是「我改了什么」，而是「为什么之前是坏的」）
- **怎么证明的**（回退对照、实测数值、截图）
- **有没有降低原有质量**（用户明确关心这点）
- **改动落在哪些文件/提交**

---

## 8. 快速参考

| 我要… | 命令 / 位置 |
| :--- | :--- |
| 本地起全栈 | `npx wrangler pages dev ./ --kv "img_url" --r2=R2_BUCKET --compatibility-date=2026-05-03 --port 8099 --persist-to /tmp/kvdata --binding BASIC_USER=admin --binding BASIC_PASS=123` |
| 跑守卫 | `python3 scripts/check_style.py && python3 scripts/check_tokens.py && python3 scripts/check_functions.py && python3 scripts/check_shared.py` |
| 8 页冒烟（运行时） | `node scripts/verify/smoke.mjs`（先起 `python3 -m http.server 8788`） |
| **8 页冒烟** | `node scripts/verify/smoke.mjs` |
| **删 CSS 前查选择器是否真死** | `node scripts/verify/dead-selectors.mjs .xxx .yyy` |
| **上收类渲染验证** | `node scripts/verify/verify_classes.mjs` |
| **每页主题开关盘点** | `node scripts/verify/audit-theme-toggle.mjs` |
| **具体视觉元素冒烟** | `node scripts/verify/visual-check.mjs` |
| **重构前后证明零差异** | `node scripts/verify/visual-snapshot.mjs a.json` → 改 → `... b.json` → `node scripts/verify/visual-diff.mjs a.json b.json` |
| 查跨页是否还各写各的 | `python3 scripts/check_shared.py` |
| 加一个跨页能力 | 写进 `app-core.js` → 挂 `window.KVault` → 各页调用点切过去 |
| 加一个共享组件 | 写进 `design-system.css` → 页面只留尺寸/布局增量 |
| 校验后端符号 | `python3 scripts/check_functions.py` |
| 生成/校验 wrangler 配置 | `npm run pages:r2:doctor` / `node scripts/cloudflare-pages-r2-doctor.js --check` |
| 看设计令牌 | `design-system.css` 顶部 `:root` |
| 看环境变量别名 | `functions/utils/env-config.js` 的 `ALIASES` |
| 看运行时配置分组 | `functions/utils/runtime-config.js` 的 `GROUPS` |
| 看鉴权语义 | `functions/utils/auth.js` 的 `isAuthRequired` |
| 推代码 | `git push "https://<PAT>@ghfast.top/https://github.com/<owner>/<repo>.git" Pre` |
| 验证推送 | `git ls-remote "https://<PAT>@ghfast.top/https://github.com/<owner>/<repo>.git" Pre` |
| 还原浏览器 | `agent-browser close --all && rm -rf /tmp/org.chromium.Chromium.*` |
| 看变量清单 | `.env.example` |
| 看完整配置参考 | `docs/README-full-reference.md` |
| 看 API 定义 | `docs/openapi.yaml` |

---

## 9. 铁律汇总

1. **只推 `Pre`，永不推 `main`。**
2. **PAT 不落盘、不回显、不提交；同一 token 可在单对话内复用，但严禁跨对话使用（新对话须换新 token）。**
3. **改完必跑四道守卫。**
4. **改 `functions/` 必跑 `check_functions.py`** —— 它是唯一能拦住「漏 import」的东西。
5. **共享样式只准有一份**，在 `design-system.css`；页面内联禁止 `@keyframes`。
6. **跨页能力只准有一份**，在 `app-core.js`（`window.KVault`）。
   页面里再写一份 `formatBytes` / 复制 / toast = 漂移起点，`check_shared.py` 会拦。
7. **页面内联 `<style>` 只写「共享层没有的属性」**。
   若写的是共享层已有的同名属性，那就是在覆盖共享组件 —— 改共享层，别改页面。
8. **修闪烁不许降低动画质量** —— 删冗余曲线，保留原动效参数。
9. **`transform`/`opacity` 是合成属性，`filter`/`backdrop-filter` 是绘制属性** —— 别在会动的元素上用后者。
10. **排查闪烁要枚举祖先链**，元凶常在祖先上。
11. **用户说「你改之前是好的」时，先查自己的 diff。**
12. **验证要端到端** —— `curl` 真实接口、跑真实上传、量真实计算样式，不要只看改了没改。
13. **删 CSS 之前先跑 `dead-selectors.mjs`** —— 判死要「静态精确匹配 + 运行时计数」两条都过，
    不能靠 grep。此次清理就因漏了这步误删过 `.header-title`。
14. **「0 差异」必须先自证工具是活的** —— 往页面里注入一个必然生效的改动
    （如 `.card{border-radius:7px!important}`），确认比对**能检出**，再相信它的「0 差异」。
    本次 `getPropertyValue('borderRadius')` 静默返回空串，导致比对永远显示 0 差异，
    差点把一个假阴性当成交付证据。
15. **验证脚本要留在仓库里，不要写 `/tmp`** —— 一次性脚本下次还得重写，
    而且过程中攒下的经验（坑、判据）会一起丢掉。现在的归宿是 `scripts/verify/`。
16. **`grid-template-rows: 0fr↔1fr` 收起动画必须有「纯包裹层」** —— 直接子元素若是带 `padding`/`border` 的卡片，
    轨道永远收不到 0（实测卡在 ~50px）。结构必须是 `<div class="collapse"><div class="collapse__inner">…面板…</div></div>`，
    `overflow:hidden; min-height:0` 落在 `.collapse__inner` 上，被裁切到 0 的是这层纯 div。已沉淀为共享层 `collapse` 过渡（见 `design-system.css`）。
17. **镜像 URL 用完整 GitHub 路径形态**，裸 `ghfast.top/<owner>/<repo>` 会 403（见 §5.1）。
18. **grid 收起容器必须给子项 `min-width:0`** —— grid 子项默认 `min-width:auto`，
    行内容（长文件名 + 按钮组）的 min-content 会把轨道撑出视口，整页横向溢出
    （真机截图：交付结果卡片、「清空」、底部导航全被截出右边界）。已修：
    `.collapse > * { min-height:0; min-width:0 }`。验证脚本 `scripts/verify/overflow-x.mjs`；
    该脚本测量时**别开 Playwright `isMobile:true`** —— Chrome 会自动撑宽布局视口
    去容纳超宽内容，溢出全部漏检（见 `scripts/verify/README.md`）。
19. **共享层新增工具类，必须显式覆盖同优先级的页面内联样式** —— 页面内联 `<style>`
    在 `@import design-system.css` **之后**，同特异性时页面内联胜出。给 `.dock` 之类
    既打 `.glass`、又指望共享层 `.card` 规则生效时，若页面内联也写了
    `backdrop-filter`，最终生效的是**页面那份**（实测 dock 的 `blur(28px)` 压过
    共享层）。做法：把页面内联的参数改成令牌（`blur(var(--glass-blur))`）或直接
    删掉重复声明，别假设共享层能盖过去。
20. **入场动画只动 `transform`/`opacity`，禁用 `filter: blur()`** —— blur 是绘制属性，
    每帧重生成位图；且与 `backdrop-filter` + `overflow:hidden`（`collapse` 动画期）
    同框会在 iOS Safari 闪烁。本轮已把 `.pane-*`/`.view-*`/`.label-*`/`.morph-*`
    入场里的 `filter: blur()` 全部移除，`will-change` 同步收窄为 `transform, opacity`。
21. **液态玻璃用 vendored 库（glassfx @ `/vendor/glassfx`），运行时零 CDN** ——
    CSS 走 `@import`（须在所有规则之前），JS 由 `app-core.js` 在 DOM 就绪后
    `import()`（失败静默跳过，frosted 兜底）。给元素加 `.glass` 即得 rim + 光标 bloom
    +（Chromium）真实折射；页面内联的背景/边框/阴影会按源顺序覆盖它的默认外观，
    故**只取增强、不改既有设计**。验证脚本 `scripts/verify/glass-fx.mjs`。
