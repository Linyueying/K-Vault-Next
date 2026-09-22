<div align="center">

<img src="logo.png" alt="K-Vault Logo" width="140">

# K-Vault-Next

> A Serverless file host and image bed running on **Cloudflare Pages**, with Telegram, R2, S3, Discord, HuggingFace, WebDAV and GitHub storage backends.

**English** | [中文](README.md)

<br>

![GitHub stars](https://img.shields.io/github/stars/Linyueying/K-Vault-Next?style=flat-square)
![GitHub forks](https://img.shields.io/github/forks/Linyueying/K-Vault-Next?style=flat-square)
![GitHub license](https://img.shields.io/github/license/Linyueying/K-Vault-Next?style=flat-square)

</div>

---

## Screenshots

<table>
  <tr>
    <td><img src="demo/%E7%99%BB%E5%BD%95%E9%A1%B5%E9%9D%A2.webp" alt="Login Page" width="300" /></td>
    <td><img src="demo/%E9%A6%96%E9%A1%B5%E4%B8%8A%E4%BC%A0%E9%A1%B5%E9%9D%A2.webp" alt="Home Upload Page" width="300" /></td>
    <td><img src="demo/%E5%90%8E%E5%8F%B0%E7%AE%A1%E7%90%86%E9%A1%B5%E9%9D%A2.webp" alt="Admin Page" width="300" /></td>
  </tr>
  <tr>
    <td><img src="demo/%E5%9B%BE%E7%89%87%E6%B5%8F%E8%A7%88%E9%A1%B5%E9%9D%A2.webp" alt="Image Browse Page" width="300" /></td>
    <td><img src="demo/WebDAV%E9%A1%B5%E9%9D%A2.webp" alt="WebDAV Page" width="300" /></td>
    <td></td>
  </tr>
</table>

---

## What it does

Files land in the storage backend you pick, metadata goes into Cloudflare KV, and you get direct links, previews, folder management, API tokens and a machine-callable API on top.

**There is exactly one deployment form**: Cloudflare Pages (static pages in the repo root plus Pages Functions under `functions/`). No build step, no Docker, no server to operate, and zero cost inside the free quota.

- **Seven storage backends**, switched from a single upload entry point; Telegram is the default
- **Three upload paths**: direct upload, upload-from-URL (with SSRF protection), and chunked upload (up to 10GB over R2 native multipart)
- **Smart routing**: in `auto` mode small files go to the default backend and files over a threshold switch to a backend you choose (R2 by default); the threshold and target are configurable on the home page
- **Admin dashboard**: search / sort / filter, folder tree, favourites, rename, batch move and delete, KV & R2 usage monitoring, API token management
- **Text paste (Pastebin)** with language tagging, expiry and access password
- **File preview** for images, audio, video, PDF, Office, Markdown, JSON, CSV, archives, email, source text, 3D / CAD and more
- **Short share links** at `/s/:slug`, combined with expiry / password / download-count limits
- **API v1 with API tokens**, fully isolated from the browser session, scope-based authorization, idempotent retries
- **Optional guest uploads** with per-file size and daily count limits
- **Fail-closed admin surface**: with no admin credentials configured, management endpoints return 503 instead of opening up to the internet
- **No telemetry**: nothing phones home

---

## Pages

| Page | Path | What it is |
| :--- | :--- | :--- |
| Home / upload | `/` | Drag-and-drop, paste and batch upload; upload-from-URL; chunked upload; smart routing; upload folder tree; upload history; direct / Markdown / HTML / BBCode link formats |
| Admin | `/admin.html` | File and folder management, favourites, usage monitoring, API token management |
| Text paste | `/paste.html` | Create / list / view / delete pastes, with expiry and password |
| Gallery | `/gallery.html` | Image browsing, search, batch copy / download / delete |
| Preview | `/preview.html` | Multi-format preview; password-protected files prompt for a password |
| WebDAV | `/webdav.html` | WebDAV upload and upload-from-URL |
| Login | `/login.html` | Dashboard login (username + password) |

---

## Deployment

### 0. Prerequisites

- A Cloudflare account
- A fork of this repository (or deploy straight from your machine with `npm run pages:deploy`)
- Credentials for at least one storage backend — Telegram is the easiest: a bot token plus a chat ID

> **Set `BASIC_USER` and `BASIC_PASS` for any public deployment.** Without them, `/api/manage/**` and `/api/admin/**` return `503 ADMIN_AUTH_NOT_CONFIGURED` and the dashboard is unusable.

### 1. Create the Pages project

Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**, then pick your repository.

| Setting | Value |
| :--- | :--- |
| Framework preset | `None` |
| **Build command** | **leave empty** |
| **Build output directory** | **leave empty** |

There is no build step — the repo root is already the static site plus `functions/`. Filling these in breaks the deployment.

### 2. Bind KV (required)

KV holds file metadata, sessions, tokens and chunked-upload tasks. **The binding name must be `img_url`**; anything else and nothing works.

Dashboard → **Workers & Pages → KV** → create a namespace → back to the Pages project → **Settings → Functions → KV namespace bindings** → Variable name `img_url`, select the namespace you just created.

### 3. Bind R2 (strongly recommended)

R2 is the only backend with native multipart support for large files and the only one that does not need KV as chunk staging. **The binding name must be `R2_BUCKET`.**

Dashboard → **R2** → create a bucket → back to the Pages project → **Settings → Functions → R2 bucket bindings** → Variable name `R2_BUCKET`.

Without it, files above 40MB cannot be uploaded at all, and chunk staging falls back to KV (chunk size drops from 50MB to 20MB).

### 4. Set environment variables

Add them under **Settings → Environment variables**. At minimum you need the admin credentials plus one storage backend; the full list is in the next section. Changes only take effect after a **redeploy**.

### 5. R2 lifecycle rules (required once R2 is bound)

R2 console → your bucket → **Settings → Object Lifecycle Rules**, add two rules:

| Rule name | Prefix | Action | Days |
| :--- | :--- | :--- | :--- |
| `delete-temp-chunks` | `chunk-upload/` | Delete objects | 1 |
| `abort-incomplete-multipart` | leave empty (whole bucket) | Abort incomplete multipart uploads | 1 |

**Why this matters**: if someone abandons a large upload halfway, the staged chunks sit in your bucket forever. The only cleanup in code is a lazy sweep triggered when the same user starts another upload, which never covers users who simply never come back.

### 6. Local development

```bash
npm install
npm start          # wrangler pages dev, already passes --kv img_url --r2=R2_BUCKET
```

Then open `http://localhost:8080`. The local credentials are `admin` / `123` (hard-coded in the `start` script).

To deploy from your machine:

```bash
npm run pages:deploy      # same as: npx wrangler pages deploy .
```

If you need a `wrangler.jsonc`, the bundled helper generates and validates one locally (it never calls the Cloudflare API):

```bash
npm run pages:r2:doctor                              # print a wrangler.jsonc
node scripts/cloudflare-pages-r2-doctor.js --check   # validate an existing one
```

### 7. Verify

- Open `/` and upload a small file, then check that you get a direct link
- Open `/admin.html` and sign in with the credentials you configured
- Open `/api/status` to see backend state (while logged out it only reports what is configured, without probing connectivity)

---

## Environment variables

### Admin credentials

| Variable | Description | Default |
| :--- | :--- | :--- |
| `BASIC_USER` | Admin username | none (**required**) |
| `BASIC_PASS` | Admin password | none (**required**) |

Both must be set before the management endpoints open up. Cookie sessions and `Authorization: Basic` are both accepted. The session cookie is always named `k_vault_session` and cannot be renamed.

### Storage backends (configure at least one)

The default backend is **Telegram**. When `storageMode` matches nothing configured it falls back to Telegram; a backend with **missing variables does not silently degrade to another one** — it errors out.

| Backend | Required variables | Optional variables | Max file size |
| :--- | :--- | :--- | :--- |
| **Telegram** | `TG_Bot_Token`, `TG_Chat_ID` | `CUSTOM_BOT_API_URL`, `TG_UPLOAD_NOTIFY`, `TELEGRAM_METADATA_MODE`, `TELEGRAM_LINK_MODE`, `PUBLIC_BASE_URL` | 20MB |
| **R2** | `R2_BUCKET` (a binding, not a variable) | — | 10GB |
| **S3-compatible** | `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET` | `S3_REGION` (default `us-east-1`) | 40MB |
| **Discord** | `DISCORD_BOT_TOKEN` + `DISCORD_CHANNEL_ID`, **or** `DISCORD_WEBHOOK_URL` | — | 25MB |
| **HuggingFace** | `HF_TOKEN`, `HF_REPO` | — | 35MB |
| **WebDAV** | `WEBDAV_BASE_URL` plus (`WEBDAV_USERNAME`/`WEBDAV_PASSWORD`) or `WEBDAV_BEARER_TOKEN` | `WEBDAV_ROOT_PATH`, `WEBDAV_TOKEN` | 40MB |
| **GitHub** | `GITHUB_REPO`, `GITHUB_TOKEN` | `GITHUB_MODE` (`releases`/`contents`), `GITHUB_PREFIX`, `GITHUB_RELEASE_TAG`, `GITHUB_BRANCH`, `GITHUB_API_BASE` | 40MB (20MB in `contents` mode) |

Details worth knowing:

- **Telegram uses the mixed-case names `TG_Bot_Token` / `TG_Chat_ID`.** The upper-case aliases `TG_BOT_TOKEN` / `TG_CHAT_ID` are only recognised additionally by the API v1 capability probe and the import endpoint, so setting both is safest.
- **Discord** prefers the bot token and only falls back to the webhook.
- **HuggingFace** expects a **dataset** repository (`owner/name`), not a model repository.
- **WebDAV** prefers `WEBDAV_BEARER_TOKEN` over `WEBDAV_TOKEN`; both work.

### Upload and sharing

| Variable | Description | Default |
| :--- | :--- | :--- |
| `CHUNK_BACKEND` | Where chunks are staged: `auto` (R2 when available) / `r2` / `kv` | `auto` |
| `PUBLIC_BASE_URL` | Site origin used to build absolute direct links | request origin |
| `FILE_URL_SECRET` | HMAC secret for signed direct links | falls back to `TG_FILE_URL_SECRET` → `TG_Bot_Token` → built-in value |
| `GUEST_UPLOAD` | Allow uploads without logging in (set `true`) | disabled |
| `GUEST_MAX_FILE_SIZE` | Per-file size limit for guests, in bytes | 5242880 (5MB) |
| `GUEST_DAILY_LIMIT` | Daily upload count per guest, counted by IP + date | 10 |
| `MINIMIZE_KV_WRITES` | When `true`, Telegram uses signed links and skips KV metadata writes (dashboard listing and deletion stop working for those files) | disabled |

### Telegram specifics

| Variable | Description | Default |
| :--- | :--- | :--- |
| `CUSTOM_BOT_API_URL` | Self-hosted Bot API server, replaces the official one | `https://api.telegram.org` |
| `TG_UPLOAD_NOTIFY` | Send a notification message after a successful upload | `true` (`TELEGRAM_UPLOAD_NOTIFY` is an alias) |
| `TELEGRAM_METADATA_MODE` | `off` / `none` / `minimal` disable KV metadata writes, `on` / `full` enable them | enabled |
| `TELEGRAM_SKIP_METADATA` | Fallback switch when `TELEGRAM_METADATA_MODE` is unset | disabled |
| `TELEGRAM_LINK_MODE` | Set to `signed` to force signed direct links | disabled |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram webhook verification secret | none (**when unset the webhook performs no verification**; `TG_WEBHOOK_SECRET` is an alias) |

### API

| Variable | Description | Default |
| :--- | :--- | :--- |
| `API_CORS_ORIGINS` | CORS allow-list for API v1, comma separated; `*` allows any origin; empty sends no CORS headers | empty |

The full checklist lives in [`.env.example`](.env.example). Note that Cloudflare Pages **does not read** `.env` files — it is a reference list only, and the real values go in the dashboard or `wrangler`.

---

## Upload limits

| Backend | Max file size | Why |
| :--- | :--- | :--- |
| R2 | 10GB | R2 native multipart |
| S3-compatible | 40MB | assembled in Worker memory |
| WebDAV | 40MB | assembled in Worker memory |
| GitHub | 40MB (20MB in `contents` mode) | assembled in Worker memory |
| HuggingFace | 35MB | LFS commit |
| Discord | 25MB | Discord attachment limit (server boosts raise it; this is the conservative value) |
| Telegram | 20MB | Bot API traffic relayed through Worker memory |

Chunking rules:

- R2 staging → **50MB per chunk**; KV staging → **20MB per chunk** (the KV value limit is 25MB, leaving headroom)
- At most **256** chunks per task
- Client and server must use the same rule, otherwise `init` fails with `CHUNK_COUNT_MISMATCH`

---

## API overview

### Authentication

The dashboard uses a cookie session or HTTP Basic. API v1 uses `Authorization: Bearer kvault_<tokenId>_<secret>`.

Tokens carry scopes: `upload`, `read`, `delete`, `paste`. They can also carry policies: `allowedStorages`, `allowedMimeTypes`, `maxFileSize`, `folderPrefix`, `allowedSourceHosts`, `rateLimit`.

### API v1

| Method | Path | Scope | Description |
| :--- | :--- | :--- | :--- |
| GET | `/api/v1/capabilities` | public | configured backends and upload limits |
| GET | `/api/v1/me` | any valid token | token introspection |
| POST | `/api/v1/upload` | `upload` | multipart upload, supports `Idempotency-Key` (deduplicated for 24h) |
| POST | `/api/v1/import` | `upload` | import from URL (SSRF-checked) |
| GET | `/api/v1/files` | `read` | paginated listing |
| GET / DELETE | `/api/v1/file/<path>` | `read` / `delete` | stream the file / delete it |
| GET | `/api/v1/file/<path>/info` | `read` | metadata |
| POST | `/api/v1/paste` | `paste` | create a paste |
| GET | `/api/v1/pastes` | `read` | list pastes |
| GET / DELETE | `/api/v1/paste/<id>` | `read` / `delete` | read / delete (password via `?password=` or `X-Paste-Password`) |

Machine-readable definition: [`docs/openapi.yaml`](docs/openapi.yaml). Integration guide: [`docs/agent-integration.md`](docs/agent-integration.md).

### Share options

Expiry, password, download-count limit and custom short slug are supported by the **backend API**: `POST /upload`, `/api/v1/upload` and the chunked upload path all accept and enforce them. The home page does **not** currently expose inputs for these; the text paste page is where expiry and password are offered in the UI.

Protected files behave like this: expired or over the download limit returns `410`, a missing password returns `401`, and a wrong password returns `403`.

---

## Project layout

```text
├── index.html admin.html paste.html gallery.html
├── preview.html webdav.html login.html
├── theme.css theme.js mobile-refactor.css
├── functions/                            # Cloudflare Pages Functions backend
│   ├── api/
│   │   ├── auth/ manage/ admin/ v1/      # auth / management / tokens / API v1
│   │   ├── chunked-upload/               # init / chunk / complete
│   │   └── status.js upload-from-url.js telegram/webhook.js
│   ├── file/[[path]].js                  # direct links (multi-segment, password, block/whitelist)
│   ├── file-info/[[path]].js             # file metadata
│   ├── s/[slug].js                       # short share links
│   └── utils/                            # storage adapters and shared helpers
├── scripts/                              # wrangler config generator / validator
├── docs/                                 # OpenAPI, integration guide, full config reference
└── .env.example                          # variable checklist (Pages does not read it)
```

---

## Full documentation

| Document | Contents |
| :--- | :--- |
| [`docs/README-full-reference.md`](docs/README-full-reference.md) | every environment variable, per-backend setup steps, API usage, limits |
| [`docs/openapi.yaml`](docs/openapi.yaml) | machine-readable API v1 definition |
| [`docs/agent-integration.md`](docs/agent-integration.md) | agent / script integration guide |
| [`docs/cloudflare-pages-r2.md`](docs/cloudflare-pages-r2.md) | troubleshooting Cloudflare Pages R2 bindings |
| [`PROJECT_INTRO.md`](PROJECT_INTRO.md) | project positioning and architecture |

---

## Credits

The backend originates from **K-Vault** — thanks to its author and community:

- katelya77/K-Vault — the source of the backend capabilities
- Telegraph-Image — early reference for the Serverless image-bed shape
- CloudFlare-ImgBed — an excellent open-source project in the same space
- The Linux.do community for feedback

On top of upstream this project rewrote the frontend, hardened authentication, upgraded chunked uploads, and added multi-segment path routing.

## License

CC0 1.0 Universal — free to use, modify and distribute.
