# K-Vault-Next 项目介绍

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

- **形态**：仓库根目录的单文件 HTML（内联 CSS/JS），无构建步骤
- **设计系统**：`design-system.css` 是全站唯一的事实来源——设计令牌、通用组件（`.card` / `.btn` / `.input` / `.switch` / `.spinner` / `.toast` / `.empty-state` …）、37 个动效关键帧、Vue 过渡族
- **页面级 `<style>` 只允许写本页增量**，不允许重复定义共享实现
- **守卫脚本**：`scripts/check_style.py`（括号平衡 / 禁止页面内定义 `@keyframes` / 必须引入设计系统）、`scripts/check_tokens.py`（校验 `var(--x)` 与 animation 名称可解析）
- **页面**：`/`、`/admin.html`、`/share.html`、`/paste.html`、`/gallery.html`、`/preview.html`、`/webdav.html`、`/login.html`

### 2. 后端

Cloudflare Pages Functions（`functions/`），无 Node 服务器、无 Docker：

| 路径 | 职责 |
| :--- | :--- |
| `functions/api/auth/` | 登录 / 会话 / 登出 |
| `functions/api/manage/` | 文件与目录管理、分享管理、运行时配置 |
| `functions/api/admin/` | API Token 管理、用量监控 |
| `functions/api/v1/` | 对外 API v1（Token 鉴权、scope、策略） |
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
| KV | **`img_url`** | 文件元数据、会话、Token、分片任务、运行时配置 | ✅ |
| R2 | **`R2_BUCKET`** | 对象存储，唯一支持原生分片的后端 | 强烈推荐 |

两者都是 **Pages 绑定**（Settings → Functions），**不是环境变量**。名称写错整个项目跑不起来。

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
| 后台配置（guest / cors / upload） | `/admin.html` → 设置面板 | ❌ 不要，即时生效 |

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

完整步骤见 [README.md](README.md)。

---

## 安全设计

- **管理面 fail-closed**：未配置管理员账密时，管理接口直接 503，不对公网开放
- **统一限流**与**登录暴力破解防护**
- **响应脱敏**：异常堆栈不回传客户端
- **SSRF 防护**：URL 转存前校验目标地址
- **依赖本地化**：第三方前端资源放进 `vendor/`，不依赖外部 CDN
- **无遥测**：不内置任何上报
