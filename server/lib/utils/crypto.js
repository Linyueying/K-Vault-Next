const crypto = require('node:crypto');

function ensureKeyMaterial(secret) {
  if (!secret) {
    throw new Error('CONFIG_ENCRYPTION_KEY (or SESSION_SECRET/FILE_URL_SECRET) is required for encrypted storage configs.');
  }
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function encryptJson(payload, secret) {
  const key = ensureKeyMaterial(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const json = JSON.stringify(payload || {});
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptJson(blob, secret) {
  if (!blob || typeof blob !== 'object') return {};
  const key = ensureKeyMaterial(secret);

  const iv = Buffer.from(blob.iv || '', 'base64');
  const tag = Buffer.from(blob.tag || '', 'base64');
  const data = Buffer.from(blob.data || '', 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  return JSON.parse(decrypted || '{}');
}

function randomId(prefix = '') {
  const raw = crypto.randomBytes(8).toString('hex');
  return prefix ? `${prefix}_${raw}` : raw;
}

module.exports = {
  encryptJson,
  decryptJson,
  randomId,
};
