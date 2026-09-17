function normalizeBaseUrl(raw) {
  if (!raw) return '';
  try {
    return new URL(String(raw)).toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function normalizeToken(value) {
  if (!value) return '';
  return String(value).replace(/^Bearer\s+/i, '').trim();
}

function normalizePath(value) {
  const normalized = String(value || '')
    .replace(/\\/g, '/')
    .trim();

  const output = [];
  for (const part of normalized.split('/')) {
    const piece = part.trim();
    if (!piece || piece === '.') continue;
    if (piece === '..') {
      output.pop();
      continue;
    }
    output.push(piece);
  }
  return output.join('/');
}

function splitPath(value) {
  const normalized = normalizePath(value);
  if (!normalized) return [];
  return normalized.split('/').filter(Boolean);
}

function encodeSegments(segments) {
  if (!segments.length) return '';
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

function getRootUrlCandidates(config) {
  const base = config.baseUrl || '';
  if (!base) return [];
  return Array.from(new Set([base, `${base}/`]));
}

function authMode(config) {
  if (config.bearerToken) return 'bearer';
  if (config.username && config.password) return 'basic';
  return 'none';
}

function hasBasicAuth(config) {
  return Boolean(config.username && config.password);
}

function hasBearerAuth(config) {
  return Boolean(config.bearerToken);
}

export function getWebDAVConfig(env = {}) {
  return {
    baseUrl: normalizeBaseUrl(env.WEBDAV_BASE_URL),
    username: String(env.WEBDAV_USERNAME || '').trim(),
    password: String(env.WEBDAV_PASSWORD || ''),
    bearerToken: normalizeToken(env.WEBDAV_BEARER_TOKEN || env.WEBDAV_TOKEN || ''),
    rootPath: normalizePath(env.WEBDAV_ROOT_PATH || ''),
  };
}

export function hasWebDAVConfig(env = {}) {
  const config = getWebDAVConfig(env);
  return Boolean(config.baseUrl) && authMode(config) !== 'none';
}

function buildAuthHeaders(config, extra = {}) {
  const headers = { ...extra };
  const mode = authMode(config);
  if (mode === 'bearer') {
    headers.Authorization = `Bearer ${config.bearerToken}`;
  } else if (mode === 'basic') {
    const encoded = btoa(`${config.username}:${config.password}`);
    headers.Authorization = `Basic ${encoded}`;
  }
  return headers;
}

function buildStoragePath(config, storagePath = '') {
  const allSegments = [...splitPath(config.rootPath), ...splitPath(storagePath)];
  return encodeSegments(allSegments);
}

function buildUrl(config, storagePath = '') {
  const relative = buildStoragePath(config, storagePath);
  return relative ? `${config.baseUrl}/${relative}` : config.baseUrl;
}

async function decodeErrorTextSafe(response) {
  try {
    const text = await response.text();
    return String(text || '').slice(0, 500);
  } catch {
    return '';
  }
}

async function fetchDav(config, method, storagePath = '', { headers = {}, body = null } = {}) {
  return fetch(buildUrl(config, storagePath), {
    method,
    headers: buildAuthHeaders(config, headers),
    body,
  });
}

function buildAuthOverrideHeaders(config, mode, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (mode === 'bearer' && hasBearerAuth(config)) {
    headers.Authorization = `Bearer ${config.bearerToken}`;
    return headers;
  }
  if (mode === 'basic' && hasBasicAuth(config)) {
    const encoded = btoa(`${config.username}:${config.password}`);
    headers.Authorization = `Basic ${encoded}`;
    return headers;
  }
  if (Object.prototype.hasOwnProperty.call(headers, 'Authorization')) {
    delete headers.Authorization;
  }
  return headers;
}

async function fetchDavWithAuthMode(config, method, storagePath = '', mode = 'none', { headers = {}, body = null } = {}) {
  return fetch(buildUrl(config, storagePath), {
    method,
    headers: buildAuthOverrideHeaders(config, mode, headers),
    body,
  });
}

function buildAuthAttemptModes(config) {
  const attemptedModes = [];
  const pushMode = (mode) => {
    if (!mode || attemptedModes.includes(mode)) return;
    attemptedModes.push(mode);
  };

  pushMode(authMode(config));
  if (hasBearerAuth(config)) pushMode('bearer');
  if (hasBasicAuth(config)) pushMode('basic');
  pushMode('none');

  return attemptedModes;
}

async function ensureCollectionPath(config, storagePath) {
  const rootSegments = splitPath(config.rootPath);
  const fileSegments = splitPath(storagePath);
  const directorySegments = [...rootSegments, ...fileSegments.slice(0, -1)];
  if (directorySegments.length === 0) return;

  for (let index = 0; index < directorySegments.length; index += 1) {
    const partial = directorySegments.slice(0, index + 1);
    const encoded = encodeSegments(partial);
    const candidates = Array.from(new Set([
      `${config.baseUrl}/${encoded}`,
      `${config.baseUrl}/${encoded}/`,
    ]));

    let success = false;
    let lastResponse = null;
    for (const url of candidates) {
      const response = await fetch(url, {
        method: 'MKCOL',
        headers: buildAuthHeaders(config),
      });
      if ([200, 201, 204, 301, 302, 405].includes(response.status)) {
        success = true;
        break;
      }
      lastResponse = response;
    }

    if (!success) {
      const detail = lastResponse ? await decodeErrorTextSafe(lastResponse) : '';
      const statusCode = lastResponse ? lastResponse.status : 'N/A';
      throw new Error(`WebDAV MKCOL failed (${statusCode}): ${detail || 'Unknown error'}`);
    }
  }
}

export async function uploadToWebDAV(arrayBuffer, storagePath, contentType, env = {}) {
  const config = getWebDAVConfig(env);
  if (!config.baseUrl) {
    throw new Error('WebDAV base URL is not configured.');
  }
  if (authMode(config) === 'none') {
    throw new Error('WebDAV auth is not configured.');
  }

  await ensureCollectionPath(config, storagePath);

  const response = await fetchDav(config, 'PUT', storagePath, {
    headers: {
      'Content-Type': contentType || 'application/octet-stream',
      'Content-Length': String(arrayBuffer.byteLength || 0),
    },
    body: arrayBuffer,
  });

  if (!response.ok && ![201, 204].includes(response.status)) {
    const detail = await decodeErrorTextSafe(response);
    throw new Error(`WebDAV upload failed (${response.status}): ${detail || 'Unknown error'}`);
  }

  return {
    path: normalizePath(storagePath),
    etag: response.headers.get('etag') || null,
  };
}

export async function getWebDAVFile(storagePath, env = {}, options = {}) {
  const config = getWebDAVConfig(env);
  if (!config.baseUrl) {
    throw new Error('WebDAV base URL is not configured.');
  }
  if (authMode(config) === 'none') {
    throw new Error('WebDAV auth is not configured.');
  }

  const headers = {};
  if (options.range) {
    headers.Range = options.range;
  }

  const attemptedModes = buildAuthAttemptModes(config);

  let firstFailure = null;

  for (const mode of attemptedModes) {
    const response = await fetchDavWithAuthMode(config, 'GET', storagePath, mode, { headers });
    if (response.ok || response.status === 206) {
      return response;
    }
    if (response.status === 404) {
      return null;
    }

    if (!firstFailure) {
      const detail = await decodeErrorTextSafe(response);
      firstFailure = { status: response.status, detail };
    }

    if (![400, 401, 403].includes(response.status)) {
      const detail = await decodeErrorTextSafe(response);
      throw new Error(`WebDAV download failed (${response.status}): ${detail || 'Unknown error'}`);
    }
  }

  if (firstFailure) {
    throw new Error(`WebDAV download failed (${firstFailure.status}): ${firstFailure.detail || 'Unknown error'}`);
  }

  throw new Error('WebDAV download failed: Unknown error');
}

export async function deleteWebDAVFile(storagePath, env = {}) {
  const config = getWebDAVConfig(env);
  if (!config.baseUrl) return false;
  if (authMode(config) === 'none') return false;

  const response = await fetchDav(config, 'DELETE', storagePath);
  if (response.ok || response.status === 404) return true;

  const detail = await decodeErrorTextSafe(response);
  throw new Error(`WebDAV delete failed (${response.status}): ${detail || 'Unknown error'}`);
}

export async function checkWebDAVConnection(env = {}) {
  if (!hasWebDAVConfig(env)) {
    return {
      connected: false,
      configured: false,
      message: 'Not configured',
    };
  }

  const config = getWebDAVConfig(env);
  try {
    const rootCandidates = getRootUrlCandidates(config);
    const propfindBody = [
      '<?xml version="1.0" encoding="utf-8" ?>',
      '<d:propfind xmlns:d="DAV:">',
      '  <d:prop><d:displayname /></d:prop>',
      '</d:propfind>',
    ].join('');

    let lastDetail = '';
    let lastStatus = null;

    const attemptedModes = buildAuthAttemptModes(config);

    for (const mode of attemptedModes) {
      for (const rootUrl of rootCandidates) {
        const optionsResponse = await fetch(rootUrl, {
          method: 'OPTIONS',
          headers: buildAuthOverrideHeaders(config, mode, { Depth: '0' }),
        });

        if (optionsResponse.ok) {
          return {
            connected: true,
            configured: true,
            status: optionsResponse.status,
            message: 'Connected',
          };
        }

        if (![400, 401, 403, 405].includes(optionsResponse.status)) {
          lastStatus = optionsResponse.status;
          lastDetail = await decodeErrorTextSafe(optionsResponse);
        }

        const propfindResponse = await fetch(rootUrl, {
          method: 'PROPFIND',
          headers: buildAuthOverrideHeaders(config, mode, {
            Depth: '0',
            'Content-Type': 'application/xml; charset=utf-8',
          }),
          body: propfindBody,
        });

        const connected = propfindResponse.ok || propfindResponse.status === 207;
        if (connected) {
          return {
            connected: true,
            configured: true,
            status: propfindResponse.status,
            message: 'Connected',
          };
        }

        lastStatus = propfindResponse.status;
        lastDetail = await decodeErrorTextSafe(propfindResponse);
      }
    }

    return {
      connected: false,
      configured: true,
      status: lastStatus || undefined,
      message: lastDetail || 'Connection failed',
      detail: lastDetail || undefined,
    };
  } catch (error) {
    return {
      connected: false,
      configured: true,
      message: error.message || 'Connection failed',
      detail: error.message || 'Connection failed',
    };
  }
}

export function normalizeWebDAVPath(value = '') {
  return normalizePath(value);
}
