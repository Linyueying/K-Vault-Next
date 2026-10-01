/**
 * 重命名：D1 缺行时的「补插」回归测试。
 *
 * ============================================================================
 * 防的是什么（真实线上故障）
 * ============================================================================
 *
 * 用户在管理后台重命名文件，弹出：
 *
 *     Image metadata not found for ID: BQACAgUAAyEGAAS...hkIgAA...
 *
 * 但这文件明明就在列表里、也能正常下载 —— 报「找不到」自相矛盾。
 *
 * ## 根因
 *
 * D1 引入**之前**上传的历史文件（本机实测是 Telegram 后端那批），
 * 记录只存在 KV，`files` 表里从来没有对应行。
 *
 * `editName` 走的是 `updateFileMetadataFields`（纯 UPDATE）：
 *
 *     UPDATE files SET file_name = ? WHERE id = ?
 *
 * 表里没这行 → `changes === 0` → 旧代码直接 `404 Image metadata not found`。
 *
 * 而「点赞」（toggleLike）走的是 `registerFileRecord`（UPSERT），
 * 遇到同样情况会补插一行、照常成功 —— **两个接口行为不一致本身就是 bug**。
 *
 * ## 修法
 *
 * `updated === 0` 时不再报错，改为用手里已有的 metadata 补插一行
 * （与 toggleLike 对齐），顺带把这条历史记录纳入 D1 管辖。
 *
 * ## 本套件锁住的行为
 *
 *   [1] **老文件（D1 无行）**：命名成功，且 D1 里被补出一行（含新名字）
 *   [2] **正常文件（D1 有行）**：走 UPDATE 快路径，不产生重复行
 *   [3] **补插也失败**：回落到 KV 写，仍返回成功（不让 D1 抖动阻断改名）
 *   [4] **文件真的不存在**（KV 也查不到）：仍然 404，不能变成"什么都成功"
 *
 * 运行：node scripts/test-rename-backfill.mjs
 */
import { onRequest } from '../functions/api/manage/editName/[id].js';

let pass = 0;
let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${label}`); }
  else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
};

// ---------------------------------------------------------------- KV 桩
/** 极简 KV：一个 Map，支持 getWithMetadata / put / get / delete。 */
function makeKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    _store: store,
    async getWithMetadata(key) {
      const hit = store.get(key);
      return hit ? { name: key, metadata: JSON.parse(JSON.stringify(hit)) } : null;
    },
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, _v, opts) {
      if (opts && opts.metadata) store.set(key, JSON.parse(JSON.stringify(opts.metadata)));
      else store.set(key, '');
    },
    async delete(key) { store.delete(key); },
  };
}

// ---------------------------------------------------------------- D1 桩
/**
 * files 表桩。只认本套件用到的三类语句：
 *   - SELECT * FROM files WHERE id = ?         （getFileRecord）
 *   - UPDATE files SET ... WHERE id = ?        （updateFileMetadataFields）
 *   - INSERT INTO files ... ON CONFLICT ...    （putFileRecord / UPSERT）
 *   - PRAGMA / ALTER / CREATE ...              （迁移噪声，无害回落）
 */
function makeDb(rows = []) {
  const table = new Map(rows.map(r => [r.id, { ...r }]));
  let failUpsert = false;

  const api = {
    _table: table,
    _failUpsert: (v) => { failUpsert = v; },
    prepare(sql) {
      const s = String(sql);
      const stmt = {
        _args: [],
        bind(...args) { this._args = args; return this; },
        async first() {
          if (/FROM\s+files\s+WHERE\s+id\s*=\s*\?/i.test(s)) {
            const row = table.get(String(this._args[0]));
            return row ? { ...row } : null;
          }
          return null; // PRAGMA / sqlite_master 等 → 无结果
        },
        async all() {
          if (/FROM\s+files/i.test(s)) return { results: [...table.values()] };
          return { results: [] };
        },
        async run() {
          // UPDATE files SET ... WHERE id = ?
          if (/^UPDATE\s+files\s+SET/i.test(s.trim())) {
            const id = String(this._args[this._args.length - 1]);
            const row = table.get(id);
            if (!row) return { success: true, meta: { changes: 0 } };
            // 按 SET 子句顺序回填（file_name / folder_path 在前，updated_at 次之）
            const sets = s.match(/SET\s+(.+?)\s+WHERE/is)?.[1] || '';
            const cols = [...sets.matchAll(/(\w+)\s*=\s*\?/g)].map(m => m[1]);
            cols.forEach((col, i) => {
              if (col === 'updated_at') return;
              row[col] = this._args[i];
            });
            return { success: true, meta: { changes: 1 } };
          }
          // INSERT INTO files ... ON CONFLICT (upsert)
          if (/INSERT\s+INTO\s+files/i.test(s)) {
            if (failUpsert) return { success: false, meta: { changes: 0 } };
            // 列名取「INSERT INTO files ( ... ) VALUES」里第一组括号的内容。
            // ⚠️ 不能写成 /\(([^)]+)\)\s*VALUES/ —— 那样会先撞上
            //    ON CONFLICT(id) 的括号（它在 VALUES 之后但正则回溯时可能先匹配到
            //    别的括号组）。这里锚定在 INSERT INTO files 之后取，最稳。
            const colsPart = s.match(/INSERT\s+INTO\s+files\s*\(([\s\S]*?)\)\s*VALUES/i)?.[1] || '';
            const cols = colsPart.split(',').map(c => c.trim().replace(/^["`]|["`]$/g, ''));
            const row = {};
            cols.forEach((c, i) => { row[c] = this._args[i]; });
            const id = String(row.id ?? '');
            if (!id) return { success: false, meta: { changes: 0 } };
            const existed = table.has(id);
            // ON CONFLICT(id) DO UPDATE = upsert：已存在则覆盖，不存在则插入
            table.set(id, { ...(table.get(id) || {}), ...row });
            return { success: true, meta: { changes: existed ? 1 : 1 } };
          }
          return { success: true, meta: { changes: 0 } }; // 迁移噪声
        },
      };
      return stmt;
    },
  };
  return api;
}

