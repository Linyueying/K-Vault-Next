/**
 * 站点品牌（branding）配置与公开接口测试。
 *
 * 覆盖：
 *   [1] normalizeBrandingConfig 归一化：默认 / 空串回落 / trim / 截断 / 非字符串
 *   [2] getBrandingConfigResolved：KV 覆盖优先、未配置回落默认 K-Vault-NEXT
 *   [3] /api/site-branding 公开接口：返回 {siteName,siteTitle,source} 且带 public 缓存头
 *   [4] 接口在 KV 异常时仍返回默认（不抛错、不中断前端）
 *
 * 运行：node scripts/test-branding.mjs
 */
import {
  normalizeBrandingConfig,
  getBrandingConfigResolved,
  CONFIG_GROUPS,
  invalidateRuntimeConfigCache,
} from '../functions/utils/runtime-config.js';
import { onRequestGet } from '../functions/api/site-branding.js';

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** 带读写计数的 KV 替身（与 test-runtime-config.mjs 同形）。 */
function makeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  const stats = { get: 0, put: 0, delete: 0 };
  return {
    _store: store,
    _stats: stats,
    async get(key, opts) {
      stats.get += 1;
      if (!store.has(key)) return null;
      const value = store.get(key);
      return opts?.type === 'json' ? value : JSON.stringify(value);
    },
    async put(key, value) {
      stats.put += 1;
      store.set(key, JSON.parse(value));
    },
    async delete(key) {
      stats.delete += 1;
      store.delete(key);
    },
  };
}

// ============================================================================
console.log('[1] normalizeBrandingConfig 归一化');
{
  const d = normalizeBrandingConfig(undefined);
  check('[1] 无输入 → 双默认 K-Vault-NEXT',
    d.siteName === 'K-Vault-NEXT' && d.siteTitle === 'K-Vault-NEXT', JSON.stringify(d));

  const e = normalizeBrandingConfig({});
  check('[1] 空对象 → 双默认',
    e.siteName === 'K-Vault-NEXT' && e.siteTitle === 'K-Vault-NEXT', JSON.stringify(e));

  const f = normalizeBrandingConfig({ siteName: '  一云  ', siteTitle: '  我的网盘 ' });
  check('[1] 自动 trim', f.siteName === '一云' && f.siteTitle === '我的网盘', JSON.stringify(f));

  const g = normalizeBrandingConfig({ siteName: '   ', siteTitle: '' }, { siteName: 'X', siteTitle: 'Y' });
  check('[1] 空串回落到 base', g.siteName === 'X' && g.siteTitle === 'Y', JSON.stringify(g));

  const h = normalizeBrandingConfig({ siteName: 'a'.repeat(200), siteTitle: 'b'.repeat(200) });
  check('[1] 超长截断到 120', h.siteName.length === 120 && h.siteTitle.length === 120,
    `${h.siteName.length}/${h.siteTitle.length}`);

  const i = normalizeBrandingConfig({ siteName: 123, siteTitle: null });
  check('[1] 非字符串 → 回落默认', i.siteName === 'K-Vault-NEXT' && i.siteTitle === 'K-Vault-NEXT', JSON.stringify(i));
}

// ============================================================================
console.log('[2] getBrandingConfigResolved：KV 优先 / 回落默认');
{
  const kv = makeKv({ 'config:branding': { siteName: '一云', siteTitle: '一云网盘' } });
  const env = { img_url: kv };
  const r = await getBrandingConfigResolved(env);
  check('[2] KV 覆盖优先', r.siteName === '一云' && r.siteTitle === '一云网盘', JSON.stringify(r));
  check('[2] source=kv', r.source === 'kv', String(r.source));

  const envNoKv = {};
  const d = await getBrandingConfigResolved(envNoKv);
  check('[2] 未绑 KV → 回落默认', d.siteName === 'K-Vault-NEXT' && d.siteTitle === 'K-Vault-NEXT', JSON.stringify(d));
  check('[2] 未绑 KV → source=env', d.source === 'env', String(d.source));

  check('[2] branding 已登记为受管分组', CONFIG_GROUPS.includes('branding'), CONFIG_GROUPS.join(','));
}

// ============================================================================
console.log('[3] /api/site-branding 公开接口');
{
  const kv = makeKv({ 'config:branding': { siteName: '一云', siteTitle: '一云网盘' } });
  const ctx = { env: { img_url: kv } };
  const res = await onRequestGet(ctx);
  const body = await res.json();
  check('[3] 返回 siteName/siteTitle', body.siteName === '一云' && body.siteTitle === '一云网盘', JSON.stringify(body));
  check('[3] 带 source 字段', body.source === 'kv', String(body.source));
  check('[3] Cache-Control 为 public 边缘缓存',
    /public/.test(res.headers.get('Cache-Control') || ''), res.headers.get('Cache-Control'));
}

// ============================================================================
console.log('[4] 接口在 KV 异常时仍返回默认');
{
  // 先清掉 [3] 留下的进程内缓存，确保本用例走"冷缓存 → 真实读 KV"路径
  invalidateRuntimeConfigCache();
  const brokenKv = {
    async get() { throw new Error('kv-down'); },
  };
  const ctx = { env: { img_url: brokenKv } };
  const res = await onRequestGet(ctx);
  const body = await res.json();
  check('[4] KV 异常不抛错、返回默认',
    res.status === 200 && body.siteName === 'K-Vault-NEXT' && body.siteTitle === 'K-Vault-NEXT',
    JSON.stringify(body));
}

// ============================================================================
console.log('');
console.log(`品牌测试完成：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
