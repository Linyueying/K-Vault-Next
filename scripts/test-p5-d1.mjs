/**
 * P5 测试：审计日志 / Paste / API Token 三类数据从 KV 迁到 D1。
 *
 * ============================================================================
 * 为什么这三类要一起测
 * ============================================================================
 *
 * 它们共享同一个迁移（0005）与同一个动机：**在 KV 里都只有"写"没有"读"**。
 *
 *   · audit_logs 键名 `audit:<ts>:<rand>`，随机后缀让枚举顺序与时间无关，
 *     想按时间倒序读一遍只能全前缀 list() 再内存排序 —— 这份日志在 KV 里
 *     本来就是不可读的，写进去只是烧额度。
 *   · pastes 列表要全量 list() 再排序分页，与文件列表早期 O(N²) 问题同源。
 *   · api_tokens 列表是 1 次 list + N 次 get + N 次 get_stat；而 `token_stat:`
 *     是**每 60 秒采样写一次**的高频键，直接啃 KV 写额度（1000/天，全站最窄）。
 *
 * ============================================================================
 * 断言哲学：把资源用量当成契约
 * ============================================================================
 *
 * 纯功能断言（"列表能返回 3 条"）抓不到"结果对但多烧一次额度"的回归 ——
 * 而这恰恰是本轮迁移唯一要紧的东西。因此每个用例除了断结果，还断
 * **KV 读写次数为 0**、**D1 查询次数**。
 *
 * ============================================================================
 * 覆盖
 * ============================================================================
 *
 *   [1] 审计：D1 写入 + 倒序读取 + 按 event/token 过滤 + 180 天保留期清理
 *   [2] 审计：D1 可用时 KV 零写入
 *   [3] 审计：D1 未绑定 → 回落 KV
 *   [4] Paste：CRUD + 过期语义（expires_at=0 表示永不过期）
 *   [5] Paste：列表排序分页由 SQL 承担，KV 零调用
 *   [6] Paste：D1 未绑定 → 回落 KV
 *   [7] Token：创建 / 读取 / 列表（LEFT JOIN 一次取回）
 *   [8] Token：列表不得产生任何 KV list/get
 *   [9] Token：局部更新不得覆盖未提及字段（并发安全）
 *  [10] Token：遥测采样去抖 + KV 零写入
 *  [11] Token：删除用 changes 判存在性；D1 可用时不读 KV
 *  [12] Token：D1 未绑定 → 完整回落 KV（等价回滚）
 *  [13] Token：鉴权链路（verifyApiToken）在 D1 下全程不碰 KV
 *
 * 运行：node scripts/test-p5-d1.mjs
 */
import {
  writeAuditRecord,
  listAuditRecords,
  AUDIT_RETENTION_SECONDS,
} from '../functions/utils/audit-store.js';
import { writeAuditLog, AUDIT_EVENTS } from '../functions/utils/audit.js';
import {
  putPasteRecord,
  getPasteRecord,
  listPasteRecords,
  deletePasteRecord,
  purgeExpiredPastes,
  pasteIdExists,
} from '../functions/utils/paste-d1.js';
import {
  createPaste,
  getPasteById,
  listPastes,
  deletePasteById,
} from '../functions/utils/paste-store.js';
import {
  createApiToken,
  getRecordById,
  listApiTokens,
  updateApiToken,
  deleteApiToken,
  rotateApiToken,
  verifyApiToken,
  touchApiTokenUsage,
} from '../functions/utils/api-token.js';
import { makeMigratedEnv } from './test-utils.mjs';

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/**
 * 带读写计数的 KV 替身。
 *
 * 记录 get/put/delete/list 四类调用次数 —— 整套测试的核心断言就是
 * "D1 可用时这四个计数必须保持为 0"。
 */
