<div align="center">

<img src="assets/img/logo.png" alt="K-Vault-Next Logo" width="120">

# K-Vault-Next

**Lightweight File Layer on Cloudflare Pages: Image Host · Cloud Drive · WebDAV · MCP**

[![Deploy to Cloudflare Pages](https://img.shields.io/badge/Deploy-Cloudflare%20Pages-F38020?logo=cloudflare&logoColor=white)](#quick-deploy)
![Runtime Dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen)
![Storage Backends](https://img.shields.io/badge/storage%20backends-7-blue)
![Max File Size](https://img.shields.io/badge/single%20file-up%20to%2010GB-orange)
![License](https://img.shields.io/badge/license-AGPL--3.0-blue)

[中文](README.md) | **English**

</div>

> Zero build step, zero runtime dependencies, no VPS or Docker required. Fork the repo, attach your Cloudflare bindings, set your environment variables, and go live in 5 minutes.

---

## Core Features

| Feature | Description |
| :--- | :--- |
| **Large-File Chunked Transfer** | **R2** native multipart up to **10GB**; **Telegram** virtual chunked uploads up to **2GB** (adaptive rate-limit cooldown, resume, aligned HTTP Range downloads, and zero-KV Edge Cache path caching) |
| **7 Storage Backends** | Telegram, Cloudflare R2, S3-compatible, WebDAV, GitHub, HuggingFace, and Discord — enable only what you use |
| **WebDAV Server** | Mount `/dav` directly in macOS Finder, Windows File Explorer, mobile apps, or rclone with separate credentials and read-only toggle |
| **AI & Automation Ready** | Full REST API v1 + zero-dependency stateless `/mcp` endpoint (11 tools, granular token policies) + zero-dependency CLI |
| **Share Landing Pages** | `/s/:slug` supports passwords, expiration, download limits, and custom slugs — **previews never consume download quota** |
| **Built-In Utilities** | **Airdrop** ephemeral 6-digit code file relay (auto-deleted after delivery); **Zero-Knowledge Vault** (`/vault.html`, client-side AES-GCM + TOTP); **Show** public gallery |
| **Secure by Default** | Fail-closed admin APIs, SSRF-guarded URL import, brute-force protection, zero telemetry, and live runtime settings in the admin panel |

---

## Quick Deploy

> **Cloudflare Pages only** (no Docker / self-hosted runtime). Go live in 5 steps:

### Step 1: Create Cloudflare Resources

In the Cloudflare Dashboard sidebar, create the resources you need:

1. **KV Namespace (Required)**: `Workers & Pages → KV → Create a namespace` (e.g. `kvault-kv`).
2. **R2 Bucket (Recommended for up to 10GB files)**: `R2 → Create bucket`.
3. **D1 Database (Recommended to minimize free-tier KV writes and enable Airdrop / full metadata)**: `Workers & Pages → D1 → Create database` (tables auto-migrate on first request; no manual SQL needed).

### Step 2: Fork & Create Pages Project

1. Fork this repository to your GitHub account.
2. Go to Cloudflare Dashboard → `Workers & Pages → Create → Pages → Connect to Git` and select your fork.
3. Configure build settings exactly as below, then click **Save and Deploy**:
   - **Framework preset**: `None`
   - **Build command**: **leave empty** (this project has no build step; setting one breaks deployment)
   - **Build output directory**: **leave empty** (or `/`)

### Step 3: Attach Pages Bindings (Functions Bindings)

Go to project `Settings → Functions` (or `Settings → Bindings`) and attach bindings using these **exact variable names** (**these are Bindings, not Environment Variables**):

| Resource Type | Variable Name (Exact Match) | Required | Purpose |
| :--- | :--- | :---: | :--- |
| **KV Namespace** | `img_url` | **Required** | Sessions, tokens, upload tasks, runtime settings |
| **R2 Bucket** | `R2_BUCKET` | Recommended | R2 object storage (single files up to 10GB) |
| **D1 Database** | `DB` | Recommended | File metadata, chunk states, share bundles, Airdrop, audit logs |

### Step 4: Set Environment Variables

Go to project `Settings → Environment variables` and add the **minimal required set**:

```env
# 1. Admin credentials (required for public deployment; admin APIs fail closed with 503 if unset)
BASIC_USER=admin
BASIC_PASS=replace_with_a_strong_password

# 2. At least one storage backend (free Telegram example; optional if R2_BUCKET is already bound)
TG_BOT_TOKEN=your_bot_token
TG_CHAT_ID=your_channel_or_group_chat_id
```

> - Variable casing is normalized automatically (e.g. `TG_BOT_TOKEN` or `TG_Bot_Token` both work).
> - See [`.env.example`](.env.example) for the complete list (S3, WebDAV, GitHub, HuggingFace, Discord, Webhooks, etc.).
> - **After saving bindings and environment variables, trigger a redeploy (`Deployments → Retry deployment`) so changes take effect.**

### Step 5: Verify Deployment

- Open `https://your-domain/`: upload a test file and confirm you get a working link.
- Open `https://your-domain/admin/files`: sign in with `BASIC_USER` / `BASIC_PASS`.
- Open `https://your-domain/api/status`: verify configured storage backends report available.

---

## Local Development

```bash
npm install
npm start          # Starts wrangler pages dev at http://localhost:8080 (default login: admin / 123)
npm run check      # Runs static guards and template verification
```

Local development reads `.dev.vars` / `.env` in the repo root. To deploy via CLI:

```bash
npm run pages:deploy
```

---

## Storage Backends & File Limits

| Backend | Max Single File | Notes |
| :--- | :---: | :--- |
| **Cloudflare R2** | **10GB** | Native multipart upload; best for large files |
| **Telegram** | **2GB** | Direct upload ≤20MB; automatic 18MB virtual chunked upload >20MB (free; requires metadata persistence) |
| **S3-Compatible / WebDAV** | 40MB | AWS S3, MinIO, Backblaze B2, OSS, OpenList, NAS, etc. |
| **GitHub** | 40MB | 40MB via Releases mode; 20MB via Contents mode |
| **HuggingFace** | 35MB | Dataset repository |
| **Discord** | 25MB | Bot token or Webhook URL |

---

## Integrations

| Interface | Endpoint / Usage | Notes |
| :--- | :--- | :--- |
| **WebDAV Mount** | `https://your-domain/dav` (Windows: `\\your-domain@SSL\dav`) | Enable online in Admin → System Settings with dedicated credentials; always use HTTPS |
| **REST API v1** | `/api/v1/**` (`Authorization: Bearer kvault_<id>_<secret>`) | Granular scopes: `upload`, `read`, `delete`, `paste`, `share` |
| **MCP Endpoint** | `POST /mcp` (JSON-RPC 2.0, stateless Streamable HTTP) | Disabled by default; toggle endpoint and each of the 11 tools live in Admin |

Zero-dependency CLI upload (Node 22+):

```bash
export KVAULT_ENDPOINT="https://your-domain"
export KVAULT_TOKEN="kvault_<id>_<secret>"
node scripts/kvault-upload.mjs upload ./demo.png --folder blog
```

---

## Documentation

- [`docs/README.md`](docs/README.md) — Full documentation index
- [`.env.example`](.env.example) — Complete environment variable reference
- [`docs/guides/storage-backends.md`](docs/guides/storage-backends.md) — Setup guides for all 7 storage backends & WebDAV server
- [`docs/guides/d1-migration-checklist.md`](docs/guides/d1-migration-checklist.md) — D1 migration & rollout checklist
- [`docs/reference/agent-integration.md`](docs/reference/agent-integration.md) — API v1, MCP, and CLI integration guide
- [`docs/reference/openapi.yaml`](docs/reference/openapi.yaml) — OpenAPI specification
- [`docs/reference/architecture.md`](docs/reference/architecture.md) — System architecture & repository layout

---

## Credits & License

Backend foundations originated from [katelya77/K-Vault](https://github.com/katelya77/K-Vault). K-Vault-Next is a streamlined Cloudflare Pages-only edition removing Docker, telemetry, and moderation while adding large-file chunking, WebDAV server, share landing pages, Airdrop, zero-knowledge Vault, and MCP.

License: **[GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE)**.
