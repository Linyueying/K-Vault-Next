/**
 * 合集 D1 下载配额原子性回归测试。
 *
 * 覆盖：
 *   [A] 上限内消费
 *   [B] 到顶返回 limited 且不再增加计数
 *   [C] 并发消费不突破上限
 *   [D] refund 归还配额且下限为 0
 *   [E] max_downloads = 0 不限次
 *   [F] notFound
 *   [G] D1 disabled / error 明确返回
 *
 * 运行：node scripts/test-bundle-quota.mjs
 */

import {
  consumeBundleQuota,
  refundBundleQuota,
} from '../functions/utils/bundle-store.js';
import {
  consumeBundleDownloadQuota,
  refundBundleDownloadQuota,
} from '../functions/utils/share-bundle.js';
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

function seedBundle(env, slug, { maxDownloads = 0, downloadCount = 0 } = {}) {
  env._db.prepare(
    `INSERT INTO bundles (slug, type, max_downloads, download_count, created_at)
     VALUES (?, 'folder', ?, ?, 1000)`
  ).run(slug, maxDownloads, downloadCount);
}

function storedCount(env, slug) {
  return env._db.prepare('SELECT download_count FROM bundles WHERE slug = ?').get(slug)
    ?.download_count;
}

console.log('\n[A] 上限内消费');
{
  const env = makeMigratedEnv();
  seedBundle(env, 'within', { maxDownloads: 2 });

  const result = await consumeBundleQuota(env, 'within');
  check('消费成功并返回完整状态',
    result.ok === true
      && result.limited === false
      && result.notFound === false
      && result.disabled === false
      && result.count === 1,
    JSON.stringify(result));
  check('计数已落库', storedCount(env, 'within') === 1, String(storedCount(env, 'within')));
}

console.log('\n[B] 到顶 limited');
{
  const env = makeMigratedEnv();
  seedBundle(env, 'limited', { maxDownloads: 2, downloadCount: 1 });

  const second = await consumeBundleDownloadQuota(env, 'limited');
  check('门面消费到最后一次配额', second.ok === true && second.count === 2, JSON.stringify(second));

  const exhausted = await consumeBundleQuota(env, 'limited');
  check('到顶返回 limited=true、ok=false',
    exhausted.ok === false
      && exhausted.limited === true
      && exhausted.notFound === false
      && exhausted.disabled === false
      && exhausted.count === 2,
    JSON.stringify(exhausted));
  check('limited 不增加计数', storedCount(env, 'limited') === 2, String(storedCount(env, 'limited')));
}

console.log('\n[C] 并发消费不超限');
{
  const env = makeMigratedEnv();
  seedBundle(env, 'race', { maxDownloads: 5 });

  const results = await Promise.all(
    Array.from({ length: 24 }, () => consumeBundleQuota(env, 'race'))
  );
  const succeeded = results.filter((result) => result.ok).length;
  const limited = results.filter((result) => result.limited).length;
  check('24 次并发恰好成功 5 次', succeeded === 5, `实际成功 ${succeeded}`);
  check('其余请求全部 limited', limited === 19, `实际 limited ${limited}`);
  check('最终计数不超过上限', storedCount(env, 'race') === 5, String(storedCount(env, 'race')));
}

console.log('\n[D] refund 与零下限');
{
  const env = makeMigratedEnv();
  seedBundle(env, 'refund', { maxDownloads: 2, downloadCount: 2 });

  const refunded = await refundBundleDownloadQuota(env, 'refund');
  check('门面退款成功并返回最新计数',
    refunded.ok === true && refunded.notFound === false && refunded.count === 1,
    JSON.stringify(refunded));

  const consumed = await consumeBundleQuota(env, 'refund');
  check('退款后可重新消费', consumed.ok === true && consumed.count === 2, JSON.stringify(consumed));

  seedBundle(env, 'zero', { downloadCount: 0 });
  const floor = await refundBundleQuota(env, 'zero');
  check('计数为 0 时退款仍成功且不变负',
    floor.ok === true && floor.count === 0 && storedCount(env, 'zero') === 0,
    JSON.stringify(floor));
}

console.log('\n[E] 不限次合集');
{
  const env = makeMigratedEnv();
  seedBundle(env, 'unlimited', { maxDownloads: 0 });

  const results = await Promise.all(
    Array.from({ length: 12 }, () => consumeBundleDownloadQuota(env, 'unlimited'))
  );
  check('不限次请求全部消费成功', results.every((result) => result.ok && !result.limited));
  check('不限次仍准确计数', storedCount(env, 'unlimited') === 12, String(storedCount(env, 'unlimited')));
}

console.log('\n[F] notFound');
{
  const env = makeMigratedEnv();
  const consumed = await consumeBundleQuota(env, 'missing');
  check('消费不存在的合集返回 notFound',
    consumed.ok === false
      && consumed.notFound === true
      && consumed.limited === false
      && consumed.disabled === false
      && consumed.count === 0,
    JSON.stringify(consumed));

  const refunded = await refundBundleQuota(env, 'missing');
  check('退款不存在的合集返回 notFound',
    refunded.ok === false && refunded.notFound === true && refunded.count === 0,
    JSON.stringify(refunded));
}

console.log('\n[G] D1 disabled / error');
{
  const disabledConsume = await consumeBundleDownloadQuota({}, 'x');
  check('消费门面在 D1 未绑定时返回 disabled',
    disabledConsume.ok === false && disabledConsume.disabled === true && !disabledConsume.error,
    JSON.stringify(disabledConsume));

  const disabledRefund = await refundBundleDownloadQuota({}, 'x');
  check('退款门面在 D1 未绑定时返回 disabled',
    disabledRefund.ok === false && disabledRefund.disabled === true && !disabledRefund.error,
    JSON.stringify(disabledRefund));

  const brokenEnv = {
    DB: {
      prepare() {
        throw new Error('d1-unavailable');
      },
    },
  };
  const failedConsume = await consumeBundleQuota(brokenEnv, 'x');
  check('消费执行失败返回 error，不伪装成 limited/notFound/disabled',
    failedConsume.ok === false
      && failedConsume.disabled === false
      && failedConsume.limited === false
      && failedConsume.notFound === false
      && failedConsume.error === 'd1-unavailable',
    JSON.stringify(failedConsume));

  const failedRefund = await refundBundleQuota(brokenEnv, 'x');
  check('退款执行失败返回 error',
    failedRefund.ok === false && failedRefund.disabled === false && failedRefund.error === 'd1-unavailable',
    JSON.stringify(failedRefund));
}

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
