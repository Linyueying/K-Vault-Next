const SHARE_SLUG_KEY_PREFIX = 'share_slug:';

function decodePathParam(rawValue = '') {
  try {
    return decodeURIComponent(String(rawValue || ''));
  } catch {
    return String(rawValue || '');
  }
}

function normalizeSlug(rawValue = '') {
  const value = String(rawValue || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,64}$/.test(value)) return '';
  return value;
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const rawValue = decodePathParam(params?.slug || '');
  if (!rawValue) {
    return new Response('Not found', { status: 404 });
  }

  let targetId = '';
  const normalizedSlug = normalizeSlug(rawValue);

  if (normalizedSlug && env?.img_url) {
    const mappedId = await env.img_url.get(`${SHARE_SLUG_KEY_PREFIX}${normalizedSlug}`);
    if (mappedId) {
      targetId = String(mappedId);
    }
  }

  if (!targetId) {
    // Backward compatibility: `/s/:id` can also directly carry a file id.
    targetId = rawValue;
  }

  const redirectUrl = new URL(`/file/${encodeURIComponent(targetId)}`, request.url);
  const sourceUrl = new URL(request.url);
  sourceUrl.searchParams.forEach((value, key) => {
    redirectUrl.searchParams.set(key, value);
  });

  return Response.redirect(redirectUrl.toString(), 302);
}
