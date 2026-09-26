/**
 * Step 4 测试：列表/分页从 KV 全量扫描迁到 D1。
 *
 * 覆盖：
 *   [1] listAllRecords 全量拉取（含 >200 行跨批翻页）
 *   [2] listRecordsPage SQL 分页（第 1/2/3 页边界）
 *   [3] sort 排序下推（sizeasc / timeasc）
 *   [4] storage 过滤下推
 *   [5] folderPath 过滤下推（'' 语义 = 根目录 = NULL）
 *   [6] d1FileToKey 形状与 KV getWithMetadata 对齐（下游零改动的前提）
 *   [7] D1 未绑定 → disabled，调用方回落 KV
 *   [8] 排序白名单：非法 sort 不得注入 SQL
 *
 * 运行：node scripts/test-list-d1.mjs
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  listFileRecords,
} from '../functions/utils/metadata-d1.js';
import {
  d1FileToKey,
  listRecordsPage,
  listAllRecords,
} from '../functions/utils/file-record.js';
import { makeMigratedEnv } from './test-utils.mjs';

let pass = 0;
let fail = 0;

function check(label, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 用内存 SQLite 模拟 D1，接口面只暴露 prepare().bind().all()/first()/run()。 */
function makeEnv() {
  const { _db, DB } = makeMigratedEnv();
  return { _db, DB };
}

