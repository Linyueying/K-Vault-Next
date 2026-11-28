/**
 * GET /api/admin/db-status —— D1 部署自检端点。
 *
 * 鉴权：由 `functions/api/admin/_middleware.js` 统一把关（fail closed），
 * 未配置 BASIC_USER/BASIC_PASS 时直接 503，不会匿名暴露。
 *
 * 用途：部署后打开这一个地址就能确认「D1 绑上了没、表建齐没、有几个迁移没跑」，
 * 不用去翻 Workers 日志，也不用手动执行 SQL。
 *
 * 查询参数：
 *   ?apply=1    强制重跑迁移（忽略 module-level 缓存）。部署后想立刻建表时用
 *   ?counts=0   跳过行数统计（表很大时更快）
 *
 * 只返回结构与计数，**不返回任何文件元数据**，避免信息泄露。
 */
import { ensureSchema, resetSchemaCache, schemaStatus, MIGRATIONS } from '../../utils/schema.js';
import { apiError, apiSuccess } from '../../utils/api-v1.js';

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }
  if (request.method !== 'GET') {
    return apiError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405);
  }

  const url = new URL(request.url);
  const apply = url.searchParams.get('apply') === '1';
  const counts = url.searchParams.get('counts') !== '0';

  let migration = null;
  if (apply && env?.DB) {
    // 强制重跑：清缓存 → 触发懒迁移。幂等，重复调用无害。
    resetSchemaCache();
    migration = await ensureSchema(env);
  }

  let status;
  try {
    status = await schemaStatus(env, { counts });
  } catch (error) {
    return apiError(
      'DB_STATUS_FAILED',
      `读取 D1 状态失败: ${error?.message || String(error)}`,
      500
    );
  }

  return apiSuccess({
    d1: status,
    migrations: {
      known: MIGRATIONS.map((m) => m.id),
      appliedNow: migration?.applied || [],
      error: migration?.error || null,
    },
    // 一句话结论，方便人眼看
    verdict: verdictFor(status),
  });
}

function verdictFor(status) {
  if (!status.enabled) {
    return 'D1 未绑定 —— 当前完全走 KV，功能不受影响，但 SQL 分页 / 原子计数未生效。';
  }
  if (status.error) {
    return `D1 异常：${status.error}`;
  }
  if (status.missing.length > 0) {
    return `迁移未跑完，缺 ${status.missing.join(', ')} —— 带 ?apply=1 再访问一次可立即补齐。`;
  }
  if (!status.healthy) {
    return '迁移记录齐全但表/列有缺失，请检查 D1。';
  }
  return 'D1 已就绪，表与迁移均完整。';
}
