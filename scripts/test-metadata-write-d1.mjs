/**
 * 元数据写入的一致性测试：**改完必须能被读侧读到**。
 *
 * ============================================================================
 * 本套件锁住的是一个真实存在的 bug
 * ============================================================================
 *
 * `editName`（改文件名）与 `move-folder`（改所在目录）此前**只写 KV**：
 *
 *     await env.img_url.put(kvKey, '', { metadata });   // 只改了 KV
 *
 * 而读侧 `getRecordWithKey` 是 **D1 优先**。于是 D1 绑定后会出现：
 *
 *     用户改名 → 接口返回 {success: true, fileName: "新名字"}
 *     → 刷新列表 → 还是旧名字（因为读的是 D1，D1 从未被更新）
 *
 * 这是"写侧与读侧走了不同的事实来源"，功能测试很难发现 —— 接口响应是对的，
 * 只有"下一次读"才暴露。所以断言必须**跨接口**：写完之后用读侧路径取回。
 *
 * ⚠️ 这类 bug 还有一个隐蔽的变体：D1 的 `files.id` 是**剥离存储前缀后的
 * 裸 ID**（`r2:photo.png` → `photo.png`）。若用 kvKey 当主键去 UPDATE，
 * 会更新 0 行且**不报错** —— 接口照样返回成功。因此本套件专门有一条
 * 「用 kvKey 定位会失败」的反向断言，把这个陷阱钉住。
 *
 * ============================================================================
 * 覆盖
 * ============================================================================
 *
 *   [1] editName：写后读侧能读到新名（跨接口一致性）
 *   [2] editName：D1 可用时确实更新了 D1（不是只写 KV）
 *   [3] ★ 陷阱：用 kvKey 当 D1 主键会更新 0 行（必须用裸 ID）
 *   [4] editName：D1 未绑定 → 回落 KV（等价回滚）
 *   [5] editName：不存在的 ID → 404
 *   [6] move-folder：改目录后读侧能读到新路径
 *   [7] move-folder：批量移动逐个生效，未找到的进 notFound
 *   [8] updateFileMetadataFields：只更新显式字段（不整行覆盖）
 *   [9] 改名不影响 folderPath（字段隔离）
 *  [10] 移动不影响 fileName（字段隔离）
 *
 * 运行：node scripts/test-metadata-write-d1.mjs
 */
import { onRequest as editNameHandler } from '../functions/api/manage/editName/[id].js';
import { onRequestPost as moveFolderHandler } from '../functions/api/manage/files/move-folder.js';
import { putRecordIndex, getRecordWithKey } from '../functions/utils/file-record.js';
import { updateFileMetadataFields } from '../functions/utils/metadata-d1.js';
import { makeMigratedEnv } from './test-utils.mjs';

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** KV 替身：底层一律存字符串，与真实 KV 一致。 */
function makeKv() {
  const store = new Map();
  const stats = { get: 0, put: 0, delete: 0, list: 0, getWithMetadata: 0 };
  return {
    _store: store,
    _stats: stats,
    async get(key, opts) {
      stats.get += 1;
      if (!store.has(key)) return null;
      const raw = store.get(key);
      return opts?.type === 'json' ? JSON.parse(raw) : raw;
    },
    async getWithMetadata(key) {
      stats.getWithMetadata += 1;
      if (!store.has(key)) return null;
      return JSON.parse(store.get(key));
    },
    async put(key, value, opts) {
      stats.put += 1;
      store.set(key, JSON.stringify({
        value: value ?? '',
        metadata: opts?.metadata ?? null,
      }));
    },
    async delete(key) { stats.delete += 1; store.delete(key); },
    async list({ prefix = '' } = {}) {
      stats.list += 1;
      return {
        keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      };
    },
  };
}

/** 造一条真实形态的文件记录（走 putRecordIndex，ID 会被剥前缀）。 */
async function seed(env, { kvKey, fileName = 'orig.png', folderPath = null }) {
  await putRecordIndex(env, kvKey, {
    metadata: {
      fileName,
      fileSize: 2048,
      TimeStamp: 1700000000000,
      storageType: 'r2',
      storage: 'r2',
      r2Key: `obj/${fileName}`,
      folderPath: folderPath ?? undefined,
    },
  });
}

