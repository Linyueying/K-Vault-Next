const path = require('node:path');

const MIME_EXTENSION_MAP = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/x-7z-compressed': '7z',
  'application/x-rar-compressed': 'rar',
  'text/plain': 'txt',
  'application/json': 'json',
};

function sanitizeExtension(ext, fallback = 'bin') {
  const normalized = String(ext || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (!normalized) return fallback;
  return normalized.slice(0, 10);
}

function getExtension(fileName, mimeType, fallback = 'bin') {
  const parsed = path.extname(fileName || '').replace('.', '');
  if (parsed) return sanitizeExtension(parsed, fallback);

  const normalizedMime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  return sanitizeExtension(MIME_EXTENSION_MAP[normalizedMime] || fallback, fallback);
}

function buildPublicFileId(storageType, fileName, mimeType) {
  const extension = getExtension(fileName, mimeType);
  const random = Math.random().toString(36).slice(2, 8);
  return `${storageType}_${Date.now()}_${random}.${extension}`;
}

function normalizeStorageType(type) {
  const normalized = String(type || '').trim().toLowerCase();
  const supported = [
    'telegram',
    'r2',
    's3',
    'discord',
    'huggingface',
    'webdav',
    'github',
  ];
  if (supported.includes(normalized)) return normalized;
  return 'telegram';
}

module.exports = {
  getExtension,
  buildPublicFileId,
  normalizeStorageType,
};
