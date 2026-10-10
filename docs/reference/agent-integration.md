# K-Vault Agent 接入指南（API Token / MCP）

面向机器客户端 —— MCP Agent、GitHub Actions、Coze Workflow、ShareX、自动化脚本 —— 的 K-Vault 图床接入说明。**第 3 节是原生 MCP 端点（推荐）**；第 4 节是直接调 REST 的对照表。机器可读接口定义见 [openapi.yaml](./openapi.yaml)。

所有示例中的 `https://your-kvault-domain` 替换为你的部署地址；`$KVAULT_API_TOKEN` 为 Token 明文（形如 `kvault_<id>_<secret>`），仅创建/轮换时返回一次，切勿写入仓库、日志或截图。

## 1. 准备 Token

### 方式 A：管理后台

登录 → 「API Token 管理」→ 新建：填写名称、勾选 scopes、可选过期时间与策略（allowedStorages / folderPrefix / maxFileSize，界面按 MB 填写大小）。明文仅创建时展示一次。

### 方式 B：Admin API（Basic 认证）

```bash
curl -X POST "https://your-kvault-domain/api/admin/tokens" \
  -u "$BASIC_USER:$BASIC_PASS" \
  -H "Content-Type: application/json" \
  -d '{"name":"blog-bot","scopes":["upload","read"],"expiresAtMs":1790000000000,"policies":{"folderPrefix":"blog"}}'
```

> 未配置 `BASIC_USER` / `BASIC_PASS` 时 admin API 整体 fail-closed，返回 503 `ADMIN_AUTH_NOT_CONFIGURED`。

### Scopes

同一套 scope 同时约束 REST 与 MCP：REST 按请求路径推导所需 scope，MCP 按被调用的**工具**推导。

| Scope | REST 能力 | MCP 工具 |
| --- | --- | --- |
| `upload` | `POST /api/v1/upload`、`POST /api/v1/import` | `kvault_upload_file`、`kvault_import_url` |
| `read` | `GET /api/v1/files`、`GET /api/v1/file/:id`、`GET /api/v1/file/:id/info` | `kvault_list_files`、`kvault_get_file_info`、`kvault_get_file`、`kvault_list_pastes` |
| `delete` | `DELETE /api/v1/file/:id` | `kvault_delete_file` |
| `paste` | Paste 相关端点 | `kvault_create_paste` |

`kvault_capabilities`（公开）与 `kvault_token_info`（任意有效 Token）不要求额外 scope。

### 策略（policies，可选）

创建/更新时传入，服务端对每次请求强制执行：

| 字段 | 说明 | 违规返回 |
| --- | --- | --- |
| `allowedStorages` | 限定存储后端（telegram / r2 / s3 / discord / huggingface / webdav / github） | 403 `POLICY_DENIED` |
| `folderPrefix` | 限定目录前缀 | 403 `POLICY_DENIED` |
| `maxFileSize` | 单文件字节上限（管理界面按 MB 输入，自动换算） | 413 `POLICY_FILE_TOO_LARGE` |

## 2. 鉴权与通用约定

- 除 `GET /api/v1/capabilities` 外，所有 v1 端点需要 `Authorization: Bearer $KVAULT_API_TOKEN`。
- 成功响应：`{"success": true, ...}`；失败：`{"success": false, "error": {"code": "...", "message": "...", "detail": "..."}}`。
- 常见错误码：
  - 401 `TOKEN_MISSING` / `TOKEN_INVALID` / `TOKEN_EXPIRED` / `TOKEN_DISABLED`
  - 403 `SCOPE_REQUIRED` / `POLICY_DENIED`
  - 413 `FILE_TOO_LARGE` / `POLICY_FILE_TOO_LARGE`
  - 触发令牌级限流返回 429
- 幂等：请求头 `Idempotency-Key`（≤200 字符）。同一 Token + 同一 Key 在 24 小时内重放首次成功响应，响应头带 `Idempotency-Replayed: true`。上传与导入均支持。

## 3. MCP 端点（原生，推荐 Agent 使用）

