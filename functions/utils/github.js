function normalizeToken(value) {
  if (!value) return '';
  return String(value).replace(/^Bearer\s+/i, '').trim();
}

function normalizeRepo(value) {
  if (!value) return '';
  const cleaned = String(value)
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^\/+|\/+$/g, '');
  const [owner, repo] = cleaned.split('/');
  if (!owner || !repo) return '';
  return `${owner}/${repo}`;
}

function normalizeApiBase(value) {
  if (!value) return 'https://api.github.com';
  try {
    return new URL(String(value)).toString().replace(/\/+$/, '');
  } catch {
    return 'https://api.github.com';
  }
}

function normalizeMode(value) {
  const mode = String(value || 'releases').trim().toLowerCase();
  return mode === 'contents' ? 'contents' : 'releases';
}

function normalizePath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').trim();
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

function encodePath(path) {
  const normalized = normalizePath(path);
  if (!normalized) return '';
  return normalized.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function arrayBufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function parseErrorBody(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const json = await response.json().catch(() => ({}));
    return json.message || json.error || JSON.stringify(json);
  }
  return response.text().catch(() => '');
}

function authHeaders(config, extra = {}, accept = null) {
  return {
    Authorization: `Bearer ${config.token}`,
    'User-Agent': 'k-vault-cloudflare-functions',
    Accept: accept || 'application/vnd.github+json',
    ...extra,
  };
}

function repoApi(config, pathname) {
  return `${config.apiBase}/repos/${config.repo}${pathname}`;
}

function contentsStoragePath(config, storageKey = '', fallbackName = '') {
  const keyPath = normalizePath(storageKey || fallbackName || `file_${Date.now()}`);
  if (!config.prefix) return keyPath;
  return keyPath ? `${config.prefix}/${keyPath}` : config.prefix;
}

