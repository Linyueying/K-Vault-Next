import { envValue } from './env-config.js';
import { ensureSchema } from './schema.js';
import { deriveIndexId } from './file-record.js';
import { getFileRecord } from './metadata-d1.js';
import {
  decodeTelegramPartRef,
  deletePartStates,
  deleteResumeMap,
  getUploadedPart,
  isChunkTaskExpired,
  listUploadedParts,
  recordUploadedPart,
} from './chunk-state.js';
import { deleteTelegramMessagesBatch } from './telegram.js';

const HOUR = 60 * 60;
const RETENTION_SECONDS = 72 * HOUR;
const LEASE_SECONDS = 5 * 60;
const CLEANUP_PREFIX = 'tg-upload-cleanup:';
const localLocks = new Set();
const cleanupCursors = new WeakMap();
const nowSeconds = () => Math.floor(Date.now() / 1000);

export function isTelegramUpload(task) {
  return task?.storageMode === 'telegram' && task.chunkBackend === 'telegram';
}

export async function telegramUploadFileKey(uploadId, fileName) {
  const name = String(fileName || '').toLowerCase();
  const extension = name.includes('.') ? name.split('.').pop().replace(/[^a-z0-9]/g, '') : '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`telegram-upload:${uploadId}`));
  const id = Array.from(new Uint8Array(digest).subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `telegram:tg_${id}.${extension || 'bin'}`;
}

function taskJournalKey(uploadId) {
  return `${CLEANUP_PREFIX}task:${uploadId}`;
}

async function guardDatabase(env) {
  if (!env.DB?.prepare) return null;
  if (!(await ensureSchema(env))?.ok) throw new Error('Telegram upload database unavailable');
  return env.DB;
}

// D1 serializes operations across isolates. Without D1 the stable file key and
// cancellation marker are durable; the mutex can only coordinate this isolate.
export async function acquireTelegramUploadGuard(env, key) {
  const db = await guardDatabase(env);
  if (!db) {
    if (localLocks.has(key)) return null;
    localLocks.add(key);
    return () => localLocks.delete(key);
  }
  const token = crypto.randomUUID();
  const now = nowSeconds();
  const result = await db.prepare(
    `INSERT INTO telegram_upload_guards (guard_key, lease_token, lease_until, retain_until)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(guard_key) DO UPDATE SET lease_token = excluded.lease_token,
       lease_until = excluded.lease_until,
       retain_until = MAX(retain_until, excluded.retain_until)
     WHERE lease_until <= ?`
  ).bind(key, token, now + LEASE_SECONDS, now + RETENTION_SECONDS, now).run();
  if (!result?.meta?.changes) return null;
  return async () => {
    try {
      const releaseSql = key.includes(':')
        ? 'DELETE FROM telegram_upload_guards WHERE guard_key = ? AND lease_token = ?'
        : 'UPDATE telegram_upload_guards SET lease_token = NULL, lease_until = 0 WHERE guard_key = ? AND lease_token = ?';
      await db.prepare(releaseSql).bind(key, token).run();
    } catch (err) {
      console.warn('Telegram upload guard release failed:', err?.message || err);
    }
  };
}

export async function readTelegramUploadOutcome(env, uploadId) {
  const db = await guardDatabase(env);
  if (db) {
    const row = await db.prepare('SELECT outcome FROM telegram_upload_guards WHERE guard_key = ?')
      .bind(uploadId).first();
    return row?.outcome ? JSON.parse(row.outcome) : null;
  }
  return env.img_url.get(`tg-upload-outcome:${uploadId}`, { type: 'json' });
}

// Called under the task guard, before removing the task or its part records.
export async function writeTelegramUploadOutcome(env, uploadId, outcome) {
  const db = await guardDatabase(env);
  const value = JSON.stringify(outcome);
  if (db) {
    const result = await db.prepare(
      'UPDATE telegram_upload_guards SET outcome = ?, retain_until = ? WHERE guard_key = ?'
    ).bind(value, nowSeconds() + RETENTION_SECONDS, uploadId).run();
    if (!result?.meta?.changes) throw new Error('Telegram upload guard missing');
    return;
  }
  await env.img_url.put(`tg-upload-outcome:${uploadId}`, value, { expirationTtl: RETENTION_SECONDS });
}

export async function trackTelegramUpload(env, uploadId, task) {
  const journal = {
    ownerId: task.ownerId,
    fileId: task.fileId,
    fileName: task.fileName,
    chatId: task.telegramChatId || envValue(env, 'TG_CHAT_ID'),
    totalChunks: task.totalChunks,
    expiresAt: task.expiresAt || Math.floor(task.createdAt / 1000) + 90 * 60,
  };
  await env.img_url.put(taskJournalKey(uploadId), JSON.stringify(journal), {
    expirationTtl: RETENTION_SECONDS,
    metadata: { dueAt: journal.expiresAt },
  });
  return journal;
}

export function readTelegramUploadJournal(env, uploadId) {
  return env.img_url.get(taskJournalKey(uploadId), { type: 'json' });
}

export async function findCommittedTelegramUpload(env, uploadId, fileName) {
  const key = await telegramUploadFileKey(uploadId, fileName);
  if (env.DB?.prepare) {
    const result = await getFileRecord(env, deriveIndexId(key), { strict: true });
    if (result?.record?.metadata?.telegramChunked) return result.record.metadata;
  }
  const metadata = await env.img_url.get(key, { type: 'json' });
  return metadata?.telegramChunked ? metadata : null;
}

export async function forgetTelegramUploadParts(env, uploadId, totalChunks) {
  await deletePartStates(env, uploadId, totalChunks, { mergeKv: true });
  await env.img_url.delete(taskJournalKey(uploadId));
}

async function checkTelegramUploadOpen(env, uploadId, task) {
  if (isChunkTaskExpired(task)) return false;
  return !(await readTelegramUploadOutcome(env, uploadId));
}

export async function beginTelegramUploadPart(env, uploadId, chunkIndex, task) {
  if (task.telegramChatId && task.telegramChatId !== envValue(env, 'TG_CHAT_ID')) {
    return { status: 409, body: { error: 'Telegram 存储频道已变更，请重新上传', code: 'TG_CHAT_CHANGED' } };
  }
  if (!await checkTelegramUploadOpen(env, uploadId, task)) {
    return { status: 404, body: { error: '上传任务已结束', code: 'UPLOAD_EXPIRED' } };
  }
  const release = await acquireTelegramUploadGuard(env, `${uploadId}:${chunkIndex}`);
  if (!release) {
    return {
      status: 503,
      body: { error: '此分片正在上传，请稍后重试', code: 'TG_PART_BUSY', retryable: true },
    };
  }
  try {
    // Tasks created by older versions did not retain a cleanup journal.
    if (!task.telegramChatId && !await readTelegramUploadJournal(env, uploadId)) {
      await trackTelegramUpload(env, uploadId, task);
    }
    return { release };
  } catch (error) {
    await release();
    throw error;
  }
}

async function deleteMessages(env, chatId, ids, { maxFallbackMessages } = {}) {
  if (!ids.length || !chatId || chatId !== envValue(env, 'TG_CHAT_ID') || !envValue(env, 'TG_BOT_TOKEN')) {
    return { deleted: 0, total: ids.length, pendingMessageIds: ids };
  }
  return deleteTelegramMessagesBatch(env, ids, {
    missingIsSuccess: true, includePending: true, maxFallbackMessages,
  });
}

// The separate per-part guard is held during sending. The task guard covers
// only the receipt write, so different fragments can still upload concurrently.
export async function confirmTelegramUploadPart(env, uploadId, chunkIndex, part, task, chatId) {
  let release;
  try {
    for (const wait of [0, 50, 150, 350, 650]) {
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      release = await acquireTelegramUploadGuard(env, uploadId);
      if (release) break;
    }
    if (release && await checkTelegramUploadOpen(env, uploadId, task)) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await recordUploadedPart(env, uploadId, chunkIndex, part, task);
        if (result.ok) return 'saved';
      }
      const previous = await getUploadedPart(env, uploadId, chunkIndex, { strict: true });
      if (previous?.etag === part.etag) return 'saved';
    } else if (release) {
      return 'closed';
    }
    return 'retry';
  } catch (err) {
    console.warn('Telegram upload receipt unavailable:', err?.message || err);
    return 'retry';
  } finally {
    if (release) await release();
  }
}