K-Vault-Next **原生实现**了 MCP（Model Context Protocol），不依赖任何第三方 SDK。相比自己拼 REST 调用，直接用 MCP 的优势是：工具描述与参数 schema 由协议自动下发给模型，无需人工维护提示词。

### 3.1 端点形态

| 方法 | 路径 | 行为 |
| :--- | :--- | :--- |
| POST | `/mcp` | JSON-RPC 2.0 请求（单条对象，或批量数组） |
| GET | `/mcp` | `405 Method Not Allowed` —— 无状态模式不提供 SSE 流 |
| OPTIONS | `/mcp` | `204` 预检 |

`/mcp/anything` 与 `/mcp` 等价：会话信息走 header 不走路由，路径段无语义。

**传输**：Streamable HTTP。响应 `Content-Type: application/json`。

### 3.2 开启方式与权限控制

默认**关闭**。未开启时 `/mcp` 返回 `404`（等同不存在，不给探测者正面信号）。

#### 方式一：后台设置（推荐，改完即时生效）

进入 **管理后台 → 系统设置 → MCP 端点**：

- **总开关**：启用 / 关闭 `/mcp`。保存写入 KV，**立即生效，无需重新部署**。
- **工具级开关**：逐个启用 / 关闭 10 个工具。关闭后该工具
  - 不出现在 Agent 的 `tools/list` 里；
  - 即使 Agent 硬编码工具名直接 `tools/call`，也会被拒绝，返回
    `result.isError=true` 且 `error.code = "TOOL_DISABLED"`。
- **服务地址**：一键复制 `/mcp` 完整地址，供填进 MCP 客户端。

工具级开关是**部署级上限**，与 API Token 的 scope 是**「与」**的关系：
某个工具既要未被后台关闭，又要 Token 具备它所需的 scope，才能调用成功。

#### 方式二：环境变量（部署期基线）

```bash
# Cloudflare Pages → Settings → Environment variables
MCP_ENABLED=true
```

优先级：**后台设置（KV）覆盖环境变量**。点击后台「恢复默认」会清除 KV 覆盖，
回退到 `MCP_ENABLED`。工具级禁用清单**没有**环境变量形态，只在后台维护。
`MCP_ENABLED` 取值兼容 `true / 1 / yes / on`（大小写不敏感）。

> **生效时机（易踩坑）**：`/mcp` 的开关判定**每个请求都重新读一次配置**
> （KV 覆盖 > 环境变量，带 30 秒 isolate 缓存），因此后台改完开关**立即生效**，
> 也不会因为请求落到不同 isolate 而失效。
>
> 早期版本为了「零 KV 往返」改为读进程内内存镜像，结果镜像只在「刚保存过配置
> 的那个 isolate」、且仅 30 秒内有效；一旦过期就回退到环境变量 `MCP_ENABLED`，
> 而后台保存的开关只存在 KV 里 —— 表现为「后台明明开着 MCP，过一会儿访问
> `/mcp` 却一直 404」。现已改为回源读取，不再有此问题。

> 工具级清单存的是「**禁用**」名单而非「启用」名单：将来新增工具时，
> 存量部署的配置里没有它的名字，因此默认可用 —— 不会因为不在旧白名单里
> 而被静默关闭。

开启后复用与 `/api/v1` **完全相同**的 API Token、scope 与策略体系；跨域白名单也复用 `API_CORS_ORIGINS`，不新增变量。

### 3.3 无状态设计（重要）

本服务端**不分配 `Mcp-Session-Id`**：

- Cloudflare Pages Functions 无常驻进程，维护会话需落 KV + 每请求回读，而 KV 免费额度仅 1000 写/天；
- MCP 规范明确允许服务端不分配会话，此时客户端**不得**发送 `Mcp-Session-Id`；
- 每个 POST 自包含，天然吻合 Serverless 请求模型。

客户端若发送 `Mcp-Session-Id`，服务端会忽略且不回传该响应头，客户端应自动降级为无状态模式。

### 3.4 鉴权粒度：握手免鉴权，tools 强制鉴权

MCP 端点的鉴权**按 JSON-RPC 方法区分**，而不是在 HTTP 层一刀切：

