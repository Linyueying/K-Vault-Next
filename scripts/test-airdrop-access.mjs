/**
 * 隔空投送门禁测试：发送权与接收权的拆分。
 *
 * ============================================================================
 * 为什么这个套件值得单独存在
 * ============================================================================
 *
 * 这里防的是一个**已经发生过一次**的缺陷：收端加入房间时复用了发端门禁，
 * 于是 `guestAllowed`（"访客能否发起"，缺省 false）把访客的**接收**也一并
 * 拦死了 —— 表现是"授权用户开好房间、访客扫码却收不了文件"。
 *
 * 这类缺陷的特点是**功能测试全绿也发现不了**：create/join 的代码路径都
 * 没报错，只是 join 回了 401。而且它与一个极易写错的默认值耦合：
 *   · guestAllowed        缺省 false（缺省即封闭）
 *   · guestReceiveAllowed 缺省 true （缺省即放行）
 * 两者方向相反，一旦某处 fallback 写反，就是静默的"能收"变"不能收"。
 *
 * 所以本套件重点断言三件事：
 *   [1] 老 KV 配置（没有 guestReceiveAllowed 字段）读出来必须是 true
 *   [2] 收端门禁对访客放行；发端门禁对访客仍然拦
 *   [3] 收端门禁仍受总开关与节点可用性约束（放行不等于不设防）
 *
 * 运行：node scripts/test-airdrop-access.mjs
 */
import {
  normalizeAirdropConfig,
  readAirdropConfigFromEnv,
  getRuntimeConfig,
  invalidateRuntimeConfigCache,
  DEFAULT_AIRDROP_GUEST_RECEIVE_ALLOWED,
  AIRDROP_CONFIG_KEY,
} from '../functions/utils/runtime-config.js';
import {
  checkAirdropAccess,
  checkAirdropReceiveAccess,
} from '../functions/utils/airdrop.js';

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
};

/**
 * 带读写计数的 KV 替身（与 test-runtime-config.mjs 同构）。
 *
 * ⚠️ `get` 的序列化要跟真实 KV 对齐：配置类是**对象**（后台 put 的是
 * JSON 字符串、读时用 type:'json' 解析），而限流计数类是**纯字符串**
 * （incrementDailyCount 直接 put 的 `String(n)`，读时 parseInt）。
 * 若无差别地 JSON.stringify 所有值，计数会变成 `"999"`（带引号），
 * parseInt 得 NaN → 计数器永远读回 0，测试就会误判成"额度没生效"。
 */
function makeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    _store: store,
    async get(key, opts) {
      if (!store.has(key)) return null;
      const value = store.get(key);
      if (opts?.type === 'json') return value;
      // 字符串原样返回（计数类），其余按 JSON 序列化（对象类）
      return typeof value === 'string' ? value : JSON.stringify(value);
    },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
}

/**
 * 构造一个"功能可用"的最小 env：
 *   · img_url  KV  —— 配置读取需要
 *   · R2_BUCKET    —— 提供至少一个可用中转节点（availableBackends 据此判定）
 *   · BASIC_USER/PASS —— isAuthRequired=true，这样访客判定才会真正生效
 *      （若站点未开认证，isGuestRequest 一律返回 false，"访客"概念不存在）
 */
function makeEnv(extra = {}) {
  return {
    img_url: makeKv(),
    R2_BUCKET: { put: async () => {}, get: async () => null, delete: async () => {} },
    BASIC_USER: 'admin',
    BASIC_PASS: 'secret',
    ...extra,
  };
}

/** 一个不带任何凭证的请求 = 访客请求 */
function guestRequest() {
  return new Request('https://x.test/api/airdrop/join', { method: 'POST' });
}

// ============================================================================
console.log('[1] normalizeAirdropConfig：缺省与回落方向');
{
  // ★ 核心回归点：老 KV 记录没有这个字段，必须回落 true
  const legacy = normalizeAirdropConfig(
    { enabled: true, guestAllowed: false },
    readAirdropConfigFromEnv({})
  );
  check('[1] ★ 老配置（无 guestReceiveAllowed）回落 true', legacy.guestReceiveAllowed === true,
    String(legacy.guestReceiveAllowed));
  check('[1] guestAllowed 仍按缺省 false 回落', legacy.guestAllowed === false,
    String(legacy.guestAllowed));

  // 无 fallback 参数时的内部 base 也必须是 true
  const bare = normalizeAirdropConfig({});
  check('[1] 无 fallback 时 guestReceiveAllowed 也是 true', bare.guestReceiveAllowed === true,
    String(bare.guestReceiveAllowed));

  // 显式布尔能关闭 / 开启
  check('[1] 显式 false 能关闭',
    normalizeAirdropConfig({ guestReceiveAllowed: false }, {}).guestReceiveAllowed === false);
  check('[1] 显式 true 能开启',
    normalizeAirdropConfig({ guestReceiveAllowed: true }, {}).guestReceiveAllowed === true);

  // 字符串 'false' 也应被 toBool 识别（KV 里存 JSON 布尔、env 里是字符串）
  check('[1] 字符串 "false" 能关闭',
    normalizeAirdropConfig({ guestReceiveAllowed: 'false' }, {}).guestReceiveAllowed === false,
    String(normalizeAirdropConfig({ guestReceiveAllowed: 'false' }, {}).guestReceiveAllowed));

  // 非法值（数字 / null）不该把默认 true 顶掉。
  // 注意：fallback 要传 **falsey**（或省略）才会走到内部默认 base ——
  // 传 `{}` 的话 base 就是那个空对象，字段全为 undefined，测的不是这件事。
  check('[1] 数字 0 不当作 false（回落 base=true）',
    normalizeAirdropConfig({ guestReceiveAllowed: 0 }).guestReceiveAllowed === true,
    String(normalizeAirdropConfig({ guestReceiveAllowed: 0 }).guestReceiveAllowed));
  check('[1] null 回落 true',
    normalizeAirdropConfig({ guestReceiveAllowed: null }).guestReceiveAllowed === true,
    String(normalizeAirdropConfig({ guestReceiveAllowed: null }).guestReceiveAllowed));

  check('[1] 默认值常量为 true', DEFAULT_AIRDROP_GUEST_RECEIVE_ALLOWED === true);
}

