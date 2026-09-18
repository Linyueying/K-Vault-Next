<div align="center">

<img src="logo.png" alt="K-Vault Logo" width="140">

# K-Vault · 一云

> 免费图片 / 文件托管方案，基于 **Cloudflare Pages** 部署，兼容 Telegram、R2、S3、Discord、HuggingFace、WebDAV、GitHub 七种存储后端

[English](README-EN.md) | **中文**

![GitHub stars](https://img.shields.io/github/stars/YOUR_GITHUB/YOUR_REPO?style=flat-square)
![GitHub forks](https://img.shields.io/github/forks/YOUR_GITHUB/YOUR_REPO?style=flat-square)
![GitHub license](https://img.shields.io/github/license/YOUR_GITHUB/YOUR_REPO?style=flat-square)

</div>

---

## 这是什么

K-Vault 是一个以 **Telegram 为核心**的 Serverless 聚合云盘 / 图床：上传的文件进入你自选的存储后端，元数据落在 Cloudflare KV，对外提供直链、预览、目录管理、API Token 与机器可调用的 API v1。

本项目**只提供一种部署形态**：

| 形态 | 运行方式 | 适合场景 |
| :--- | :--- | :--- |
| **Cloudflare Pages** | 根目录静态页 + `functions/` Pages Functions | 免费额度内零成本、边缘加速、全球可用 |

> Docker / Nginx 自托管部署已从本仓库移除。`server/` 目录作为上游 Node 运行时源码保留（供参考与二次开发），**不再是受支持的部署目标**，其专属能力（动态存储配置管理、审计日志查询、签名分享链接）在 Pages 部署下不可用。

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
- **多种视图** — 网格、列表
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

- **单一部署形态** — Cloudflare Pages（静态页 + Pages Functions），无构建步骤
- **GitHub Actions** — 仅保留 Pages 部署说明与 CI 测试工作流

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
- **彻底移除 Sentry 遥测** — 前后端上报链路与 npm 依赖一并清除，见下方「3. 移除 Sentry 遥测」。
- **图标库锁版本** — FontAwesome 由不固定版本改为固定 `@6.4.2`。
- **改用国内可达 CDN** — Vue 2.6.14 由 jsdelivr 换成 bootcdn，改善国内首屏加载。
- **自研 Design Token 样式体系** — 页面样式统一基于 CSS 变量（`--primary` / `--text-main` / `--surface-*` / `--ease-fluid` 等），配合保留的 `theme.css` / `theme.js` 实现亮暗主题与全站 UI 配置联动。
- **品牌化** — 页面标题调整为自有品牌（首页「一云」、`gallery.html`「影像画廊 | K-Vault」、`admin.html`「K-Vault · 管理后台」）。

### 2. 安全加固

上游与 Pages / Node 两端统一收敛了管理面鉴权：

| 加固项 | 说明 |
| :--- | :--- |
| **`POST /api/upload-from-url` 补上访客门槛** | 此前该接口在 Cloudflare Pages 上**完全无鉴权**，任何人可让服务端拉取任意远程 URL 并写入你的存储后端。现与 Node 运行时行为对齐：管理员放行，访客需 `GUEST_UPLOAD=true` 且满足大小/次数限制 |
| **`/api/manage/**` 改为 fail-closed** | 此前未配置 `BASIC_USER` / `BASIC_PASS` 时**整个管理接口对公网开放**（含删除、重命名、移动、黑白名单）。现统一返回 `503 ADMIN_AUTH_NOT_CONFIGURED`，与 `/api/admin/**` 策略一致；保留的 Node 运行时同样覆盖 `/api/storage/**`、`/api/settings`、`POST /api/ui-config`、`POST /api/share/sign` |
| **修复 `/api/manage/login` 不可达** | 该登录入口此前被同目录中间件拦截，导致 `gallery.html` 的 401 恢复路径落到纯文本 401 而非登录页。现豁免该路由，未登录 302 跳 `/login.html`，已登录跳 `/admin.html` |
| **`GET /api/status` 分级返回** | 未登录访客只拿到「各后端是否可用 + 访客配置 + 上传上限 + 能力清单」，且**不再触发任何后端连通性探测**；连通性结果、后端错误详情、机器人身份等诊断信息仅管理员可见 |

### 3. 移除 Sentry 遥测

上游在 Pages Functions 里内置了一套**默认开启**的 Sentry 上报，并且指向的是上游作者自己的项目。本项目将其整块移除。

**上游的行为**（`functions/utils/middleware.js`）：

- 每个请求都会把 headers、Cloudflare 请求属性（`request.cf`）、URL、method、redirect 等打上 Sentry 标签上报
- 硬编码 DSN 指向 `o4507041519108096.ingest.us.sentry.io` —— **上游作者的 Sentry 项目**
- 还会额外请求 `https://frozen-sentinel.pages.dev/signal/sampleRate.json` —— 上游作者自己的 Pages 站点
- 只有显式设置 `disable_telemetry` 才会关闭；而 `import` 在模块顶层，**依赖无论如何都必须能解析**

也就是说，直接部署上游版本，你的实例的请求元数据会回流到上游作者那里。

**本项目的改动**：

| 变更 | 说明 |
| :--- | :--- |
| 删除 `functions/utils/middleware.js` | 遥测模块本体（Sentry 插件封装、标签/事务上报、采样率拉取）全部移除 |
| 删除 `functions/_middleware.js`、`functions/api/_middleware.js`、`functions/file/_middleware.js` | 这三个文件原本只是挂载遥测中间件的空转链，遥测移除后无任何作用 |
| 清理 `functions/upload.js` | 移除 `errorHandling` / `telemetryData` 的导入与两处无效调用（其返回值原本就被丢弃） |
| 移除 `package.json` 依赖 | 删除 `@cloudflare/pages-plugin-sentry`、`@sentry/tracing` |
| 同步 `package-lock.json` | 连带删除 6 个锁条目（含 4 个 `@sentry/*` 传递依赖），保持 `npm ci` 可用的锁一致性 |

**收益**：

1. **无数据外流** —— 不再有任何请求元数据发往第三方
2. **Functions 零外部依赖** —— Pages 打包不再有 `Could not resolve "@cloudflare/pages-plugin-sentry"` 的风险，**Build command 可以真正留空**
3. 少一个 devDependency 安装负担，代码更少

保留的鉴权中间件（`functions/api/v1/_middleware.js`、`functions/api/admin/_middleware.js`、`functions/api/manage/_middleware.js`）不受影响。

> 注：文档中 `disable_telemetry` / `sampleRate` 两个环境变量现已失效（遥测代码已不存在），保留在参考文档中仅为对照上游。

### 4. 死代码清理

- 移除 8 个与 `/api/manage/*` 完全重复、无任何调用者的 `/api/drive/*` 路由
- 移除 4 个无调用者的兼容别名（`GET /api/manage/check`、`GET/POST /api/manage/logout`、`GET /api/auth/login`、`GET /api/chunked-upload/init`）——其中 `manage/logout` 与 `chunked-upload/init` 因其真实兼容价值已**恢复保留**
- 移除 Pages 侧死文件 `functions/api/r2/upload.js`（无调用者、无文档、无鉴权）
- `server/app.js` 净减约 210 行，路由 79 → 69

---

### 5. 本次改造：移除 Docker 部署 + 补齐缺失面板

**（1）只保留 Cloudflare Pages 部署**

| 动作 | 内容 |
| :--- | :--- |
| 删除部署产物 | `Dockerfile`、`docker-compose.yml`、`.dockerignore`、`docker/`（Nginx 配置与 entrypoint）、`server/.dockerignore` |
| 删除 Docker 文档 | `README-DOCKER.md`、`README-DOCKER-EN.md`，并清理 `README.md` / `docs/` 中的 Docker 章节 |
| 删除镜像工作流 | `.github/workflows/docker-image.yml`、`.github/workflows/docker-smoke.yml` |
| 删除 Docker 脚本 | `scripts/bootstrap-env.js`、`scripts/bootstrap-env.sh`、`scripts/docker-ci-smoke.js`、`scripts/docker-storage-doctor.js`、`scripts/storage-regression.js` |
| 清理 npm 脚本 | 移除全部 `docker:*` 与 `regression:storage` |
| 保留 | `server/` Node 运行时源码（不再是受支持的部署目标）、`docs/`、`test/` 中的服务端测试 |
| 回归保护 | `test/deployment-contract.test.js` 新增断言：上表文件必须不存在，且 `package.json` 不得再有 `docker:` 脚本 |

**（2）删除旧版后台页面**

`admin-imgtc.html`（Element UI 版后台）、`admin-waterfall.html`（瀑布流后台）及配套的 `admin-imgtc.css` 已删除。这两个页面此前就是**孤儿页**（没有任何页面链接过去），删除后后台能力统一收敛到 `admin.html`。

**（3）新上传时可直接设置有效期 / 密码 / 下载次数 / 短链**

`/api/v1/upload` 早就支持 `expires_in`、`password`、`max_downloads`、`slug`，但它们只挂在需要 Token 的 API 上，而网页上传走的 `POST /upload` **完全不接受这些字段**，所以网页端一直用不了。本次补齐：

| 改动 | 文件 |
| :--- | :--- |
| 抽出共享实现（字段解析、校验、元数据合并、短链映射） | 新增 `functions/utils/share-options.js` |
| 网页直传支持四个字段（仅管理员；访客被拒，避免短链抢占） | `functions/upload.js` |
| 分片上传链路同样支持（初始化时预留短链，合并时写元数据） | `functions/api/chunked-upload/init.js`、`complete.js` |
| 上传抽屉新增「分享设置」标签页 | `index.html` |
| 受密码保护文件：内联密码表单 + 自动重试；410 明确提示过期 / 超限 | `preview.html` |

> 若 Telegram 关闭了元数据写入（`TELEGRAM_METADATA_MODE=off` 或 `TELEGRAM_SKIP_METADATA=1`），这四个字段就无处存放 —— 此时请求会被**显式拒绝**（409），而不是给出一个看似受保护、实际没有保护的链接。

**（4）补齐后台面板**

| 面板 | 状态 | 实现 |
| :--- | :--- | :--- |
| API Token 管理 | ✅ 已补齐 | `admin.html`「工具 → API Token 管理」：列出 / 新建 / 编辑（权限、策略、有效期、启停）/ 轮换 / 删除；密钥仅在创建与轮换时显示一次 |
| 文本粘贴（Pastebin） | ✅ 已补齐 | 新增 `paste.html` + 会话鉴权端点 `functions/api/manage/paste.js`、`functions/api/manage/paste/[id].js`（复用 `utils/paste-store.js`） |
| 前端 UI 设计面板 | ❌ 仍未提供 | 读写能力保留在 `theme.js` 的 `UIDesignManager` 与 `/api/ui-config` 中 |

---

## 已知差异 / 待补齐

| 能力 | 上游 `admin.html` | 本项目 `admin.html` | 后端接口 |
| :--- | :---: | :---: | :--- |
| API Token 管理 | ✅ | ✅ 已补齐 | `/api/admin/tokens*` |
| 文本粘贴 | ❌（仅 API） | ✅ 已补齐（`paste.html`） | `/api/manage/paste*`、`/api/v1/paste*` |
| 上传有效期 / 密码 / 下载次数 / 短链 | ❌（仅 API） | ✅ 已补齐 | `POST /upload`、分片上传 |
| 文件黑白名单 | ✅ | ❌ | `/api/manage/block|white/:id` |
| 前端 UI 设计面板 | ✅ | ❌ | `GET/POST /api/ui-config` |

**黑白名单是目前唯一「后端就绪、前端完全没有入口」的能力**：新版 `admin.html` 从未实现它，此前依赖 `admin-imgtc.html` 兜底，而该页面已按本次要求删除。如需恢复，可在 `admin.html` 的卡片操作与批量操作里调用 `/api/manage/block/:id` 与 `/api/manage/white/:id` 补上。

---

## 快速开始

### Cloudflare Pages 部署

1. Fork 本仓库
2. Cloudflare Dashboard → Workers & Pages → 创建 Pages 项目 → 连接本仓库
3. **Build command 与 Build output directory 都留空**（本项目无构建步骤）
4. 绑定 KV：变量名必须是 `img_url`
5. 配置环境变量（至少 `TG_Bot_Token`、`TG_Chat_ID`；公网部署**必须**设 `BASIC_USER` / `BASIC_PASS`）
6. 部署完成后访问 `/` 上传、`/admin.html` 管理

> 本仓库不提供 Docker / Nginx 自托管部署路径：`Dockerfile`、`docker-compose.yml`、`docker/`、`.env.example` 对应的容器编排脚本均已移除。根目录的 `.env.example` 仅作为保留的 `server/` Node 运行时的配置模板。

---

## 页面一览

| 页面 | 路径 | 说明 |
| :--- | :--- | :--- |
| 首页 / 上传 | `/` | 批量上传、拖拽、粘贴上传；抽屉内可设置有效期 / 密码 / 下载次数 / 自定义短链 |
| 管理后台 | `/admin.html` | 文件管理、目录树、收藏、存储状态、**API Token 管理** |
| 文本粘贴 | `/paste.html` | Pastebin：创建 / 列表 / 查看 / 删除，支持语言标记、过期与访问密码 |
| 图片浏览 | `/gallery.html` | 影像画廊 |
| WebDAV | `/webdav.html` | WebDAV 上传 / 状态检查 / URL 上传 |
| 文件预览 | `/preview.html` | 多格式预览（图片、视频、音频、PDF、docx、txt 等），受密码保护的文件会弹出密码输入 |
| 登录 | `/login.html` | 后台登录 |
| 拦截提示 | `/block-img.html`、`/whitelist-on.html` | 黑名单 / 白名单模式提示页 |

---

## 目录结构

```
├── index.html                  # 首页 / 上传（含分享设置抽屉）
├── admin.html                  # 管理后台（重写，含 API Token 管理面板）
├── paste.html                  # 文本粘贴（Pastebin）前端
├── gallery.html                # 影像画廊（重写）
├── webdav.html / preview.html / login.html
├── theme.css / theme.js        # 主题与全站 UI 设计配置
├── functions/                  # Cloudflare Pages Functions 后端
│   ├── api/                    # auth / manage（含 paste） / admin / v1 / chunked-upload ...
│   ├── file/[id].js            # 文件直链、黑白名单、密码 / 过期 / 下载次数校验
│   ├── utils/share-options.js  # 有效期 / 密码 / 下载次数 / 短链的共享实现
│   └── s/[slug].js             # 短分享链
├── server/                     # 上游 Node 运行时（Hono）源码保留，非部署目标
│   ├── app.js                  # 全部路由
│   ├── lib/                    # 仓储层、存储适配器、鉴权、SSRF 防护
│   └── db/                     # SQLite schema
├── test/                       # 测试（含部署契约与 Pages 上传路由回归）
├── docs/                       # OpenAPI、接入指南、完整配置参考
├── scripts/                    # Cloudflare Pages R2 绑定排查
└── .github/workflows/          # 仅 Pages 说明与 CI 测试
```

---

## 完整文档

| 文档 | 内容 |
| :--- | :--- |
| [docs/README-full-reference.md](docs/README-full-reference.md) | **完整配置参考**：全部环境变量、各存储后端详细配置步骤、API 使用指南、ShareX 配置、使用限制 |
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
