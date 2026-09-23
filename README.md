<div align="center">

<img src="logo.png" alt="K-Vault Logo" width="140">

# K-Vault-Next

**中文** | [English](README-EN.md)

</div>

> 跑在 **Cloudflare Pages** 上的 Serverless 云盘 / 图床，支持 Telegram、R2、S3、Discord、HuggingFace、WebDAV、GitHub 七种存储后端

文件存进你选的存储后端，元数据写进 Cloudflare KV，对外提供直链、预览、目录管理、API Token 和机器可调用接口。

**只有一种部署形态**：Cloudflare Pages（根目录静态页 + `functions/` 下的 Pages Functions）。无构建步骤、无 Docker、无服务器运维，免费额度内零成本。

---

## 它能做什么

- **七种存储后端**，同一个上传入口切换，默认 Telegram
- **三种上传方式**：直传、URL 转存（带 SSRF 防护）、分片上传（R2 原生 multipart 可到 10GB）
- **智能节点选择**：auto 模式下小文件走默认后端，超过阈值的文件自动切到你指定的后端（默认 R2），阈值与后端可在首页设置
- **并行上传**：首页「存储节点」抽屉里可开关，开启后多个文件同时上传。调度按目标节点拆成两个互不阻塞的池子 —— Telegram 直传池与大文件分片池 —— 避免慢速 Telegram 任务占死槽位拖累大文件。大文件并发度用分段控件选 1 或 2（受 Cloudflare 单实例 128MB 内存约束），Telegram 因同一频道约 1 条/秒的限流固定为 1，设置会记在本地；关闭开关即改为逐个上传。访客模式固定串行。
- **管理后台**：文件搜索 / 排序 / 筛选、目录树、收藏、重命名、批量移动与删除、KV/R2 用量监控、API Token 管理
- **文本粘贴（Pastebin）**：语言标记、有效期、访问密码
- **文件预览**：图片、音视频、PDF、Office、Markdown、JSON、CSV、压缩包、邮件、代码文本、3D/CAD 等
- **短分享链** `/s/:slug`，配合有效期 / 密码 / 下载次数上限
- **API v1 + API Token**：与网页登录态完全隔离，按 scope 授权，支持幂等重试
- **访客上传**：可选开启，可限制单文件大小与每日次数
- **管理面 fail-closed**：没配管理员账密时管理接口直接 503，不对公网开放
- **无遥测**：不内置任何第三方上报

---

## 页面一览

| 页面 | 路径 | 说明 |
| :--- | :--- | :--- |
| 首页 / 上传 | `/` | 拖拽、粘贴、批量上传；URL 转存；分片上传；智能节点选择；上传目录树；上传历史；直链 / Markdown / HTML / BBCode 多种格式；按条目配置分享 |
| 管理后台 | `/admin.html` | 文件与目录管理、收藏、用量监控、API Token 管理、**分享管理**（有效期 / 次数 / 取消） |
| 分享页 | `/share.html` | `/s/:slug` 短链的落地页，提供预览与下载；密码保护、失效原因提示 |
| 文本粘贴 | `/paste.html` | 创建 / 列表 / 查看 / 删除 Paste，支持有效期与访问密码 |
| 图片画廊 | `/gallery.html` | 图片浏览、搜索、批量复制直链 / 下载 / 删除 |
| 文件预览 | `/preview.html` | 多格式预览，密码保护的文件会弹出密码输入 |
| WebDAV | `/webdav.html` | WebDAV 上传与 URL 转存 |
| 登录 | `/login.html` | 后台登录（用户名 + 密码） |

---

## 部署教程

### 0. 准备

- 一个 Cloudflare 账号
- Fork 本仓库（或用 `npm run pages:deploy` 从本地直接推）
- 至少一个存储后端的凭据（最简单是 Telegram：一个 Bot Token + 一个 Chat ID）

