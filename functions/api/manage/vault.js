/**
 * 密码库专用同步接口（继承 `/api/manage/**` fail-closed 管理员会话鉴权）。
 *
 * 端点契约：
 *   GET    /api/manage/vault[?metaOnly=1]  → 读取云端密文信封及当前版本号 revision
 *   PUT    /api/manage/vault               → 带乐观锁（expectedRevision）原子写入；版本冲突返回 409 + 服务端最新信封
 *   DELETE /api/manage/vault               → 删除云端密码库记录
 *
 * 所有响应均带 `Cache-Control: no-store`，避免浏览器或边缘缓存返回陈旧版本号。
 *
 * @module api/manage/vault
 */
import {
  DEFAULT_VAULT_KEY,
  deleteVaultRecord,
  getVaultRecord,
  putVaultRecord,
} from '../../utils/vault-store.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
    },
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const url = new URL(request.url);
    const metaOnly = url.searchParams.get('metaOnly') === '1' || url.searchParams.get('metaOnly') === 'true';
    const record = await getVaultRecord(env, { vaultKey: DEFAULT_VAULT_KEY, metaOnly });
    return jsonResponse({ ok: true, ...record }, 200);
  } catch (error) {
    const status = Number(error?.status) || 500;
    return jsonResponse({ ok: false, error: error?.message || '读取云端密码库失败。' }, status);
  }
}

export async function onRequestPut(context) {
  const { request, env } = context;

  let body = null;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: '请求体必须是 JSON。' }, 400);
  }

  try {
    const result = await putVaultRecord(env, {
      vaultKey: DEFAULT_VAULT_KEY,
      envelope: body?.envelope,
      expectedRevision: body?.expectedRevision ?? 0,
      deviceId: body?.deviceId || '',
      force: body?.force === true,
    });

    if (result.conflict) {
      return jsonResponse(
        {
          ok: false,
          code: 'VAULT_CONFLICT',
          error: '云端密码库已有更新版本，请合并后重试。',
          ...(result.current || {}),
        },
        409
      );
    }

    return jsonResponse({ ok: true, ...result }, 200);
  } catch (error) {
    const status = Number(error?.status) || 500;
    return jsonResponse({ ok: false, error: error?.message || '保存云端密码库失败。' }, status);
  }
}

export async function onRequestDelete(context) {
  const { env } = context;
  try {
    const result = await deleteVaultRecord(env, { vaultKey: DEFAULT_VAULT_KEY });
    return jsonResponse({ ok: true, deleted: Boolean(result.deleted) }, 200);
  } catch (error) {
    const status = Number(error?.status) || 500;
    return jsonResponse({ ok: false, error: error?.message || '删除云端密码库失败。' }, status);
  }
}
