/**
 * GET /api/manage/kv-usage
 * 查询当前 KV 命名空间的存储用量与操作次数，并根据账户计划自动调整限额。
 *
 * 依赖环境变量：
 *   CF_ACCOUNT_ID     - Cloudflare 账户 ID
 *   CF_API_TOKEN      - API Token（需 Workers KV Storage:Read + Account Settings:Read）
 *   KV_NAMESPACE_ID   - KV 命名空间 ID
 */

/* ============================================================
 * 计划限额配置
 * 免费计划：每日 00:00 UTC 重置
 * 付费计划：按月计费，超出部分按量付费
 * ============================================================ */
const PLAN_LIMITS = {
  free: {
    storageBytes: 1 * 1024 * 1024 * 1024,       // 1 GB
    reads:   100000,
    writes:  1000,
    deletes: 1000,
    lists:   1000,
    resetType: 'daily'
  },
  paid: {
    storageBytes: null,                           // 付费计划存储不设硬上限
    reads:   10000000,                            // 10M / 月
    writes:  1000000,                             // 1M / 月
    deletes: 1000000,                             // 1M / 月
    lists:   1000000,                             // 1M / 月
    resetType: 'monthly'
  }
};

/* ============================================================
 * 缓存配置
 * ============================================================ */
const CACHE_KEYS = {
  plan:    'kv-usage:config:plan',
  billing: 'kv-usage:config:billing_period'
};

const CACHE_TTL = {
  plan:    86400,        // 24 小时
  billing: 32 * 86400    // 32 天
};

/* ============================================================
 * 工具函数：从 KV 缓存读取（带容错）
 * ============================================================ */
async function cacheGet(env, key) {
  try {
    return await env.KV.get(key, { type: 'json' });
  } catch (e) {
    return null;
  }
}

async function cachePut(env, key, value, expirationTtl) {
  try {
    await env.KV.put(key, JSON.stringify(value), { expirationTtl });
  } catch (e) {
    // 缓存写入失败不影响主流程
  }
}

/* ============================================================
 * 计划检测
 * 调用 Subscriptions API，查找 rate_plan.id === 'workers_paid'
 * 且 scope === 'account' 的订阅。
 * 检测失败时回退到免费计划（保守策略，避免超额风险）。
 * ============================================================ */
