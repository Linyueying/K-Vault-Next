#!/usr/bin/env python3
"""
从 functions/utils/schema.js 生成 migrations/*.sql。

为什么要生成：Cloudflare Pages Functions 没有文件系统，读不到 .sql，
所以 DDL 必须以 JS 常量形式存在（schema.js 是唯一来源）。
但人工排查、本地 `wrangler d1 execute` 偶尔还是想要 .sql 文件 ——
于是由本脚本从 JS 生成，保证两处绝不漂移。

**不要手工编辑 migrations/*.sql**，改动请改 schema.js 后重跑本脚本。
"""
import re
import os
import textwrap

# 自定位到仓库根：不要写死绝对路径，否则仓库克隆到别处会立刻失效
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA = os.path.join(REPO_ROOT, "functions/utils/schema.js")
OUT_DIR = os.path.join(REPO_ROOT, "migrations")

# 每个迁移对应的说明文字（纯文档性质，不影响执行）
NOTES = {
    "0001_files": """--
-- 目标：把原本压在 KV 里的「文件记录 + 分享设置 + 下载计数 + 去重索引」
--       收敛到一张表，顺带消灭三个历史包袱：
--
--   1. `idxt:<裸ID>` 索引层      → D1 主键（id）天然是索引，直接删除
--   2. `dlc:<kvKey>` 独立计数键  → 表内字段 + 原子自增（不再 read-modify-write）
--   3. `sha_dup:<sha>` 去重索引  → content_sha 唯一索引（INSERT 冲突即命中）
--
-- 字段来源对照（原 KV metadata 字段 → 本表列）：
--   TimeStamp            → uploaded_at
--   fileName             → file_name
--   fileSize             → file_size
--   storageType/storage  → storage
--   r2Key / s3Key / ...  → storage_key
--   folderPath           → folder_path
--   ListType             → list_type
--   Label                → label
--   liked                → liked
--   shareSlug            → share_slug
--   sharePasswordSalt    → share_password_salt
--   sharePasswordHash    → share_password_hash
--   shareExpiresAt       → share_expires_at
--   shareMaxDownloads    → share_max_downloads
--   shareDownloadCount   → share_download_count
""",
    "0002_folder_markers": """--
-- 背景：0001 的 files 表只描述"文件"，但还有一类记录——**文件夹标记**
--       （KV 中的 `folder:<path>` 键，metadata.folderMarker=true）。
--       它让"空文件夹"也能在目录树里存在。
--
-- 为什么不做成独立的 folders 表：
--   文件夹标记与文件记录共享同一套生命周期（重命名目录时两者都要改
--   folder_path；删除目录时两者都要处理），且都需要按 folder_path 前缀查询。
--   放进同一张表，一次 UPDATE 就能同时覆盖"目录下的文件"与"目录的标记"。
--
-- 为什么用 is_folder 而不是复用 storage 列：
--   storage 表达的是"文件存在哪个后端"，把 'folder' 塞进去会污染取值域，
--   让所有 `storage = 'r2'` 这类查询必须额外排除文件夹行。
--   列级 DEFAULT 0 保证存量行自动获得 is_folder = 0，无需回填。
--
-- ⚠️ 注意：ALTER TABLE ADD COLUMN **不幂等**，重复执行会报
--    "duplicate column name"。运行时自动迁移靠 schema.js 里的 guard
--    （PRAGMA table_info 查列）保护；手动执行本文件时请确认只跑一次。
""",
    "0003_share_bundles": """--
-- 背景：`share-bundle.js` 把合集定义存在 KV 的 `bundle:<slug>` 键上，
--       再用 `bundle_slug:<slug>` 做存在性索引。
--
-- 为什么合集**不能**塞进 files 表：
--   files 的主键是"文件 ID"，每条记录对应一个可下载的实体。
--   合集不是文件——它是一个"链接"，指向若干文件（快照型）或一个目录
--   （实时型）。配额语义也不同：文件计数是"这个文件被下载几次"，
--   合集计数是"这个链接被打开几次"。同一文件可以既在合集里、
--   又有自己的单文件分享，两条配额线各算各的。
--
-- 表结构映射（原 KV metadata → 列）：
--   slug → slug（PRIMARY KEY）    type → type
--   fileIds → bundle_files 关联表  folderPath → folder_path
--   includeSubfolders → include_subfolders
--   expiresAt → expires_at        maxDownloads → max_downloads
--   downloadCount → download_count
--   passwordSalt → password_salt  passwordHash → password_hash
--   createdAt → created_at        label → label
--
-- 成员拆成独立表而非 JSON 数组：成员顺序需稳定保留（分享页按加入顺序
-- 展示），用 position 列表达；且需支持反查"某文件被哪些合集引用"。
""",
    "0006_files_share_title": """--
-- 背景：分享此前只有"系统给的名字"——单文件分享显示真实文件名，既不能
--       给访客一个更好懂的标题，也无处附一句说明。
--
-- 本列是单文件分享的**展示标题**（KV metadata 里的 shareTitle）。
-- 允许为 NULL：NULL 表示"回退到真实文件名"，存量数据因此零改动即可工作。
--
-- 为什么允许为空而不回填：分享标题是**可选增强**。强制必填会让每次创建
--       分享都要先想个名字；把回退逻辑放在读取侧（接口与页面各一处）
--       比在写入侧给历史数据造标题便宜得多。
--
-- ⚠️ ALTER TABLE ADD COLUMN 不幂等，靠 schema.js 的 guard 保护。
--    刻意**每条列一个迁移**：若四条 ALTER 挤在同一条迁移里，一旦出现
--    "files 已加列、bundles 未加列"的半应用状态，重跑时第一条 ALTER 就会
--    抛 duplicate column name，整段迁移失败且版本不被标记 —— 迁移将卡死。
""",
    "0007_files_share_description": """--
-- 单文件分享的**展示描述**（KV metadata 里的 shareDescription）。
-- 与 0006 的 share_title 同批次引入，理由与注意事项完全相同。
--
-- 标题回答"这是什么"，描述回答"有什么要注意的"（例如"原图未压缩，
-- 单张约 8 MB"）。两者都允许为空，空即不渲染对应区块。
""",
    "0008_bundles_title": """--
-- 合集 / 目录分享的**展示标题**（对应单文件侧的 files.share_title）。
--
-- 为什么合集更需要它：合集的默认标题只能是「N 个文件的合集」这种没有
--       辨识度的文案，而合集恰恰承载"一次打包若干文件给人"的场景 ——
--       一个能自己命名的标题（"年会照片"、"Q3 报销凭证"）价值最大。
--
-- 历史兼容：bundles 原本就有 label 列但从未被使用。这里新增 title 而不
--       复用 label，是为了让"标题"这个语义有唯一归属；读取侧以
--       "优先 title、为空回退 label"的顺序兼容早期可能写进 label 的数据。
""",
    "0009_bundles_description": """--
-- 合集 / 目录分享的**展示描述**（对应单文件侧的 files.share_description）。
-- 与 0008 的 title 同批次引入，理由与注意事项完全相同。
""",

}