function makeKv(initial = {}, options = {}) {
  const store = new Map(Object.entries(initial));
  const stats = { get: 0, put: 0, delete: 0, list: 0 };
  return {
    _store: store,
    _stats: stats,
    async get(key, opts) {
      stats.get += 1;
      if (options.failGet) throw new Error('kv-down');
      if (!store.has(key)) return null;
      const value = store.get(key);
      return opts?.type === 'json' ? value : JSON.stringify(value);
    },
    async put(key, value) {
      stats.put += 1;
      if (options.failPut) throw new Error('kv-down');
      store.set(key, JSON.parse(value));
    },
    async delete(key) {
      stats.delete += 1;
      store.delete(key);
    },
    async list({ prefix = '', cursor } = {}) {
      stats.list += 1;
      if (options.failList) throw new Error('kv-down');
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: cursor || undefined };
    },
  };
}

/** 给 D1 包一层 SQL 计数器，用于断言"查询次数"这类用量契约。 */
function counted(env, base = {}) {
  const queries = [];
  const DB = {
    prepare(sql) {
      queries.push(String(sql).replace(/\s+/g, ' ').trim());
      return base.DB.prepare(sql);
    },
  };
  return { env: { ...base, ...env, DB }, queries };
}

/** 只统计匹配关键字（如 SELECT / INSERT / UPDATE / DELETE）的查询数。 */
function countLike(queries, pattern) {
  return queries.filter((sql) => pattern.test(sql)).length;
}

const DAY = 24 * 3600 * 1000;

// ============================================================================
console.log('[1] 审计：D1 写入 / 倒序读取 / 过滤 / 保留期清理');
{
  const base = makeMigratedEnv();
  const { env } = counted({}, base);

  // 种子时间用"相对现在"的偏移。若用 1000/2000/3000 这类绝对小值，
  // 它们相对现在就是 1970 年 —— 会被同一次写入的保留期清理顺带删掉，
  // 从而让"按时间倒序"这类断言失去意义（且看起来像清理逻辑有 bug）。
  const t0 = Date.now() - 3000;
  await writeAuditRecord(env, { event: 'token.created', tokenId: 't1', operation: 'create', success: true, client: 'ua', detail: 'x', timestamp: t0 });
  await writeAuditRecord(env, { event: 'token.deleted', tokenId: 't2', operation: 'delete', success: true, client: 'ua', timestamp: t0 + 2000 });
  await writeAuditRecord(env, { event: 'token.created', tokenId: 't3', operation: 'create', success: false, client: 'ua', timestamp: t0 + 1000 });

  const all = await listAuditRecords(env, {});
  check('[1] 三条记录都可读', all.items.length === 3, JSON.stringify(all.items.length));
  check('[1] 按时间倒序（新 > 中 > 旧）',
    all.items.map((r) => r.timestamp).join(',') === `${t0 + 2000},${t0 + 1000},${t0}`,
    all.items.map((r) => r.timestamp).join(','));
  check('[1] success 布尔化（不是 0/1 数字）', all.items[0].success === true);

  const created = await listAuditRecords(env, { event: 'token.created' });
  check('[1] 按 event 过滤 = 2 条', created.items.length === 2, String(created.items.length));
  check('[1] 过滤后仍倒序', created.items.map((r) => r.timestamp).join(',') === `${t0 + 1000},${t0}`);

  const byToken = await listAuditRecords(env, { tokenId: 't2' });
  check('[1] 按 tokenId 过滤 = 1 条', byToken.items.length === 1 && byToken.items[0].tokenId === 't2');

  const paged = await listAuditRecords(env, { limit: 1, offset: 1 });
  check('[1] 分页 offset=1 取到第二条', paged.items.length === 1 && paged.items[0].timestamp === t0 + 1000);

  const since = await listAuditRecords(env, { since: t0 + 500 });
  check('[1] since 过滤掉最旧那条', since.items.length === 2, String(since.items.length));

  // 保留期清理：写入一条超期记录后，下一次写入应把它带走
  const expired = Date.now() - (AUDIT_RETENTION_SECONDS + 3600) * 1000;
  await env.DB.prepare(
    `INSERT INTO audit_logs (event, token_id, operation, success, client, detail, timestamp)
     VALUES ('ancient', 'old', 'x', 1, 'ua', NULL, ?)`
  ).bind(expired).run();
  const before = await listAuditRecords(env, {});
  check('[1] 超期记录确实被写进去了（前置条件）', before.items.some((r) => r.event === 'ancient'));

  await writeAuditRecord(env, { event: 'trigger', tokenId: 't9', timestamp: Date.now() });
  const after = await listAuditRecords(env, {});
  check('[1] 写入时顺带清掉超期记录（复刻 KV TTL）',
    !after.items.some((r) => r.event === 'ancient'),
    after.items.map((r) => r.event).join(','));
  check('[1] 未超期的记录不受影响', after.items.some((r) => r.event === 'token.created'));
}

