export async function onRequest(context) {
    // 清除认证 cookie 并返回 401
    return new Response('Logged out.', { 
      status: 401,
      headers: {
        'Set-Cookie': 'auth=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict',
        'WWW-Authenticate': 'Basic realm="K-Vault Admin"'
      }
    });
  }
