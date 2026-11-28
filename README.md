<div align="center">

<img src="assets/img/logo.png" alt="K-Vault-Next Logo" width="120">

# K-Vault-Next

**跑在 Cloudflare Pages 上的轻量文件层：图床 · 网盘 · WebDAV · MCP**

[![Deploy to Cloudflare Pages](https://img.shields.io/badge/Deploy-Cloudflare%20Pages-F38020?logo=cloudflare&logoColor=white)](#快速部署)
![Runtime Dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen)
![Storage Backends](https://img.shields.io/badge/storage%20backends-7-blue)
![Max File Size](https://img.shields.io/badge/single%20file-up%20to%2010GB-orange)
![License](https://img.shields.io/badge/license-AGPL--3.0-blue)

**中文** | [English](README-EN.md)

</div>

> 零构建、零运行时依赖、无 VPS / Docker。Fork 仓库，在 Cloudflare Pages 绑定资源并填好变量，5 分钟上线。

---

## 核心特性

| 能力 | 说明 |
| :--- | :--- |
| **大文件分片上传 & 加速下载** | **R2** 原生分片最高 **10GB**；**Telegram** 虚拟分片直传最高 **2GB**（自适应频控冷却 + 断点续传 + 原生 Range 分段下载 + 边缘缓存零 KV 消耗） |
| **7 种存储后端** | Telegram、Cloudflare R2、S3 兼容、WebDAV、GitHub、HuggingFace、Discord，按需启用 |
| **WebDAV 服务端** | `/dav` 直接挂载到 Finder / Windows 资源管理器 / 手机 App / rclone，支持独立账密与只读模式 |
| **AI & 自动化接口** | 完整 REST API v1 + 原生无状态 `/mcp`（11 个工具，支持细粒度 Token 策略）+ 零依赖 CLI |
| **分享落地页** | `/s/:slug` 支持密码、有效期、下载次数上限与自定义短链，**预览不计次、下载才计次** |
| **实用附加工具** | **隔空投送（Airdrop）** 6 位码传完即焚；**本地零知识密码库**（`/vault.html`，浏览器端 AES-GCM 加密 + TOTP）；**Show** 公开展示页 |
| **安全默认** | 管理面 fail-closed、URL 导入 SSRF 防护、登录防爆破、无遥测、高频配置后台在线修改即时生效 |

---

## 快速部署

> 仅支持 **Cloudflare Pages**（无 Docker / 自托管）。以下 5 步即可上线：

### 第 1 步：准备资源（Cloudflare 控制台）

在 Cloudflare Dashboard 左侧提前创建所需绑定资源：

1. **KV 命名空间（必需）**：`Workers & Pages → KV → Create a namespace`（例如命名 `kvault-kv`）。
2. **R2 存储桶（推荐，开启 10GB 大文件）**：`R2 → Create bucket`。
3. **D1 数据库（推荐，大幅节省免费版 KV 写入并启用隔空投送 / 完整管理能力）**：`Workers & Pages → D1 → Create database`（首次访问会自动建表迁移，无需手动执行 SQL）。

### 第 2 步：Fork 并创建 Pages 项目

1. Fork 本仓库到你的 GitHub 账号。
2. 进入 Cloudflare Dashboard → `Workers & Pages → Create → Pages → Connect to Git`，选择刚 Fork 的仓库。
3. 构建配置按如下填写，然后点击 **Save and Deploy**：
   - **Framework preset**：`None`
   - **Build command**：**留空**（本项目无构建步骤，填写会导致部署失败）
   - **Build output directory**：**留空**（或 `/`）

### 第 3 步：添加 Pages 绑定（Functions Bindings）

进入项目 `Settings → Functions`（或 `Settings → Bindings`），严格按以下**变量名**添加绑定（**这是绑定，不是环境变量**）：

| 资源类型 | 变量名（必须完全一致） | 是否必需 | 用途 |
| :--- | :--- | :---: | :--- |
| **KV Namespace** | `img_url` | **必需** | 会话、Token、分片任务、运行时配置 |
| **R2 Bucket** | `R2_BUCKET` | 推荐 | R2 对象存储（单文件最高 10GB） |
| **D1 Database** | `DB` | 推荐 | 文件元数据、分片状态、分享合集、隔空投送、审计日志 |

### 第 4 步：配置环境变量

进入项目 `Settings → Environment variables`，填入**最小必填集**：

```env
# 1. 管理员账密（公网部署必填，不配则管理后台 fail-closed 返回 503）
BASIC_USER=admin
BASIC_PASS=请替换为强密码

# 2. 至少配置一个存储后端（以免费的 Telegram 为例；若已绑 R2 可选填）
TG_BOT_TOKEN=你的_Bot_Token
TG_CHAT_ID=你的频道或群组_Chat_ID
```

> - 环境变量大小写自动兼容（如 `TG_BOT_TOKEN` / `TG_Bot_Token` 填一个即可）。
> - 完整变量清单（S3 / WebDAV / GitHub / HuggingFace / Discord / Webhook 等）见 [`.env.example`](.env.example)。
> - **保存绑定和环境变量后，务必在 `Deployments` 中触发一次重新部署（Retry deployment）使其生效。**

### 第 5 步：验证上线

- 访问 `https://你的域名/`：进入站点并上传测试文件，确认拿到直链。
- 访问 `https://你的域名/admin/files`：用 `BASIC_USER` / `BASIC_PASS` 登录后台。
- 访问 `https://你的域名/api/status`：检查各存储后端可用状态。

---

## 本地开发

```bash
npm install
npm start          # 启动 wrangler pages dev (http://localhost:8080，默认账密 admin / 123)
npm run check      # 运行静态守卫与模板编译校验
```

本地开发读取根目录 `.dev.vars` / `.env`；如需通过命令行直接发布到 Cloudflare Pages：

```bash
npm run pages:deploy
```

---

## 存储后端与单文件上限

| 存储后端 | 单文件上限 | 说明 |
| :--- | :---: | :--- |
| **Cloudflare R2** | **10GB** | 原生 Multipart 分片，大文件首选 |
| **Telegram** | **2GB** | ≤20MB 直传，>20MB 自动走 18MB 虚拟分片直传（免费，需开启元数据持久化） |
| **S3 兼容 / WebDAV** | 40MB | 支持 AWS S3 / MinIO / B2 / OSS 及 OpenList / NAS / 坚果云 |
| **GitHub** | 40MB | Releases 模式 40MB，Contents 模式 20MB |
| **HuggingFace** | 35MB | Dataset 仓库 |
| **Discord** | 25MB | Bot Token 或 Webhook |

---

## 常用接入方式

| 入口 | 地址 / 用法 | 说明 |
| :--- | :--- | :--- |
| **WebDAV 挂载** | `https://你的域名/dav`（Windows 用 `\\你的域名@SSL\dav`） | 后台「系统设置」在线开启并配置独立账密，务必使用 HTTPS |
| **REST API v1** | `/api/v1/**`（`Authorization: Bearer kvault_<id>_<secret>`） | 支持 `upload / read / delete / paste / share` 五种细粒度 scope |
| **MCP 端点** | `POST /mcp`（JSON-RPC 2.0，无状态 Streamable HTTP） | 默认关闭，后台一键开关并可逐个控制 11 个工具 |

零依赖命令行上传（Node 22+）：

```bash
export KVAULT_ENDPOINT="https://你的域名"
export KVAULT_TOKEN="kvault_<id>_<secret>"
node scripts/kvault-upload.mjs upload ./demo.png --folder blog
```

---

## 文档导航

- [`docs/README.md`](docs/README.md) — 完整文档索引
- [`.env.example`](.env.example) — 全部环境变量清单
- [`docs/guides/storage-backends.md`](docs/guides/storage-backends.md) — 七种存储后端与 WebDAV 服务端配置教程
- [`docs/guides/d1-migration-checklist.md`](docs/guides/d1-migration-checklist.md) — D1 迁移与灰度验证清单
- [`docs/reference/agent-integration.md`](docs/reference/agent-integration.md) — API v1 / MCP / CLI 接入指南
- [`docs/reference/openapi.yaml`](docs/reference/openapi.yaml) — OpenAPI 规范定义
- [`docs/reference/architecture.md`](docs/reference/architecture.md) — 项目架构与目录说明

---

## 版权与开源协议

Copyright © 2026 **Linyueying**. All rights reserved.

本项目基于 **[GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE)** 开源：你可以自由使用、修改与自托管本项目；但如果你修改了本项目代码并对外提供网络服务，须同样以 AGPL-3.0 协议公开修改后的完整源码，并保留原作者版权与许可声明。

早期后端基础能力衍生自 [katelya77/K-Vault](https://github.com/katelya77/K-Vault)（CC0 1.0 Universal 公有领域奉献，本仓库为纯 Cloudflare Pages 精简强化版，移除 Docker / 遥测 / 内容审核，新增大文件分片、WebDAV 服务端、分享落地页、隔空投送、密码库、Show 展廊与 MCP）。完整版权与上游声明请参阅 [NOTICE](NOTICE)。
