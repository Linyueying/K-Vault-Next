/**
 * GET /api/manage/usage
 * 查询 KV、R2 与 D1 的存储用量与操作次数，自动识别计划类型。
 *
 * 环境变量依赖（在 Cloudflare Pages 设置 -> 环境变量 中配置）：
 *   - CF_ACCOUNT_ID    (D1/KV/R2 用量必填) Cloudflare 账户 ID
 *   - CF_API_TOKEN     (D1/KV/R2 用量必填) API Token，需要 "账户分析:读取" 和 "Workers R2 存储:读取" 权限
 *   - R2_BUCKET_NAMES  (必填) 真实的 R2 桶名，多个用英文逗号隔开，例如 "k-valut-next,k-vault-files"
 *   - KV_NAMESPACE_ID  (必填) KV 命名空间的 ID，用于绕过运行时无法读取 namespaceId 的限制
 *   - D1_DATABASE_ID   (可选) D1 数据库 ID。**不配也能用**——存储用量走查询返回的
 *                      meta.size_after，不需要 API；配了才会额外显示今日读写行数
 *   - CF_PLAN_TYPE     (可选) 强制指定计划类型，填 "free" 或 "paid"，填了就不再去请求 Cloudflare 订阅接口
 *
 * 关于 D1 用量：
 *   免费额度 5 GB 存储 / 每日 500 万行读取 / 每日 10 万行写入（每日 00:00 UTC 重置）
 *   付费额度 5 GB 存储 / 每月 250 亿行读取 / 每月 5000 万行写入
 *   存储大小取自每次查询返回的 `meta.size_after`（官方口径），零配置、实时准确；
 *   今日读写行数只能从 GraphQL `d1AnalyticsAdaptiveGroups` 拿，故需要 D1_DATABASE_ID。
 */

import { TABLES, schemaStatus } from '../../utils/schema.js';

const PLAN_LIMITS = {
  free: {
    kv: { storageBytes: 1 * 1024 * 1024 * 1024, reads: 100000, writes: 1000, deletes: 1000, lists: 1000 },
    r2: { storageBytes: 10 * 1024 * 1024 * 1024, classA: 1000000, classB: 10000000 }, // R2 按月重置
    // D1 免费：存储 5 GB（总量），读写**按日**重置
    d1: { storageBytes: 5 * 1024 * 1024 * 1024, rowsRead: 5000000, rowsWritten: 100000, resetType: 'daily' },
    resetType: 'daily'
  },
  paid: {
    kv: { storageBytes: null, reads: 10000000, writes: 1000000, deletes: 1000000, lists: 1000000 },
    r2: { storageBytes: null, classA: null, classB: null },
    // D1 付费：含 5 GB 存储 + 25B 读 / 50M 写（**按月**），超出按量计费
    d1: { storageBytes: 5 * 1024 * 1024 * 1024, rowsRead: 25000000000, rowsWritten: 50000000, resetType: 'monthly' },
    resetType: 'monthly'
  }
};

/** D1 里需要展示行数的业务表（排除 schema_migrations 这类元表）。 */
const D1_BUSINESS_TABLES = TABLES.filter((t) => t !== 'schema_migrations');

const CACHE_KEYS = { plan: 'kv-usage:config:plan', billing: 'kv-usage:config:billing_period' };
const CACHE_TTL = { plan: 86400, billing: 32 * 86400 };

/**
 * 缓存用的 KV 命名空间。
 *
 * 注意绑定名叫 img_url，不是 KV —— 早期这里写死 env.KV 导致缓存永远失效，
 * 每次打开后台都重新请求一次订阅接口。这里兼容多种写法。
 */
function cacheNamespace(env) {
  return env.KV || env.img_url || null;
}

async function cacheGet(env, key) {
  try {
    const kv = cacheNamespace(env);
    if (!kv) return null;
    return await kv.get(key, { type: 'json' });
  } catch (e) { return null; }
}
async function cachePut(env, key, value, expirationTtl) {
  try {
    const kv = cacheNamespace(env);
    if (!kv) return;
    await kv.put(key, JSON.stringify(value), { expirationTtl });
  } catch (e) {}
}

/* ============================================================
 * 绑定识别（优先使用环境变量真实桶名，精确区分 KV 和 R2）
 * ============================================================ */