// ============================================================================
console.log('[2] 环境变量基线');
{
  const dflt = readAirdropConfigFromEnv({});
  check('[2] 缺省 guestReceiveAllowed=true', dflt.guestReceiveAllowed === true,
    String(dflt.guestReceiveAllowed));
  check('[2] 缺省 guestAllowed=false（方向相反）', dflt.guestAllowed === false);
  check('[2] 缺省 enabled=true', dflt.enabled === true);

  const off = readAirdropConfigFromEnv({ AIRDROP_GUEST_RECEIVE_ALLOWED: 'false' });
  check('[2] 显式 env "false" 关闭', off.guestReceiveAllowed === false);
  const on = readAirdropConfigFromEnv({ AIRDROP_GUEST_RECEIVE_ALLOWED: 'true' });
  check('[2] 显式 env "true" 开启', on.guestReceiveAllowed === true);
  // 只认字面量，别把 '1' / 'yes' 当 true（与全站 toBool 口径一致）
  const weird = readAirdropConfigFromEnv({ AIRDROP_GUEST_RECEIVE_ALLOWED: 'yes' });
  check('[2] 非字面量 "yes" 不当作 true（回落默认 true）', weird.guestReceiveAllowed === true,
    String(weird.guestReceiveAllowed));
}

// ============================================================================
console.log('[3] 经 KV 读取（真实链路：normalize(stored, fromEnv)）');
{
  invalidateRuntimeConfigCache();
  // KV 里存一条"老格式"配置（前端后台保存时还没有这个字段）
  const env = makeEnv();
  env.img_url._store.set(AIRDROP_CONFIG_KEY, {
    enabled: true, guestAllowed: false, maxFileSize: 104857600,
    dailyLimit: 50, ttlMinutes: 30,
  });
  const cfg = await getRuntimeConfig(env, 'airdrop');
  check('[3] ★ KV 老记录经完整链路仍读到 true', cfg.guestReceiveAllowed === true,
    JSON.stringify(cfg));
  check('[3] 且 source 标记为 kv', cfg.source === 'kv', cfg.source);

  // KV 里显式存 false，应能覆盖并关闭
  invalidateRuntimeConfigCache();
  env.img_url._store.set(AIRDROP_CONFIG_KEY, { guestReceiveAllowed: false });
  const cfg2 = await getRuntimeConfig(env, 'airdrop');
  check('[3] KV 显式 false 能关闭', cfg2.guestReceiveAllowed === false);
  invalidateRuntimeConfigCache();
}

// ============================================================================
console.log('[4] checkAirdropReceiveAccess：收端门禁（本次修复的核心）');
{
  invalidateRuntimeConfigCache();
  const env = makeEnv({ AIRDROP_ENABLED: 'true' });
  invalidateRuntimeConfigCache();

  const gate = await checkAirdropReceiveAccess(guestRequest(), env);
  check('[4] ★ 访客可以加入房间（不再 401）', gate.allowed === true,
    JSON.stringify(gate));
  check('[4] 且被正确识别为访客', gate.isGuest === true, String(gate.isGuest));

  // 总开关关闭 → 收端也必须被拦（放行不等于不设防）
  invalidateRuntimeConfigCache();
  const envOff = makeEnv({ AIRDROP_ENABLED: 'false' });
  invalidateRuntimeConfigCache();
  const gateOff = await checkAirdropReceiveAccess(guestRequest(), envOff);
  check('[4] ★ 总开关关闭时收端被拦 (403)', gateOff.allowed === false && gateOff.status === 403,
    JSON.stringify(gateOff));

  // 没有任何可用节点 → 收端被拦 (503)
  invalidateRuntimeConfigCache();
  const envNoNode = {
    img_url: makeKv(),
    BASIC_USER: 'admin', BASIC_PASS: 'secret',
  };
  invalidateRuntimeConfigCache();
  const gateNoNode = await checkAirdropReceiveAccess(guestRequest(), envNoNode);
  check('[4] ★ 无可用中转节点时收端被拦 (503)',
    gateNoNode.allowed === false && gateNoNode.status === 503, JSON.stringify(gateNoNode));

  // 管理员显式关掉访客接收 → 访客被拦 (401)
  invalidateRuntimeConfigCache();
  const envDeny = makeEnv({ AIRDROP_GUEST_RECEIVE_ALLOWED: 'false' });
  invalidateRuntimeConfigCache();
  const gateDeny = await checkAirdropReceiveAccess(guestRequest(), envDeny);
  check('[4] ★ 管理员关闭访客接收后，访客被拦 (401)',
    gateDeny.allowed === false && gateDeny.status === 401, JSON.stringify(gateDeny));
  check('[4] 该拒绝带 requireLogin 语义（前端据此提示登录）',
    gateDeny.status === 401);
}