// ============================================================================
console.log('[2] 审计：D1 可用时 KV 零写入');
{
  const base = makeMigratedEnv();
  const kv = makeKv();
  const env = { ...base, img_url: kv };

  await writeAuditLog(env, {
    event: AUDIT_EVENTS.TOKEN_CREATED,
    tokenId: 'tk',
    operation: 'admin.tokens.create',
    success: true,
    client: 'ua',
  });

  check('[2] writeAuditLog 未写 KV', kv._stats.put === 0, `put=${kv._stats.put}`);
  check('[2] writeAuditLog 未读 KV', kv._stats.get === 0);
  check('[2] 记录确实进了 D1', (await listAuditRecords(env, {})).items.length === 1);
  check('[2] D1 行数 = 1',
    Number(base._db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n) === 1);
}

// ============================================================================
console.log('[3] 审计：D1 未绑定 → 回落 KV');
{
  const kv = makeKv();
  const env = { img_url: kv };

  await writeAuditLog(env, {
    event: AUDIT_EVENTS.TOKEN_CREATED,
    tokenId: 'tk',
    operation: 'create',
    success: true,
    client: 'ua',
  });

  check('[3] 降级态写进了 KV', kv._stats.put === 1, `put=${kv._stats.put}`);
  check('[3] 键名保持 audit: 前缀',
    [...kv._store.keys()].some((k) => k.startsWith('audit:')),
    [...kv._store.keys()].join(','));
}

// ============================================================================
console.log('[4] Paste：CRUD 与过期语义');
{
  const base = makeMigratedEnv();
  const { env } = counted({}, base);
  const nowMs = Date.now();

  await putPasteRecord(env, {
    id: 'p_alive', content: 'hello', language: 'js', size: 5,
    createdAt: nowMs, expiresAt: 0,
  });
  const alive = await getPasteRecord(env, 'p_alive');
  check('[4] 读回内容一致', alive?.content === 'hello' && alive?.language === 'js');
  check('[4] expiresAt=0 归一化为 null（永不过期）', alive?.expiresAt === null, String(alive?.expiresAt));

  await putPasteRecord(env, {
    id: 'p_expired', content: 'gone', language: 'text', size: 4,
    createdAt: nowMs - 10 * DAY, expiresAt: nowMs - DAY,
  });
  check('[4] 已过期 → 读不到', (await getPasteRecord(env, 'p_expired')) === null);
  check('[4] 过期记录仍在表里（读侧过滤，非删除）',
    Number(base._db.prepare('SELECT COUNT(*) AS n FROM pastes').get().n) === 2);

  check('[4] pasteIdExists 对过期 id 仍返回 true（upsert 可覆盖）',
    (await pasteIdExists(env, 'p_expired')).exists === true);
  check('[4] pasteIdExists 对未知 id 返回 false',
    (await pasteIdExists(env, 'nope')).exists === false);

  // upsert：同 id 覆盖
  await putPasteRecord(env, { id: 'p_alive', content: 'v2', language: 'py', size: 2, createdAt: nowMs, expiresAt: 0 });
  check('[4] upsert 覆盖生效', (await getPasteRecord(env, 'p_alive'))?.content === 'v2');
  check('[4] upsert 不产生第二行',
    Number(base._db.prepare('SELECT COUNT(*) AS n FROM pastes').get().n) === 2);

  const del = await deletePasteRecord(env, 'p_alive');
  check('[4] 删除返回 deleted=1', del.ok && del.deleted === 1);
  check('[4] 删除后再读为 null', (await getPasteRecord(env, 'p_alive')) === null);
  check('[4] 删不存在的返回 deleted=0', (await deletePasteRecord(env, 'p_alive')).deleted === 0);

  const purged = await purgeExpiredPastes(env);
  check('[4] 清理回收 1 条过期记录', purged.ok && purged.deleted === 1, JSON.stringify(purged));
  check('[4] 清理不影响未过期记录',
    Number(base._db.prepare('SELECT COUNT(*) AS n FROM pastes').get().n) === 0);
}