async function detectPlan(env) {
  const accountId = env.CF_ACCOUNT_ID;
  const apiToken  = env.CF_API_TOKEN;

  /* 1. 尝试从缓存读取 */
  const cached = await cacheGet(env, CACHE_KEYS.plan);
  if (cached && cached.type) {
    return {
      type: cached.type,
      limits: PLAN_LIMITS[cached.type],
      fromCache: true,
      error: null
    };
  }

  /* 2. 缓存未命中，调用 Subscriptions API */
  try {
    const resp = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/subscriptions`,
      {
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const data = await resp.json();

    if (!resp.ok || !data.success) {
      throw new Error(data.errors?.[0]?.message || `HTTP ${resp.status}`);
    }

    const subs = Array.isArray(data.result) ? data.result : [];

    /* 查找 Workers Paid 订阅 */
    const paidSub = subs.find(s =>
      s.rate_plan?.id === 'workers_paid' && s.rate_plan?.scope === 'account'
    );

    const planType = paidSub ? 'paid' : 'free';

    /* 3. 提取计费周期（仅付费计划有） */
    let billingPeriod = null;
    if (paidSub && paidSub.current_period_start && paidSub.current_period_end) {
      billingPeriod = {
        start: paidSub.current_period_start,
        end:   paidSub.current_period_end
      };
      await cachePut(env, CACHE_KEYS.billing, billingPeriod, CACHE_TTL.billing);
    }

    /* 4. 缓存计划类型 */
    await cachePut(env, CACHE_KEYS.plan, { type: planType }, CACHE_TTL.plan);

    return {
      type: planType,
      limits: PLAN_LIMITS[planType],
      billingPeriod,
      fromCache: false,
      error: null
    };

  } catch (e) {
    /* 回退到免费计划（保守策略，避免超额风险） */
    return {
      type: 'free',
      limits: PLAN_LIMITS.free,
      billingPeriod: null,
      fromCache: false,
      error: e.message || '计划检测失败，已回退到免费计划'
    };
  }
}

/* ============================================================
 * 获取计费周期（用于付费计划的月度用量对齐）
 * ============================================================ */
async function getBillingPeriod(env, plan) {
  /* 优先使用内存中的计费周期 */
  if (plan.billingPeriod) return plan.billingPeriod;

  /* 其次从缓存读取 */
  const cached = await cacheGet(env, CACHE_KEYS.billing);
  if (cached && cached.start && cached.end) return cached;

  return null;
}

/* ============================================================
 * 计算统计日期范围
 * 免费计划：当日
 * 付费计划：当前计费周期（或当月）
 * ============================================================ */
function getDateRange(plan, billingPeriod) {
  const today = new Date().toISOString().slice(0, 10);

  if (plan.type === 'free' || plan.limits.resetType === 'daily') {
    return { start: today, end: today };
  }

  /* 付费计划：使用计费周期 */
  if (billingPeriod && billingPeriod.start) {
    const start = new Date(billingPeriod.start).toISOString().slice(0, 10);
    const end   = new Date(billingPeriod.end).toISOString().slice(0, 10);
    /* 限制在 Analytics API 的 31 天保留期内 */
    const startDate = new Date(start);
    const endDate   = new Date(end);
    if ((endDate - startDate) > 31 * 86400000) {
      /* 如果计费周期超过 31 天，只取最近 31 天 */
      startDate.setTime(endDate.getTime() - 31 * 86400000);
    }
    return {
      start: startDate.toISOString().slice(0, 10),
      end: endDate.toISOString().slice(0, 10)
    };
  }

  /* 回退到当月 */
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  return { start: monthStart, end: today };
}

/* ============================================================
 * GraphQL 查询：存储用量
 * ============================================================ */
async function fetchStorageUsage(accountId, apiToken, namespaceId, dateRange) {
  const query = `
    query KvStorage($accountTag: string!, $namespaceId: string, $start: Date, $end: Date) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          kvStorageAdaptiveGroups(
            filter: { date_geq: $start, date_leq: $end, namespaceId: $namespaceId }
            limit: 1
            orderBy: [date_DESC]
          ) {
            max { keyCount byteCount }
            dimensions { date }
          }
        }
      }
    }`;

  const resp = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query,
      variables: {
        accountTag: accountId,
        namespaceId: namespaceId,
        start: dateRange.start,
        end: dateRange.end
      }
    })
  });

  const data = await resp.json();
  if (data.errors) {
    throw new Error(data.errors[0]?.message || '存储用量查询失败');
  }

  const groups = data.data?.viewer?.accounts?.[0]?.kvStorageAdaptiveGroups || [];
  const latest = groups[0]?.max || { keyCount: 0, byteCount: 0 };
  return {
    keyCount: Number(latest.keyCount || 0),
    byteCount: Number(latest.byteCount || 0)
  };
}

/* ============================================================
 * GraphQL 查询：操作次数
 * ============================================================ */
async function fetchOperations(accountId, apiToken, namespaceId, dateRange) {
  const query = `
    query KvOps($accountTag: string!, $namespaceId: string, $start: Date, $end: Date) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          kvOperationsAdaptiveGroups(
            filter: { namespaceId: $namespaceId, date_geq: $start, date_leq: $end }
            limit: 100
          ) {
            sum { requests }
            dimensions { actionType }
          }
        }
      }
    }`;

  const resp = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      query,
      variables: {
        accountTag: accountId,
        namespaceId: namespaceId,
        start: dateRange.start,
        end: dateRange.end
      }
    })
  });

  const data = await resp.json();
  if (data.errors) {
    throw new Error(data.errors[0]?.message || '操作次数查询失败');
  }

  const groups = data.data?.viewer?.accounts?.[0]?.kvOperationsAdaptiveGroups || [];

  /* 初始化操作计数器，兼容多种 actionType 命名 */
  const ops = { read: 0, write: 0, delete: 0, list: 0 };

  groups.forEach(g => {
    const raw = String(g.dimensions?.actionType || '').toLowerCase();
    /* 兼容 read/read_key/readKey 等写法 */
    let key = raw;
    if (raw.includes('read'))   key = 'read';
    else if (raw.includes('write') || raw.includes('put')) key = 'write';
    else if (raw.includes('delete') || raw.includes('remove')) key = 'delete';
    else if (raw.includes('list'))  key = 'list';

    if (ops[key] !== undefined) {
      ops[key] += Number(g.sum?.requests || 0);
    }
  });

  return ops;
}

/* ============================================================
 * 主处理函数
 * ============================================================ */
export async function onRequestGet(context) {
  const { env, request } = context;

  const accountId = env.CF_ACCOUNT_ID;
  const apiToken  = env.CF_API_TOKEN;
  const nsId      = env.KV_NAMESPACE_ID || env.KV_NAMESPACE;

  /* 环境变量校验 */
  if (!accountId || !apiToken || !nsId) {
    return Response.json({
      success: false,
      configured: false,
      error: '缺少环境变量 CF_ACCOUNT_ID / CF_API_TOKEN / KV_NAMESPACE_ID',
      plan: null,
      storage: null,
      operations: null,
      date: '',
      resetAt: ''
    }, { status: 503 });
  }

  try {
    /* 1. 检测计划类型（带缓存，24 小时 TTL） */
    const plan = await detectPlan(env);

    /* 2. 获取计费周期（付费计划用于月度用量对齐） */
    const billingPeriod = plan.type === 'paid'
      ? await getBillingPeriod(env, plan)
      : null;

    /* 3. 计算统计日期范围 */
    const dateRange = getDateRange(plan, billingPeriod);

    /* 4. 并行查询存储用量和操作次数 */
    const [storage, ops] = await Promise.all([
      fetchStorageUsage(accountId, apiToken, nsId, dateRange),
      fetchOperations(accountId, apiToken, nsId, dateRange)
    ]);

    /* 5. 根据计划类型计算剩余额度 */
    const limits = plan.limits;

    /* 存储用量：付费计划存储不设硬上限，仅展示已用大小 */
    const storageResult = {
      usedBytes: storage.byteCount,
      totalBytes: limits.storageBytes,              // 付费计划为 null
      keyCount: storage.keyCount,
      usagePercent: limits.storageBytes
        ? (storage.byteCount / limits.storageBytes) * 100
        : null                                       // 付费计划不计算百分比
    };

    /* 操作次数：根据计划类型选择日限额或月限额 */
    const operationsResult = {
      read: {
        used: ops.read,
        limit: limits.reads,
        remaining: Math.max(0, limits.reads - ops.read)
      },
      write: {
        used: ops.write,
        limit: limits.writes,
        remaining: Math.max(0, limits.writes - ops.write)
      },
      delete: {
        used: ops.delete,
        limit: limits.deletes,
        remaining: Math.max(0, limits.deletes - ops.delete)
      },
      list: {
        used: ops.list,
        limit: limits.lists,
        remaining: Math.max(0, limits.lists - ops.list)
      }
    };

    /* 6. 构建返回结果 */
    const resetLabel = plan.type === 'free'
      ? '每日 00:00 UTC 重置'
      : (billingPeriod
          ? `计费周期 ${billingPeriod.start} 至 ${billingPeriod.end}，超出按量付费`
          : '按月计费，超出按量付费');

    return Response.json({
      success: true,
      configured: true,
      plan: {
        type: plan.type,                             // 'free' | 'paid'
        typeLabel: plan.type === 'paid' ? '付费计划' : '免费计划',
        resetType: limits.resetType,                 // 'daily' | 'monthly'
        fromCache: plan.fromCache,
        detectionError: plan.error,                  // 检测失败时的错误信息
        billingPeriod: billingPeriod
      },
      storage: storageResult,
      operations: operationsResult,
      date: `${dateRange.start} ~ ${dateRange.end}`,
      resetAt: resetLabel
    });

  } catch (e) {
    return Response.json({
      success: false,
      configured: true,
      error: e.message || '查询异常',
      plan: null,
      storage: null,
      operations: null,
      date: '',
      resetAt: ''
    }, { status: 500 });
  }
}