> **公网部署必须设置 `BASIC_USER` 和 `BASIC_PASS`**。不设的话 `/api/manage/**` 与 `/api/admin/**` 一律返回 `503 ADMIN_AUTH_NOT_CONFIGURED`，后台完全不可用。

### 1. 创建 Pages 项目

Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**，选中你的仓库。

| 配置项 | 填什么 |
| :--- | :--- |
| Framework preset | `None` |
| **Build command** | **留空** |
| **Build output directory** | **留空** |

本项目没有构建步骤，根目录就是静态页 + `functions/`，填了反而会部署失败。

### 2. 绑定 KV（必需）

KV 存放文件元数据、会话、Token、分片任务等。**变量名必须叫 `img_url`**，写成别的名字整个项目跑不起来。

Dashboard → **Workers & Pages → KV** → 创建命名空间 → 回到 Pages 项目 → **Settings → Functions → KV namespace bindings** → Variable name 填 `img_url`，选中刚建的命名空间。

### 3. 绑定 R2（强烈推荐）

R2 是唯一支持大文件原生分片、且不需要 KV 中转分片的后端。**绑定名必须是 `R2_BUCKET`**。

Dashboard → **R2** → 创建存储桶 → 回到 Pages 项目 → **Settings → Functions → R2 bucket bindings** → Variable name 填 `R2_BUCKET`。

不绑的后果：单文件超过 40MB 就传不了，分片暂存退回 KV（单片上限从 50MB 降到 20MB）。

### 4. 配置环境变量

在 **Settings → Environment variables** 里添加，**最小集只有两样：管理员账密 + 一个存储后端**。完整清单见下一章。

环境变量改完需要**重新部署**才生效；但标记为「后台可设置」的那些（CORS、分片后端、访客上传策略）可以在管理后台随时改、**即时生效**，部署时根本不用填。

### 5. R2 生命周期规则（绑了 R2 就必须配）

R2 控制台 → 你的存储桶 → **Settings → Object Lifecycle Rules**，加两条：

| 规则名 | 前缀 | 操作 | 天数 |
| :--- | :--- | :--- | :--- |
| `delete-temp-chunks` | `chunk-upload/` | Delete objects | 1 |
| `abort-incomplete-multipart` | 留空（作用于全桶） | Abort incomplete multipart uploads | 1 |

**不配会怎样**：用户传大文件传到一半关掉页面，那些临时分片会永久占着 R2 空间。代码里只有"用户再次发起上传时顺带清理"的惰性逻辑，覆盖不了用户再也不回来的情况。

### 6. 本地开发

```bash
npm install
npm start          # wrangler pages dev，已内置 --kv img_url --r2=R2_BUCKET
```

访问 `http://localhost:8080`。本地默认账密是 `admin` / `123`（写在 `npm start` 里）。

部署到线上：

```bash
npm run pages:deploy      # 等价于 npx wrangler pages deploy .
```

需要 `wrangler.jsonc` 时可以用内置脚本生成并校验（纯本地生成，不连 Cloudflare API）：

```bash
npm run pages:r2:doctor                              # 打印一份 wrangler.jsonc
node scripts/cloudflare-pages-r2-doctor.js --check   # 校验现有配置
```

### 7. 验证

- 打开 `/` 传个小文件，看能否拿到直链
- 打开 `/admin.html` 用你设的账密登录
- 打开 `/api/status` 看各后端状态（未登录时只返回"是否已配置"，不触发连通性探测）

---

## 环境变量

### 管理员鉴权

| 变量 | 说明 | 默认值 |
| :--- | :--- | :--- |
| `BASIC_USER` | 管理员用户名 | 无（**必填**） |
| `BASIC_PASS` | 管理员密码 | 无（**必填**） |

两者都配好后管理接口才开放，支持 Cookie 会话与 `Authorization: Basic` 两种方式。会话 Cookie 名固定为 `k_vault_session`，不可配置。

### 存储后端（至少配一个）

默认后端是 **Telegram**。`storageMode` 匹配不到任何已配置后端时会回落 Telegram；**变量缺失不会自动降级到其他后端**，而是直接报错。

