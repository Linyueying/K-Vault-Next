# 存储后端逐步配置

Telegram / R2 / S3 / Discord / HuggingFace / WebDAV / GitHub 七种后端逐一怎么配。

> [!NOTE]
> 本篇内容源自上游 `katelya77/K-Vault` 的 README（见
> [`../archive/upstream-k-vault-reference.md`](../archive/upstream-k-vault-reference.md)），
> 是目前全仓库**唯一**保留这些逐步配置步骤的地方，故单独拆出。
>
> 但它描述的部分能力与 K-Vault-Next 的当前行为可能有出入 —— 环境变量的
> **准确清单请以 [`README.md`](../../README.md) 与 [`.env.example`](../../.env.example) 为准**，
> 本篇只用来查「某个后端具体怎么一步步配起来」。

---

## 存储配置

### Telegram 增强模式（自部署 Bot API + Webhook）

项目已支持将 Telegram API 基础地址切换为自部署 Bot API，并支持通过 Webhook 在群/频道接收文件后自动回复直链。

**关键环境变量：**

| 变量名 | 说明 | 示例 |
| :--- | :--- | :--- |
| `CUSTOM_BOT_API_URL` | 自部署 Bot API 地址（不填则默认 `https://api.telegram.org`） | `http://127.0.0.1:8081` |
| `PUBLIC_BASE_URL` | Webhook 回链时使用的公网域名（建议填写） | `https://img.example.com` |
| `TG_WEBHOOK_SECRET` | Webhook 密钥，校验头 `X-Telegram-Bot-Api-Secret-Token` | `your-secret` |
| `TELEGRAM_LINK_MODE` | Telegram 链接模式，设为 `signed` 启用签名直链 | `signed` |
| `MINIMIZE_KV_WRITES` | 设为 `true` 时启用低 KV 写入策略（也会启用签名直链） | `true` |
| `TELEGRAM_METADATA_MODE` | Telegram 元数据写入策略：`off` 关闭后台索引写入，默认写轻量索引 | `off` |
| `TG_UPLOAD_NOTIFY` | 网页上传成功后，是否额外发送“直链+File ID”通知消息 | `true` |
| `FILE_URL_SECRET` | 签名直链密钥（不填则回退到 `TG_Bot_Token`） | `random-long-secret` |

**Webhook 部署步骤：**

1. 在 Telegram 中把 Bot 拉进目标频道/群并授予发言权限（频道建议管理员）。
2. 在 Cloudflare Pages 中配置 `TG_Bot_Token`、`PUBLIC_BASE_URL`、`TG_WEBHOOK_SECRET`，然后重新部署。
3. 调用 `setWebhook` 指向本项目接口：`https://你的域名/api/telegram/webhook`。
4. 频道/群内发送图片或文件，Bot 会自动回复 `/file/...` 直链。

**`setWebhook` 示例（官方 API）：**

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"https://img.example.com/api/telegram/webhook\",\"secret_token\":\"<YOUR_SECRET>\",\"allowed_updates\":[\"message\",\"channel_post\"]}"
```

**`setWebhook` 示例（自部署 Bot API）：**

```bash
curl -X POST "http://127.0.0.1:8081/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"https://img.example.com/api/telegram/webhook\",\"secret_token\":\"<YOUR_SECRET>\",\"allowed_updates\":[\"message\",\"channel_post\"]}"
```

**Webhook 验证与排查：**

1. `setWebhook` 返回 `{"ok":true,"result":true}` 只代表 Telegram 接受了 webhook 地址，不代表 Bot 已经成功回链。
2. 调用 `getWebhookInfo` 查看 Telegram 是否正在向你的 Pages 域名投递更新：

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo"
```

3. 在群/频道发送图片或文件后，查看 Cloudflare Pages Functions 日志。K-Vault 的 webhook POST 响应会包含：
   - `directLink`：生成的 `/file/...` 链接
   - `reply.ok`：是否成功调用 `sendMessage`
   - `reply.reason`：失败时的 Telegram API 描述或跳过原因