| 方法 | 是否需要 Token | 说明 |
| :--- | :--- | :--- |
| `initialize` | 否 | 协议握手。带 Token 才返回 `capabilities.tools` 与 `instructions` |
| `ping` | 否 | 连通性探测 |
| `notifications/*` | 否 | 单向通知，服务端回 `202` 无 body |
| `tools/list` | **是** | 缺失 → HTTP `401` |
| `tools/call` | **是** | 缺失 → HTTP `401` |

这样设计的原因：

1. **客户端行为契合**：主流 MCP 客户端（Claude Desktop、各语言 SDK）在 `initialize` 阶段还不一定发送 `Authorization`，它们把「建立连接」和「提供凭据」分两步。若握手就 401，客户端在拿到 `capabilities` 之前就断了，无法协商、无法降级。
2. **不泄露信息**：匿名 `initialize` 只返回协议版本与 `serverInfo`，**不声明 tools 能力、不返回 `instructions`**。工具清单属于需要 Token 才可见的资产。
3. **失败仍然关闭**：`tools/list` 与 `tools/call` 强制鉴权；MCP 总开关（后台或 `MCP_ENABLED`）未开启时整个端点 404。

> 批量请求（数组）逐条独立判定。若批内任一条是 `tools/*` 且未带 Token，整个 HTTP 请求按 `401` 返回——因为「这次请求本身没通过鉴权」是传输层事实，逐条 200 会掩盖它。

### 3.5 协议握手与版本协商

> **`initialize` / `ping` / `notifications/*` 是握手方法，无需 Token**（见 3.3 的鉴权粒度说明）。
> 不带 `Authorization` 也能完成握手，但响应的 `capabilities` 会是空对象、不返回 `instructions`——
> 即**不暴露工具清单**。要拿到完整能力声明与 `tools/list`，仍需在请求上带 Token。

匿名握手（可用于探测服务端是否支持 MCP）：

```bash
curl -s -X POST "https://your-kvault-domain/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",
       "params":{"protocolVersion":"2025-06-18",
                 "capabilities":{},
                 "clientInfo":{"name":"my-agent","version":"1.0"}}}'
```

匿名响应（注意 `capabilities` 为空）：

```json
{"jsonrpc":"2.0","id":1,"result":{
  "protocolVersion":"2025-06-18",
  "capabilities":{},
  "serverInfo":{"name":"k-vault-next","version":"1.0.0"}}}
```

带上 Token 后，同样的请求会返回完整能力与引导语：

```bash
curl -s -X POST "https://your-kvault-domain/mcp" \
  -H "Authorization: Bearer $KVAULT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",
       "params":{"protocolVersion":"2025-06-18",
                 "capabilities":{},
                 "clientInfo":{"name":"my-agent","version":"1.0"}}}'
```

```json
{"jsonrpc":"2.0","id":1,"result":{
  "protocolVersion":"2025-06-18",
  "capabilities":{"tools":{"listChanged":false}},
  "serverInfo":{"name":"k-vault-next","version":"1.0.0"},
  "instructions":"K-Vault-Next 是一个 serverless 文件托管服务……"}}
```

**版本协商规则**：服务端支持 `2025-06-18` / `2025-03-26` / `2024-11-05`。客户端给的版本命中列表则原样回显；**未命中时回服务端最新版，而不是报错**——按规范，服务端必须返回一个自己支持的版本，由客户端决定是否继续。

`capabilities` 中**只声明 `tools`**：未实现的能力不会声明，否则会诱导客户端调用不存在的 `resources/*` 或 `prompts/*` 并收到 `-32601`。

握手后客户端应发送 `notifications/initialized` 通知（无 `id`），服务端回 `202` 且无响应体。

### 3.6 列出工具

```bash
curl -s -X POST "https://your-kvault-domain/mcp" \
  -H "Authorization: Bearer $KVAULT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

响应 `result.tools[]`，每项含 `name` / `description` / `inputSchema`。

> ⚠️ **`tools/list` 只返回当前 Token 有权限调用的工具。** 这是刻意的：工具清单会被客户端喂给模型，列出必然被拒的工具等于诱导模型反复调用并拿到错误。
>
> 注意这只是**可见性过滤**，不是安全边界——`tools/call` 每次仍会按 scope 二次校验。

### 3.7 调用工具

```bash
curl -s -X POST "https://your-kvault-domain/mcp" \
  -H "Authorization: Bearer $KVAULT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call",
       "params":{"name":"kvault_list_files",
                 "arguments":{"limit":10,"storage":"r2"}}}'