| 后端 | 必需变量 | 可选变量 | 单文件上限 |
| :--- | :--- | :--- | :--- |
| **Telegram** | `TG_Bot_Token`、`TG_Chat_ID` | `CUSTOM_BOT_API_URL`、`TG_UPLOAD_NOTIFY`、`TELEGRAM_METADATA_MODE`、`TELEGRAM_LINK_MODE`、`PUBLIC_BASE_URL` | 20MB |
| **R2** | `R2_BUCKET`（绑定名，非环境变量） | — | 10GB |
| **S3 兼容** | `S3_ENDPOINT`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`、`S3_BUCKET` | `S3_REGION`（默认 `us-east-1`） | 40MB |
| **Discord** | `DISCORD_BOT_TOKEN` + `DISCORD_CHANNEL_ID`，**或** `DISCORD_WEBHOOK_URL` | — | 25MB |
| **HuggingFace** | `HF_TOKEN`、`HF_REPO` | — | 35MB |
| **WebDAV** | `WEBDAV_BASE_URL` + （`WEBDAV_USERNAME`/`WEBDAV_PASSWORD`）或 `WEBDAV_BEARER_TOKEN` | `WEBDAV_ROOT_PATH`、`WEBDAV_TOKEN` | 40MB |
| **GitHub** | `GITHUB_REPO`、`GITHUB_TOKEN` | `GITHUB_MODE`（`releases`/`contents`）、`GITHUB_PREFIX`、`GITHUB_RELEASE_TAG`、`GITHUB_BRANCH`、`GITHUB_API_BASE` | 40MB（contents 模式 20MB） |

配置细节：

- **变量名大小写不用纠结**：`TG_Bot_Token` / `TG_BOT_TOKEN`、`TG_Chat_ID` / `TG_CHAT_ID` 这类写法**任意一种都会被自动识别**，填一个即可，**不需要再「两个都写上」**。同类别名还有：`TELEGRAM_WEBHOOK_SECRET` / `TG_WEBHOOK_SECRET`、`TG_UPLOAD_NOTIFY` / `TELEGRAM_UPLOAD_NOTIFY`、`FILE_URL_SECRET` / `TG_FILE_URL_SECRET`、`WEBDAV_BEARER_TOKEN` / `WEBDAV_TOKEN`。
- **部分变量可在管理后台改，部署时无需预置**：`API_CORS_ORIGINS`、`CHUNK_BACKEND`、访客上传策略（`GUEST_UPLOAD` / `GUEST_MAX_FILE_SIZE` / `GUEST_DAILY_LIMIT`）在后台「设置」里改完即时生效，不必改环境变量重新部署。
- **Discord** 优先用 Bot Token，失败才回退 Webhook。
- **HuggingFace** 的 `HF_REPO` 是 **dataset** 仓库（`owner/name`），不是 model 仓库。
- **WebDAV** 中 `WEBDAV_BEARER_TOKEN` 优先于 `WEBDAV_TOKEN`，两者都支持。

### 上传与分享

| 变量 | 说明 | 默认值 |
| :--- | :--- | :--- |
| `CHUNK_BACKEND` | 分片暂存位置：`auto`（有 R2 就用 R2）/ `r2` / `kv`（也可后台设置） | `auto` |
| `PUBLIC_BASE_URL` | 生成绝对直链用的站点地址 | 请求 origin |
| `FILE_URL_SECRET` | 签名直链的 HMAC 密钥（`TG_FILE_URL_SECRET` 自动识别） | 依次回落 `TG_FILE_URL_SECRET` → `TG_Bot_Token` → 内置值 |
| `GUEST_UPLOAD` | 是否允许未登录访客上传（`true` 开启） | 关闭 |
| `GUEST_MAX_FILE_SIZE` | 访客单文件大小上限（字节） | 5242880（5MB） |
| `GUEST_DAILY_LIMIT` | 访客每日上传次数（按 IP + 日期计） | 10 |
| `MINIMIZE_KV_WRITES` | `true` 时 Telegram 走签名直链且不写 KV 元数据（后台列表与删除会受影响） | 关闭 |

### Telegram 专项

| 变量 | 说明 | 默认值 |
| :--- | :--- | :--- |
| `CUSTOM_BOT_API_URL` | 自部署 Bot API 服务器地址，替换官方地址 | `https://api.telegram.org` |
| `TG_UPLOAD_NOTIFY` | 上传成功后是否发通知消息（`TELEGRAM_UPLOAD_NOTIFY` 自动识别） | `true` |
| `TELEGRAM_METADATA_MODE` | `off` / `none` / `minimal` 关闭 KV 元数据写入，`on` / `full` 开启 | 开启 |
| `TELEGRAM_SKIP_METADATA` | 未设 `TELEGRAM_METADATA_MODE` 时的替代开关 | 关闭 |
| `TELEGRAM_LINK_MODE` | 设为 `signed` 强制签名直链 | 关闭 |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram Webhook 校验密钥（`TG_WEBHOOK_SECRET` 自动识别） | 无（**未设置时 webhook 不做任何校验**） |