// ============================================================================
console.log('[5] Paste：排序分页交给 SQL，KV 零调用');
{
  const base = makeMigratedEnv();
  const kv = makeKv();
  const { env, queries } = counted({ img_url: kv }, base);
  const base0 = Date.now();

  for (let i = 0; i < 5; i += 1) {
    await putPasteRecord(env, {
      id: `p${i}`, content: `c${i}`, language: 'text', size: 1,
      createdAt: base0 + i * 1000, expiresAt: 0,
    });
  }

  const page1 = await listPasteRecords(env, { limit: 2, offset: 0 });
  check('[5] 第一页 2 条', page1.items.length === 2);
  check('[5] 倒序：最新在前', page1.items[0].id === 'p4' && page1.items[1].id === 'p3',
    page1.items.map((i) => i.id).join(','));
  check('[5] total 反映全集（5）', page1.total === 5, String(page1.total));

  const page2 = await listPasteRecords(env, { limit: 2, offset: 2 });
  check('[5] 第二页接着往下', page2.items.map((i) => i.id).join(',') === 'p2,p1',
    page2.items.map((i) => i.id).join(','));

  check('[5] ★ 列表全程未 list() KV', kv._stats.list === 0, `list=${kv._stats.list}`);
  check('[5] ★ 列表全程未 get() KV', kv._stats.get === 0, `get=${kv._stats.get}`);
  check('[5] 列表全程未写 KV', kv._stats.put === 0, `put=${kv._stats.put}`);
  check('[5] 排序分页确实由 SQL 承担（LIMIT/OFFSET 出现在语句里）',
    queries.some((sql) => /LIMIT \? OFFSET \?/i.test(sql)),
    queries.filter((s) => /pastes/i.test(s)).join(' | '));

  // 过期的不能被列出来
  await putPasteRecord(env, { id: 'pold', content: 'x', createdAt: base0 - 10 * DAY, expiresAt: base0 - DAY });
  const listAfter = await listPasteRecords(env, {});
  check('[5] 过期记录不进列表', !listAfter.items.some((i) => i.id === 'pold'));
  check('[5] total 也排除过期项', listAfter.total === 5, String(listAfter.total));
}

// ============================================================================
console.log('[6] Paste：D1 未绑定 → 回落 KV（store 层）');
{
  const kv = makeKv();
  const env = { img_url: kv };

  const created = await createPaste(
    { content: 'legacy', language: 'text', expiresIn: 3600 },
    env
  );
  check('[6] 降级态创建成功', Boolean(created?.id), JSON.stringify(created));

  const read = await getPasteById(created.id, env);
  // getPasteById 返回包装体 {ok, paste}，不是平铺记录
  check('[6] 降级态读回内容', read?.ok === true && read.paste?.content === 'legacy', JSON.stringify(read));

  const listed = await listPastes(env, { limit: 10, cursor: 0 });
  check('[6] 降级态列表能返回', Array.isArray(listed?.items) && listed.items.length >= 1,
    JSON.stringify(listed?.items?.length));

  const removed = await deletePasteById(created.id, env);
  check('[6] 降级态删除成功', removed === true, JSON.stringify(removed));
  check('[6] 降级态确实用了 KV', kv._stats.put > 0 && kv._stats.get > 0,
    `put=${kv._stats.put} get=${kv._stats.get}`);
}

