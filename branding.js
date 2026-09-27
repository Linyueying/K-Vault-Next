/**
 * branding.js —— 站点品牌动态注入（轻量、无依赖）
 *
 * 从公开接口 /api/site-branding 读取管理员在后台设置的
 * 「网站名字 siteName」与「网站标题 siteTitle」，替换页面里硬编码的旧名字。
 *
 * 适用点：
 *   · document.title                       → siteTitle
 *   · 所有 [data-brand-name] 元素文本       → siteName（首页品牌 <h1> 等）
 *   · meta[property="og:title"]            → siteTitle
 *   · meta[name="description"] 的品牌前缀   → siteName
 *
 * 设计要点：
 *   · 纯原生 JS，依赖度为 0，任何页面 <script defer> 引入即可用。
 *   · 结果按 URL 缓存在模块级变量里，同一页面多次调用只发一次请求。
 *   · 接口读取失败或返回空 → 不改动页面（保持原硬编码值），绝不抛错中断渲染。
 *   · 用 ?force 或 window.__brandForce 可跳过缓存（调试用）。
 */
(function () {
  'use strict';

  var cache = null; // { siteName, siteTitle }

  function applyBranding(data) {
    if (!data) return;
    var name = (data.siteName || '').trim();
    var title = (data.siteTitle || '').trim();
    if (!name && !title) return; // 没配置就别动，保留原值

    try {
      if (title && document.title) {
        document.title = title;
      }
    } catch (e) { /* ignore */ }

    if (name) {
      var nodes = document.querySelectorAll('[data-brand-name]');
      for (var i = 0; i < nodes.length; i++) {
        nodes[i].textContent = name;
      }
    }

    try {
      var og = document.querySelector('meta[property="og:title"]');
      if (og && title) og.setAttribute('content', title);

      var desc = document.querySelector('meta[name="description"]');
      if (desc && name) {
        var cur = desc.getAttribute('content') || '';
        // 把开头的「旧品牌名 · 」替换成新名字；无分隔符则整体前置
        var next = cur.replace(/^[^·]+ · /, name + ' · ');
        if (next === cur && cur.indexOf(' · ') === -1) next = name + ' · ' + cur;
        desc.setAttribute('content', next);
      }
    } catch (e) { /* ignore */ }
  }

  function loadBranding(force) {
    if (cache && !force) {
      applyBranding(cache);
      return Promise.resolve(cache);
    }
    return fetch('/api/site-branding', { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && (data.siteName || data.siteTitle)) {
          cache = data;
          applyBranding(data);
        }
        return data;
      })
      .catch(function () { return null; });
  }

  // 暴露给需要手动触发的场景（如 SPA 路由切换后）
  window.applySiteBranding = function (force) { return loadBranding(!!force); };

  // 自动应用：DOM 就绪即拉取；若 Vue 还没挂载（defer 顺序原因），
  // 等 DOMContentLoaded 再补一次，确保 [data-brand-name] 已存在。
  function auto() { loadBranding(false); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', auto);
  } else {
    auto();
  }
  // 兜底：极端情况下 defer 顺序导致首轮未命中，下一帧再试一次
  window.addEventListener('load', function () { loadBranding(false); });
})();