```

成功响应：

```json
{"jsonrpc":"2.0","id":3,"result":{
  "content":[{"type":"text","text":"{\"success\":true,\"files\":[...],\"pagination\":{...}}"}],
  "isError":false}}
```

**结果的 `content[0].text` 是 JSON 字符串**（而非自然语言），可直接解析出 `id` / `links` 等字段。所有工具的产出都是这一形态，跨客户端兼容性最好。

### 3.8 工具清单（10 个）

| Tool | 所需 scope | 说明 |
| :--- | :--- | :--- |
| `kvault_capabilities` | 公开 | 已启用的存储后端、上传上限、图片类型 |
| `kvault_token_info` | 任意 Token | 当前 Token 的 scopes / policies / 用量 |
| `kvault_upload_file` | `upload` | base64 上传，**适合 ≤512KB**；支持 slug / 有效期 / 密码 / 下载次数。返回含顶层 `directLink` |
| `kvault_import_url` | `upload` | 服务端抓取远程 URL 入库，**远程大文件走这个**（带 SSRF 防护） |
| `kvault_list_files` | `read` | 游标分页列表 |
| `kvault_get_file_info` | `read` | 文件元信息（JSON） |
| `kvault_get_file` | `read` | 下载链接与状态（**不内联二进制**） |
| `kvault_delete_file` | `delete` | 永久删除 |
| `kvault_create_paste` | `paste` | 创建文本片段 |
| `kvault_list_pastes` | `read` | 文本片段列表 |

**大文件的三条出口**（同时也是工具 `description` 里强调的内容）：

| 场景 | 走哪条路 |
| :--- | :--- |
| 远程 URL | `kvault_import_url` —— 服务端抓取，内容不经过模型上下文 |
| **本地文件**（≤100MB） | 命令行 `node scripts/kvault-upload.mjs upload <路径>`（见 §3.13） |
| 超大文件（>100MB） | 网页端**分片上传**（R2 原生 multipart，最高 10GB）—— 需 Cookie/Basic 会话，不接受 API Token |

> 为什么本地文件不该硬塞进 `kvault_upload_file`：base64 会使体积膨胀约 33%，而 `/mcp` 请求体上限 1MiB，实际只能传约 750KB 的原文件。超过后模型只能反复重试同一个必然失败的工具。

**`kvault_upload_file` / `kvault_import_url` 的返回含顶层 `directLink`**：等于 `links.download`，另附 `note: "Direct link: <url>"`。这是 MCP 适配层额外加的，**直接调 REST 的客户端不会看到该字段**。

### 3.13 命令行上传客户端（本地文件推荐）

上面 §3.8 的表格里，**本地文件**这条路上 MCP 工具会吃亏：内容得先编码成 base64 塞进 JSON，而 `/mcp` 请求体上限 1MiB，实际只能传约 750KB。当你要传的是本机上的文件时，用 CLI 更直接——**它连的是 v1 REST 端点，不是 MCP**，因此没有 1MiB 约束（上限 100MB）。

```bash
export KVAULT_ENDPOINT="https://your-kvault-domain"
export KVAULT_TOKEN="kvault_<id>_<secret>"

node scripts/kvault-upload.mjs upload ./cover.png
```

**零 npm 依赖**：只用 Node 22 内置的 `parseArgs` / `fetch` / `FormData` / `Blob` / `fs.globSync`，不需要 `npm install`。

| 选项 | 环境变量 | 说明 |
| :--- | :--- | :--- |
| `-e, --endpoint` | `KVAULT_ENDPOINT` | 站点地址（`KVAULT_BASE_URL` 亦可；自动补 `https://`、去掉尾部路径） |
| `-t, --token` | `KVAULT_TOKEN` / `KVAULT_API_TOKEN` | API Token，需 `upload` scope |
| `-s, --storage` | — | 存储后端 |
| `-f, --folder` | — | 目录前缀（服务端字段名是 `folderPath`） |
| `-p, --password` | — | 分享密码 |
| `--expires-in` | — | 分享有效期（秒） |
| `--max-downloads` | — | 分享下载次数上限 |
| `--slug` | — | 自定义分享 slug |
| `--dedupe` | — | 请求服务端按内容去重 |
| `--json` / `-q, --quiet` | — | 结构化输出 / 只输出直链（互斥） |

