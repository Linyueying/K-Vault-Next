/**
 * P6 前置量化：运行时配置缓存的 TTL 到底值多少钱。
 *
 * 单 isolate 内的 KV 读次数 = 请求数 / max(1, TTL秒 / 请求间隔秒)。
 * 也就是说 TTL 只在**同 isolate 内连续请求**时才起作用。
 *
 * Cloudflare 的 isolate 会被大量复用（一个 isolate 常驻一段时间），因此
 * 这里的收益是真实的，但需要按"每 isolate 每 TTL 窗口内省下多少次 KV 读"来看。
 *
 * 运行：node scripts/bench-p6-config.mjs
 */

const SCENARIOS = [
  { name: '访客上传（每次上传）', reqPerMin: 2 },
  { name: 'API CORS 预检（每次 API 调用）', reqPerMin: 30 },
  { name: '后台设置页（每次打开）', reqPerMin: 0.2 },
];

const TTLS = [
  { label: '现状 5s', ms: 5000 },
  { label: '目标 30s', ms: 30000 },
];

// ===========================================================================
/**
 * 每个 isolate 每天回源 KV 的次数。
 *
 * 关键：回源次数**不能超过请求次数**（最多每次请求都回源一次）。
 *   · 请求间隔 >= TTL  → 每次请求都会过期 → 回源 = 请求数
 *   · 请求间隔 <  TTL  → 一个 TTL 窗口内只回源 1 次 → 回源 = 86400 / TTL
 * 取两者较小值。
 */
function readsPerDay(reqPerMin, ttlMs) {
  const reqPerDay = reqPerMin * 60 * 24;
  const intervalMs = 60000 / reqPerMin;
  const byTtl = 86400 / (ttlMs / 1000);
  return {
    reads: Math.ceil(Math.min(reqPerDay, byTtl)),
    reqPerDay,
    intervalMs,
  };
}

console.log('\n' + '='.repeat(78));
console.log('P6 量化：运行时配置缓存 TTL —— 每 isolate 每天回源 KV 的次数');
console.log('='.repeat(78));
console.log('\n口径：同 isolate 内，请求间隔 >= TTL 则每次请求都回源（缓存无效）；');
console.log('      请求间隔 < TTL 则每 TTL 窗口只回源 1 次。取二者较小值。');
console.log('      KV 读额度 10 万/天是三份里最宽的 —— 这里省的是读，不是瓶颈。\n');

for (const s of SCENARIOS) {
  console.log(`【${s.name}】`);
  let prev = null;
  for (const t of TTLS) {
    const r = readsPerDay(s.reqPerMin, t.ms);
    const merge = r.reqPerDay / r.reads;
    let line = `  ${t.label.padEnd(10)} 请求 ${String(r.reqPerDay).padStart(5)}/天` +
      ` → 回源 ${String(r.reads).padStart(5)}/天  （合并比 ${merge.toFixed(1)}x）`;
    if (prev != null && prev !== r.reads) line += `  省 ${prev - r.reads}`;
    console.log(line);
    prev = r.reads;
  }
  console.log('');
}

console.log('='.repeat(78));
console.log('结论：');
console.log('  · TTL 只在「请求间隔 < TTL」时才真的省下读。间隔 ≥ 5s 的场景');
console.log('    （访客上传、后台设置页）5s→30s **一点都省不到**，因为本来每次');
console.log('    请求就过期了，拉长 TTL 只是让缓存重新变得有意义。');
console.log('  · 只有高频路径（API CORS 预检这类秒级间隔）才有实际收益。');
console.log('  · 真正的代价是**跨 isolate 的配置生效延迟**：最坏 30 秒。');
console.log('    save/reset 已做主动失效，所以同 isolate 内始终即时生效 ——');
console.log('    这正是为什么可以拉长 TTL，而不是无脑依赖失效。');
console.log('='.repeat(78) + '\n');