const json = (body) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});

/** 构造一次 editName 请求上下文。 */
async function rename(env, fileId, newName) {
  const url = `https://x/api/manage/editName/${encodeURIComponent(fileId)}?newName=${encodeURIComponent(newName)}`;
  const res = await onRequest({
    request: new Request(url),
    params: { id: encodeURIComponent(fileId) },
    env,
  });
  return { status: res.status, body: await res.json() };
}

// ============================================================ 场景数据
const TG_ID = 'BQACAgUAAyEGAAShkW1dAAMFaQv2xyzABCdefGhIJklMnOpQrStUvW';
const TG_KEY = `${TG_ID}.md`;                       // Telegram：无前缀，kvKey = `${fileId}.${ext}`
/**
 * ⚠️ D1 的 files.id 对 Telegram 文件来说 = **kvKey 本身**（带扩展名）。
 *
 * 因为 `deriveIndexId()` 只剥离**已知存储前缀**（`img:` / `r2:` / `vid:` …），
 * 而 Telegram 的 kvKey 没有前缀，于是原样返回 —— 带上 `.md` 后缀。
 * 这一点很容易写错（我第一版测试就拿裸 fileId 去查表，结果误判为"没插进去"），
 * 所以这里用 TG_D1_ID 明确区分"存储 fileId"与"D1 主键"。
 */
const TG_D1_ID = TG_KEY;
const TG_META = {
  fileName: 'K-Vault-Next-vs-K-Vault.md',
  fileSize: 8192,
  TimeStamp: 1759000000000,
  storageType: 'telegram',
  storage: 'telegram',
};

console.log('\n[1] 老文件（D1 无行）→ 补插后改名成功');
{
  // 关键前提：KV 查得到（所以列表里看得见），D1 表里空
  const env = { DB: makeDb([]), img_url: makeKv({ [TG_KEY]: TG_META }) };
  const { status, body } = await rename(env, TG_KEY, '新名字.md');

  check('返回 200（不再报 Image metadata not found）', status === 200, `status=${status}`);
  check('success = true', body.success === true, JSON.stringify(body));
  check('新文件名已返回', body.fileName === '新名字.md', JSON.stringify(body.fileName));

  const row = env.DB._table.get(TG_D1_ID);
  check('D1 里补出了这一行', !!row, `表中只有: ${[...env.DB._table.keys()].join(', ') || '(空)'}`);
  check('补出的行带着新名字', row?.file_name === '新名字.md', JSON.stringify(row?.file_name));
  check('补出的行未丢原始大小', Number(row?.file_size) === 8192, JSON.stringify(row?.file_size));
}

console.log('\n[2] 正常文件（D1 已有行）→ 走 UPDATE，不产生重复');
{
  const env = {
    DB: makeDb([{ id: TG_D1_ID, kv_key: TG_KEY, file_name: '旧名.md', file_size: 8192, storage: 'telegram' }]),
    img_url: makeKv({ [TG_KEY]: TG_META }),
  };
  const before = env.DB._table.size;
  const { status, body } = await rename(env, TG_KEY, '改后.md');

  check('返回 200', status === 200, `status=${status}`);
  check('success = true', body.success === true, JSON.stringify(body));
  check('行数不变（未插重复行）', env.DB._table.size === before, `${before} → ${env.DB._table.size}`);
  check('文件名已更新', env.DB._table.get(TG_D1_ID)?.file_name === '改后.md');
}

console.log('\n[3] 补插失败 → 回落 KV，仍返回成功（不阻断改名）');
{
  const env = { DB: makeDb([]), img_url: makeKv({ [TG_KEY]: TG_META }) };
  env.DB._failUpsert(true);
  const { status, body } = await rename(env, TG_KEY, '兜底名.md');

  check('返回 200（D1 抖动不该阻断改名）', status === 200, `status=${status}`);
  check('success = true', body.success === true, JSON.stringify(body));
  const kvMeta = env.img_url._store.get(TG_KEY);
  check('KV 里的文件名已更新', kvMeta?.fileName === '兜底名.md', JSON.stringify(kvMeta?.fileName));
}

console.log('\n[4] 文件真的不存在（KV 也查不到）→ 仍然 404');
{
  const env = { DB: makeDb([]), img_url: makeKv({}) };
  const { status, body } = await rename(env, 'nonexistent-id.md', '随便.md');

  check('返回 404（不能把"查不到"也当成功）', status === 404, `status=${status}`);
  check('success = false', body.success === false, JSON.stringify(body));
}

console.log('\n[5] 无 D1 绑定（纯 KV 环境）→ KV 改名照常');
{
  const env = { img_url: makeKv({ [TG_KEY]: TG_META }) };
  const { status, body } = await rename(env, TG_KEY, '纯KV环境.md');

  check('返回 200', status === 200, `status=${status}`);
  check('success = true', body.success === true, JSON.stringify(body));
  check('KV 已更新', env.img_url._store.get(TG_KEY)?.fileName === '纯KV环境.md');
}

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
