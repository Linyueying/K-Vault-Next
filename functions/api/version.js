/**
 * GET /api/version → { version, commit }
 *
 * 顶栏品牌区「版本号 · 提交号」的轻量只读端点。公开无需鉴权：
 * 版本号与提交号本来就会随部署公开，不构成信息泄露。
 *
 * 字段来源：
 *   · version：优先读环境变量 APP_VERSION（升级版本时可在 vars 里改），
 *     未配置时回落到内置默认值（与 index.js 的 versionLabel 默认值保持一致）。
 *   · commit：Cloudflare Pages **Git 集成部署**会注入 CF_PAGES_COMMIT_SHA；
 *     direct upload（wrangler pages deploy）没有该变量，可手动在
 *     vars / .env 里配置 APP_COMMIT_SHA 兜底。两者都没有时返回空串，
 *     前端据此回退为只显示版本号。
 *
 * 提交号统一截短为 7 位（与 git log --oneline 一致），避免长串 sha 撑破顶栏。
 *
 * @module api/version
 */

/** 未配置 APP_VERSION 时的默认版本号（发版时同步更新此处与 index.js） */
const DEFAULT_VERSION = 'v0.1.0';

/** 提交号显示长度（git 默认短 sha） */
const SHORT_SHA_LENGTH = 7;

export async function onRequestGet(context) {
  const { env } = context;

  const version = String(env?.APP_VERSION || DEFAULT_VERSION).trim() || DEFAULT_VERSION;
  const rawCommit = String(env?.CF_PAGES_COMMIT_SHA || env?.APP_COMMIT_SHA || '').trim();

  return Response.json(
    {
      version,
      commit: rawCommit.slice(0, SHORT_SHA_LENGTH),
    },
    { headers: { 'Cache-Control': 'public, max-age=300' } },
  );
}