/** 造一个 editName 的请求上下文。 */
function editCtx(env, id, newName) {
  return {
    request: new Request(`https://x.test/api/manage/editName/${encodeURIComponent(id)}?newName=${encodeURIComponent(newName)}`),
    params: { id: encodeURIComponent(id) },
    env,
  };
}

/** 造一个 move-folder 的请求上下文。 */
function moveCtx(env, ids, targetFolderPath) {
  return {
    request: new Request('https://x.test/api/manage/files/move-folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, targetFolderPath }),
    }),
    params: {},
    env,
  };
}

/** 直接从 D1 读裸 ID 那行。 */
function d1Row(env, bareId) {
  return env._db.prepare('SELECT file_name, folder_path FROM files WHERE id = ?').get(bareId);
}

// ============================================================================
console.log('[1] editName：写后读侧能读到新名（跨接口一致性）');
{
  const base = makeMigratedEnv();
  const env = { ...base, img_url: makeKv() };
  await seed(env, { kvKey: 'r2:photo.png', fileName: 'old.png' });

  const res = await editNameHandler(editCtx(env, 'r2:photo.png', 'new.png'));
  const body = await res.json();
  check('[1] 改名返回 200', res.status === 200, JSON.stringify(body));
  check('[1] 响应里的 fileName 是新名', body.fileName === 'new.png', body.fileName);

  // ★ 核心：用**读侧路径**再取一次，必须看到新名字。
  // 这正是 bug 之前会失败的地方 —— 接口说成功了，读侧还是旧名。
  const { record } = await getRecordWithKey(env, 'r2:photo.png');
  check('[1] ★ 读侧能看到新名字（跨接口一致）',
    record?.metadata?.fileName === 'new.png',
    `读回 ${record?.metadata?.fileName}`);
}

// ============================================================================
console.log('[2] editName：D1 可用时确实更新了 D1');
{
  const base = makeMigratedEnv();
  const listKv = makeKv();
  const env = { ...base, img_url: listKv };
  await seed(env, { kvKey: 'r2:a.png', fileName: 'a.png' });

  const before = d1Row(env, 'a.png');
  check('[2] 前置：D1 里是旧名', before.file_name === 'a.png');

  await editNameHandler(editCtx(env, 'r2:a.png', 'renamed.png'));

  const after = d1Row(env, 'a.png');
  check('[2] ★ D1 里的 file_name 已更新', after.file_name === 'renamed.png',
    String(after.file_name));
  check('[2] KV 也同步写了（P3 前保持双写）', listKv._stats.put > 0,
    `put=${listKv._stats.put}`);
}

// ============================================================================
console.log('[3] ★ 陷阱：用 kvKey 当 D1 主键会静默更新 0 行');
{
  const base = makeMigratedEnv();
  const env = { ...base, img_url: makeKv() };
  await seed(env, { kvKey: 'r2:trap.png', fileName: 'trap.png' });

  // D1 的 id 是裸 ID；用带前缀的 kvKey 去 UPDATE 匹配不到任何行，
  // 而且**不报错** —— 这正是最容易写出"接口成功但数据没改"的原因。
  const withPrefix = await updateFileMetadataFields(env, 'r2:trap.png', { fileName: 'nope.png' });
  check('[3] ★ 用 kvKey 定位返回 updated=0', withPrefix.ok === true && withPrefix.updated === 0,
    JSON.stringify(withPrefix));
  check('[3] ★ 且没有报错（静默失败才是危险的）', withPrefix.error === undefined,
    String(withPrefix.error));
  check('[3] 数据确实没被改', d1Row(env, 'trap.png').file_name === 'trap.png');

  // 用裸 ID 才是对的
  const withBare = await updateFileMetadataFields(env, 'trap.png', { fileName: 'yes.png' });
  check('[3] 用裸 ID 定位返回 updated=1', withBare.updated === 1, JSON.stringify(withBare));
  check('[3] 数据被正确修改', d1Row(env, 'trap.png').file_name === 'yes.png');
}

