-- ============================================================================
-- 0009_bundles_description.sql — 合集分享描述（bundles.description）
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
--
-- 合集 / 目录分享的**展示描述**（对应单文件侧的 files.share_description）。
-- 与 0008 的 title 同批次引入，理由与注意事项完全相同。
-- ============================================================================

ALTER TABLE bundles ADD COLUMN description TEXT;
