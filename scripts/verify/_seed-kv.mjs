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
 *
 * @param {(string|{name:string,fileType?:string,fileSize?:number,folder?:string})[]} names
 *   文件名列表。传字符串时按 `document` + 实际字节数落库（旧行为）；
 *   需要验证图标 / 配色 / 按类型排序时，传对象显式指定 fileType 与 fileSize ——
 *   服务端只按 fileType 分类，清单页的细分靠扩展名，两者都得能造出来。
 * @param {{ folder?: string }} [opts] - 可选，指定 folderPath（用于「分享目录」用例）。
 * @returns {{ok: boolean, reason?: string, written?: string[]}}
 */
export async function ensureSeedFiles(names, opts = {}) {
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
    for (const entry of names) {
      const spec = typeof entry === 'string' ? { name: entry } : entry || {};
      const name = String(spec.name || '');
      if (!name) throw new Error('seed 文件名不能为空');

      const body = Buffer.from(`verify-bundle seed for ${name}\n`);
      // blob 文件名沿用 miniflare 的 <hex><suffix> 形状
      const blobId = crypto.createHash('sha256').update(name + '-verify').digest('hex') + '000001a0d2cd58c0';
      fs.writeFileSync(path.join(BLOBS, blobId), body);

      const folder = spec.folder || opts.folder || '';
      const metadata = JSON.stringify({
        fileName: name,
        // fileSize 允许显式指定：清单页的「按大小排序」需要可区分的量级，
        // 全靠真实字节数的话几个种子文件几乎一样大，排序断言会假通过。
        fileSize: Number.isFinite(spec.fileSize) ? spec.fileSize : body.length,
        fileType: spec.fileType || 'document',
        TimeStamp: spec.timeStamp || Date.now(),
        // 可选：把文件归入某个目录，供「分享目录」用例按 folderPath 解析成员。
        ...(folder ? { folderPath: folder } : {}),
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
