/**
 * 隔空投送能力下发测试：未登录（访客）也必须拿到「能不能用」的答案。
 *
 * ============================================================================
 * 为什么这个套件存在
 * ============================================================================
 *
 * 缺陷现场：未登录用户扫二维码接收授权用户发起的投送，页面先弹
 * 「没有可用储存节点」。房间与中转节点都正常，真正的原因是
 * /api/auth/check 对未登录请求**完全不下发** airdrop 能力，前端只能退回
 * 初始值 `{enabled:false, nodes:[]}`，入口遂把「未知」当成「没配节点」。
 *
 * 因此这里断言的不是某个 UI 文案，而是**契约**：只要站点配了中转节点且
 * 功能开启，未登录请求也必须看到 `airdrop.enabled === true` 与非空 nodes，
 * 否则收端连入口都过不去。
 *
 * 同时守住另一半：访客拿到的必须是**最小集合** —— 房间 TTL、每日限额、
 * 访客上传配额继续隐藏，不能因为修一个入口问题就把 dashboard 侧写
 * 顺手递给匿名访问者。
 *
 * 运行：node scripts/test-airdrop-capability.mjs
 */
import { onRequestGet } from '../functions/api/auth/check.js';
import { invalidateRuntimeConfigCache } from '../functions/utils/runtime-config.js';

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/** 带最小读写能力的 KV 替身（配置读取用） */
function makeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(key, opts) {
      if (!store.has(key)) return null;
      const value = store.get(key);
      if (opts?.type === 'json') return value;
      return typeof value === 'string' ? value : JSON.stringify(value);
    },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
}

const R2_BUCKET = {
  put: async () => {},
  get: async () => null,
  delete: async () => {},
};

function makeEnv(extra = {}) {
  return {
    img_url: makeKv(),
    R2_BUCKET,
    BASIC_USER: 'admin',
    BASIC_PASS: 'secret',
    ...extra,
  };
}

/** 未登录请求：不带 Cookie / Authorization */
async function callCheck(env, headers = {}) {
  const request = new Request('https://x.test/api/auth/check', { method: 'GET', headers });
  const res = await onRequestGet({ request, env });
  return { status: res.status, body: await res.json() };
}

// ============================================================================
console.log('[1] 未登录：必须拿到可用的 airdrop 能力（本次缺陷的核心契约）');
{
  const { status, body } = await callCheck(makeEnv());
  check('[1] 未登录仍返回 200', status === 200, String(status));
  check('[1] authenticated=false', body.authenticated === false);
  check('[1] ★ 下发 airdrop 字段', Boolean(body.airdrop), JSON.stringify(body));
  check('[1] ★ enabled=true（有 R2 节点、功能默认开启）', body.airdrop?.enabled === true,
    String(body.airdrop?.enabled));
  check('[1] ★ nodes 非空且含 r2', Array.isArray(body.airdrop?.nodes)
    && body.airdrop.nodes.some((n) => n.key === 'r2'),
    JSON.stringify(body.airdrop?.nodes));
  check('[1] 收端默认放行访客（guestReceiveAllowed=true）',
    body.airdrop?.guestReceiveAllowed === true, String(body.airdrop?.guestReceiveAllowed));
  check('[1] 发端默认拒绝访客（guestAllowed=false）',
    body.airdrop?.guestAllowed === false, String(body.airdrop?.guestAllowed));
}

// ============================================================================
console.log('[2] 未登录：运营参数仍然隐藏（最小暴露面）');
{
  const { body } = await callCheck(makeEnv());
  check('[2] ★ 不下发房间 TTL', !('ttlMinutes' in (body.airdrop || {})), JSON.stringify(body.airdrop));
  check('[2] ★ 不下发 maxFileSize', !('maxFileSize' in (body.airdrop || {})));
  check('[2] ★ 不下发 dailyLimit', !('dailyLimit' in (body.airdrop || {})));
  check('[2] ★ 不下发访客上传配额 guestUpload', !('guestUpload' in body), JSON.stringify(body));
  check('[2] 不泄露认证来源 reason', !('reason' in body));
}

// ============================================================================
console.log('[3] 未登录：没有节点时 enabled=false（真实不可用仍要如实告知）');
{
  const env = makeEnv({ R2_BUCKET: undefined });
  const { status, body } = await callCheck(env);
  check('[3] 仍返回 200', status === 200, String(status));
  check('[3] ★ enabled=false', body.airdrop?.enabled === false, String(body.airdrop?.enabled));
  check('[3] ★ nodes 为空数组（前端据此判"缺节点"，这次是真缺）',
    Array.isArray(body.airdrop?.nodes) && body.airdrop.nodes.length === 0,
    JSON.stringify(body.airdrop?.nodes));
}

// ============================================================================
console.log('[4] 未登录：后台关闭「访客接收」时该位如实下发');
{
  const env = makeEnv();
  await env.img_url.put('config:airdrop', {
    enabled: true,
    guestAllowed: false,
    guestReceiveAllowed: false,
    ttlMinutes: 5,
    dailyLimit: 50,
    maxFileSize: 100 * 1024 * 1024,
    statsRetention: 500,
  });
  // runtime-config 有模块级缓存，跨用例必须显式失效，否则读到上一条配置
  invalidateRuntimeConfigCache();
  const { body } = await callCheck(env);
  check('[4] ★ guestReceiveAllowed=false 透传给访客',
    body.airdrop?.guestReceiveAllowed === false, String(body.airdrop?.guestReceiveAllowed));
  check('[4] enabled 仍为 true（开关与访客权限是两件事）', body.airdrop?.enabled === true);
}

// ============================================================================
console.log('[5] 已登录：完整能力（运营参数照常下发）');
{
  const env = makeEnv();
  // 清掉 [4] 写进缓存的那份「访客接收已关闭」配置
  invalidateRuntimeConfigCache();
  const headers = { Authorization: 'Basic ' + btoa('admin:secret') };
  const { status, body } = await callCheck(env, headers);
  check('[5] 已登录返回 200', status === 200, String(status));
  check('[5] authenticated=true', body.authenticated === true);
  check('[5] ★ 已登录仍带 ttlMinutes', Number(body.airdrop?.ttlMinutes) > 0,
    String(body.airdrop?.ttlMinutes));
  check('[5] 已登录带 guestUpload（访客配额）', Boolean(body.guestUpload));
}

// ============================================================================
console.log('[6] 未开认证的开放实例：能力照常完整下发');
{
  const env = { img_url: makeKv(), R2_BUCKET };
  const { body } = await callCheck(env);
  check('[6] authenticated=true（无需登录）', body.authenticated === true);
  check('[6] airdrop.enabled=true', body.airdrop?.enabled === true);
  check('[6] 开放实例仍下发 ttlMinutes', Number(body.airdrop?.ttlMinutes) > 0);
}

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
if (fail > 0) process.exit(1);
