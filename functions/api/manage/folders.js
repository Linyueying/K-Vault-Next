import {
  listFolderStats,
  listMarkers,
  ensureFolderMarker,
  removeFolderMarkers,
  moveFolder,
  clearFolder,
  folderHasContent,
} from '../../utils/file-record.js';

const STORAGE_PREFIXES = ['img:', 'vid:', 'aud:', 'doc:', 'r2:', 's3:', 'discord:', 'hf:', 'webdav:', 'github:', ''];
// idxt: 记录索引、dlc: 下载计数、fstat: 文件夹统计 —— 均为内部辅助键，不参与文件/文件夹判定。
const INVALID_PREFIXES = ['session:', 'chunk:', 'upload:', 'temp:', 'idxt:', 'dlc:', 'fstat:'];

function normalizeFolderPath(value = '') {
  const raw = String(value || '').replace(/\\/g, '/').trim();
  const output = [];
  for (const part of raw.split('/')) {
    const piece = part.trim();
    if (!piece || piece === '.') continue;
    if (piece === '..') {
      output.pop();
      continue;
    }
    output.push(piece);
  }
  return output.join('/');
}

function inferStorageType(name, metadata = {}) {
  const explicit = metadata.storageType || metadata.storage;
  if (explicit) return String(explicit).toLowerCase();
  const keyName = String(name || '');
  if (keyName.startsWith('r2:')) return 'r2';
  if (keyName.startsWith('s3:')) return 's3';
  if (keyName.startsWith('discord:')) return 'discord';
  if (keyName.startsWith('hf:')) return 'huggingface';
  if (keyName.startsWith('webdav:')) return 'webdav';
  if (keyName.startsWith('github:')) return 'github';
  return 'telegram';
}

function matchStorage(storageType, storageFilter) {
  if (!storageFilter) return true;
  if (storageFilter === 'kv' || storageFilter === 'telegram') return storageType === 'telegram';
  return storageType === storageFilter;
}

function isFolderMarker(key) {
  if (!key?.name) return false;
  if (String(key.name).startsWith('folder:')) return true;
  return key.metadata?.folderMarker === true;
}

function shouldIncludeFileRecord(key) {
  if (!key?.name) return false;
  if (INVALID_PREFIXES.some((prefix) => key.name.startsWith(prefix))) return false;
  if (isFolderMarker(key)) return false;
  const metadata = key.metadata || {};
  return Boolean(metadata.fileName) && metadata.TimeStamp !== undefined && metadata.TimeStamp !== null;
}

function includeParentPaths(pathValue, set) {
  const parts = normalizeFolderPath(pathValue).split('/').filter(Boolean);
  for (let i = 1; i < parts.length; i += 1) {
    set.add(parts.slice(0, i).join('/'));
  }
}

function buildFolderNodes(fileRecords, folderMarkers) {
  const folderPaths = new Set();
  const fileCountByFolder = new Map();

  for (const record of fileRecords) {
    const folderPath = normalizeFolderPath(record?.metadata?.folderPath || '');
    if (!folderPath) continue;
    folderPaths.add(folderPath);
    includeParentPaths(folderPath, folderPaths);
    fileCountByFolder.set(folderPath, (fileCountByFolder.get(folderPath) || 0) + 1);
  }

  for (const marker of folderMarkers) {
    const markerPath = normalizeFolderPath(
      marker?.metadata?.folderPath
      || (String(marker?.name || '').startsWith('folder:') ? String(marker.name).slice('folder:'.length) : '')
      || ''
    );
    if (!markerPath) continue;
    folderPaths.add(markerPath);
    includeParentPaths(markerPath, folderPaths);
  }

  return [...folderPaths]
    .sort((a, b) => {
      const depthA = a.split('/').length;
      const depthB = b.split('/').length;
      if (depthA !== depthB) return depthA - depthB;
      return a.localeCompare(b, 'en', { sensitivity: 'base' });
    })
    .map((pathValue) => {
      const parts = pathValue.split('/');
      return {
        path: pathValue,
        name: parts[parts.length - 1] || pathValue,
        parentPath: parts.length > 1 ? parts.slice(0, -1).join('/') : '',
        depth: parts.length,
        fileCount: fileCountByFolder.get(pathValue) || 0,
      };
    });
}

