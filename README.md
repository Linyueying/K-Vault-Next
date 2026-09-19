# K-Vault-Next · 一云

> 基于 **Cloudflare Pages** 的 Serverless 云盘 / 图床，支持 Telegram、R2、S3、Discord、HuggingFace、WebDAV、GitHub 七种存储后端

---

## 这是什么

K-Vault-Next 是一个轻量、免费、可自部署的 Serverless 云盘。文件上传到你选择的存储后端，元数据写入 Cloudflare KV，对外提供直链、预览、目录管理、API Token 与机器可调用接口。

**只有一种部署形态**：Cloudflare Pages（静态页 + Pages Functions）。无构建步骤，无 Docker，无服务器运维，免费额度内**零成本**。

---

## 核心特性

### 存储与上传

- **七种存储后端**：Telegram、Cloudflare R2、S3 兼容（AWS / MinIO / B2 / 阿里云 OSS 等）、Discord、HuggingFace、WebDAV、GitHub
- **大文件分片上传**：50MB 分片，R2 单文件上限 **10GB**；非 R2 后端 40MB
- **智能节点分流**：一键启用 auto 模式，小文件自动走 Telegram，大文件自动走用户首选后端
- **URL 远程转存**：服务端拉取远程 URL 后转存，内置 SSRF 防护
- **访客上传**：可选开启，支持单文件大小与每日次数限制
- **分享设置**：上传时可直接设置有效期、访问密码、下载次数上限、自定义短链
- **多格式支持**：图片、视频、音频、文档、压缩包等

### 管理后台

- **文件管理**：搜索、排序、按存储后端筛选、分页游标加载
- **目录树**：新建 / 重命名 / 移动 / 递归删除，文件批量移动
- **收藏与重命名**：单文件收藏标记、显示名重命名（不改动公开直链）
- **API Token 管理**：列出 / 新建 / 编辑（权限、策略、有效期、启停）/ 轮换 / 删除
- **文本粘贴（Pastebin）**：创建 / 列表 / 查看 / 删除，支持语言标记、过期与访问密码
- **存储状态面板**：各后端连通性、上传上限、访客配置

### API 与自动化

- **API Token 体系**：与网页登录态完全隔离，可吊销 / 轮换；`scopes` 按需授权
- **Token 策略**：`allowedStorages` 限定后端、`folderPrefix` 限定目录、`maxFileSize` 限定大小
- **幂等重试**：`Idempotency-Key` 24 小时内去重，网络重试不产生重复文件
- **内容去重**：≤25MB 重复内容走 SHA-256 索引自动去重
- **API v1**：文件上传 / 列表 / 下载 / 删除 + 文本 Paste 创建 / 读取 / 删除
- **CORS 白名单**：通过 `API_CORS_ORIGINS` 控制跨域来源
- **机器可读文档**：见 [docs/openapi.yaml](docs/openapi.yaml)，接入指南见 [docs/agent-integration.md](docs/agent-integration.md)

### 安全

- **管理接口 fail-closed**：未配置 `BASIC_USER` / `BASIC_PASS` 时，`/api/manage/**`、`/api/admin/**` 直接返回 `503`，而非开放给公网
- **访客门槛统一**：`POST /api/upload-from-url` 与其它上传路径行为对齐，访客受 `GUEST_UPLOAD=true` 与大小 / 次数限制
- **`GET /api/status` 分级返回**：访客仅看到后端可用性、上传上限、能力清单；连通性诊断信息仅管理员可见
- **无遥测**：不内置任何第三方上报，无数据外流

---

## 页面一览

| 页面 | 路径 | 说明 |
| :--- | :--- | :--- |
| 首页 / 上传 | `/` | 批量上传、拖拽、粘贴上传；可设置有效期 / 密码 / 下载次数 / 短链 |
| 管理后台 | `/admin.html` | 文件管理、目录树、收藏、存储状态、API Token 管理 |
| 文本粘贴 | `/paste.html` | Pastebin：创建 / 列表 / 查看 / 删除 |
| 图片浏览 | `/gallery.html` | 影像画廊 |
| WebDAV | `/webdav.html` | WebDAV 上传 / 状态检查 / URL 上传 |
| 文件预览 | `/preview.html` | 多格式预览，受密码保护的文件弹出密码输入 |
| 登录 | `/login.html` | 后台登录 |


