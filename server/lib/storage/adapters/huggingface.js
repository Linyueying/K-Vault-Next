function normalizeToken(value) {
  if (!value) return '';
  return String(value).replace(/^Bearer\s+/i, '').trim();
}

function normalizeRepo(value) {
  if (!value) return '';
  return String(value)
    .trim()
    .replace(/^https?:\/\/huggingface\.co\//i, '')
    .replace(/^datasets\//i, '')
    .replace(/^\/+|\/+$/g, '');
}

function toBase64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

function commitUrl(repo, branch = 'main') {
  return `https://huggingface.co/api/datasets/${repo}/commit/${encodeURIComponent(branch)}`;
}

function resolveUrl(repo, pathInRepo) {
  return `https://huggingface.co/datasets/${repo}/resolve/main/${pathInRepo}`;
}

class HuggingFaceStorageAdapter {
  constructor(config) {
    this.type = 'huggingface';
    this.config = {
      token: normalizeToken(config.token),
      repo: normalizeRepo(config.repo),
    };
  }

  validate() {
    if (!this.config.token || !this.config.repo) {
      throw new Error('HuggingFace storage requires token and repo.');
    }
  }

  authHeaders(extra = {}) {
    return {
      Authorization: `Bearer ${this.config.token}`,
      ...extra,
    };
  }

  async testConnection() {
    this.validate();

    const response = await fetch(`https://huggingface.co/api/datasets/${this.config.repo}`, {
      headers: this.authHeaders(),
    });

    return {
      connected: response.ok,
      status: response.status,
    };
  }

  async upload({ storageKey, buffer, fileName }) {
    this.validate();

    // Basic implementation keeps reliability high; large files should use S3/R2/Telegram.
    const maxSize = 35 * 1024 * 1024;
    if (buffer.byteLength > maxSize) {
      throw new Error('HuggingFace regular upload limit exceeded (35MB).');
    }

    const pathInRepo = storageKey;
    const body = [
      JSON.stringify({ key: 'header', value: { summary: `Upload ${fileName || pathInRepo}` } }),
      JSON.stringify({
        key: 'file',
        value: {
          path: pathInRepo,
          encoding: 'base64',
          content: toBase64(buffer),
        },
      }),
    ].join('\n');

    const response = await fetch(commitUrl(this.config.repo), {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/x-ndjson' }),
      body,
    });

    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(json.error || json.message || `HuggingFace upload failed (${response.status}).`);
    }

    return {
      storageKey: pathInRepo,
      metadata: {
        hfPath: pathInRepo,
        hfCommit: json.commitOid || null,
      },
    };
  }

  async download({ metadata = {}, storageKey, range }) {
    const pathInRepo = metadata.hfPath || storageKey;
    const headers = {};
    if (this.config.token) {
      headers.Authorization = `Bearer ${this.config.token}`;
    }
    if (range) headers.Range = range;

    const response = await fetch(resolveUrl(this.config.repo, pathInRepo), {
      headers,
      redirect: 'follow',
    });

    if (!response.ok && response.status !== 206) {
      if (response.status === 404) return null;
      throw new Error(`HuggingFace download failed (${response.status}).`);
    }

    return response;
  }

  async delete({ metadata = {}, storageKey }) {
    this.validate();

    const pathInRepo = metadata.hfPath || storageKey;
    const body = [
      JSON.stringify({ key: 'header', value: { summary: `Delete ${pathInRepo}` } }),
      JSON.stringify({ key: 'deletedFile', value: { path: pathInRepo } }),
    ].join('\n');

    const response = await fetch(commitUrl(this.config.repo), {
      method: 'POST',
      headers: this.authHeaders({ 'Content-Type': 'application/x-ndjson' }),
      body,
    });

    return Boolean(response.ok);
  }
}

module.exports = {
  HuggingFaceStorageAdapter,
};
