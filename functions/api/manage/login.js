import { checkAuthentication } from '../../utils/auth.js';

/**
 * Login entry helper.
 *
 *   - already authenticated -> /admin.html
 *   - otherwise             -> /login.html?redirect=%2Fadmin.html
 *
 * This route is allowlisted in ./_middleware.js so it stays reachable while
 * logged out; otherwise the redirect could never happen.
 */
export async function onRequest(context) {
  const { request } = context;

  const auth = await checkAuthentication(context);
  const target = auth?.authenticated
    ? '/admin.html'
    : '/login.html?redirect=%2Fadmin.html';

  const origin = new URL(request.url).origin;
  return Response.redirect(new URL(target, origin).toString(), 302);
}