export async function discardUnconfirmedTelegramPart(env, uploadId, chunkIndex, task, chatId, messageId, { knownUntracked = false } = {}) {
  if (!messageId) return;
  try {
    if (knownUntracked) {
      const result = await deleteMessages(env, chatId, [messageId]);
      if (result.deleted === result.total) return;
    }
    await env.img_url.put(
      `${CLEANUP_PREFIX}message:${uploadId}:${messageId}`,
      JSON.stringify({ uploadId, chunkIndex, fileName: task.fileName, chatId, messageId }),
      { expirationTtl: 2 * 24 * HOUR, metadata: { dueAt: nowSeconds() + 120 } },
    );
  } catch (err) {
    console.error('Could not retain unconfirmed Telegram fragment:', err?.message || err);
  }
}

async function cleanupUnconfirmedMessage(env, entry) {
  const release = await acquireTelegramUploadGuard(env, entry.uploadId);
  if (!release) return false;
  try {
    const committed = await findCommittedTelegramUpload(env, entry.uploadId, entry.fileName);
    if (committed?.telegramChunks?.some((part) => String(part.msgId) === String(entry.messageId))) {
      return true;
    }
    const part = await getUploadedPart(env, entry.uploadId, entry.chunkIndex, { strict: true });
    if (String(decodeTelegramPartRef(part?.etag)?.msgId) === String(entry.messageId)) return true;
    const result = await deleteMessages(env, entry.chatId, [entry.messageId]);
    return result.deleted === result.total;
  } finally {
    await release();
  }
}