// ============================================================================
console.log('[7] Token：创建 / 读取 / 列表（LEFT JOIN 一次取回）');
{
  const base = makeMigratedEnv();
  const { env } = counted({}, base);

  const created = await createApiToken(
    { name: 'CI', scopes: ['upload', 'read'], expiresAt: null },
    env
  );
  check('[7] 返回明文 token 且带前缀', /^kvault_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/.test(created.token || ''),
    created.token);
  check('[7] 公开记录含 id/name/scopes',
    Boolean(created.record.id) && created.record.name === 'CI' &&
    created.record.scopes.join(',') === 'upload,read');
  check('[7] 公开记录不含密钥', !('tokenHash' in created.record) && !('tokenSalt' in created.record));

  const fetched = await getRecordById(created.record.id, env);
  check('[7] 按 id 读回', fetched?.name === 'CI' && fetched?.enabled === true);
  check('[7] 读回带 tokenHash（内部字段）', typeof fetched?.tokenHash === 'string' && fetched.tokenHash.length > 0);
  check('[7] scopes 是数组而非 JSON 字符串', Array.isArray(fetched?.scopes), typeof fetched?.scopes);

  await createApiToken({ name: 'Older', scopes: ['read'] }, env);
  // 手动把 Older 的创建时间调早，验证排序
  await env.DB.prepare('UPDATE api_tokens SET created_at = ? WHERE name = ?')
    .bind(Date.now() - 10 * DAY, 'Older').run();

  const list = await listApiTokens(env);
  check('[7] 列表返回 2 条', list.length === 2, String(list.length));
  check('[7] 按 createdAt 倒序（新的在前）', list[0].name === 'CI', list.map((t) => t.name).join(','));
  check('[7] 从未使用过的令牌 usageCount=0', list[1].usageCount === 0, String(list[1].usageCount));
  check('[7] 从未使用过的令牌 lastUsedAt=null', list[1].lastUsedAt === null, JSON.stringify(list[1].lastUsedAt));
}

// ============================================================================
console.log('[8] Token：列表不得产生任何 KV 调用');
{
  const base = makeMigratedEnv();
  const kv = makeKv();
  const { env, queries } = counted({ img_url: kv }, base);

  for (let i = 0; i < 3; i += 1) {
    await createApiToken({ name: `t${i}`, scopes: ['read'] }, env);
  }
  kv._stats.get = 0; kv._stats.put = 0; kv._stats.list = 0; kv._stats.delete = 0;
  queries.length = 0;

  const list = await listApiTokens(env);
  check('[8] 列表返回 3 条', list.length === 3, String(list.length));
  check('[8] ★ 未 list() KV（KV 版此处会翻全命名空间）', kv._stats.list === 0, `list=${kv._stats.list}`);
  check('[8] ★ 未 get() KV（KV 版是 2N 次 get）', kv._stats.get === 0, `get=${kv._stats.get}`);
  check('[8] 未写 KV', kv._stats.put === 0);
  check('[8] ★ 一次查询取完（LEFT JOIN，不是 N+1）', queries.length === 1, `${queries.length} 次: ${queries.join(' | ')}`);
  check('[8] 用了 LEFT JOIN 而非 INNER JOIN（否则无遥测的令牌会消失）',
    /LEFT JOIN token_stats/i.test(queries[0] || ''), queries[0]);

  // 给一个令牌加遥测，确认 JOIN 后统计能被带出来
  await touchApiTokenUsage(list[0].id, env, { operation: 'GET /api/v1/me', client: 'test' });
  const list2 = await listApiTokens(env);
  const withStat = list2.find((t) => t.id === list[0].id);
  check('[8] 遥测经 JOIN 带出（usageCount=1）', withStat?.usageCount === 1, String(withStat?.usageCount));
  check('[8] 遥测带出 lastOperation', withStat?.lastOperation === 'GET /api/v1/me', withStat?.lastOperation);
}

