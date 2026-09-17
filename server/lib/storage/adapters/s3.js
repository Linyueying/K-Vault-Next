async function sha256Hex(data) {
  const buffer = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return arrayBufferToHex(hash);
}

async function hmacSha256(key, data) {
  const keyBuffer = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const dataBuffer = typeof data === 'string' ? new TextEncoder().encode(data) : data;

  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return await crypto.subtle.sign('HMAC', cryptoKey, dataBuffer);
}

function arrayBufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function uriEncode(value, encodeSlash = true) {
  let encoded = encodeURIComponent(value)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
  if (!encodeSlash) {
    encoded = encoded.replace(/%2F/g, '/');
  }
  return encoded;
}

async function signRequest(method, url, headers, body, credentials) {
  const { accessKeyId, secretAccessKey, region, service } = credentials;
  const parsedUrl = new URL(url);
  const now = new Date();

  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const amzDate = `${dateStamp}T${now.toISOString().slice(11, 19).replace(/:/g, '')}Z`;

  const payloadHash = body
    ? await sha256Hex(body instanceof ArrayBuffer ? new Uint8Array(body) : body)
    : await sha256Hex('');

  headers['x-amz-date'] = amzDate;
  headers['x-amz-content-sha256'] = payloadHash;
  headers.host = parsedUrl.host;

  const canonicalUri = uriEncode(parsedUrl.pathname, false);
  const canonicalQueryString = [...parsedUrl.searchParams.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
    .map(([key, value]) => `${uriEncode(key)}=${uriEncode(value)}`)
    .join('&');

  const normalizedHeaders = Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase().trim(), String(value).trim()])
    .sort((a, b) => a[0].localeCompare(b[0]));

  const canonicalHeaders = normalizedHeaders.map(([key, value]) => `${key}:${value}\n`).join('');
  const signedHeaders = normalizedHeaders.map(([key]) => key).join(';');

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = await hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, 'aws4_request');
  const signature = arrayBufferToHex(await hmacSha256(kSigning, stringToSign));

  headers.Authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

class S3CompatAdapter {
  constructor(config, type = 's3') {
    this.type = type;
    this.config = {
      endpoint: (config.endpoint || '').replace(/\/+$/, ''),
      region: config.region || 'us-east-1',
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    };
  }

  validate() {
    const { endpoint, bucket, accessKeyId, secretAccessKey } = this.config;
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      throw new Error(`${this.type.toUpperCase()} storage requires endpoint, bucket, accessKeyId and secretAccessKey.`);
    }
  }

  getCredentials() {
    return {
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      region: this.config.region,
      service: 's3',
    };
  }

  objectUrl(key) {
    return `${this.config.endpoint}/${this.config.bucket}/${key}`;
  }

  async signedFetch(method, url, headers = {}, body = null) {
    const signed = await signRequest(method, url, { ...headers }, body, this.getCredentials());
    return fetch(url, {
      method,
      headers: signed,
      body,
    });
  }

  async testConnection() {
    this.validate();
    const url = `${this.config.endpoint}/${this.config.bucket}?list-type=2&max-keys=1`;
    const response = await this.signedFetch('GET', url);
    return {
      connected: response.ok,
      status: response.status,
    };
  }

  async upload({ storageKey, buffer, mimeType, fileName }) {
    this.validate();

    const headers = {
      'content-type': mimeType || 'application/octet-stream',
      'content-length': String(buffer.byteLength),
      'x-amz-meta-filename': fileName || '',
      'x-amz-meta-uploadtime': String(Date.now()),
    };

    const response = await this.signedFetch('PUT', this.objectUrl(storageKey), headers, buffer);
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`S3 upload failed (${response.status}): ${text}`);
    }

    return {
      storageKey,
      metadata: {
        etag: response.headers.get('etag') || null,
      },
    };
  }

  async download({ storageKey, range }) {
    this.validate();
    const headers = {};
    if (range) headers.range = range;

    const response = await this.signedFetch('GET', this.objectUrl(storageKey), headers);
    if (!response.ok && response.status !== 206) {
      if (response.status === 404) return null;
      throw new Error(`S3 download failed (${response.status})`);
    }
    return response;
  }

  async head({ storageKey }) {
    this.validate();
    const response = await this.signedFetch('HEAD', this.objectUrl(storageKey));
    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`S3 head failed (${response.status})`);
    }
    return {
      contentType: response.headers.get('content-type'),
      contentLength: Number(response.headers.get('content-length') || 0),
      etag: response.headers.get('etag'),
    };
  }

  async delete({ storageKey }) {
    this.validate();
    const response = await this.signedFetch('DELETE', this.objectUrl(storageKey));
    return Boolean(response.ok || response.status === 204 || response.status === 404);
  }
}

module.exports = {
  S3CompatAdapter,
};