HEADER = """-- ============================================================================
-- {filename} — {title}
-- ============================================================================
--
-- ⚠️ 本文件由 scripts/gen-migrations.py 从 functions/utils/schema.js
--    **自动生成**，请勿手工编辑（改动会被覆盖）。
--
--    运行时并不需要本文件 —— Cloudflare Pages Functions 没有文件系统，
--    读不到 .sql；实际建表由 schema.js 的 ensureSchema() 在首次访问 D1 时
--    自动完成（懒迁移）。本文件仅用于人工排查与本地兜底。
--
--    唯一来源：functions/utils/schema.js
--    重新生成：python3 scripts/gen-migrations.py
{notes}-- ============================================================================

"""

TITLES = {
    "0001_files": "K-Vault 文件元数据表（D1）",
    "0002_folder_markers": "文件夹标记纳入 files 表",
    "0003_share_bundles": "合集分享（bundle）纳入 D1",
    "0006_files_share_title": "分享标题（files.share_title）",
    "0007_files_share_description": "分享描述（files.share_description）",
    "0008_bundles_title": "合集分享标题（bundles.title）",
    "0009_bundles_description": "合集分享描述（bundles.description）",
}


def strip_js_comments(text: str) -> str:
    """
    去掉 JS 的行注释与块注释。

    ## 为什么必须做这一步

    常量数组里的 SQL 是用反引号包起来的字符串，但**注释里也常有反引号**
    （写文档时习惯用反引号标出键名、列名）。之前的实现直接对整个数组体
    `re.findall(r"`(.*?)`")`，于是注释中的反引号片段会被当成一条 SQL 语句
    抽出去。

    这个 bug 的表现很有迷惑性：生成的 .sql 里多出一行垃圾（例如
    `token_stat:<id>;`），而 **schema.js 本身完全正常** —— 运行时懒迁移
    不读 .sql，所以线上毫无症状；只有本地测试加载 migrations/ 时才炸，
    报一个和真实原因毫无关系的语法错误。

    先剥注释再抽字符串，从源头消除这类误判。
    注意：SQL 字符串内部按约定不使用 `//` 与 `/* */`，因此可以安全地
    全文剥离（不做词法分析）。
    """
    # 块注释（非贪婪，支持跨行）
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    # 行注释：仅当 // 不在反引号字符串内时才剥离。
    # 逐行处理并跟踪反引号配对状态，避免误伤 SQL 里的字符串字面量。
    out_lines = []
    for line in text.split("\n"):
        in_tick = line.count("`") % 2 == 1
        idx = line.find("//")
        if idx != -1 and not in_tick:
            out_lines.append(line[:idx])
        else:
            out_lines.append(line)
    return "\n".join(out_lines)


