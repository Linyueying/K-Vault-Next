/**
 * Step 7 测试：stats 聚合下推 SQL 后，口径必须与内存版逐字段一致。
 *
 * 背景：`/api/manage/list` 原先为算 stats 要把**全部文件行**取回内存
 * （listAllRecords 按 200 一批 OFFSET 翻页、每批重跑 COUNT(*)，扫描量 O(N²)）。
 * 现在改成 aggregateFileStats() 一条条件聚合 SQL。
 *
 * 这个改动最大的风险不是性能，而是**两条路径口径漂移** —— SQL 版的统计
 * 与内存版差一个，后台面板的数字就错了，而且错得很安静。本套件用「对拍」
 * 守住这一点：同一批数据分别走两条实现，要求逐字段完全相等。
 *
 * 覆盖：
 *   [1] 空表
 *   [2] 单一类型
 *   [3] 混合类型 + 混合存储（对拍核心）
 *   [4] 文件夹标记不得计入（is_folder=1 的行要排除）
 *   [5] 未知 storage 取值不计入 byStorage（与内存版 hasOwnProperty 一致）
 *   [6] file_type 由 inferFileType 推断，与 normalizeKey 的结果一致
 *   [7] storage 筛选：?storage=kv 与 ?storage=telegram 同义
 *   [8] storage 筛选后 total 只数命中的
 *   [9] D1 未绑定 → disabled（调用方回落内存计算）
 *
 * 运行：node scripts/test-stats-aggregate.mjs
 */

import { aggregateFileStats } from '../functions/utils/metadata-d1.js';
import { computeStats, normalizeKey, inferFileType } from '../functions/utils/file-list.js';
import { listAllRecords } from '../functions/utils/file-record.js';
import { makeMigratedEnv } from './test-utils.mjs';

let pass = 0;
let fail = 0;
function check(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}