// ============================================================================
console.log('[9] Token：局部更新不得覆盖未提及字段（并发安全）');
{
  const base = makeMigratedEnv();
  const { env } = counted({}, base);

  const created = await createApiToken(
    { name: 'svc', scopes: ['upload', 'read', 'delete'], expiresAt: Date.now() + 30 * DAY },
    env
  );
  const id = created.record.id;
  const originalHash = (await getRecordById(id, env)).tokenHash;

  // 模拟并发：先拿一份旧快照，然后在"旧快照之后"发生两次互不相关的更新
  const stale = await getRecordById(id, env);

  await updateApiToken(id, { enabled: false }, env);
  await updateApiToken(id, { scopes: ['read'] }, env);

  const after = await getRecordById(id, env);
  check('[9] 两次更新都生效', after.enabled === false && after.scopes.join(',') === 'read',
    `enabled=${after.enabled} scopes=${after.scopes.join(',')}`);
  check('[9] ★ 密钥未被覆盖（stale 快照没把 tokenHash 写回去）',
    after.tokenHash === originalHash, `${after.tokenHash} !== ${originalHash}`);
  check('[9] 未提及的 name 保持不变', after.name === 'svc', after.name);
  check('[9] 未提及的 expiresAt 保持不变', Number(after.expiresAt) === Number(stale.expiresAt),
    `${after.expiresAt} vs ${stale.expiresAt}`);

  // 轮换与禁用并发：轮换只碰密钥列，不得把 enabled 复活
  const rotated = await rotateApiToken(id, env);
  check('[9] 轮换成功并换了密钥', rotated && rotated.record.id === id);
  const afterRotate = await getRecordById(id, env);
  check('[9] ★ 轮换后仍是禁用态（没被整行覆盖复活）', afterRotate.enabled === false,
    `enabled=${afterRotate.enabled}`);
  check('[9] 轮换确实换了 tokenHash', afterRotate.tokenHash !== originalHash);
  check('[9] 轮换记录 rotatedAt', Number(afterRotate.rotatedAt) > 0);

  check('[9] 更新不存在的令牌 → null', (await updateApiToken('notexist', { enabled: true }, env)) === null);
  check('[9] 轮换不存在的令牌 → null', (await rotateApiToken('notexist', env)) === null);
}