function detectBindings(env) {
  const r2Buckets = [];
  const kvNamespaces = [];

  // 1. 优先读取环境变量中的 R2 真实桶名（彻底解决重复卡片和查不到数据的问题）
  const envR2Names = String(env.R2_BUCKET_NAMES || '').split(',').map(s => s.trim()).filter(Boolean);
  if (envR2Names.length > 0) {
    envR2Names.forEach(name => {
      r2Buckets.push({ binding: `env:${name}`, bucketName: name, source: 'env' });
    });
  } else {
    // 如果没有配置环境变量，才去自动扫描绑定，但极其不推荐，容易出错
    for (const [key, value] of Object.entries(env)) {
      if (!value || typeof value !== 'object') continue;
      // 利用 createMultipartUpload 精确区分 R2 和 KV
      if (typeof value.get === 'function' && typeof value.put === 'function' && typeof value.createMultipartUpload === 'function') {
        r2Buckets.push({ binding: key, bucketName: key, source: 'binding' });
      }
    }
  }

  // 2. 提取 KV 绑定
  for (const [key, value] of Object.entries(env)) {
    if (!value || typeof value !== 'object') continue;
    if (typeof value.get !== 'function' || typeof value.put !== 'function' || typeof value.list !== 'function') continue;
    
    const isR2 = typeof value.createMultipartUpload === 'function';
    if (!isR2) {
      // 运行时无法读取 KV 的 namespaceId，必须从环境变量获取
      const nsId = value.namespaceId || env.KV_NAMESPACE_ID || '';
      kvNamespaces.push({ binding: key, namespaceId: nsId });
    }
  }

  return { r2Buckets, kvNamespaces };
}

/* ============================================================
 * 计划检测（支持 CF_PLAN_TYPE 强制指定，彻底绕过 API）
 * ============================================================ */
async function detectPlan(env) {
  // 终极退路：如果环境变量里直接指定了计划，直接返回，完全不请求 API
  if (env.CF_PLAN_TYPE === 'paid' || env.CF_PLAN_TYPE === 'free') {
    return { type: env.CF_PLAN_TYPE, limits: PLAN_LIMITS[env.CF_PLAN_TYPE], billingPeriod: null, fromCache: false, error: null };
  }

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
      headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' }
    });
    
    let data;
    try { data = await resp.json(); } catch (e) { throw new Error(`解析失败, HTTP ${resp.status}`); }

    if (!resp.ok || !data.success) {
      let errMsg = data.errors ? data.errors.map(e => `${e.code}: ${e.message}`).join('; ') : `HTTP ${resp.status}`;
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
    return { type: 'free', limits: PLAN_LIMITS.free, billingPeriod: null, fromCache: false, error: e.message || '计划检测失败' };
  }
}

async function getBillingPeriod(env, plan) {
  if (plan.billingPeriod) return plan.billingPeriod;
  const cached = await cacheGet(env, CACHE_KEYS.billing);
  if (cached && cached.start && cached.end) return cached;
  return null;
}

/* ============================================================
 * 日期范围生成
 * ============================================================ */

// KV 日期范围：免费计划按日，付费计划按计费周期
function getDateRange(plan, billingPeriod) {
  const today = new Date().toISOString().slice(0, 10);
  if (plan.type === 'free' || plan.limits.resetType === 'daily') {
    return { start: today, end: today };
  }
  if (billingPeriod && billingPeriod.start) {
    const start = new Date(billingPeriod.start).toISOString().slice(0, 10);
    const end = new Date(billingPeriod.end).toISOString().slice(0, 10);
    const startDate = new Date(start), endDate = new Date(end);
    if ((endDate - startDate) > 31 * 86400000) startDate.setTime(endDate.getTime() - 31 * 86400000);
    return { start: startDate.toISOString().slice(0, 10), end: endDate.toISOString().slice(0, 10) };
  }
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  return { start: monthStart, end: today };
}

// ★ R2 日期范围：统一按当月（月初到今日）
// 因为 R2 免费额度是按月重置的，必须查看本月累计
function getR2DateRange() {
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  return { start: monthStart, end: now.toISOString().slice(0, 10) };
}

/* ============================================================
 * GraphQL 查询封装
 * ============================================================ */
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

/* ============================================================
 * KV 查询
 * ============================================================ */
