/**
 * Step 5 测试：分享总览 (shares.js) + 文件夹操作 (folders.js) 迁到 SQL。
 *
 * 覆盖：
 *   [A] 文件夹标记：写入 / 列出 / 删除（is_folder 列）
 *   [B] folderFileCounts：SQL GROUP BY 计数 + 父路径展开 + marker 合并
 *   [C] moveFolderTree：整棵树 folder_path 改写（含子目录）+ id/kv_key 同步
 *   [D] clearFolderPath：递归 / 非递归清空
 *   [E] folderHasContent：非递归删除的前置校验
 *   [F] listSharedRecords：只返回真正开启分享的行（hasActiveShare 语义对齐）
 *   [G] LIKE 特殊字符转义（% _ 出现在目录名中不得通配）
 *   [H] D1 未绑定 → 全部返回 disabled（调用方回落 KV）
 *   [I] 文件夹行不得混入文件列表（is_folder 过滤）
 *
 * 运行：node scripts/test-folders-shares.mjs
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  listFolderMarkers,
  folderFileCounts,
  upsertFolderMarker,
  deleteFolderMarkers,
  moveFolderTree,
  clearFolderPath,
} from '../functions/utils/metadata-d1.js';
import {
  listFolderStats,
  listMarkers,
  ensureFolderMarker,
  removeFolderMarkers,
  moveFolder,
  clearFolder,
  folderHasContent,
  listSharedRecords,
  listAllRecords,
} from '../functions/utils/file-record.js';
import { makeMigratedEnv } from './test-utils.mjs';

let pass = 0;
let fail = 0;
function check(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}

function makeEnv() {
  return makeMigratedEnv();
}

/** 直接插一行（绕过业务层，用于造数据）。 */
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
    over.share_slug ?? null, over.share_password_hash ?? null,
    over.share_expires_at ?? null, over.share_max_downloads ?? 0,
    over.share_download_count ?? 0
  );
}

