# 文档导航

K-Vault-Next 的完整文档索引。**刚接手的话先看右列，别按目录翻。**

| 我想…… | 去这里 |
| :--- | :--- |
| 部署一个站点 | [`../../README.md`](../README.md) → 环境变量与部署章节 |
| 查某个环境变量怎么写 | [`../../README.md`](../README.md) → 环境变量完整清单 / [`.env.example`](../.env.example) |
| 搞懂整体架构与技术实现 | [`reference/architecture.md`](reference/architecture.md) |
| 迁移 / 上线 D1 数据库 | [`guides/d1-migration-checklist.md`](guides/d1-migration-checklist.md) |
| R2 绑定配不通 | [`guides/cloudflare-pages-r2.md`](guides/cloudflare-pages-r2.md) |
| 配置 Telegram / S3 / WebDAV 等后端 | [`guides/storage-backends.md`](guides/storage-backends.md) |
| 用 Token 调 API / 接 MCP Agent | [`reference/agent-integration.md`](reference/agent-integration.md) + [`reference/openapi.yaml`](reference/openapi.yaml) |
| 自动化（AI Agent）怎么改这个仓库 | [`agents/AI-OPERATIONS.md`](agents/AI-OPERATIONS.md) |
| 本地改完要跑哪些校验 | [`../scripts/verify/README.md`](../scripts/verify/README.md) |

---

## 运维指南 `guides/`

需要照着步骤动手做的事。

| 文件 | 内容 |
| :--- | :--- |
| [`d1-migration-checklist.md`](guides/d1-migration-checklist.md) | D1 迁移上线与灰度验证清单。含对账、回滚、用量监控 —— 全仓库工程质量最高的文档，**动 D1 前必读** |
| [`storage-backends.md`](guides/storage-backends.md) | Telegram / R2 / S3 / Discord / HuggingFace / WebDAV / GitHub 七种后端的逐步配置 |
| [`cloudflare-pages-r2.md`](guides/cloudflare-pages-r2.md) | R2 绑定失效时的排障短文（英文） |

## 参考 `reference/`

描述系统"是什么"的技术性文档。

| 文件 | 内容 |
| :--- | :--- |
| [`architecture.md`](reference/architecture.md) | 项目定位、与上游 K-Vault 的差异、技术架构（前端/后端/数据层/存储）、安全设计 |
| [`agent-integration.md`](reference/agent-integration.md) | API Token 获取、scopes、policies、幂等键、7 个 MCP Tools 映射 |
| [`openapi.yaml`](reference/openapi.yaml) | OpenAPI 3 机器可读的 API 定义 |

## 给 AI Agent `agents/`

| 文件 | 内容 |
| :--- | :--- |
| [`AI-OPERATIONS.md`](agents/AI-OPERATIONS.md) | 接手本项目必读。含本地环境、验证工具箱、Git 推送流程、事故复盘、**27 条铁律** |

> ⚠️ 这份文档是写给 AI Agent / 自动化助手的，不是给人类用户的。

## 归档 `archive/`

**历史快照，不再随代码更新。** 它们的价值是"当初为什么这么做"，不是"现在怎么做"。

| 文件 | 内容 |
| :--- | :--- |
| [`select-bar-bug-postmortem.md`](archive/select-bar-bug-postmortem.md) | 底部操作栏抽搐 Bug 的完整排障链路（含复现脚本源码） |
| [`frontend-unify-report.md`](archive/frontend-unify-report.md) | 前端统一化改造的一次性结项报告 |
| [`upstream-k-vault-reference.md`](archive/upstream-k-vault-reference.md) | **上游 `katelya77/K-Vault` 的 README 存档**，多处已过时，有 banner 警告 |

---

## 目录约定

- `guides/` —— 要动手照做的
- `reference/` —— 查"是什么"的
- `agents/` —— 给自动化工具看的
- `archive/` —— 只读历史，别拿它当现状

根目录只保留面向终端用户的 [`README.md`](../README.md) 和 [`README-EN.md`](../README-EN.md)，其余一律下沉到这里。
