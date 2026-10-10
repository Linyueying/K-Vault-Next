<div align="center">

<img src="assets/img/logo.png" alt="K-Vault-Next Logo" width="140">

# K-Vault-Next

## 一个跑在 Cloudflare Pages 上的 Serverless 云盘 / 图床 —— 零服务器、零构建、零运行时依赖

[![Deploy to Cloudflare Pages](https://img.shields.io/badge/Deploy-Cloudflare%20Pages-F38020?logo=cloudflare&logoColor=white)](#-部署5-步上线)
![Runtime Dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen)
![Storage Backends](https://img.shields.io/badge/storage%20backends-7-blue)
![Max File Size](https://img.shields.io/badge/single%20file-up%20to%2010GB-orange)
![License](https://img.shields.io/badge/license-CC0%201.0-lightgrey)

**中文** | [English](README-EN.md)

</div>

> **白嫖 Cloudflare 免费额度，部署一个属于你自己的云盘。** 不用买 VPS、不用开 Docker、不用管运维。Fork 一下，绑两个资源，5 分钟上线。

---

## 为什么你该部署一个 K-Vault-Next

| | |
| :--- | :--- |
| **零成本** | 完全跑在 Cloudflare 免费额度内：Pages 托管、KV 元数据、R2 存储、D1 数据库、Functions 计算。不花一分钱。 |
| **零运维** | 没有服务器、没有 Docker、没有 Nginx、没有数据库要养。没有构建步骤，`git push` 即部署。 |
| **零运行时依赖** | 运行时代码只有标准 Web API。没有 npm 生产依赖，没有 CVE 需要追。唯一的依赖是 `wrangler`（开发用）。 |
| **七种存储后端** | Telegram、R2、S3 兼容、Discord、HuggingFace、WebDAV、GitHub —— 你手头有什么就用什么。 |
| **单文件最高 10GB** | R2 原生 multipart 分片上传，大文件不虚。 |
| **自带隔空投送** | 点对点临时传输：8 位连接码 / 二维码配对，传完即焚，像 AirDrop 一样传文件。 |
| **安全默认** | 管理面 fail-closed、SSRF 防护、统一限流、暴力破解防护、堆栈脱敏、源码不泄露。 |
| **为机器而生** | 完整 REST API v1 + 细粒度 Token 策略 + OpenAPI 定义 + Agent 接入指南。 |

---

## 🎯 功能一览

### 上传 —— 怎么顺手怎么来

- **拖拽 / 粘贴 / 批量上传** —— 把文件拖进页面就行，支持多选
- **URL 转存** —— 贴一个网址，服务器替你抓下来存好（带 SSRF 防护）
- **分片上传** —— R2 原生 multipart，单文件最高 **10GB**
- **智能节点选择** —— 超过阈值自动切换存储后端，还能开启并行上传（Telegram 池与分片池分离）
- **上传目录树** —— 上传时直接指定落地目录，不用事后搬
- **上传历史** —— 本地上传记录，随时找回直链
- **多种链接格式** —— 直链 / Markdown / HTML / BBCode 一键复制
- **按条目配置分享** —— 每个文件单独配自己的分享策略

### 管理后台 —— 一个正经的云盘该有的样子

- **目录树** —— 任意层级文件夹，批量移动、重命名、删除
- **收藏** —— 把常用文件钉起来
- **用量监控** —— KV / R2 实时用量一目了然
- **API Token 管理** —— 发牌、轮换、吊销，带策略
- **分享管理** —— 所有已分享条目汇总面板：有效期、剩余时长、已用/总次数、密码状态，可筛选、搜索、复制、取消
- **运行时配置** —— 访客上传、CORS、分片后端、WebDAV 服务端，**改完即时生效，不用重新部署**
- **分区路径** —— `/admin/files`、`/admin/shares`、`/admin/storage`、`/admin/system`

### 分享体系 —— 不只是个直链

- **分享落地页** —— `/s/:slug` 跳到落地页，给人看的，不是裸文件流
- **密码保护** —— 给敏感文件加道门
- **有效期** —— 到点自动失效
- **下载次数上限** —— 传够 N 次就关门
- **自定义短链** —— 用你想要的 slug
- **预览不计次** —— 只有点「下载」才消耗次数，爬虫和预览不背锅
- **失效原因明确** —— 过期 / 次数用尽 / 密码错，各给各的提示，不甩一句「链接无效」

### 文本粘贴 —— 分享代码和文本的另一条路

- `/paste.html` 创建 / 列表 / 查看 / 删除 Paste
- 带语言标记
- 支持有效期与访问密码
- 独立的 `paste` scope，可单独授权给某个 Token

### 隔空投送（Airdrop）—— 传完即焚的临时通道

> 给两台设备之间开一个**临时、私密、用完即删**的传输房间。像 AirDrop，但跨网络、跨平台。

```text
发端创建房间 ──▶ 生成 8 位连接码 + 二维码
     │
     ▼
收端扫码/输码加入 ──▶ 双方配对（linked）
     │
     ▼
发端逐文件上传 ──▶ 中转节点（R2 / Telegram）
     │
     ▼
收端逐文件下载 ──▶ 全部取走 ──▶ 临时文件立即删除
```

- **8 位连接码** —— 去掉了 `0/O`、`1/I/L` 等易混字符，方便口述和手打
- **二维码扫码配对** —— 手机扫一下就连上
- **192 bit 收端凭证** —— 连接码只负责「找到房间」，凭证才负责「证明你是那个人」。光看到二维码截不到文件
- **单收端锁定** —— 一个房间只允许一个接收方，先到先得
- **文件名延迟揭示** —— 文件全部落地前，收端看不到任何文件名（隐私）
- **TTL 从建房起算** —— 默认 5 分钟，超时房间立即失效，两端停止轮询（省 D1 读量）
- **交付宽限期** —— 发端已交付、收端正在下载时，过期给额外窗口，避免下到一半被清空
- **传完即焚** —— 收端取完全部文件，中转节点上的临时文件立即删除
- **使用统计** —— 后台可看投递次数、成功率、访客占比、活跃房间数

### 还有这些

- **图片画廊** `/gallery.html` —— 浏览、搜索、批量复制直链 / 下载 / 删除
- **多格式预览** `/preview.html` —— 加密文件会弹密码框
- **WebDAV 服务端** `/webdav.html` —— 把本站挂载成网络硬盘（详见下文）

---

## 🧱 架构

### 一句话

**Cloudflare Pages 前端静态页 + `functions/` 下的 Pages Functions 后端 + 三个 Cloudflare 原生绑定（KV / R2 / D1）。** 请求进来，文件写进存储后端，元数据写进 KV 或 D1，完事。

```text
                    ┌──────────────────────────────────────────────┐
                    │           Cloudflare Pages (边缘)             │
                    │                                              │
   浏览器 / Agent ──▶│  静态页面 (8 个 HTML)  +  functions/ 路由    │
                    │         │                    │               │
                    │         │                    ├── /api/v1/**   │  REST API
                    │         │                    ├── /mcp         │  MCP 端点
                    │         │                    ├── /file/**    │  文件直链
                    │         │                    ├── /dav/**     │  WebDAV 服务端
                    │         │                    ├── /s/:slug    │  分享短链
                    │         │                    └── /upload      │
                    └─────────┼────────────────────┼───────────────┘
                              │                    │
              ┌───────────────┴────────┬───────────┴───────────┬──────────────┐
              ▼                        ▼                       ▼              ▼
        ┌──────────┐            ┌──────────┐           ┌──────────┐   ┌──────────┐
        │    KV    │            │    R2    │           │    D1    │   │  存储后端 │
        │  img_url │            │R2_BUCKET │           │    DB    │   │ 七选一    │
        ├──────────┤            ├──────────┤           ├──────────┤   ├──────────┤
        │ 会话     │            │ 对象存储 │           │ 文件元数据│   │ Telegram │
        │ Token    │            │ 原生分片 │           │ 文件夹标记│   │ R2       │
        │ 分片任务 │            │ 10GB     │           │ 分享合集 │   │ S3       │
        │ 运行时配置│            │          │           │ Token    │   │ Discord  │
        │ (必需)   │            │(强烈推荐)│           │ 粘贴/审计│   │ HF/GH/DAV│
        └──────────┘            └──────────┘           │ Airdrop  │   └──────────┘
                                                        │ (可选)   │
                                                        └──────────┘
```

### 前端

- **8 个页面入口**（根目录 HTML）+ `assets/` 共享层，**无构建步骤**
- **`design-system.css` 是全站唯一事实来源** —— 设计令牌、通用组件、**37 个动效关键帧**、Vue 过渡族
- **`app-core.js`** 挂在 `window.KVault`，`formatBytes` / `toast` / `copy` / `fetchJSON` 全站只有一份实现
- **Apple HIG 动效体系** —— 缓动 / 时长令牌、首屏错峰入场
- **无障碍分级降级** —— `prefers-reduced-motion`、`prefers-reduced-transparency`、`html[data-perf="low"]`
- **四道守卫脚本 + 模板编译** 串进 `npm run check`，防止「一次改动只生效一页」

### 后端

Cloudflare Pages Functions（`functions/`），**无 Node 服务器、无 Docker**。文件路径字面即 API 路由。

| 路径 | 职责 |
| :--- | :--- |
| `functions/api/auth/` | 登录 / 会话 / 登出 |
| `functions/api/manage/` | 文件与目录管理、分享管理、运行时配置 |
| `functions/api/admin/` | API Token 管理、用量监控 |
| `functions/api/v1/` | 对外 REST API v1（Token 鉴权、scope、策略） |
| `functions/mcp/` | MCP 端点（JSON-RPC 2.0 / Streamable HTTP，无第三方 SDK） |
| `functions/api/chunked-upload/` | 分片上传 init / chunk / complete |
| `functions/api/airdrop/` | 隔空投送房间与文件周转 |
| `functions/api/telegram/webhook.js` | Telegram Webhook 回链 |
| `functions/api/upload-from-url.js` | URL 转存（带 SSRF 防护） |
| `functions/file/[[path]].js` | 文件直链（**任意层级路径**、密码） |
| `functions/dav/[[path]].js` | WebDAV 服务端 |
| `functions/s/[slug].js` | 分享短链 → 302 到落地页 |
| `functions/utils/` | 存储适配器与公共工具 |

**两个关键模块：**

- **`utils/env-config.js`** —— 环境变量统一读取层。为每个逻辑变量声明可接受的写法（`TG_Bot_Token` / `TG_BOT_TOKEN`…），取第一个非空值。**填一次就行，大小写随便你。**
- **`utils/runtime-config.js`** —— 「KV 覆盖 > 环境变量」运行时配置。高频开关存进 KV，后台改完**即时生效**，环境变量降级为基线值。

### 数据层

| 绑定 | 名称 | 用途 | 必需 |
| :--- | :--- | :--- | :---: |
| **KV** | **`img_url`** | 会话、Token、分片任务、运行时配置；未绑 D1 时的文件元数据 | 是 |
| **R2** | **`R2_BUCKET`** | 对象存储，唯一支持原生分片的后端 | 强烈推荐 |
| **D1** | **`DB`** | 文件元数据、文件夹标记、合集分享、API Token、粘贴、审计日志、Airdrop | 可选 |

> **注意**：三者都是 **Pages 绑定**（Settings → Functions），**不是环境变量**。名称写错整个项目跑不起来。

**D1 是渐进启用的** —— 代码层走「D1 优先 / KV 兜底」双路径，**不绑 D1 时行为与接入前完全一致**。可以先合代码、后建库，没有「必须同时切」的压力。

- **建表是自动的** —— 运行时首次访问触发懒迁移，按 `schema_migrations` 记账依次补齐
- **建库只需一条命令** —— `bash scripts/setup-d1.sh`

### 存储后端（七选一）

| 后端 | 单文件上限 | 说明 |
| :--- | :--- | :--- |
| **Cloudflare R2** | **10GB** | 唯一原生分片，大文件首选 |
| **Telegram** | 20MB | 默认后端，一个 Bot 就能用，完全免费 |
| **S3 兼容** | 40MB | AWS S3 / MinIO / B2 / 阿里云 OSS… |
| **WebDAV** | 40MB | 对接 alist / OpenList / NAS / 坚果云 |
| **GitHub** | 40MB（`contents` 20MB） | 存到仓库 / Release |
| **HuggingFace** | 35MB | Dataset 仓库 |
| **Discord** | 25MB | 频道存文件 |

> 指定后端未配置时回落 Telegram；**变量缺失不会静默降级到其他后端**，而是直接报错 —— 出问题你知道问题在哪。

---

## 🔐 安全

安全不是补丁，是从设计第一天就长进去的。

| 机制 | 说明 |
| :--- | :--- |
| **管理面 fail-closed** | 未配置管理员账密时，管理接口一律 `503 ADMIN_AUTH_NOT_CONFIGURED`，**绝不默认对公网开放** |
| **URL 导入 SSRF 防护** | 校验目标地址，拦截私网 / 回环 / 云元数据（`169.254.169.254` 等）；端口白名单；**每一次重定向都重新校验** |
| **统一限流** | `/api/**`、`/file/**`、`/upload` 默认 isolate 内限流（零 KV 开销），需要跨 isolate 强约束可开全局 |
| **登录暴力破解防护** | 登录窗口限流，撞库无效 |
| **堆栈脱敏** | 异常堆栈绝不回传客户端，不泄露内部路径 |
| **源码 / 配置不泄露** | 生产环境把 `package.json`、`wrangler.toml`、`.env*`、`migrations/`、`scripts/`、`docs/`、`README` 等一律拦成 **404**（不是 403，避免确认文件存在） |
| **无遥测** | 不内置任何上报，你的数据不出你的 Cloudflare 账号 |
| **依赖本地化** | 第三方前端资源放在 `vendor/`，不依赖外部 CDN（也就不怕 CDN 挂 / 被投毒） |
| **Token 策略** | `allowedStorages` / `allowedMimeTypes` / `maxFileSize` / `folderPrefix` / `allowedSourceHosts` / `rateLimit`，最小权限 |
| **Token 哈希存储** | 令牌明文不落库，`tokenSalt` + `tokenHash`，恒定时间比较 |
| **审计日志** | 令牌创建 / 轮换 / 启停 / 删除 / 校验失败全记录，**记录前脱敏，不存完整密钥、不存 IP** |
| **全站安全响应头** | CSP、HSTS、`X-Frame-Options`、`X-Content-Type-Options`、`Referrer-Policy`、`Permissions-Policy` |
| **魔法字节嗅探** | 不轻信 `Content-Type`，按文件头判断真实类型 |

---

## 🚀 部署（5 步上线）

> **唯一支持的方式：Cloudflare Pages。** 无 Docker、无自托管路径。

**准备：** 一个 Cloudflare 账号 + 至少一个存储后端凭据（最简单是 Telegram：一个 Bot Token + 一个 Chat ID）。

| # | 动作 | 关键值 |
| :-- | :--- | :--- |
| 1 | **Fork 本仓库** | — |
| 2 | **创建 Pages 项目** | Connect to Git，Framework preset 选 `None`，**Build command / 输出目录全部留空**（本项目没有构建步骤，填了反而部署失败） |
| 3 | **绑定 KV（必需）** | 变量名必须叫 **`img_url`** |
| 4 | **绑定 R2（强烈推荐）** | 变量名必须叫 **`R2_BUCKET`** |
| 5 | **配环境变量** | `BASIC_USER`、`BASIC_PASS` + 一个存储后端凭据 |

> **公网部署必须设 `BASIC_USER` 和 `BASIC_PASS`**，否则后台不可用（这是 fail-closed，不是 bug）。
>
> **绑了 R2 就一定要配两条生命周期规则**：删除 `chunk-upload/` 前缀对象、终止未完成的分片上传（各 1 天）。否则用户传大文件传一半关页面，临时分片会永久占空间。

### 本地开发

```bash
npm install
npm start          # wrangler pages dev，已内置 --kv img_url --r2=R2_BUCKET
```

访问 `http://localhost:8080`，默认账密 `admin` / `123`。本地 `wrangler` **会读** `.env` / `.dev.vars`（线上 Pages 不读）。

### 部署到线上

```bash
npm run pages:deploy      # 等价于 npx wrangler pages deploy .
```

### 验证

- 打开 `/` 传个小文件，看能否拿到直链
- 打开 `/admin/files` 用你设的账密登录
- 打开 `/api/status` 看各后端状态

完整环境变量清单见 [`.env.example`](.env.example)，已按「必填最小集 → 存储后端 7 选 1 → 可选开关 → 后台可设置」分组。

---

## 🌐 把本站当作 WebDAV 主机

除了作为 WebDAV **客户端**把文件推到别的网盘，本站还能反过来当 **WebDAV 服务端** —— 让你的电脑 / 手机把本站挂载成一块网络硬盘，直接拖拽上传、下载、建目录、改名。

| 平台 | 挂载地址 |
| :--- | :--- |
| macOS Finder（⌘K） | `https://你的域名/dav` |
| Windows 映射网络驱动器 | `\\你的域名@SSL\dav` |
| 手机 App / RaiDrive / rclone | `https://你的域名/dav` |

**协议能力：** `OPTIONS`（`DAV: 1, 2`）、`PROPFIND`（`Depth: 0/1`）、`GET`/`HEAD`（支持 `Range` 断点续传）、`PUT`、`DELETE`、`MKCOL`、`MOVE`、`COPY`。

服务端与客户端**完全独立**（变量前缀 `WEBDAV_SERVER_*` vs `WEBDAV_*`），可同时开启。独立账密（与站点 `BASIC_USER` 分开）、独立只读开关、文件落库后端可选。

> **务必在 HTTPS 下使用** —— WebDAV 客户端只发 HTTP Basic，密码在请求头里明文传输。
>
> 全部配置可在后台在线修改、**即时生效**。

---

## 🤖 API 与 Agent 接入

### 鉴权

- 网页后台：Cookie 会话 或 HTTP Basic
- API v1：`Authorization: Bearer kvault_<tokenId>_<secret>`
- MCP：同一个 Bearer Token，工具可见性由 scope 决定

四种 scope：`upload` · `read` · `delete` · `paste`

### API v1 端点

| 方法 | 路径 | scope | 说明 |
| :--- | :--- | :--- | :--- |
| GET | `/api/v1/capabilities` | 公开 | 已配置的后端与上传上限 |
| GET | `/api/v1/me` | 任意 Token | Token 自省 |
| POST | `/api/v1/upload` | `upload` | 上传，支持 `Idempotency-Key`（24h 去重） |
| POST | `/api/v1/import` | `upload` | URL 导入（SSRF 校验） |
| GET | `/api/v1/files` | `read` | 分页列表 |
| GET / DELETE | `/api/v1/file/<path>` | `read` / `delete` | 直链流 / 删除 |
| GET | `/api/v1/file/<path>/info` | `read` | 元数据 |
| POST | `/api/v1/paste` | `paste` | 创建粘贴 |
| GET | `/api/v1/pastes` | `read` | 粘贴列表 |
| GET / DELETE | `/api/v1/paste/<id>` | `read` / `delete` | 读取 / 删除 |

机器可读定义见 [`docs/reference/openapi.yaml`](docs/reference/openapi.yaml)，Agent 接入指南见 [`docs/reference/agent-integration.md`](docs/reference/agent-integration.md)（含 MCP 工具映射）。

### MCP 端点

原生实现 [Model Context Protocol](https://modelcontextprotocol.io/)，**不依赖任何第三方 SDK**——纯手写 JSON-RPC 2.0 + Streamable HTTP，与项目「零运行时依赖」的定位一致。

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| POST | `/mcp` | JSON-RPC 2.0 请求（单条或批量）。支持 `initialize` / `tools/list` / `tools/call` / `ping` |
| GET | `/mcp` | `405` —— 无状态模式不提供 SSE 流 |

**开关**：默认**关闭**。需设置环境变量 `MCP_ENABLED=true` 才对公网开放；未开启时 `/mcp` 返回 `404`（fail-closed：新增的网络面不因「忘了配」而自动敞开）。

**鉴权**：与 API v1 共用同一套 API Token（`Authorization: Bearer kvault_<id>_<secret>`），并复用同一份 CORS 白名单 `API_CORS_ORIGINS`。

**鉴权粒度按 JSON-RPC 方法区分**（不是按连接一刀切）：

| 方法 | 需要 Token | 说明 |
| :--- | :--- | :--- |
| `initialize` / `ping` / `notifications/*` | 否 | 协议握手。匿名 `initialize` 的 `capabilities` 为空对象、不含 `instructions`，**不暴露工具清单**；带 Token 才返回完整能力 |
| `tools/list` / `tools/call` | **是** | 缺失 → HTTP `401` |

主流的 MCP 客户端在 `initialize` 阶段还不一定发送 `Authorization`（它们把「建立连接」与「提供凭据」分两步），因此握手免鉴权是兼容性所必需的；同时因为匿名握手不泄露任何工具信息，安全边界并未放宽。

**10 个工具**：

| Tool | 所需 scope |
| :--- | :--- |
| `kvault_capabilities` | 公开 |
| `kvault_token_info` | 任意 Token |
| `kvault_upload_file` | `upload` |
| `kvault_import_url` | `upload` |
| `kvault_list_files` | `read` |
| `kvault_get_file_info` | `read` |
| `kvault_get_file` | `read` |
| `kvault_delete_file` | `delete` |
| `kvault_create_paste` | `paste` |
| `kvault_list_pastes` | `read` |

`tools/list` **只返回当前 Token 有权限调用的工具**，避免把必然被拒的工具喂给模型。工具执行时仍会按 scope 二次校验（可见性过滤不是安全边界）。

**无状态设计**：不分配 `Mcp-Session-Id`。Cloudflare Pages Functions 无常驻进程，维护会话需要落 KV 并在每个请求回读，而 MCP 规范允许服务端不分配会话，因此无状态是 Serverless 上的正确取舍。

---

## 📁 目录结构

Cloudflare Pages **没有构建步骤**，仓库根目录即站点根目录。以下两个目录**不要移动**：`functions/`（Pages Functions 硬约定）与根目录的 8 个 HTML（它们就是线上 URL）。

```text
├── index.html admin.html paste.html gallery.html      # 页面入口（根即站点根，勿移动）
├── preview.html webdav.html login.html share.html
├── assets/                              # 静态资源（CSS / JS / 图片 / 第三方库）
│   ├── css/                             # design-system.css（全站唯一事实来源）
│   ├── js/                              # app-core.js（共享层，必须先于页面脚本）
│   └── vendor/                          # fontawesome / glassfx / vue / qrcode
├── functions/                           # Cloudflare Pages Functions 后端（路径即路由，勿动）
│   ├── api/                             # auth / manage / admin / v1 / airdrop / chunked-upload
│   ├── mcp/[[path]].js                  # MCP 端点（JSON-RPC 2.0，无状态 Streamable HTTP）
│   ├── file/[[path]].js                 # 文件直链（多层路径、密码）
│   ├── dav/[[path]].js                  # WebDAV 服务端
│   ├── s/[slug].js                      # 分享短链 → 302 到落地页
│   └── utils/                           # 存储适配器与公共工具
│       ├── schema.js                    # D1 迁移的唯一真源
│       ├── env-config.js                # 环境变量统一读取层
│       ├── runtime-config.js            # KV 覆盖 > 环境变量 的运行时配置
│       └── ssrf-guard.js ratelimit.js redact.js metadata-d1.js …
├── migrations/                          # 由 scripts/gen-migrations.py 从 schema.js 生成，勿手改
├── scripts/                             # 校验 / 测试 / D1 工具
├── docs/                                # 分层文档，总入口见 docs/README.md
└── .env.example                         # 变量清单（Pages 不读此文件）
```

---

## 🎨 设计系统

所有页面共用一份 `design-system.css` —— **令牌、通用组件、动效关键帧、Vue 过渡族的唯一事实来源**。

| 类别 | 内容 |
| :--- | :--- |
| 设计令牌 | 品牌色 / 语义色 / 玻璃质感 / 文字 / 阴影 / 圆角 / 间距 / 字号 / 控件高度 / 缓动（4 档）/ 时长（5 档） |
| 通用组件 | `.card`、`.btn--*`、`.input` / `.select` / `.textarea`、`.switch`、`.spinner`、`.toast`、`.empty-state`、`.progress` |
| 动效 | **37 个关键帧** + `.boot-rise` 入场编排 |
| 过渡族 | `fade / pop / rise / drop / bar / ctrl / toast / list / menu / sheet / dialog / view-forward / view-back` |
| 无障碍 | 三级降级：`prefers-reduced-motion` / `prefers-reduced-transparency` / `html[data-perf="low"]` |

改完跑一次守卫脚本，确保没有回归：

```bash
npm run check
```

---

## 📚 文档导航

| 文档 | 内容 |
| :--- | :--- |
| [`docs/README.md`](docs/README.md) | **文档总入口**（按「我要做什么」分类） |
| [`docs/guides/d1-migration-checklist.md`](docs/guides/d1-migration-checklist.md) | **D1 迁移部署与灰度验证清单** —— 动 D1 前必读 |
| [`docs/guides/storage-backends.md`](docs/guides/storage-backends.md) | 七种后端逐步配置 + WebDAV 主机 |
| [`docs/reference/architecture.md`](docs/reference/architecture.md) | 技术架构详情 |
| [`docs/reference/agent-integration.md`](docs/reference/agent-integration.md) | Agent / 脚本接入指南 |
| [`docs/reference/openapi.yaml`](docs/reference/openapi.yaml) | API v1 机器可读定义 |
| [`docs/agents/AI-OPERATIONS.md`](docs/agents/AI-OPERATIONS.md) | 写给 AI Agent 的操作手册 |

### Telegram Webhook 密钥

| 变量名 | 说明 | 默认值 |
| :--- | :--- | :--- |
| `TELEGRAM_WEBHOOK_SECRET` | Webhook 校验密钥。**必须设置**：未设置时端点直接 `503` 停用 | 无（未设置则停用） |

> Telegram Webhook 现在是 **fail-closed** 的。以前未设密钥时端点不做校验，任何人都能匿名往你的 KV 写数据。现在必须先用 `secret_token` 注册 webhook。

---

## 🙏 致谢

后端能力源自 **K-Vault**，感谢原作者与社区：

- [katelya77/K-Vault](https://github.com/katelya77/K-Vault) — 后端能力的来源
- Telegraph-Image — 早期 Serverless 图床形态参考
- CloudFlare-ImgBed — 同类优秀开源图床项目
- Linux.do 社区用户反馈

---

## 🆚 与上游 katelya77/K-Vault 的区别

> 放在最后：如果你是奔着「部署一个自己的云盘」来的，上面的内容已经够了。这一章是给需要横向对比的人看的。

### 定位差异

上游是「Cloudflare Pages + Docker 双模」的通用文件托管；K-Vault-Next 是「**只留 Cloudflare Pages 单形态**」的精简强化版 —— 砍掉自托管复杂度，把省下来的力气全花在 Pages 这一条路上。

### 总览对照

| 维度 | katelya77/K-Vault | K-Vault-Next |
| :--- | :--- | :--- |
| 部署形态 | Cloudflare Pages **+ Docker 单镜像** | **仅 Cloudflare Pages** |
| 运行时依赖 | Sentry 等 | **零运行时依赖** |
| 遥测 | 内置 Sentry，`disable_telemetry` 关闭 | **无任何遥测代码** |
| 页面数量 | 6 个 | **8 个**（新增 `/paste.html`、`/share.html`） |
| 前端样式 | 各页面各写一份 | **`design-system.css` 单一事实来源** |
| 环境变量写法 | 大小写两套名字，建议「两个都写上」 | **统一读取层，填一次即可** |
| 改配置 | 改环境变量 → 重新部署 | 高频配置**后台可改，即时生效** |
| R2 单文件上限 | 100MB | **10GB**（原生 multipart） |
| 分享短链 | `/s/:slug` 302 直出文件 | `/s/:slug` → **分享落地页**，预览不计次、下载才计次 |
| 内容审核 / 黑白名单 | 有 | **已移除** |
| 隔空投送 | 无 | **有**（连接码 / 二维码配对，传完即焚） |

### Next 砍掉了什么

- **Docker / 自托管整条链路** —— `server/` Node 运行时、`docker-compose.yml`、`Dockerfile`、GHCR 镜像构建
- **Docker 专属环境变量** —— `DATA_DIR`、`PORT`、`CONFIG_ENCRYPTION_KEY`、`SESSION_SECRET`、`SETTINGS_REDIS_*` 等
- **Sentry 遥测** 及其开关
- **内容审核**（`ModerateContentApiKey`）与**黑白名单**（`WhiteList_Mode`）
- **旧前端产物** `frontend/`（Vite/Vue）与 `_nuxt/`

> 如果你需要的是「一台 VPS 上跑起来、后端随便换、还能配 Redis 存配置」，那应该直接用上游的 Docker 版本。本仓库**不做**这件事。

### Next 增强了什么

| 方向 | 变化 |
| :--- | :--- |
| 前端统一 | `design-system.css`：令牌、组件、37 个关键帧全站唯一来源 |
| 动效与无障碍 | Apple HIG 令牌、首屏错峰入场、三级降级 |
| 环境变量 | `env-config.js` 统一读取层，大小写与历史别名自动兼容 |
| 运行时配置 | 四组配置存 KV，后台改即时生效 |
| 分片上传 | R2 原生 multipart，100MB → **10GB** |
| WebDAV 服务端 | 新增 `/dav`，把本站挂载成网络硬盘 |
| 分享体系 | 落地页 + 有效期 / 密码 / 次数 / 自定义 slug + 后台分享管理 |
| 隔空投送 | 全新功能：连接码 / 二维码配对、传完即焚 |
| 安全 | 管理面 fail-closed、统一限流、暴力破解防护、SSRF 防护、依赖本地化 |
| 文档 | `openapi.yaml` + `agent-integration.md` |

---

## 📄 许可证

**CC0 1.0 Universal** — 可自由使用、修改与分发。拿走，改吧，部署吧。