/**
 * 列出 KV 中全部 key（全量扫描）。
 * 仅在 fstat: 索引缺失/失效时作为回落路径使用。
 */
async function listAllKeys(env) {
  const all = [];
  let cursor = undefined;
  let guard = 0;
  do {
    const page = await env.img_url.list({ limit: 1000, cursor });
    all.push(...(page.keys || []));
    cursor = page.list_complete ? undefined : page.cursor;
    guard += 1;
  } while (cursor && guard < 10000);
  return all;
}

/**
 * 从全量 key 中解析出"文件夹统计快照"。
 *
 * 快照结构（存入 fstat:__index__ 的 metadata）：
 *   { version, updatedAt, folders: { "<path>": { count, marker } } }
 *
 * 说明：只记录每个 folderPath 的文件数量与是否存在显式 folder: 标记，
 * 足以驱动 buildFolderNodes 的全部输出字段（path/name/parentPath/depth/fileCount）。
 */
function buildFolderSnapshot(allKeys) {
  const folders = {};

  const touch = (pathValue) => {
    const normalized = normalizeFolderPath(pathValue);
    if (!normalized) return null;
    if (!folders[normalized]) folders[normalized] = { count: 0, marker: false };
    return folders[normalized];
  };

  // 自身 + 所有父路径都要入表（父路径 fileCount 为 0，但需作为节点出现）
  const includeAll = (pathValue) => {
    const normalized = normalizeFolderPath(pathValue);
    if (!normalized) return;
    const parts = normalized.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i += 1) {
      touch(parts.slice(0, i).join('/'));
    }
  };

  for (const item of allKeys) {
    if (isFolderMarker(item)) {
      const markerPath = normalizeFolderPath(
        item.metadata?.folderPath
        || (String(item.name || '').startsWith('folder:') ? String(item.name).slice('folder:'.length) : '')
        || ''
      );
      if (!markerPath) continue;
      includeAll(markerPath);
      const entry = touch(markerPath);
      if (entry) entry.marker = true;
      continue;
    }

    if (!shouldIncludeFileRecord(item)) continue;
    const folderPath = normalizeFolderPath(item.metadata?.folderPath || '');
    if (!folderPath) continue;
    includeAll(folderPath);
    const entry = touch(folderPath);
    if (entry) entry.count += 1;
  }

  return { version: 1, updatedAt: Date.now(), folders };
}

const FSTAT_KEY = 'fstat:__index__';

/**
 * 分批并发执行异步任务，避免一次性打爆 KV 的并发/写入速率限制。
 *
 * 背景：目录删除需要逐个改写目录内所有文件的 metadata（把 folderPath 清空）。
 * 早期实现是 `for (const item of list) await put(...)` 的串行写法 —— 每个文件
 * 都是一次完整的 KV 网络往返，文件多时耗时线性增长（线上数百个文件可达数秒）。
 * 改为分批并发后，同样是 N 次写，但并行发起，整体耗时降到 ≈ (N/批次) 个往返。
 *
 * 每批用 allSettled：单个失败不影响其余，最后统计成功数即可。
 *
 * @param {Array} items 待处理项
 * @param {(item:any)=>Promise<any>} worker 单项处理函数
 * @param {number} [size] 每批并发数
 * @returns {Promise<number>} 成功（fulfilled）的数量
 */
async function runBatched(items, worker, size = 16) {
  let ok = 0;
  for (let i = 0; i < items.length; i += size) {
    const results = await Promise.allSettled(items.slice(i, i + size).map(worker));
    ok += results.filter((r) => r.status === 'fulfilled').length;
  }
  return ok;
}

/**
 * 读取文件夹统计快照。
 * @returns {Promise<{version:number, folders:object}|null>}
 */