4. 如果 `reply.ok=false`：
   - 确认 Bot 在频道中是管理员，或在群里有发言权限。
   - 确认 `TG_UPLOAD_NOTIFY` / `TELEGRAM_UPLOAD_NOTIFY` 没有被设置为 `false`。
   - 如果设置了 `TG_WEBHOOK_SECRET`，`setWebhook` 的 `secret_token` 必须完全一致。
   - 群聊场景如果 Bot 收不到普通消息，关闭 BotFather 中的隐私模式，或让用户显式 @Bot。

> **关于 2G 文件：**  
> 使用自部署 Bot API（`CUSTOM_BOT_API_URL`）并由 Telegram 客户端直接发到群/频道，再由 Webhook 回链，可利用 Bot API 大文件能力（常见可到 2GB）。  
> 但网页上传链路仍受当前前端策略与 Cloudflare 请求体限制影响（见下方“使用限制”），不等同于前端直接上传 2GB。
>
> **注意：** 自部署 Bot API 下载文件会先缓存到本地磁盘，请预留足够空间并关注 I/O。

### Telegram 低 KV 写入模式（可选）

当你担心 Cloudflare KV 每日读写额度不够时，可以启用：

- `TELEGRAM_LINK_MODE=signed`（仅 Telegram 文件使用签名直链）
- 或 `MINIMIZE_KV_WRITES=true`（同时影响分片上传任务写入策略）

启用后，Telegram 文件默认仍会写入轻量 KV 索引（用于后台列表和管理操作），下载时通过签名参数直接解析 `file_id`，从而降低 KV 读写压力。设置 `TELEGRAM_METADATA_MODE=off` 时，签名 Telegram 上传会跳过 API 上传后的 KV 元数据探测：`password`、`expires_in`、`max_downloads`、`slug` 会被忽略，响应也不提供删除链接。设置 `MINIMIZE_KV_WRITES=true` 时，API Token 鉴权仍需读取 KV，但 `lastUsedAt` 仅在首次使用及之后至少间隔一小时才写回。

> **可选取舍：** 若你希望 Telegram 文件完全不写入 KV，请额外设置 `TELEGRAM_METADATA_MODE=off`。此时文件不会出现在后台列表，也无法使用依赖 KV 元数据的标签/黑白名单/删除流程。

### KV 存储（图片管理，必需）

启用图片管理功能需要配置 KV：

1. 进入 Cloudflare Dashboard → `Workers 和 Pages` → `KV`
2. 点击 `创建命名空间`，命名为 `k-vault`
3. 进入 Pages 项目 → `设置` → `函数` → `KV 命名空间绑定`
4. 添加绑定：变量名 `img_url`，选择创建的命名空间
5. 重新部署项目

### R2 存储（大文件支持，可选）

配置 R2 可支持最大 100MB 文件上传：

1. **创建存储桶**
   - Cloudflare Dashboard → `R2 对象存储` → `创建存储桶`
   - 命名为 `k-vault-files`

2. **绑定到项目**
   - Pages 项目 → `设置` → `函数` → `R2 存储桶绑定`
   - 变量名 `R2_BUCKET`，选择存储桶

3. **启用 R2**
   - `设置` → `环境变量` → 添加 `USE_R2` = `true`
   - 重新部署

> 如果重新部署时报 `binding R2_BUCKET of type r2_bucket contains an invalid jurisdiction`，说明 Cloudflare Pages 在校验 R2 绑定元数据时失败，不是上传代码报错。普通 R2 桶不要设置 `jurisdiction`；只有带数据驻留限制的桶才使用 `eu` 或 `fedramp`。按 [Cloudflare Pages R2 绑定排查](./cloudflare-pages-r2.md) 删除并重建 Production/Preview 绑定，或运行 `npm run pages:r2:doctor -- --check` 校验 `wrangler.jsonc`。

### S3 兼容存储（可选）

支持任何 S3 兼容的对象存储服务，包括 AWS S3、MinIO、BackBlaze B2、阿里云 OSS 等。

**环境变量：**

| 变量名 | 说明 | 示例 |
| :--- | :--- | :--- |
| `S3_ENDPOINT` | S3 服务端点 URL | `https://s3.us-east-1.amazonaws.com` |
| `S3_REGION` | 区域 | `us-east-1` |
| `S3_ACCESS_KEY_ID` | 访问密钥 ID | `AKIA...` |
| `S3_SECRET_ACCESS_KEY` | 秘密访问密钥 | `wJalr...` |
| `S3_BUCKET` | 存储桶名称 | `my-filebed` |