// Callers hold the task guard. Keep the receipts and checkpoint successful
// deletions so older Bot APIs with bounded single-delete fallback make progress.
export async function cleanCanceledTelegramUpload(env, uploadId, journal, options = {}) {
  if (options.deferInitialDeletion && !journal.cleanupDueAt) {
    const dueAt = nowSeconds() + 120;
    await env.img_url.put(taskJournalKey(uploadId), JSON.stringify({
      ...journal, cleanupDueAt: dueAt,
    }), { expiration: journal.expiresAt + 2 * 24 * HOUR, metadata: { dueAt } });
    return { deletedTelegramChunks: 0, cleanupPending: true };
  }
  if (options.deferInitialDeletion && journal.cleanupDueAt > nowSeconds()) {
    return { deletedTelegramChunks: 0, cleanupPending: true };
  }
  const parts = await listUploadedParts(env, uploadId, {
    mergeKv: true, includeDuplicates: true, strict: true,
  });
  const handled = new Set(journal.deletedMessageIds || []);
  const remaining = [...new Set(parts.map((part) => decodeTelegramPartRef(part.etag)?.msgId)
    .filter(Boolean).map(String))].filter((id) => !handled.has(id));
  const offset = journal.cleanupOffset || 0;
  const ids = [...remaining.slice(offset), ...remaining.slice(0, offset)];
  const { deleted, total, pendingMessageIds } = await deleteMessages(env, journal.chatId, ids, options);
  const cleanupPending = deleted < total;
  if (cleanupPending) {
    const pending = new Set(pendingMessageIds.map(String));
    for (const id of ids) {
      if (!pending.has(id)) handled.add(id);
    }
    await env.img_url.put(taskJournalKey(uploadId), JSON.stringify({
      ...journal,
      deletedMessageIds: [...handled],
      cleanupDueAt: nowSeconds() + 60,
      cleanupOffset: (offset + (options.maxFallbackMessages || 36)) % pending.size,
    }), {
      expiration: journal.expiresAt + 2 * 24 * HOUR,
      metadata: { dueAt: nowSeconds() + 60 },
    });
  } else {
    await forgetTelegramUploadParts(env, uploadId, journal.totalChunks);
  }
  return { deletedTelegramChunks: deleted, cleanupPending };
}

export async function sweepTelegramUploads(env) {
  if (!env.img_url?.list) return;
  const now = nowSeconds();
  const state = cleanupCursors.get(env.img_url) || {};
  if (state.nextAt > now) return;
  state.nextAt = now + 60;
  cleanupCursors.set(env.img_url, state);
  const page = await env.img_url.list({ prefix: CLEANUP_PREFIX, limit: 3, cursor: state.cursor });
  state.cursor = page.list_complete === false ? page.cursor : undefined;

  for (const key of page.keys || []) {
    if (key.metadata?.dueAt > now) continue;
    try {
      const entry = await env.img_url.get(key.name, { type: 'json' });
      if (!entry) continue;
      if (key.name.startsWith(`${CLEANUP_PREFIX}message:`)) {
        if (await cleanupUnconfirmedMessage(env, entry)) await env.img_url.delete(key.name);
        continue;
      }
      if ((entry.cleanupDueAt ?? entry.expiresAt) > now) continue;
      const uploadId = key.name.slice(`${CLEANUP_PREFIX}task:`.length);
      const release = await acquireTelegramUploadGuard(env, uploadId);
      if (!release) continue;
      try {
        const outcome = await readTelegramUploadOutcome(env, uploadId);
        if (outcome?.phase === 'done' || await findCommittedTelegramUpload(env, uploadId, entry.fileName)) {
          await forgetTelegramUploadParts(env, uploadId, entry.totalChunks);
        } else {
          if (!outcome) {
            await writeTelegramUploadOutcome(env, uploadId, { phase: 'canceled', ownerId: entry.ownerId });
          }
          await cleanCanceledTelegramUpload(env, uploadId, entry, { maxFallbackMessages: 3 });
          await env.img_url.delete(`upload:${uploadId}`);
          await deleteResumeMap(env, entry.ownerId, entry.fileId, uploadId);
        }
      } finally {
        await release();
      }
    } catch (err) {
      console.warn('Telegram upload cleanup deferred:', err?.message || err);
    }
  }
  const db = await guardDatabase(env);
  if (db) {
    await db.prepare('DELETE FROM telegram_upload_guards WHERE retain_until < ? AND lease_until < ?')
      .bind(now, now).run();
  }
}
