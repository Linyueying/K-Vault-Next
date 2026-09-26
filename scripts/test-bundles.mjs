/**
 * Step 6 测试：合集分享 (share-bundle.js) 迁到 D1。
 *
 * 覆盖：
 *   [A] readBundle / writeBundle：快照型 round-trip，形状与 KV 版一致
 *   [B] 实时型（folder）合集：folderPath / includeSubfolders 正确持久化
 *   [C] 空壳判定：快照型无成员视为无效（与 KV 版语义对齐）
 *   [D] 成员顺序稳定（position 保序，含重复提交）
 *   [E] incrementBundleCount：原子自增（并发不丢）
 *   [F] isSlugTaken：合集与单文件分享的命名空间共享
 *   [G] listBundleRecords：一次取回全部合集 + 成员（无 N+1）
 *   [H] deleteBundleRecord：连同成员一并清理
 *   [I] listRecordsInFolder：目录成员过滤（根目录 / 精确 / 递归）
 *   [J] D1 未绑定 → 全部 disabled
 *
 * 运行：node scripts/test-bundles.mjs
 */

import {
  readBundleRecord,
  writeBundleRecord,
  deleteBundleRecord,
  listBundleRecords,
  incrementBundleCount,
  isSlugTaken,
} from '../functions/utils/bundle-store.js';
import { listRecordsInFolder } from '../functions/utils/file-record.js';
import {
  readBundle,
  writeBundle,
  deleteBundle,
  isBundleSlugAvailable,
  incrementBundleDownloadCount,
  listFolderMembersLive,
  listAllBundles,
} from '../functions/utils/share-bundle.js';
import { makeMigratedEnv } from './test-utils.mjs';

let pass = 0;
let fail = 0;
function check(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}

