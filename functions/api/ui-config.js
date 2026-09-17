import { checkAuthentication, isAuthRequired } from '../utils/auth.js';
import { apiError, apiSuccess } from '../utils/api-v1.js';

const UI_CONFIG_KEY = 'ui_config';
const KV_BINDING_CANDIDATES = ['img_url', 'KV', 'UI_CONFIG_KV'];
const EFFECT_STYLES = new Set(['none', 'math', 'particle', 'texture']);

const DEFAULT_UI_CONFIG = {
  version: 1,
  baseColor: '#fafaf8',
  globalBackgroundUrl: '',
  loginBackgroundMode: 'follow-global',
  loginBackgroundUrl: '',
  cardOpacity: 86,
  cardBlur: 14,
  effectStyle: 'math',
  effectIntensity: 22,
  optimizeMobile: true,
};

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}

function normalizeHexColor(value) {
  const text = String(value || '').trim();
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(text)) {
    return DEFAULT_UI_CONFIG.baseColor;
  }
  if (text.length === 4) {
    return (
      '#' +
      text[1] +
      text[1] +
      text[2] +
      text[2] +
      text[3] +
      text[3]
    ).toLowerCase();
  }
  return text.toLowerCase();
}

function sanitizeUrl(url) {
  const text = String(url || '').trim();
  if (!text) return '';
  if (/^(https?:)?\/\//i.test(text)) return text;
  if (/^\//.test(text)) return text;
  return '';
}

function normalizeUiConfig(raw) {
  const next = Object.assign({}, DEFAULT_UI_CONFIG, raw || {});
  next.baseColor = normalizeHexColor(next.baseColor);
  next.globalBackgroundUrl = sanitizeUrl(next.globalBackgroundUrl);
  next.loginBackgroundMode = next.loginBackgroundMode === 'custom' ? 'custom' : 'follow-global';
  next.loginBackgroundUrl = sanitizeUrl(next.loginBackgroundUrl);
  next.cardOpacity = Math.round(clampNumber(next.cardOpacity, 0, 100));
  next.cardBlur = Math.round(clampNumber(next.cardBlur, 0, 32));
  next.effectStyle = EFFECT_STYLES.has(next.effectStyle) ? next.effectStyle : DEFAULT_UI_CONFIG.effectStyle;
  next.effectIntensity = Math.round(clampNumber(next.effectIntensity, 0, 100));
  next.optimizeMobile = next.optimizeMobile !== false;
  return next;
}

function extractUiConfigPayload(body = {}) {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    if (body.config && typeof body.config === 'object' && !Array.isArray(body.config)) {
      return body.config;
    }
    if (body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)) {
      return body.settings;
    }
    return body;
  }
  return {};
}

function resolveKvBinding(env = {}) {
  for (const name of KV_BINDING_CANDIDATES) {
    const candidate = env?.[name];
    if (candidate && typeof candidate.get === 'function' && typeof candidate.put === 'function') {
      return { name, binding: candidate };
    }
  }
  return null;
}

function missingKvBindingResponse() {
  return apiError(
    'KV_BINDING_MISSING',
    '未检测到可用的 KV 命名空间绑定，请在 Cloudflare Pages -> Settings -> Functions -> KV namespace bindings 中绑定并重新部署。',
    500,
    { expectedBindings: KV_BINDING_CANDIDATES }
  );
}

export async function onRequestOptions() {
  return new Response(null, { status: 204 });
}

export async function onRequestGet(context) {
  const kv = resolveKvBinding(context.env);
  if (!kv) {
    console.error('[ui-config] KV binding missing. Expected one of:', KV_BINDING_CANDIDATES.join(', '));
    return missingKvBindingResponse();
  }

  let saved = null;
  try {
    saved = await kv.binding.get(UI_CONFIG_KEY, { type: 'json' });
  } catch (error) {
    console.error('[ui-config] Failed to read config from KV:', {
      binding: kv.name,
      error: error?.message || String(error),
    });
    return apiError(
      'KV_READ_FAILED',
      '读取 UI 配置失败，请检查 KV 绑定与 Functions 日志。',
      500,
      { binding: kv.name, detail: error?.message || String(error) }
    );
  }

  const config = normalizeUiConfig(saved || DEFAULT_UI_CONFIG);
  return apiSuccess({
    config,
    source: saved ? 'kv' : 'default',
    binding: kv.name,
  });
}

export async function onRequestPost(context) {
  const kv = resolveKvBinding(context.env);
  if (!kv) {
    console.error('[ui-config] KV binding missing. Expected one of:', KV_BINDING_CANDIDATES.join(', '));
    return missingKvBindingResponse();
  }

  if (!isAuthRequired(context.env)) {
    console.warn('[ui-config] Write blocked: no admin credential configured.');
    return apiError(
      'ADMIN_AUTH_NOT_CONFIGURED',
      '需要先配置 BASIC_USER 和 BASIC_PASS 才能保存 UI 配置。',
      503
    );
  }

  const auth = await checkAuthentication(context);
  if (!auth.authenticated) {
    console.warn('[ui-config] Unauthorized write attempt blocked.');
    return apiError('UNAUTHORIZED', '需要先登录管理员账号。', 401);
  }

  let body = {};
  try {
    body = await context.request.json();
  } catch {
    body = {};
  }

  const config = normalizeUiConfig(extractUiConfigPayload(body));
  try {
    await kv.binding.put(UI_CONFIG_KEY, JSON.stringify(config));
  } catch (error) {
    console.error('[ui-config] Failed to write config to KV:', {
      binding: kv.name,
      error: error?.message || String(error),
    });
    return apiError(
      'KV_WRITE_FAILED',
      '保存 UI 配置失败，请检查 KV 绑定权限与 Functions 日志。',
      500,
      { binding: kv.name, detail: error?.message || String(error) }
    );
  }

  return apiSuccess({
    config,
    source: 'kv',
    binding: kv.name,
  });
}
