# 文档导航

K-Vault-Next 的完整文档索引，按使用场景快速定位：

| 我想…… | 去这里 |
| :--- | :--- |
| 5 分钟部署一个站点 | [`README.md`](../README.md)（[English](../README-EN.md)） |
| 查阅全部环境变量 | [`.env.example`](../.env.example) |
| 配置 7 大存储后端 / 排查 R2 绑定 | [`guides/storage-backends.md`](guides/storage-backends.md) |
| 迁移或上线 Cloudflare D1 数据库 | [`guides/d1-migration-checklist.md`](guides/d1-migration-checklist.md) |
| 了解系统整体架构与目录说明 | [`reference/architecture.md`](reference/architecture.md) |
| 接入 REST API v1 / MCP Agent / CLI | [`reference/agent-integration.md`](reference/agent-integration.md) + [`reference/openapi.yaml`](reference/openapi.yaml) |
| 了解大文件分片、配额与缓存机制 | [`reference/upload-download-optimization.md`](reference/upload-download-optimization.md) |
| 本地开发、运行校验与参与贡献 | [`development.md`](development.md) + [`scripts/verify/README.md`](../scripts/verify/README.md) |

---

## 目录结构

### 配置与运维 `guides/`
- [`storage-backends.md`](guides/storage-backends.md) — Telegram / R2（含绑定排障）/ S3 / Discord / HuggingFace / WebDAV / GitHub 七种后端逐步配置指南
- [`d1-migration-checklist.md`](guides/d1-migration-checklist.md) — D1 迁移上线、对账校验、回滚策略与用量监控清单

### 技术参考 `reference/`
- [`architecture.md`](reference/architecture.md) — 项目定位、页面与后端模块、数据层（KV / R2 / D1）、缩略图与安全设计
- [`agent-integration.md`](reference/agent-integration.md) — API Token、权限 Scope、原生 MCP 端点与 CLI 工具接入说明
- [`openapi.yaml`](reference/openapi.yaml) — OpenAPI 3 机器可读接口规范
- [`upload-download-optimization.md`](reference/upload-download-optimization.md) — 分片可重入状态机、内存安全边界、原子配额与边缘缓存设计

### 工程开发
- [`development.md`](development.md) — 本地 `wrangler` 调试、设计系统约束、`npm run check` 守卫与分支协作规范
