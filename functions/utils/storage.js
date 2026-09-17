/**
 * 存储工具模块 - 统一管理 KV 和 R2 存储
 * 支持按文件类型划分 KV Key 前缀
 * 支持 R2 存储作为备选存储方式
 */

// KV Key 前缀配置
export const KEY_PREFIXES = {
  // 文件类型前缀
  IMAGE: 'img:',
  VIDEO: 'vid:',
  AUDIO: 'aud:',
  DOCUMENT: 'doc:',
  
  // 系统前缀
  SESSION: 'session:',
  UPLOAD: 'upload:',
  CHUNK: 'chunk:',
  
  // 默认前缀（兼容旧数据）
  DEFAULT: ''
};

// 文件类型与前缀映射
const FILE_TYPE_MAP = {
  // 图片
  'jpg': 'IMAGE', 'jpeg': 'IMAGE', 'png': 'IMAGE', 'gif': 'IMAGE',
  'webp': 'IMAGE', 'bmp': 'IMAGE', 'svg': 'IMAGE', 'ico': 'IMAGE',
  'heic': 'IMAGE', 'heif': 'IMAGE', 'avif': 'IMAGE', 'tiff': 'IMAGE',
  
  // 视频
  'mp4': 'VIDEO', 'webm': 'VIDEO', 'ogg': 'VIDEO', 'avi': 'VIDEO',
  'mov': 'VIDEO', 'wmv': 'VIDEO', 'flv': 'VIDEO', 'mkv': 'VIDEO',
  'm4v': 'VIDEO', '3gp': 'VIDEO', 'ts': 'VIDEO',
  
  // 音频
  'mp3': 'AUDIO', 'wav': 'AUDIO', 'flac': 'AUDIO', 'aac': 'AUDIO',
  'm4a': 'AUDIO', 'wma': 'AUDIO', 'ape': 'AUDIO', 'opus': 'AUDIO',
  
  // 文档和其他文件默认为 DOCUMENT
};

/**
 * 根据文件扩展名获取对应的 Key 前缀
 * @param {string} fileName 文件名
 * @returns {string} Key 前缀
 */
export function getKeyPrefix(fileName) {
  if (!fileName) return KEY_PREFIXES.DEFAULT;
  
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (!ext) return KEY_PREFIXES.DOCUMENT;
  
  const typeKey = FILE_TYPE_MAP[ext];
  return typeKey ? KEY_PREFIXES[typeKey] : KEY_PREFIXES.DOCUMENT;
}

/**
 * 获取文件类型名称
 * @param {string} fileName 文件名
 * @returns {string} 类型名称
 */
export function getFileType(fileName) {
  if (!fileName) return 'document';
  
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (!ext) return 'document';
  
  const typeKey = FILE_TYPE_MAP[ext];
  return typeKey ? typeKey.toLowerCase() : 'document';
}

/**
 * 生成带前缀的 KV Key
 * @param {string} id 文件 ID
 * @param {string} fileName 文件名（用于确定前缀）
 * @returns {string} 带前缀的 Key
 */
export function generateKey(id, fileName) {
  const prefix = getKeyPrefix(fileName);
  return `${prefix}${id}`;
}

/**
 * 从 Key 中解析 ID（移除前缀）
 * @param {string} key 带前缀的 Key
 * @returns {string} 原始 ID
 */
export function parseKey(key) {
  for (const prefix of Object.values(KEY_PREFIXES)) {
    if (prefix && key.startsWith(prefix)) {
      return key.slice(prefix.length);
    }
  }
  return key;
}

/**
 * 存储适配器基类
 */
class StorageAdapter {
  async put(key, value, metadata = {}) {
    throw new Error('Not implemented');
  }
  
  async get(key) {
    throw new Error('Not implemented');
  }
  
  async delete(key) {
    throw new Error('Not implemented');
  }
  
  async list(options = {}) {
    throw new Error('Not implemented');
  }
}

/**
 * KV 存储适配器
 */
export class KVStorageAdapter extends StorageAdapter {
  constructor(kvNamespace) {
    super();
    this.kv = kvNamespace;
  }
  
  async put(key, value, options = {}) {
    const kvOptions = {};
    if (options.metadata) {
      kvOptions.metadata = options.metadata;
    }
    if (options.expirationTtl) {
      kvOptions.expirationTtl = options.expirationTtl;
    }
    await this.kv.put(key, value, kvOptions);
  }
  
  async get(key, options = {}) {
    const type = options.type || 'text';
    return await this.kv.get(key, { type });
  }
  