### API

| 变量 | 说明 | 默认值 |
| :--- | :--- | :--- |
| `API_CORS_ORIGINS` | API v1 的 CORS 白名单，逗号分隔；`*` 表示任意来源；留空不发 CORS 头（**建议后台设置，即时生效**） | 空 |

完整清单见 [`.env.example`](.env.example)，已按「必填最小集 → 存储后端 7 选 1 → 可选开关 → 后台可设置」分组，照着填要用的那一段即可。

注意 Cloudflare Pages **不读** `.env` 文件，那只是变量清单参考，实际值要在 Dashboard 或 `wrangler` 里配。

---

## 上传限制

| 后端 | 单文件上限 | 原因 |
| :--- | :--- | :--- |
| R2 | 10GB | R2 原生 multipart 分片 |
| S3 兼容 | 40MB | 需在 Worker 内存中拼装 |
| WebDAV | 40MB | 需在 Worker 内存中拼装 |
| GitHub | 40MB（`contents` 模式 20MB） | 需在 Worker 内存中拼装 |
| HuggingFace | 35MB | LFS 提交 |
| Discord | 25MB | Discord 附件限制（服务器加成可提升，这里取保守值） |
| Telegram | 20MB | Bot API 经 Worker 内存转发 |

分片规则：

- R2 暂存 → **50MB/片**；KV 暂存 → **20MB/片**（KV 单值上限 25MB，留安全余量）
- 单个任务最多 **256** 片
- 前后端必须用同一套分片规则，否则 `init` 会报 `CHUNK_COUNT_MISMATCH`

---

## API 概览

### 鉴权

网页后台走 Cookie 会话或 HTTP Basic；API v1 走 `Authorization: Bearer kvault_<tokenId>_<secret>`。

Token 的 scope 有四种：`upload`、`read`、`delete`、`paste`。Token 还可附加策略：`allowedStorages`、`allowedMimeTypes`、`maxFileSize`、`folderPrefix`、`allowedSourceHosts`、`rateLimit`。

### API v1

| 方法 | 路径 | scope | 说明 |
| :--- | :--- | :--- | :--- |
| GET | `/api/v1/capabilities` | 公开 | 已配置的后端与上传上限 |
| GET | `/api/v1/me` | 任意有效 Token | Token 自省 |
| POST | `/api/v1/upload` | `upload` | multipart 上传，支持 `Idempotency-Key`（24 小时内去重） |
| POST | `/api/v1/import` | `upload` | URL 导入（带 SSRF 校验） |
| GET | `/api/v1/files` | `read` | 分页列表 |
| GET / DELETE | `/api/v1/file/<path>` | `read` / `delete` | 读取直链流 / 删除 |
| GET | `/api/v1/file/<path>/info` | `read` | 元数据 |
| POST | `/api/v1/paste` | `paste` | 创建文本粘贴 |
| GET | `/api/v1/pastes` | `read` | 粘贴列表 |
| GET / DELETE | `/api/v1/paste/<id>` | `read` / `delete` | 读取 / 删除（密码经 `?password=` 或 `X-Paste-Password`） |

