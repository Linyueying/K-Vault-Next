const assert = require('assert');
const { WebDAVStorageAdapter } = require('../server/lib/storage/adapters/webdav');

describe('Server WebDAV adapter download fallback', function () {
  const originalFetch = global.fetch;

  afterEach(function () {
    global.fetch = originalFetch;
  });

  it('falls back from bearer to basic auth', async function () {
    const seenAuth = [];
    let callCount = 0;

    global.fetch = async (_url, init = {}) => {
      callCount += 1;
      const auth = init?.headers?.Authorization || '';
      seenAuth.push(auth);
      if (callCount === 1) {
        return new Response('unauthorized', { status: 401 });
      }
      return new Response('ok', { status: 200 });
    };

    const adapter = new WebDAVStorageAdapter({
      baseUrl: 'https://example.com/dav',
      bearerToken: 'bad-token',
      username: 'user',
      password: 'pass',
    });

    const response = await adapter.download({ storageKey: 'uploads/file.png' });
    const body = await response.text();

    assert.strictEqual(response.status, 200);
    assert.strictEqual(body, 'ok');
    assert.strictEqual(callCount, 2);
    assert.ok(String(seenAuth[0]).startsWith('Bearer '));
    assert.ok(String(seenAuth[1]).startsWith('Basic '));
  });

  it('falls back to anonymous when authenticated reads are rejected', async function () {
    const seenAuth = [];
    let callCount = 0;

    global.fetch = async (_url, init = {}) => {
      callCount += 1;
      const auth = init?.headers?.Authorization || '';
      seenAuth.push(auth);
      if (callCount === 1) {
        return new Response('forbidden', { status: 403 });
      }
      return new Response('public', { status: 200 });
    };

    const adapter = new WebDAVStorageAdapter({
      baseUrl: 'https://example.com/dav',
      username: 'user',
      password: 'pass',
    });

    const response = await adapter.download({ storageKey: 'uploads/public.png' });
    const body = await response.text();

    assert.strictEqual(response.status, 200);
    assert.strictEqual(body, 'public');
    assert.strictEqual(callCount, 2);
    assert.ok(String(seenAuth[0]).startsWith('Basic '));
    assert.strictEqual(String(seenAuth[1]), '');
  });

  it('returns null on 404', async function () {
    global.fetch = async () => new Response('missing', { status: 404 });

    const adapter = new WebDAVStorageAdapter({
      baseUrl: 'https://example.com/dav',
      username: 'user',
      password: 'pass',
    });

    const response = await adapter.download({ storageKey: 'uploads/missing.png' });
    assert.strictEqual(response, null);
  });

  it('testConnection falls back from bearer to basic auth', async function () {
    const seenAuth = [];

    global.fetch = async (_url, init = {}) => {
      const auth = init?.headers?.Authorization || '';
      seenAuth.push(auth);
      if (String(auth).startsWith('Bearer ')) {
        return new Response('unauthorized', { status: 401 });
      }
      return new Response('<?xml version="1.0"?><multistatus/>', { status: 207 });
    };

    const adapter = new WebDAVStorageAdapter({
      baseUrl: 'https://example.com/dav',
      bearerToken: 'bad-token',
      username: 'user',
      password: 'pass',
    });

    const result = await adapter.testConnection();
    assert.strictEqual(result.connected, true);
    assert.ok(String(seenAuth[0]).startsWith('Bearer '));
    assert.ok(seenAuth.some((value) => String(value).startsWith('Basic ')));
  });
});