/** 造一个假 KV（供 D1 路径下的"KV 镜像写入"调用不报错）。 */
function makeKV() {
  const m = new Map();
  return {
    _map: m,
    async put(k, v, o) { m.set(k, { value: v, metadata: o?.metadata }); },
    async get(k) { const e = m.get(k); return e ? e.value : null; },
    async getWithMetadata(k) { const e = m.get(k); return e ? { value: e.value, metadata: e.metadata } : null; },
    async delete(k) { m.delete(k); },
    async list({ prefix = '', limit = 1000 } = {}) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit)
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

function makeEnv() {
  const env = makeMigratedEnv();
  env.img_url = makeKV();
  return env;
}

function seedFile(env, { id, folder = null, name = 'f.png' }) {
  env._db.prepare(
    `INSERT INTO files (id, kv_key, is_folder, storage, storage_key, file_name,
       file_size, folder_path, uploaded_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(id, `r2:${id}`, 0, 'r2', id, name, 100, folder, 1000);
}

async function main() {
  // ==========================================================================
  console.log('[A] 快照型合集 round-trip');
  {
    const env = makeEnv();
    const written = await writeBundle(env, {
      slug: 'abc123',
      type: 'files',
      fileIds: ['f1', 'f2', 'f3'],
      expiresAt: 1700000000000,
      maxDownloads: 10,
      passwordSalt: 'salt',
      passwordHash: 'hash',
      label: '测试合集',
    });
    check('writeBundle 返回 slug', written.slug === 'abc123');
    check('writeBundle 返回 fileIds', written.fileIds.join(',') === 'f1,f2,f3', written.fileIds.join(','));

    const read = await readBundle(env, 'abc123');
    check('readBundle 命中', Boolean(read));
    check('type = files', read.type === 'files');
    check('fileIds 保序', read.fileIds.join(',') === 'f1,f2,f3', read.fileIds.join(','));
    check('expiresAt', read.expiresAt === 1700000000000);
    check('maxDownloads', read.maxDownloads === 10);
    check('passwordSalt', read.passwordSalt === 'salt');
    check('passwordHash', read.passwordHash === 'hash');
    check('label', read.label === '测试合集');
    check('folderPath 为空（快照型）', read.folderPath === '');
    check('includeSubfolders false', read.includeSubfolders === false);
    check('createdAt 被填充', read.createdAt > 0);
  }

  // ==========================================================================
  console.log('[B] 实时型（folder）合集');
  {
    const env = makeEnv();
    await writeBundle(env, {
      slug: 'folder01',
      type: 'folder',
      folderPath: 'photos/2024',
      includeSubfolders: true,
      maxDownloads: 0,
    });

    const read = await readBundle(env, 'folder01');
    check('type = folder', read.type === 'folder');
    check('folderPath 保留', read.folderPath === 'photos/2024', read.folderPath);
    check('includeSubfolders = true', read.includeSubfolders === true);
    check('fileIds 为空', read.fileIds.length === 0);

    // 实时型不该在 bundle_files 留下成员
    const members = env._db.prepare('SELECT * FROM bundle_files WHERE bundle_slug = ?').all('folder01');
    check('bundle_files 无残留成员', members.length === 0);
  }

  // ==========================================================================
  console.log('[C] 空壳判定：快照型无成员视为无效');
  {
    const env = makeEnv();
    // 直接插一行空的快照型（绕过 writeBundle 的校验）
    env._db.prepare(
      `INSERT INTO bundles (slug, type, expires_at, max_downloads, download_count, created_at)
       VALUES ('empty01','files',0,0,0,1000)`
    ).run();

    const read = await readBundle(env, 'empty01');
    check('readBundle 返回 null', read === null, JSON.stringify(read));

    const list = await listBundleRecords(env);
    check('listBundleRecords 跳过空壳', list.bundles.length === 0, `实际 ${list.bundles.length}`);
  }

  // ==========================================================================
  console.log('[D] 成员顺序稳定 + 重复提交不产生重复行');
  {
    const env = makeEnv();
    await writeBundle(env, { slug: 'order01', type: 'files', fileIds: ['c', 'a', 'b'] });
    let read = await readBundle(env, 'order01');
    check('顺序为 c,a,b', read.fileIds.join(',') === 'c,a,b', read.fileIds.join(','));

    // 整体覆盖：新顺序应完全替换
    await writeBundle(env, { slug: 'order01', type: 'files', fileIds: ['b', 'a'] });
    read = await readBundle(env, 'order01');
    check('覆盖后为 b,a', read.fileIds.join(',') === 'b,a', read.fileIds.join(','));

    const rows = env._db.prepare('SELECT COUNT(*) AS n FROM bundle_files WHERE bundle_slug = ?').all('order01');
    check('无残留旧成员（共 2 行）', rows[0].n === 2, String(rows[0].n));

    // 含重复 id 的输入
    await writeBundle(env, { slug: 'dup01', type: 'files', fileIds: ['x', 'x', 'y'] });
    const dup = env._db.prepare('SELECT COUNT(*) AS n FROM bundle_files WHERE bundle_slug = ?').all('dup01');
    check('重复 id 去重（共 2 行）', dup[0].n === 2, String(dup[0].n));
  }

  // ==========================================================================
  console.log('[E] incrementBundleCount：原子自增');
  {
    const env = makeEnv();
    await writeBundle(env, { slug: 'cnt01', type: 'files', fileIds: ['f1'] });

    // 并发 10 次自增 —— 原子 UPDATE 不应丢计数
    await Promise.all(Array.from({ length: 10 }, () => incrementBundleCount(env, 'cnt01')));

    const row = env._db.prepare('SELECT download_count FROM bundles WHERE slug = ?').get('cnt01');
    check('并发 10 次后计数 = 10', row.download_count === 10, String(row.download_count));

    // 经 share-bundle.js 的门面函数
    const viaFacade = await incrementBundleDownloadCount(env, 'cnt01');
    check('门面函数返回递增后的值', viaFacade === 11, String(viaFacade));
  }

  // ==========================================================================
  console.log('[F] isSlugTaken：命名空间共享');
  {
    const env = makeEnv();
    await writeBundle(env, { slug: 'taken01', type: 'files', fileIds: ['f1'] });
    seedFile(env, { id: 'shared1', name: 'shared.png' });
    env._db.prepare("UPDATE files SET share_slug = 'fileslug1' WHERE id = 'shared1'").run();

    const a = await isSlugTaken(env, 'taken01');
    check('合集占用的 slug 判为已占用', a.taken === true);

    const b = await isSlugTaken(env, 'fileslug1');
    check('单文件分享占用的 slug 判为已占用', b.taken === true);

    const c = await isSlugTaken(env, 'neverused');
    check('未使用的 slug 判为可用', c.taken === false);

    // 经门面函数
    const avail = await isBundleSlugAvailable(env, 'neverused');
    check('isBundleSlugAvailable 返回 true', avail === true);
    const notAvail = await isBundleSlugAvailable(env, 'taken01');
    check('isBundleSlugAvailable 对已占用返回 false', notAvail === false);
    const selfExclude = await isBundleSlugAvailable(env, 'taken01', { excludeBundleSlug: 'taken01' });
    check('排除自身时返回 true', selfExclude === true);
  }

  // ==========================================================================
  console.log('[G] listBundleRecords：一次取回全部 + 成员');
  {
    const env = makeEnv();
    await writeBundle(env, { slug: 'b1', type: 'files', fileIds: ['f1', 'f2'] });
    await writeBundle(env, { slug: 'b2', type: 'folder', folderPath: 'docs' });
    await writeBundle(env, { slug: 'b3', type: 'files', fileIds: ['f3'] });

    const res = await listBundleRecords(env);
    check('返回 3 个合集', res.bundles.length === 3, `实际 ${res.bundles.length}`);
    check('按 created_at 倒序', res.bundles[0].createdAt >= res.bundles[2].createdAt);

    const b1 = res.bundles.find((b) => b.slug === 'b1');
    check('b1 成员正确', b1.fileIds.join(',') === 'f1,f2', b1.fileIds.join(','));
    const b2 = res.bundles.find((b) => b.slug === 'b2');
    check('b2 是实时型带 folderPath', b2.type === 'folder' && b2.folderPath === 'docs');

    // 门面函数
    const facade = await listAllBundles(env);
    check('listAllBundles 返回 3 个', facade.bundles.length === 3);
  }

  // ==========================================================================
  console.log('[H] deleteBundleRecord：连带成员清理');
  {
    const env = makeEnv();
    await writeBundle(env, { slug: 'del01', type: 'files', fileIds: ['f1', 'f2'] });
    check('删除前有 2 个成员',
      env._db.prepare('SELECT COUNT(*) AS n FROM bundle_files WHERE bundle_slug=?').get('del01').n === 2);

    await deleteBundle(env, 'del01');

    check('bundles 行已删',
      env._db.prepare('SELECT COUNT(*) AS n FROM bundles WHERE slug=?').get('del01').n === 0);
    check('bundle_files 成员已清理',
      env._db.prepare('SELECT COUNT(*) AS n FROM bundle_files WHERE bundle_slug=?').get('del01').n === 0);
    check('readBundle 返回 null', (await readBundle(env, 'del01')) === null);
  }

  // ==========================================================================
  console.log('[I] listRecordsInFolder：目录成员过滤');
  {
    const env = makeEnv();
    seedFile(env, { id: 'r1', folder: null, name: 'root.png' });
    seedFile(env, { id: 'p1', folder: 'photos', name: 'p1.png' });
    seedFile(env, { id: 'p2', folder: 'photos', name: 'p2.png' });
    seedFile(env, { id: 'p3', folder: 'photos/2024', name: 'p3.png' });
    seedFile(env, { id: 'd1', folder: 'docs', name: 'd1.png' });

    const root = await listRecordsInFolder(env, '', false);
    check('根目录非递归 → 1 个', root.files.length === 1, `实际 ${root.files.length}`);
    check('根目录那 1 个是 root.png', root.files[0]?.metadata?.fileName === 'root.png');

    const rootAll = await listRecordsInFolder(env, '', true);
    check('根目录递归 → 全部 5 个', rootAll.files.length === 5, `实际 ${rootAll.files.length}`);

    const photos = await listRecordsInFolder(env, 'photos', false);
    check('photos 非递归 → 2 个', photos.files.length === 2, `实际 ${photos.files.length}`);

    const photosRec = await listRecordsInFolder(env, 'photos', true);
    check('photos 递归 → 3 个', photosRec.files.length === 3, `实际 ${photosRec.files.length}`);

    const docs = await listRecordsInFolder(env, 'docs', false);
    check('docs → 1 个', docs.files.length === 1);

    // 门面函数（经 normalizeKey）
    const live = await listFolderMembersLive(env, 'photos', true);
    check('listFolderMembersLive 递归 → 3 个', live.length === 3, `实际 ${live.length}`);
    check('条目含 storageType（normalizeKey 生效）', Boolean(live[0]?.metadata?.storageType));
    check('条目 name = kvKey', live[0]?.name?.startsWith('r2:'), live[0]?.name);
  }

  // ==========================================================================
  console.log('[J] D1 未绑定 → 读类返回 null / 写类返回 disabled');
  {
    const kvOnly = { img_url: makeKV() };

    // 读类：返回 null（形状与 readBundle 对齐），调用方据此回落 KV
    check('readBundleRecord → null', (await readBundleRecord(kvOnly, 'x')) === null);

    // 写类 / 列表类：返回 disabled 标记
    const written = await writeBundleRecord(kvOnly, { slug: 'x', fileIds: ['f'] });
    check('writeBundleRecord → disabled', written.disabled === true, JSON.stringify(written));

    const deleted = await deleteBundleRecord(kvOnly, 'x');
    check('deleteBundleRecord → disabled', deleted.disabled === true, JSON.stringify(deleted));

    const listed = await listBundleRecords(kvOnly);
    check('listBundleRecords → disabled', listed.disabled === true, JSON.stringify(listed));

    const inc = await incrementBundleCount(kvOnly, 'x');
    check('incrementBundleCount → disabled', inc.disabled === true, JSON.stringify(inc));

    const taken = await isSlugTaken(kvOnly, 'x');
    check('isSlugTaken → disabled', taken.disabled === true, JSON.stringify(taken));

    const inFolder = await listRecordsInFolder(kvOnly, '', false);
    check('listRecordsInFolder → disabled', inFolder.disabled === true, JSON.stringify(inFolder));

    const allBundles = await listAllBundles(kvOnly);
    check('listAllBundles → disabled', allBundles.disabled === true, JSON.stringify(allBundles));

    // 门面层：D1 未绑定时 readBundle 必须回落到 KV（此处 KV 为空 → null）
    check('readBundle 回落 KV 后返回 null', (await readBundle(kvOnly, 'nothing')) === null);
  }

  console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('测试异常:', error);
  process.exit(1);
});
