export function parseByteLength(value) {
  if (!/^\d+$/.test(String(value ?? ''))) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

/** The length must describe the bytes we forward, including for partial responses. */
export function upstreamByteLength(response, fullSize = null) {
  const encoding = response.headers.get('Content-Encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') return null;

  const declared = parseByteLength(response.headers.get('Content-Length'));
  if (response.status === 206) {
    const range = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/i.exec(response.headers.get('Content-Range') || '');
    if (!range) return declared > 0 ? declared : null;
    const start = parseByteLength(range[1]);
    const end = parseByteLength(range[2]);
    if (start === null || end === null || end < start) return null;
    const length = end - start + 1;
    return Number.isSafeInteger(length) && (!declared || declared === length) ? length : null;
  }

  // Some backends use 0 to mean unknown. Only use a zero supplied by trusted object metadata.
  if (declared > 0) return declared;
  return response.status === 200 ? parseByteLength(fullSize) : null;
}

/** Attach at the end: e.g. the byte cache's transform otherwise loses the stream length. */
export function withDownloadLength(response) {
  if (![200, 206].includes(response.status)) return response;
  const size = parseByteLength(response.headers.get('Content-Length'));
  if (size === null) return response;

  const headers = new Headers(response.headers);
  const policy = headers.get('Cache-Control');
  if (!policy) {
    headers.set('Cache-Control', 'no-transform');
  } else if (!/(?:^|,)\s*no-transform(?:\s*,|$)/i.test(policy)) {
    headers.set('Cache-Control', `${policy}, no-transform`);
  }
  let body = response.body;

  // Workers derives the wire header from the body, ignoring a manually set length on generic streams.
  if (body && typeof FixedLengthStream === 'function') {
    const { readable, writable } = new FixedLengthStream(size);
    body.pipeTo(writable).catch(() => {}); // The returned readable propagates the stream error.
    body = readable;
  }

  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
