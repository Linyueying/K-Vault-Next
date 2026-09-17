const { run, get } = require('../../db');

function getClientIp(request) {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || '0.0.0.0';
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

class GuestService {
  constructor(db, config) {
    this.db = db;
    this.config = config;
  }

  getConfig() {
    if (!this.config.guestUploadEnabled) {
      return { enabled: false, maxFileSize: 0, dailyLimit: 0 };
    }
    return {
      enabled: true,
      maxFileSize: this.config.guestMaxFileSize,
      dailyLimit: this.config.guestDailyLimit,
    };
  }

  checkUploadAllowed(request, fileSize = 0) {
    if (!this.config.guestUploadEnabled) {
      return {
        allowed: false,
        status: 401,
        reason: 'Guest upload disabled. Please login first.',
      };
    }

    if (fileSize > this.config.guestMaxFileSize) {
      return {
        allowed: false,
        status: 413,
        reason: `Guest upload file size limit exceeded (${Math.ceil(this.config.guestMaxFileSize / 1024 / 1024)}MB).`,
      };
    }

    const ip = getClientIp(request);
    const day = todayKey();
    const row = get(this.db, 'SELECT count FROM guest_upload_counters WHERE id = ?', [`${ip}:${day}`]);
    const current = row ? Number(row.count) : 0;

    if (current >= this.config.guestDailyLimit) {
      return {
        allowed: false,
        status: 429,
        reason: `Guest daily upload limit reached (${this.config.guestDailyLimit}).`,
        remaining: 0,
      };
    }

    return {
      allowed: true,
      remaining: this.config.guestDailyLimit - current,
    };
  }

  incrementUsage(request) {
    if (!this.config.guestUploadEnabled) return;

    const ip = getClientIp(request);
    const day = todayKey();
    const id = `${ip}:${day}`;
    const now = Date.now();

    const existing = get(this.db, 'SELECT count FROM guest_upload_counters WHERE id = ?', [id]);
    if (!existing) {
      run(
        this.db,
        `INSERT INTO guest_upload_counters(id, ip, day, count, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [id, ip, day, 1, now]
      );
      return;
    }

    run(
      this.db,
      `UPDATE guest_upload_counters
       SET count = ?, updated_at = ?
       WHERE id = ?`,
      [Number(existing.count) + 1, now, id]
    );
  }
}

module.exports = {
  GuestService,
  getClientIp,
};
