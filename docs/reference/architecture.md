# K-Vault-Next 项目介绍与技术架构

> 本篇回答「这个项目**是什么**、**为什么这么设计**」。
> 要动手部署请看 [`../../README.md`](../../README.md)，要按主题找文档请看 [`../README.md`](../README.md)。

## 项目定位

K-Vault-Next 是一个跑在 **Cloudflare Pages** 上的 Serverless 云盘 / 图床：文件存进你选的存储后端，元数据写进 Cloudflare KV，对外提供直链、预览、目录管理、分享控制、文本粘贴与机器可调用的 API。

本仓库派生自 [katelya77/K-Vault](https://github.com/katelya77/K-Vault)。**定位上的关键取舍是：只保留 Cloudflare Pages 一种部署形态。** 上游的 Docker 自托管路线被完整移除，省下来的复杂度换成了 Pages 这条路本身的深度——前端统一、鉴权加固、分片上传升级、分享体系重构。

如果你需要「一台 VPS 上跑起来、后端随便换、配置存 Redis」，请直接使用上游的 Docker 版本；本仓库不做这件事。

---

## 与上游 katelya77/K-Vault 的区别

### 形态差异

| 维度 | katelya77/K-Vault | K-Vault-Next |
| :--- | :--- | :--- |
| 部署形态 | Cloudflare Pages + Docker 单镜像 | **仅 Cloudflare Pages** |
| 运行时依赖 | Sentry 等 | **零运行时依赖** |
| 遥测 | 内置 Sentry，`disable_telemetry` 关闭 | **无任何遥测代码** |
| 页面数量 | 6 | **8**（新增 `/paste.html`、`/share.html`） |
| 前端样式 | 各页面各写一份 | **`design-system.css` 单一事实来源** |
| 配置生效 | 改环境变量 → 重新部署 | 三组高频配置**后台可改，即时生效** |
| 环境变量写法 | 大小写两套名字，需「两个都写上」 | **统一读取层，任意写法都识别** |

### 移除的部分

- **Docker / 自托管整条链路**：`server/` Node 运行时、`docker-compose.yml`、`Dockerfile`、`README-DOCKER.md`、GHCR 镜像构建与配套服务端测试。
- **Docker 专属环境变量**：`DATA_DIR`、`DB_PATH`、`CHUNK_DIR`、`PORT`、`WEB_PORT`、`CONFIG_ENCRYPTION_KEY`、`SESSION_SECRET`、`SETTINGS_STORE`、`SETTINGS_REDIS_*`、`UPLOAD_MAX_SIZE`、`UPLOAD_SMALL_FILE_THRESHOLD`、`CHUNK_SIZE`、`DEFAULT_STORAGE_TYPE`。
- **Sentry 遥测**及其开关 `disable_telemetry`。
- **内容审核**（`ModerateContentApiKey`）与**黑白名单**（`WhiteList_Mode`）。
- **旧前端产物** `frontend/`（Vite/Vue）与 `_nuxt/`。

### 增强的部分

| 方向 | 变化 |
| :--- | :--- |
| 前端统一 | `design-system.css`：令牌、组件、37 个关键帧、Vue 过渡族全站唯一来源 |
| 动效与无障碍 | Apple HIG 缓动/时长令牌、首屏错峰入场；`prefers-reduced-motion` / `prefers-reduced-transparency` / `html[data-perf="low"]` 分级降级 |
| 环境变量 | `functions/utils/env-config.js` 统一读取层，大小写与历史别名自动兼容 |
| 运行时配置 | `config:guest` / `config:cors` / `config:upload` 存 KV，后台改即时生效 |
| 分片上传 | R2 原生 multipart，单文件上限 100MB → **10GB** |
| 路由 | `functions/file/[[path]].js` 支持任意层级路径 |
| 分享体系 | `/s/:slug` → `/share.html` 落地页；有效期 / 密码 / 次数 / 自定义 slug；后台分享管理面板 |
| 文本粘贴 | 新增 `/paste.html` 与 `paste` scope |
| 管理后台 | 目录树、收藏、重命名、批量移动、KV/R2 用量监控、Token 策略 |
| 上传调度 | 智能节点选择 + 可开关的并行上传（Telegram 池与分片池分离） |
| 安全 | 管理面 fail-closed、统一限流、登录暴力破解防护、堆栈脱敏、URL 导入 SSRF 防护、依赖本地化 |
| 文档 | `docs/openapi.yaml`、`docs/agent-integration.md` |

### 上传限制对比

| 后端 | 上游 | 本项目 | 说明 |
| :--- | :--- | :--- | :--- |
| Telegram（Pages） | 20MB | 20MB | 一致 |
| Cloudflare R2 | 100MB | **10GB** | 改用 R2 原生 multipart |
| S3 兼容 | 100MB | 40MB | 未实现分片，Worker 内存拼装 |
| WebDAV / GitHub | 未标注 | 40MB | Worker 内存拼装 |
| HuggingFace | 35MB / 50GB（LFS） | 35MB | 未接入 LFS 路径 |
| Discord | 25MB / 50–100MB（L2+） | 25MB | 取保守值 |

> 本项目并非全面更强：R2 大幅提升，S3 / WebDAV / GitHub 因为没有分片路径反而低于上游标注值。

---

## 技术架构

### 1. 前端

- **形态**：8 个页面入口（根目录 HTML）+ `assets/` 共享层，**无构建步骤**。页面的 CSS / JS 已外置到 `assets/css/` 与 `assets/js/`，页面本身只保留「本页增量」——少量内联 `<style>` 与本页脚本
- **设计系统**：`design-system.css` 是全站唯一的事实来源——设计令牌、通用组件（`.card` / `.btn` / `.input` / `.switch` / `.spinner` / `.toast` / `.empty-state` …）、37 个动效关键帧、Vue 过渡族
- **共享 JS**：`app-core.js`（挂在 `window.KVault`）—— `formatBytes` / `toast` / `copy` / `fetchJSON` / `formatTime` 各只有这一份实现
- **页面级样式只允许写本页增量**，不允许重复定义共享实现
- **守卫脚本**：`scripts/check_style.py`（括号平衡 / 禁止页面内定义 `@keyframes` / 必须引入设计系统）、`scripts/check_tokens.py`（`var(--x)` 与 animation 名可解析，含外置 CSS 与 JS 动态注入的变量）、`scripts/check_styles.py`（从模板反查样式）、`scripts/check_shared.py`（跨页共享层一致性，防「一次改动只生效一页」）。四道守卫 + 模板编译已串进 `npm run check`
- **页面**：`/`、`/admin.html`（分区路径 `/admin/files|shares|storage|system`）、`/share.html`、`/paste.html`、`/gallery.html`、`/preview.html`、`/webdav.html`、`/login.html`

### 2. 后端

Cloudflare Pages Functions（`functions/`），无 Node 服务器、无 Docker：

| 路径 | 职责 |
| :--- | :--- |
| `functions/api/auth/` | 登录 / 会话 / 登出 |
| `functions/api/manage/` | 文件与目录管理、分享管理、运行时配置 |
| `functions/api/admin/` | API Token 管理、用量监控 |
| `functions/api/v1/` | 对外 API v1（Token 鉴权、scope、策略） |
| `functions/mcp/` | MCP 端点（JSON-RPC 2.0 / Streamable HTTP，零 SDK 依赖） |

### 2.1 MCP 端点：传输与鉴权分层

`functions/mcp/` 原生实现了 MCP，**不引入任何运行时依赖**——`protocol.js` 手写 JSON-RPC 2.0 信封，`tools.js` 声明工具，`handlers.js` 把工具调用翻译成对 `api/v1` handler 的内部调用（合成 Request + 透传 context），因此策略、幂等、去重、审计全部继承，不存在第二份业务实现。

三处关键设计：

- **无状态**：不分配 `Mcp-Session-Id`。Pages Functions 无常驻进程，维护会话需落 KV 并每请求回读；MCP 规范明确允许服务端不分配会话。代价是不提供 SSE（`GET /mcp` → 405）与取消通知，收益是零额外存储开销且天然吻合 Serverless 模型。
- **鉴权分三层，且粒度按方法而非按连接**：L1（`mcp/_middleware.js`）校验 Token 有效性并注入 `context.data.apiToken` → L2 per-token 限流 → L3（`tools.js`）按**工具**声明的 scope 二次校验。MCP 是单一入口，工具名在 POST body 里，HTTP 层无从推导所需 scope，因此不能照搬 v1 的「按路径推 scope」。
- **握手方法免鉴权**：`initialize` / `ping` / `notifications/*` 不要求 Token，`tools/list` 与 `tools/call` 强制鉴权。之所以不在 HTTP 层一刀切，是因为主流 MCP 客户端在 `initialize` 阶段尚未发送 `Authorization`，握手即 401 会让客户端在拿到 `capabilities` 之前就断开。为保证不泄露信息，匿名 `initialize` 返回的 `capabilities` 为空对象且不含 `instructions`——工具清单只在带 Token 时才可见。实现上中间件**不解析 body**（读流会消费掉 `request.body`），而是「有 Token 就校验注入、无 Token 则裸放行不注入」，由路由层按 method 决定是否拒绝。
- **错误分三层**：传输鉴权失败走 HTTP 401/403；JSON-RPC 协议错误走 HTTP **200** + `error` 信封（JSON-RPC over HTTP 的约定）；工具业务失败走 HTTP **200** + `result.isError=true`。因此**判断工具是否成功必须看 `result.isError`，不能只看状态码**。

端点默认关闭（`MCP_ENABLED`），未开启时返回 404 —— 与「管理面 fail-closed」同一思路：新增网络面不因「部署时忘了配」而自动敞开。
| `functions/mcp/` | MCP 端点（JSON-RPC 2.0 / Streamable HTTP，零 SDK 依赖） |
| `functions/api/chunked-upload/` | 分片上传 init / chunk / complete |
| `functions/api/share-info.js` | 分享页只读信息（公开） |
| `functions/api/status.js` | 后端连通性与配置状态 |
| `functions/api/upload-from-url.js` | URL 转存（带 SSRF 防护） |
| `functions/api/telegram/webhook.js` | Telegram Webhook 回链 |
| `functions/file/[[path]].js` | 文件直链（多层路径、密码） |
| `functions/file-info/[[path]].js` | 文件元信息 |
| `functions/s/[slug].js` | 短分享链 → 302 到 `/share.html` |
| `functions/utils/` | 存储适配器与公共工具 |

两个关键工具模块：

- **`utils/env-config.js`** —— 环境变量统一读取层。为 `TG_BOT_TOKEN`、`TG_CHAT_ID`、`TG_UPLOAD_NOTIFY`、`TELEGRAM_WEBHOOK_SECRET`、`FILE_URL_SECRET`、`WEBDAV_BEARER_TOKEN` 声明可接受的写法列表，取第一个非空值，于是大小写与历史别名都能识别，部署时填一次即可。
- **`utils/runtime-config.js`** —— 「KV 覆盖 > 环境变量」的运行时配置。guest / cors / upload 三组存为 `config:<group>`，后台保存后即时生效，环境变量退化为基线值；后台可重置回基线。

### 3. 数据层

| 绑定 | 名称 | 用途 | 必需 |
| :--- | :--- | :--- | :---: |
| KV | **`img_url`** | 会话、Token、分片任务、运行时配置；未绑 D1 时的文件元数据 | ✅ |
| R2 | **`R2_BUCKET`** | 对象存储，唯一支持原生分片的后端 | 强烈推荐 |
| D1 | **`DB`** | 文件元数据、文件夹标记、合集分享、API Token、粘贴、审计日志、Airdrop | 可选 |

三者都是 **Pages 绑定**（Settings → Functions），**不是环境变量**。名称写错整个项目跑不起来。

**D1 是渐进启用的**：代码层走「D1 优先 / KV 兜底」双路径，**不绑 D1 时行为与接入前完全一致**，所以可以先合代码、后建库，不存在「必须同时切」的压力。

- **建表是自动的**：运行时首次访问 D1 触发懒迁移（`functions/utils/schema.js` 的 `ensureSchema()`），按 `schema_migrations` 记账依次补齐，同 isolate 内只跑一次。DDL 的唯一真源是 `schema.js` 里的 JS 常量——Workers 没有文件系统，读不到 `.sql`；`migrations/*.sql` 只是 `scripts/gen-migrations.py` 生成的副本，**不要手改**（会被覆盖）
- **建库只能靠 CLI**：`bash scripts/setup-d1.sh`（Cloudflare 没有「部署时建库」的 API）。它会建库并把 `database_id` 回填进 `wrangler.toml`，这是全流程唯一需要动手的地方
- 上线与灰度验证的完整清单见 [`guides/d1-migration-checklist.md`](../guides/d1-migration-checklist.md)

### 4. 存储后端

Telegram（默认）、Cloudflare R2、S3 兼容、Discord、HuggingFace、WebDAV、GitHub，共七种，通过同一个上传入口切换。指定后端未配置时回落 Telegram；**变量缺失不会静默降级到其他后端**，而是直接报错。

---

## 部署

### 唯一受支持的方式：Cloudflare Pages

构建设置必须**全部留空**（Framework preset 选 `None`，Build command / Build output directory 留空）。根目录就是静态页 + `functions/`，填构建命令反而会部署失败。

不提供 Docker / Nginx 自托管路径，也不再使用 `frontend/dist`、`frontend/landing`、`_nuxt` 作为部署入口。

### 环境变量的三层配置

| 类型 | 配置位置 | 改完是否需重新部署 |
| :--- | :--- | :---: |
| 绑定（KV / R2） | Settings → **Functions** | ✅ 要 |
| 环境变量 | Settings → **Environment variables** | ✅ 要 |
| 后台配置（guest / cors / upload） | `/admin/storage` → 设置面板 | ❌ 不要，即时生效 |

三个最常见的问题：

1. 把绑定当环境变量填（在 Environment variables 里填 `img_url` 是无效的）
2. 改完没重新部署（必须 Retry deployment 或推送新提交）
3. 以为 Pages 会读 `.env`（不会；`.env.example` 只是清单。本地 `wrangler` 才读 `.env`）

### 最小部署集

1. 绑定 KV，变量名 **`img_url`**
2. 绑定 R2，变量名 **`R2_BUCKET`**
3. `BASIC_USER`
4. `BASIC_PASS`
5. 一个存储后端的凭据（推荐 `TG_Bot_Token` + `TG_Chat_ID`）
6. 若绑了 R2：配两条生命周期规则清理 `chunk-upload/` 与未完成的分片

> **公网部署必须设 `BASIC_USER` 与 `BASIC_PASS`**，否则管理接口一律 `503 ADMIN_AUTH_NOT_CONFIGURED`（fail-closed）。

完整步骤见 [README.md](../../README.md)。

---

## 安全设计

- **管理面 fail-closed**：未配置管理员账密时，管理接口直接 503，不对公网开放
- **统一限流**与**登录暴力破解防护**
- **响应脱敏**：异常堆栈不回传客户端
- **SSRF 防护**：URL 转存前校验目标地址
- **依赖本地化**：第三方前端资源放进 `vendor/`，不依赖外部 CDN
- **无遥测**：不内置任何上报
