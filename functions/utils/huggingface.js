/**
 * HuggingFace Datasets 存储工具模块
 * 使用 HF Hub API 上传/下载/删除文件
 */

const HF_BASE_URL = 'https://huggingface.co';

function stripWrappingQuotes(value) {
    return value.replace(/^['"]+|['"]+$/g, '');
}

function normalizeHFToken(rawToken) {
    if (!rawToken) return '';
    let token = stripWrappingQuotes(String(rawToken).trim());
    token = token.replace(/^Bearer\s+/i, '').trim();
    return token;
}

function normalizeHFRepo(rawRepo) {
    if (!rawRepo) return '';

    let repo = stripWrappingQuotes(String(rawRepo).trim());

    // 允许填写完整 URL / datasets 前缀 / 纯 repoId
    repo = repo
        .replace(/^https?:\/\/huggingface\.co\//i, '')
        .replace(/^datasets\//i, '')
        .replace(/^\/+|\/+$/g, '');

    const parts = repo.split('/').filter(Boolean);
    if (parts.length < 2) return '';

    return `${parts[0]}/${parts[1]}`;
}

function getCommitUrl(repoId, branch = 'main') {
    return `${HF_BASE_URL}/api/datasets/${repoId}/commit/${encodeURIComponent(branch)}`;
}

function getLfsBatchUrl(repoId) {
    return `${HF_BASE_URL}/datasets/${repoId}.git/info/lfs/objects/batch`;
}

/**
 * 统一解析配置，避免因空格、引号、Bearer 前缀等导致误判
 */
export function getHuggingFaceConfig(env = {}) {
    const token = normalizeHFToken(env.HF_TOKEN);
    const repo = normalizeHFRepo(env.HF_REPO);

    return {
        token,
        repo,
        configured: Boolean(token && repo)
    };
}

export function hasHuggingFaceConfig(env = {}) {
    return getHuggingFaceConfig(env).configured;
}

/**
 * ArrayBuffer 转 Base64（Cloudflare Workers 兼容）
 */
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = '';

    for (let i = 0; i < bytes.byteLength; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode(...chunk);
    }

    return btoa(binary);
}

function createCommitBody(lines) {
    return lines.map((line) => JSON.stringify(line)).join('\n');
}

async function readHFError(response) {
    const text = await response.text();
    if (!text) return '未知错误';

    try {
        const data = JSON.parse(text);
        return data.error || data.message || text;
    } catch {
        return text;
    }
}

async function detectUploadMode(pathInRepo, fileBuffer, token, repo) {
    const bytes = new Uint8Array(fileBuffer);
    const sampleBytes = bytes.slice(0, Math.min(bytes.byteLength, 512));
    const sampleBase64 = arrayBufferToBase64(sampleBytes.buffer);

    const response = await fetch(
        `${HF_BASE_URL}/api/datasets/${repo}/preupload/main`,
        {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                files: [{
                    path: pathInRepo,
                    size: bytes.byteLength,
                    sample: sampleBase64
                }]
            })
        }
    );

    if (!response.ok) {
        const errorText = await readHFError(response);
        return {
            success: false,
            error: `HF 预上传检查失败 (${response.status}): ${errorText}`
        };
    }

    const data = await response.json();
    const files = Array.isArray(data?.files) ? data.files : [];
    const fileInfo = files.find((item) => item.path === pathInRepo) || files[0];

    return {
        success: true,
        uploadMode: fileInfo?.uploadMode || 'regular'
    };
}

async function sha256Hex(arrayBuffer) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
    const hashBytes = new Uint8Array(hashBuffer);

    return Array.from(hashBytes)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

function getUploadHeaders(header = {}) {
    const result = {};

    for (const [key, value] of Object.entries(header)) {
        if (key === 'chunk_size' || /^\d+$/.test(key)) {
            continue;
        }
        if (value != null) {
            result[key] = value;
        }
    }

    return result;
}

async function uploadLfsObject(fileBuffer, oid, uploadAction) {
    if (!uploadAction?.href) {
        return { success: false, error: 'HF LFS 返回了无效的上传地址' };
    }

    const header = uploadAction.header || {};
    const chunkSize = Number(header.chunk_size || 0);
    const partKeys = Object.keys(header)
        .filter((key) => /^\d+$/.test(key))
        .sort((a, b) => Number(a) - Number(b));

    if (chunkSize > 0 && partKeys.length > 0) {
        const completeReq = {
            oid,
            parts: []
        };

        for (const part of partKeys) {
            const index = Number(part) - 1;
            const start = index * chunkSize;
            const end = Math.min(start + chunkSize, fileBuffer.byteLength);
            const chunk = fileBuffer.slice(start, end);

            const partResponse = await fetch(header[part], {
                method: 'PUT',
                body: chunk
            });

            if (!partResponse.ok) {
                const errorText = await readHFError(partResponse);
                return {
                    success: false,
                    error: `HF LFS 分片上传失败 (${partResponse.status}): ${errorText}`
                };
            }

            const eTag = partResponse.headers.get('ETag');
            if (!eTag) {
                return { success: false, error: 'HF LFS 分片上传缺少 ETag' };
            }

            completeReq.parts.push({
                partNumber: Number(part),
                etag: eTag
            });
        }

        const completeResponse = await fetch(uploadAction.href, {
            method: 'POST',
            headers: {
                'Accept': 'application/vnd.git-lfs+json',
                'Content-Type': 'application/vnd.git-lfs+json'
            },
            body: JSON.stringify(completeReq)
        });

        if (!completeResponse.ok) {
            const errorText = await readHFError(completeResponse);
            return {
                success: false,
                error: `HF LFS 分片合并失败 (${completeResponse.status}): ${errorText}`
            };
        }

        return { success: true };
    }

    const uploadResponse = await fetch(uploadAction.href, {
        method: 'PUT',
        headers: getUploadHeaders(header),
        body: fileBuffer
    });

    if (!uploadResponse.ok) {
        const errorText = await readHFError(uploadResponse);
        return {
            success: false,
            error: `HF LFS 上传失败 (${uploadResponse.status}): ${errorText}`
        };
    }

    return { success: true };
}

async function uploadToLfs(fileBuffer, token, repo) {
    const oid = await sha256Hex(fileBuffer);
    const size = fileBuffer.byteLength;

    const response = await fetch(getLfsBatchUrl(repo), {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.git-lfs+json',
            'Content-Type': 'application/vnd.git-lfs+json'
        },
        body: JSON.stringify({
            operation: 'upload',
            transfers: ['basic', 'multipart'],
            hash_algo: 'sha_256',
            ref: { name: 'main' },
            objects: [{ oid, size }]
        })
    });

    if (!response.ok) {
        const errorText = await readHFError(response);
        return {
            success: false,
            error: `HF LFS 批量握手失败 (${response.status}): ${errorText}`
        };
    }

    const data = await response.json();
    const object = Array.isArray(data?.objects) ? data.objects[0] : null;

    if (!object) {
        return { success: false, error: 'HF LFS 返回数据格式异常' };
    }

    if (object.error) {
        const message = object.error.message || JSON.stringify(object.error);
        return { success: false, error: `HF LFS 错误: ${message}` };
    }

    // actions.upload 不存在时，表示对象已在 LFS 中，无需重复上传
    if (object.actions?.upload) {
        const uploadResult = await uploadLfsObject(fileBuffer, oid, object.actions.upload);
        if (!uploadResult.success) {
            return uploadResult;
        }
    }

    return { success: true, oid, size };
}

