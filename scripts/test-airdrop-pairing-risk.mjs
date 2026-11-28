import assert from 'node:assert/strict';
import { onRequestPost as create } from '../functions/api/airdrop/create.js';
import { onRequestPost as join } from '../functions/api/airdrop/join.js';
import { onRequestGet as status } from '../functions/api/airdrop/status.js';
import { onRequestPost as upload } from '../functions/api/airdrop/upload.js';
import { onRequestGet as download } from '../functions/api/airdrop/download.js';
import { onRequestPost as cancel } from '../functions/api/airdrop/cancel.js';
import { assessAirdropFiles } from '../functions/utils/airdrop-risk.js';
import { cleanupExpired } from '../functions/utils/airdrop.js';
import { makeMigratedEnv } from './test-utils.mjs';

let reads = 0;
const deleted = [];
const stored = [];
const env = {
  ...makeMigratedEnv(),
  AIRDROP_ENABLED: 'true',
  AIRDROP_GUEST_ALLOWED: 'true',
  AIRDROP_GUEST_RECEIVE_ALLOWED: 'true',
  AIRDROP_TTL_MINUTES: '15',
  R2_BUCKET: {
    async put(key) { stored.push(key); },
    async get() {
      reads += 1;
      return { body: new Response('hello').body, size: 5 };
    },
    async delete(key) { deleted.push(key); }
  }
};

function call(handler, params = {}, body, ip = '203.0.113.12', headers = {}) {
  const url = new URL('https://example.com/api/airdrop/test');
  url.search = new URLSearchParams(params);
  const options = { headers: { 'CF-Connecting-IP': ip, ...headers } };
  if (body) {
    options.method = 'POST';
    if (body instanceof FormData) {
      options.body = body;
    } else {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
  }
  return handler({ request: new Request(url, options), env });
}

const created = await call(create, {}, {});
assert.equal(created.status, 200);
const room = await created.json();
assert.match(room.code, /^[0-9]{6}$/);
assert.ok(room.pairingExpiresAt < room.expiresAt);

// Keep a known leading zero through the endpoints and SQLite primary key.
const code = '012345';
const token = room.senderToken;
env._db.prepare('UPDATE airdrop_sessions SET code = ? WHERE code = ?').run(code, room.code);
const uploadParams = { code, token, node: 'r2' };
const uploadBlocked = await call(upload, uploadParams, {});
assert.equal((await uploadBlocked.json()).code, 'PAIRING_REQUIRED');
assert.equal((await call(join, {}, { code: 12345 })).status, 400);
assert.equal((await call(join, {}, { code: 'ABCDEF' })).status, 400);
const candidates = await Promise.all([call(join, {}, { code }), call(join, {}, { code })]);
assert.deepEqual(candidates.map(response => response.status).sort(), [200, 409]);
const receiver = await candidates.find(response => response.ok).json();
assert.equal(receiver.code, code);
assert.equal(Object.hasOwn(receiver, 'checkCode'), false);
const sendView = (await (await call(status, { code, token })).json()).session;
assert.equal(sendView.status, 'linked');
const receiverParams = { code, token: receiver.receiverToken };
const view = (await (await call(status, receiverParams)).json()).session;
assert.equal(view.status, 'linked');
assert.equal(view.files, undefined);
assert.equal((await call(upload, { ...uploadParams, token: receiver.receiverToken }, {})).status, 403);

const files = [
  { name: 'readme.txt', type: 'text/plain' },
  { name: 'invoice.pdf.exe', type: 'text/plain' },
  { name: 'notes.txt', type: 'application/zip' },
  { name: 'preview\u202E.png', type: 'image/png' }
];
const risks = [
  { name: 'invoice.pdf.exe', reasons: ['active'] },
  { name: 'notes.txt', reasons: ['archive'] },
  { name: 'preview�.png', reasons: ['filename'] }
];
assert.deepEqual(assessAirdropFiles(files), risks);
for (const [index, { name, type }] of files.entries()) {
  const form = new FormData();
  form.set('file', new File(['hello'], name, { type }));
  const response = await call(upload, { ...uploadParams, final: Number(index === files.length - 1) }, form);
  assert.equal(response.status, 200, await response.text());
}
assert.equal(stored.length, files.length);
const now = Date.now();
env._db.prepare('UPDATE airdrop_sessions SET expires_at = ? WHERE code = ?').run(now - 1000, code);
await cleanupExpired(env, now);
assert.deepEqual(deleted, []);
const exposed = (await (await call(status, receiverParams)).json()).session;
assert.deepEqual(exposed.risks, risks);
assert.equal(Object.hasOwn(exposed.files[1], 'key'), false);
assert.ok(exposed.expiresAt > now);
const firstFile = { ...receiverParams, idx: 0 };
const refused = await call(download, firstFile);
assert.equal(refused.status, 409);
assert.equal((await refused.json()).code, 'RISK_CONFIRMATION_REQUIRED');
assert.equal(reads, 0);
const accepted = await call(download, firstFile, undefined, undefined, { 'X-KVault-Accept-Risk': '1' });
assert.equal(accepted.status, 200);
assert.equal(accepted.headers.get('X-Content-Type-Options'), 'nosniff');
assert.equal(await accepted.text(), 'hello');
assert.equal(reads, 1);
assert.equal((await call(cancel, {}, receiverParams)).status, 200);
assert.deepEqual(deleted, stored);
assert.equal((await call(download, firstFile, undefined, undefined, { 'X-KVault-Accept-Risk': '1' })).status, 409);

env._db.prepare("INSERT INTO airdrop_sessions (code, status, sender_token, created_at, expires_at) VALUES ('654321', 'waiting', ?, ?, ?)")
  .run(token, now - 301000, now + 300000);
assert.equal((await call(join, {}, { code: '654321' })).status, 404);
const guesses = await Promise.all(Array.from({ length: 7 }, () => call(join, {}, { code: '000000' }, '203.0.113.13')));
assert.equal(guesses.filter(response => response.status === 429).length, 1);
assert.ok(Number(guesses.find(response => response.status === 429).headers.get('Retry-After')) > 0);
const pendingCode = '543210';
env._db.prepare("INSERT INTO airdrop_sessions (code, status, sender_token, receiver_token, created_at, expires_at) VALUES (?, 'pairing', ?, ?, ?, ?)")
  .run(pendingCode, token, receiver.receiverToken, now, now + 300000);
const pending = await call(status, { code: pendingCode, token });
assert.equal((await pending.json()).session.status, 'linked');
console.log('✅ 6 位连接码直接配对、单收端、配对限流、交付宽限、风险下载门禁与取消');