// ============================================================================
console.log('[4] editName：D1 未绑定 → 回落 KV（等价回滚）');
{
  const kv = makeKv();
  const env = { img_url: kv };
  await kv.put('r2:legacy.png', '', {
    metadata: { fileName: 'legacy.png', fileSize: 1, storageType: 'r2', storage: 'r2' },
  });

  const res = await editNameHandler(editCtx(env, 'r2:legacy.png', 'kv-only.png'));
  const body = await res.json();
  check('[4] 无 D1 时改名成功', res.status === 200 && body.fileName === 'kv-only.png',
    JSON.stringify(body));

  const stored = JSON.parse(kv._store.get('r2:legacy.png'));
  check('[4] KV 里的 metadata 已更新', stored.metadata.fileName === 'kv-only.png',
    stored.metadata.fileName);
}

// ============================================================================
console.log('[5] editName：错误处理');
{
  const base = makeMigratedEnv();
  const env = { ...base, img_url: makeKv() };
  await seed(env, { kvKey: 'r2:exists.png', fileName: 'exists.png' });

  const missing = await editNameHandler(editCtx(env, 'r2:ghost.png', 'x.png'));
  check('[5] 不存在的 ID → 404', missing.status === 404, String(missing.status));

  const empty = await editNameHandler(editCtx(env, 'r2:exists.png', ''));
  check('[5] 空名字 → 400', empty.status === 400, String(empty.status));

  const tooLong = await editNameHandler(editCtx(env, 'r2:exists.png', 'x'.repeat(200)));
  check('[5] 超长名字 → 400', tooLong.status === 400, String(tooLong.status));
}

// ============================================================================
console.log('[6] move-folder：改目录后读侧能读到新路径');
{
  const base = makeMigratedEnv();
  const env = { ...base, img_url: makeKv() };
  await seed(env, { kvKey: 'r2:m.png', fileName: 'm.png' });

  const res = await moveFolderHandler(moveCtx(env, ['r2:m.png'], 'photos/2024'));
  const body = await res.json();
  check('[6] 移动返回成功', res.status === 200 && body.moved === 1, JSON.stringify(body));

  const { record } = await getRecordWithKey(env, 'r2:m.png');
  check('[6] ★ 读侧能看到新目录路径',
    record?.metadata?.folderPath === 'photos/2024',
    String(record?.metadata?.folderPath));

  const row = d1Row(env, 'm.png');
  check('[6] D1 里的 folder_path 已更新', row.folder_path === 'photos/2024',
    String(row.folder_path));

  // 目录标记也要落到 D1（否则目录树里看不到这个空目录）
  const marker = base._db.prepare('SELECT id FROM files WHERE id = ?').get('folder:photos/2024');
  check('[6] ★ 目录标记已落到 D1', Boolean(marker), '未找到 folder:photos/2024');
}

// ============================================================================
console.log('[7] move-folder：批量移动与 notFound');
{
  const base = makeMigratedEnv();
  const env = { ...base, img_url: makeKv() };
  await seed(env, { kvKey: 'r2:x1.png', fileName: 'x1.png' });
  await seed(env, { kvKey: 'r2:x2.png', fileName: 'x2.png' });

  const res = await moveFolderHandler(
    moveCtx(env, ['r2:x1.png', 'r2:x2.png', 'r2:nope.png'], 'archive')
  );
  const body = await res.json();
  check('[7] 移动了 2 个', body.moved === 2, JSON.stringify(body));
  check('[7] 未找到的进了 notFound', body.notFound.length === 1 && body.notFound[0] === 'r2:nope.png',
    JSON.stringify(body.notFound));

  check('[7] 两个都到新目录',
    d1Row(env, 'x1.png').folder_path === 'archive' && d1Row(env, 'x2.png').folder_path === 'archive');

  // 全部找不到 → 404 且不改动任何东西
  const none = await moveFolderHandler(moveCtx(env, ['r2:ghost1.png'], 'archive'));
  check('[7] 全部未找到 → 404', none.status === 404, String(none.status));

  const emptyIds = await moveFolderHandler(moveCtx(env, [], 'archive'));
  check('[7] 空 ids → 400', emptyIds.status === 400, String(emptyIds.status));
}

