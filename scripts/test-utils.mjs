/**
 * 测试共用工具：在内存 SQLite 上按顺序应用全部迁移。
 *
 * 为什么要按序全量加载而不是逐个写死文件名：
 *   migrations/ 是会随迭代增长的（0001 → 0002 → ...）。如果每个测试都硬编码
 *   `readFileSync('migrations/0001_files.sql')`，那么每加一个迁移就要改一遍
 *   所有测试 —— 漏改的测试会因为"列不存在"而失败，且失败信息（no such column）
 *   看起来像业务代码 bug，白白浪费排查时间。
 *
 * 这里按文件名排序全量 exec，新增迁移自动生效，测试与生产 schema 永远同步。
 *
 * @module test-utils
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');

/** 迁移目录（按文件名升序 = 执行顺序）。 */
export function migrationFiles() {
  const dir = join(ROOT, 'migrations');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => join(dir, name));
}

/**
 * 建一个内存 SQLite，按序应用全部迁移。
 * @returns {DatabaseSync}
 */
export function openMigratedDb() {
  const db = new DatabaseSync(':memory:');
  for (const file of migrationFiles()) {
    db.exec(readFileSync(file, 'utf8'));
  }
  return db;
}

/**
 * 把 node:sqlite 的 DatabaseSync 包装成 D1 的调用面
 * （prepare().bind().first()/all()/run()）。
 *
 * @param {DatabaseSync} db
 * @returns {{prepare: (sql: string) => any}}
 */
export function wrapAsD1(db) {
  const wrap = (sql, params = []) => ({
    bind(...args) { return wrap(sql, args); },
    async first() {
      const r = db.prepare(sql).get(...params);
      return r === undefined ? null : r;
    },
    async all() {
      return { results: db.prepare(sql).all(...params) };
    },
    async run() {
      const info = db.prepare(sql).run(...params);
      // D1 的 changes 同时出现在顶层与 meta 里，两者都给，覆盖不同读取习惯
      return { changes: info.changes, meta: { changes: info.changes } };
    },
  });
  return { prepare: (sql) => wrap(sql) };
}

/**
 * 一步构造「带全量迁移的内存 D1 环境」。
 * @returns {{_db: DatabaseSync, DB: object}}
 */
export function makeMigratedEnv() {
  const db = openMigratedDb();
  return { _db: db, DB: wrapAsD1(db) };
}
