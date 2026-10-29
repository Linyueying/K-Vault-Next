import {
  begin,
  complete,
  release,
  ensureSchema,
  IDEMPOTENCY_TTL_SECONDS,
  PROCESSING_STALE_MS,
} from '../functions/utils/idempotency.js';
import { makeMigratedEnv } from './test-utils.mjs';

let pass = 0;
let fail = 0;

function check(label, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  [PASS] ${label}`);
  } else {
    fail += 1;
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function makeD1Env() {
  const env = makeMigratedEnv();
  // The real migration is owned separately; tests create the assumed table explicitly.
  env._db.exec(`
    CREATE TABLE IF NOT EXISTS api_idempotency (
      token_id TEXT NOT NULL,
      idem_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      state TEXT NOT NULL,
      status INTEGER,
      response_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY(token_id, idem_key)
    )
  `);
  return env;
}

function makeKv() {
  const store = new Map();
  return {
    store,
    async get(key, options = {}) {
      const value = store.get(key);
      if (value == null) return null;
      return options.type === 'json' ? JSON.parse(value) : value;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

const NOW = 1700000000000;
const base = { tokenId: 'token-a', key: 'key-a', requestHash: 'hash-a' };

console.log('[1] Concurrent D1 begin has exactly one owner');
{
  const env = makeD1Env();
  check('ensureSchema accepts the migrated table', await ensureSchema(env) === true);
  const results = await Promise.all(Array.from({ length: 16 }, () => begin(env, { ...base, now: NOW })));
  const acquired = results.filter((result) => result.state === 'acquired');
  check('exactly one acquired', acquired.length === 1, JSON.stringify(results));
  check('all other callers see processing', results.filter((result) => result.state === 'processing').length === 15);

  const conflict = await begin(env, { ...base, requestHash: 'hash-b', now: NOW + 1 });
  check('same key with another request hash conflicts', conflict.state === 'conflict', JSON.stringify(conflict));

  const body = { success: true, file: { id: 'r2:file-a' }, links: { download: 'https://example.test/file-a' } };
  const completed = await complete(env, {
    ...base,
    lease: acquired[0].lease,
    status: 200,
    body,
    now: NOW + 2,
  });
  check('owner completes successfully', completed.ok === true, JSON.stringify(completed));

  const replay = await begin(env, { ...base, now: NOW + 3 });
  check('completed begin returns replay', replay.state === 'completed', JSON.stringify(replay));
  check('replay preserves status and exact body', replay.status === 200 && JSON.stringify(replay.body) === JSON.stringify(body));
  const row = env._db.prepare(`
    SELECT state, status, response_json, created_at, updated_at, expires_at
    FROM api_idempotency WHERE token_id = ? AND idem_key = ?
  `).get(base.tokenId, base.key);
  check('snapshot expiry is 24 hours after completion', Number(row.expires_at) - Number(row.updated_at) === IDEMPOTENCY_TTL_SECONDS * 1000);
  check('D1 stores completed status and response', row.state === 'completed' && Number(row.status) === 200 && JSON.parse(row.response_json).file.id === 'r2:file-a');

  const completedConflict = await begin(env, { ...base, requestHash: 'hash-b', now: NOW + 4 });
  check('completed key still rejects another request hash', completedConflict.state === 'conflict');
}

console.log('[2] Release allows retry and cannot erase a completed snapshot');
{
  const env = makeD1Env();
  const input = { tokenId: 'token-a', key: 'retry-key', requestHash: 'retry-hash' };
  const first = await begin(env, { ...input, now: NOW });
  const released = await release(env, { ...input, lease: first.lease });
  check('processing owner releases successfully', released.ok === true, JSON.stringify(released));
  const retry = await begin(env, { ...input, now: NOW + 1 });
  check('retry acquires after release', retry.state === 'acquired', JSON.stringify(retry));
  await complete(env, { ...input, lease: retry.lease, body: { success: true }, now: NOW + 2 });
  const releaseCompleted = await release(env, { ...input, lease: retry.lease });
  check('release does not delete completed response', releaseCompleted.ok === false);
  check('completed response remains replayable', (await begin(env, { ...input, now: NOW + 3 })).state === 'completed');
}

console.log('[3] Stale processing lease has one conditional takeover');
{
  const env = makeD1Env();
  const input = { tokenId: 'token-a', key: 'stale-key', requestHash: 'stale-hash' };
  const original = await begin(env, { ...input, now: NOW });
  const atBoundary = await begin(env, { ...input, now: NOW + PROCESSING_STALE_MS });
  check('15-minute boundary is still processing', atBoundary.state === 'processing');

  const takeoverResults = await Promise.all([
    begin(env, { ...input, now: NOW + PROCESSING_STALE_MS + 1 }),
    begin(env, { ...input, now: NOW + PROCESSING_STALE_MS + 1 }),
  ]);
  const takeovers = takeoverResults.filter((result) => result.state === 'acquired');
  check('only one stale takeover acquires', takeovers.length === 1, JSON.stringify(takeoverResults));

  const staleComplete = await complete(env, {
    ...input,
    lease: original.lease,
    body: { success: true, owner: 'stale' },
    now: NOW + PROCESSING_STALE_MS + 2,
  });
  check('old owner cannot complete the takeover lease', staleComplete.ok === false, JSON.stringify(staleComplete));
  const staleRelease = await release(env, { ...input, lease: original.lease });
  check('old owner cannot release the takeover lease', staleRelease.ok === false);

  const newComplete = await complete(env, {
    ...input,
    lease: takeovers[0].lease,
    body: { success: true, owner: 'takeover' },
    now: NOW + PROCESSING_STALE_MS + 3,
  });
  check('takeover owner completes', newComplete.ok === true, JSON.stringify(newComplete));
  const replay = await begin(env, { ...input, now: NOW + PROCESSING_STALE_MS + 4 });
  check('replay belongs to takeover owner', replay.body?.owner === 'takeover', JSON.stringify(replay));
}

console.log('[4] Expired completed snapshot can be acquired again');
{
  const env = makeD1Env();
  const input = { tokenId: 'token-a', key: 'expiry-key', requestHash: 'expiry-hash' };
  const first = await begin(env, { ...input, now: NOW });
  await complete(env, { ...input, lease: first.lease, body: { success: true }, now: NOW + 1 });
  const expired = await begin(env, { ...input, now: NOW + IDEMPOTENCY_TTL_SECONDS * 1000 + 2 });
  check('expired snapshot no longer blocks a new upload', expired.state === 'acquired', JSON.stringify(expired));
}

console.log('[5] KV fallback uses SHA-256 namespacing and the same API');
{
  const kv = makeKv();
  const env = { img_url: kv };
  const input = { tokenId: 'token-kv', key: 'sensitive-key', requestHash: 'kv-hash' };
  const first = await begin(env, { ...input, now: NOW });
  check('KV fallback acquires without D1', first.state === 'acquired' && first.backend === 'kv', JSON.stringify(first));
  const storeKey = [...kv.store.keys()][0] || '';
  check('KV key has a 64-character SHA-256 namespace', /^idem:v2:sha256:[a-f0-9]{64}$/.test(storeKey), storeKey);
  check('KV key does not expose the raw idempotency key', !storeKey.includes(input.key));

  const body = { success: true, file: { id: 'kv-file' } };
  await complete(env, { ...input, lease: first.lease, body, now: NOW + 1 });
  const replay = await begin(env, { ...input, now: NOW + 2 });
  check('KV completed response replays exactly', replay.state === 'completed' && JSON.stringify(replay.body) === JSON.stringify(body));
  check('KV request hash conflicts match D1', (await begin(env, { ...input, requestHash: 'other', now: NOW + 2 })).state === 'conflict');

  const retryInput = { ...input, key: 'kv-retry' };
  const processing = await begin(env, { ...retryInput, now: NOW });
  await release(env, { ...retryInput, lease: processing.lease });
  check('KV release permits retry', (await begin(env, { ...retryInput, now: NOW + 1 })).state === 'acquired');
}

console.log('[6] D1 operational failure falls back to KV');
{
  const kv = makeKv();
  const env = {
    img_url: kv,
    DB: { prepare() { throw new Error('d1-down'); } },
  };
  const result = await begin(env, { tokenId: 'token-a', key: 'fallback', requestHash: 'hash', now: NOW });
  check('D1 exception does not block best-effort KV acquisition', result.state === 'acquired' && result.backend === 'kv', JSON.stringify(result));
}

console.log(`\n===== ${pass} passed / ${fail} failed =====`);
process.exit(fail === 0 ? 0 : 1);