async function readFolderSnapshot(env) {
  try {
    const record = await env.img_url.getWithMetadata(FSTAT_KEY, { type: 'json' });
    const snapshot = record?.metadata;
    if (snapshot && snapshot.version === 1 && snapshot.folders && typeof snapshot.folders === 'object') {
      return snapshot;
    }
  } catch (error) {
    console.warn('Failed to read folder snapshot:', error?.message || error);
  }
  return null;
}

/**
 * 写入文件夹统计快照。失败不影响主流程（下次仍走全表扫描）。
 */
async function writeFolderSnapshot(env, snapshot) {
  try {
    await env.img_url.put(FSTAT_KEY, '', { metadata: snapshot });
  } catch (error) {
    console.warn('Failed to write folder snapshot:', error?.message || error);
  }
}

/**
 * 失效文件夹快照。任何会改变文件夹结构的写操作后调用，使下次读取重建。
 */
async function invalidateFolderSnapshot(env) {
  try {
    await env.img_url.delete(FSTAT_KEY);
  } catch (error) {
    console.warn('Failed to invalidate folder snapshot:', error?.message || error);
  }
}

/**
 * 把快照还原成 buildFolderNodes 需要的输入形态，保证输出字段完全一致。
 */
function snapshotToNodes(snapshot, storageFilter) {
  // storageFilter 依赖每个文件的 storageType，快照未记录该维度；
  // 传入过滤条件时退回全量扫描，保证筛选结果正确。
  if (storageFilter) return null;

  const folders = snapshot.folders || {};
  const paths = Object.keys(folders).sort((a, b) => {
    const depthA = a.split('/').length;
    const depthB = b.split('/').length;
    if (depthA !== depthB) return depthA - depthB;
    return a.localeCompare(b, 'en', { sensitivity: 'base' });
  });

  return paths.map((pathValue) => {
    const parts = pathValue.split('/');
    return {
      path: pathValue,
      name: parts[parts.length - 1] || pathValue,
      parentPath: parts.length > 1 ? parts.slice(0, -1).join('/') : '',
      depth: parts.length,
      fileCount: folders[pathValue]?.count || 0,
    };
  });
}

/**
 * 把 D1 的 folders 映射（{ "<path>": {count, marker} }）转成节点数组。
 *
 * 输出字段与 `buildFolderNodes()` 完全对齐（path/name/parentPath/depth/fileCount），
 * 排序规则也一致（先按深度、再按字典序），保证前端拿到的东西与 KV 版逐字段相同。
 *
 * @param {object} folderMap - listFolderStats() 返回的 folders
 * @param {Array} markers - listMarkers() 返回的标记数组（此处仅用于兜底补路径）
 */
function nodesFromFolderMap(folderMap = {}, markers = []) {
  const paths = new Set(Object.keys(folderMap));

  // 标记可能在 folderMap 中缺席（如无文件的空目录），补进来
  for (const marker of markers) {
    const path = normalizeFolderPath(marker?.path || '');
    if (path) paths.add(path);
  }

  return [...paths]
    .sort((a, b) => {
      const depthA = a.split('/').length;
      const depthB = b.split('/').length;
      if (depthA !== depthB) return depthA - depthB;
      return a.localeCompare(b, 'en', { sensitivity: 'base' });
    })
    .map((pathValue) => {
      const parts = pathValue.split('/');
      return {
        path: pathValue,
        name: parts[parts.length - 1] || pathValue,
        parentPath: parts.length > 1 ? parts.slice(0, -1).join('/') : '',
        depth: parts.length,
        fileCount: folderMap[pathValue]?.count || 0,
      };
    });
}