/**
 * 上传文件到 HuggingFace Dataset
 * @param {ArrayBuffer} fileBuffer - 文件内容
 * @param {string} pathInRepo - 在仓库中的路径，如 "uploads/abc.png"
 * @param {string} fileName - 原始文件名
 * @param {object} env - 环境变量 (HF_TOKEN, HF_REPO)
 * @returns {{ success, error }}
 */
export async function uploadToHuggingFace(fileBuffer, pathInRepo, fileName, env) {
    const { token, repo, configured } = getHuggingFaceConfig(env);

    if (!configured) {
        return { success: false, error: 'HuggingFace 配置不完整，请检查 HF_TOKEN 和 HF_REPO' };
    }

    try {
        // 与官方 SDK 一致，先做 preupload 让服务端判定 regular / lfs
        const preupload = await detectUploadMode(pathInRepo, fileBuffer, token, repo);
        if (!preupload.success) {
            return { success: false, error: preupload.error };
        }

        let operationLine;
        if (preupload.uploadMode === 'lfs') {
            const lfsUpload = await uploadToLfs(fileBuffer, token, repo);
            if (!lfsUpload.success) {
                return { success: false, error: lfsUpload.error };
            }

            operationLine = {
                key: 'lfsFile',
                value: {
                    path: pathInRepo,
                    algo: 'sha256',
                    size: lfsUpload.size,
                    oid: lfsUpload.oid
                }
            };
        } else {
            const base64Content = arrayBufferToBase64(fileBuffer);
            operationLine = {
                key: 'file',
                value: {
                    content: base64Content,
                    path: pathInRepo,
                    encoding: 'base64'
                }
            };
        }

        const body = createCommitBody([
            {
                key: 'header',
                value: { summary: `Upload ${fileName || pathInRepo}` }
            },
            operationLine
        ]);

        const response = await fetch(getCommitUrl(repo), {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/x-ndjson'
            },
            body
        });

        if (!response.ok) {
            const errorText = await readHFError(response);
            return { success: false, error: `HF 上传失败 (${response.status}): ${errorText}` };
        }

        const result = await response.json();
        return { success: true, commitOid: result.commitOid };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * 从 HuggingFace Dataset 获取文件
 * 返回一个可以直接代理给客户端的 Response
 * @param {string} pathInRepo - 文件在仓库中的路径
 * @param {object} env - 环境变量
 * @param {object} options - 可选参数 { range }
 */
export async function getHuggingFaceFile(pathInRepo, env, options = {}) {
    const { token, repo } = getHuggingFaceConfig(env);
    if (!repo) {
        return new Response('HuggingFace 仓库未配置', { status: 500 });
    }

    const url = `${HF_BASE_URL}/datasets/${repo}/resolve/main/${pathInRepo}`;
    const headers = {};

    // 私有仓库需要 Token
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    if (options.range) {
        headers['Range'] = options.range;
    }

    return fetch(url, {
        headers,
        redirect: 'follow'
    });
}

/**
 * 获取文件的公开下载 URL
 */
export function getHuggingFacePublicUrl(pathInRepo, env) {
    const { repo } = getHuggingFaceConfig(env);
    return repo ? `${HF_BASE_URL}/datasets/${repo}/resolve/main/${pathInRepo}` : '';
}

/**
 * 从 HuggingFace Dataset 删除文件
 */
export async function deleteHuggingFaceFile(pathInRepo, env) {
    const { token, repo, configured } = getHuggingFaceConfig(env);
    if (!configured) {
        return false;
    }

    try {
        const body = createCommitBody([
            {
                key: 'header',
                value: { summary: `Delete ${pathInRepo}` }
            },
            {
                key: 'deletedFile',
                value: { path: pathInRepo }
            }
        ]);

        const response = await fetch(getCommitUrl(repo), {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/x-ndjson'
            },
            body
        });

        return response.ok;
    } catch (error) {
        console.error('HF delete error:', error);
        return false;
    }
}

/**
 * 检查 HuggingFace 连接状态
 */
export async function checkHuggingFaceConnection(env) {
    const { token, repo, configured } = getHuggingFaceConfig(env);
    if (!configured) {
        return { connected: false, error: '未配置 HF_TOKEN 或 HF_REPO' };
    }

    try {
        const response = await fetch(
            `${HF_BASE_URL}/api/datasets/${repo}`,
            { headers: { 'Authorization': `Bearer ${token}` } }
        );

        if (response.ok) {
            const data = await response.json();
            return {
                connected: true,
                repoId: data.id,
                isPrivate: data.private
            };
        }

        const errorText = await readHFError(response);
        return { connected: false, error: `HTTP ${response.status}: ${errorText}` };
    } catch (e) {
        return { connected: false, error: e.message };
    }
}
