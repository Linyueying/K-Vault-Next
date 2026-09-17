<div align="center">

<img src="logo.png" alt="K-Vault Logo" width="140">

# K-Vault · 一云

> 免费图片 / 文件托管方案，支持 **Cloudflare Pages + Docker** 双模部署，兼容 Telegram、R2、S3、Discord、HuggingFace、WebDAV、GitHub 七种存储后端

[English](README-EN.md) | **中文**

![GitHub stars](https://img.shields.io/github/stars/YOUR_GITHUB/YOUR_REPO?style=flat-square)
![GitHub forks](https://img.shields.io/github/forks/YOUR_GITHUB/YOUR_REPO?style=flat-square)
![GitHub license](https://img.shields.io/github/license/YOUR_GITHUB/YOUR_REPO?style=flat-square)

</div>

---

## 这是什么

K-Vault 是一个以 **Telegram 为核心**的 Serverless 聚合云盘 / 图床：上传的文件进入你自选的存储后端，元数据落在 Cloudflare KV（或 Docker 下的 SQLite），对外提供直链、预览、目录管理、API Token 与机器可调用的 API v1。

它有两种正式部署形态，共用同一套根目录静态页面：

| 形态 | 运行方式 | 适合场景 |
| :--- | :--- | :--- |
| **Cloudflare Pages** | 根目录静态页 + `functions/` Pages Functions | 免费额度内零成本、边缘加速、全球可用 |
| **Docker 自托管** | Nginx 静态页 + `server/` Node.js/Hono 运行时 | VPS / NAS / 内网、长期自托管、不受 CF 额度限制 |

---

## 与上游的关系（请先读这一节）

本项目是 [katelya77/K-Vault](https://github.com/katelya77/K-Vault) 的衍生版本：

```
katelya77/K-Vault  ──►  Linyueying/K-Vault  ──►  本项目
   原始实现              前端现代化尝试         轻量前端重写 + 安全加固
```

**先说清楚事实，避免误解：**

- **后端 100% 沿用上游，未作改动。** `functions/**`、`server/**`、`test/**`、`docs/**` 与上游逐字节一致（仅本仓库的少数几处安全加固除外，见下方「安全加固」）。因此上游的全部能力在本项目中完整可用。
- **本项目真正的工作集中在前端页面重写**：`admin.html`、`index.html`、`gallery.html` 三个页面被重写为不依赖 Element UI 的轻量实现。
- **`Linyueying/K-Vault` 与 `katelya77/K-Vault` 的文件树与内容逐字节相同**（1458 个文件、README 哈希一致），即该 fork 未产生实际代码变更；本项目独立完成了前端重写。

本项目**不声称**是对上游的全面超越。它是一份「更轻的前端 + 更严的鉴权面」的改版，代价见「已知差异」一节。

---

## 功能特性

以下能力继承自 K-Vault，在本项目中完整可用：

### 存储与上传

- **七种存储后端** — Telegram、Cloudflare R2、S3 兼容（AWS S3 / MinIO / B2 / 阿里云 OSS 等）、Discord、HuggingFace、WebDAV、GitHub
- **Telegram Webhook 回链** — 机器人在频道/群收到文件后自动回复直链；配合自部署 Bot API 可支持大文件
- **KV 写入优化** — Telegram 可启用签名直链 / 低 KV 写入模式，显著降低 KV 读写消耗
- **分片上传** — 最大 100MB（建议配合 R2 / S3 / WebDAV / GitHub）
- **URL 远程导入** — 服务端拉取远程 URL 后转存，内置 SSRF 防护
- **访客上传** — 可选开启，支持单文件大小与每日次数限制
- **多格式支持** — 图片、视频、音频、文档、压缩包等

### 管理后台

- **文件管理** — 搜索、排序、按存储后端筛选、分页游标加载
- **目录树** — 新建 / 重命名 / 移动 / 递归删除目录，文件批量移动
- **收藏与重命名** — 单文件收藏标记、显示名重命名（不改动公开直链）
- **黑白名单** — 文件级 Block / White 标记，命中后直链自动跳转到拦截提示页
- **多种视图** — 网格、列表、瀑布流
- **存储状态面板** — 各后端连通性、上传上限、访客配置
- **前端 UI 设计配置（跨端同步）** — 背景图、卡片毛玻璃、动态背景特效，可写回服务端全站生效

### API 与自动化

- **API Token 体系** — 与网页登录态完全隔离，可吊销/轮换；`scopes` 按需授权（`upload` / `read` / `delete` / `paste`）
- **Token 策略（policies）** — `allowedStorages` 限定后端、`folderPrefix` 限定目录、`maxFileSize` 限定大小
- **幂等重试** — `Idempotency-Key` 24 小时内去重，网络重试不产生重复文件
- **内容去重** — ≤25MB 重复内容走 SHA-256 索引自动去重
- **审计追踪** — 记录 Token 最后使用时间、操作类型与客户端标签
- **API v1** — 文件上传/列表/下载/删除 + 文本 Paste 创建/读取/删除
- **CORS 白名单** — 通过 `API_CORS_ORIGINS` 控制跨域来源
- **文档化接口** — 机器可读定义见 [docs/openapi.yaml](docs/openapi.yaml)，接入指南见 [docs/agent-integration.md](docs/agent-integration.md)

### 部署与运维

- **双模部署** — 同一套前端，Cloudflare Pages 或 Docker
- **动态存储配置管理** — 通过 API 新增/编辑/删除/测试存储配置、设置默认后端
- **可插拔设置存储（Docker）** — `sqlite`（默认）或 Redis 协议后端（Upstash / Redis / KVrocks）
- **GitHub Actions** — 主分支 / Tag 自动构建并推送镜像

---

## 相对上游的改动

### 1. 前端重写（本项目的主要工作）

三个核心页面被重写为不依赖组件库的轻量实现：

| 页面 | 上游 | 本项目 | 变化 |
| :--- | ---: | ---: | :--- |
| `admin.html` | 4999 行 / 216 KB | **1786 行 / 82 KB** | −64% 行数，−62% 体积 |
| `index.html` | 5753 行 / 183 KB | **3297 行 / 131 KB** | −43% 行数，−28% 体积 |
| `gallery.html` | 1376 行 / 40 KB | **1725 行 / 57 KB** | +25% 行数（画廊能力加强） |

具体做法：

- **移除 Element UI 2.15.3** — 三个页面原本都加载 Element UI 的 CSS + JS；重写后完全去除，改为手写 CSS。上游 `admin.html` 中有 443 处 `el-` 组件引用，本项目中仅剩 7 处样式类名残留。
- **移除 Sentry CDN** — `admin.html` 不再注入第三方错误上报脚本。
- **图标库锁版本** — FontAwesome 由不固定版本改为固定 `@6.4.2`。
- **改用国内可达 CDN** — Vue 2.6.14 由 jsdelivr 换成 bootcdn，改善国内首屏加载。
- **自研 Design Token 样式体系** — 页面样式统一基于 CSS 变量（`--primary` / `--text-main` / `--surface-*` / `--ease-fluid` 等），配合保留的 `theme.css` / `theme.js` 实现亮暗主题与全站 UI 配置联动。
- **品牌化** — 页面标题调整为自有品牌（首页「一云」、`gallery.html`「影像画廊 | K-Vault」、`admin.html`「K-Vault · 管理后台」）。

### 2. 安全加固

上游与 Pages/Docker 两端统一收敛了管理面鉴权：

| 加固项 | 说明 |
| :--- | :--- |
| **`POST /api/upload-from-url` 补上访客门槛** | 此前该接口在 Cloudflare Pages 上**完全无鉴权**，任何人可让服务端拉取任意远程 URL 并写入你的存储后端。现与 Docker 行为对齐：管理员放行，访客需 `GUEST_UPLOAD=true` 且满足大小/次数限制 |
| **`/api/manage/**` 改为 fail-closed** | 此前未配置 `BASIC_USER` / `BASIC_PASS` 时**整个管理接口对公网开放**（含删除、重命名、移动、黑白名单）。现统一返回 `503 ADMIN_AUTH_NOT_CONFIGURED`，与 `/api/admin/**` 策略一致；Docker 侧同策略覆盖 `/api/storage/**`、`/api/settings`、`POST /api/ui-config`、`POST /api/share/sign` |
| **修复 `/api/manage/login` 不可达** | 该登录入口此前被同目录中间件拦截，导致 `gallery.html` 的 401 恢复路径落到纯文本 401 而非登录页。现豁免该路由，未登录 302 跳 `/login.html`，已登录跳 `/admin.html` |
| **`GET /api/status` 分级返回** | 未登录访客只拿到「各后端是否可用 + 访客配置 + 上传上限 + 能力清单」，且**不再触发任何后端连通性探测**；连通性结果、后端错误详情、机器人身份等诊断信息仅管理员可见 |

### 3. 死代码清理

- 移除 8 个与 `/api/manage/*` 完全重复、无任何调用者的 `/api/drive/*` 路由
- 移除 4 个无调用者的兼容别名（`GET /api/manage/check`、`GET/POST /api/manage/logout`、`GET /api/auth/login`、`GET /api/chunked-upload/init`）——其中 `manage/logout` 与 `chunked-upload/init` 因其真实兼容价值已**恢复保留**
- 移除 Pages 侧死文件 `functions/api/r2/upload.js`（无调用者、无文档、无鉴权）
- `server/app.js` 净减约 210 行，路由 79 → 69

---

## 已知差异 / 待补齐

前端重写**不是纯增益**。上游默认后台 `admin.html` 中有以下面板，重写后的默认后台**尚未包含**：

| 面板 | 上游 `admin.html` | 本项目 `admin.html` | 后端接口 |
| :--- | :---: | :---: | :--- |
| API Token 管理 | ✅ | ❌ | 已实现（`/api/admin/tokens*`） |
| 文件黑白名单 | ✅ | ❌ | 已实现（`/api/manage/block|white/:id`） |
| 前端 UI 设计面板 | ✅ | ❌ | 已实现（`GET/POST /api/ui-config`） |
| 到 `admin-imgtc.html` / `admin-waterfall.html` 的入口 | ✅ | ❌ | — |

需要注意的是：**接口与工具函数都已就绪，缺的只是默认后台的入口**。其中黑白名单在 `admin-imgtc.html`（Element UI 版后台，文件完整保留）中仍可使用，只是新版 `admin.html` 不再链接过去；UI 设计配置的读写能力也在 `theme.js` 的 `UIDesignManager` 中保留。

因此当前状态下：

- 想用 Token 管理 / UI 设计面板 → 暂时通过 API 调用，或参考上游 `admin.html` 自行补 UI
- 想用黑白名单 → 直接访问 `admin-imgtc.html`

如果你更希望「功能与上游对齐」而不是「体积更小」，这几个面板可以逐步移植回新版后台。

---

## 快速开始

### 方式一：Cloudflare Pages 部署

1. Fork 本仓库
2. Cloudflare Dashboard → Workers & Pages → 创建 Pages 项目 → 连接本仓库
3. **Build command 与 Build output directory 都留空**（本项目无构建步骤）
4. 绑定 KV：变量名必须是 `img_url`
5. 配置环境变量（至少 `TG_Bot_Token`、`TG_Chat_ID`；公网部署**必须**设 `BASIC_USER` / `BASIC_PASS`）
6. 部署完成后访问 `/` 上传、`/admin.html` 管理

### 方式二：Docker 部署

```bash
git clone <本仓库地址>
cd <仓库目录>
cp .env.example .env   # 或运行 npm run docker:init-env 生成
docker compose up -d
```

访问 `http://<你的地址>:8080`。

> ⚠️ **注意**：`docker-compose.yml` 默认拉取上游镜像 `ghcr.io/katelya77/k-vault:latest`。若要使用本仓库的构建产物，请将其改为你自己的镜像地址，或本地构建：
>
> ```bash
> docker build -t k-vault:local .
> # 然后在 .env 中设置 KVAULT_IMAGE=k-vault:local
> ```

---

## 页面一览

| 页面 | 路径 | 说明 |
| :--- | :--- | :--- |
| 首页 / 上传 | `/` | 批量上传、拖拽、粘贴上传 |
| 管理后台 | `/admin.html` | 文件管理、目录树、收藏、存储状态 |
| 旧版后台 | `/admin-imgtc.html` | Element UI 版后台，含黑白名单批量操作 |
| 瀑布流后台 | `/admin-waterfall.html` | 瀑布流视图 |
| 图片浏览 | `/gallery.html` | 影像画廊 |
| WebDAV | `/webdav.html` | WebDAV 上传 / 状态检查 / URL 上传 |
| 文件预览 | `/preview.html` | 多格式预览（图片、视频、音频、PDF、docx、txt 等） |
| 登录 | `/login.html` | 后台登录 |
| 拦截提示 | `/block-img.html`、`/whitelist-on.html` | 黑名单 / 白名单模式提示页 |

---

## 目录结构

```
├── index.html                  # 首页 / 上传
├── admin.html                  # 管理后台（重写）
├── admin-imgtc.html            # Element UI 版后台（含黑白名单）
├── admin-waterfall.html        # 瀑布流后台
├── gallery.html                # 影像画廊（重写）
├── webdav.html / preview.html / login.html
├── theme.css / theme.js        # 主题与全站 UI 设计配置
├── functions/                  # Cloudflare Pages Functions 后端
│   ├── api/                    # auth / manage / admin / v1 / chunked-upload ...
│   ├── file/[id].js            # 文件直链与黑白名单执行
│   └── s/[slug].js             # 短分享链
├── server/                     # Docker 自托管后端（Hono）
│   ├── app.js                  # 全部路由
│   ├── lib/                    # 仓储层、存储适配器、鉴权、SSRF 防护
│   └── db/                     # SQLite schema
├── test/                       # 20 个测试文件
├── docs/                       # OpenAPI、接入指南、完整配置参考
├── scripts/                    # 环境引导、存储回归、Docker smoke
└── docker/                     # Nginx 配置与 entrypoint
```

---

## 完整文档

| 文档 | 内容 |
| :--- | :--- |
| [docs/README-full-reference.md](docs/README-full-reference.md) | **完整配置参考**：全部环境变量、各存储后端详细配置步骤、API 使用指南、ShareX 配置、使用限制 |
| [README-DOCKER.md](README-DOCKER.md) | Docker 部署详解 |
| [docs/openapi.yaml](docs/openapi.yaml) | API v1 机器可读定义 |
| [docs/agent-integration.md](docs/agent-integration.md) | Agent / 脚本接入指南 |
| [docs/cloudflare-pages-r2.md](docs/cloudflare-pages-r2.md) | Cloudflare Pages R2 绑定排查 |
| [PROJECT_INTRO.md](PROJECT_INTRO.md) | 项目定位与架构说明 |

---

## 上游与致谢

本项目的后端实现来自 **K-Vault**，感谢原作者与社区：

- [katelya77/K-Vault](https://github.com/katelya77/K-Vault) — 本项目直接上游，全部后端能力的来源
- [Linyueying/K-Vault](https://github.com/Linyueying/K-Vault) — 本项目的直接 fork 基点
- [Telegraph-Image](https://github.com/cf-pages/Telegraph-Image) — K-Vault 早期 Serverless 图床形态的重要上游参考
- [CloudFlare-ImgBed](https://github.com/MarSeventh/CloudFlare-ImgBed) — 同类优秀开源图床项目
- Linux.do 社区用户反馈

上游项目亦声明自身「并非对上述项目的简单复制，而是在相关开源生态、社区反馈和实际使用需求的基础上逐步整理、扩展和实现」。本项目在此之上仅做前端重写与鉴权加固，后端的全部设计功劳归上游作者。

---

## 许可证

[CC0 1.0 Universal](LICENSE) — 与上游保持一致，可自由使用、修改与分发。