def main():
    src = open(SCHEMA, encoding="utf-8").read()

    # 提取形如 const M0001_FILES = [ `...`, `...` ]; 的数组
    blocks = {}
    for m in re.finditer(r"const (M\d{4}_\w+)\s*=\s*\[(.*?)\n\];", src, re.S):
        name, body = m.group(1), m.group(2)
        # 先剥注释，再抽反引号字符串 —— 否则注释里的反引号会被误当成 SQL
        stmts = re.findall(r"`(.*?)`", strip_js_comments(body), re.S)
        blocks[name] = [s.strip() for s in stmts if s.strip()]

    # 迁移清单在数组体外，但同样可能被注释干扰（如 guard 字段的说明），
    # 一并剥离后再解析顺序。
    src_for_order = strip_js_comments(src)

    # 提取 MIGRATIONS 清单的顺序与 id
    # 注意：条目可能带 guard 字段（如 0002），所以 id 与 statements 之间
    # 可能有任意内容，不能假设两者相邻。
    mig_src = re.search(r"export const MIGRATIONS = \[(.*?)\n\];", src_for_order, re.S).group(1)
    order = []
    for m in re.finditer(r"\{\s*id:\s*'([^']+)'.*?statements:\s*(\w+)", mig_src, re.S):
        order.append((m.group(1), m.group(2)))

    os.makedirs(OUT_DIR, exist_ok=True)

    for mig_id, const_name in order:
        stmts = blocks.get(const_name)
        if not stmts:
            print(f"⚠️  找不到 {const_name} 的内容，跳过")
            continue

        filename = f"{mig_id}.sql"
        content = HEADER.format(
            filename=filename,
            title=TITLES.get(mig_id, mig_id),
            notes=NOTES.get(mig_id, ""),
        )
        content += "\n\n".join(stmt + ";" for stmt in stmts) + "\n"

        path = os.path.join(OUT_DIR, filename)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"生成 {filename}  （{len(stmts)} 条语句）")


if __name__ == "__main__":
    main()