优先级：**命令行参数 > 环境变量**。

输入形态可以混用：

```bash
node scripts/kvault-upload.mjs upload ./a.png ./b.jpg     # 多文件（逐个独立成败）
node scripts/kvault-upload.mjs upload './shots/*.png'     # glob（支持 **）
node scripts/kvault-upload.mjs upload ./dist/             # 目录递归
cat report.pdf | node scripts/kvault-upload.mjs upload -  # 标准输入
```

退出码与输出：

| 退出码 | 含义 |
| :--- | :--- |
| `0` | 全部成功 |
| `1` | 有文件上传失败（批量模式下只要有一个失败就是 1） |
| `2` | 用法 / 配置错误（参数非法、缺 Token、路径不存在、单文件超过 100MB） |

- `--quiet` 只输出直链（每行一个），可直接用于 `LINK=$(...)`
- `--json` 每文件输出一个 JSON 对象，含 `directLink` / `links` / `file` / `sha256`
- **错误隔离**：批量模式下某个文件失败不影响其余；失败项的 `error.code` 原样保留在 `--json` 输出里

**边界**：

- 单文件 ≤100MB。更大的文件走网页端**分片上传**——那条链路需要 Cookie/Basic 会话，不接受 API Token，本 CLI 刻意不覆盖。
- 不做流式上传：Node 原生 `FormData`/`Blob` 要求内容全量驻留内存。手写 multipart 流式编码器会引入 boundary 生成 / 分块拼接 / 背压处理一整套复杂度，对「零依赖小工具」不值得；代价被显式圈在 100MB。
- CLI 是**服务端到服务端**调用（无 `Origin` 头），因此不受 CORS 约束。

### 3.9 错误分层（务必区分）

| 层 | 表现 | 何时出现 |
| :--- | :--- | :--- |
| 传输鉴权失败 | HTTP `401` / `403`，body 为 `{success:false,error:{code,message}}` | `tools/list` / `tools/call` 缺少 Token，或 Token 无效/过期/被禁用 |
| JSON-RPC 协议错误 | HTTP **`200`**，body 含 `error.code`（`-32700`/`-32600`/`-32601`/`-32602`/`-32603`） | JSON 非法、信封不合法、方法不存在、参数结构错误 |
| 工具业务失败 | HTTP **`200`**，`result.isError=true`，`content[0].text` 内是业务错误 JSON | 文件不存在、scope 不足（`TOKEN_SCOPE_DENIED`）、参数值非法 |

**关键**：协议层错误走 HTTP 200 + `error` 信封（JSON-RPC over HTTP 的约定），只有**传输层鉴权**才用 401/403。**判断工具是否成功要看 `result.isError`，不能只看 HTTP 状态码**。

两个容易混淆的「参数错误」，分属不同层：

| 情况 | 返回 | 层 |
| :--- | :--- | :--- |
| `tools/call` 缺 `params.name` | `error.code = -32602` | 协议层（JSON-RPC 结构不合法） |
| `kvault_upload_file` 缺 `contentBase64` | `result.isError = true`，文本内是 `VALIDATION_ERROR` | 业务层（协议合法，工具自己校验失败） |

所有错误 `message` 都经过脱敏，即使内部异常文本夹带了凭证也不会外泄。

### 3.10 批量请求

`POST /mcp` 接受 JSON-RPC 批量数组，逐条独立处理——单条失败不影响同批次其它请求：

```bash
curl -s -X POST "https://your-kvault-domain/mcp" \
  -H "Authorization: Bearer $KVAULT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '[{"jsonrpc":"2.0","id":1,"method":"ping"},
       {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}]'
```

