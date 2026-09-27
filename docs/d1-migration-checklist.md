# D1 迁移部署与灰度验证清单

> 适用范围：本项目把文件元数据、文件夹标记、合集分享从 Cloudflare KV 迁移到 D1
> （`migrations/0001~0003`）之后的首次上线与验证。
>
> **重要前提**：代码层已实现「D1 优先 / KV 兜底」双路径。**未绑定 D1 时行为与改造前
> 完全一致**——所以可以先合代码、后建库，不存在"必须同时切"的压力。
>
> **建表是自动的**：应用运行时首次访问 D1 会自动建表并补齐迁移（懒迁移），
> **不需要手动执行任何 SQL**。
>
> **建库也是一条命令**：`bash scripts/setup-d1.sh` 自动建库并把 `database_id`
> 写进 `wrangler.toml`。这是全流程唯一需要你动手的地方——Cloudflare 没有
> 「部署时建库」的 API，数据库实例本身只能由 CLI 创建。

---

## 0. 先理解这次改动的风险面

在动手之前，先明确「绑上 D1 会发生什么」，这决定了验证的重点。

| 变化 | 风险等级 | 为什么 |
| :--- | :--- | :--- |
| 文件记录读路径改走 D1 | **高** | 读不到记录 = 文件无法下载。绑 D1 后 D1 miss 会回落 KV，但若 D1 里是**脏数据**（如 storage_key 错），不会回落而是报错 |
| 下载计数改走 D1 原子计数 | **高** | 计数是**单源**（迁移策略 A），D1 里的值就是唯一真相。KV 的 `dlc:` 不再被读 |
| 列表/分页走 SQL | 中 | 只影响后台面板显示，不影响文件本身的可访问性 |
| 文件夹标记存 D1 | 中 | 影响目录树显示与目录操作。**若不迁移存量标记，目录树会「空掉」** |
| 合集分享走 D1 | 中 | 未写入 D1 的存量合集在绑库后会「消失」（读路径 D1 miss → 回落 KV，实际能兜住，但需验证） |

**关键判断**：你之前确认过是**全新部署、无存量数据**。若确实如此，上面的"存量迁移"问题全部不存在，
可直接跳到第 3 步。若其实有存量数据，必须先做第 2 步的对账。

---

## 1. 建库（一次性）

### 1.1 确认 wrangler 可用

```bash
cd <项目根目录>
npx wrangler --version     # 应输出 4.x
npx wrangler whoami        # 确认已登录、且是目标账号
```

### 1.2 创建 D1 数据库

**一条命令搞定**（自动建库、解析 `database_id`、写入 `wrangler.toml`）：

```bash
bash scripts/setup-d1.sh
```

脚本会：检查 wrangler 与登录 → 创建数据库 → 把 `database_id` 写进 `wrangler.toml`
第 50 行 → 打印后续步骤。库已存在时会自动复用，不报错。

其他用法：

```bash
bash scripts/setup-d1.sh --name mydb        # 指定数据库名（默认 k_vault）
bash scripts/setup-d1.sh --id <uuid>        # 库已存在，只把 id 写进配置
bash scripts/setup-d1.sh --apply            # 顺带执行 migrations/*.sql（可选兜底）
bash scripts/setup-d1.sh --dry-run          # 只看会做什么，不改动任何文件
```

等价的手工命令（想自己来的时候）：

```bash
npx wrangler d1 create k_vault
```

输出形如：