/** 造一行数据。 */
function insert(env, over = {}) {
  const row = {
    id: over.id ?? `id-${Math.random().toString(36).slice(2, 8)}`,
    kv_key: over.kv_key ?? null,
    storage: over.storage ?? 'r2',
    storage_key: over.storage_key ?? null,
    file_name: over.file_name ?? 'a.png',
    file_size: over.file_size ?? 100,
    folder_path: over.folder_path ?? null,
    uploaded_at: over.uploaded_at ?? Date.now(),
    content_sha: over.content_sha ?? null,
    share_slug: over.share_slug ?? null,
    share_max_downloads: over.share_max_downloads ?? 0,
    share_download_count: over.share_download_count ?? 0,
  };
  env._db
    .prepare(
      `INSERT INTO files (id, kv_key, storage, storage_key, file_name, file_size,
         folder_path, uploaded_at, content_sha, share_slug,
         share_max_downloads, share_download_count)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      row.id, row.kv_key, row.storage, row.storage_key, row.file_name, row.file_size,
      row.folder_path, row.uploaded_at, row.content_sha, row.share_slug,
      row.share_max_downloads, row.share_download_count
    );
  return row;
}

async function main() {
  // ==========================================================================
  console.log('[1] listAllRecords 全量拉取（跨批翻页）');
  {
    const env = makeEnv();
    const base = 1_700_000_000_000;
    // 造 450 行 → 必须翻 3 批（200/200/50）
    for (let i = 0; i < 450; i += 1) {
      insert(env, {
        id: `f${i}`,
        kv_key: `r2:f${i}.png`,
        storage_key: `f${i}.png`,
        file_name: `f${i}.png`,
        uploaded_at: base + i,
      });
    }
    const res = await listAllRecords(env);
    check('总数 450', res.total === 450, `实际 ${res.total}`);
    check('条数 450（跨批无丢失）', res.files.length === 450, `实际 ${res.files.length}`);
    check('无重复 ID', new Set(res.files.map((f) => f.name)).size === 450);
  }

  // ==========================================================================
  console.log('[2] listRecordsPage SQL 分页边界');
  {
    const env = makeEnv();
    for (let i = 0; i < 25; i += 1) {
      insert(env, { id: `p${i}`, kv_key: `r2:p${i}.png`, uploaded_at: 1000 + i });
    }
    const p1 = await listRecordsPage(env, { limit: 10, offset: 0 });
    const p2 = await listRecordsPage(env, { limit: 10, offset: 10 });
    const p3 = await listRecordsPage(env, { limit: 10, offset: 20 });
    check('第1页 10 条', p1.files.length === 10);
    check('第2页 10 条', p2.files.length === 10);
    check('第3页 5 条（尾页）', p3.files.length === 5, `实际 ${p3.files.length}`);
    check('total 恒为 25', p1.total === 25 && p3.total === 25);
    const ids = new Set([...p1.files, ...p2.files, ...p3.files].map((f) => f.name));
    check('三页无重叠、无遗漏', ids.size === 25, `实际 ${ids.size}`);
  }

  // ==========================================================================
  console.log('[3] sort 排序下推');
  {
    const env = makeEnv();
    insert(env, { id: 's1', kv_key: 'r2:big.png', file_name: 'big.png', file_size: 900, uploaded_at: 3000 });
    insert(env, { id: 's2', kv_key: 'r2:small.png', file_name: 'small.png', file_size: 10, uploaded_at: 2000 });
    insert(env, { id: 's3', kv_key: 'r2:mid.png', file_name: 'mid.png', file_size: 500, uploaded_at: 1000 });

    const desc = await listRecordsPage(env, { limit: 10 });
    check('默认按 uploaded_at 倒序', desc.files.map((f) => f.metadata.fileName).join(',') === 'big.png,small.png,mid.png',
      desc.files.map((f) => f.metadata.fileName).join(','));

    const sizeAsc = await listRecordsPage(env, { limit: 10, sort: 'sizeasc' });
    check('sizeasc 按体积升序', sizeAsc.files.map((f) => f.metadata.fileSize).join(',') === '10,500,900',
      sizeAsc.files.map((f) => f.metadata.fileSize).join(','));

    const timeAsc = await listRecordsPage(env, { limit: 10, sort: 'timeasc' });
    check('timeasc 按时间升序', timeAsc.files.map((f) => f.metadata.fileName).join(',') === 'mid.png,small.png,big.png',
      timeAsc.files.map((f) => f.metadata.fileName).join(','));
  }

  // ==========================================================================
  console.log('[4] storage 过滤下推');
  {
    const env = makeEnv();
    insert(env, { id: 'x1', kv_key: 'r2:a.png', storage: 'r2' });
    insert(env, { id: 'x2', kv_key: 's3:b.png', storage: 's3' });
    insert(env, { id: 'x3', kv_key: 'tg:c.png', storage: 'telegram' });

    const r2 = await listRecordsPage(env, { limit: 10, storage: 'r2' });
    check('只剩 r2 一条', r2.files.length === 1 && r2.files[0].metadata.storage === 'r2');
    check('total 随过滤变化', r2.total === 1, `实际 ${r2.total}`);
  }

  // ==========================================================================
  console.log('[5] folderPath 过滤下推（\'\' = 根目录 = NULL）');
  {
    const env = makeEnv();
    insert(env, { id: 'd1', kv_key: 'r2:root.png', file_name: 'root.png', storage_key: 'root.png', folder_path: null });
    insert(env, { id: 'd2', kv_key: 'r2:a.png', file_name: 'a.png', storage_key: 'a.png', folder_path: 'photos' });
    insert(env, { id: 'd3', kv_key: 'r2:b.png', file_name: 'b.png', storage_key: 'b.png', folder_path: 'photos/2024' });

    const root = await listRecordsPage(env, { limit: 10, folderPath: '' });
    check('根目录只有 1 条（NULL 语义正确）', root.files.length === 1 && root.files[0].metadata.fileName === 'root.png',
      `实际 ${root.files.length}`);

    const photos = await listRecordsPage(env, { limit: 10, folderPath: 'photos' });
    check('photos 目录只有 1 条（不含子目录）', photos.files.length === 1 && photos.files[0].metadata.folderPath === 'photos',
      `实际 ${photos.files.length}`);
  }

  // ==========================================================================
  console.log('[6] d1FileToKey 形状与 KV getWithMetadata 对齐');
  {
    const env = makeEnv();
    insert(env, {
      id: 'shape1',
      kv_key: 'r2:photo.jpg',
      storage: 'r2',
      storage_key: 'photo.jpg',
      file_name: 'photo.jpg',
      file_size: 2048,
      folder_path: 'album',
      uploaded_at: 1234567,
      share_slug: 'abc',
      share_max_downloads: 5,
      share_download_count: 2,
    });
    const row = env._db.prepare('SELECT * FROM files WHERE id = ?').get('shape1');
    const key = d1FileToKey(row);

    check('name = kvKey（下游定位依赖）', key.name === 'r2:photo.jpg', key.name);
    check('metadata.fileName', key.metadata.fileName === 'photo.jpg');
    check('metadata.TimeStamp = uploaded_at', key.metadata.TimeStamp === 1234567);
    check('metadata.fileSize', key.metadata.fileSize === 2048);
    check('metadata.storageType', key.metadata.storageType === 'r2');
    check('metadata.r2Key 回填（否则下载定位不到）', key.metadata.r2Key === 'photo.jpg', String(key.metadata.r2Key));
    check('metadata.folderPath', key.metadata.folderPath === 'album');
    check('metadata.shareSlug', key.metadata.shareSlug === 'abc');
    check('metadata.shareMaxDownloads', key.metadata.shareMaxDownloads === 5);
    check('metadata.shareDownloadCount', key.metadata.shareDownloadCount === 2);
    check('metadata.ListType 默认 None', key.metadata.ListType === 'None');
    check('metadata.liked 布尔化', key.metadata.liked === false);
  }

  // ==========================================================================
  console.log('[7] D1 未绑定 → disabled（回落 KV 的信号）');
  {
    const bare = { img_url: { async list() { return { keys: [] }; } } };
    const page = await listRecordsPage(bare, { limit: 10 });
    check('listRecordsPage.disabled=true', page.disabled === true);
    const all = await listAllRecords(bare);
    check('listAllRecords.disabled=true', all.disabled === true);
    const raw = await listFileRecords(bare);
    check('listFileRecords.disabled=true', raw.disabled === true);
  }

  // ==========================================================================
  console.log('[8] 排序白名单：非法 sort 不得注入 SQL');
  {
    const env = makeEnv();
    insert(env, { id: 'inj1', kv_key: 'r2:a.png', uploaded_at: 5000 });
    // 恶意排序串：若被拼接进 SQL 会语法报错或拖库
    const res = await listRecordsPage(env, {
      limit: 10,
      sort: 'uploaded_at; DROP TABLE files;--',
    });
    check('恶意 sort 被白名单忽略，仍返回数据', res.files.length === 1 && res.total === 1,
      `files=${res.files.length} total=${res.total}`);
    const stillThere = env._db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='files'").get();
    check('files 表未被破坏', Boolean(stillThere));
  }

  console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('测试异常:', error);
  process.exit(1);
});