  async getWithMetadata(key, options = {}) {
    const type = options.type || 'text';
    return await this.kv.getWithMetadata(key, { type });
  }
  
  async delete(key) {
    await this.kv.delete(key);
  }
  
  async list(options = {}) {
    return await this.kv.list(options);
  }
}

/**
 * R2 存储适配器
 */
export class R2StorageAdapter extends StorageAdapter {
  constructor(r2Bucket) {
    super();
    this.bucket = r2Bucket;
  }
  
  async put(key, value, options = {}) {
    const r2Options = {};
    if (options.metadata) {
      r2Options.customMetadata = options.metadata;
    }
    if (options.contentType) {
      r2Options.httpMetadata = {
        contentType: options.contentType
      };
    }
    await this.bucket.put(key, value, r2Options);
  }
  
  async get(key) {
    const object = await this.bucket.get(key);
    if (!object) return null;
    
    return {
      value: object,
      metadata: object.customMetadata,
      httpMetadata: object.httpMetadata
    };
  }
  
  async delete(key) {
    await this.bucket.delete(key);
  }
  
  async list(options = {}) {
    const listOptions = {};
    if (options.prefix) {
      listOptions.prefix = options.prefix;
    }
    if (options.limit) {
      listOptions.limit = options.limit;
    }
    if (options.cursor) {
      listOptions.cursor = options.cursor;
    }
    
    const result = await this.bucket.list(listOptions);
    
    // 转换为与 KV list 兼容的格式
    return {
      keys: result.objects.map(obj => ({
        name: obj.key,
        metadata: obj.customMetadata || {}
      })),
      list_complete: !result.truncated,
      cursor: result.truncated ? result.cursor : null
    };
  }
}

/**
 * 统一存储管理器
 * 支持 KV 和 R2 两种存储方式
 */
export class StorageManager {
  constructor(env) {
    this.env = env;
    this.kvAdapter = env.img_url ? new KVStorageAdapter(env.img_url) : null;
    this.r2Adapter = env.R2_BUCKET ? new R2StorageAdapter(env.R2_BUCKET) : null;
    
    // 默认使用 KV，如果配置了 R2 优先使用 R2
    this.useR2 = env.USE_R2 === 'true' && this.r2Adapter;
  }
  
  get primaryAdapter() {
    return this.useR2 ? this.r2Adapter : this.kvAdapter;
  }
  
  /**
   * 存储文件元数据（使用 KV）
   */
  async putMetadata(id, fileName, metadata) {
    if (!this.kvAdapter) {
      throw new Error('KV namespace not configured');
    }
    
    const key = generateKey(id, fileName);
    await this.kvAdapter.put(key, '', { metadata });
  }
  
  /**
   * 获取文件元数据
   */
  async getMetadata(id, fileName) {
    if (!this.kvAdapter) {
      throw new Error('KV namespace not configured');
    }
    
    const key = generateKey(id, fileName);
    const result = await this.kvAdapter.getWithMetadata(key);
    return result?.metadata || null;
  }
  
  /**
   * 存储文件内容（优先使用 R2）
   */
  async putFile(key, content, options = {}) {
    if (this.useR2) {
      await this.r2Adapter.put(key, content, options);
    } else if (this.kvAdapter) {
      // KV 不适合存储大文件，仅存储元数据
      console.warn('R2 not configured, file content not stored in KV');
    }
  }
  
  /**
   * 获取文件内容
   */
  async getFile(key) {
    if (this.useR2) {
      return await this.r2Adapter.get(key);
    }
    return null;
  }
  
  /**
   * 删除文件
   */
  async deleteFile(id, fileName) {
    const key = generateKey(id, fileName);
    
    // 删除元数据
    if (this.kvAdapter) {
      await this.kvAdapter.delete(key);
    }
    
    // 如果使用 R2，也删除文件内容
    if (this.useR2) {
      await this.r2Adapter.delete(id);
    }
  }
  
  /**
   * 列出文件
   * @param {string} type 文件类型 (image, video, audio, document, 或 all)
   */
  async listFiles(type = 'all', options = {}) {
    if (!this.kvAdapter) {
      throw new Error('KV namespace not configured');
    }
    
    // 根据类型确定前缀
    let prefix = '';
    if (type !== 'all') {
      const prefixKey = type.toUpperCase();
      prefix = KEY_PREFIXES[prefixKey] || '';
    }
    
    return await this.kvAdapter.list({
      prefix,
      ...options
    });
  }
}

/**
 * 创建存储管理器实例
 */
export function createStorageManager(env) {
  return new StorageManager(env);
}