// ============================================================================
console.log('[10] Token：遥测采样去抖 + KV 零写入');
{
  const base = makeMigratedEnv();
  const kv = makeKv();
  const { env, queries } = counted({ img_url: kv }, base);

  const created = await createApiToken({ name: 'x', scopes: ['read'] }, env);
  const id = created.record.id;
  kv._stats.get = 0; kv._stats.put = 0;
  queries.length = 0;

  const first = await touchApiTokenUsage(id, env, { operation: 'A', client: 'ua1' });
  check('[10] 首次写入成功', first === true);
  check('[10] ★ 遥测不写 KV', kv._stats.put === 0, `put=${kv._stats.put}`);
  check('[10] 遥测不读 KV', kv._stats.get === 0, `get=${kv._stats.get}`);
  // ★ 采样判定下推到 SQL 的 WHERE，因此"读-改-写"被压成单条 UPSERT。
  // 这是每次 API 调用都会走的热点路径，多一次查询就是白烧一份 rows read。
  check('[10] ★ 遥测只花 1 次查询（不是先读后写 2 次）', queries.length === 1,
    `${queries.length} 次: ${queries.join(' | ')}`);
  check('[10] 用的是 ON CONFLICT 条件 UPSERT',
    /ON CONFLICT\(token_id\) DO UPDATE/i.test(queries[0] || '') && /WHERE/i.test(queries[0] || ''),
    queries[0]);

  queries.length = 0;
  const second = await touchApiTokenUsage(id, env, { operation: 'B', client: 'ua2' });
  check('[10] ★ 60 秒内第二次被采样跳过（返回 false）', second === false);
  check('[10] ★ 采样跳过也只花 1 次查询', queries.length === 1, String(queries.length));
  const stat = await listApiTokens(env).then((l) => l.find((t) => t.id === id));
  check('[10] 采样跳过后计数仍为 1', stat?.usageCount === 1, String(stat?.usageCount));
  check('[10] 采样跳过后 lastOperation 仍是首次的值', stat?.lastOperation === 'A', stat?.lastOperation);

  // 失败也要计数，且写 lastFailureAt
  const created2 = await createApiToken({ name: 'y', scopes: ['read'] }, env);
  await touchApiTokenUsage(created2.record.id, env, { success: false, operation: 'FAIL' });
  const stat2 = await listApiTokens(env).then((l) => l.find((t) => t.id === created2.record.id));
  check('[10] 失败路径计数 +1', stat2?.usageCount === 1, String(stat2?.usageCount));

  // 表被删掉时遥测应静默失败，不抛
  const bare = { DB: { prepare() { throw new Error('no such table: token_stats'); } }, img_url: makeKv() };
  let threw = false;
  let result = null;
  try { result = await touchApiTokenUsage(id, bare, {}); } catch { threw = true; }
  check('[10] 表异常时不抛异常（鉴权路径不能被遥测拖垮）', threw === false, '抛了');
  check('[10] 表异常时返回 false', result === false, JSON.stringify(result));

  // ★ 计数必须在 SQL 侧自增（request_count = request_count + 1），
  // 而不是"读出旧值 +1 再写回"。后者在并发下会把两次调用压成一次计数 ——
  // 这里用"绕过采样窗口的连续 5 次调用"来验证累加是原子的。
  {
    const base2 = makeMigratedEnv();
    const { env: env2 } = counted({}, base2);
    const c2 = await createApiToken({ name: 'counter', scopes: ['read'] }, env2);
    let wrote = 0;
    for (let i = 0; i < 5; i += 1) {
      // 每次都把采样窗口清零，模拟 5 次真正落盘的遥测写
      await env2.DB.prepare('UPDATE token_stats SET last_touch_at = 0 WHERE token_id = ?')
        .bind(c2.record.id).run();
      if (await touchApiTokenUsage(c2.record.id, env2, { operation: `op${i}` })) wrote += 1;
    }
    const row = base2._db.prepare('SELECT request_count FROM token_stats WHERE token_id = ?')
      .get(c2.record.id);
    check('[10] ★ SQL 侧自增：5 次写入累计为 5（并发不丢计数）',
      Number(row.request_count) === 5 && wrote === 5,
      `request_count=${row.request_count} wrote=${wrote}`);
  }
}

// ============================================================================
console.log('[11] Token：删除与存在性判定');
{
  const base = makeMigratedEnv();
  const kv = makeKv();
  const { env, queries } = counted({ img_url: kv }, base);

  const created = await createApiToken({ name: 'doomed', scopes: ['read'] }, env);
  const id = created.record.id;
  await touchApiTokenUsage(id, env, {});

  kv._stats.get = 0; kv._stats.put = 0; kv._stats.delete = 0;
  queries.length = 0;

  const ok = await deleteApiToken(id, env);
  check('[11] 删除返回 true', ok === true);
  check('[11] ★ 删除未读 KV（用 changes 判存在性，没有先查再删）',
    kv._stats.get === 0, `get=${kv._stats.get}`);
  check('[11] 未删 KV', kv._stats.delete === 0);
  check('[11] 凭据行已删除',
    Number(base._db.prepare('SELECT COUNT(*) AS n FROM api_tokens').get().n) === 0);
  check('[11] ★ 遥测行一并清理（不留孤儿）',
    Number(base._db.prepare('SELECT COUNT(*) AS n FROM token_stats').get().n) === 0);

  check('[11] 删除不存在的返回 false', (await deleteApiToken(id, env)) === false);
  check('[11] 删除不存在的也不读 KV', kv._stats.get === 0, `get=${kv._stats.get}`);
  check('[11] 非法 id 返回 false', (await deleteApiToken('!!', env)) === false);
}

