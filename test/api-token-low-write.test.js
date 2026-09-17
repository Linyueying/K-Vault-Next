const assert = require('assert');

// Minimal KV double with call counters (low-write tests only need get/put).
class MemoryKV {
  constructor() {
    this.store = new Map();
    this.putCalls = 0;
    this.getCalls = 0;
  }

  async put(key, value = '', options = {}) {
    this.putCalls += 1;
    this.store.set(String(key), {
      value: String(value ?? ''),
      metadata: options?.metadata || null,
    });
  }

  async get(key, options = {}) {
    this.getCalls += 1;
    const entry = this.store.get(String(key));
    if (!entry) return null;
    if (options?.type === 'json') {
      try {
        return JSON.parse(entry.value);
      } catch {
        return null;
      }
    }
    return entry.value;
  }

  async delete(key) {
    this.store.delete(String(key));
  }
}

async function invokeMiddleware(env, token) {
  const { onRequest } = await import('../functions/api/v1/_middleware.js');
  const request = new Request('https://example.com/api/v1/files', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  const waiters = [];
  const response = await onRequest({
    request,
    env,
    data: {},
    next: () => new Response('ok', { status: 200 }),
    waitUntil: (promise) => {
      waiters.push(Promise.resolve(promise));
    },
  });
  await Promise.allSettled(waiters);
  return response;
}

async function setupScenario({ envOverrides = {}, statAgeMs = null } = {}) {
  const { createApiToken } = await import('../functions/utils/api-token.js');
  const env = { img_url: new MemoryKV(), ...envOverrides };
  const created = await createApiToken({ name: 'low-write-token', scopes: ['read'] }, env);
  if (statAgeMs != null) {
    await env.img_url.put(`token_stat:${created.record.id}`, JSON.stringify({
      lastUsedAt: Date.now() - statAgeMs,
      usageCount: 3,
      lastTouchAt: Date.now() - statAgeMs,
    }));
  }
  return { env, token: created.token, record: created.record };
}

describe('API token low-write mode (MINIMIZE_KV_WRITES=true)', function () {
  it('still writes usage on first use when no stat record exists', async function () {
    const { env, token } = await setupScenario({ envOverrides: { MINIMIZE_KV_WRITES: 'true' } });

    const writesBefore = env.img_url.putCalls;
    const response = await invokeMiddleware(env, token);

    assert.strictEqual(response.status, 200);
    assert.strictEqual(env.img_url.putCalls, writesBefore + 1, 'first use must persist the usage stat');
  });

  it('skips the usage write inside the one-hour window when MINIMIZE_KV_WRITES=true', async function () {
    const { env, token } = await setupScenario({
      envOverrides: { MINIMIZE_KV_WRITES: 'true' },
      statAgeMs: 90 * 1000, // 90s ago: past the default 60s debounce, inside the 1h window
    });

    const writesBefore = env.img_url.putCalls;
    const response = await invokeMiddleware(env, token);

    assert.strictEqual(response.status, 200);
    assert.strictEqual(env.img_url.putCalls, writesBefore, 'low-write mode must not persist usage within one hour');
  });

  it('still writes usage in default mode once the 60s debounce window has passed', async function () {
    const { env, token } = await setupScenario({ statAgeMs: 90 * 1000 });

    const writesBefore = env.img_url.putCalls;
    const response = await invokeMiddleware(env, token);

    assert.strictEqual(response.status, 200);
    assert.strictEqual(env.img_url.putCalls, writesBefore + 1, 'default mode keeps the 60s sampling behaviour');
  });

  it('writes usage again in low-write mode after one hour has elapsed', async function () {
    const { env, token } = await setupScenario({
      envOverrides: { MINIMIZE_KV_WRITES: 'true' },
      statAgeMs: 2 * 60 * 60 * 1000, // 2h ago: outside the 1h window
    });

    const writesBefore = env.img_url.putCalls;
    const response = await invokeMiddleware(env, token);

    assert.strictEqual(response.status, 200);
    assert.strictEqual(env.img_url.putCalls, writesBefore + 1, 'usage must be persisted once the hourly window elapses');
  });
});