function releaseAssetName(config, storageKey = '', fallbackName = '') {
  const path = contentsStoragePath(config, storageKey, fallbackName);
  return String(path || `file_${Date.now()}`).replace(/\//g, '__');
}

async function getContentsMetadata(config, pathInRepo) {
  const response = await fetch(repoApi(config, `/contents/${encodePath(pathInRepo)}`), {
    headers: authHeaders(config),
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    const detail = await parseErrorBody(response);
    throw new Error(`GitHub contents lookup failed (${response.status}): ${detail}`);
  }
  return response.json();
}

async function uploadViaContents(config, { arrayBuffer, storageKey, fileName }) {
  const maxSize = 20 * 1024 * 1024;
  if (arrayBuffer.byteLength > maxSize) {
    throw new Error('GitHub Contents mode is limited to 20MB.');
  }

  const pathInRepo = contentsStoragePath(config, storageKey, fileName);
  if (!pathInRepo) {
    throw new Error('GitHub Contents mode requires a valid storage path.');
  }

  const existing = await getContentsMetadata(config, pathInRepo);
  const payload = {
    message: `k-vault upload: ${pathInRepo}`,
    content: arrayBufferToBase64(arrayBuffer),
  };
  if (config.branch) payload.branch = config.branch;
  if (existing?.sha) payload.sha = existing.sha;

  const response = await fetch(repoApi(config, `/contents/${encodePath(pathInRepo)}`), {
    method: 'PUT',
    headers: authHeaders(config, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`GitHub contents upload failed (${response.status}): ${json.message || 'Unknown error'}`);
  }

  return {
    storagePath: pathInRepo,
    metadata: {
      githubMode: 'contents',
      githubPath: pathInRepo,
      githubSha: json.content?.sha || null,
      githubRepo: config.repo,
    },
  };
}

async function getReleaseByTag(config, tag, createIfMissing = false) {
  const response = await fetch(repoApi(config, `/releases/tags/${encodeURIComponent(tag)}`), {
    headers: authHeaders(config),
  });

  if (response.status === 404) {
    if (!createIfMissing) return null;
    return createRelease(config, tag);
  }
  if (!response.ok) {
    const detail = await parseErrorBody(response);
    throw new Error(`GitHub release lookup failed (${response.status}): ${detail}`);
  }
  return response.json();
}

async function getLatestRelease(config, createIfMissing = false) {
  const response = await fetch(repoApi(config, '/releases/latest'), {
    headers: authHeaders(config),
  });

  if (response.status === 404) {
    if (!createIfMissing) return null;
    return createRelease(config, 'k-vault-storage');
  }
  if (!response.ok) {
    const detail = await parseErrorBody(response);
    throw new Error(`GitHub latest release lookup failed (${response.status}): ${detail}`);
  }
  return response.json();
}

async function createRelease(config, tag) {
  const response = await fetch(repoApi(config, '/releases'), {
    method: 'POST',
    headers: authHeaders(config, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      tag_name: tag,
      name: tag,
      draft: false,
      prerelease: false,
    }),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`GitHub create release failed (${response.status}): ${json.message || 'Unknown error'}`);
  }
  return json;
}

async function ensureRelease(config) {
  if (config.releaseTag) {
    return getReleaseByTag(config, config.releaseTag, true);
  }
  return getLatestRelease(config, true);
}

async function listReleaseAssets(config, releaseId) {
  const response = await fetch(repoApi(config, `/releases/${releaseId}/assets?per_page=100`), {
    headers: authHeaders(config),
  });

  if (!response.ok) {
    const detail = await parseErrorBody(response);
    throw new Error(`GitHub release assets list failed (${response.status}): ${detail}`);
  }
  return response.json();
}

async function findReleaseAsset(config, releaseId, assetName) {
  const assets = await listReleaseAssets(config, releaseId);
  return assets.find((asset) => asset.name === assetName) || null;
}

async function deleteReleaseAssetById(config, assetId) {
  const response = await fetch(repoApi(config, `/releases/assets/${assetId}`), {
    method: 'DELETE',
    headers: authHeaders(config),
  });
  if (response.ok || response.status === 404) return true;
  const detail = await parseErrorBody(response);
  throw new Error(`GitHub release asset delete failed (${response.status}): ${detail}`);
}

async function uploadViaReleases(config, { arrayBuffer, storageKey, fileName, contentType }) {
  const release = await ensureRelease(config);
  const assetName = releaseAssetName(config, storageKey, fileName);

  const existing = await findReleaseAsset(config, release.id, assetName);
  if (existing?.id) {
    await deleteReleaseAssetById(config, existing.id);
  }

  const uploadUrl = new URL(String(release.upload_url || '').replace(/\{.+\}$/, ''));
  uploadUrl.searchParams.set('name', assetName);

  const response = await fetch(uploadUrl.toString(), {
    method: 'POST',
    headers: {
      ...authHeaders(config, {
        'Content-Type': contentType || 'application/octet-stream',
        'Content-Length': String(arrayBuffer.byteLength),
      }),
    },
    body: arrayBuffer,
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`GitHub release upload failed (${response.status}): ${json.message || 'Unknown error'}`);
  }

  return {
    storagePath: contentsStoragePath(config, storageKey, fileName),
    metadata: {
      githubMode: 'releases',
      githubRepo: config.repo,
      githubReleaseId: release.id,
      githubAssetId: json.id || null,
      githubAssetName: json.name || assetName,
      githubDownloadUrl: json.browser_download_url || '',
    },
  };
}

async function resolveReleaseAsset(config, storageKey, metadata = {}) {
  if (metadata.githubAssetId) {
    const response = await fetch(repoApi(config, `/releases/assets/${metadata.githubAssetId}`), {
      headers: authHeaders(config),
    });

    if (response.ok) {
      return response.json();
    }
    if (response.status !== 404) {
      const detail = await parseErrorBody(response);
      throw new Error(`GitHub release asset lookup failed (${response.status}): ${detail}`);
    }
  }

  const releaseId = metadata.githubReleaseId || (await ensureRelease(config)).id;
  const assetName = metadata.githubAssetName || releaseAssetName(config, storageKey);
  return findReleaseAsset(config, releaseId, assetName);
}

async function downloadViaContents(config, storageKey, metadata = {}, range = '') {
  const pathInRepo = metadata.githubPath || contentsStoragePath(config, storageKey);
  if (!pathInRepo) return null;

  const headers = {};
  if (range) headers.Range = range;

  const response = await fetch(repoApi(config, `/contents/${encodePath(pathInRepo)}`), {
    headers: authHeaders(config, headers, 'application/vnd.github.raw'),
    redirect: 'follow',
  });

  if (!response.ok && response.status !== 206) {
    if (response.status === 404) return null;
    const detail = await parseErrorBody(response);
    throw new Error(`GitHub contents download failed (${response.status}): ${detail}`);
  }

  return response;
}

async function downloadViaReleases(config, storageKey, metadata = {}, range = '') {
  const asset = await resolveReleaseAsset(config, storageKey, metadata);
  if (!asset?.id) return null;

  const headers = {};
  if (range) headers.Range = range;

  const assetApiResponse = await fetch(repoApi(config, `/releases/assets/${asset.id}`), {
    headers: authHeaders(config, headers, 'application/octet-stream'),
    redirect: 'manual',
  });

  if (assetApiResponse.status === 404) return null;
  if (assetApiResponse.status === 301 || assetApiResponse.status === 302) {
    const redirectUrl = assetApiResponse.headers.get('location');
    if (!redirectUrl) {
      throw new Error('GitHub release download redirect URL is missing.');
    }
    const response = await fetch(redirectUrl, {
      headers: range ? { Range: range } : {},
      redirect: 'follow',
    });
    if (!response.ok && response.status !== 206) {
      throw new Error(`GitHub release download failed (${response.status}).`);
    }
    return response;
  }

  if (!assetApiResponse.ok && assetApiResponse.status !== 206) {
    const detail = await parseErrorBody(assetApiResponse);
    throw new Error(`GitHub release download failed (${assetApiResponse.status}): ${detail}`);
  }

  return assetApiResponse;
}

async function deleteViaContents(config, storageKey, metadata = {}) {
  const pathInRepo = metadata.githubPath || contentsStoragePath(config, storageKey);
  if (!pathInRepo) return false;

  const existing = await getContentsMetadata(config, pathInRepo);
  if (!existing?.sha) return true;

  const payload = {
    message: `k-vault delete: ${pathInRepo}`,
    sha: existing.sha,
  };
  if (config.branch) payload.branch = config.branch;

  const response = await fetch(repoApi(config, `/contents/${encodePath(pathInRepo)}`), {
    method: 'DELETE',
    headers: authHeaders(config, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });

  if (response.ok || response.status === 404) return true;
  const detail = await parseErrorBody(response);
  throw new Error(`GitHub contents delete failed (${response.status}): ${detail}`);
}

async function deleteViaReleases(config, storageKey, metadata = {}) {
  const asset = await resolveReleaseAsset(config, storageKey, metadata);
  if (!asset?.id) return true;
  return deleteReleaseAssetById(config, asset.id);
}

export function getGitHubConfig(env = {}) {
  return {
    repo: normalizeRepo(env.GITHUB_REPO || ''),
    token: normalizeToken(env.GITHUB_TOKEN || ''),
    mode: normalizeMode(env.GITHUB_MODE || 'releases'),
    prefix: normalizePath(env.GITHUB_PREFIX || env.GITHUB_PATH || ''),
    releaseTag: String(env.GITHUB_RELEASE_TAG || '').trim(),
    branch: String(env.GITHUB_BRANCH || '').trim(),
    apiBase: normalizeApiBase(env.GITHUB_API_BASE || 'https://api.github.com'),
  };
}

export function hasGitHubConfig(env = {}) {
  const config = getGitHubConfig(env);
  return Boolean(config.repo && config.token);
}

export async function uploadToGitHub(arrayBuffer, storageKey, fileName, contentType, env = {}) {
  const config = getGitHubConfig(env);
  if (!config.repo || !config.token) {
    throw new Error('GitHub storage is not configured.');
  }

  if (config.mode === 'contents') {
    return uploadViaContents(config, { arrayBuffer, storageKey, fileName, contentType });
  }
  return uploadViaReleases(config, { arrayBuffer, storageKey, fileName, contentType });
}

export async function getGitHubFile(storageKey, metadata = {}, env = {}, options = {}) {
  const config = getGitHubConfig(env);
  if (!config.repo || !config.token) {
    throw new Error('GitHub storage is not configured.');
  }

  const mode = String(metadata.githubMode || config.mode || 'releases').toLowerCase();
  if (mode === 'contents') {
    return downloadViaContents(config, storageKey, metadata, options.range || '');
  }
  return downloadViaReleases(config, storageKey, metadata, options.range || '');
}

export async function deleteGitHubFile(storageKey, metadata = {}, env = {}) {
  const config = getGitHubConfig(env);
  if (!config.repo || !config.token) {
    return false;
  }

  const mode = String(metadata.githubMode || config.mode || 'releases').toLowerCase();
  if (mode === 'contents') {
    return deleteViaContents(config, storageKey, metadata);
  }
  return deleteViaReleases(config, storageKey, metadata);
}

export async function checkGitHubConnection(env = {}) {
  if (!hasGitHubConfig(env)) {
    return {
      connected: false,
      configured: false,
      message: 'Not configured',
    };
  }

  const config = getGitHubConfig(env);
  try {
    const repoResponse = await fetch(repoApi(config, ''), {
      headers: authHeaders(config),
    });
    if (!repoResponse.ok) {
      const detail = await parseErrorBody(repoResponse);
      return {
        connected: false,
        configured: true,
        status: repoResponse.status,
        message: detail || 'Repository access failed',
        detail: detail || undefined,
      };
    }

    if (config.mode === 'contents') {
      return {
        connected: true,
        configured: true,
        mode: 'contents',
        message: 'Connected',
      };
    }

    if (config.releaseTag) {
      const release = await getReleaseByTag(config, config.releaseTag, false);
      if (!release) {
        return {
          connected: false,
          configured: true,
          mode: 'releases',
          message: `Release tag "${config.releaseTag}" does not exist`,
        };
      }
    }

    return {
      connected: true,
      configured: true,
      mode: 'releases',
      message: 'Connected',
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

export function normalizeGitHubStoragePath(value = '') {
  return normalizePath(value);
}
