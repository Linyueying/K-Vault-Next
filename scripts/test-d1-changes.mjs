/**
 * D1 受影响行数回归测试。
 *
 * ============================================================================
 * 这个测试为什么存在
 * ============================================================================
 *
 * 线上真实故障：**后台修改 API Token 一直报「提交失败」**，轮换密钥与删除
 * Token 同样报 `TOKEN_NOT_FOUND` —— 但数据其实**已经改了**。
 *
 * 根因是 D1 结果读取写错了字段：
 *
 *     const updated = Number(res?.changes) || 0;   // 恒为 0
 *
 * 真实 D1 的 `run()` 返回 `{ success, meta: { changes } }`，顶层**没有**
 * changes。于是「更新了 1 行」被读成 0，调用方判定"这一行不存在"，返回
 * 404 —— 而 UPDATE 早就执行完了。这就是最难查的一类：**假报错 + 真生效**。
 * 用户看到失败去重试，重试照样"失败"，可每次操作都真的落库了。
 *
 * 更值得记住的是**为什么单测没拦住**：当时的 D1 替身同时塞了顶层 changes
 * 和 meta.changes，比真实 D1 更宽容。生产代码写错字段，测试里却一路绿灯。
 * 所以本套件同时守住两件事：
 *
 *   1. 生产代码只从 meta.changes 取行数（changedCount）
 *   2. 替身**只**提供 meta.changes —— 比现实更宽容的替身等于没测
 *
 * ============================================================================
 * 覆盖
 * ============================================================================
 *
 *   [1] changedCount —— meta.changes / 顶层 changes / 两者都没有
 *   [2] 替身保真：run() 的顶层不得出现 changes
 *   [3] ★ 改 Token 成功路径（线上故障点）
 *   [4] ★ 轮换密钥成功路径
 *   [5] ★ 删除 Token：真删掉时报告 1，不存在时报告 0
 *   [6] 反向用例：不存在的 id 必须报告 null / false（不能一律报成功）
 *
 * 运行：node scripts/test-d1-changes.mjs
 */
import { changedCount } from '../functions/utils/d1-result.js';
import {
  createApiToken,
  deleteApiToken,
  getRecordById,
  rotateApiToken,
  updateApiToken,
} from '../functions/utils/api-token.js';
import { deletePasteRecord } from '../functions/utils/paste-d1.js';
import { makeMigratedEnv } from './test-utils.mjs';

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
};
const eq = (label, actual, expected) =>
  check(label, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);

/* ==========================================================================
 * [1] changedCount —— 纯函数
 * ========================================================================== */
console.log('\n[1] changedCount');
{
  eq('真实 D1 形状 meta.changes', changedCount({ success: true, meta: { changes: 1 } }), 1);
  eq('meta.changes = 0（没匹配到行）', changedCount({ success: true, meta: { changes: 0 } }), 0);
  eq('无 meta.changes 时回落顶层 changes', changedCount({ changes: 3 }), 3);
  eq('meta 优先于顶层', changedCount({ meta: { changes: 2 }, changes: 9 }), 2);
  eq('两者都没有 → 0', changedCount({ success: true }), 0);
  eq('null → 0', changedCount(null), 0);
  eq('undefined → 0', changedCount(undefined), 0);
  eq('meta 非数字 → 0', changedCount({ meta: { changes: 'x' } }), 0);
  // 关键回归：顶层没有 changes 时**不能**被当成 0 而误判"没这行"
  check('★ 只有 meta.changes 时能取到非 0 行数',
    changedCount({ success: true, meta: { changes: 5 } }) === 5);
}

/* ==========================================================================
 * [2] 替身保真
 * ========================================================================== */
console.log('\n[2] D1 替身保真（防止"替身比现实宽容"再次掩盖 bug）');
{
  const env = makeMigratedEnv();
  const res = await env.DB.prepare('SELECT 1 AS one').first();
  eq('替身能正常查询', res.one, 1);

  // 直接执行一条会改行的语句，检查返回形状
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS __probe (id TEXT PRIMARY KEY)').run();
  const ins = await env.DB.prepare('INSERT OR REPLACE INTO __probe (id) VALUES (?)').bind('a').run();
  check('替身 run() 提供 meta.changes', Number(ins?.meta?.changes) >= 1, JSON.stringify(ins));
  check('★ 替身 run() 顶层**没有** changes（与真实 D1 一致）',
    ins.changes === undefined, `顶层 changes=${JSON.stringify(ins.changes)}`);
  // 生产代码若写成 res.changes，在这套替身下会立刻暴露
  eq('★ 用错误字段读取会得到 0（正是线上 bug 的形态）',
    Number(ins?.changes) || 0, 0);
}

