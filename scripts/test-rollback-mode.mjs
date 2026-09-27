/**
 * 存储回滚模式（writeKvLegacy）测试。
 *
 * ============================================================================
 * 本套件锁住的核心契约
 * ============================================================================
 *
 *   1. **默认必须是开启**。合入本改动不应改变任何现网行为 —— 任何"没配过
 *      这个开关"的环境，KV 写入量与迁移前逐字节一致。
 *   2. **关闭后 KV 写必须真的归零**。这是整个开关存在的意义；如果只是
 *      "看起来关了"而底层还在写，KV 写额度照样被烧掉，等于没做。
 *   3. **关闭后读侧仍能读到数据**。停写 KV 的前提是 D1 已经接管读侧；
 *      如果停写之后文件列表空了，那这个开关就是个陷阱。
 *   4. **判定过程不得额外消耗 KV 读**。判定点本身在写路径上，用 KV 读
 *      额度去换 KV 写额度是亏的 —— 所以必须走进程内配置镜像。
 *
 * ============================================================================
 * 为什么断言"调用次数"而不是"结果对不对"
 * ============================================================================
 *
 * 这个开关的全部价值体现在**资源用量**上：结果（文件能不能读到）在两种
 * 模式下都一样。纯功能断言抓不到"结果对但多烧一次 KV 写"的回归，所以本
 * 套件的主体断言是 KV 替身上的计数器。
 *
 * ============================================================================
 * 覆盖
 * ============================================================================
 *
 *   [1] 默认值：未配置时 writeKvLegacy 为 true
 *   [2] 默认开启时：上传/改名 → KV 确实被写
 *   [3] ★ 关闭后：KV 写为 0，但 D1 里有记录
 *   [4] ★ 关闭后：读侧仍能读到（跨接口一致性）
 *   [5] ★ 关闭后：判定过程不产生额外 KV 读（镜像生效）
 *   [6] 重新开启 → KV 写入立即恢复（可逆性）
 *   [7] 环境变量基线 KV_LEGACY_WRITE=false 可关闭
 *   [8] delete 路径：D1 行被删除（不受开关影响）
 *   [9] settings API：读写 storage 组往返
 *  [10] settings API：writeKvLegacy 非布尔 → 400
 *  [11] 关掉开关后 editName：D1 已更新且 KV 未写
 *
 * 运行：node scripts/test-rollback-mode.mjs
 */
import {
  getStorageConfigResolved,
  saveRuntimeConfig,
  resetRuntimeConfig,
  invalidateRuntimeConfigCache,
  shouldWriteKvLegacy,
  shouldWriteKvLegacySync,
  readStorageConfigFromEnv,
} from '../functions/utils/runtime-config.js';
import { putKvFileMetadata, putRecordIndex, getRecordWithKey } from '../functions/utils/file-record.js';
import { onRequest as editNameHandler } from '../functions/api/manage/editName/[id].js';
import { onRequestGet as settingsGet, onRequestPost as settingsPost } from '../functions/api/manage/settings.js';
import { makeMigratedEnv } from './test-utils.mjs';

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/**
 * KV 替身：底层一律存字符串（与真实 KV 一致），并统计每类操作次数。
 *
 * ============================================================================
 * 写入约定：value 与 metadata 分开存，**不能混成一个 wrapper 对象**
 * ============================================================================
 *
 * 真实 KV 有两个独立的取数入口：
 *
 *   get(key, {type:'json'})  → 拿到 **value**（JSON.parse 后的）
 *   getWithMetadata(key)     → 拿到 `{ value, metadata }` 包装体
 *
 * 早期几个套件的替身把两者都塞进 `{value, metadata}` 再整体 JSON 序列化，
 * 于是 `get(key,{type:'json'})` 会返回**包装体而不是 value**。文件记录这条
 * 链路只走 getWithMetadata，所以那个缺陷一直没暴露；但运行时配置正是用
 * `get(key,{type:'json'})` 读的 —— 用那个替身会读到 `{value,metadata}`，
 * 归一化时找不到 `writeKvLegacy` 字段，静默回退成默认 true，
 * 表现成「明明关了开关却还在写 KV」。
 *
 * 所以这里按真实语义分开存两份，杜绝该陷阱。
 */
