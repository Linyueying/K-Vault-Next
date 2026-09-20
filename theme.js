(function () {
  "use strict";

  var STORAGE_KEY = "themeMode";
  var THEME_ATTR = "data-theme";
  var VALID = { light: true, dark: true };
  var root = document.documentElement;

  function normalizeTheme(theme) {
    return VALID[theme] ? theme : "light";
  }

  function getStoredTheme() {
    try {
      return normalizeTheme(localStorage.getItem(STORAGE_KEY));
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

  function ensureAutoToggle() {
    if (document.querySelector("[data-theme-toggle]")) return;

    var navLinks = document.querySelector(".header .nav-links");
    if (navLinks) {
      var inlineBtn = createToggleButton("theme-auto-inline-toggle");
      navLinks.insertBefore(inlineBtn, navLinks.firstChild);
      bindToggle(inlineBtn);
      return;
    }

    var adminActions = document.querySelector(".header-content .actions");
    if (adminActions) {
      var adminBtn = createToggleButton("theme-admin-toggle");
      adminActions.insertBefore(adminBtn, adminActions.firstChild);
      bindToggle(adminBtn);
      return;
    }

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
