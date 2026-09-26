# D1 迁移部署与灰度验证清单

> 适用范围：本项目把文件元数据、文件夹标记、合集分享从 Cloudflare KV 迁移到 D1
> （`migrations/0001~0003`）之后的首次上线与验证。
>
> **重要前提**：代码层已实现「D1 优先 / KV 兜底」双路径。**未绑定 D1 时行为与改造前
> 完全一致**——所以可以先合代码、后建库，不存在"必须同时切"的压力。
>
> **建表是自动的**：应用运行时首次访问 D1 会自动建表并补齐迁移（懒迁移），
> **不需要手动执行任何 SQL**。你唯一要手动做的是第 1 步的「创建 D1 数据库」
> ——这是 Cloudflare 的硬限制，CLI 才能建库。详见第 1.4 节。

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

绑库并部署、产生第一次访问后，确认表确实建出来了：

```bash
npx wrangler d1 execute k_vault --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

期望三张表：`bundle_files`、`bundles`、`files`，外加自动建的 `schema_migrations`。

**验证列齐全**：

```bash
npx wrangler d1 execute k_vault --remote --command "PRAGMA table_info(files)"
```

期望 **23 列**，其中必须包含 `is_folder`。

**验证迁移记录**：

```bash
npx wrangler d1 execute k_vault --remote --command "SELECT * FROM schema_migrations ORDER BY version"
```

期望三行：`0001_files`、`0002_folder_markers`、`0003_share_bundles`。

> 如果这里查不到表，说明要么 `DB` 绑定没生效（回到第 3 步），要么首次访问还没触发。
> 随便上传一个文件就能触发。

### 1.5 （可选）手动兜底

自动迁移失效时的应急手段。正常情况下**不需要跑**：

```bash
npx wrangler d1 execute k_vault --remote --file=./migrations/0001_files.sql
npx wrangler d1 execute k_vault --remote --file=./migrations/0002_folder_markers.sql
npx wrangler d1 execute k_vault --remote --file=./migrations/0003_share_bundles.sql
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

## 9. 本地回归测试

改动后跑一遍全部测试套件，确保没有回归：

```bash
for t in test-file-record test-file-record-upload test-quota \
         test-list-d1 test-folders-shares test-bundles; do
  printf "%-32s" "$t"
  node "scripts/$t.mjs" 2>&1 | grep "结果:"
done
```

期望：**6 套件全部 0 失败**（合计 180 个用例）。

这些测试基于 `node:sqlite` 在内存里跑真实 SQL，并自动加载 `migrations/` 下**全部**
迁移文件——所以新增迁移后无需改测试，schema 会自动跟上。

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