async function fetchKvStorage(accountId, apiToken, namespaceId, dateRange) {
  if (!namespaceId) throw new Error('无法获取 KV Namespace ID，请在环境变量中配置 KV_NAMESPACE_ID');
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
  if (!namespaceId) return { read: 0, write: 0, delete: 0, list: 0 };
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
    let key = raw.includes('read') ? 'read' : raw.includes('write') || raw.includes('put') ? 'write' : raw.includes('delete') || raw.includes('remove') ? 'delete' : raw.includes('list') ? 'list' : raw;
    if (ops[key] !== undefined) ops[key] += Number(g.sum?.requests || 0);
  });
  return ops;
}

/* ============================================================
 * R2 查询
 * ============================================================ */
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

  const classA_actions = ['PutObject', 'CopyObject', 'ListObjects', 'ListObjectsV2', 'ListMultipartUploads', 'CreateMultipartUpload', 'UploadPart', 'CompleteMultipartUpload', 'AbortMultipartUpload'];
  const classB_actions = ['GetObject', 'HeadObject', 'HeadBucket', 'GetBucketLocation'];

  let classA = 0, classB = 0;
  groups.forEach(g => {
    const action = g.dimensions?.actionType || '';
    const count = Number(g.sum?.requests || 0);
    if (classA_actions.some(a => action.includes(a))) classA += count;
    else if (classB_actions.some(a => action.includes(a))) classB += count;
    else classB += count; // 其他未分类的操作统统归为 Class B
  });
  return { classA, classB };
}

/* ============================================================
 * D1 查询
 * ============================================================ */

/** D1 是否可用（与数据层同一判定口径）。 */
function isD1Enabled(env) {
  return Boolean(env && env.DB && typeof env.DB.prepare === 'function');
}

/**
 * 本地采集（**不需要任何 API 凭据**）。
 *
 * 数据库大小取自 D1 每次查询返回的 `meta.size_after` —— 这是 Cloudflare 官方
 * 的计费口径，比 GraphQL 里的存储指标更实时，也不要求配 database_id。
 * 表结构与行数直接用已有的 schemaStatus（只读，不触发迁移）。
 */
async function fetchD1Local(env) {
  let sizeBytes = null;
  try {
    // 任何查询都会带 size_after，用最轻的一条
    const res = await env.DB.prepare('SELECT 1 AS ok').run();
    const n = Number(res?.meta?.size_after);
    if (Number.isFinite(n) && n > 0) sizeBytes = n;
  } catch (e) {
    // size_after 拿不到不影响其余部分
  }

  let status = null;
  try {
    status = await schemaStatus(env, { counts: true });
  } catch (e) {
    status = { enabled: true, healthy: false, error: e.message || String(e) };
  }

  const rowsByTable = {};
  if (status?.counts) {
    for (const table of D1_BUSINESS_TABLES) {
      const n = status.counts[table];
      rowsByTable[table] = n == null ? null : Number(n);
    }
  }

  return {
    sizeBytes,
    rowsByTable,
    tableCount: D1_BUSINESS_TABLES.filter((t) => status?.tables?.[t]).length,
    expectedTableCount: D1_BUSINESS_TABLES.length,
    healthy: Boolean(status?.healthy),
    missingMigrations: status?.missing || [],
    error: status?.error || null,
  };
}

/**
 * 今日/本周期的行数读写（GraphQL）。只有它需要 D1_DATABASE_ID。
 */
async function fetchD1Analytics(accountId, apiToken, databaseId, dateRange) {
  if (!databaseId) throw new Error('未配置 D1_DATABASE_ID');
  const query = `
    query D1Analytics($accountTag: string!, $databaseId: string, $start: Date, $end: Date) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        d1AnalyticsAdaptiveGroups(
          filter: { databaseId: $databaseId, date_geq: $start, date_leq: $end }
          limit: 100
        ) { sum { readQueries writeQueries rowsRead rowsWritten } dimensions { date databaseId } }
      } }
    }`;
  const data = await gql(apiToken, query, {
    accountTag: accountId, databaseId, start: dateRange.start, end: dateRange.end
  });
  const groups = data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups || [];

  const totals = { rowsRead: 0, rowsWritten: 0, readQueries: 0, writeQueries: 0 };
  groups.forEach(g => {
    totals.rowsRead += Number(g.sum?.rowsRead || 0);
    totals.rowsWritten += Number(g.sum?.rowsWritten || 0);
    totals.readQueries += Number(g.sum?.readQueries || 0);
    totals.writeQueries += Number(g.sum?.writeQueries || 0);
  });
  return totals;
}

/* ============================================================
 * 主处理函数
 * ============================================================ */