function makeKv() {
  const values = new Map();   // key -> 原始字符串 value
  const metas = new Map();    // key -> metadata 对象
  const stats = { get: 0, put: 0, delete: 0, list: 0, getWithMetadata: 0 };
  return {
    _values: values,
    _metas: metas,
    _stats: stats,
    /** 兼容既有断言写法：`_store.has(key)` 判存在 */
    _store: {
      has: (k) => values.has(k),
      get: (k) => values.get(k),
      keys: () => values.keys(),
    },
    async get(key, opts) {
      stats.get += 1;
      if (!values.has(key)) return null;
      const raw = values.get(key);
      return opts?.type === 'json' ? JSON.parse(raw) : raw;
    },
    async getWithMetadata(key) {
      stats.getWithMetadata += 1;
      if (!values.has(key)) return null;
      return { value: values.get(key), metadata: metas.get(key) ?? null };
    },
    async put(key, value, opts) {
      stats.put += 1;
      values.set(key, String(value ?? ''));
      if (opts?.metadata !== undefined) metas.set(key, opts.metadata);
    },
    async delete(key) { stats.delete += 1; values.delete(key); metas.delete(key); },
    async list({ prefix = '' } = {}) {
      stats.list += 1;
      return {
        keys: [...values.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      };
    },
  };
}

/** 组合 env：内存 D1 + KV 替身。 */
function makeEnv() {
  const kv = makeKv();
  const d1 = makeMigratedEnv();
  return { ...d1, img_url: kv, _kv: kv };
}

/** 每个用例开始前清空运行时配置缓存，避免跨用例串味。 */
function freshCache() {
  invalidateRuntimeConfigCache();
}

/** 造一个 editName 的请求上下文。 */
function editCtx(env, id, newName) {
  return {
    request: new Request(`https://x.test/api/manage/editName/${encodeURIComponent(id)}?newName=${encodeURIComponent(newName)}`),
    params: { id: encodeURIComponent(id) },
    env,
  };
}

/** 造一条真实形态的文件记录（走 putRecordIndex，ID 会被剥前缀）。 */
async function seed(env, { kvKey, fileName = 'orig.png' }) {
  await putRecordIndex(env, kvKey, {
    metadata: {
      fileName,
      fileSize: 2048,
      TimeStamp: 1700000000000,
      storageType: 'r2',
      storage: 'r2',
      r2Key: `obj/${fileName}`,
    },
  });
}

/** 造一个 settings POST 请求上下文。 */
function settingsPostCtx(env, body) {
  return {
    request: new Request('https://x.test/api/manage/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  };
}

// ============================================================================
console.log('[1] 默认值：未配置时 writeKvLegacy 为 true');
{
  freshCache();
  check('环境变量缺省 → true', readStorageConfigFromEnv({}).writeKvLegacy === true);
  check('KV_LEGACY_WRITE=false → false', readStorageConfigFromEnv({ KV_LEGACY_WRITE: 'false' }).writeKvLegacy === false);
  check('KV_LEGACY_WRITE=true → true', readStorageConfigFromEnv({ KV_LEGACY_WRITE: 'true' }).writeKvLegacy === true);
  check('非字面量 "0" 不当作 false（严格解析）', readStorageConfigFromEnv({ KV_LEGACY_WRITE: '0' }).writeKvLegacy === true);

  const env = makeEnv();
  const cfg = await getStorageConfigResolved(env);
  check('★ 未保存过 → 默认开启', cfg.writeKvLegacy === true, JSON.stringify(cfg));
  check('来源标记为 env', cfg.source === 'env', cfg.source);
  check('shouldWriteKvLegacy → true', (await shouldWriteKvLegacy(env)) === true);
}

// ============================================================================
console.log('\n[2] 默认开启时：KV 确实被写');
{
  freshCache();
  const env = makeEnv();
  const before = env._kv._stats.put;
  const wrote = await putKvFileMetadata(env, 'r2:a.png', { fileName: 'a.png' });
  check('返回 true（确实写了）', wrote === true);
  check('KV put 次数 +1', env._kv._stats.put === before + 1, `${before} → ${env._kv._stats.put}`);
  check('KV 里能取到记录', env._kv._store.has('r2:a.png'));
}

// ============================================================================
console.log('\n[3] ★ 关闭后：KV 写为 0，但 D1 里有记录');
{
  freshCache();
  const env = makeEnv();
  await saveRuntimeConfig(env, 'storage', { writeKvLegacy: false });

  const before = env._kv._stats.put;
  // 模拟上传点：先写 KV（受闸门），再登记 D1
  await putKvFileMetadata(env, 'r2:b.png', { fileName: 'b.png' });
  await putRecordIndex(env, 'r2:b.png', { metadata: { fileName: 'b.png', fileSize: 1, TimeStamp: 1 } });

  check('★ KV put 次数为 0（未写）', env._kv._stats.put === before, `新增 ${env._kv._stats.put - before} 次`);
  check('KV 里没有该键', !env._kv._store.has('r2:b.png'));
  const row = env._db.prepare('SELECT file_name FROM files WHERE id = ?').get('b.png');
  check('★ D1 里有记录', row && row.file_name === 'b.png', JSON.stringify(row));
}

// ============================================================================
console.log('\n[4] ★ 关闭后：读侧仍能读到（跨接口一致性）');
{
  freshCache();
  const env = makeEnv();
  await saveRuntimeConfig(env, 'storage', { writeKvLegacy: false });

  await putKvFileMetadata(env, 'r2:c.png', { fileName: 'c.png' });
  await putRecordIndex(env, 'r2:c.png', { metadata: { fileName: 'c.png', fileSize: 9, TimeStamp: 1 } });

  // 用读侧路径取回（裸 ID）
  const hit = await getRecordWithKey(env, 'r2:c.png');
  check('★ 读侧能命中 D1', Boolean(hit?.record?.metadata), JSON.stringify(hit?.record));
  check('读回的文件名正确', hit?.record?.metadata?.fileName === 'c.png');
}

// ============================================================================
console.log('\n[5] ★ 关闭后：判定过程不产生额外 KV 读（镜像生效）');
{
  freshCache();
  const env = makeEnv();
  await saveRuntimeConfig(env, 'storage', { writeKvLegacy: false });

  // 保存配置时已把 storage 组镜像进索引键，之后判定应零 KV 读。
  const beforeGet = env._kv._stats.get;
  const sync = shouldWriteKvLegacySync(env);
  check('★ 同步判定命中镜像，返回 false', sync === false, String(sync));

  await putKvFileMetadata(env, 'r2:d.png', { fileName: 'd.png' });
  const afterGet = env._kv._stats.get;
  check('★ 整个判定 + 跳过写入过程，KV 读增加 0 次', afterGet === beforeGet, `新增 ${afterGet - beforeGet} 次`);
}

// ============================================================================
console.log('\n[6] 重新开启 → KV 写入立即恢复（可逆性）');
{
  freshCache();
  const env = makeEnv();
  await saveRuntimeConfig(env, 'storage', { writeKvLegacy: false });
  const offPut = env._kv._stats.put;
  await putKvFileMetadata(env, 'r2:e1.png', { fileName: 'e1.png' });
  check('关闭时未写', env._kv._stats.put === offPut);

  // 注意：saveRuntimeConfig 自身会往 KV 写一条 config:storage，所以基准要
  // 在保存**之后**取，否则会把配置写入算进"文件元数据写入"里。
  await saveRuntimeConfig(env, 'storage', { writeKvLegacy: true });
  const onPut = env._kv._stats.put;
  await putKvFileMetadata(env, 'r2:e2.png', { fileName: 'e2.png' });
  check('★ 重新开启后写入了', env._kv._stats.put === onPut + 1, `新增 ${env._kv._stats.put - onPut} 次`);
  check('新键已存在', env._kv._store.has('r2:e2.png'));
}

// ============================================================================
console.log('\n[7] 环境变量基线 KV_LEGACY_WRITE=false 可关闭');
{
  freshCache();
  const env = makeEnv();
  env.KV_LEGACY_WRITE = 'false';
  const cfg = await getStorageConfigResolved(env);
  check('★ 环境变量即生效（无需保存 KV）', cfg.writeKvLegacy === false, JSON.stringify(cfg));
  check('来源标记为 env', cfg.source === 'env');

  const before = env._kv._stats.put;
  await putKvFileMetadata(env, 'r2:f.png', { fileName: 'f.png' });
  check('KV put 未发生', env._kv._stats.put === before);
}

// ============================================================================
console.log('\n[8] 关闭开关后：editName 仍更新 D1 且不写 KV');
{
  freshCache();
  const env = makeEnv();
  await saveRuntimeConfig(env, 'storage', { writeKvLegacy: false });
  await seed(env, { kvKey: 'r2:g.png', fileName: 'g.png' });

  const beforePut = env._kv._stats.put;
  const res = await editNameHandler(editCtx(env, 'g.png', 'renamed.png'));
  const body = await res.json();

  check('改名成功', body.success === true, JSON.stringify(body));
  check('★ D1 里的名字已更新', env._db.prepare('SELECT file_name FROM files WHERE id = ?').get('g.png')?.file_name === 'renamed.png');
  check('★ KV 未被写入', env._kv._stats.put === beforePut, `新增 ${env._kv._stats.put - beforePut} 次`);

  // 读侧一致性：改名后能读到新名
  const hit = await getRecordWithKey(env, 'g.png');
  check('★ 读侧读到新名', hit?.record?.metadata?.fileName === 'renamed.png', JSON.stringify(hit?.record?.metadata));
}

// ============================================================================
console.log('\n[9] settings API：读写 storage 组往返');
{
  freshCache();
  const env = makeEnv();

  // 初始读取
  const r1 = await (await settingsGet({ env })).json();
  check('GET 返回 storage 组', Boolean(r1.storage), JSON.stringify(r1.storage));
  check('★ GET 默认 writeKvLegacy=true', r1.storage.writeKvLegacy === true);
  check('GET 返回 storageEnvBaseline', r1.storageEnvBaseline?.writeKvLegacy === true);
  check('GET 返回 hasD1Binding=true', r1.hasD1Binding === true);

  // 保存为 false
  const r2 = await (await settingsPost(settingsPostCtx(env, {
    guest: { enabled: false, maxFileSize: 1024 * 1024, dailyLimit: 3 },
    storage: { writeKvLegacy: false },
  }))).json();
  check('POST 保存成功', r2.success === true, JSON.stringify(r2.error || ''));
  check('★ 保存后 writeKvLegacy=false', r2.storage.writeKvLegacy === false);
  check('保存后来源标记为 kv', r2.storage.source === 'kv', r2.storage.source);
  check('guest 组同时被保存', r2.guest.dailyLimit === 3, String(r2.guest.dailyLimit));

  // 重新读取确认持久化
  freshCache();
  const r3 = await (await settingsGet({ env })).json();
  check('★ 重新读取仍为 false', r3.storage.writeKvLegacy === false);

  // 重置 storage 组，回退 env 基线
  const r4 = await resetRuntimeConfig(env, 'storage');
  check('★ 重置后回退为 true', r4.writeKvLegacy === true);
}

// ============================================================================
console.log('\n[10] settings API：writeKvLegacy 非布尔 → 400');
{
  freshCache();
  const env = makeEnv();
  const bad = await settingsPost(settingsPostCtx(env, { storage: { writeKvLegacy: 'false' } }));
  check('★ 字符串 "false" 被拒绝（400）', bad.status === 400, `status=${bad.status}`);
  const body = await bad.json();
  check('错误信息提示需布尔值', /布尔/.test(body.error || ''), body.error);

  const bad2 = await settingsPost(settingsPostCtx(env, { storage: { writeKvLegacy: 0 } }));
  check('★ 数字 0 被拒绝（400）', bad2.status === 400, `status=${bad2.status}`);

  // 确认没有写进去
  freshCache();
  const view = await (await settingsGet({ env })).json();
  check('★ 校验失败不落库，仍是默认 true', view.storage.writeKvLegacy === true);
}

// ============================================================================
console.log('\n[11] ★ 关闭后整条上传链路：KV 写为 0 而 D1 记录完整');
{
  freshCache();
  const env = makeEnv();
  await saveRuntimeConfig(env, 'storage', { writeKvLegacy: false });

  // 模拟 v1/upload 的写入序列（闸门 + putRecordIndex）
  const files = ['r2:h1.png', 'r2:h2.png', 'r2:h3.png'];
  const beforePut = env._kv._stats.put;
  for (const key of files) {
    // 裸 ID = 去掉存储前缀后的部分（"r2:h1.png" → "h1.png"）
    const bare = key.slice(key.indexOf(':') + 1);
    const meta = { fileName: bare, fileSize: 100, TimeStamp: Date.now() };
    await putKvFileMetadata(env, key, meta);
    await putRecordIndex(env, key, { metadata: meta });
  }

  check('★ 三次上传共产生 0 次 KV 写', env._kv._stats.put === beforePut, `新增 ${env._kv._stats.put - beforePut} 次`);

  const rows = env._db.prepare('SELECT id FROM files ORDER BY id').all();
  check('★ D1 里三条记录齐全', rows.length === 3, JSON.stringify(rows));

  for (const key of files) {
    const bare = key.slice(key.indexOf(':') + 1);
    const hit = await getRecordWithKey(env, key);
    check(`读侧命中 ${bare}`, hit?.record?.metadata?.fileName === bare, JSON.stringify(hit?.record?.metadata));
  }
}

// ============================================================================
console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