function folderStartsWith(pathValue, parentPath) {
  const normalizedPath = normalizeFolderPath(pathValue);
  const normalizedParent = normalizeFolderPath(parentPath);
  if (!normalizedParent) return false;
  return normalizedPath === normalizedParent || normalizedPath.startsWith(`${normalizedParent}/`);
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const storageFilter = String(url.searchParams.get('storage') || '').toLowerCase();
  // fresh=1：跳过 fstat: 快照直扫全表。用于「写操作成功后的静默校正」——
  // KV 是最终一致且边缘有读缓存（最长 60s），刚失效的快照键仍可能被读到旧值，
  // 把已删除的目录刷回界面。绕开快照虽不能 100% 消除跨 POP 延迟，
  // 但避开了「快照键缓存」这个最大的旧值来源；
  // 且 fresh 模式不把扫描结果写回快照，避免把传播中的旧状态固化下来。
  const fresh = url.searchParams.get('fresh') === '1';

  if (!env.img_url) {
    return json({ success: false, error: 'KV binding img_url is not configured.' }, 500);
  }

  const baseResponse = (folders) => {
    const response = json({ success: true, folders });
    response.headers.set('Cache-Control', 'no-store, max-age=0');
    return response;
  };

  // ==========================================================================
  // 路径 A：D1 —— SQL GROUP BY 直接算目录树，无需全表扫描，也无需 fstat: 快照
  //
  // KV 版之所以要维护 fstat:__index__ 快照，是因为每次列举都是全量 list()
  // 扫描（计费 + 延迟随文件数线性增长）。D1 用一条 GROUP BY 就能算出每个目录
  // 的文件数，快照这层缓存自然消失 —— 连带 fresh=1 那个"绕开快照缓存"
  // 的参数也失去意义（SQL 查询无边缘缓存，天然强一致）。
  // ==========================================================================
  const d1Stats = await listFolderStats(env);
  if (!d1Stats.disabled && !storageFilter) {
    const markers = await listMarkers(env);
    const nodes = nodesFromFolderMap(d1Stats.folders, markers.folders || []);
    return baseResponse(nodes);
  }

  // ==========================================================================
  // 路径 B：KV 兜底（原有逻辑）
  // ==========================================================================
  // 快路径：读 fstat: 快照（1 次读），直接给出文件夹树，不再全表扫描。
  // 带 storage 过滤时快照不含该维度，退回全量扫描以保证筛选正确。
  if (!storageFilter && !fresh) {
    const snapshot = await readFolderSnapshot(env);
    if (snapshot) {
      const nodes = snapshotToNodes(snapshot, storageFilter);
      if (nodes) return baseResponse(nodes);
    }
  }

  // 回落：全量扫描，顺带重建快照供后续请求使用
  const allKeys = await listAllKeys(env);
  const fileRecords = allKeys
    .filter(shouldIncludeFileRecord)
    .map((item) => ({
      ...item,
      metadata: {
        ...(item.metadata || {}),
        storageType: inferStorageType(item.name, item.metadata || {}),
        folderPath: normalizeFolderPath(item.metadata?.folderPath || ''),
      },
    }))
    .filter((item) => matchStorage(item.metadata?.storageType, storageFilter));

  const folderMarkers = allKeys
    .filter(isFolderMarker)
    .filter((item) => matchStorage(inferStorageType(item.name, item.metadata || {}), storageFilter));

  // 仅在无过滤且非 fresh 时重建快照（否则快照会丢失 storage 维度语义；
  // fresh 模式下写回会把传播中的旧状态固化成快照，见函数顶部说明）
  if (!storageFilter && !fresh) {
    await writeFolderSnapshot(env, buildFolderSnapshot(allKeys));
  }

  return baseResponse(buildFolderNodes(fileRecords, folderMarkers));
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.img_url) {
    return json({ success: false, error: 'KV binding img_url is not configured.' }, 500);
  }

  const body = await request.json().catch(() => ({}));
  const path = normalizeFolderPath(body.path || body.folderPath || '');
  if (!path) {
    return json({ success: false, error: 'path is required.' }, 400);
  }

  // D1 优先；未绑定时回落 KV（并失效快照）
  const d1 = await ensureFolderMarker(env, path);
  if (d1.disabled) {
    await env.img_url.put(`folder:${path}`, '', {
      metadata: {
        folderMarker: true,
        folderPath: path,
        TimeStamp: Date.now(),
      },
    });
    await invalidateFolderSnapshot(env);
  }

  return json({ success: true, path });
}