async function main() {
  // ==========================================================================
  console.log('[A] 文件夹标记：写入 / 列出 / 删除');
  {
    const env = makeEnv();
    await upsertFolderMarker(env, 'photos');
    await upsertFolderMarker(env, 'photos/2024');
    await upsertFolderMarker(env, 'docs');

    const listed = await listFolderMarkers(env);
    check('列出 3 个标记', listed.folders.length === 3, `实际 ${listed.folders.length}`);
    check('路径正确', listed.folders.map((f) => f.path).join(',') === 'docs,photos,photos/2024',
      listed.folders.map((f) => f.path).join(','));
    check('id 形如 folder:<path>', listed.folders[0].id === 'folder:docs', listed.folders[0].id);

    // upsert 幂等：再写一次不应产生新行
    await upsertFolderMarker(env, 'photos');
    const again = await listFolderMarkers(env);
    check('重复 upsert 幂等（仍 3 行）', again.folders.length === 3, `实际 ${again.folders.length}`);
    check('storage 列为 folder', env._db.prepare("SELECT storage FROM files WHERE id='folder:photos'").get().storage === 'folder');

    await deleteFolderMarkers(env, 'docs', false);
    const afterDelete = await listFolderMarkers(env);
    check('删除单目录后剩 2 个', afterDelete.folders.length === 2, `实际 ${afterDelete.folders.length}`);
  }

  // ==========================================================================
  console.log('[B] folderFileCounts：SQL 计数 + 父路径展开 + marker 合并');
  {
    const env = makeEnv();
    rawInsert(env, { id: 'f1', folder_path: 'photos' });
    rawInsert(env, { id: 'f2', folder_path: 'photos' });
    rawInsert(env, { id: 'f3', folder_path: 'photos/2024' });
    rawInsert(env, { id: 'f4', folder_path: 'docs' });
    rawInsert(env, { id: 'f5', folder_path: null });        // 根目录，不应出现在目录计数里
    rawInsert(env, { id: 'folder:photos', is_folder: 1, folder_path: 'photos', storage: 'folder', file_name: 'photos' });

    const stats = await folderFileCounts(env);
    const map = stats.folders;
    check('photos 计数 2（只算直接子文件）', map.photos?.count === 2, String(map.photos?.count));
    check('photos/2024 计数 1', map['photos/2024']?.count === 1, String(map['photos/2024']?.count));
    check('docs 计数 1', map.docs?.count === 1);
    check('photos 标记为 true', map.photos?.marker === true);
    check('docs 无标记', map.docs?.marker === false);
    check('根目录文件不计入任何目录', Object.keys(map).every((k) => k !== ''));
    check('总数不受影响（folderFileCounts 只数文件）', map.photos.count + map['photos/2024'].count + map.docs.count === 4);
  }

  // ==========================================================================
  console.log('[C] moveFolderTree：整棵树改写（含子目录）');
  {
    const env = makeEnv();
    rawInsert(env, { id: 'm1', kv_key: 'r2:a.png', folder_path: 'old', file_name: 'a.png' });
    rawInsert(env, { id: 'm2', kv_key: 'r2:b.png', folder_path: 'old/sub', file_name: 'b.png' });
    rawInsert(env, { id: 'm3', kv_key: 'r2:c.png', folder_path: 'old/sub/deep', file_name: 'c.png' });
    rawInsert(env, { id: 'm4', kv_key: 'r2:d.png', folder_path: 'other', file_name: 'd.png' });
    rawInsert(env, { id: 'folder:old', is_folder: 1, folder_path: 'old', storage: 'folder', file_name: 'old' });
    rawInsert(env, { id: 'folder:old/sub', is_folder: 1, folder_path: 'old/sub', storage: 'folder', file_name: 'sub' });

    const res = await moveFolderTree(env, 'old', 'new');
    check('updatedFiles = 3', res.updatedFiles === 3, String(res.updatedFiles));
    check('updatedMarkers = 2', res.updatedMarkers === 2, String(res.updatedMarkers));

    const paths = env._db.prepare("SELECT id, folder_path FROM files WHERE is_folder=0 ORDER BY id").all();
    check('old → new', paths.find((p) => p.id === 'm1').folder_path === 'new', paths.find((p) => p.id === 'm1').folder_path);
    check('old/sub → new/sub', paths.find((p) => p.id === 'm2').folder_path === 'new/sub', paths.find((p) => p.id === 'm2').folder_path);
    check('old/sub/deep → new/sub/deep', paths.find((p) => p.id === 'm3').folder_path === 'new/sub/deep', paths.find((p) => p.id === 'm3').folder_path);
    check('other 不受影响', paths.find((p) => p.id === 'm4').folder_path === 'other');

    const markers = env._db.prepare("SELECT id, folder_path FROM files WHERE is_folder=1 ORDER BY folder_path").all();
    check('标记 id 同步改写成 folder:new', markers.some((m) => m.id === 'folder:new'), JSON.stringify(markers));
    check('标记 id 同步改写成 folder:new/sub', markers.some((m) => m.id === 'folder:new/sub'), JSON.stringify(markers));
    check('无残留 folder:old 标记', !markers.some((m) => String(m.id).startsWith('folder:old')));
  }

  // ==========================================================================
  console.log('[D] clearFolderPath：递归 / 非递归');
  {
    const env = makeEnv();
    rawInsert(env, { id: 'c1', folder_path: 'work' });
    rawInsert(env, { id: 'c2', folder_path: 'work/2024' });
    rawInsert(env, { id: 'c3', folder_path: 'keep' });

    const nonRec = await clearFolderPath(env, 'work', false);
    check('非递归只清 1 个', nonRec === 1, String(nonRec));
    check('work/2024 未受影响', env._db.prepare("SELECT folder_path FROM files WHERE id='c2'").get().folder_path === 'work/2024');

    rawInsert(env, { id: 'c4', folder_path: 'work2' });
    rawInsert(env, { id: 'c5', folder_path: 'work2/sub' });
    const rec = await clearFolderPath(env, 'work2', true);
    check('递归清 2 个', rec === 2, String(rec));
    check('子目录文件 folder_path 置空', env._db.prepare("SELECT folder_path FROM files WHERE id='c5'").get().folder_path === null);
    check('keep 目录始终未动', env._db.prepare("SELECT folder_path FROM files WHERE id='c3'").get().folder_path === 'keep');
  }

  // ==========================================================================
  console.log('[E] folderHasContent：非递归删除前置校验');
  {
    const env = makeEnv();
    rawInsert(env, { id: 'h1', folder_path: 'full' });
    rawInsert(env, { id: 'folder:parent', is_folder: 1, folder_path: 'parent', storage: 'folder', file_name: 'parent' });
    rawInsert(env, { id: 'folder:parent/child', is_folder: 1, folder_path: 'parent/child', storage: 'folder', file_name: 'child' });

    const withFiles = await folderHasContent(env, 'full');
    check('含文件的目录 hasFiles=true', withFiles.hasFiles === true);
    check('含文件的目录 hasChildFolders=false', withFiles.hasChildFolders === false);

    const withChild = await folderHasContent(env, 'parent');
    check('含子目录 hasChildFolders=true', withChild.hasChildFolders === true);
    check('含子目录 hasFiles=false', withChild.hasFiles === false);

    const empty = await folderHasContent(env, 'nothing');
    check('空目录两者皆 false', empty.hasFiles === false && empty.hasChildFolders === false);
  }

  // ==========================================================================
  console.log('[F] listSharedRecords：hasActiveShare 语义对齐');
  {
    const env = makeEnv();
    rawInsert(env, { id: 's1', kv_key: 'r2:s1.png', file_name: 's1.png', share_slug: 'abc' });
    rawInsert(env, { id: 's2', kv_key: 'r2:s2.png', file_name: 's2.png', share_password_hash: 'hash' });
    rawInsert(env, { id: 's3', kv_key: 'r2:s3.png', file_name: 's3.png', share_expires_at: Date.now() + 86400000 });
    rawInsert(env, { id: 's4', kv_key: 'r2:s4.png', file_name: 's4.png', share_max_downloads: 5, share_download_count: 2 });
    // ❌ 只有残留计数、无分享配置 —— 不应出现（revoke 后的脏数据）
    rawInsert(env, { id: 's5', kv_key: 'r2:s5.png', file_name: 's5.png', share_download_count: 9 });
    // ❌ 普通文件
    rawInsert(env, { id: 's6', kv_key: 'r2:s6.png', file_name: 's6.png' });
    // ❌ 文件夹标记不该混进来
    rawInsert(env, { id: 'folder:x', is_folder: 1, folder_path: 'x', storage: 'folder', file_name: 'x', share_slug: 'zzz' });

    const res = await listSharedRecords(env);
    const ids = res.files.map((f) => f.name).sort();
    check('返回 4 条', res.files.length === 4, `实际 ${res.files.length}: ${ids.join(',')}`);
    check('含 slug 的 s1 在列', ids.includes('r2:s1.png'));
    check('含密码的 s2 在列', ids.includes('r2:s2.png'));
    check('含过期的 s3 在列', ids.includes('r2:s3.png'));
    check('含限次的 s4 在列', ids.includes('r2:s4.png'));
    check('残留计数的 s5 不在列（revoke 语义正确）', !ids.includes('r2:s5.png'));
    check('普通文件 s6 不在列', !ids.includes('r2:s6.png'));
    check('文件夹标记不在列', !ids.includes('folder:x'));
    // 计数随行返回，无需二次查询
    const s4 = res.files.find((f) => f.name === 'r2:s4.png');
    check('share_download_count 随行返回', s4.metadata.shareDownloadCount === 2, String(s4.metadata.shareDownloadCount));
  }

  // ==========================================================================
  console.log('[G] LIKE 特殊字符转义');
  {
    const env = makeEnv();
    // 目录名里含 % 和 _ —— 若不转义会被当通配符，误伤其他目录
    rawInsert(env, { id: 'p1', folder_path: '100%done' });
    rawInsert(env, { id: 'p2', folder_path: '100Xdone' });   // % 若未转义会匹配到这行
    rawInsert(env, { id: 'p3', folder_path: 'a_b' });
    rawInsert(env, { id: 'p4', folder_path: 'aXb' });        // _ 若未转义会匹配到这行

    const cleared = await clearFolderPath(env, '100%done', false);
    check('含%的目录非递归只清自己', cleared === 1, String(cleared));
    check('100Xdone 未被误伤', env._db.prepare("SELECT folder_path FROM files WHERE id='p2'").get().folder_path === '100Xdone');

    const cleared2 = await clearFolderPath(env, 'a_b', false);
    check('含_的目录非递归只清自己', cleared2 === 1, String(cleared2));
    check('aXb 未被误伤', env._db.prepare("SELECT folder_path FROM files WHERE id='p4'").get().folder_path === 'aXb');

    // 递归场景：前缀里的特殊字符同样要转义
    const env2 = makeEnv();
    rawInsert(env2, { id: 'q1', folder_path: '50%off/sub' });
    rawInsert(env2, { id: 'q2', folder_path: '50Xoff/sub' });
    const r = await clearFolderPath(env2, '50%off', true);
    check('递归时 % 也正确转义', r === 1, String(r));
    check('50Xoff 未被误伤', env2._db.prepare("SELECT folder_path FROM files WHERE id='q2'").get().folder_path === '50Xoff/sub');
  }

  // ==========================================================================
  console.log('[H] D1 未绑定 → 全部 disabled（回落 KV 的信号）');
  {
    const bare = { img_url: { async list() { return { keys: [] }; } } };
    const checks = [
      ['listFolderStats', await listFolderStats(bare)],
      ['listMarkers', await listMarkers(bare)],
      ['ensureFolderMarker', await ensureFolderMarker(bare, 'x')],
      ['removeFolderMarkers', await removeFolderMarkers(bare, 'x')],
      ['moveFolder', await moveFolder(bare, 'a', 'b')],
      ['clearFolder', await clearFolder(bare, 'x')],
      ['folderHasContent', await folderHasContent(bare, 'x')],
      ['listSharedRecords', await listSharedRecords(bare)],
    ];
    for (const [name, res] of checks) {
      check(`${name} → disabled`, res.disabled === true, JSON.stringify(res));
    }
  }

  // ==========================================================================
  console.log('[I] 文件夹行不得混入文件列表');
  {
    const env = makeEnv();
    rawInsert(env, { id: 'file1', kv_key: 'r2:real.png', file_name: 'real.png' });
    rawInsert(env, { id: 'folder:ghost', is_folder: 1, folder_path: 'ghost', storage: 'folder', file_name: 'ghost' });

    const all = await listAllRecords(env);
    check('listAllRecords 只返回文件（1 条）', all.files.length === 1, `实际 ${all.files.length}`);
    check('文件名是 real.png', all.files[0]?.metadata?.fileName === 'real.png', all.files[0]?.metadata?.fileName);
    check('total 也只数文件', all.total === 1, String(all.total));
  }

  console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('测试异常:', error);
  process.exit(1);
});
