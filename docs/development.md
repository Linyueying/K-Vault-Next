# 本地开发与贡献指南

面向开发者与自动化助手的工程手册：本地全栈启动、架构硬约束、必跑校验与分支工作流。

---

## 1. 快速启动本地全栈

本项目为纯 **Cloudflare Pages + Pages Functions** 架构，**无构建步骤、零运行时依赖**（仅需 Node 22+ 与 Python 3）：

```bash
npm install
npm start
```

需要自定义端口与持久化目录时，可直接运行：

```bash
npx wrangler pages dev ./ \
  --kv "img_url" \
  --r2=R2_BUCKET \
  --compatibility-date=2026-05-03 \
  --port 8099 \
  --persist-to /tmp/kvdata \
  --binding BASIC_USER=admin \
  --binding BASIC_PASS=123
```

关键说明：
- KV 绑定名必须为 `img_url`，R2 绑定名必须为 `R2_BUCKET`，D1 绑定名（可选）必须为 `DB`。
- 本地 `wrangler pages dev` 会读取 `.env` / `.dev.vars`；线上 Cloudflare Pages **不会**读取仓库内的 `.env`，仅认控制台环境变量与绑定。
- 不传 `BASIC_USER` / `BASIC_PASS` 时，管理接口默认 Fail-Closed 返回 `503`（生产环境必须配置）。

---

## 2. 工程硬约束

| 维度 | 约定 |
| :--- | :--- |
| **无构建步骤** | 仓库根目录即发布产物，禁止引入 Vite / Webpack / TS 编译产物或 `dist/` |
| **零运行时依赖** | 业务代码仅使用 Cloudflare Workers / Web Standard API，禁止添加 `dependencies` |
| **样式单一真源** | 公共 Design Token、组件与 `@keyframes` 必须写在 `assets/css/design-system.css`；**严禁在任何 `.html` 页面内联 `<style>` 中定义 `@keyframes`** |
| **共享 JS 层** | 通用工具统一收口在 `assets/js/app-core.js`（`window.KVault`），不在页面中重复实现 |
| **静态资源本地化** | 第三方前端库与图标字体放在 `assets/vendor/`，不引入外部 CDN（受严格 CSP 约束） |
| **D1 迁移真源** | 表结构唯一真源为 `functions/utils/schema.js`，修改后运行 `npm run d1:migrations` 自动生成 `migrations/*.sql`，不要手改 SQL 文件 |

---

## 3. 提交前必跑校验

```bash
# 1. 全量静态守卫 + 跨页共享层 + Functions 语法 + 模板编译（必跑）
npm run check

# 2. 后端单元测试套件（改动 functions/ 或迁移时必跑）
npm test
```

改动涉及前端渲染或动画交互时，可按需运行 `scripts/verify/` 下的 Playwright 浏览器验证脚本（详见 [`../scripts/verify/README.md`](../scripts/verify/README.md)）。

改动涉及 API 行为或新增配置项时，请同步更新：
- 环境变量清单：[`.env.example`](../.env.example) 与 [`README.md`](../README.md)
- API 规范：[`reference/openapi.yaml`](reference/openapi.yaml) 与 [`reference/agent-integration.md`](reference/agent-integration.md)

---

## 4. 分支与提交规范

- **`main`**：默认分支兼生产发布分支，始终保持可部署状态，重要版本打 `v1.x.x` Tag。
- **`dev`**：日常开发分支。新功能与修复在 `dev` 验证通过后，通过 **Squash Merge** 合入 `main`，合并完成后将 `dev` 对齐回 `main`，保持线性提交历史。
- **提交前缀**：遵循 Conventional Commits（`feat:` / `fix:` / `style:` / `refactor:` / `perf:` / `docs:` / `chore:`）。
- **开源协议**：本项目遵循 **GNU AGPL-3.0**（详见 [`LICENSE`](../LICENSE) 与 [`NOTICE`](../NOTICE)）。