若整批都是通知（无 `id`），返回 `202` 且无响应体（规范允许）。

### 3.11 已知限制

- **不提供 SSE**（`GET /mcp` 返回 405）：Serverless 环境不适合长连接。因此也无法推送 `tools/list_changed` 通知（`capabilities.tools.listChanged` 声明为 `false`）。
- **不支持取消**：`notifications/cancelled` 在无状态模式下一旦请求分发就无法中断。
- **请求体上限 1MiB**：主要约束 base64 上传（原文件实际约 750KB）。远程大文件请用 `kvault_import_url`，**本地大文件请用 CLI**（§3.13，上限 100MB）。
- **`kvault_upload_file` 依赖上游 multipart 处理**：该工具会合成 `multipart/form-data` 请求转发给 `/api/v1/upload`，因此继承上游的一切行为与限制（含请求体上限与存储后端配置）。若上游 multipart 链路异常，本工具会一并失败——这与 `DELETE /file/<id>`、`GET /file/<id>` 等工具的失败表现一致。

### 3.12 测试与验证

MCP 端点有两层测试，职责互补：

| 脚本 | 类型 | 运行方式 |
| :--- | :--- | :--- |
| `scripts/test-mcp.mjs` | 纯函数单测（协议层 / 工具表 / 适配层契约），无需起服务 | `npm test` 已包含 |
| `scripts/test-kvault-upload.mjs` | 上传 CLI 纯函数单测（参数 / 路径展开 / 请求构造 / 错误翻译 / 退出码，注入 fetch 替身） | `npm test` 已包含 |
| `scripts/test-mcp-e2e.py` | 真实 HTTP 端到端，需先手动启动 `wrangler pages dev` | 见脚本头部注释 |

端到端脚本覆盖：握手与版本协商、匿名 vs 带 Token 的能力差异、`tools/list` 的 scope 过滤、各工具成功与错误路径、错误分层、`401`/`405`/`413`/`204` 边界、批量请求、paste 读写闭环。

---

## 4. HTTP 端点 ↔ MCP Tool 概念映射

> 本节是**自己拼 REST 调用**时的参考。若使用上面的原生 MCP 端点，可跳过。

| 概念 Tool | 对应 HTTP | 说明 |
| :--- | :--- | :--- |
| `kvault_health` | GET /api/v1/capabilities | 存活/就绪探测（200 且 `data.apiVersion` 存在即健康） |
| `kvault_capabilities` | GET /api/v1/capabilities | 能力清单：可用存储后端、大小上限、图片类型 |
| `kvault_token_info` | GET /api/v1/me | 当前 Token 的 scopes / policies / 用量 |
| `kvault_upload_file` | POST /api/v1/upload | multipart 文件上传 |
| `kvault_import_url` | POST /api/v1/import | 远程 URL 导入（内置 SSRF 防护） |
| `kvault_list_files` | GET /api/v1/files | 游标分页列表 |
| `kvault_get_file` | GET /api/v1/file/:id/info；GET /api/v1/file/:id | 元信息 JSON / 字节流（支持 Range） |

### 4.1 kvault_health / kvault_capabilities

```bash
curl "https://your-kvault-domain/api/v1/capabilities"
```

```json
{"success":true,"data":{"apiVersion":"v1","upload":true,"importFromUrl":true,"maxUploadSize":104857600,"storages":["telegram","r2"],"imageTypes":["image/jpeg","image/png","image/webp","image/avif","image/gif","image/bmp"]}}
```

`storages` 仅列出已配置可用的后端。

### 4.2 kvault_token_info

```bash
curl -H "Authorization: Bearer $KVAULT_API_TOKEN" "https://your-kvault-domain/api/v1/me"
```

返回 `data.token`：`id / name / scopes / expiresAt / enabled / policies / createdAt / lastUsedAt / usageCount`。适合 Agent 启动时自检凭据权限。

### 4.3 kvault_upload_file

