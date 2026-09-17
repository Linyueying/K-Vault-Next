const STORAGE_PREFIXES = ['img:', 'vid:', 'aud:', 'doc:', 'r2:', 's3:', 'discord:', 'hf:', 'webdav:', 'github:', ''];
const INVALID_PREFIXES = ['session:', 'chunk:', 'upload:', 'temp:'];

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

async function findRecordWithKey(env, fileId) {
  const hasKnownPrefix = STORAGE_PREFIXES.some((prefix) => prefix && fileId.startsWith(prefix));
  const candidateKeys = hasKnownPrefix ? [fileId] : STORAGE_PREFIXES.map((prefix) => `${prefix}${fileId}`);

  for (const key of candidateKeys) {
    const record = await env.img_url.getWithMetadata(key);
    if (record?.metadata) {
      return { record, kvKey: key };
    }
  }
  return { record: null, kvKey: fileId };
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

  if (!env.img_url) {
    return json({ success: false, error: 'KV binding img_url is not configured.' }, 500);
  }

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

  return json({
    success: true,
    folders: buildFolderNodes(fileRecords, folderMarkers),
  });
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

  await env.img_url.put(`folder:${path}`, '', {
    metadata: {
      folderMarker: true,
      folderPath: path,
      TimeStamp: Date.now(),
    },
  });

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
    for (const item of filesInFolder) {
      const metadata = {
        ...(item.metadata || {}),
        folderPath: '',
      };
      await env.img_url.put(item.name, '', { metadata });
      clearedFiles += 1;
    }
  }

  let deletedMarkers = 0;
  for (const marker of markersInFolder) {
    await env.img_url.delete(marker.name);
    deletedMarkers += 1;
  }

  if (!recursive) {
    await env.img_url.delete(`folder:${path}`);
    deletedMarkers += 1;
  }

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
