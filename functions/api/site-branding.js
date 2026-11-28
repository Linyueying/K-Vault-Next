/**
 * 站点品牌公开读取接口（无鉴权）
 *
 *   GET /api/site-branding  →  { siteName, siteTitle, source }
 *
 * 用途：让静态前端（index.html 等）在加载时拉取管理员在后台设置的
 * 网站显示名（siteName）与浏览器标签标题（siteTitle），替换硬编码的
 * 旧名字（如「一云」）。未设置时回落到默认值 K-Vault-NEXT。
 *
 * 设计要点：
 *   · 不进任何 _middleware 鉴权（functions/api 下只有 admin / manage / v1
 *     三处有中间件），因此是公开接口，可被任意页面、甚至外部站点读取。
 *   · 返回带 `Cache-Control: public`，交给 CDN 边缘缓存；品牌不是高频变更项，
 *     60s 的缓存窗口足够，又能让后台改完在 1 分钟内全量生效。
 *   · 与运行时配置层复用同一份「KV 覆盖 > 环境变量基线」判定，保证后台
 *     保存后立即反映，且未配置时与默认部署行为一致。
 */
import { getBrandingConfigResolved } from '../utils/runtime-config.js';

export async function onRequestGet(context) {
    const { env } = context;
    try {
        const cfg = await getBrandingConfigResolved(env);
        return new Response(
            JSON.stringify({
                siteName: cfg?.siteName || 'K-Vault-NEXT',
                siteTitle: cfg?.siteTitle || 'K-Vault-NEXT',
                source: cfg?.source || 'env'
            }),
            {
                status: 200,
                headers: {
                    'Content-Type': 'application/json; charset=utf-8',
                    // 边缘缓存：品牌低频变更，1 分钟足够新鲜
                    'Cache-Control': 'public, max-age=60, s-maxage=60'
                }
            }
        );
    } catch (error) {
        console.error('site-branding read error:', error);
        // 读取失败也别让前端崩：回退默认名，前端照常渲染
        return new Response(
            JSON.stringify({ siteName: 'K-Vault-NEXT', siteTitle: 'K-Vault-NEXT', source: 'default' }),
            {
                status: 200,
                headers: {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': 'public, max-age=30'
                }
            }
        );
    }
}