| 参数 | 位置 | 必填 | 说明 |
| --- | --- | --- | --- |
| `file` | form-data | 是 | 文件本体 |
| `storage` | form-data | 否 | telegram / r2 / s3 / discord / huggingface / webdav / github，缺省用默认存储 |
| `folderPath` | form-data | 否 | 目录前缀 |
| `slug` | form-data | 否 | 自定义分享 slug（冲突返回 409 `SLUG_CONFLICT`） |
| `expires_in` | form-data | 否 | 分享链接有效秒数 |
| `max_downloads` | form-data | 否 | 分享下载次数上限 |
| `password` | form-data | 否 | 分享密码 |

```bash
curl -X POST "https://your-kvault-domain/api/v1/upload" \
  -H "Authorization: Bearer $KVAULT_API_TOKEN" \
  -H "Idempotency-Key: post-42-cover" \
  -F "file=@./cover.png" -F "storage=r2" -F "folderPath=blog/2026"
```

成功：`{"success":true,"file":{"id":"...","name":"cover.png",...},"links":{"download":"...","share":"...","delete":"..."}}`。≤25MB 的重复内容上传会命中 SHA-256 去重索引，响应附加 `"deduplicated": true` 并返回已有文件。

### 4.4 kvault_import_url

| 参数 | 位置 | 必填 | 说明 |
| --- | --- | --- | --- |
| `url` | JSON | 是 | 远程地址 |
| `storage` | JSON | 否 | 同上传 |
| `folder` | JSON | 否 | 目录前缀 |
| `deduplicate` | JSON | 否 | 默认 `true`，设为 `false` 跳过去重 |

```bash
curl -X POST "https://your-kvault-domain/api/v1/import" \
  -H "Authorization: Bearer $KVAULT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: agent-run-20260903-1" \
  -d '{"url":"https://cdn.example.com/cover.jpg","storage":"r2","folder":"agent"}'
```

返回 `data.file`（含 `sha256`）、`data.links.download / share`、`data.source.url`、`data.deduplicated`。

SSRF 防护：仅允许 http/https；端口白名单 80 / 443 / 8080 / 8443；内网、环回、链路本地、CGNAT、云厂商 metadata 主机与字面 IP 一律拒绝（Docker 侧对每个 DNS 解析结果复检）；每一跳重定向都重新校验。

### 4.5 kvault_list_files

```bash
curl -H "Authorization: Bearer $KVAULT_API_TOKEN" \
  "https://your-kvault-domain/api/v1/files?limit=50&storage=r2&search=cover"
```

可选 query：`limit`（默认 50，最大 200）、`cursor`、`storage`、`search`、`listType`、`folderPath`。返回 `files[]` 与 `pagination{cursor, listComplete, pageCount, total}`；下一页传 `cursor=<pagination.cursor>`。

### 4.6 kvault_get_file

```bash
# 元信息（JSON，含原始字段 raw）
curl -H "Authorization: Bearer $KVAULT_API_TOKEN" "https://your-kvault-domain/api/v1/file/<id>/info"

# 字节流（支持 Range，受分享密码保护约束）
curl -H "Authorization: Bearer $KVAULT_API_TOKEN" "https://your-kvault-domain/api/v1/file/<id>"
```

## 5. 其他端点

- `POST /api/v1/paste`（scope: `paste`）：`{"content":"...","language":"text","expires_in":86400,"password":""}` → 201 + `paste{id, language, createdAt, expiresAt, hasPassword}` 与 `links.view / links.raw`。
- `GET /api/v1/pastes`：分页列表。
- `DELETE /api/v1/file/:id`（scope: `delete`）：删除文件。

## 6. 安全须知（Agent 开发者）

1. Token 明文只在创建/轮换时返回一次，服务端只存哈希；疑似泄露立即 rotate，旧密钥即刻失效。
2. 禁用的 Token 立即失效，且不能被任何遥测写入"复活"（用量统计与凭据分离存储，60 秒防抖）。
3. 上传默认拒绝 SVG；URL 导入仅 http(s) + 端口白名单。
4. 为 Agent 配最小权限：推荐 `upload` scope + `folderPrefix` 策略。
5. 浏览器前端直连需配置 `API_CORS_ORIGINS` 白名单；纯服务端调用无需 CORS。
