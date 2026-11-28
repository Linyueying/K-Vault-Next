import { isD1Enabled } from '../../utils/metadata-d1.js';
import {
  isDavFolderPath,
  listWebdavMountFolders,
  readWebdavMount,
  saveWebdavMount,
} from '../../utils/webdav-mount.js';

function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function settingsResponse(env) {
  const [mount, folders] = await Promise.all([readWebdavMount(env), listWebdavMountFolders(env)]);
  return json({ ...mount, folders });
}

export async function onRequestGet({ env }) {
  try {
    return await settingsResponse(env);
  } catch (error) {
    console.error('WebDAV mount settings read failed:', error?.message);
    return json({ error: '暂时无法读取 WebDAV 挂载根目录。' }, 503);
  }
}

export async function onRequestPut({ request, env }) {
  const body = await request.json().catch(() => null);
  const rootPath = body?.rootPath;
  if (rootPath !== '' && !isDavFolderPath(rootPath)) {
    return json({ error: '请选择有效的挂载根目录。' }, 400);
  }
  if (!isD1Enabled(env)) {
    return json({ error: '设置挂载根目录需要绑定 D1 文件数据库。' }, 503);
  }
  try {
    if (!(await saveWebdavMount(env, rootPath))) {
      return json({ error: '目标文件夹已不存在，请刷新后重新选择。' }, 409);
    }
    return await settingsResponse(env);
  } catch (error) {
    console.error('WebDAV mount settings save failed:', error?.message);
    return json({ error: '暂时无法保存 WebDAV 挂载根目录。' }, 503);
  }
}