// ============================================================================
console.log('[5] checkAirdropAccess：发端门禁行为不变');
{
  invalidateRuntimeConfigCache();
  const env = makeEnv({ AIRDROP_ENABLED: 'true' });
  invalidateRuntimeConfigCache();

  // 访客默认不能发起
  const gate = await checkAirdropAccess(guestRequest(), env);
  check('[5] ★ 访客发起仍被拦 (401)', gate.allowed === false && gate.status === 401,
    JSON.stringify(gate));
  check('[5] 拒绝码是 AIRDROP_GUEST_DENIED', gate.code === 'AIRDROP_GUEST_DENIED', gate.code);

  // 总开关关闭 → 拦 (403)
  invalidateRuntimeConfigCache();
  const envOff = makeEnv({ AIRDROP_ENABLED: 'false' });
  invalidateRuntimeConfigCache();
  const g2 = await checkAirdropAccess(guestRequest(), envOff);
  check('[5] 总开关关闭时发起被拦 (403)', g2.allowed === false && g2.status === 403,
    JSON.stringify(g2));

  // 无节点 → 拦 (503)
  invalidateRuntimeConfigCache();
  const g3 = await checkAirdropAccess(guestRequest(), {
    img_url: makeKv(), BASIC_USER: 'admin', BASIC_PASS: 'secret',
  });
  check('[5] 无可用节点时发起被拦 (503)', g3.allowed === false && g3.status === 503,
    JSON.stringify(g3));
  invalidateRuntimeConfigCache();
}

// ============================================================================
console.log('[6] 收端不受每日次数限制（与发端的差异点）');
{
  invalidateRuntimeConfigCache();
  const env = makeEnv({ AIRDROP_ENABLED: 'true', AIRDROP_DAILY_LIMIT: '1' });
  invalidateRuntimeConfigCache();

  // 灌满当日计数。注意 key 里的 IP：getClientIp 在无 CF-Connecting-IP /
  // X-Forwarded-For 时返回 'unknown'，这里请求不带 IP 头，所以用 unknown。
  const kv = env.img_url;
  const today = new Date().toISOString().slice(0, 10);
  kv._store.set(`airdrop:count:unknown:${today}`, '999');
  invalidateRuntimeConfigCache();

  // 用**已认证**的请求去测额度分支 —— 访客会先被 guestAllowed 拦成 401
  // （见用例 [5]），根本走不到额度检查。要验的是"额度耗尽"这件事本身，
  // 所以这里必须绕开访客判定，否则测的是另一条分支。
  const authedReq = new Request('https://x.test/api/airdrop/create', {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa('admin:secret')}` },
  });
  const sendGate = await checkAirdropAccess(authedReq, env);
  check('[6] 额度耗尽时发起被拦 (429)',
    sendGate.allowed === false && sendGate.status === 429, JSON.stringify(sendGate));
  check('[6] 拒绝码是 AIRDROP_DAILY_LIMIT', sendGate.code === 'AIRDROP_DAILY_LIMIT', sendGate.code);

  // 同样的前提下，收端不受额度影响
  const recvGate = await checkAirdropReceiveAccess(guestRequest(), env);
  check('[6] ★ 额度耗尽不影响接收（收端放行）', recvGate.allowed === true,
    JSON.stringify(recvGate));
  invalidateRuntimeConfigCache();
}

// ============================================================================
console.log('[7] 「访客」概念在未开认证的部署下不存在');
{
  invalidateRuntimeConfigCache();
  // 站点未配 BASIC_USER/PASS → isAuthRequired=false → 所有人都不算访客
  const env = {
    img_url: makeKv(),
    R2_BUCKET: { put: async () => {}, get: async () => null, delete: async () => {} },
  };
  invalidateRuntimeConfigCache();
  const gate = await checkAirdropAccess(guestRequest(), env);
  check('[7] 无认证部署下发起不被"访客"规则误拦', gate.allowed === true, JSON.stringify(gate));
  check('[7] 此时 isGuest=false（没有访客概念）', gate.isGuest === false, String(gate.isGuest));
  invalidateRuntimeConfigCache();
}

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
