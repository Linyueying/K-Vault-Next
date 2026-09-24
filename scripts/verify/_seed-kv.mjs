// 往本地 wrangler 的 KV 里直接写几条文件记录。
//
// 为什么需要它：本地 wrangler 没有 telegram 出口，`/api/upload-from-url`
// 又被 SSRF 防护挡住回环地址，所以「先上传再验证」这条路在本地走不通。
// 这里按真实上传写下的 metadata 形状直接落库，让合集用例有真实数据可依赖。
//
// 前提：wrangler pages dev 必须用 --persist-to /tmp/kvdata 启动（默认路径），
// 且已经跑过一次让它把库文件建出来。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PERSIST = process.env.KV_PERSIST || '/tmp/kvdata';
const KV_ROOT = path.join(PERSIST, 'v3', 'kv');
const NS_DIR = path.join(KV_ROOT, 'miniflare-KVNamespaceObject');
const BLOBS = path.join(KV_ROOT, 'img_url', 'blobs');

// 本地 KV 的库文件名是命名空间 id 的 sha256，这里直接在 NS_DIR 里找唯一一个非 metadata 的 .sqlite
function findDb() {
  if (!fs.existsSync(NS_DIR)) return null;
  const hit = fs.readdirSync(NS_DIR).filter((f) => f.endsWith('.sqlite') && !f.startsWith('metadata'));
  return hit.length ? path.join(NS_DIR, hit[0]) : null;
}

/**
 * 确保给定的文件名在 KV 里存在（内容不重要，只需要是可下载的记录）。
 * @returns {{ok: boolean, reason?: string, written?: string[]}}
 */
export async function ensureSeedFiles(names) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    return { ok: false, reason: '当前 Node 没有 node:sqlite（需要 Node 22+）' };
  }

  const dbPath = findDb();
  if (!dbPath) {
    return { ok: false, reason: `找不到 KV 库：${NS_DIR}（先启动一次 wrangler pages dev --persist-to）` };
  }
  fs.mkdirSync(BLOBS, { recursive: true });

  const db = new DatabaseSync(dbPath);
  const written = [];
  try {
    for (const name of names) {
      const body = Buffer.from(`verify-bundle seed for ${name}\n`);
      // blob 文件名沿用 miniflare 的 <hex><suffix> 形状
      const blobId = crypto.createHash('sha256').update(name + '-verify').digest('hex') + '000001a0d2cd58c0';
      fs.writeFileSync(path.join(BLOBS, blobId), body);

      const metadata = JSON.stringify({
        fileName: name,
        fileSize: body.length,
        fileType: 'document',
        TimeStamp: Date.now(),
      });

      db.prepare('REPLACE INTO _mf_entries (key, blob_id, expiration, metadata) VALUES (?, ?, ?, ?)')
        .run(name, blobId, null, metadata);
      written.push(name);
    }
  } catch (err) {
    return { ok: false, reason: `${err.code || 'ERR'}: ${err.message}` };
  } finally {
    db.close();
  }

  return { ok: true, written };
}