机器可读定义见 [`docs/openapi.yaml`](docs/openapi.yaml)，接入指南见 [`docs/agent-integration.md`](docs/agent-integration.md)。

### 分享选项

有效期、访问密码、下载次数上限、自定义短链这四个字段在**前后端均可设置**。

**前端入口**

| 位置 | 可设置项 |
| --- | --- |
| 首页结果卡片 / 历史卡片 → **分享按钮** | 四项全支持。点开弹窗配置，提交后直接给出 `/s/:slug` 链接 |
| 首页「URL 转存」 | 复用同一份分享设置 |
| 文本粘贴页 `/paste.html` | 有效期与密码 |

> 分享是**按条目配置**的：每条文件/历史记录各有一个分享按钮，已分享的条目再点进去就是「管理」态，
> 可以改配置或取消分享，而不是在首页设一个全局开关。

**后端接口**

| 接口 | 传入方式 |
| --- | --- |
| `POST /api/manage/share/:id` | 推荐。JSON `action`（`create` / `update` / `revoke`）+ 四个字段；`update` 时传 `-1` 表示该字段保持不变，传 `0` / `""` 表示清除 |
| `POST /upload` | FormData 扁平字段 `expires_in` / `max_downloads` / `slug` / `password` |
| `POST /api/chunked-upload/init` | JSON `shareOptions` 对象（在 init 阶段即完成校验与短链占用预检） |
| `POST /api/upload-from-url` | JSON `shareOptions` 对象，或扁平字段 |
| `POST /api/v1/upload` | 扁平字段，响应返回 `links.share` |

上传成功后，后端会在响应体中回传分享摘要（`shareSlug` / `sharePath` /
`shareExpiresAt` / `shareMaxDownloads` / `sharePasswordProtected`），
因此刷新页面或从本地历史恢复后，短链依然可以取回并复制。

**访问链路**

```
/s/:slug  ──302──▶  /share.html?s=:slug  ──▶  GET /api/share-info?s=:slug
                                                    │
                                    200 ─────────────┴──────── 401 需密码 / 403 密码错
                                                                410 已过期或次数用尽 / 404 无此分享
```

- `/s/:slug` **只做跳转**，不再直接吐出文件流。
- 分享页 `/share.html` 提供**预览与下载**两个入口；只有点「下载」（即带 `dl=1` 请求）才计入下载次数，
  预览不计次。
- `admin.html` → 工具菜单 → **分享管理**：汇总所有已分享条目，可见有效期、剩余时长、
  已用/总次数、密码状态，并支持按状态筛选、搜索、复制链接与取消分享。

> ⚠️ **行为变更（breaking change）**：早期版本的 `/s/:slug` 会 `302` 到 `/file/:id` 而**直接下载文件**。
> 现在它跳转到分享页。旧链接**无需迁移**即可自动获得新的分享页体验；副作用是直接访问短链的
> 爬虫 / 脚本 / IM 预览会拿到 HTML 而非文件本体，需要在请求里显式带 `dl=1` 才能取到文件。

受保护文件的表现：过期或下载次数用尽返回 `410`，需要密码时返回 `401`，密码错误返回 `403`。
分享页对过期与用尽都会给出明确的失效原因，而不是笼统的「链接无效」。

---

## 目录结构

