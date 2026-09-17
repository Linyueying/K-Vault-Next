const assert = require('assert');

describe('WebDAV download auth fallback', function () {
  const originalFetch = global.fetch;

  afterEach(function () {
    global.fetch = originalFetch;
  });

  it('falls back from bearer to basic auth when bearer fails', async function () {
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

    const { getWebDAVFile } = await import('../functions/utils/webdav.js');
    const env = {
      WEBDAV_BASE_URL: 'https://example.com/dav',
      WEBDAV_BEARER_TOKEN: 'bad-token',
      WEBDAV_USERNAME: 'user',
      WEBDAV_PASSWORD: 'pass',
    };

    const response = await getWebDAVFile('uploads/file.png', env);
    const body = await response.text();

    assert.strictEqual(response.status, 200);
    assert.strictEqual(body, 'ok');
    assert.strictEqual(callCount, 2);
    assert.ok(String(seenAuth[0]).startsWith('Bearer '));
    assert.ok(String(seenAuth[1]).startsWith('Basic '));
  });

  it('falls back to anonymous when auth is rejected', async function () {
    const seenAuth = [];
    let callCount = 0;

    global.fetch = async (_url, init = {}) => {
      callCount += 1;
      const auth = init?.headers?.Authorization || '';
      seenAuth.push(auth);
      if (callCount === 1) {
        return new Response('forbidden', { status: 403 });
      }
      return new Response('public-ok', { status: 200 });
    };

    const { getWebDAVFile } = await import('../functions/utils/webdav.js');
    const env = {
      WEBDAV_BASE_URL: 'https://example.com/dav',
      WEBDAV_USERNAME: 'user',
      WEBDAV_PASSWORD: 'pass',
    };

    const response = await getWebDAVFile('uploads/public.png', env);
    const body = await response.text();

    assert.strictEqual(response.status, 200);
    assert.strictEqual(body, 'public-ok');
    assert.strictEqual(callCount, 2);
    assert.ok(String(seenAuth[0]).startsWith('Basic '));
    assert.strictEqual(String(seenAuth[1]), '');
  });

  it('returns null when file is not found', async function () {
    global.fetch = async () => new Response('not found', { status: 404 });

    const { getWebDAVFile } = await import('../functions/utils/webdav.js');
    const env = {
      WEBDAV_BASE_URL: 'https://example.com/dav',
      WEBDAV_USERNAME: 'user',
      WEBDAV_PASSWORD: 'pass',
    };

    const response = await getWebDAVFile('uploads/missing.png', env);
    assert.strictEqual(response, null);
  });

  it('connection check falls back from bearer to basic auth', async function () {
    const authHeaders = [];

    global.fetch = async (_url, init = {}) => {
      const auth = init?.headers?.Authorization || '';
      authHeaders.push(auth);
      if (String(auth).startsWith('Bearer ')) {
        return new Response('unauthorized', { status: 401 });
      }
      return new Response('<?xml version="1.0"?><multistatus/>', { status: 207 });
    };

    const { checkWebDAVConnection } = await import('../functions/utils/webdav.js');
    const env = {
      WEBDAV_BASE_URL: 'https://example.com/dav',
      WEBDAV_BEARER_TOKEN: 'bad-token',
      WEBDAV_USERNAME: 'user',
      WEBDAV_PASSWORD: 'pass',
    };

    const result = await checkWebDAVConnection(env);
    assert.strictEqual(result.connected, true);
    assert.ok(String(authHeaders[0]).startsWith('Bearer '));
    assert.ok(authHeaders.some((value) => String(value).startsWith('Basic ')));
  });
});
