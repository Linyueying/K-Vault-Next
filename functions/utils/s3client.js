/**
 * S3 兼容存储客户端
 * 使用 AWS Signature V4 签名，纯 Web API 实现
 * 兼容 AWS S3、MinIO、BackBlaze B2、阿里云 OSS 等
 */

// --- 加密工具 ---

async function sha256Hex(data) {
    const buffer = typeof data === 'string'
        ? new TextEncoder().encode(data)
        : data;
    const hash = await crypto.subtle.digest('SHA-256', buffer);
    return arrayBufferToHex(hash);
}

async function hmacSha256(key, data) {
    const keyBuffer = typeof key === 'string'
        ? new TextEncoder().encode(key)
        : key;
    const dataBuffer = typeof data === 'string'
        ? new TextEncoder().encode(data)
        : data;

    const cryptoKey = await crypto.subtle.importKey(
        'raw', keyBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    return await crypto.subtle.sign('HMAC', cryptoKey, dataBuffer);
}

function arrayBufferToHex(buffer) {
    return Array.from(new Uint8Array(buffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

// URI 编码 (RFC 3986)
function uriEncode(str, encodeSlash = true) {
    let encoded = encodeURIComponent(str);
    // AWS 要求的额外字符编码
    encoded = encoded.replace(/!/g, '%21')
        .replace(/'/g, '%27')
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29')
        .replace(/\*/g, '%2A');
    if (!encodeSlash) {
        encoded = encoded.replace(/%2F/g, '/');
    }
    return encoded;
}

// --- AWS Signature V4 签名 ---

async function signRequest(method, url, headers, body, credentials) {
    const { accessKeyId, secretAccessKey, region, service } = credentials;
    const parsedUrl = new URL(url);

    // 时间戳
    const now = new Date();
    const dateStamp = now.toISOString().replace(/[-:.TZ]/g, '').substring(0, 8);
    const amzDate = dateStamp + 'T' + now.toISOString().replace(/[-:.Z]/g, '').substring(9, 15) + 'Z';

    // 计算 payload hash
    const payloadHash = body
        ? await sha256Hex(body instanceof ArrayBuffer ? new Uint8Array(body) : body)
        : await sha256Hex('');

    // 设置必需的头
    headers['x-amz-date'] = amzDate;
    headers['x-amz-content-sha256'] = payloadHash;
    headers['host'] = parsedUrl.host;

    // 1. Canonical Request
    const canonicalUri = uriEncode(parsedUrl.pathname, false);
    const canonicalQueryString = [...parsedUrl.searchParams]
        .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
        .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
        .join('&');

    const sortedHeaders = Object.entries(headers)
        .map(([k, v]) => [k.toLowerCase().trim(), v.toString().trim()])
        .sort((a, b) => a[0].localeCompare(b[0]));

    const canonicalHeaders = sortedHeaders.map(([k, v]) => `${k}:${v}\n`).join('');
    const signedHeaders = sortedHeaders.map(([k]) => k).join(';');

    const canonicalRequest = [
        method, canonicalUri, canonicalQueryString,
        canonicalHeaders, signedHeaders, payloadHash
    ].join('\n');

    // 2. String to Sign
    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
        'AWS4-HMAC-SHA256', amzDate, credentialScope,
        await sha256Hex(canonicalRequest)
    ].join('\n');

    // 3. Signing Key
    const kDate = await hmacSha256('AWS4' + secretAccessKey, dateStamp);
    const kRegion = await hmacSha256(kDate, region);
    const kService = await hmacSha256(kRegion, service);
    const kSigning = await hmacSha256(kService, 'aws4_request');

    // 4. Signature
    const signature = arrayBufferToHex(await hmacSha256(kSigning, stringToSign));

    // 5. Authorization Header
    headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return headers;
}

// --- S3 Client 类 ---

export class S3Client {
    constructor(config) {
        this.endpoint = config.endpoint.replace(/\/$/, '');
        this.region = config.region || 'us-east-1';
        this.bucket = config.bucket;
        this.accessKeyId = config.accessKeyId;
        this.secretAccessKey = config.secretAccessKey;
    }

    _getUrl(key) {
        // 使用 path-style URL 以兼容所有 S3 服务
        return `${this.endpoint}/${this.bucket}/${key}`;
    }

    _getCredentials() {
        return {
            accessKeyId: this.accessKeyId,
            secretAccessKey: this.secretAccessKey,
            region: this.region,
            service: 's3'
        };
    }

    /**
     * 上传文件
     */
    async putObject(key, body, options = {}) {
        const url = this._getUrl(key);
        const headers = {};

        if (options.contentType) {
            headers['content-type'] = options.contentType;
        }
        if (body instanceof ArrayBuffer || body instanceof Uint8Array) {
            headers['content-length'] = (body instanceof ArrayBuffer ? body.byteLength : body.length).toString();
        }

        // 自定义元数据
        if (options.metadata) {
            for (const [k, v] of Object.entries(options.metadata)) {
                const hKey = k.startsWith('x-amz-meta-') ? k : `x-amz-meta-${k}`;
                headers[hKey] = v;
            }
        }

        const signedHeaders = await signRequest('PUT', url, { ...headers }, body, this._getCredentials());

        const response = await fetch(url, {
            method: 'PUT',
            headers: signedHeaders,
            body: body
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`S3 PutObject failed (${response.status}): ${text}`);
        }

        return { etag: response.headers.get('etag') };
    }

    /**
     * 获取文件
     */
    async getObject(key, options = {}) {
        const url = this._getUrl(key);
        const headers = {};

        if (options.range) {
            headers['range'] = options.range;
        }

        const signedHeaders = await signRequest('GET', url, { ...headers }, null, this._getCredentials());

        const response = await fetch(url, {
            method: 'GET',
            headers: signedHeaders
        });

        if (!response.ok && response.status !== 206) {
            if (response.status === 404) return null;
            const text = await response.text();
            throw new Error(`S3 GetObject failed (${response.status}): ${text}`);
        }

        return response;
    }

    /**
     * 删除文件
     */
    async deleteObject(key) {
        const url = this._getUrl(key);
        const signedHeaders = await signRequest('DELETE', url, {}, null, this._getCredentials());

        const response = await fetch(url, {
            method: 'DELETE',
            headers: signedHeaders
        });

        if (!response.ok && response.status !== 204) {
            const text = await response.text();
            throw new Error(`S3 DeleteObject failed (${response.status}): ${text}`);
        }

        return true;
    }

    /**
     * 获取文件头信息
     */
    async headObject(key) {
        const url = this._getUrl(key);
        const signedHeaders = await signRequest('HEAD', url, {}, null, this._getCredentials());

        const response = await fetch(url, {
            method: 'HEAD',
            headers: signedHeaders
        });

        if (!response.ok) {
            if (response.status === 404) return null;
            throw new Error(`S3 HeadObject failed (${response.status})`);
        }

        return {
            contentLength: parseInt(response.headers.get('content-length') || '0'),
            contentType: response.headers.get('content-type'),
            etag: response.headers.get('etag'),
            lastModified: response.headers.get('last-modified')
        };
    }

    /**
     * 检查连接（列出 bucket）
     */
    async checkConnection() {
        const url = `${this.endpoint}/${this.bucket}?list-type=2&max-keys=1`;
        const signedHeaders = await signRequest('GET', url, {}, null, this._getCredentials());

        const response = await fetch(url, {
            method: 'GET',
            headers: signedHeaders
        });

        return response.ok;
    }
}

/**
 * 创建 S3 客户端实例
 */
export function createS3Client(env) {
    if (!env.S3_ENDPOINT || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY || !env.S3_BUCKET) {
        throw new Error('S3 配置不完整，需要 S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET');
    }

    return new S3Client({
        endpoint: env.S3_ENDPOINT,
        region: env.S3_REGION || 'us-east-1',
        bucket: env.S3_BUCKET,
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY
    });
}
