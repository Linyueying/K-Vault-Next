import { ensureSchema } from './schema.js';
import { isD1Enabled } from './metadata-d1.js';

const UNAVAILABLE = 'WebDAV mount settings are temporarily unavailable.';

/** Validate one decoded path segment before handing it to the mounted DAV namespace. */
export function isDavSegment(segment) {
  return typeof segment === 'string' && Boolean(segment) && segment.trim() === segment &&
    segment !== '.' && segment !== '..' && !/[/\\\x00-\x1f\x7f]/.test(segment);
}

export function isDavFolderPath(path) {
  return typeof path === 'string' && Boolean(path) && path.split('/').every(isDavSegment);
}

async function mountDb(env) {
  if (!(await ensureSchema(env)).ok) throw new Error(UNAVAILABLE);
  return env.DB;
}

export async function readWebdavMount(env) {
  if (!isD1Enabled(env)) return { status: 'unsupported', rootPath: '' };
  const db = await mountDb(env);
  const row = await db.prepare(`
    SELECT mount.root_path, mount.invalidated, marker.id AS marker_id
    FROM webdav_mount AS mount
    LEFT JOIN files AS marker ON marker.id = ('folder:' || mount.root_path)
      AND marker.folder_path = mount.root_path AND marker.is_folder = 1 AND marker.trashed_at IS NULL
    WHERE mount.id = 1
  `).first();

  if (!row?.root_path) return { status: 'library', rootPath: '' };
  const available = !row.invalidated && row.marker_id && isDavFolderPath(row.root_path);
  return { status: available ? 'ready' : 'missing', rootPath: row.root_path };
}

export async function listWebdavMountFolders(env) {
  if (!isD1Enabled(env)) return [];
  const db = await mountDb(env);
  const rows = await db.prepare(`
    SELECT folder_path FROM files
    WHERE is_folder = 1 AND trashed_at IS NULL AND id = ('folder:' || folder_path)
    ORDER BY folder_path
  `).all();
  return (rows.results || []).map(row => row.folder_path).filter(isDavFolderPath);
}

/** Validate and select the marker atomically. The old selection survives a rejected save. */
export async function saveWebdavMount(env, rootPath) {
  const db = await mountDb(env);
  if (rootPath === '') {
    await db.prepare('DELETE FROM webdav_mount WHERE id = 1').run();
    return true;
  }
  const row = await db.prepare(`
    INSERT INTO webdav_mount (id, root_path, invalidated)
    SELECT 1, folder_path, 0 FROM files
    WHERE id = ? AND folder_path = ? AND is_folder = 1 AND trashed_at IS NULL
    ON CONFLICT(id) DO UPDATE SET root_path = excluded.root_path, invalidated = 0
    RETURNING id
  `).bind('folder:' + rootPath, rootPath).first();
  return row?.id === 1;
}
