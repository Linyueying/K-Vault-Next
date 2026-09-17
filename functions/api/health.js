export async function onRequest() {
  return new Response(JSON.stringify({
    ok: true,
    mode: 'pages-functions',
    timestamp: Date.now(),
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
