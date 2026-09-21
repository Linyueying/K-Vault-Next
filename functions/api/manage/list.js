import {
  normalizeFolderPath,
  isFolderMarker,
  shouldIncludeKey,
  normalizeKey,
  listAllKeys,
} from '../../utils/file-list.js';

function matchStorage(storageType, storageFilter) {
  if (!storageFilter) return true;
  if (storageFilter === 'kv' || storageFilter === 'telegram') return storageType === 'telegram';
  return storageType === storageFilter;
}

function compareByTimestampDesc(a, b) {
  const left = Number(a?.metadata?.TimeStamp || 0);
  const right = Number(b?.metadata?.TimeStamp || 0);
  return right - left;
}

function compareByFileSizeAsc(a, b) {
  const left = Number(a?.metadata?.fileSize || 0);
  const right = Number(b?.metadata?.fileSize || 0);
  if (left !== right) return left - right;
  const leftTs = Number(a?.metadata?.TimeStamp || 0);
  const rightTs = Number(b?.metadata?.TimeStamp || 0);
  return rightTs - leftTs;
}

function computeStats(files) {
  const stats = {
    total: 0,
    byType: { image: 0, video: 0, audio: 0, document: 0 },
    byStorage: {
      telegram: 0,
      r2: 0,
      s3: 0,
      discord: 0,
      huggingface: 0,
      webdav: 0,
      github: 0,
    },
  };

  for (const file of files) {
    const fileType = file.metadata?.fileType || 'document';
    const storageType = file.metadata?.storageType || 'telegram';

    stats.total += 1;
    if (Object.prototype.hasOwnProperty.call(stats.byType, fileType)) {
      stats.byType[fileType] += 1;
    } else {
      stats.byType.document += 1;
    }

    if (Object.prototype.hasOwnProperty.call(stats.byStorage, storageType)) {
      stats.byStorage[storageType] += 1;
    }
  }

  return stats;
}

function collectFolderPaths(files, folderMarkers = []) {
  const paths = new Set();

  for (const marker of folderMarkers) {
    const metadataPath = normalizeFolderPath(marker?.metadata?.folderPath || marker?.metadata?.path || '');
    const keyPath = String(marker?.name || '').startsWith('folder:')
      ? normalizeFolderPath(String(marker.name).slice('folder:'.length))
      : '';
    const path = metadataPath || keyPath;
    if (path) {
      paths.add(path);
      includeParentPaths(path, paths);
    }
  }

  for (const file of files) {
    const path = normalizeFolderPath(file?.metadata?.folderPath || '');
    if (!path) continue;
    paths.add(path);
    includeParentPaths(path, paths);
  }

  return paths;
}

function includeParentPaths(pathValue, targetSet) {
  const parts = normalizeFolderPath(pathValue).split('/').filter(Boolean);
  for (let i = 1; i < parts.length; i += 1) {
    targetSet.add(parts.slice(0, i).join('/'));
  }
}

function buildFolderNodes(files, folderMarkers = []) {
  const fileCountByFolder = new Map();
  for (const file of files) {
    const folderPath = normalizeFolderPath(file?.metadata?.folderPath || '');
    if (!folderPath) continue;
    fileCountByFolder.set(folderPath, (fileCountByFolder.get(folderPath) || 0) + 1);
  }

  const folderPaths = [...collectFolderPaths(files, folderMarkers)].sort((a, b) => {
    const depthA = a.split('/').length;
    const depthB = b.split('/').length;
    if (depthA !== depthB) return depthA - depthB;
    return a.localeCompare(b, 'en', { sensitivity: 'base' });
  });

  return folderPaths.map((pathValue) => {
    const parts = pathValue.split('/');
    const name = parts[parts.length - 1] || pathValue;
    const parentPath = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    return {
      path: pathValue,
      name,
      parentPath,
      depth: parts.length,
      fileCount: fileCountByFolder.get(pathValue) || 0,
    };
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (!env.img_url) {
    return new Response(JSON.stringify({ error: 'KV binding img_url is not configured.' }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      },
    });
  }

  const rawLimit = url.searchParams.get('limit');
  let limit = parseInt(rawLimit || '100', 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 100;
  if (limit > 1000) limit = 1000;

  const offset = Math.max(0, parseInt(url.searchParams.get('cursor') || '0', 10) || 0);
  const prefix = url.searchParams.get('prefix') || '';
  const storageFilter = String(url.searchParams.get('storage') || '').toLowerCase();

  // 修复：区分"没传 folderPath"和"传了空的 folderPath（=根目录）"
  const rawFolderPath = url.searchParams.get('folderPath');
  const rawFolderAlias = url.searchParams.get('folder');
  const hasFolderFilter = rawFolderPath !== null || rawFolderAlias !== null;
  const folderFilter = hasFolderFilter
    ? normalizeFolderPath(rawFolderPath !== null ? rawFolderPath : (rawFolderAlias || ''))
    : '';

  const sort = String(url.searchParams.get('sort') || '').toLowerCase();
  const includeStats = ['1', 'true', 'yes'].includes(
    String(url.searchParams.get('includeStats') || url.searchParams.get('stats') || '').toLowerCase()
  );
  const includeFolders = ['1', 'true', 'yes'].includes(
    String(url.searchParams.get('includeFolders') || '').toLowerCase()
  );

  const allKeys = await listAllKeys(env, prefix);
  const folderMarkers = allKeys.filter(isFolderMarker);

  const normalizedFiles = allKeys
    .filter(shouldIncludeKey)
    .map(normalizeKey)
    .filter((item) => matchStorage(item.metadata?.storageType, storageFilter));

  const sorter = (sort === 'sizeasc' || sort === 'smallfirst')
    ? compareByFileSizeAsc
    : compareByTimestampDesc;

  // 修复：folderPath 为空字符串时 → 只返回根目录文件（folderPath 也是空）
  const filtered = normalizedFiles
    .filter((item) => {
      if (!hasFolderFilter) return true;
      const itemFolder = normalizeFolderPath(item.metadata?.folderPath || '');
      return itemFolder === folderFilter;
    })
    .sort(sorter);

  const page = filtered.slice(offset, offset + limit);
  const nextOffset = offset + limit < filtered.length ? offset + limit : null;

  const payload = {
    keys: page,
    pageCount: page.length,
    cursor: nextOffset == null ? null : String(nextOffset),
    list_complete: nextOffset == null,
  };

  if (includeStats) {
    payload.stats = computeStats(filtered);
  }

  if (includeFolders) {
    payload.folders = buildFolderNodes(normalizedFiles, folderMarkers);
  }

  return new Response(JSON.stringify(payload), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    },
  });
}