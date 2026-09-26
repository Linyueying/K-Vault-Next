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

SCHEMA = "/workspace/K-Vault-Next/functions/utils/schema.js"
OUT_DIR = "/workspace/K-Vault-Next/migrations"

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
}


def main():
    src = open(SCHEMA, encoding="utf-8").read()

    # 提取形如 const M0001_FILES = [ `...`, `...` ]; 的数组
    blocks = {}
    for m in re.finditer(r"const (M\d{4}_\w+)\s*=\s*\[(.*?)\n\];", src, re.S):
        name, body = m.group(1), m.group(2)
        stmts = re.findall(r"`(.*?)`", body, re.S)
        blocks[name] = [s.strip() for s in stmts if s.strip()]

    # 提取 MIGRATIONS 清单的顺序与 id
    # 注意：条目可能带 guard 字段（如 0002），所以 id 与 statements 之间
    # 可能有任意内容，不能假设两者相邻。
    mig_src = re.search(r"export const MIGRATIONS = \[(.*?)\n\];", src, re.S).group(1)
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
