/**
 * Step 6 测试：storage 筛选下推到 SQL（D1 路径不再为筛选退回全量扫 KV）。
 *
 * 背景：folders.js 早期写的是 `!d1Stats.disabled && !storageFilter`，
 * 只要带 `?storage=` 就绕开 D1、退回 listAllKeys() 全量扫描 KV 命名空间，
 * 迁移带来的收益当场归零。现在 storage 下推给 SQL（files 表有 storage 列
 * 与 idx_files_storage 索引），本套件锁住这条路径的行为边界。
 *
 * 覆盖：
 *   [1] normalizeStorageFilter：'kv' 与 'telegram' 同义、大小写与空白
 *   [2] 不筛选时行为必须与改动前逐字段一致（防止改动误伤默认路径）
 *   [3] 筛选后只数命中的文件，且标记不再凭空造出 count=0 的目录
 *   [4] ?storage=kv 与 ?storage=telegram 结果一致
 *   [5] 经 listFolderStats 透传
 *   [6] D1 未绑定 → disabled（调用方回落 KV）
 *
 * 运行：node scripts/test-storage-filter.mjs
 */
import { folderFileCounts, normalizeStorageFilter } from '../functions/utils/metadata-d1.js';
import { listFolderStats } from '../functions/utils/file-record.js';
import { makeMigratedEnv } from './test-utils.mjs';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
};

function rawInsert(env, over = {}) {
  env._db.prepare(
    `INSERT INTO files (id, kv_key, is_folder, storage, storage_key, file_name,
       file_size, folder_path, uploaded_at, share_slug, share_password_hash,
       share_expires_at, share_max_downloads, share_download_count)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    over.id, over.kv_key ?? null, over.is_folder ?? 0, over.storage ?? 'r2',
    over.storage_key ?? null, over.file_name ?? 'f.png', over.file_size ?? 100,
    over.folder_path ?? null, over.uploaded_at ?? 1000,
    null, null, null, 0, 0
  );
}

function makeEnv() { return makeMigratedEnv(); }

console.log('[1] normalizeStorageFilter 归一化');
check("'kv' → 'telegram'", normalizeStorageFilter('kv') === 'telegram');
check("'R2' → 'r2'（大小写+空格）", normalizeStorageFilter('  R2 ') === 'r2');
check("'' → ''（不筛选）", normalizeStorageFilter('') === '');
check("undefined → ''", normalizeStorageFilter(undefined) === '');
check("'telegram' 保持", normalizeStorageFilter('telegram') === 'telegram');

console.log('[2] 不筛选时行为必须与改动前完全一致');
{
  const env = makeEnv();
  rawInsert(env, { id: 'f1', folder_path: 'photos', storage: 'r2' });
  rawInsert(env, { id: 'f2', folder_path: 'photos', storage: 'telegram' });
  rawInsert(env, { id: 'f3', folder_path: 'photos/2024', storage: 'r2' });
  rawInsert(env, { id: 'f4', folder_path: 'docs', storage: 'telegram' });
  rawInsert(env, { id: 'folder:photos', is_folder: 1, folder_path: 'photos', storage: 'folder', file_name: 'photos' });
  rawInsert(env, { id: 'folder:empty', is_folder: 1, folder_path: 'empty', storage: 'folder', file_name: 'empty' });

  const map = (await folderFileCounts(env)).folders;
  check('photos 计数 2', map.photos?.count === 2, String(map.photos?.count));
  check('photos/2024 计数 1', map['photos/2024']?.count === 1);
  check('docs 计数 1', map.docs?.count === 1);
  check('photos marker=true', map.photos?.marker === true);
  check('docs marker=false', map.docs?.marker === false);
  check('空目录 empty 仍出现（标记建出，count=0）', map.empty?.count === 0 && map.empty?.marker === true,
    JSON.stringify(map.empty));
}

console.log('[3] 筛选 r2：只数 r2 文件，且不凭空造目录');
{
  const env = makeEnv();
  rawInsert(env, { id: 'f1', folder_path: 'photos', storage: 'r2' });
  rawInsert(env, { id: 'f2', folder_path: 'photos', storage: 'telegram' });
  rawInsert(env, { id: 'f3', folder_path: 'photos/2024', storage: 'r2' });
  rawInsert(env, { id: 'f4', folder_path: 'docs', storage: 'telegram' });
  rawInsert(env, { id: 'folder:photos', is_folder: 1, folder_path: 'photos', storage: 'folder', file_name: 'photos' });
  rawInsert(env, { id: 'folder:empty', is_folder: 1, folder_path: 'empty', storage: 'folder', file_name: 'empty' });

  const map = (await folderFileCounts(env, { storage: 'r2' })).folders;
  check('photos 计数 1（telegram 那文件被排除）', map.photos?.count === 1, String(map.photos?.count));
  check('photos/2024 计数 1', map['photos/2024']?.count === 1);
  check('docs 不出现（无 r2 文件）', map.docs === undefined, JSON.stringify(map.docs));
  check('empty 不出现（标记不再凭空造目录）', map.empty === undefined, JSON.stringify(map.empty));
  check('photos marker 仍为 true（已有目录补标志）', map.photos?.marker === true);
  check('photos/2024 无标记', map['photos/2024']?.marker === false);
}

console.log('[4] 筛选 kv/telegram 同义');
{
  const env = makeEnv();
  rawInsert(env, { id: 'f1', folder_path: 'a', storage: 'telegram' });
  rawInsert(env, { id: 'f2', folder_path: 'b', storage: 'r2' });
  const byKv = (await folderFileCounts(env, { storage: 'kv' })).folders;
  const byTg = (await folderFileCounts(env, { storage: 'telegram' })).folders;
  check("?storage=kv 命中 telegram 文件", byKv.a?.count === 1, JSON.stringify(byKv));
  check("?storage=kv 与 ?storage=telegram 结果一致", JSON.stringify(byKv) === JSON.stringify(byTg));
  check("?storage=kv 不含 r2 目录 b", byKv.b === undefined);
}

console.log('[5] 经 listFolderStats 透传');
{
  const env = makeEnv();
  rawInsert(env, { id: 'f1', folder_path: 'a', storage: 'r2' });
  rawInsert(env, { id: 'f2', folder_path: 'b', storage: 'telegram' });
  const r = await listFolderStats(env, { storage: 'r2' });
  check('透传生效：只有 a', r.folders.a?.count === 1 && r.folders.b === undefined, JSON.stringify(r.folders));
  check('未 disabled', r.disabled !== true);
}

console.log('[6] D1 未绑定 → disabled（调用方回落 KV）');
{
  const r = await listFolderStats({}, { storage: 'r2' });
  check('disabled=true', r.disabled === true);
}

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
