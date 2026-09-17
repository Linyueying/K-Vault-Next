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
  const normalized = String(value || 'releases').trim().toLowerCase();
  if (normalized === 'contents') return 'contents';
  return 'releases';
}

function normalizePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/');
}

function encodePath(path) {
  const normalized = normalizePath(path);
  if (!normalized) return '';
  return normalized.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

async function parseErrorBody(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const json = await response.json().catch(() => ({}));
    return json.message || json.error || JSON.stringify(json);
  }
  return response.text().catch(() => '');
}

class GitHubStorageAdapter {
  constructor(config) {
    this.type = 'github';
    this.config = {
      repo: normalizeRepo(config.repo),
      token: normalizeToken(config.token),
      mode: normalizeMode(config.mode),
      prefix: normalizePath(config.prefix || config.path),
      releaseTag: String(config.releaseTag || config.tag || '').trim(),
      branch: String(config.branch || '').trim(),
      apiBase: normalizeApiBase(config.apiBase),
    };

    this.cachedRelease = null;
  }

  validate() {
    if (!this.config.repo || !this.config.token) {
      throw new Error('GitHub storage requires repo and token.');
    }

    if (!['releases', 'contents'].includes(this.config.mode)) {
      throw new Error('GitHub storage mode must be "releases" or "contents".');
    }
  }

  authHeaders(extra = {}, overrideAccept = null) {
    const headers = {
      Authorization: `Bearer ${this.config.token}`,
      'User-Agent': 'k-vault-storage-adapter',
      Accept: overrideAccept || 'application/vnd.github+json',
      ...extra,
    };
    return headers;
  }

  repoApi(pathname) {
    return `${this.config.apiBase}/repos/${this.config.repo}${pathname}`;
  }

  contentsPath(storageKey = '') {
    const keyPath = normalizePath(storageKey);
    if (!this.config.prefix) return keyPath;
    return keyPath ? `${this.config.prefix}/${keyPath}` : this.config.prefix;
  }

  releaseAssetName(storageKey = '', fallbackName = '') {
    const keyPath = normalizePath(storageKey || fallbackName || `file_${Date.now()}`);
    const merged = this.config.prefix ? `${this.config.prefix}/${keyPath}` : keyPath;
    return merged.replace(/\//g, '__');
  }

  async testConnection() {
    this.validate();

    const repoResponse = await fetch(this.repoApi(''), {
      headers: this.authHeaders(),
    });

    if (!repoResponse.ok) {
      const detail = await parseErrorBody(repoResponse);
      return {
        connected: false,
        status: repoResponse.status,
        detail: detail || 'GitHub repository access failed.',
      };
    }

    if (this.config.mode === 'contents') {
      return {
        connected: true,
        mode: 'contents',
        limit: 'Recommended for small files/text workloads; API write throughput and size are limited.',
      };
    }

    if (this.config.releaseTag) {
      const release = await this.getReleaseByTag(this.config.releaseTag, false);
      if (!release) {
        return {
          connected: false,
          mode: 'releases',
          detail: `Release tag "${this.config.releaseTag}" does not exist.`,
        };
      }
    }

    return {
      connected: true,
      mode: 'releases',
      limit: 'Uses GitHub Release assets. Large binaries are supported better than Contents API.',
    };
  }

  async getContentsMetadata(pathInRepo) {
    const response = await fetch(this.repoApi(`/contents/${encodePath(pathInRepo)}`), {
      headers: this.authHeaders(),
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      const detail = await parseErrorBody(response);
      throw new Error(`GitHub contents lookup failed (${response.status}): ${detail}`);
    }
    return response.json();
  }

  async uploadViaContents({ storageKey, buffer, fileName }) {
    const maxSize = 20 * 1024 * 1024;
    if (buffer.byteLength > maxSize) {
      throw new Error('GitHub Contents mode upload limit exceeded (20MB practical cap in K-Vault).');
    }

    const pathInRepo = this.contentsPath(storageKey || fileName);
    if (!pathInRepo) {
      throw new Error('GitHub Contents mode requires a valid path or prefix.');
    }

    const existing = await this.getContentsMetadata(pathInRepo);
    const payload = {
      message: `k-vault upload: ${pathInRepo}`,
      content: Buffer.from(buffer).toString('base64'),
    };
    if (this.config.branch) payload.branch = this.config.branch;
    if (existing?.sha) payload.sha = existing.sha;

    const response = await fetch(this.repoApi(`/contents/${encodePath(pathInRepo)}`), {
      method: 'PUT',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });

    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`GitHub contents upload failed (${response.status}): ${json.message || 'Unknown error'}`);
    }

    return {
      storageKey,
      metadata: {
        githubMode: 'contents',
        githubPath: pathInRepo,
        githubSha: json.content?.sha || null,
      },
    };
  }

