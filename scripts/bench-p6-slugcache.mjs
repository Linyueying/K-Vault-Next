/**
 * P6 决策验证：slug → 记录 的 LRU 缓存到底该不该加？
 *
 * ============================================================================
 * 要回答的问题
 * ============================================================================
 *
 * P2 之后，短链解析已经是一条 D1 主键/索引点查（`getFileRecordByShareSlug`）。
 * 方案里原计划给 `slug → kvKey` 加一层 LRU（1000 条 / 60s）。
 *
 * 但有两件事必须先算清楚：
 *
 *   1. **省下的是什么？** D1 点查是 rows read 的代价，不是 KV 写额度。
 *      而 rows read 额度是 500 万/天 —— 比 KV 写额度宽 50 倍。
 *   2. **代价是什么？** 缓存会让「改了分享设置 → 短链仍按旧记录响应」
 *      在 TTL 内成立。分享设置是**安全相关**的（密码、次数上限、有效期），
 *      在这里引入陈旧窗口，风险等级与缓存一个静态配置完全不同。
 *
 * 本脚本量化第 1 点。第 2 点无法量化，只能定性判断 —— 但它足以否决方案：
 * 在鉴权/授权相关的读取上加缓存，是经典的 CWE-524（敏感信息陈旧缓存）。
 *
 * 运行：node scripts/bench-p6-slugcache.mjs
 */

const D1_ROWS_READ_QUOTA = 5_000_000; // 免费版/天
const KV_WRITE_QUOTA = 1000;

/**
 * 短链访问的 D1 rows read。
 *
 * 一次 getFileRecordByShareSlug 是主键/索引点查 —— 命中一行，计入 1 row read
 * （SQLite 点查不扫全表）。
 */
function rowsReadPerHit() {
  return 1;
}

console.log('\n' + '='.repeat(78));
console.log('P6 决策：要不要给 slug → 记录 加 LRU 缓存');
console.log('='.repeat(78));

console.log('\n【1】省下的是什么额度');
console.log(`  短链解析一次 D1 点查 ≈ ${rowsReadPerHit()} row read（走索引，不扫表）`);
console.log(`  rows read 免费额度 ${D1_ROWS_READ_QUOTA.toLocaleString()}/天`);
console.log(`  → 用满额度可支撑 ${(D1_ROWS_READ_QUOTA / rowsReadPerHit()).toLocaleString()} 次短链访问/天`);

console.log('\n【2】对照：真正紧的额度是什么');
console.log(`  KV 写额度 ${KV_WRITE_QUOTA}/天  —— 比 rows read 窄 ${(D1_ROWS_READ_QUOTA / KV_WRITE_QUOTA).toFixed(0)} 倍`);
console.log('  短链解析**不写任何东西**，因此它完全不碰这份最紧的额度。');
console.log('  → 优化它对"额度水位"没有贡献。');

console.log('\n【3】不同访问量下，缓存能省的 rows read');
console.log('  日均访问     不加缓存 rows read    加缓存后(理论省 90%)    占额度');
for (const visits of [1000, 10_000, 100_000, 1_000_000]) {
  const noCache = visits * rowsReadPerHit();
  const withCache = Math.ceil(visits * 0.1);
  const pct = ((noCache / D1_ROWS_READ_QUOTA) * 100).toFixed(2);
  console.log(
    `  ${String(visits).padStart(10)}  ${String(noCache).padStart(18)}  ${String(withCache).padStart(20)}    ${pct.padStart(6)}%`
  );
}

console.log('\n【4】代价：陈旧窗口');
console.log('  分享设置包含：密码、次数上限、有效期、是否开启分享。');
console.log('  这些都是**授权相关**字段。加 60s 缓存意味着：');
console.log('    · 后台把分享关掉后，最长 60 秒内短链仍能正常访问');
console.log('    · 改掉密码后，最长 60 秒内旧密码仍能通过校验');
console.log('    · 调小次数上限后，最长 60 秒内仍按旧上限放行');
console.log('');
console.log('  对比一下：静态配置（访客开关 / CORS 白名单）缓存 30s 的代价是');
console.log('  "开关晚 30 秒生效"；而授权字段缓存 60s 的代价是');
console.log('  "**撤销授权晚 60 秒生效**"。这两者不是一个量级。');

console.log('\n' + '='.repeat(78));
console.log('结论：**不加**。');
console.log('='.repeat(78));
console.log('  1. 收益侧：省的是最宽松的额度（rows read），且短链访问量要到百万级');
console.log('     才占额度个位数百分比 —— 在可见的未来都不构成压力。');
console.log('  2. 代价侧：在授权路径上引入陈旧窗口，属于典型的"用安全性换一个');
console.log('     用不上的性能"。');
console.log('  3. 真正的问题是：**方案撰写时 P2 还没落地**，那时短链解析还带着');
console.log('     一次 KV 读 + 二次定位，缓存看起来划算。P2 把它压成一条点查之后，');
console.log('     这项优化就没有存在理由了 —— 属于被后续改动"淘汰"的计划项。');
console.log('='.repeat(78) + '\n');