// ============================================================================
console.log('[8] updateFileMetadataFields：只更新显式字段');
{
  const base = makeMigratedEnv();
  const env = { ...base, img_url: makeKv() };
  await seed(env, { kvKey: 'r2:iso.png', fileName: 'iso.png', folderPath: 'keep/me' });

  // 只改 fileName
  await updateFileMetadataFields(env, 'iso.png', { fileName: 'only-name.png' });
  let row = d1Row(env, 'iso.png');
  check('[8] fileName 已改', row.file_name === 'only-name.png');
  check('[8] ★ folderPath 未被清空（未提及的字段保持原值）',
    row.folder_path === 'keep/me', String(row.folder_path));

  // 只改 folderPath
  await updateFileMetadataFields(env, 'iso.png', { folderPath: 'elsewhere' });
  row = d1Row(env, 'iso.png');
  check('[8] folderPath 已改', row.folder_path === 'elsewhere');
  check('[8] ★ fileName 未被清空', row.file_name === 'only-name.png', String(row.file_name));

  // 空 patch 不产生 UPDATE
  const noop = await updateFileMetadataFields(env, 'iso.png', {});
  check('[8] 空 patch → updated=0 且不报错', noop.ok === true && noop.updated === 0,
    JSON.stringify(noop));

  // 非白名单字段被忽略
  await updateFileMetadataFields(env, 'iso.png', { fileSize: 999999, storage: 'hacked' });
  const after = base._db.prepare('SELECT file_name, folder_path FROM files WHERE id = ?').get('iso.png');
  check('[8] 非白名单字段不会写入（fileSize/storage 被忽略）',
    after.file_name === 'only-name.png' && after.folder_path === 'elsewhere',
    JSON.stringify(after));
}

// ============================================================================
console.log('[9] 字段隔离：改名不影响目录，移动不影响文件名');
{
  const base = makeMigratedEnv();
  const env = { ...base, img_url: makeKv() };
  await seed(env, { kvKey: 'r2:both.png', fileName: 'both.png', folderPath: 'start/here' });

  await editNameHandler(editCtx(env, 'r2:both.png', 'renamed-only.png'));
  let { record } = await getRecordWithKey(env, 'r2:both.png');
  check('[9] 改名后目录不变', record?.metadata?.folderPath === 'start/here',
    String(record?.metadata?.folderPath));

  await moveFolderHandler(moveCtx(env, ['r2:both.png'], 'moved/there'));
  ({ record } = await getRecordWithKey(env, 'r2:both.png'));
  check('[9] 移动后名字不变', record?.metadata?.fileName === 'renamed-only.png',
    String(record?.metadata?.fileName));
  check('[9] 移动后目录已变', record?.metadata?.folderPath === 'moved/there',
    String(record?.metadata?.folderPath));
}

// ============================================================================
console.log('[10] D1 写入失败 → 回落 KV，不阻断操作');
{
  const base = makeMigratedEnv();
  const kv = makeKv();
  // D1 可用但 UPDATE 会失败（模拟表被改坏）
  const flakyDb = {
    prepare(sql) {
      if (/^UPDATE files/i.test(sql.replace(/\s+/g, ' '))) {
        throw new Error('table is locked');
      }
      return base.DB.prepare(sql);
    },
  };
  const env = { DB: flakyDb, img_url: kv, _db: base._db };
  await seed({ ...base, img_url: kv }, { kvKey: 'r2:flaky.png', fileName: 'flaky.png' });

  const res = await editNameHandler(editCtx(env, 'r2:flaky.png', 'fallback.png'));
  const body = await res.json();
  check('[10] ★ D1 写入失败时仍返回成功（回落 KV）', res.status === 200 && body.fileName === 'fallback.png',
    JSON.stringify(body));

  const stored = JSON.parse(kv._store.get('r2:flaky.png'));
  check('[10] KV 兜底确实写了新名', stored.metadata.fileName === 'fallback.png',
    stored.metadata.fileName);
}

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