**不同服务商的 Endpoint 示例：**

| 服务商 | Endpoint 格式 | Region |
| :--- | :--- | :--- |
| AWS S3 | `https://s3.{region}.amazonaws.com` | `us-east-1` 等 |
| MinIO | `https://minio.example.com:9000` | `us-east-1` |
| BackBlaze B2 | `https://s3.{region}.backblazeb2.com` | `us-west-004` 等 |
| 阿里云 OSS | `https://oss-{region}.aliyuncs.com` | `cn-hangzhou` 等 |
| Cloudflare R2 | `https://{account_id}.r2.cloudflarestorage.com` | `auto` |

**部署步骤：**

1. 在你的 S3 服务商创建存储桶
2. 获取 Access Key ID 和 Secret Access Key
3. 在 Cloudflare Pages 项目中添加上述环境变量
4. 重新部署，前端将自动显示 S3 存储选项

### Discord 存储（可选）

通过 Discord 频道存储文件，支持 Webhook 和 Bot 两种方式。

> **注意：** Discord 附件 URL 会在约 24 小时后过期。本项目通过代理方式提供文件下载，每次请求时自动刷新 URL。当前版本会优先使用 Bot 查询消息，并在失败时自动回退到 Webhook 查询。若同时配置 Bot + Webhook，请确保 Bot 对 Webhook 所在频道具备读取权限。

**环境变量：**

| 变量名 | 说明 | 必需 |
| :--- | :--- | :---: |
| `DISCORD_WEBHOOK_URL` | Discord Webhook URL（推荐用于上传） | 二选一 |
| `DISCORD_BOT_TOKEN` | Discord Bot Token（用于获取和删除文件） | 推荐 |
| `DISCORD_CHANNEL_ID` | Discord 频道 ID（Bot 模式上传时需要） | Bot 模式 |

**Webhook 方式部署（推荐）：**

1. 在 Discord 服务器中，进入频道设置 → 集成 → Webhook
2. 创建新的 Webhook，复制 Webhook URL
3. 在 Cloudflare Pages 添加环境变量 `DISCORD_WEBHOOK_URL`
4. （推荐）同时创建 Discord Bot 并添加 `DISCORD_BOT_TOKEN`，用于文件获取和删除
5. 重新部署

**Bot 方式部署：**