  async downloadViaContents({ storageKey, metadata = {}, range }) {
    const pathInRepo = metadata.githubPath || this.contentsPath(storageKey);
    if (!pathInRepo) return null;

    const headers = {};
    if (range) headers.Range = range;

    const response = await fetch(this.repoApi(`/contents/${encodePath(pathInRepo)}`), {
      headers: this.authHeaders(headers, 'application/vnd.github.raw'),
      redirect: 'follow',
    });

    if (!response.ok && response.status !== 206) {
      if (response.status === 404) return null;
      const detail = await parseErrorBody(response);
      throw new Error(`GitHub contents download failed (${response.status}): ${detail}`);
    }

    return response;
  }

  async deleteViaContents({ storageKey, metadata = {} }) {
    const pathInRepo = metadata.githubPath || this.contentsPath(storageKey);
    if (!pathInRepo) return false;

    const existing = await this.getContentsMetadata(pathInRepo);
    if (!existing?.sha) return true;

    const payload = {
      message: `k-vault delete: ${pathInRepo}`,
      sha: existing.sha,
    };
    if (this.config.branch) payload.branch = this.config.branch;

    const response = await fetch(this.repoApi(`/contents/${encodePath(pathInRepo)}`), {
      method: 'DELETE',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });

    if (response.ok || response.status === 404) return true;

    const detail = await parseErrorBody(response);
    throw new Error(`GitHub contents delete failed (${response.status}): ${detail}`);
  }

  async getReleaseByTag(tag, createIfMissing = false) {
    const response = await fetch(this.repoApi(`/releases/tags/${encodeURIComponent(tag)}`), {
      headers: this.authHeaders(),
    });

    if (response.status === 404) {
      if (!createIfMissing) return null;
      return this.createRelease(tag);
    }
    if (!response.ok) {
      const detail = await parseErrorBody(response);
      throw new Error(`GitHub release lookup failed (${response.status}): ${detail}`);
    }
    return response.json();
  }

  async getLatestRelease(createIfMissing = false) {
    const response = await fetch(this.repoApi('/releases/latest'), {
      headers: this.authHeaders(),
    });

    if (response.status === 404) {
      if (!createIfMissing) return null;
      return this.createRelease('k-vault-storage');
    }
    if (!response.ok) {
      const detail = await parseErrorBody(response);
      throw new Error(`GitHub latest release lookup failed (${response.status}): ${detail}`);
    }
    return response.json();
  }