```text
[[d1_databases]]
binding = "DB"
database_name = "k_vault"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**把 `database_id` 填进 `wrangler.toml` 的第 50 行**（替换 `<在此填入 ...>` 占位符）。

> ⚠️ `binding` 必须是 `DB`，不能改名。代码里所有数据层函数都读 `env.DB`
> （`metadata-d1.js`、`bundle-store.js` 的 `isD1Enabled()`）。

### 1.3 建表 —— **自动，无需手动执行**

应用运行时会**自动建表并补齐迁移**（懒迁移），所以这一步**什么都不用做**。

机制说明：

- 数据层首次访问 D1 时调用 `ensureSchema(env)`（`functions/utils/schema.js`）
- 它检查 `schema_migrations` 表，按顺序执行缺失的迁移
- 同一次 isolate 内只跑一次（module-level 缓存），后续请求零开销
- **之后每次部署若带了新迁移，也会自动应用**——isolate 重建时重新检查

幂等性是怎么保证的：

| 语句类型 | 幂等方式 |
| :--- | :--- |
| `CREATE TABLE / INDEX` | SQL 自带 `IF NOT EXISTS` |
| `ALTER TABLE ADD COLUMN` | **不自带幂等**。靠 `guard` 前置检查：`PRAGMA table_info()` 查列是否存在，已存在则跳过 |

> ⚠️ 这就是为什么 `ALTER TABLE` 那条（0002 加 `is_folder`）需要特殊处理——
> 重复执行会抛 `duplicate column name`。运行时有 guard 保护；
> 若你手动执行 `.sql` 文件，请确认只跑一次。

**DDL 的唯一来源是 `functions/utils/schema.js`**（JS 字符串常量），不是 `migrations/*.sql`。
原因是 Cloudflare Pages Functions 运行在 Workers 环境、**没有文件系统**，读不到 `.sql` 文件。
`migrations/*.sql` 只是由 `scripts/gen-migrations.py` 生成的副本，供人工排查与本地兜底，
**不要手工编辑**（会被覆盖）。

想重新生成 `.sql`：

```bash
python3 scripts/gen-migrations.py
```

### 1.4 验证建表（部署后做，不是现在）

**首选：打开自检端点**（需管理员登录，端点挂载在 `/api/admin/**` 下，
沿用现有 fail-closed 鉴权）：

```
https://<你的域名>/api/admin/db-status
```

返回示例：

```json
{
  "success": true,
  "d1": {
    "enabled": true,
    "healthy": true,
    "applied": [{"version": "0001_files", "applied_at": 1730000000000}],
    "missing": [],
    "tables": {
      "api_tokens": true, "audit_logs": true, "bundle_files": true,
      "bundles": true, "files": true, "pastes": true, "token_stats": true,
      "schema_migrations": true
    },
    "columns": {"files.is_folder": true, "files.file_type": true},
    "counts": {"files": 42, "bundles": 0, "bundle_files": 0, "api_tokens": 2, "pastes": 1, "audit_logs": 57, "token_stats": 2, "schema_migrations": 5}
  },
  "verdict": "D1 已就绪，表与迁移均完整。"
}
```

看 `verdict` 一句话就知道状态。四种结论：

| verdict | 含义 | 怎么办 |
| :--- | :--- | :--- |
| D1 已就绪，表与迁移均完整 | 正常 | 没了 |
| 迁移未跑完，缺 xxx | 懒迁移还没触发或失败了 | 加 `?apply=1` 再访问一次 |
| 迁移记录齐全但表/列有缺失 | 表被外部改动过 | 查 `?counts=1` 的 tables 字段定位 |
| D1 未绑定 | `env.DB` 不存在 | 回第 3 步检查 Pages 的 binding |

端点**只读**（不带 `?apply=1` 时一个字节都不写），也不返回任何文件元数据，
只有结构与计数，可以放心访问。表很大时加 `?counts=0` 跳过行数统计。

**备选：用 wrangler 查**（不想开浏览器时）：

```bash
npx wrangler d1 execute k_vault --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

期望 8 张表：`api_tokens`、`audit_logs`、`bundle_files`、`bundles`、`files`、
`pastes`、`token_stats`，外加自动建的 `schema_migrations`。

**验证列齐全**：

```bash
npx wrangler d1 execute k_vault --remote --command "PRAGMA table_info(files)"
```

期望 **24 列**，其中必须包含 `is_folder` 与 `file_type`。

**验证迁移记录**：

```bash
npx wrangler d1 execute k_vault --remote --command "SELECT * FROM schema_migrations ORDER BY version"
```

期望五行：`0001_files`、`0002_folder_markers`、`0003_share_bundles`、
`0004_file_type`、`0005_tokens_pastes_audit`。

> 如果这里查不到表，说明要么 `DB` 绑定没生效（回到第 3 步），要么首次访问还没触发。
> 随便上传一个文件就能触发。

### 1.5 （可选）手动兜底

自动迁移失效时的应急手段。正常情况下**不需要跑**：

```bash
bash scripts/setup-d1.sh --apply
```

> **不要跳号、不要乱序**。`0002` 依赖 `0001` 建出的 `files` 表。

---

## 2. 存量数据对账（仅在「有既有数据」时需要）

**全新部署跳过本节。**

### 2.1 盘点 KV 侧的既有数据

```bash
# 统计各类键的数量（在 Pages 项目所在账号执行）
npx wrangler kv key list --namespace-id <img_url 的 namespace id> --prefix "folder:" | jq length
npx wrangler kv key list --namespace-id <img_url 的 namespace id> --prefix "bundle:" | jq length
```

### 2.2 迁移文件记录

D1 需要的是「文件记录」行。KV 里符合"文件记录"判定的是：
**有 `fileName` 且有 `TimeStamp`** 的键（即 `shouldIncludeKey()` 的规则）。

对账方式：写一个一次性脚本读取 KV 全量键、调用 `registerFileRecord()` 写入 D1。
**不要手工拼 SQL**——`metadataToColumns()` 里有 storage_key 的推导逻辑
（从 `r2:xxx.png` 剥前缀），手写容易漏。

### 2.3 迁移文件夹标记

KV 里形如 `folder:<path>` 的键要搬成 `files` 表中 `is_folder = 1` 的行。
走 `upsertFolderMarker(env, path)` 写入，不要手工 INSERT——
它会同时填好 `id`、`kv_key`、`folder_path` 三个必须一致的字段。

### 2.4 迁移合集

走 `writeBundleRecord(env, bundle)`，**注意快照型的成员要一并写入 `bundle_files`**。

### 2.5 对账口径

迁移后必须让下面两个数字**完全相等**，否则说明搬漏了：

```bash
# D1 侧文件数
npx wrangler d1 execute k_vault --remote --command "SELECT COUNT(*) FROM files WHERE is_folder = 0"

# KV 侧 + 人工核对的期望值
```

---

## 3. 绑定到 Pages

D1 与 KV/R2 不同，**它需要 CLI 建库**，但绑定仍可在后台完成：

1. 打开 `Workers & Pages` → 你的 Pages 项目 → `Settings` → `Bindings`
2. **Production 和 Preview 都要加**（只加一个环境会导致另一个环境的预览版走 KV 路径，
   表现为"线上好了但预览还是旧的"，很容易误判）
3. 添加绑定：
   - Type: `D1 database`
   - Variable name: `DB` ← **必须完全一致**
   - Database: `k_vault`
4. 重新部署（Production）

> 如果项目已在用 `wrangler.jsonc` 作为绑定的事实来源（见
> [cloudflare-pages-r2.md](./cloudflare-pages-r2.md)），则 D1 也要写进该文件，
> 否则后台的绑定会被 wrangler 配置覆盖。

---

## 4. 验证「确实走了 D1 路径」

这是最关键的一步。**不能只看"页面能打开"就认为迁移成功**——因为
D1 路径失败了会自动回落 KV，页面照样正常，你会误以为一切顺利。

### 4.1 用 `source` 字段直接确认

为这次迁移，接口响应里加了 `source` 字段（仅后台接口）：

```bash
# 需要带管理鉴权 cookie 或 token
curl -s 'https://<你的域名>/api/manage/list?limit=1' | jq '.source'
```

| 返回值 | 含义 |
| :--- | :--- |
| `"d1"` | ✅ 走的是 D1 路径，迁移生效 |
| `"kv"` | ❌ 还是 KV，说明 D1 未绑定成功或查询报错回落了 |

同样可查：

```bash
curl -s 'https://<你的域名>/api/manage/shares'   | jq '.source'
curl -s 'https://<你的域名>/api/manage/folders'  | jq '.source'
curl -s 'https://<你的域名>/api/manage/share-bundles' | jq '.source'
```

### 4.2 查 D1 里是否真的有数据

`source: "d1"` 只说明查询走了 D1，**不代表 D1 里有数据**。如果 D1 是空的，
列表会是空的（且**不会**回落 KV——因为空表是"成功查询"，不是"查询失败"）。

```bash
npx wrangler d1 execute k_vault --remote --command "SELECT COUNT(*) FROM files"
npx wrangler d1 execute k_vault --remote --command "SELECT COUNT(*) FROM files WHERE is_folder = 1"
npx wrangler d1 execute k_vault --remote --command "SELECT COUNT(*) FROM bundles"
```

**上传一个新文件，再查一次**：计数应从 N 变成 N+1。这是最可靠的端到端验证。

---

## 5. 功能验证清单（逐项打勾）

绑库并部署后，按顺序走一遍。**每一项都要看结果，不要凭"应该没问题"跳过。**

### 5.1 上传链路

- [ ] 上传一个图片 → 成功
- [ ] `SELECT * FROM files ORDER BY uploaded_at DESC LIMIT 1` → 有这条记录
- [ ] 该记录的 `storage_key` 非空（如 `abc123.png`）——**空值会导致下载失败**
- [ ] 该记录的 `is_folder = 0`
- [ ] 该记录的 `folder_path` 与预期一致（根目录为 NULL）

### 5.2 下载链路

- [ ] 直接访问文件 URL → 能下载，内容正确
- [ ] 打开带 `dl=1` 的下载链接 → 能下载
- [ ] 看 D1：`share_download_count` 增加了 1

### 5.3 分享配额（原子计数）

- [ ] 建一个 `maxDownloads = 2` 的分享
- [ ] 下载 2 次 → 都成功
- [ ] 第 3 次 → 应返回 **410**（配额用尽）
- [ ] `SELECT share_download_count, share_max_downloads FROM files WHERE ...` → 计数停在 2，**没有超发到 3**
- [ ] 密码错误的请求 → **不消耗配额**（计数不变）

> 最后一条是本次改造的时序设计要点：先验密码、再预占配额。

### 5.4 后台面板

- [ ] 文件列表能显示，分页翻页正常（`cursor` 能往下走）
- [ ] 按存储类型筛选（`?storage=r2`）结果正确
- [ ] 文件夹树能显示，各目录的文件数正确
- [ ] 分享列表能显示，下载次数与 D1 一致
- [ ] 合集列表能显示

### 5.5 文件夹操作

- [ ] 新建文件夹 → `SELECT * FROM files WHERE is_folder = 1 AND folder_path = 'xxx'` 有行
- [ ] 重命名文件夹 → 目录内文件的 `folder_path` 全部跟着改
- [ ] 重命名后标记行的 **`id` 也变成了 `folder:<新路径>`**（不是 `folder:<旧路径>`）
- [ ] 删除空文件夹 → 成功
- [ ] 删除非空文件夹（不递归）→ 返回 **409**
- [ ] 删除非空文件夹（`recursive=1`）→ 文件被移回根目录（`folder_path` 变 NULL），**文件本身没被删**

### 5.6 合集分享

- [ ] 用「选文件」方式建合集 → 分享链接能打开，成员正确
- [ ] 用「选文件夹」方式建合集 → 分享链接能打开，成员随上传**实时变化**
- [ ] 合集配额：设 `maxDownloads=1`，下载 1 次后再访问 → 应被拒
- [ ] 删除合集 → `bundles` 和 `bundle_files` 两张表的相关行都清空

---

## 6. 回滚方案

**这是本次改造最大的优势**：回滚不需要改代码，只需解绑。

### 快速回滚（秒级）

1. Pages → Settings → Bindings
2. 删除 `DB` 这个 D1 绑定
3. 重新部署

之后所有数据层函数的 `isD1Enabled(env)` 返回 `false`，**自动回落 KV 老路径**，
行为与改造前一致。

> ⚠️ 回滚的前提是 **KV 里还有数据**。若已停止 KV 写入很久、D1 里才是最新数据，
> 回滚会"丢失 D1 期间产生的变更"。因此：
> - 灰度期间建议保持 KV 的双写（现有代码 `writeBundle` 仍然写 KV，文件记录也仍在写 KV）
> - 若要**彻底**停止 KV 写入，先确认稳定运行 1~2 周再动手

### 局部回滚

如果只是某类接口有问题（如文件夹操作），可以在对应文件里临时把 D1 分支短路：

```js
// functions/api/manage/folders.js
const d1Stats = await listFolderStats(env);
if (!d1Stats.disabled && !storageFilter && false) {  // ← 临时加 && false
```

比整体解绑更精细，适合"只有一个接口出问题"的场景。

---

## 7. 常见故障排查

| 现象 | 可能原因 | 排查方法 |
| :--- | :--- | :--- |
| `source` 恒为 `"kv"` | 绑定变量名不是 `DB` | 后台确认变量名拼写；Preview 环境是否也绑了 |
| `source` 为 `"d1"` 但列表为空 | D1 表是空的 | `SELECT COUNT(*) FROM files`；确认迁移数据是否搬了 |
| 报 `no such column: is_folder` | 只跑了 `0001`，漏了 `0002` | 重跑 `0002`；`PRAGMA table_info(files)` 确认 |
| 文件能列出来但下载 404 | `storage_key` 为空 | 查该行 `storage_key`；空则说明写入时 metadata 缺 `r2Key` 且 kvKey 无法推导 |
| 目录树整个空掉 | `is_folder` 标记没迁过来 | `SELECT COUNT(*) FROM files WHERE is_folder = 1` |
| 合集点开是空白页 | 快照型成员没写进 `bundle_files` | `SELECT COUNT(*) FROM bundle_files WHERE bundle_slug = 'xxx'` |
| 下载计数不涨 | 计数写到了 KV 而非 D1 | 确认 `source`；查 D1 的 `share_download_count` |
| 配额超发（下 3 次但 max=2） | 未走原子路径 | 理论上不可能，如出现请检查是否 D1 未绑定 |

---

## 8. 上线后的观察项

稳定运行后，定期检查：

```bash
# 1. D1 与 KV 是否存在漂移（若仍双写）
#    D1 的文件数应 >= KV 的文件数（D1 是超集）
npx wrangler d1 execute k_vault --remote --command "SELECT COUNT(*) FROM files WHERE is_folder = 0"

# 2. 是否有异常数据（storage_key 为空）
npx wrangler d1 execute k_vault --remote --command \
  "SELECT COUNT(*) FROM files WHERE is_folder = 0 AND storage_key IS NULL AND storage != 'telegram'"

# 3. 是否有孤儿成员（指向已删除文件）
npx wrangler d1 execute k_vault --remote --command \
  "SELECT COUNT(*) FROM bundle_files WHERE file_id NOT IN (SELECT id FROM files)"

# 4. 内容去重是否生效（同一 sha 不应有多行）
npx wrangler d1 execute k_vault --remote --command \
  "SELECT content_sha, COUNT(*) AS n FROM files WHERE content_sha IS NOT NULL GROUP BY content_sha HAVING n > 1"
```

四项都应为 **0**（第 1 项除外，它是数量统计）。

---

## 9. D1 用量监控

后台「用量」面板已支持 D1，与 KV / R2 并列展示。**存储部分零配置就能看**。

### 数据从哪来

| 指标 | 来源 | 是否需要配置 |
| :--- | :--- | :--- |
| 数据库大小 | 每次查询返回的 `meta.size_after`（Cloudflare 官方计费口径） | **不需要** |
| 各表行数、表数 | 本地 `COUNT(*)`（复用 `schemaStatus`） | **不需要** |
| 今日/本周期读写行数 | GraphQL `d1AnalyticsAdaptiveGroups` | 需要 `D1_DATABASE_ID` |
| 查询次数（读/写） | 同上 | 需要 `D1_DATABASE_ID` |

想看读写行数的话，在 Pages 的 Settings → Environment variables 加一条：

```
D1_DATABASE_ID = <你的 database_id>
```

这个值就是 `wrangler.toml` 里那个 `database_id`，也可以用 `npx wrangler d1 list` 查到。
**不配也完全能用**——只是读写行数那两栏会空着，并提示原因，其他指标照常显示。

### 额度参照

| 计划 | 存储 | 行数读取 | 行数写入 | 重置 |
| :--- | :--- | :--- | :--- | :--- |
| Free | 5 GB（账户总量） | 500 万 / 日 | 10 万 / 日 | 每日 00:00 UTC |
| Paid | 含 5 GB，超出 $0.75/GB-月 | 250 亿 / 月 | 5000 万 / 月 | 按月 |

> ⚠️ 免费计划超了每日读写额度，D1 会直接返回错误、查询跑不动（不是限速）。
> 存储满了则无法再插入数据。面板里进度条 >90% 会变红，留意一下。
>
> **索引能显著降低 rows read**——`files` 表已经建好了
> `uploaded_at` / `folder_path` / `content_sha` / `share_slug` / `storage` 等索引，
> 列表与查询都走索引，不会全表扫描。

---

## 10. 本地回归测试

改动后跑一遍全部测试套件，确保没有回归：

```bash
npm test
```

期望：**18 套件全部 0 失败**（合计 732 个用例）。

这些测试基于 `node:sqlite` 在内存里跑真实 SQL，并自动加载 `migrations/` 下**全部**
迁移文件——所以新增迁移后无需改测试，schema 会自动跟上。

其中 `test-usage-d1.mjs` 专门覆盖用量监控：D1 未绑定、缺 API 凭据、
缺 `D1_DATABASE_ID`、GraphQL 失败降级、免费/付费额度差异等 41 个用例。

`test-stats-aggregate.mjs` 是**对拍套件**（29 个用例）：同一批数据分别走
「SQL 聚合」与「内存聚合」两条路，逐字段比对结果必须完全一致，
用来保证 `0004_file_type` 迁移引入的 `file_type` 列与旧口径不漂移。

`test-shortlink-d1.mjs` 覆盖短链解析（45 个用例）。它最关键的断言不是
「跳转对不对」，而是**读取次数**：D1 可用时 KV 读必须为 0、D1 查询只能有 1 次。
功能正确但偷偷多读一次 KV 的回归最容易蒙混过关，所以要把次数也锁住。

`test-dedup-d1.mjs` 覆盖内容去重索引（34 个用例），断言同样是**次数**：
D1 可用时 KV 写必须为 0。另有两条语义断言 —— 超出 TTL 窗口不得命中
（复刻 KV 的 `expirationTtl`）、两种数据来源返回的字段名必须完全一致。

`test-folder-kv-guard.mjs` 是**守卫套件**（44 个用例），方向与上面几个相反 ——
它守的是「不该发生的事必须继续不发生」。`folders.js` 里残留大量 KV 时代的
全表逻辑（`listAllKeys()` 翻遍命名空间、`fstat:` 快照读写），D1 分支都提前
return 了，但**这类"理应走不到"的代码最危险**：一次 return 被重构掉就会在
生产上悄悄开始全表扫描，而功能完全正常，只有额度在飞速见底。
断言因此是调用次数：D1 可用时 `kv.list() === 0` 且 `fstat:` 的读写删均为 0。

`test-p5-d1.mjs` 覆盖 P5 的三类数据（115 个用例，13 个分组）：审计日志、
Paste、API Token。取向与 `test-dedup-d1.mjs` 一致 —— 断言
**D1 可用时 KV 的 get/put/delete/list 四个计数必须全为 0**。
它额外锁住三条最容易回归的不变式：

1. **局部更新不得覆盖未提及字段**。KV 版是整行覆盖，照抄成
   「先 SELECT 再整行 UPDATE」会让 `rotate`（改密钥）与
   `update`（改 enabled）并发时互相回退 —— 最坏是一个被禁用的令牌
   被轮换流程复活。测试里专门有一条「轮换后仍是禁用态」。
2. **遥测只花 1 次查询**。采样去抖被下推到 `ON CONFLICT ... WHERE`，
   写与不写都是 1 次；另有「SQL 侧自增 5 次后恰好等于 5」验证并发不丢计数。
3. **鉴权链路全程不碰 KV**，含 4 种失败分支（scope 不足 / 禁用 / 过期 /
   未知 id）。

配套的 `scripts/bench-p5.mjs` 输出四场景的 KV 调用对比（降级态 vs D1），
用来在改动后快速确认额度收益没有悄悄退化。

`test-slug-owner-d1.mjs`（33 用例）与 `test-metadata-write-d1.mjs`（36 用例）
是 **P3（停止 KV 双写）的准入检查**，锁住的是两个已经真实发生过的 bug：

- **短链唯一性校验只读 KV**。P3 停写后该校验会永久返回"空闲"，两个用户
  能拿到同一个短链。危险在于**停写后功能不会立刻坏** —— 存量键还在，
  读侧照常命中，只有新建短链时才出问题。
- **改名 / 移动目录只写 KV**。用户改名 → 接口返回成功 → 刷新列表还是旧名字。
  接口响应全对，只有"下一次读"才暴露。

这两类的共同点是**写侧与读侧走了不同的事实来源**，功能测试完全抓不到。
所以断言必须**跨接口**：写完之后用读侧路径再取一次。

> 搭这两个套件时踩到的三个替身陷阱，都写进了注释，避免后续重犯：
> 1. KV 替身的 `put` 误用 `JSON.parse` → 底层存成对象、读回多一层引号。
>    替身必须忠实模拟存储介质（KV 底层一律存字符串）。
> 2. `files.id` 是**剥离前缀后的裸 ID**，用 kvKey 当主键做 UPDATE 会
>    **静默更新 0 行**（不报错）。测试里留了一条反向断言专门钉住它。
> 3. 种子数据必须走 `putRecordIndex()` 而非直接 `putFileRecord()` ——
>    只有真实写入路径才会剥前缀，手写 ID 会造出「D1 里有行但按 ID 查不到」
>    的假数据。

`test-runtime-config.mjs`（40 用例）覆盖运行时配置的进程内缓存。这套 TTL
逻辑此前完全无覆盖，而它的两种错误方向都不报错：缓存不生效只是读放大，
缓存不失效则会让用户以为后台坏了。断言重点是**回源次数**与**主动失效后
同 tick 内可见性**。

> 这几个套件共同的取向：**把"资源用量"也当成契约来测**。
> 纯功能断言无法发现"结果对但多烧了一次额度"这类回归，而在免费额度
> 每小时都可能被打爆的场景里，那恰恰是最致命的一类。

---

## 11. 存储回滚模式（writeKvLegacy）

P3「停止 KV 双写」原本是一次**不可逆的代码改动**。实测收益只有每天再省
一次 KV 写，代价却是永久失去「解绑即回滚」的退路 —— 不划算。

所以改成**运行时可切换的开关**，把决定权交给运维：

| | `writeKvLegacy = true`（默认） | `writeKvLegacy = false` |
|---|---|---|
| 文件元数据写入 | D1 + KV 双写 | **仅 D1** |
| KV 文件记录键 | 写入 | **不写** |
| 读侧来源 | D1 优先，miss 回落 KV | D1（唯一来源） |
| 恢复方式 | — | 后台拨回开关，**无需重新部署** |

配置位置：`config:storage`（KV 覆盖）→ 环境变量 `KV_LEGACY_WRITE` 兜底。
后台入口：`admin.html` 设置面板 →「存储回滚模式」。

**默认必须是 `true`**：合入本改动不改变任何现网行为，停写是运维主动做出
且随时可撤销的决定。

### 开关只管「文件元数据」，不管全部 KV 写

这一点容易误解。`putKvFileMetadata()` 是唯一的闸门，它只拦
`env.img_url.put(kvKey, '', { metadata })` 这一类**文件记录主存储写入**。
以下 KV 键各有独立语义，**不随开关启停**：

| KV 键 | 为什么不受开关影响 |
|---|---|
| `session:*` | 登录态。停写等于把所有人踢下线。 |
| `chunk:*` / `upload:*` | 分片暂存。KV 后端的分片上传依赖它。 |
| `token_rl:*` / 限流计数 | 独立的窗口计数语义，与文件记录无关。 |
| `idem:*` 幂等缓存 | 重放保护，属请求语义。 |
| `fstat:__index__` 文件夹快照 | **纯 KV 缓存，没有 D1 对应物**。停写只会让每次读都退回全量扫描，白白多烧 D1 的 rows read 而无收益。 |

同理，**删除路径里的 D1 清理不受开关影响** —— 删除是"记录不该再存在"，
不是"要不要多写一份副本"。

### 零 KV 读的判定：分组配置镜像

判定点在**写路径**上（每次上传都要问一次"要不要写 KV"）。若为了判断
而多读一次 KV，就是用读额度换写额度，账面上不划算。

因此 `getRuntimeConfig(env,'storage')` 读回配置后，会把结果镜像进
进程内索引键（按 **KV 绑定对象身份**分区，见下），后续写路径直接命中
镜像、**零 KV 往返**。镜像丢失无任何正确性影响，只是多一次回源。

> 踩过的坑：`WeakMap` **没有 `size` 属性**。最初用 `map.size + 1` 生成
> 绑定 ID，`undefined + 1 === NaN`，于是所有绑定都叫 `kv:NaN`，
> 分区形同虚设 —— 表现为「A 环境关掉的开关，泄漏成了 B 环境的配置」。
> 已改为自维护单调计数器。

### `test-rollback-mode.mjs`（46 用例）

主体断言是**资源用量**而非功能结果（两种模式下功能结果都一样）：

1. 默认开启 → KV 确实被写。
2. **关闭后 KV 写为 0**，但 D1 有记录、读侧仍能读到。
3. 判定过程**不产生额外 KV 读**（镜像生效）。
4. 重新开启 → 写入立即恢复（可逆性）。
5. settings API 读写往返；`writeKvLegacy` 非布尔一律 400
   （不接受 `'false'` / `0`，避免"以为关了其实没关"）。

> ⚠️ **替身陷阱（第 4 个，前三个见第 10 节）**：早期套件的 KV 替身把
> `value` 与 `metadata` 混成一个 `{value, metadata}` 对象整体序列化，
> 于是 `get(key,{type:'json'})` 返回**包装体而不是 value**。
> 文件记录链路只走 `getWithMetadata`，所以缺陷一直没暴露；但**运行时配置
> 正是用 `get(key,{type:'json'})` 读的** —— 用那个替身会读到包装体，
> 归一化时找不到 `writeKvLegacy`，静默回退成默认 `true`，
> 表现成"明明关了开关却还在写 KV"。本套件按真实语义分开存两份。

---

## 附：本次迁移消除的历史包袱

迁移完成后，以下几类 KV 辅助键**不再需要**（D1 表结构已替代）：

| 旧 KV 键 | 替代物 |
| :--- | :--- |
| `idxt:<裸ID>` | `files.id` 主键 |
| `dlc:<kvKey>` | `files.share_download_count`（原子自增） |
| `sha_dup:<sha>` | `files.content_sha` 部分唯一索引 |
| `fstat:__index__` | `GROUP BY folder_path` 实时聚合 |
| `bundle_slug:<slug>` | `bundles.slug` 主键 |

> `s/[slug].js` 的分享跳转仍读 `bundle_slug:`，属独立链路，未纳入本次迁移。