1. 前往 [Discord Developer Portal](https://discord.com/developers/applications) 创建应用
2. 在 Bot 标签页创建 Bot，获取 Token
3. 在 OAuth2 → URL Generator 中，选择 `bot` scope，并给 Bot 授予 `Administrator` 权限
4. 使用生成的 URL 邀请 Bot 到你的服务器
5. 在 Cloudflare Pages 添加 `DISCORD_BOT_TOKEN` 和 `DISCORD_CHANNEL_ID`
6. 重新部署

**故障排查（`File not found on Discord`）：**

1. 确认 `DISCORD_WEBHOOK_URL` 指向的频道，Bot 也能访问（频道不一致会导致上传成功但直链失败）。
2. 直接给 Bot 授予 `Administrator` 权限，避免频道权限遗漏导致读取失败。
3. 修改环境变量后必须重新部署 Cloudflare Pages（仅保存变量不会即时生效）。
4. 打开 `/api/status` 检查 Discord 状态是否显示为 `bot`、`webhook` 或 `bot+webhook`。

**限制：**
- 无 Boost 服务器：25MB/文件
- Level 2 Boost：50MB/文件
- Level 3 Boost：100MB/文件

### HuggingFace 存储（可选）

使用 HuggingFace Datasets API 存储文件。文件以 git commit 的形式保存在 Dataset 仓库中。

**环境变量：**

| 变量名 | 说明 | 示例 |
| :--- | :--- | :--- |
| `HF_TOKEN` | HuggingFace 写入权限 Token | `hf_xxxxxxxxxxxx` |
| `HF_REPO` | Dataset 仓库 ID | `username/my-filebed` |

**部署步骤：**

1. 注册 [HuggingFace](https://huggingface.co) 账户
2. 创建新的 Dataset 仓库（Settings → New Dataset）
3. 前往 [Settings → Access Tokens](https://huggingface.co/settings/tokens) 创建 Token（需要 Write 权限）
4. 在 Cloudflare Pages 添加 `HF_TOKEN` 和 `HF_REPO` 环境变量
5. 重新部署

**限制：**
- 普通上传（base64）：约 35MB/文件
- LFS 上传：最大 50GB/文件
- 免费用户仓库总大小：约 50GB

### WebDAV 存储（可选）

适合对接 alist/openlist、NAS、群晖、坚果云等支持 WebDAV 的存储服务。  
你可以把 WebDAV 作为统一挂载入口，后台继续按目录管理文件，已生成的 `/file/...` 直链不受目录调整影响。
其中 alist/openlist 建议直接填写其 WebDAV 挂载地址（例如 `https://example.com/dav`），不要填管理后台地址。

**环境变量：**

| 变量名 | 说明 | 示例 |
| :--- | :--- | :--- |
| `WEBDAV_BASE_URL` | WebDAV 基础地址（不带结尾 `/`） | `https://dav.example.com/dav` |
| `WEBDAV_USERNAME` | WebDAV 用户名（Basic 认证） | `alice` |
| `WEBDAV_PASSWORD` | WebDAV 密码（Basic 认证） | `your-password` |
| `WEBDAV_BEARER_TOKEN` | Bearer Token（与用户名/密码二选一） | `eyJhbGciOi...` |
| `WEBDAV_TOKEN` | Bearer Token 兼容变量名（可选） | `eyJhbGciOi...` |
| `WEBDAV_ROOT_PATH` | 可选，WebDAV 根目录前缀 | `k-vault/uploads` |

**部署步骤：**

1. 在你的 WebDAV 服务端准备一个可写目录，并确认具备 `PUT/GET/DELETE/MKCOL` 权限。
2. 在 Cloudflare Pages 项目中添加上述 `WEBDAV_*` 变量（认证方式二选一：`用户名+密码` 或 `Bearer Token`）。
3. 重新部署后，访问 `/api/status` 检查 `webdav.connected` 与 `webdav.enabled`，或直接打开 `/webdav.html` 测试上传。
4. 修改 `WEBDAV_*` 变量后需在 Cloudflare Dashboard 或 wrangler 中重新部署才能生效。

**常见问题：**

- `Not configured`：通常是 `WEBDAV_BASE_URL` 为空，或认证变量未正确填写。
- `401/403`：认证失败，请检查账号密码或 Token。
- 上传失败且提示 `MKCOL`：说明服务端不允许建目录或路径权限不足，请调整 WebDAV 权限。

### GitHub 存储（可选）

支持将文件存到 GitHub 仓库，提供两种模式：

- `releases`：更适合二进制文件，默认模式
- `contents`：更适合小文件/文本文件（单文件建议不超过 20MB）

**环境变量：**

| 变量名 | 说明 | 示例 |
| :--- | :--- | :--- |
| `GITHUB_TOKEN` | GitHub Token（需要仓库写入权限） | `ghp_xxxxxxxxxxxx` |
| `GITHUB_REPO` | 目标仓库（`owner/repo`） | `yourname/kvault-files` |
| `GITHUB_MODE` | 存储模式：`releases` / `contents` | `releases` |
| `GITHUB_PREFIX` | 可选，仓库内路径前缀 | `uploads` |
| `GITHUB_RELEASE_TAG` | 可选，releases 模式固定标签 | `k-vault-storage` |
| `GITHUB_BRANCH` | 可选，contents 模式目标分支 | `main` |
| `GITHUB_API_BASE` | 可选，GitHub API 基址（企业版时可改） | `https://api.github.com` |

**部署步骤：**

1. 准备一个 GitHub 仓库（建议专门用于存储文件）。
2. 在 GitHub `Settings -> Developer settings -> Personal access tokens` 创建 Token（Classic 或 Fine-grained 均可），确保对目标仓库有写权限。
3. 在 Cloudflare Pages 项目中添加 `GITHUB_TOKEN`、`GITHUB_REPO`，可按需补充 `GITHUB_MODE` 等可选变量。
4. 重新部署后，首页会出现 GitHub 存储选项（未连通时为禁用态）。
5. 可访问 `/api/status` 确认 `github.connected` 与 `github.enabled` 状态。

**建议：**

- 大文件优先使用 `releases` 模式。
- 需要目录化管理和频繁覆盖时可使用 `contents` 模式。

---