/** 直接插一行（绕过业务层）。 */
function rawInsert(env, over = {}) {
  env._db.prepare(
    `INSERT INTO files (id, kv_key, is_folder, storage, storage_key, file_type,
       file_name, file_size, folder_path, uploaded_at, share_slug,
       share_password_hash, share_expires_at, share_max_downloads, share_download_count)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    over.id, over.kv_key ?? null, over.is_folder ?? 0, over.storage ?? 'r2',
    over.storage_key ?? null, over.file_type ?? null,
    over.file_name ?? 'f.png', over.file_size ?? 100,
    over.folder_path ?? null, over.uploaded_at ?? 1000,
    null, null, null, 0, 0
  );
}

const makeEnv = () => makeMigratedEnv();

/** 走旧路径：全量取回 → normalizeKey → 内存 computeStats。 */
async function statsViaMemory(env, options = {}) {
  const full = await listAllRecords(env, options);
  return computeStats(full.files.map(normalizeKey));
}

console.log('[1] 空表');
{
  const env = makeEnv();
  const a = (await aggregateFileStats(env)).stats;
  const b = await statsViaMemory(env);
  check('total = 0', a.total === 0);
  check('与内存版一致', JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}

console.log('[2] 单一类型');
{
  const env = makeEnv();
  rawInsert(env, { id: 'a.png', file_name: 'a.png', file_type: 'image', storage: 'r2' });
  const a = (await aggregateFileStats(env)).stats;
  check('total = 1', a.total === 1);
  check('byType.image = 1', a.byType.image === 1);
  check('byStorage.r2 = 1', a.byStorage.r2 === 1);
  check('与内存版一致', JSON.stringify(a) === JSON.stringify(await statsViaMemory(env)));
}

console.log('[3] 混合类型 + 混合存储（对拍核心）');
{
  const env = makeEnv();
  const rows = [
    ['i1', 'a.jpg', 'image', 'r2'],
    ['i2', 'b.png', 'image', 'telegram'],
    ['v1', 'c.mp4', 'video', 'r2'],
    ['v2', 'd.webm', 'video', 's3'],
    ['a1', 'e.mp3', 'audio', 'discord'],
    ['a2', 'f.flac', 'audio', 'huggingface'],
    ['d1', 'g.pdf', 'document', 'webdav'],
    ['d2', 'h.txt', 'document', 'github'],
    ['d3', 'noext', 'document', 'telegram'],
  ];
  for (const [id, name, ft, st] of rows) {
    rawInsert(env, { id, kv_key: `${st}:${name}`, file_name: name, file_type: ft, storage: st });
  }

  const a = (await aggregateFileStats(env)).stats;
  const b = await statsViaMemory(env);
  check('total = 9', a.total === 9, String(a.total));
  check('byType 分布正确',
    a.byType.image === 2 && a.byType.video === 2 && a.byType.audio === 2 && a.byType.document === 3,
    JSON.stringify(a.byType));
  check('byStorage 分布正确',
    a.byStorage.r2 === 2 && a.byStorage.telegram === 2 && a.byStorage.s3 === 1
      && a.byStorage.discord === 1 && a.byStorage.huggingface === 1
      && a.byStorage.webdav === 1 && a.byStorage.github === 1,
    JSON.stringify(a.byStorage));
  check('★ 与内存版逐字段一致', JSON.stringify(a) === JSON.stringify(b),
    `SQL=${JSON.stringify(a)}\n     内存=${JSON.stringify(b)}`);
}

console.log('[4] 文件夹标记不得计入');
{
  const env = makeEnv();
  rawInsert(env, { id: 'f1', file_name: 'a.png', file_type: 'image', storage: 'r2', folder_path: 'docs' });
  rawInsert(env, {
    id: 'folder:docs', is_folder: 1, storage: 'folder', file_name: 'docs',
    folder_path: 'docs', file_type: 'document',
  });
  rawInsert(env, {
    id: 'folder:empty', is_folder: 1, storage: 'folder', file_name: 'empty',
    folder_path: 'empty', file_type: 'document',
  });
  const a = (await aggregateFileStats(env)).stats;
  check('total = 1（两个标记被排除）', a.total === 1, String(a.total));
  check('folder 存储不计入 byStorage', a.byStorage.telegram === 0 && a.byStorage.r2 === 1,
    JSON.stringify(a.byStorage));
}

console.log('[5] 未知 storage 不计入 byStorage');
{
  const env = makeEnv();
  rawInsert(env, { id: 'x1', file_name: 'a.png', file_type: 'image', storage: 'weird-backend' });
  rawInsert(env, { id: 'x2', file_name: 'b.png', file_type: 'image', storage: 'r2' });
  const a = (await aggregateFileStats(env)).stats;
  const b = await statsViaMemory(env);
  check('total 仍数 2（未知值也算文件）', a.total === 2, String(a.total));
  check('未知值不入任何桶', Object.values(a.byStorage).reduce((s, n) => s + n, 0) === 1);
  check('★ 与内存版一致', JSON.stringify(a) === JSON.stringify(b),
    `SQL=${JSON.stringify(a)}\n     内存=${JSON.stringify(b)}`);
}

console.log('[6] file_type 推断与 normalizeKey 一致');
{
  const cases = [
    ['photo.JPG', 'image'], ['a.png', 'image'], ['clip.MP4', 'video'],
    ['song.mp3', 'audio'], ['notes.txt', 'document'], ['noext', 'document'],
  ];
  for (const [name, expected] of cases) {
    const inferred = inferFileType(`r2:${name}`, { fileName: name });
    const env = makeEnv();
    rawInsert(env, { id: name, kv_key: `r2:${name}`, file_name: name, file_type: inferred, storage: 'r2' });
    const a = (await aggregateFileStats(env)).stats;
    const b = await statsViaMemory(env);
    check(`${name} → ${expected}（SQL 与内存一致）`,
      inferred === expected && JSON.stringify(a) === JSON.stringify(b),
      `inferred=${inferred}`);
  }
}

console.log('[7] storage 筛选：kv 与 telegram 同义');
{
  const env = makeEnv();
  rawInsert(env, { id: 't1', file_name: 'a.png', file_type: 'image', storage: 'telegram' });
  rawInsert(env, { id: 'r1', file_name: 'b.png', file_type: 'image', storage: 'r2' });
  const byKv = (await aggregateFileStats(env, { storage: 'kv' })).stats;
  const byTg = (await aggregateFileStats(env, { storage: 'telegram' })).stats;
  check('total = 1', byKv.total === 1, String(byKv.total));
  check('byStorage.telegram = 1', byKv.byStorage.telegram === 1);
  check('kv 与 telegram 结果相同', JSON.stringify(byKv) === JSON.stringify(byTg));
}

console.log('[8] 筛选 r2 后只数 r2 文件');
{
  const env = makeEnv();
  rawInsert(env, { id: 't1', file_name: 'a.png', file_type: 'image', storage: 'telegram' });
  rawInsert(env, { id: 'r1', file_name: 'b.mp4', file_type: 'video', storage: 'r2' });
  rawInsert(env, { id: 'r2', file_name: 'c.mp3', file_type: 'audio', storage: 'r2' });
  const a = (await aggregateFileStats(env, { storage: 'r2' })).stats;
  const b = await statsViaMemory(env, { storage: 'r2' });
  check('total = 2', a.total === 2, String(a.total));
  check('byType.video=1, audio=1, image=0',
    a.byType.video === 1 && a.byType.audio === 1 && a.byType.image === 0,
    JSON.stringify(a.byType));
  check('★ 与内存版一致', JSON.stringify(a) === JSON.stringify(b),
    `SQL=${JSON.stringify(a)}\n     内存=${JSON.stringify(b)}`);
}

console.log('[9] D1 未绑定 → disabled');
{
  const r = await aggregateFileStats({}, { storage: 'r2' });
  check('disabled = true', r.disabled === true);
  check('stats 为 null', r.stats === null);
}

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