```text
├── index.html admin.html paste.html gallery.html
├── preview.html webdav.html login.html share.html
├── design-system.css                     # 设计系统：全站唯一的事实来源（令牌/组件/动效）
├── theme.css theme.js mobile-refactor.css
├── functions/                            # Cloudflare Pages Functions 后端
│   ├── api/
│   │   ├── auth/ manage/ admin/ v1/      # 鉴权 / 管理 / Token / API v1
│   │   ├── chunked-upload/               # 分片上传 init / chunk / complete
│   │   ├── share-info.js                 # 分享页只读信息（公开）
│   │   └── status.js upload-from-url.js telegram/webhook.js
│   ├── file/[[path]].js                  # 文件直链（多层路径、密码、黑白名单）
│   ├── file-info/[[path]].js             # 文件元信息
│   ├── s/[slug].js                       # 短分享链 → 302 到 /share.html
│   └── utils/                            # 存储适配器与公共工具（含 share-options.js）
├── scripts/                              # wrangler 配置生成 / 校验工具
│   └── check_style.py check_tokens.py strip_css.py   # 样式一致性守卫
├── docs/                                 # OpenAPI、接入指南、完整配置参考
└── .env.example                          # 变量清单（Pages 不读此文件）
```

---

## 设计系统（design-system.css）

所有页面共用一份 `design-system.css`，它是**令牌、通用组件、动效关键帧、Vue 过渡族的唯一事实来源**，
页面级 `<style>` 里只允许出现「本页特有的增量」，不允许重复定义共享实现。

| 类别 | 内容 |
| --- | --- |
| 设计令牌 | 品牌色 / 语义色 / 玻璃质感 / 文字 / 阴影 / 圆角 / 间距 / 字号 / 控件高度 / 缓动（4 档）/ 时长（5 档） |
| 通用组件 | `.card`（`.liquid-card` 为历史别名）、`.btn--primary / --danger / --ghost / --icon / --sm / --lg / --block`、`.text-btn`、`.input / .select / .textarea / .field`、`.switch`、`.spinner`、`.toast-stack / .toast`、`.empty-state`、`.check`、`.progress` |
| 动效 | 37 个关键帧（`riseIn` / `riseInSm` / `scaleIn` / `dockIn` / `pop` / `sheetIn` / `dialogIn` / `maskIn` …）+ 入场编排 `.boot-rise` 系列 |
| 过渡族 | `fade / pop / rise / drop / bar / ctrl / toast / list / menu / sheet / dialog / view-forward / view-back` … |
| 无障碍 | `prefers-reduced-motion`、`prefers-reduced-transparency`、`html[data-perf="low"]` 低端设备降级 |

改动约定：

- 新组件优先写进 `design-system.css`，不要在各页面里各写一份。
- 旧写法 `.btn-primary` / `.btn-danger` / `.btn-ghost` / `.btn-block` 仍作为兼容别名保留，新代码请用 `--` 双连字符写法。
- 改完跑一次守卫脚本，确保没有回归：

```bash
python3 scripts/check_style.py     # 括号平衡 / 禁止页面内定义 @keyframes / 必须引入设计系统
python3 scripts/check_tokens.py    # 所有 var(--x) 与 animation 名称都能解析到定义
```

---

## 完整文档

| 文档 | 内容 |
| :--- | :--- |
| [`docs/README-full-reference.md`](docs/README-full-reference.md) | 全部环境变量、各后端配置步骤、API 用法、使用限制 |
| [`docs/openapi.yaml`](docs/openapi.yaml) | API v1 机器可读定义 |
| [`docs/agent-integration.md`](docs/agent-integration.md) | Agent / 脚本接入指南 |
| [`docs/cloudflare-pages-r2.md`](docs/cloudflare-pages-r2.md) | Cloudflare Pages R2 绑定排查 |
| [`PROJECT_INTRO.md`](PROJECT_INTRO.md) | 项目定位与架构说明 |

---

## 致谢

后端能力源自 **K-Vault**，感谢原作者与社区：

- katelya77/K-Vault — 后端能力的来源
- Telegraph-Image — 早期 Serverless 图床形态参考
- CloudFlare-ImgBed — 同类优秀开源图床项目
- Linux.do 社区用户反馈

本项目在上游基础上完成了前端重写、鉴权加固、分片上传升级、多层路径路由等工作。

## 许可证

CC0 1.0 Universal — 可自由使用、修改与分发。