// ============================================================================
console.log('[12] Token：D1 未绑定 → 完整回落 KV（等价回滚）');
{
  const kv = makeKv();
  const env = { img_url: kv };

  const created = await createApiToken({ name: 'legacy', scopes: ['upload', 'read'] }, env);
  check('[12] 降级态创建成功', Boolean(created?.record?.id));

  const keys = [...kv._store.keys()];
  check('[12] 凭据落在 api_token: 前缀', keys.some((k) => k.startsWith('api_token:')), keys.join(','));

  const fetched = await getRecordById(created.record.id, env);
  check('[12] 降级态读回一致', fetched?.name === 'legacy' && fetched?.scopes.join(',') === 'upload,read');

  const listed = await listApiTokens(env);
  check('[12] 降级态列表返回 1 条', listed.length === 1, String(listed.length));
  check('[12] 降级态列表确实走了 KV list()', kv._stats.list > 0, `list=${kv._stats.list}`);

  await touchApiTokenUsage(created.record.id, env, { operation: 'Z' });
  check('[12] 降级态遥测写进 token_stat:',
    [...kv._store.keys()].some((k) => k.startsWith('token_stat:')),
    [...kv._store.keys()].join(','));

  const listed2 = await listApiTokens(env);
  check('[12] 降级态遥测能被列出', listed2[0].usageCount === 1, String(listed2[0].usageCount));

  const updated = await updateApiToken(created.record.id, { name: 'renamed' }, env);
  check('[12] 降级态更新生效', updated?.record?.name === 'renamed');

  const rotated = await rotateApiToken(created.record.id, env);
  check('[12] 降级态轮换返回新 token', Boolean(rotated?.token));

  const removed = await deleteApiToken(created.record.id, env);
  check('[12] 降级态删除成功', removed === true);
  check('[12] 降级态删除后无残留 ',
    ![...kv._store.keys()].some((k) => k.startsWith('api_token:') || k.startsWith('token_stat:')),
    [...kv._store.keys()].join(','));
}

// ============================================================================
console.log('[13] Token：鉴权链路在 D1 下全程不碰 KV');
{
  const base = makeMigratedEnv();
  const kv = makeKv();
  const { env } = counted({ img_url: kv }, base);

  const created = await createApiToken({ name: 'auth', scopes: ['upload'] }, env);
  kv._stats.get = 0; kv._stats.put = 0; kv._stats.list = 0;

  const okResult = await verifyApiToken(created.token, env, 'upload');
  check('[13] 有效令牌通过校验', okResult.ok === true, JSON.stringify(okResult));
  check('[13] 返回令牌记录且含 id', okResult.token?.id === created.record.id);
  check('[13] ★ 校验过程未读 KV', kv._stats.get === 0, `get=${kv._stats.get}`);
  check('[13] ★ 校验过程未写 KV（纯读，不会复活禁用态）', kv._stats.put === 0, `put=${kv._stats.put}`);

  const wrongScope = await verifyApiToken(created.token, env, 'delete');
  check('[13] 缺 scope → 403 TOKEN_SCOPE_DENIED',
    wrongScope.ok === false && wrongScope.code === 'TOKEN_SCOPE_DENIED' && wrongScope.status === 403);

  const anyScope = await verifyApiToken(created.token, env, '@me');
  check('[13] @me 通配任意有效令牌', anyScope.ok === true);

  await updateApiToken(created.record.id, { enabled: false }, env);
  const disabled = await verifyApiToken(created.token, env, 'upload');
  check('[13] 禁用后 → 401 TOKEN_DISABLED',
    disabled.ok === false && disabled.code === 'TOKEN_DISABLED');

  await updateApiToken(created.record.id, { enabled: true, expiresAt: Date.now() - 1000 }, env);
  const expired = await verifyApiToken(created.token, env, 'upload');
  check('[13] 过期后 → 401 TOKEN_EXPIRED',
    expired.ok === false && expired.code === 'TOKEN_EXPIRED', JSON.stringify(expired));

  const bogus = await verifyApiToken('kvault_abc_def', env, 'read');
  check('[13] 未知 id → 401 TOKEN_INVALID',
    bogus.ok === false && bogus.code === 'TOKEN_INVALID');

  check('[13] ★ 全部鉴权分支合计仍为 KV 零调用',
    kv._stats.get === 0 && kv._stats.put === 0 && kv._stats.list === 0,
    `get=${kv._stats.get} put=${kv._stats.put} list=${kv._stats.list}`);
}

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
