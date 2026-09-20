/**
 * GET /api/manage/usage
 * 查询 KV 和 R2 的存储用量与操作次数，自动识别计划类型。
 *
 * 绑定识别顺序：
 *   1. 从 env 中自动识别 R2Bucket / KVNamespace 绑定（使用 createMultipartUpload 精确区分）
 *   2. 若配置了环境变量 R2_BUCKET_NAMES，则优先使用真实桶名
 *   3. 都没有时优雅降级，返回 r2Available: false
 */

const PLAN_LIMITS = {
  free: {
    kv: { storageBytes: 1 * 1024 * 1024 * 1024, reads: 100000, writes: 1000, deletes: 1000, lists: 1000 },
    r2: { storageBytes: 10 * 1024 * 1024 * 1024, classA: 1000000, classB: 10000000 },
    resetType: 'daily'
  },
  paid: {
    kv: { storageBytes: null, reads: 10000000, writes: 1000000, deletes: 1000000, lists: 1000000 },
    r2: { storageBytes: null, classA: null, classB: null },
    resetType: 'monthly'
  }
};

const CACHE_KEYS = { plan: 'kv-usage:config:plan', billing: 'kv-usage:config:billing_period' };
const CACHE_TTL = { plan: 86400, billing: 32 * 86400 };

async function cacheGet(env, key) {
  try { return await env.KV.get(key, { type: 'json' }); } catch (e) { return null; }
}
async function cachePut(env, key, value, expirationTtl) {
  try { await env.KV.put(key, JSON.stringify(value), { expirationTtl }); } catch (e) {}
}

/* ============================================================
 * 核心修复：绑定识别（精确区分 KV 和 R2）
 * ============================================================ */
function detectBindings(env) {
  const r2Buckets = [];
  const kvNamespaces = [];

  for (const [key, value] of Object.entries(env)) {
    if (!value || typeof value !== 'object') continue;

    // 必须有 get/put/list 方法才可能是 KV 或 R2
    if (typeof value.get !== 'function' || typeof value.put !== 'function' || typeof value.list !== 'function') continue;

    // ★ 核心修复：利用 R2 独有的 createMultipartUpload 方法精确区分
    // KV 没有这个方法，绝对不会误判！
    const isR2 = typeof value.createMultipartUpload === 'function';
    const isKV = !isR2;

    if (isKV) {
      // 真实环境中 namespaceId 可能不存在，给个默认值
      kvNamespaces.push({ binding: key, namespaceId: value.namespaceId || 'unknown' });
    } else if (isR2) {
      // ★ 注意：R2 的绑定名称（key）通常不等于真实的桶名（bucketName）
      // 真实的桶名在 Workers 运行时无法通过代码读取，所以默认先用绑定名占位
      // 后续会通过环境变量 R2_BUCKET_NAMES 进行覆盖修正
      const bucketName = value.bucketName || value.name || key;
      r2Buckets.push({ binding: key, bucketName, source: 'binding' });
    }
  }

  // ★ 如果环境变量配置了真实桶名（强烈推荐），则强制修正
  const envR2Names = String(env.R2_BUCKET_NAMES || '').split(',').map(s => s.trim()).filter(Boolean);
  if (envR2Names.length > 0) {
    envR2Names.forEach(name => {
      const existing = r2Buckets.find(b => b.bucketName === name);
      if (existing) {
        existing.source = 'env'; // 标记为来自环境变量（真实桶名）
      } else {
        r2Buckets.push({ binding: `env:${name}`, bucketName: name, source: 'env' });
      }
    });
  }

  return { r2Buckets, kvNamespaces };
}

/* ============================================================
 * 计划检测（增强健壮性，输出明确的错误原因）
 * ============================================================ */