export async function onRequestPut(context) {
  const { request, env } = context;
  if (!env.img_url) {
    return json({ success: false, error: 'KV binding img_url is not configured.' }, 500);
  }

  const body = await request.json().catch(() => ({}));
  const sourcePath = normalizeFolderPath(body.sourcePath || body.path || '');
  const targetPath = normalizeFolderPath(body.targetPath || body.newPath || '');

  if (!sourcePath || !targetPath) {
    return json({ success: false, error: 'sourcePath and targetPath are required.' }, 400);
  }
  if (sourcePath === targetPath) {
    return json({ success: false, error: 'sourcePath and targetPath cannot be the same.' }, 400);
  }
  if (folderStartsWith(targetPath, sourcePath)) {
    return json({ success: false, error: 'targetPath cannot be inside sourcePath.' }, 400);
  }

  // ==========================================================================
  // 路径 A：D1 —— 两条 UPDATE 完成整棵目录树的改写
  //   · 原先 KV 版要遍历目录内每个文件逐个 put（N 次网络往返，数百文件可达数秒）
  //   · 这里 UPDATE 的 WHERE 用 folder_path = ? OR LIKE 'path/%' 一次命中全部子孙，
  //     开销与目录大小无关
  // ==========================================================================
  const moved = await moveFolder(env, sourcePath, targetPath);
  if (!moved.disabled) {
    // 目标目录本身要存在（源目录为空时子路径不会产生任何行）
    await ensureFolderMarker(env, targetPath);
    return json({
      success: true,
      sourcePath,
      targetPath,
      updatedFiles: moved.updatedFiles || 0,
      updatedMarkers: moved.updatedMarkers || 0,
      source: 'd1',
    });
  }

  // ==========================================================================
  // 路径 B：KV 兜底（原有逻辑）
  // ==========================================================================
  const allKeys = await listAllKeys(env);
  let updatedFiles = 0;
  let updatedMarkers = 0;

  for (const item of allKeys) {
    if (shouldIncludeFileRecord(item)) {
      const currentFolder = normalizeFolderPath(item.metadata?.folderPath || '');
      if (!folderStartsWith(currentFolder, sourcePath)) continue;

      const suffix = currentFolder === sourcePath ? '' : currentFolder.slice(sourcePath.length + 1);
      const nextFolder = suffix ? `${targetPath}/${suffix}` : targetPath;
      const metadata = {
        ...(item.metadata || {}),
        folderPath: normalizeFolderPath(nextFolder),
      };
      await env.img_url.put(item.name, '', { metadata });
      updatedFiles += 1;
      continue;
    }

    if (isFolderMarker(item)) {
      const markerPath = normalizeFolderPath(
        item.metadata?.folderPath
        || (String(item.name || '').startsWith('folder:') ? String(item.name).slice('folder:'.length) : '')
      );
      if (!folderStartsWith(markerPath, sourcePath)) continue;

      const suffix = markerPath === sourcePath ? '' : markerPath.slice(sourcePath.length + 1);
      const nextFolder = suffix ? `${targetPath}/${suffix}` : targetPath;
      await env.img_url.put(`folder:${normalizeFolderPath(nextFolder)}`, '', {
        metadata: {
          ...(item.metadata || {}),
          folderMarker: true,
          folderPath: normalizeFolderPath(nextFolder),
          TimeStamp: Date.now(),
        },
      });
      if (item.name !== `folder:${normalizeFolderPath(nextFolder)}`) {
        await env.img_url.delete(item.name);
      }
      updatedMarkers += 1;
    }
  }

  await env.img_url.put(`folder:${targetPath}`, '', {
    metadata: {
      folderMarker: true,
      folderPath: targetPath,
      TimeStamp: Date.now(),
    },
  });
  await invalidateFolderSnapshot(env);

  return json({
    success: true,
    sourcePath,
    targetPath,
    updatedFiles,
    updatedMarkers,
  });
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  if (!env.img_url) {
    return json({ success: false, error: 'KV binding img_url is not configured.' }, 500);
  }

  const url = new URL(request.url);
  let path = normalizeFolderPath(url.searchParams.get('path') || '');
  let recursive = ['1', 'true', 'yes'].includes(String(url.searchParams.get('recursive') || '').toLowerCase());

  if (!path) {
    const body = await request.json().catch(() => ({}));
    path = normalizeFolderPath(body.path || body.folderPath || '');
    if (!recursive) {
      recursive = ['1', 'true', 'yes'].includes(String(body.recursive || '').toLowerCase());
    }
  }

  if (!path) {
    return json({ success: false, error: 'path is required.' }, 400);
  }

  // ==========================================================================
  // 路径 A：D1 —— 用 SQL 做前置校验 + 批量改写
  // ==========================================================================
  const content = await folderHasContent(env, path);
  if (!content.disabled) {
    if (!recursive) {
      if (content.hasFiles) {
        return json({ success: false, error: 'Folder is not empty. Use recursive=1 to force.' }, 409);
      }
      if (content.hasChildFolders) {
        return json({ success: false, error: 'Folder has child folders. Use recursive=1 to force.' }, 409);
      }
    }

    let clearedFiles = 0;
    if (recursive) {
      // 目录内文件移回根目录（清空 folder_path，文件本体不删）
      const cleared = await clearFolder(env, path, true);
      clearedFiles = cleared.count || 0;
    }

    // 删除目录标记。非递归时只删自身；递归时连子目录标记一并删。
    const removed = await removeFolderMarkers(env, path, recursive);
    let deletedMarkers = removed.count || 0;
    if (!recursive) {
      // 上面 deleteFolderMarkers(false) 已删掉自身标记，
      // 这里保持与 KV 版一致的计数语义（+1）已在 count 内，无需再补。
      deletedMarkers = deletedMarkers || 1;
    }

    return json({
      success: true,
      path,
      recursive,
      clearedFiles,
      deletedMarkers,
      source: 'd1',
    });
  }

  // ==========================================================================
  // 路径 B：KV 兜底（原有逻辑）
  // ==========================================================================
  const allKeys = await listAllKeys(env);

  const filesInFolder = allKeys.filter((item) => {
    if (!shouldIncludeFileRecord(item)) return false;
    const folderPath = normalizeFolderPath(item.metadata?.folderPath || '');
    return folderStartsWith(folderPath, path);
  });

  const markersInFolder = allKeys.filter((item) => {
    if (!isFolderMarker(item)) return false;
    const markerPath = normalizeFolderPath(
      item.metadata?.folderPath
      || (String(item.name || '').startsWith('folder:') ? String(item.name).slice('folder:'.length) : '')
    );
    return folderStartsWith(markerPath, path);
  });

  if (!recursive) {
    if (filesInFolder.length > 0) {
      return json({ success: false, error: 'Folder is not empty. Use recursive=1 to force.' }, 409);
    }
    const hasChildFolder = markersInFolder.some((item) => {
      const markerPath = normalizeFolderPath(
        item.metadata?.folderPath
        || (String(item.name || '').startsWith('folder:') ? String(item.name).slice('folder:'.length) : '')
      );
      return markerPath !== path;
    });
    if (hasChildFolder) {
      return json({ success: false, error: 'Folder has child folders. Use recursive=1 to force.' }, 409);
    }
  }

  let clearedFiles = 0;
  if (recursive) {
    // 分批并发改写：把目录内文件移回根目录（清空 folderPath，文件本身不删）
    clearedFiles = await runBatched(filesInFolder, (item) => env.img_url.put(item.name, '', {
      metadata: {
        ...(item.metadata || {}),
        folderPath: '',
      },
    }));
  }

  // 分批并发删除目录标记
  let deletedMarkers = await runBatched(markersInFolder, (marker) => env.img_url.delete(marker.name));

  if (!recursive) {
    await env.img_url.delete(`folder:${path}`);
    deletedMarkers += 1;
  }
  await invalidateFolderSnapshot(env);

  return json({
    success: true,
    path,
    recursive,
    clearedFiles,
    deletedMarkers,
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