  async createRelease(tag) {
    const response = await fetch(this.repoApi('/releases'), {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/json' }),
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

  async ensureRelease() {
    if (this.cachedRelease?.id) {
      return this.cachedRelease;
    }

    const release = this.config.releaseTag
      ? await this.getReleaseByTag(this.config.releaseTag, true)
      : await this.getLatestRelease(true);

    this.cachedRelease = release;
    return release;
  }

  parseUploadUrl(template) {
    return String(template || '').replace(/\{.+\}$/, '');
  }

  async listReleaseAssets(releaseId) {
    const response = await fetch(this.repoApi(`/releases/${releaseId}/assets?per_page=100`), {
      headers: this.authHeaders(),
    });

    if (!response.ok) {
      const detail = await parseErrorBody(response);
      throw new Error(`GitHub release assets list failed (${response.status}): ${detail}`);
    }
    return response.json();
  }

  async findReleaseAsset({ releaseId, assetName }) {
    const assets = await this.listReleaseAssets(releaseId);
    return assets.find((asset) => asset.name === assetName) || null;
  }

  async deleteReleaseAssetById(assetId) {
    const response = await fetch(this.repoApi(`/releases/assets/${assetId}`), {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
    if (response.ok || response.status === 404) return true;
    const detail = await parseErrorBody(response);
    throw new Error(`GitHub release asset delete failed (${response.status}): ${detail}`);
  }

  async uploadViaReleases({ storageKey, buffer, mimeType, fileName }) {
    const release = await this.ensureRelease();
    const assetName = this.releaseAssetName(storageKey, fileName);

    const existing = await this.findReleaseAsset({
      releaseId: release.id,
      assetName,
    });

    if (existing?.id) {
      await this.deleteReleaseAssetById(existing.id);
    }

    const uploadUrl = new URL(this.parseUploadUrl(release.upload_url));
    uploadUrl.searchParams.set('name', assetName);

    const response = await fetch(uploadUrl.toString(), {
      method: 'POST',
      headers: {
        ...this.authHeaders({
          'Content-Type': mimeType || 'application/octet-stream',
          'Content-Length': String(buffer.byteLength),
        }),
      },
      body: buffer,
    });

    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`GitHub release upload failed (${response.status}): ${json.message || 'Unknown error'}`);
    }

    return {
      storageKey,
      metadata: {
        githubMode: 'releases',
        githubReleaseId: release.id,
        githubAssetId: json.id || null,
        githubAssetName: json.name || assetName,
        githubDownloadUrl: json.browser_download_url || '',
      },
    };
  }

  async resolveReleaseAsset({ storageKey, metadata = {} }) {
    if (metadata.githubAssetId) {
      const response = await fetch(this.repoApi(`/releases/assets/${metadata.githubAssetId}`), {
        headers: this.authHeaders(),
      });

      if (response.ok) {
        const json = await response.json();
        return json;
      }

      if (response.status !== 404) {
        const detail = await parseErrorBody(response);
        throw new Error(`GitHub release asset lookup failed (${response.status}): ${detail}`);
      }
    }

    const releaseId = metadata.githubReleaseId || (await this.ensureRelease()).id;
    const assetName = metadata.githubAssetName || this.releaseAssetName(storageKey);
    return this.findReleaseAsset({ releaseId, assetName });
  }

  async downloadViaReleases({ storageKey, metadata = {}, range }) {
    const asset = await this.resolveReleaseAsset({ storageKey, metadata });
    if (!asset?.id) return null;

    const headers = {};
    if (range) headers.Range = range;

    const assetApiResponse = await fetch(this.repoApi(`/releases/assets/${asset.id}`), {
      headers: this.authHeaders(headers, 'application/octet-stream'),
      redirect: 'manual',
    });

    if (assetApiResponse.status === 404) return null;
    if (assetApiResponse.status === 302 || assetApiResponse.status === 301) {
      const redirectUrl = assetApiResponse.headers.get('location');
      if (!redirectUrl) {
        throw new Error('GitHub release download redirect location missing.');
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

  async deleteViaReleases({ storageKey, metadata = {} }) {
    const asset = await this.resolveReleaseAsset({ storageKey, metadata });
    if (!asset?.id) return true;
    return this.deleteReleaseAssetById(asset.id);
  }

  async upload(payload) {
    this.validate();
    if (this.config.mode === 'contents') {
      return this.uploadViaContents(payload);
    }
    return this.uploadViaReleases(payload);
  }

  async download(payload) {
    this.validate();
    if (this.config.mode === 'contents') {
      return this.downloadViaContents(payload);
    }
    return this.downloadViaReleases(payload);
  }

  async delete(payload) {
    this.validate();
    if (this.config.mode === 'contents') {
      return this.deleteViaContents(payload);
    }
    return this.deleteViaReleases(payload);
  }
}

module.exports = {
  GitHubStorageAdapter,
};