async function detectPlan(env) {
  const accountId = env.CF_ACCOUNT_ID;
  const apiToken = env.CF_API_TOKEN;

  if (!accountId || !apiToken) {
    return { type: 'free', limits: PLAN_LIMITS.free, billingPeriod: null, fromCache: false, error: '缺少 CF_ACCOUNT_ID 或 CF_API_TOKEN' };
  }

  const cached = await cacheGet(env, CACHE_KEYS.plan);
  if (cached && cached.type) {
    return { type: cached.type, limits: PLAN_LIMITS[cached.type], fromCache: true, error: null };
  }

  try {
    const resp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/subscriptions`, {
      headers: { 'Authorization': `Bearer ${apiToken}` }
    });
    const data = await resp.json();
    if (!resp.ok || !data.success) {
      let errMsg = data.errors ? data.errors.map(e => e.message).join(', ') : `HTTP ${resp.status}`;
      throw new Error(errMsg);
    }

    const subs = Array.isArray(data.result) ? data.result : [];
    const paidSub = subs.find(s => s.rate_plan?.id === 'workers_paid' && s.rate_plan?.scope === 'account');
    const planType = paidSub ? 'paid' : 'free';

    let billingPeriod = null;
    if (paidSub && paidSub.current_period_start && paidSub.current_period_end) {
      billingPeriod = { start: paidSub.current_period_start, end: paidSub.current_period_end };
      await cachePut(env, CACHE_KEYS.billing, billingPeriod, CACHE_TTL.billing);
    }

    await cachePut(env, CACHE_KEYS.plan, { type: planType }, CACHE_TTL.plan);
    return { type: planType, limits: PLAN_LIMITS[planType], billingPeriod, fromCache: false, error: null };

  } catch (e) {
    console.error("Plan detection failed:", e);
    return { type: 'free', limits: PLAN_LIMITS.free, billingPeriod: null, fromCache: false, error: e.message || '计划检测失败' };
  }
}

async function getBillingPeriod(env, plan) {
  if (plan.billingPeriod) return plan.billingPeriod;
  const cached = await cacheGet(env, CACHE_KEYS.billing);
  if (cached && cached.start && cached.end) return cached;
  return null;
}

function getDateRange(plan, billingPeriod) {
  const today = new Date().toISOString().slice(0, 10);
  if (plan.type === 'free' || plan.limits.resetType === 'daily') {
    return { start: today, end: today };
  }
  if (billingPeriod && billingPeriod.start) {
    const start = new Date(billingPeriod.start).toISOString().slice(0, 10);
    const end = new Date(billingPeriod.end).toISOString().slice(0, 10);
    const startDate = new Date(start);
    const endDate = new Date(end);
    if ((endDate - startDate) > 31 * 86400000) {
      startDate.setTime(endDate.getTime() - 31 * 86400000);
    }
    return { start: startDate.toISOString().slice(0, 10), end: endDate.toISOString().slice(0, 10) };
  }
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  return { start: monthStart, end: today };
}

async function gql(apiToken, query, variables) {
  const resp = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const data = await resp.json();
  if (data.errors) throw new Error(data.errors[0]?.message || 'GraphQL 查询失败');
  return data.data;
}

async function fetchKvStorage(accountId, apiToken, namespaceId, dateRange) {
  const query = `
    query KvStorage($accountTag: string!, $namespaceId: string, $start: Date, $end: Date) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        kvStorageAdaptiveGroups(
          filter: { date_geq: $start, date_leq: $end, namespaceId: $namespaceId }
          limit: 1 orderBy: [date_DESC]
        ) { max { keyCount byteCount } dimensions { date } }
      } }
    }`;
  const data = await gql(apiToken, query, { accountTag: accountId, namespaceId, start: dateRange.start, end: dateRange.end });
  const groups = data?.viewer?.accounts?.[0]?.kvStorageAdaptiveGroups || [];
  const latest = groups[0]?.max || { keyCount: 0, byteCount: 0 };
  return { keyCount: Number(latest.keyCount || 0), byteCount: Number(latest.byteCount || 0) };
}

async function fetchKvOperations(accountId, apiToken, namespaceId, dateRange) {
  const query = `
    query KvOps($accountTag: string!, $namespaceId: string, $start: Date, $end: Date) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        kvOperationsAdaptiveGroups(
          filter: { namespaceId: $namespaceId, date_geq: $start, date_leq: $end }
          limit: 100
        ) { sum { requests } dimensions { actionType } }
      } }
    }`;
  const data = await gql(apiToken, query, { accountTag: accountId, namespaceId, start: dateRange.start, end: dateRange.end });
  const groups = data?.viewer?.accounts?.[0]?.kvOperationsAdaptiveGroups || [];
  const ops = { read: 0, write: 0, delete: 0, list: 0 };
  groups.forEach(g => {
    const raw = String(g.dimensions?.actionType || '').toLowerCase();
    let key = raw;
    if (raw.includes('read')) key = 'read';
    else if (raw.includes('write') || raw.includes('put')) key = 'write';
    else if (raw.includes('delete') || raw.includes('remove')) key = 'delete';
    else if (raw.includes('list')) key = 'list';
    if (ops[key] !== undefined) ops[key] += Number(g.sum?.requests || 0);
  });
  return ops;
}

async function fetchR2Storage(accountId, apiToken, bucketName, dateRange) {
  const query = `
    query R2Storage($accountTag: string!, $bucketName: string!, $start: Date, $end: Date) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        r2StorageAdaptiveGroups(
          filter: { date_geq: $start, date_leq: $end, bucketName: $bucketName }
          limit: 1 orderBy: [date_DESC]
        ) {
          max { payloadSize metadataSize objectCount uploadCount }
          dimensions { date bucketName }
        }
      } }
    }`;
  const data = await gql(apiToken, query, { accountTag: accountId, bucketName, start: dateRange.start, end: dateRange.end });
  const groups = data?.viewer?.accounts?.[0]?.r2StorageAdaptiveGroups || [];
  const latest = groups[0]?.max || {};
  return {
    payloadSize: Number(latest.payloadSize || 0),
    metadataSize: Number(latest.metadataSize || 0),
    objectCount: Number(latest.objectCount || 0),
    uploadCount: Number(latest.uploadCount || 0)
  };
}

async function fetchR2Operations(accountId, apiToken, bucketName, dateRange) {
  const query = `
    query R2Ops($accountTag: string!, $bucketName: string!, $start: Date, $end: Date) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        r2OperationsAdaptiveGroups(
          filter: { bucketName: $bucketName, date_geq: $start, date_leq: $end }
          limit: 100
        ) { sum { requests } dimensions { actionType } }
      } }
    }`;
  const data = await gql(apiToken, query, { accountTag: accountId, bucketName, start: dateRange.start, end: dateRange.end });
  const groups = data?.viewer?.accounts?.[0]?.r2OperationsAdaptiveGroups || [];

  const classA_actions = ['PutObject', 'CopyObject', 'ListObjects', 'ListObjectsV2',
    'ListMultipartUploads', 'CreateMultipartUpload', 'UploadPart',
    'CompleteMultipartUpload', 'AbortMultipartUpload'];
  const classB_actions = ['GetObject', 'HeadObject', 'HeadBucket', 'GetBucketLocation'];

  let classA = 0, classB = 0;
  groups.forEach(g => {
    const action = g.dimensions?.actionType || '';
    const count = Number(g.sum?.requests || 0);
    if (classA_actions.some(a => action.includes(a))) classA += count;
    else if (classB_actions.some(a => action.includes(a))) classB += count;
    else classB += count;
  });
  return { classA, classB };
}

export async function onRequestGet(context) {
  const { env } = context;
  const accountId = env.CF_ACCOUNT_ID;
  const apiToken = env.CF_API_TOKEN;

  const { r2Buckets, kvNamespaces } = detectBindings(env);

  if (!kvNamespaces.length && !r2Buckets.length) {
    return Response.json({
      success: false, configured: false,
      error: '未检测到 KV 或 R2 绑定，请检查 Pages 项目的绑定配置',
      plan: null, kv: null, r2: [], r2Available: false, date: '', resetAt: ''
    }, { status: 503 });
  }

  if (!accountId || !apiToken) {
    return Response.json({
      success: false, configured: true,
      error: '缺少 CF_ACCOUNT_ID 或 CF_API_TOKEN，无法查询用量数据',
      plan: null, kv: null, r2: [], r2Available: r2Buckets.length > 0,
      r2Bindings: r2Buckets.map(b => ({ binding: b.binding, bucketName: b.bucketName, source: b.source })),
      date: '', resetAt: ''
    }, { status: 503 });
  }

  try {
    const plan = await detectPlan(env);
    const billingPeriod = plan.type === 'paid' ? await getBillingPeriod(env, plan) : null;
    const dateRange = getDateRange(plan, billingPeriod);

    let kvResult = null;
    if (kvNamespaces.length > 0) {
      const kvBinding = kvNamespaces[0];
      try {
        const [kvStorage, kvOps] = await Promise.all([
          fetchKvStorage(accountId, apiToken, kvBinding.namespaceId, dateRange),
          fetchKvOperations(accountId, apiToken, kvBinding.namespaceId, dateRange)
        ]);
        const kvLimits = plan.limits.kv;
        kvResult = {
          binding: kvBinding.binding,
          storage: {
            usedBytes: kvStorage.byteCount,
            totalBytes: kvLimits.storageBytes,
            keyCount: kvStorage.keyCount,
            usagePercent: kvLimits.storageBytes ? (kvStorage.byteCount / kvLimits.storageBytes) * 100 : null
          },
          operations: {
            read:   { used: kvOps.read,   limit: kvLimits.reads,   remaining: Math.max(0, kvLimits.reads - kvOps.read) },
            write:  { used: kvOps.write,  limit: kvLimits.writes,  remaining: Math.max(0, kvLimits.writes - kvOps.write) },
            delete: { used: kvOps.delete, limit: kvLimits.deletes, remaining: Math.max(0, kvLimits.deletes - kvOps.delete) },
            list:   { used: kvOps.list,   limit: kvLimits.lists,   remaining: Math.max(0, kvLimits.lists - kvOps.list) }
          }
        };
      } catch (e) {
        kvResult = { binding: kvBinding.binding, error: e.message || 'KV 查询失败' };
      }
    }

    const r2Results = [];
    for (const r2 of r2Buckets) {
      try {
        const [r2Storage, r2Ops] = await Promise.all([
          fetchR2Storage(accountId, apiToken, r2.bucketName, dateRange),
          fetchR2Operations(accountId, apiToken, r2.bucketName, dateRange)
        ]);
        const r2Limits = plan.limits.r2;
        r2Results.push({
          binding: r2.binding,
          bucketName: r2.bucketName,
          source: r2.source,
          storage: {
            usedBytes: r2Storage.payloadSize + r2Storage.metadataSize,
            payloadSize: r2Storage.payloadSize,
            metadataSize: r2Storage.metadataSize,
            objectCount: r2Storage.objectCount,
            uploadCount: r2Storage.uploadCount,
            totalBytes: r2Limits.storageBytes,
            usagePercent: r2Limits.storageBytes
              ? ((r2Storage.payloadSize + r2Storage.metadataSize) / r2Limits.storageBytes) * 100
              : null
          },
          operations: {
            classA: { used: r2Ops.classA, limit: r2Limits.classA, remaining: r2Limits.classA ? Math.max(0, r2Limits.classA - r2Ops.classA) : null },
            classB: { used: r2Ops.classB, limit: r2Limits.classB, remaining: r2Limits.classB ? Math.max(0, r2Limits.classB - r2Ops.classB) : null }
          }
        });
      } catch (e) {
        r2Results.push({
          binding: r2.binding, bucketName: r2.bucketName, source: r2.source,
          error: e.message || 'R2 查询失败'
        });
      }
    }

    const resetLabel = plan.type === 'free'
      ? '每日 00:00 UTC 重置'
      : (billingPeriod ? `计费周期 ${billingPeriod.start} 至 ${billingPeriod.end}，超出按量付费` : '按月计费，超出按量付费');

    return Response.json({
      success: true,
      configured: true,
      plan: {
        type: plan.type,
        typeLabel: plan.type === 'paid' ? '付费计划' : '免费计划',
        resetType: plan.limits.resetType,
        fromCache: plan.fromCache,
        detectionError: plan.error,
        billingPeriod
      },
      kv: kvResult,
      r2: r2Results,
      r2Available: r2Buckets.length > 0,
      r2Source: r2Buckets.length > 0 ? r2Buckets[0].source : null,
      date: `${dateRange.start} ~ ${dateRange.end}`,
      resetAt: resetLabel
    });

  } catch (e) {
    return Response.json({
      success: false, configured: true,
      error: e.message || '查询异常',
      plan: null, kv: null, r2: [], r2Available: false, date: '', resetAt: ''
    }, { status: 500 });
  }
}