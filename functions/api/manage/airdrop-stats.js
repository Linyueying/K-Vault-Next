/**
 * 隔空投送 —— 管理后台使用情况
 *
 *   GET    /api/manage/airdrop-stats?days=7   → 用量统计（概览 / 按天 / 最近记录）
 *   DELETE /api/manage/airdrop-stats          → 清空历史统计
 *
 * 鉴权由 api/manage/_middleware.js 统一兜底，这里不再重复校验。
 */
import { getAirdropConfig } from '../../utils/runtime-config.js';
import { getUsageStats, clearStats, resolveBackend, jsonResponse } from '../../utils/airdrop.js';

export async function onRequestGet(context) {
  const { request, env } = context;

  if (!env?.DB || typeof env.DB.prepare !== 'function') {
    return jsonResponse({ error: '未绑定 D1，无法读取隔空投送统计。', code: 'NO_D1' }, 503);
  }

  const days = Number(new URL(request.url).searchParams.get('days') || 7);

  // 统计查询与「中转节点探测」及「当前配置」彼此独立：
  // 统计查不出来（例如迁移未跑），不该连累 backend / config 一起 500 ——
  // 否则后台会把「统计暂时读不到」误显示成「没有绑定 R2 或 Telegram」。
  let stats = null;
  let statsError = '';
  try {
    stats = await getUsageStats(env, days);
  } catch (error) {
    console.error('Airdrop stats error:', error);
    statsError = error?.message || '读取统计失败';
  }

  const cfg = await getAirdropConfig(env);
  const backend = resolveBackend(env);
  return jsonResponse({
    success: true,
    stats,
    statsError,
    config: {
      enabled: cfg.enabled,
      guestAllowed: cfg.guestAllowed,
      guestReceiveAllowed: cfg.guestReceiveAllowed,
      maxFileSize: cfg.maxFileSize,
      dailyLimit: cfg.dailyLimit,
      ttlMinutes: cfg.ttlMinutes,
      source: cfg.source
    },
    backend: { name: backend.backend, label: backend.label, maxBytes: backend.maxBytes }
  });
}

export async function onRequestDelete(context) {
  const { env } = context;
  if (!env?.DB || typeof env.DB.prepare !== 'function') {
    return jsonResponse({ error: '未绑定 D1，无法清空统计。', code: 'NO_D1' }, 503);
  }
  try {
    await clearStats(env);
    return jsonResponse({ success: true });
  } catch (error) {
    console.error('Airdrop stats clear error:', error);
    return jsonResponse({ error: error?.message || '清空统计失败' }, 500);
  }
}
