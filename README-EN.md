<div align="center">

<img src="assets/img/logo.png" alt="K-Vault-Next Logo" width="140">

# K-Vault-Next

> A Serverless file host and image bed running on **Cloudflare Pages**, with Telegram, R2, S3, Discord, HuggingFace, WebDAV and GitHub storage backends.

**English** | [中文](README.md)

<br>

![GitHub stars](https://img.shields.io/github/stars/Linyueying/K-Vault-Next?style=flat-square)
![GitHub forks](https://img.shields.io/github/forks/Linyueying/K-Vault-Next?style=flat-square)
![GitHub license](https://img.shields.io/github/license/Linyueying/K-Vault-Next?style=flat-square)

</div>

---

Files land in the storage backend you pick, metadata goes into Cloudflare KV, and you get direct links, previews, folder management, share controls, text pastes, API tokens and a machine-callable API on top.

**There is exactly one deployment form**: Cloudflare Pages (static pages in the repo root plus Pages Functions under `functions/`). No build step, no Docker, no server to operate, **zero runtime dependencies**, and zero cost inside the free quota.

This repository is derived from [katelya77/K-Vault](https://github.com/katelya77/K-Vault). It keeps the backend capabilities and then rewrites the frontend, hardens authentication, upgrades chunked uploads and drops the Docker self-hosting path. See the next section for the full diff.

---

## How this differs from katelya77/K-Vault

### In one line

Upstream is a general-purpose file host with **both Cloudflare Pages and Docker** targets. K-Vault-Next is a trimmed, hardened fork that **keeps Cloudflare Pages only** — it trades away self-hosting flexibility and spends the effort on that single path instead.

### Overview

| | katelya77/K-Vault | K-Vault-Next |
| :--- | :--- | :--- |
| Deployment | Cloudflare Pages **+ single Docker image** | **Cloudflare Pages only** |
| Runtime dependencies | `@sentry/tracing`, `@cloudflare/pages-plugin-sentry`, … | **none** (only `wrangler` as a dev dependency) |
| Telemetry | Sentry built in, disabled via `disable_telemetry` | **no telemetry code at all** |
| Pages | 6 | **8** (adds `/paste.html` and `/share.html`) |
| Frontend CSS | written per page | **`design-system.css` as the single source of truth** + Apple HIG motion system |
| Variable naming | two spellings per setting; docs suggested "set both" | **unified read layer, any spelling works, set it once** |
| Changing config | edit variables → redeploy | three groups are **editable in the dashboard, written to KV, live immediately** |
| Max file (R2) | 100MB (chunked) | **10GB** (R2 native multipart) |
| Short link | `/s/:slug` 302s straight to the file | `/s/:slug` → **share landing page**; previews do not count, downloads do |
| Admin dashboard | file management + allow/deny list | folder tree, favourites, rename, batch move, usage monitoring, share management |
| Content moderation | `ModerateContentApiKey` | **removed** (no third-party moderation calls) |
| Allow / deny list | `WhiteList_Mode` | **removed** |
| Frontend build output | previously shipped `frontend/` (Vite/Vue) and `_nuxt/` | **removed**; single-file HTML in the repo root is the only entry point |
| Tests / CI | mocha, Docker smoke tests, storage regression script | server-side tests removed; config validators and style guards under `scripts/` remain |

### What Next removes

- **The entire Docker / self-hosting track**: the `server/` Node runtime, `docker-compose.yml`, `Dockerfile`, `README-DOCKER.md`, the GHCR image pipeline and the accompanying server tests.
- **Docker-only environment variables**: `DATA_DIR`, `DB_PATH`, `CHUNK_DIR`, `PORT`, `WEB_PORT`, `CONFIG_ENCRYPTION_KEY`, `SESSION_SECRET`, `SETTINGS_STORE`, `SETTINGS_REDIS_*`, `UPLOAD_MAX_SIZE`, `UPLOAD_SMALL_FILE_THRESHOLD`, `CHUNK_SIZE`, `DEFAULT_STORAGE_TYPE`.
- **Sentry telemetry** — dependencies and instrumentation are gone, so `disable_telemetry` no longer exists either.
- **Content moderation and allow/deny lists** — `ModerateContentApiKey`, `WhiteList_Mode` and their code paths.

> If what you need is "run it on a VPS, swap backends freely, store config in Redis", use upstream's Docker build. This repository deliberately does **not** do that.

### What Next adds

| Area | Change |
| :--- | :--- |
| Frontend consistency | `design-system.css`: design tokens, shared components, 37 keyframes and the Vue transition families live in one place; pages only carry local increments |
| Motion & accessibility | Apple HIG easing/duration tokens, staggered first-paint choreography; `prefers-reduced-motion`, `prefers-reduced-transparency` and `html[data-perf="low"]` tiering |
| Environment variables | `functions/utils/env-config.js` — one read layer, so `TG_Bot_Token` and `TG_BOT_TOKEN` both work |
| Runtime config | `config:guest` / `config:cors` / `config:upload` editable in the dashboard, written to KV, live without a redeploy |
| Chunked upload | R2 native multipart; per-file ceiling raised from 100MB to **10GB**; staging target (`auto` / `r2` / `kv`) switchable in the dashboard |
| Routing | `functions/file/[[path]].js` handles arbitrary-depth file paths |
| Sharing | `/s/:slug` → `/share.html?s=:slug` landing page; expiry / password / download-count limit / custom slug, settable from both UI and API; a "share management" panel in the dashboard |
| Text paste | new `/paste.html` plus a `paste` scope, with language tagging, expiry and password |
| Admin dashboard | folder tree, favourites, rename, batch move, KV/R2 usage monitoring, token policies (`allowedStorages`, `folderPrefix`, `rateLimit`, …) |
| Upload scheduling | a "storage node" drawer on the home page: smart routing (files over a threshold switch backends) plus optional parallel uploads (Telegram pool and chunk pool kept separate) |
| Security | fail-closed admin surface, unified rate limiting, login brute-force protection, stack-trace redaction, SSRF guard on URL imports, vendored third-party assets |
| Docs | `docs/reference/openapi.yaml` (machine-readable API) and `docs/reference/agent-integration.md` (agent integration guide) |

### Upload limits compared

| Backend | upstream K-Vault | K-Vault-Next | Note |
| :--- | :--- | :--- | :--- |
| Telegram (Pages web upload) | 20MB | 20MB | same; both relay through Worker memory |
| Telegram (Docker web upload) | 50MB | — | Next has no Docker target |
| Cloudflare R2 | 100MB (chunked) | **10GB** | Next uses R2 native multipart |
| S3-compatible | 100MB (chunked) | 40MB | Next has no S3 chunking; assembled in Worker memory |
| WebDAV | not documented | 40MB | assembled in Worker memory |
| GitHub | not documented | 40MB (20MB in `contents` mode) | assembled in Worker memory |
| HuggingFace | 35MB (plain) / 50GB (LFS) | 35MB | Next does not use the LFS path |
| Discord | 25MB (no boost) / 50–100MB (L2+) | 25MB | Next takes the conservative value |

> Honest note: Next is not strictly stronger across the board. R2 jumps a long way, but S3, WebDAV and GitHub are *lower* than upstream's figures because they have no chunked path here.

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

## Pages

| Page | Path | What it is |
| :--- | :--- | :--- |
| Home / upload | `/` | Drag-and-drop, paste and batch upload; upload-from-URL; chunked upload; smart routing; upload folder tree; upload history; direct / Markdown / HTML / BBCode link formats; per-item share config |
| Admin | `/admin/files` | File and folder management, favourites, rename, batch move/delete, KV & R2 usage monitoring, API token management, share management, runtime settings |
| Share | `/share.html` | Landing page for `/s/:slug`; preview and download, password gate, expiry reasons |
| Text paste | `/paste.html` | Create / list / view / delete pastes, with expiry and password |
| Gallery | `/gallery.html` | Image browsing, search, batch copy / download / delete |
| Preview | `/preview.html` | Multi-format preview; password-protected files prompt for a password |
| WebDAV | `/webdav.html` | WebDAV upload and upload-from-URL |
| Login | `/login.html` | Dashboard login (username + password) |

---

## Setting environment variables correctly

This is where most deployments go wrong. Read it in order.

### Three different kinds of "config"

Cloudflare Pages has three kinds of configuration, and they behave completely differently:

| Kind | Where you set it | Redeploy needed? | Examples |
| :--- | :--- | :--- | :--- |
| **Binding** | Settings → **Functions** → KV namespace bindings / R2 bucket bindings | **Yes** | `img_url`, `R2_BUCKET` |
| **Environment variable** | Settings → **Environment variables** | **Yes** | `BASIC_USER`, `TG_Bot_Token`, … |
| **Runtime config (in KV)** | `/admin/storage` → settings panel | **No** — live immediately | guest uploads, CORS, chunk staging backend |

**The three classic mistakes**:

1. **Filling a binding in as an environment variable.** KV and R2 are *bindings*, not variables. Setting `img_url = something` under Environment variables does **nothing**; bind it under Settings → **Functions**.
2. **Forgetting to redeploy.** Bindings and variables are injected at deploy time. After changing them, go to Deployments → latest → **Retry deployment** (or push a new commit). A running deployment never picks up new values on its own.
3. **Expecting Pages to read `.env`.** The `.env.example` in this repo is a checklist of *what* to configure, not a config file. Cloudflare Pages **does not read** `.env`. (Local `wrangler` does — see below.)

### Minimum viable setup: five steps

| # | Action | Name / variable | Value |
| :-- | :--- | :--- | :--- |
| 1 | Bind KV | **name must be `img_url`** | a KV namespace you create |
| 2 | Bind R2 (strongly recommended) | **name must be `R2_BUCKET`** | an R2 bucket you create |
| 3 | Environment variable | `BASIC_USER` | your dashboard username |
| 4 | Environment variable | `BASIC_PASS` | your dashboard password |
| 5 | Environment variable | credentials for one storage backend (Telegram is easiest: `TG_Bot_Token` + `TG_Chat_ID`) | — |

> **Set `BASIC_USER` and `BASIC_PASS` for any public deployment.** Without them, `/api/manage/**` and `/api/admin/**` return `503 ADMIN_AUTH_NOT_CONFIGURED` and the dashboard is unusable — fail-closed, never open to the internet.

**Step 6 (only if you bound R2)**: configure R2 lifecycle rules, or abandoned chunks from half-finished uploads will sit in your bucket forever. See [step 5](#5-r2-lifecycle-rules-required-once-r2-is-bound).

### You do not need to worry about variable casing

Cloudflare Pages environment variables are **case-sensitive**. Historically the same setting existed under two spellings (`TG_Bot_Token` and `TG_BOT_TOKEN`), and different modules each read only one of them — so you could fill in the upper-case alias exactly as documented and have the main upload path silently ignore it, with no error at all. Older docs could only advise "set both", i.e. enter every value twice.

Now the backend has a single read layer, `functions/utils/env-config.js`, which declares the accepted spellings for each logical variable and takes the first non-empty one:

| Logical variable | Spellings recognised (in priority order) |
| :--- | :--- |
| `TG_BOT_TOKEN` | `TG_Bot_Token` → `TG_BOT_TOKEN` |
| `TG_CHAT_ID` | `TG_Chat_ID` → `TG_CHAT_ID` |
| `TG_UPLOAD_NOTIFY` | `TG_UPLOAD_NOTIFY` → `TELEGRAM_UPLOAD_NOTIFY` |
| `TELEGRAM_WEBHOOK_SECRET` | `TELEGRAM_WEBHOOK_SECRET` → `TG_WEBHOOK_SECRET` |
| `FILE_URL_SECRET` | `FILE_URL_SECRET` → `TG_FILE_URL_SECRET` |
| `WEBDAV_BEARER_TOKEN` | `WEBDAV_BEARER_TOKEN` → `WEBDAV_TOKEN` |

**Pick one spelling and set it once — "set both" is no longer needed.** Variables not listed here are read verbatim.

### Variables you never need to set at deploy time

These three groups are editable in `/admin/storage` → settings panel and take effect **immediately, with no redeploy**. They are stored in KV (`config:guest` / `config:cors` / `config:upload`), and the read order is **KV override > environment variable**.

| Group | Contents | Environment variables (baseline only) |
| :--- | :--- | :--- |
| Guest uploads | enabled, max file size, daily limit | `GUEST_UPLOAD`, `GUEST_MAX_FILE_SIZE`, `GUEST_DAILY_LIMIT` |
| CORS | API v1 origin allow-list | `API_CORS_ORIGINS` |
| Chunk staging | `auto` / `r2` / `kv` | `CHUNK_BACKEND` |

Environment variables act as a **baseline** here: they apply only until the group has been saved once from the dashboard. After that KV wins. A "reset" button in the dashboard deletes the KV key and drops you back to the environment baseline.

> This is a real improvement over upstream, where every setting is env-only and every change costs a redeploy.

### Full walkthrough

#### 0. Prerequisites

- A Cloudflare account
- A fork of this repository (or deploy straight from your machine with `npm run pages:deploy`)
- Credentials for at least one storage backend — Telegram is the easiest: a bot token plus a chat ID

#### 1. Create the Pages project

Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**, then pick your repository.

| Setting | Value |
| :--- | :--- |
| Framework preset | `None` |
| Root directory | empty (repo root) |
| Install command | empty |
| **Build command** | **leave empty** |
| **Build output directory** | **leave empty** |
| Deploy command | empty |

There is no build step — the repo root is already the static site plus `functions/`. Filling these in breaks the deployment. In particular, do **not** put `npx wrangler deploy` (a Workers command) or `npm run build` here; you will hit errors like `The detected framework ("Hono") cannot be automatically configured`.

#### 2. Bind KV (required)

KV holds file metadata, sessions, tokens, chunked-upload tasks and runtime config. **The binding name must be `img_url`**; anything else and nothing works.

Dashboard → **Workers & Pages → KV** → create a namespace → back to the Pages project → **Settings → Functions → KV namespace bindings** → Variable name `img_url`, select the namespace you just created.

#### 3. Bind R2 (strongly recommended)

R2 is the only backend with native multipart support for large files, and the only one that needs no KV chunk staging. **The binding name must be `R2_BUCKET`.**

Dashboard → **R2** → create a bucket → back to the Pages project → **Settings → Functions → R2 bucket bindings** → Variable name `R2_BUCKET`.

Without it, files above 40MB cannot be uploaded at all, and chunk staging falls back to KV (chunk size drops from 50MB to 20MB).

#### 4. Set environment variables

Settings → **Environment variables** → Add variables.

- For secrets (passwords, tokens, keys), press **Encrypt** to store them as secrets — after saving they cannot be viewed again.
- Production and Preview environments are configured separately.
- Changes only take effect after a **redeploy**.

**Minimum: admin credentials plus one storage backend.** Full list below.

#### 5. R2 lifecycle rules (required once R2 is bound)

R2 console → your bucket → **Settings → Object Lifecycle Rules**, add two rules:

| Rule name | Prefix | Action | Days |
| :--- | :--- | :--- | :--- |
| `delete-temp-chunks` | `chunk-upload/` | Delete objects | 1 |
| `abort-incomplete-multipart` | leave empty (whole bucket) | Abort incomplete multipart uploads | 1 |

**Why this matters**: if someone abandons a large upload halfway, the staged chunks sit in your bucket forever. The only cleanup in code is a lazy sweep triggered when the same user starts another upload, which never covers users who simply never come back.

#### 6. Local development

```bash
npm install
npm start          # wrangler pages dev, already passes --kv img_url --r2=R2_BUCKET
```

Then open `http://localhost:8080`. The local credentials are `admin` / `123` (hard-coded in the `start` script's `--binding` flags, not environment variables).

> Local runs use `wrangler`, which **does** read `.env` / `.dev.vars` — the opposite of Pages in production.

To deploy from your machine:

```bash
npm run pages:deploy      # same as: npx wrangler pages deploy .
```

If you need a `wrangler.jsonc`, the bundled helper generates and validates one locally (it never calls the Cloudflare API):

```bash
npm run pages:r2:doctor                              # print a wrangler.jsonc
node scripts/cloudflare-pages-r2-doctor.js --check   # validate an existing one
```

#### 7. Verify

- Open `/` and upload a small file, then check that you get a direct link
- Open `/admin/files` and sign in with the credentials you configured
- Open `/api/status` to see backend state (while logged out it only reports what is configured, without probing connectivity)

---

## Environment variables

### Admin credentials (required for public deployments)

| Variable | Description | Default | Redeploy needed |
| :--- | :--- | :--- | :---: |
| `BASIC_USER` | Admin username | none (**required**) | ✅ |
| `BASIC_PASS` | Admin password | none (**required**) | ✅ |

Both must be set before the management endpoints open up. Cookie sessions and `Authorization: Basic` are both accepted. The session cookie is always named `k_vault_session` and cannot be renamed.

### Storage backends (configure at least one)

The default backend is **Telegram**. When `storageMode` matches nothing configured it falls back to Telegram; a backend with **missing variables does not silently degrade to another one** — it errors out.

| Backend | Required variables | Optional variables | Max file size |
| :--- | :--- | :--- | :--- |
| **Telegram** | `TG_Bot_Token`, `TG_Chat_ID` | `CUSTOM_BOT_API_URL`, `TG_UPLOAD_NOTIFY`, `TELEGRAM_METADATA_MODE`, `TELEGRAM_LINK_MODE`, `PUBLIC_BASE_URL` | 20MB |
| **R2** | `R2_BUCKET` (a **binding**, not a variable) | — | 10GB |
| **S3-compatible** | `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET` | `S3_REGION` (default `us-east-1`) | 40MB |
| **Discord** | `DISCORD_BOT_TOKEN` + `DISCORD_CHANNEL_ID`, **or** `DISCORD_WEBHOOK_URL` | — | 25MB |
| **HuggingFace** | `HF_TOKEN`, `HF_REPO` | — | 35MB |
| **WebDAV** | `WEBDAV_BASE_URL` plus (`WEBDAV_USERNAME`/`WEBDAV_PASSWORD`) or `WEBDAV_BEARER_TOKEN` | `WEBDAV_ROOT_PATH` | 40MB |
| **GitHub** | `GITHUB_REPO`, `GITHUB_TOKEN` | `GITHUB_MODE` (`releases`/`contents`), `GITHUB_PREFIX`, `GITHUB_RELEASE_TAG`, `GITHUB_BRANCH`, `GITHUB_API_BASE` | 40MB (20MB in `contents` mode) |

Details worth knowing:

- **Discord** prefers the bot token and only falls back to the webhook.
- **HuggingFace** expects a **dataset** repository (`owner/name`), not a model repository.
- **WebDAV** prefers `WEBDAV_BEARER_TOKEN` over `WEBDAV_TOKEN`; both work.

### Upload and sharing

| Variable | Description | Default | Redeploy needed |
| :--- | :--- | :--- | :---: |
| `CHUNK_BACKEND` | Where chunks are staged: `auto` (R2 when available) / `r2` / `kv` | `auto` | ❌ dashboard |
| `PUBLIC_BASE_URL` | Site origin used to build absolute direct links | request origin | ✅ |
| `FILE_URL_SECRET` | HMAC secret for signed direct links (`TG_FILE_URL_SECRET` also recognised) | falls back to `TG_FILE_URL_SECRET` → `TG_Bot_Token` → built-in value | ✅ |
| `GUEST_UPLOAD` | Allow uploads without logging in (set `true`) | disabled | ❌ dashboard |
| `GUEST_MAX_FILE_SIZE` | Per-file size limit for guests, in bytes | 5242880 (5MB) | ❌ dashboard |
| `GUEST_DAILY_LIMIT` | Daily upload count per guest, counted by IP + date | 10 | ❌ dashboard |
| `MINIMIZE_KV_WRITES` | When `true`, Telegram uses signed links and skips KV metadata writes (dashboard listing and deletion stop working for those files) | disabled | ✅ |

### Telegram specifics

| Variable | Description | Default |
| :--- | :--- | :--- |
| `CUSTOM_BOT_API_URL` | Self-hosted Bot API server, replaces the official one | `https://api.telegram.org` |
| `TG_UPLOAD_NOTIFY` | Send a notification message after a successful upload (`TELEGRAM_UPLOAD_NOTIFY` is an alias) | `true` |
| `TELEGRAM_METADATA_MODE` | `off` / `none` / `minimal` disable KV metadata writes, `on` / `full` enable them | enabled |
| `TELEGRAM_SKIP_METADATA` | Fallback switch when `TELEGRAM_METADATA_MODE` is unset | disabled |
| `TELEGRAM_LINK_MODE` | Set to `signed` to force signed direct links | disabled |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram webhook verification secret (`TG_WEBHOOK_SECRET` is an alias). **Required**: while unset, `/api/telegram/webhook` answers `503` and accepts no writes | none — **webhook disabled when unset** |
| `TG_WEBHOOK_CHAT_IDS` | Optional hardening: only process updates from these chats/channels, comma-separated (e.g. `-1001234567890`). Empty = no restriction | empty (unrestricted) |

> **The webhook is now fail-closed.** Previously an unset `TELEGRAM_WEBHOOK_SECRET` skipped
> verification entirely, letting anyone POST anonymously — writing metadata into your KV and
> minting direct links for arbitrary `file_id`s. Register the webhook with `secret_token`:
>
> ```bash
> curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-domain>/api/telegram/webhook&secret_token=<SAME_SECRET>"
> ```
>
> `GET /api/telegram/webhook` then reports `secretConfigured: true`.

### API

| Variable | Description | Default | Redeploy needed |
| :--- | :--- | :--- | :---: |
| `API_CORS_ORIGINS` | CORS allow-list for API v1, comma separated; `*` allows any origin; empty sends no CORS headers | empty | ❌ dashboard |
| `PUBLIC_STATUS_DIAGNOSTICS` | Only relevant on **open instances** (no admin auth configured): set to `true` to expose full `/api/status` diagnostics (connectivity probes, bot identity, bucket/repo names) to anonymous visitors. Off by default | off | ✅ |
| `RATE_LIMIT_GLOBAL_MAX` | Cross-isolate global IP rate limit (requests/minute, applies to `/api/**`, `/file/**`, `/upload` only). Costs 1 KV read + 1 KV write per request — **not recommended on the free tier** (1,000 writes/day). Leave at `0`; the zero-cost in-isolate limiter is always active | `0` (off) | ✅ |

### Static paths blocked in production

Cloudflare Pages serves every file in the deploy directory, so `functions/_middleware.js`
returns 404 (not 403 — 403 would confirm the file exists) for:

`package.json`, `package-lock.json`, `wrangler.toml`, `.env*`, `.git/**`, `.github/**`,
`functions/**`, `migrations/**`, `scripts/**`, `docs/**`, `demo/**`, `node_modules/**`,
`README.md`, `README-EN.md`

> The last two are deliberate: the READMEs enumerate all seven storage backends and the
> deployment topology (~34KB) — ready-made reconnaissance material on a live instance.

Full checklist: [`.env.example`](.env.example). Remember that Cloudflare Pages **does not read** `.env` — it is a reference list only, and the real values go in the dashboard or `wrangler`.

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

Machine-readable definition: [`docs/openapi.yaml`](docs/reference/openapi.yaml). Integration guide: [`docs/agent-integration.md`](docs/reference/agent-integration.md).

### Share options

Expiry, password, download-count limit and custom short slug are supported by the **backend API**: `POST /upload`, `/api/v1/upload` and the chunked upload path all accept and enforce them. The home page does **not** currently expose inputs for these; the text paste page is where expiry and password are offered in the UI.

Protected files behave like this: expired or over the download limit returns `410`, a missing password returns `401`, and a wrong password returns `403`.

---

## Project layout

Cloudflare Pages has **no build step** — the repository root _is_ the site root, since `wrangler pages deploy .` publishes these paths as-is. So leave these two alone:

- `functions/` — a hard Pages Functions convention; the file path _is_ the API route
- the 8 HTML files in the root — they are the URLs themselves (e.g. `/index.html`, `/admin.html`; `/admin/*` falls back to `admin.html` via `functions/admin/[[path]].js`)

```text
├── index.html admin.html paste.html gallery.html      # page entrypoints (root = site root, do not move)
├── preview.html webdav.html login.html share.html
├── assets/                              # static assets (CSS / JS / images / vendored libs)
│   ├── css/                             # design-system.css (single source of truth)
│   │                                    # theme.css / index.css / mobile-refactor.css
│   ├── js/                              # app-core.js (shared layer, must precede page scripts)
│   │                                    # theme.js / index.js / branding.js
│   ├── img/                             # favicon.ico / logo.png / logo-64.png / logo-180.png
│   └── vendor/                          # fontawesome / glassfx / vue / qrcode
├── functions/                           # Cloudflare Pages Functions backend (path = route, do not move)
│   ├── api/
│   │   ├── auth/ manage/ admin/ v1/     # auth / management / tokens / API v1
│   │   ├── chunked-upload/              # init / chunk / complete
│   │   ├── site-branding.js             # site branding info (public)
│   │   └── status.js upload-from-url.js share-info.js telegram/webhook.js
│   ├── file/[[path]].js                 # direct links (multi-segment, password)
│   ├── file-info/[[path]].js            # file metadata
│   ├── s/[slug].js                      # short share links → 302 to /share.html
│   └── utils/                           # storage adapters and shared helpers
│       ├── schema.js                    # single source of truth for D1 migrations (JS constants)
│       ├── env-config.js                # unified env read layer (casing / aliases)
│       ├── runtime-config.js            # KV override > env runtime config
│       └── metadata-d1.js ratelimit.js redact.js ssrf-guard.js …
├── migrations/                          # generated from schema.js by scripts/gen-migrations.py — do not edit
├── scripts/                             # validation / test / D1 tooling
│   ├── check_styles.py check_shared.py check_functions.py   # consistency guards (npm run check)
│   ├── check_style.py check_tokens.py strip_css.py          # additional guards (run manually)
│   ├── verify/                          # Playwright visual regression scripts (see scripts/verify/README.md)
│   └── cloudflare-pages-r2-doctor.js gen-migrations.py setup-d1.sh
├── docs/                                # layered docs, start at docs/README.md
│   ├── guides/                          # things to follow step by step
│   ├── reference/                       # look up "what is it"
│   ├── agents/                          # for AI agents
│   └── archive/                         # historical snapshots, not current state
├── demo/                                # demo screenshots and animation comparison pages
└── .env.example                         # variable checklist (Pages does not read it)
```

---

## Full documentation

| Document | Contents |
| :--- | :--- |
| [`docs/README.md`](docs/README.md) | **documentation index** (navigated by "what am I trying to do") |
| [`docs/guides/d1-migration-checklist.md`](docs/guides/d1-migration-checklist.md) | **D1 migration & phased rollout checklist** (create DB, bind, verify `source` field, rollback, troubleshooting) |
| [`docs/guides/storage-backends.md`](docs/guides/storage-backends.md) | step-by-step setup for Telegram / R2 / S3 / Discord / HuggingFace / WebDAV / GitHub |
| [`docs/guides/cloudflare-pages-r2.md`](docs/guides/cloudflare-pages-r2.md) | troubleshooting Cloudflare Pages R2 bindings |
| [`docs/reference/architecture.md`](docs/reference/architecture.md) | project positioning, tech architecture (frontend / backend / data / storage), security design |
| [`docs/reference/agent-integration.md`](docs/reference/agent-integration.md) | agent / script integration guide (tokens, scopes, idempotency keys, MCP tool mapping) |
| [`docs/reference/openapi.yaml`](docs/reference/openapi.yaml) | machine-readable API v1 definition |
| [`docs/agents/AI-OPERATIONS.md`](docs/agents/AI-OPERATIONS.md) | **operations manual for AI agents** (local setup, verification tooling, debugging handbook, incident postmortems, hard constraints) — human users can skip |
| [`docs/archive/`](docs/README.md#archive) | historical snapshots (upstream README, one-off refactor report, bug postmortem) — **not current state** |

---

## Credits

The backend originates from **K-Vault** — thanks to its author and community:

- [katelya77/K-Vault](https://github.com/katelya77/K-Vault) — the source of the backend capabilities
- Telegraph-Image — early reference for the Serverless image-bed shape
- CloudFlare-ImgBed — an excellent open-source project in the same space
- The Linux.do community for feedback

On top of upstream this project rewrote and unified the frontend, hardened authentication, upgraded chunked uploads, added multi-segment path routing and rebuilt the sharing system — and removed the Docker self-hosting path. Upstream is still actively developed; if you need Docker, use upstream directly.

## License

CC0 1.0 Universal — free to use, modify and distribute.
