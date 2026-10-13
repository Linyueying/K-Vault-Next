import { checkAuthentication, isAuthRequired } from '../../utils/auth.js';
import { apiError } from '../../utils/api-v1.js';
import { handleApiPreflight } from '../../utils/cors.js';

/**
 * 缩略图写入端点中间件 —— 与 /api/admin/** 同一套 fail-closed 策略。
 *
 * 为什么不是「谁上传谁就能写」：缩略图是写在**任意 fileKey** 上的附属对象，
 * 若不对写入者设门槛，任何人都能拿一个猜到的 key 往 KV / R2 里塞垃圾字节。
 * 逐请求校验「这个 key 是不是他刚上传的」需要额外状态，收益不抵复杂度；
 * 直接要求管理员身份，与删除 / 改名 / 分享配置保持一致。
 *
 * 后果（有意为之）：访客上传的图片不会生成缩略图，列表里走 302 回退原图。
 */
export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return await handleApiPreflight(request, env);
  }

  if (!env?.img_url) {
    return apiError('SERVER_MISCONFIGURED', 'KV binding img_url is not configured.', 500);
  }

  if (!isAuthRequired(env)) {
    return apiError(
      'ADMIN_AUTH_NOT_CONFIGURED',
      'Thumbnail upload requires BASIC_USER and BASIC_PASS to be configured. It fails closed when no admin credential is set.',
      503
    );
  }

  const authResult = await checkAuthentication(context);
  if (!authResult.authenticated) {
    return apiError('UNAUTHORIZED', 'Admin authentication required.', 401);
  }

  return context.next();
}
