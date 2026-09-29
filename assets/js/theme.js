(function () {
  "use strict";

  /* 与各页既有实现共用同一个存储键。
     历史上这里用 "themeMode"，而 index.html / admin.html 自带的切换逻辑用 "theme"，
     两套键并存会导致主题偏好互相覆盖、刷新后回退。统一到 "theme"。 */
  var STORAGE_KEY = "theme";
  var LEGACY_KEY = "themeMode";
  var THEME_ATTR = "data-theme";
  var VALID = { light: true, dark: true };
  var root = document.documentElement;

  function normalizeTheme(theme) {
    return VALID[theme] ? theme : "light";
  }

  function getStoredTheme() {
    try {
      var value = localStorage.getItem(STORAGE_KEY);
      if (!value) {
        // 兼容旧键：迁移一次，避免老用户偏好丢失
        var legacy = localStorage.getItem(LEGACY_KEY);
        if (legacy && VALID[legacy]) {
          localStorage.setItem(STORAGE_KEY, legacy);
          value = legacy;
        }
      }
      return normalizeTheme(value);
    } catch (e) {
      return "light";
    }
  }

  function getCurrentTheme() {
    return normalizeTheme(root.getAttribute(THEME_ATTR));
  }

  function updateToggleVisual(button, theme) {
    var normalized = normalizeTheme(theme);
    var icon = button.querySelector("[data-theme-icon]");
    var label = button.querySelector("[data-theme-label]");
    var toDark = normalized !== "dark";

    button.setAttribute(
      "aria-label",
      toDark ? "切换到夜间模式" : "切换到亮色模式"
    );
    button.setAttribute(
      "title",
      toDark ? "切换到夜间模式" : "切换到亮色模式"
    );

    if (icon) {
      icon.className = toDark ? "fas fa-moon" : "fas fa-sun";
    }
    if (label) {
      label.textContent = toDark ? "夜间" : "亮色";
    }
  }

  function updateAllToggles(theme) {
    var toggles = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < toggles.length; i++) {
      updateToggleVisual(toggles[i], theme);
    }
  }

  function applyTheme(theme, options) {
    var opts = options || {};
    var persist = opts.persist !== false;
    var broadcast = opts.broadcast !== false;
    var normalized = normalizeTheme(theme);

    root.setAttribute(THEME_ATTR, normalized);
    root.style.colorScheme = normalized;
    updateAllToggles(normalized);

    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, normalized);
      } catch (e) {}
    }

    if (broadcast) {
      try {
        window.dispatchEvent(
          new CustomEvent("theme:change", { detail: { theme: normalized } })
        );
      } catch (e) {}
    }

    return normalized;
  }

  function bindToggle(button) {
    if (!button || button.dataset.themeBound === "1") return;
    button.dataset.themeBound = "1";
    button.addEventListener("click", function () {
      ThemeManager.toggleTheme();
    });
    updateToggleVisual(button, getCurrentTheme());
  }

  function createToggleButton(className) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.setAttribute("data-theme-toggle", "");
    button.innerHTML =
      '<i class="fas fa-moon" data-theme-icon></i><span data-theme-label>夜间</span>';
    return button;
  }

  /* 页面若已自带主题切换按钮（例如 index.html 的 toggleLiquidTheme、admin.html 的
     toggleTheme），就不要凭空再造一个浮动按钮 —— 那会出现两个切换入口，观感与
     行为都不对。
     注意：这里刻意用一个**独立属性名** `data-own-theme-toggle`，而不是复用
     `data-theme-toggle`。后者会被 initDom() 的 querySelectorAll('[data-theme-toggle]')
     扫到并绑定点击处理器；若挂在 <body> 上，body 就会变成第二个切换按钮，
     导致同一次点击被处理两次、主题来回抵消。 */
  function pageHasOwnToggle() {
    return document.documentElement.hasAttribute("data-own-theme-toggle");
  }

  function ensureAutoToggle() {
    if (document.querySelector("[data-theme-toggle]")) return;
    if (pageHasOwnToggle()) return;

    /* 这里原本还有两条「插入到页头」的分支：
         document.querySelector(".header .nav-links")
         document.querySelector(".header-content .actions")
       但本仓库 8 个页面里**都不存在** .header / .nav-links / .header-content，
       两个选择器永远匹配不到，属历史遗留的死分支（伴随一整层对应的死 CSS）。
       已删除。现在只有下面这条浮动按钮路径会生效 —— 它正是实际一直在跑的那条，
       也是 paste / share / preview / login 四页看到浮动开关的原因。 */

    if (document.body && document.body.dataset.disableThemeToggle === "true") {
      return;
    }

    var floatingBtn = createToggleButton("theme-floating-toggle");
    document.body.appendChild(floatingBtn);
    bindToggle(floatingBtn);
  }

  function initDom() {
    var toggles = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < toggles.length; i++) {
      bindToggle(toggles[i]);
    }
    ensureAutoToggle();
    updateAllToggles(getCurrentTheme());
  }

  var ThemeManager = {
    getTheme: getCurrentTheme,
    setTheme: function (theme) {
      return applyTheme(theme, { persist: true, broadcast: true });
    },
    toggleTheme: function () {
      var next = getCurrentTheme() === "dark" ? "light" : "dark";
      return applyTheme(next, { persist: true, broadcast: true });
    },
  };

  window.ThemeManager = ThemeManager;

  // Always default to light if user has no saved preference.
  applyTheme(getStoredTheme(), { persist: false, broadcast: false });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initDom, { once: true });
  } else {
    initDom();
  }

  window.addEventListener("storage", function (event) {
    if (event.key !== STORAGE_KEY) return;
    applyTheme(getStoredTheme(), { persist: false, broadcast: false });
  });
})();