---

## 快速开始

### Cloudflare Pages 部署

1. Fork 本仓库
2. Cloudflare Dashboard → Workers & Pages → 创建 Pages 项目 → 连接本仓库
3. **Build command 与 Build output directory 都留空**（无构建步骤）
4. 绑定 KV：**变量名必须是 `img_url`**
5. 配置环境变量（至少 `TG_Bot_Token`、`TG_Chat_ID`；公网部署**必须**设 `BASIC_USER` / `BASIC_PASS`）
6. 部署完成后访问 `/` 上传、`/admin.html` 管理

### R2 生命周期规则（配了 R2 的必须配）

在 Cloudflare R2 控制台 → 你的存储桶 → **Settings → Object Lifecycle Rules**，添加两条规则：

| 规则名 | 前缀 | 操作 | 天数 |
| :--- | :--- | :--- | :--- |
| `delete-temp-chunks` | `chunk-upload/` | Delete objects | 1 |
| `abort-incomplete-multipart` | （留空） | Abort incomplete multipart uploads | 1 |

**不配会导致大文件上传中断后临时分片永久占用空间。**

---

## 目录结构

```
├── index.html                  # 首页 / 上传
├── admin.html                  # 管理后台
├── paste.html                  # 文本粘贴前端
├── gallery.html                # 影像画廊
├── webdav.html / preview.html / login.html
├── theme.css / theme.js        # 主题与全站 UI 配置
├── functions/                  # Cloudflare Pages Functions 后端
│   ├── api/
│   │   ├── chunked-upload/     # 分片上传（init / chunk / complete）
│   │   ├── auth/ manage/ admin/ v1/
│   │   └── status.js
│   ├── file/[[path]].js        # 文件直链（支持多层路径）
│   ├── file-info/[[path]].js   # 文件元信息
│   ├── utils/
│   │   ├── chunk-limits.js     # 分片共享常量
│   │   ├── share-options.js    # 有效期 / 密码 / 下载次数 / 短链
│   │   └── auth.js 等
│   └── s/[slug].js             # 短分享链
├── server/                     # 上游 Node 运行时源码（非部署目标，仅供参考）
├── test/                       # 测试
├── docs/                       # OpenAPI、接入指南、完整配置参考
└── .github/workflows/          # 仅 CI 测试
```

---

## 完整文档

| 文档 | 内容 |
| :--- | :--- |
| [docs/README-full-reference.md](docs/README-full-reference.md) | **完整配置参考**：全部环境变量、各后端详细配置步骤、API 使用指南、ShareX 配置、使用限制，部分内容可能不适用于Next版 |
| [docs/oenapi.yaml](docs/openapi.yaml) | API v1 机器可读定义 |
| [docs/agent-integration.md](docs/agent-integration.md) | Agent / 脚本接入指南 |
| [docs/cloudflare-pages-r2.md](docs/cloudflare-pages-r2.md) | Cloudflare Pages R2 绑定排查 |
| [PROJECT_INTRO.md](PROJECT_INTRO.md) | 项目定位与架构说明 |

---

## 致谢

本项目的后端实现来自 **K-Vault**，感谢原作者与社区：

- [katelya77/K-Vault](https://github.com/katelya77/K-Vault) — 全部后端能力的来源
- [Telegraph-Image](https://github.com/cf-pages/Telegraph-Image) — 早期 Serverless 图床形态参考
- [CloudFlare-ImgBed](https://github.com/MarSeventh/CloudFlare-ImgBed) — 同类优秀开源图床项目
- Linux.do 社区用户反馈

本项目在上游基础上主要完成了前端重写、鉴权加固、分片上传升级（50MB / 10GB）、多层路径路由、KV 写入优化等工作。

---

## 许可证

[CC0 1.0 Universal](LICENSE) — 可自由使用、修改与分发。