/* ==========================================================================
 * [3]-[5] 端到端：Token 改 / 轮换 / 删
 * ========================================================================== */
console.log('\n[3]-[5] Token 改 / 轮换 / 删');
{
  const env = makeMigratedEnv();

  const created = await createApiToken({ name: 'regression', scopes: ['upload', 'read'] }, env);
  check('建 Token 成功', Boolean(created && created.record && created.record.id),
    JSON.stringify(created && created.record));

  const id = created.record.id;

  // ── [3] 改 Token：线上故障点 ──
  // 之前这里返回 null → 路由层回 404 TOKEN_NOT_FOUND，尽管 UPDATE 已生效
  const updated = await updateApiToken(id, { scopes: ['upload', 'read', 'share'] }, env);
  check('★ 改 Token 返回记录而不是 null（线上故障点）', Boolean(updated), String(updated));
  if (updated) {
    check('★ 新 scope 真的写进去了',
      Array.isArray(updated.record.scopes) && updated.record.scopes.includes('share'),
      JSON.stringify(updated.record.scopes));
  }

  // 改完再读一次，确认持久化（而不是只在返回值里变）
  const reread = await getRecordById(id, env);
  check('★ 落库后回读仍含 share',
    Boolean(reread && reread.scopes.includes('share')),
    JSON.stringify(reread && reread.scopes));

  // 禁用/启用也走同一条路径
  const disabled = await updateApiToken(id, { enabled: false }, env);
  check('禁用 Token 返回记录', Boolean(disabled), String(disabled));
  check('禁用状态已生效', Boolean(disabled) && disabled.record.enabled === false,
    JSON.stringify(disabled && disabled.record.enabled));

  // ── [4] 轮换密钥 ──
  const rotated = await rotateApiToken(id, env);
  check('★ 轮换密钥返回新密钥而不是 null', Boolean(rotated && rotated.token), String(rotated));

  // ── [5] 删除 ──
  const deleted = await deleteApiToken(id, env);
  eq('★ 删除存在的 Token 返回 true', deleted, true);
  const gone = await getRecordById(id, env);
  eq('删除后确实读不到', gone, null);

  // ── [6] 反向用例：不存在必须报"不存在"，不能一律成功 ──
  eq('删不存在的 Token → false', await deleteApiToken('no-such-token-id', env), false);
  eq('改不存在的 Token → null',
    await updateApiToken('no-such-token-id', { scopes: ['read'] }, env), null);
  eq('轮换不存在的 Token → null', await rotateApiToken('no-such-token-id', env), null);
}

/* ==========================================================================
 * [7] paste 删除 —— 同一根因的另一处
 * ========================================================================== */
console.log('\n[7] paste 删除（同根因）');
{
  const env = makeMigratedEnv();
  await env._db.exec(`
    CREATE TABLE IF NOT EXISTS pastes (
      paste_id TEXT PRIMARY KEY, content TEXT, language TEXT,
      created_at INTEGER, expires_at INTEGER, has_password INTEGER DEFAULT 0
    );
  `);
  await env.DB.prepare(
    'INSERT INTO pastes (paste_id, content, language, created_at, expires_at) VALUES (?,?,?,?,?)'
  ).bind('p1', 'hello', 'text', Date.now(), 0).run();

  const d1 = await deletePasteRecord(env, 'p1');
  check('删除存在的 paste 报告 ok', d1.ok === true, JSON.stringify(d1));
  eq('★ 删除存在的 paste 报告 1 行（而非 0）', Number(d1.deleted), 1);

  const d2 = await deletePasteRecord(env, 'p1');
  eq('重复删除报告 0 行', Number(d2.deleted), 0);
}

/* ==========================================================================
 * 汇总
 * ========================================================================== */
console.log('');
if (fail === 0) {
  console.log(`✅ D1 行数读取回归全部通过：${pass} 项断言，0 失败。`);
  process.exit(0);
} else {
  console.log(`❌ D1 行数读取回归失败：${pass} 通过 / ${fail} 失败（共 ${pass + fail} 项）。`);
  process.exit(1);
}