export async function onRequestGet(context) {
  const { env } = context;
  const accountId = env.CF_ACCOUNT_ID;
  const apiToken = env.CF_API_TOKEN;

  const { r2Buckets, kvNamespaces } = detectBindings(env);
  const d1Enabled = isD1Enabled(env);

  const emptyD1 = { d1: null, d1Available: false };

  if (!kvNamespaces.length && !r2Buckets.length && !d1Enabled) {
    return Response.json({ success: false, configured: false, error: '未检测到 KV / R2 / D1 绑定，请检查 Pages 项目的绑定配置', plan: null, kv: null, r2: [], r2Available: false, ...emptyD1, date: '', resetAt: '' }, { status: 503 });
  }

  // 缺 API 凭据时，D1 的本地用量（存储大小 / 表行数）仍拿得到，所以不再整体 503。
  // 只有在「连 D1 都没有」时才维持原来的 503 行为。
  if (!accountId || !apiToken) {
    if (!d1Enabled) {
      return Response.json({ success: false, configured: true, error: '缺少 CF_ACCOUNT_ID 或 CF_API_TOKEN，无法查询用量数据', plan: null, kv: null, r2: [], r2Available: r2Buckets.length > 0, ...emptyD1, date: '', resetAt: '' }, { status: 503 });
    }
  }

  try {
    const plan = await detectPlan(env);
    const billingPeriod = plan.type === 'paid' ? await getBillingPeriod(env, plan) : null;
    
    // KV 使用原有的日/计费周期范围
    const dateRange = getDateRange(plan, billingPeriod);
    // ★ R2 强制使用“当月”范围，因为 R2 是按月重置额度的
    const r2DateRange = getR2DateRange();

    /* 1. 查询 KV 用量 */
    let kvResult = null;
    if (kvNamespaces.length > 0) {
      const kvBinding = kvNamespaces[0];
      if (!accountId || !apiToken) {
        kvResult = { binding: kvBinding.binding, error: '缺少 CF_ACCOUNT_ID 或 CF_API_TOKEN' };
      } else {
      try {
        const [kvStorage, kvOps] = await Promise.all([
          fetchKvStorage(accountId, apiToken, kvBinding.namespaceId, dateRange),
          fetchKvOperations(accountId, apiToken, kvBinding.namespaceId, dateRange)
        ]);
        const kvLimits = plan.limits.kv;
        kvResult = {
          binding: kvBinding.binding,
          storage: { usedBytes: kvStorage.byteCount, totalBytes: kvLimits.storageBytes, keyCount: kvStorage.keyCount, usagePercent: kvLimits.storageBytes ? (kvStorage.byteCount / kvLimits.storageBytes) * 100 : null },
          operations: {
            read:   { used: kvOps.read,   limit: kvLimits.reads,   remaining: Math.max(0, kvLimits.reads - kvOps.read) },
            write:  { used: kvOps.write,  limit: kvLimits.writes,  remaining: Math.max(0, kvLimits.writes - kvOps.write) },
            delete: { used: kvOps.delete, limit: kvLimits.deletes, remaining: Math.max(0, kvLimits.deletes - kvOps.delete) },
            list:   { used: kvOps.list,   limit: kvLimits.lists,   remaining: Math.max(0, kvLimits.lists - kvOps.list) }
          }
        };
      } catch (e) { kvResult = { binding: kvBinding.binding, error: e.message || 'KV 查询失败' }; }
      }
    }

    /* 2. 查询 R2 用量（按当月） */
    const r2Results = [];
    for (const r2 of r2Buckets) {
      if (!accountId || !apiToken) {
        r2Results.push({ binding: r2.binding, bucketName: r2.bucketName, source: r2.source, error: '缺少 CF_ACCOUNT_ID 或 CF_API_TOKEN' });
        continue;
      }
      try {
        const [r2Storage, r2Ops] = await Promise.all([
          fetchR2Storage(accountId, apiToken, r2.bucketName, r2DateRange),
          fetchR2Operations(accountId, apiToken, r2.bucketName, r2DateRange)
        ]);
        const r2Limits = plan.limits.r2;
        r2Results.push({
          binding: r2.binding, bucketName: r2.bucketName, source: r2.source,
          storage: { 
            usedBytes: r2Storage.payloadSize + r2Storage.metadataSize, 
            payloadSize: r2Storage.payloadSize, 
            metadataSize: r2Storage.metadataSize, 
            objectCount: r2Storage.objectCount, 
            uploadCount: r2Storage.uploadCount, 
            totalBytes: r2Limits.storageBytes, 
            usagePercent: r2Limits.storageBytes ? ((r2Storage.payloadSize + r2Storage.metadataSize) / r2Limits.storageBytes) * 100 : null 
          },
          operations: { 
            classA: { used: r2Ops.classA, limit: r2Limits.classA, remaining: r2Limits.classA ? Math.max(0, r2Limits.classA - r2Ops.classA) : null }, 
            classB: { used: r2Ops.classB, limit: r2Limits.classB, remaining: r2Limits.classB ? Math.max(0, r2Limits.classB - r2Ops.classB) : null } 
          }
        });
      } catch (e) { 
        r2Results.push({ binding: r2.binding, bucketName: r2.bucketName, source: r2.source, error: e.message || 'R2 查询失败' }); 
      }
    }

    /* 3. 查询 D1 用量（存储/行数本地拿，读写行数走 GraphQL） */
    let d1Result = null;
    if (d1Enabled) {
      const d1Limits = plan.limits.d1;
      const local = await fetchD1Local(env);

      let analytics = null;
      let analyticsError = null;
      if (!accountId || !apiToken) {
        analyticsError = '缺少 CF_ACCOUNT_ID 或 CF_API_TOKEN，无法显示读写行数';
      } else if (!env.D1_DATABASE_ID) {
        analyticsError = '未配置 D1_DATABASE_ID，无法显示读写行数（存储用量不受影响）';
      } else {
        try {
          analytics = await fetchD1Analytics(accountId, apiToken, env.D1_DATABASE_ID, dateRange);
        } catch (e) {
          analyticsError = e.message || 'D1 用量查询失败';
        }
      }

      const usedBytes = local.sizeBytes || 0;
      d1Result = {
        binding: 'DB',
        storage: {
          usedBytes,
          totalBytes: d1Limits.storageBytes,
          usagePercent: d1Limits.storageBytes ? (usedBytes / d1Limits.storageBytes) * 100 : null,
          sizeEstimated: local.sizeBytes == null, // 拿不到 size_after 时标出来，别当成 0
          rowsByTable: local.rowsByTable,
          tableCount: local.tableCount,
          expectedTableCount: local.expectedTableCount,
        },
        // 读写行数：免费按日、付费按月，与 dateRange 一致
        operations: analytics ? {
          rowsRead:    { used: analytics.rowsRead,    limit: d1Limits.rowsRead,    remaining: Math.max(0, d1Limits.rowsRead - analytics.rowsRead) },
          rowsWritten: { used: analytics.rowsWritten, limit: d1Limits.rowsWritten, remaining: Math.max(0, d1Limits.rowsWritten - analytics.rowsWritten) }
        } : null,
        queries: analytics ? { read: analytics.readQueries, write: analytics.writeQueries } : null,
        rowsSource: analytics ? 'graphql' : null,
        analyticsError,
        schema: { healthy: local.healthy, missing: local.missingMigrations, error: local.error },
      };
    }

    const resetLabel = plan.type === 'free' 
      ? 'KV 每日 00:00 UTC 重置 · R2 按月重置 · D1 每日 00:00 UTC 重置' 
      : (billingPeriod ? `KV 计费周期 ${billingPeriod.start} 至 ${billingPeriod.end}，超出按量付费 · R2 按月计费 · D1 按月计费` : 'KV 按月计费，超出按量付费 · R2 按月计费 · D1 按月计费');

    return Response.json({ 
      success: true, 
      configured: true, 
      plan: { type: plan.type, typeLabel: plan.type === 'paid' ? '付费计划' : '免费计划', resetType: plan.limits.resetType, fromCache: plan.fromCache, detectionError: plan.error, billingPeriod }, 
      kv: kvResult, 
      r2: r2Results, 
      r2Available: r2Buckets.length > 0, 
      r2Source: r2Buckets.length > 0 ? r2Buckets[0].source : null, 
      d1: d1Result,
      d1Available: d1Enabled,
      date: `${r2DateRange.start} ~ ${r2DateRange.end}`, 
      resetAt: resetLabel 
    });
  } catch (e) {
    return Response.json({ success: false, configured: true, error: e.message || '查询异常', plan: null, kv: null, r2: [], r2Available: false, d1: null, d1Available: false, date: '', resetAt: '' }, { status: 500 });
  }
}