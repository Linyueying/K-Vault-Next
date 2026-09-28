/**
 * K-Vault-Next · 宣传页交互 (landing.js)
 * ---------------------------------------------------------------------------
 * 纯原生、无构建、无依赖。共享能力（复制、toast、滚动揭示、glassfx 启动）一律
 * 复用 app-core.js 的 window.KVault，本文件只写「这一页特有的编排」：
 *
 *   1. 顶栏：滚动凝胶囊、进度条、移动端抽屉、当前小节高亮
 *   2. 首屏：逐字入场拆字、终端打字机、3D 倾斜、磁吸按钮、光标聚光
 *   3. 内容：数字滚动、条形图/路由图进入视口后点亮
 *   4. 演示台：模糊 / 饱和度 / 不透明度实时调参、折射增强、背景动画开关
 *   5. API 标签页、FAQ 手风琴、复制按钮与轻提示
 *
 * 约定：
 *   · 所有效果都是**增强**：任一块失败都不影响页面可读可点（逐块 try/catch）；
 *   · prefers-reduced-motion 命中时不做位移/打字/倾斜，直接落到终态。
 */
(function () {
  "use strict";

  var KV = window.KVault || {};
  var root = document.documentElement;
  var reduceMotion = false;
  try {
    reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) { /* noop */ }
  var canHover = true;
  try {
    canHover = !window.matchMedia || window.matchMedia("(hover: hover)").matches;
  } catch (e) { /* noop */ }

  function $(sel, scope) { return (scope || document).querySelector(sel); }
  function $$(sel, scope) { return [].slice.call((scope || document).querySelectorAll(sel)); }
  function on(el, type, fn, opts) { if (el) el.addEventListener(type, fn, opts || false); }
  function safe(fn) { return function () { try { return fn.apply(this, arguments); } catch (e) { /* noop */ } }; }
  function raf(fn) {
    var queued = false;
    return function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () { queued = false; fn(); });
    };
  }

  /* ======================================================================
     1. 轻提示：复用设计系统的 .toast 观感，元素级动画放在 landing.css
     ====================================================================== */
  var toastBox = $("#lpToasts");
  function toast(text, kind) {
    if (!toastBox) return;
    var el = document.createElement("div");
    el.className = "lp-toast" + (kind ? " lp-toast--" + kind : "");
    el.innerHTML = '<i class="fas ' + (kind === "ok" ? "fa-circle-check" : "fa-circle-info") + '"></i>';
    el.appendChild(document.createTextNode(text));
    toastBox.appendChild(el);
    window.setTimeout(function () {
      el.classList.add("is-out");
      window.setTimeout(function () { el.remove(); }, 320);
    }, 2200);
  }

  /* ======================================================================
     2. 顶栏 / 进度 / 回到顶部 / 小节高亮
     ====================================================================== */
  function initChrome() {
    var nav = $("#lpNav");
    var bar = $("#lpProgress");
    var toTop = $("#lpTop");
    var links = $$(".lp-nav__links a");
    var sections = links
      .map(function (a) {
        var id = (a.getAttribute("href") || "").replace("#", "");
        return id ? document.getElementById(id) : null;
      })
      .filter(Boolean);

    var update = raf(function () {
      var y = window.pageYOffset || root.scrollTop || 0;
      var h = Math.max(1, (document.documentElement.scrollHeight || 1) - window.innerHeight);
      if (bar) bar.style.width = Math.min(100, (y / h) * 100).toFixed(2) + "%";
      if (nav) nav.classList.toggle("is-stuck", y > 12);
      if (toTop) toTop.classList.toggle("is-on", y > 640);
    });
    on(window, "scroll", update, { passive: true });
    on(window, "resize", update, { passive: true });
    update();

    on(toTop, "click", function () {
      window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
    });

    /* 移动端抽屉 */
    var burger = $("#lpBurger");
    on(burger, "click", function () {
      var open = nav.classList.toggle("is-open");
      burger.setAttribute("aria-expanded", open ? "true" : "false");
    });
    links.forEach(function (a) {
      on(a, "click", function () {
        if (nav) nav.classList.remove("is-open");
        if (burger) burger.setAttribute("aria-expanded", "false");
      });
    });

    /* 当前小节高亮（不影响可读性，失败也无妨） */
    if (!("IntersectionObserver" in window) || !sections.length) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        links.forEach(function (a) {
          var hit = a.getAttribute("href") === "#" + entry.target.id;
          a.classList.toggle("is-current", hit);
          if (hit) { a.setAttribute("aria-current", "true"); } else { a.removeAttribute("aria-current"); }
        });
      });
    }, { rootMargin: "-45% 0px -50% 0px", threshold: 0 });
    sections.forEach(function (s) { io.observe(s); });
  }

  /* ======================================================================
     3. 首屏逐字入场：把每个字包进 .lp-ch，按序配 --cd 延迟
        —— 位移 + 模糊 → 清晰，, 这一层完全靠 CSS 关键帧，JS 只负责拆字
     ====================================================================== */
  function initSplitText() {
    $$("[data-split]").forEach(function (line) {
      if (line.dataset.splitDone === "1") return;
      var base = parseFloat(line.dataset.delay || 0) / 1000;
      var step = 0.045;
      var walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT, null);
      var textNodes = [];
      while (walker.nextNode()) textNodes.push(walker.currentNode);

      var index = 0;
      textNodes.forEach(function (node) {
        /* 源码里的换行与缩进是排版用的，必须折叠成单个空格并去掉首尾 ——
           否则每个缩进空格都会生成一个占位 span，把标题顶出容器、被迫折行。 */
        var text = node.nodeValue.replace(/\s+/g, " ").trim();
        if (!text) return;
        var parent = node.parentNode;
        if (!parent) return;

        /* 渐变字（--grad）：它靠自己的 background-clip 上色，一旦把字包进子
           span，父级背景就裁不到子元素了（实测字会整块消失）。所以这一个词
           不拆字，整体作为一个单元入场。 */
        if (parent.classList && parent.classList.contains("lp-title__grad")) {
          parent.classList.add("lp-ch", "lp-ch--atomic");
          parent.style.setProperty("--cd", (base + index * step).toFixed(3) + "s");
          index += text.length;
          return;
        }

        var piece = document.createDocumentFragment();
        Array.prototype.slice.call(text).forEach(function (ch) {
          var span = document.createElement("span");
          span.className = ch === " " ? "lp-ch lp-ch--space" : "lp-ch";
          span.style.setProperty("--cd", (base + index * step).toFixed(3) + "s");
          span.textContent = ch === " " ? "\u00a0" : ch;
          piece.appendChild(span);
          index += 1;
        });
        parent.replaceChild(piece, node);
      });
      line.dataset.splitDone = "1";
    });
  }

  /* ======================================================================
     4. 终端打字机
     ====================================================================== */
  function initTyping() {
    var el = $("#lpTyping");
    if (!el) return;
    var lines = [
      "$ npx wrangler pages deploy .",
      "✔ 上传完成 · 12 个文件 · 0 构建步骤",
      "",
      '$ curl -X POST .../api/v1/upload \\',
      '    -H "Authorization: Bearer kvault_…" \\',
      "    -F file=@cover.png -F storage=r2",
      "",
      "→ 直链 /file/blog/cover.png",
      "→ 分享 /s/ocean （有效期 7 天 · 密码可选）"
    ];
    var full = lines.join("\n");

    if (reduceMotion) { el.textContent = full; return; }

    var li = 0;
    var ci = 0;
    var out = "";
    function tick() {
      if (li >= lines.length) {
        window.setTimeout(function () { li = 0; ci = 0; out = ""; tick(); }, 5200);
        return;
      }
      var line = lines[li];
      if (ci < line.length) {
        ci += 1;
        el.textContent = out + line.slice(0, ci);
        window.setTimeout(tick, 16 + Math.random() * 34);
        return;
      }
      out += line + "\n";
      li += 1;
      ci = 0;
      el.textContent = out;
      window.setTimeout(tick, line === "" ? 90 : 460);
    }
    window.setTimeout(tick, 900);
  }

  /* ======================================================================
     5. 光标聚光 + 卡片内侧辉光
     ====================================================================== */
  function initPointerGlow() {
    if (!canHover) return;

    /* 背景聚光：全局 rAF 节流，只写两个自定义属性 */
    var pending = null;
    var queued = false;
    on(document, "pointermove", function (e) {
      pending = e;
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () {
        queued = false;
        if (!pending) return;
        root.style.setProperty("--lp-mx", ((pending.clientX / window.innerWidth) * 100).toFixed(2) + "%");
        root.style.setProperty("--lp-my", ((pending.clientY / window.innerHeight) * 100).toFixed(2) + "%");
      });
    }, { passive: true });

    /* 卡片 / 页面卡：内侧辉光跟随光标（每张卡各自节流） */
    $$(".lp-glowcard").forEach(function (card) {
      var point = null;
      var busy = false;
      on(card, "pointermove", function (e) {
        point = e;
        if (busy) return;
        busy = true;
        requestAnimationFrame(function () {
          busy = false;
          if (!point) return;
          var r = card.getBoundingClientRect();
          card.style.setProperty("--gx", (((point.clientX - r.left) / r.width) * 100).toFixed(2) + "%");
          card.style.setProperty("--gy", (((point.clientY - r.top) / r.height) * 100).toFixed(2) + "%");
        });
      }, { passive: true });
    });
  }

  /* ======================================================================
     6. 3D 倾斜（Hero 舞台）+ 磁吸按钮
     ====================================================================== */
  function initTilt() {
    if (reduceMotion || !canHover) return;
    $$("[data-tilt]").forEach(function (stage) {
      var max = parseFloat(stage.dataset.tiltMax || "6");
      var layers = $$(".lp-tilt__layer", stage);
      var set = function (rx, ry) {
        layers.forEach(function (layer) {
          var depth = parseFloat(layer.dataset.depth || "10") / 10;
          layer.style.setProperty("--rx", (rx * depth).toFixed(3) + "deg");
          layer.style.setProperty("--ry", (ry * depth).toFixed(3) + "deg");
          layer.style.setProperty("--tz", (depth * 5).toFixed(1) + "px");
        });
      };
      on(stage, "pointermove", function (e) {
        var r = stage.getBoundingClientRect();
        var px = (e.clientX - r.left) / r.width - 0.5;
        var py = (e.clientY - r.top) / r.height - 0.5;
        set(-py * max, px * max * 1.15);
      });
      on(stage, "pointerleave", function () { set(0, 0); });
    });

    $$(".lp-magnet").forEach(function (btn) {
      on(btn, "pointermove", function (e) {
        var r = btn.getBoundingClientRect();
        var dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
        var dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
        btn.style.transform = "translate3d(" + (dx * 5).toFixed(2) + "px," + (dy * 4).toFixed(2) + "px,0)";
      });
      on(btn, "pointerleave", function () { btn.style.transform = ""; });
    });
  }

  /* ======================================================================
     6.5 揭示兜底（safety net）
        共享层用 IntersectionObserver 接管 [data-reveal]；但观察器的回调按帧
        投递，**快速甩动 / 拖动滚动条 / 程序化跳转**时元素可能整帧掠过视口而
        从不被判定为相交 —— 结果是它永远停在 opacity:0，内容凭空消失。
        这里补一遍几何兜底：凡是已经落在视口内的元素直接补上 is-revealed。
        与共享层写的是同一个类，重复执行无副作用；元素一旦揭示即出队，
        常驻成本基本为零。
     ====================================================================== */
  function initRevealFallback() {
    var pending = $$("[data-reveal]");
    if (!pending.length) return;

    function sweep() {
      if (!pending.length) return;
      var vh = window.innerHeight || 0;
      var rest = [];
      for (var i = 0; i < pending.length; i += 1) {
        var el = pending[i];
        if (el.classList.contains("is-revealed")) continue;
        var r = el.getBoundingClientRect();
        /* 只判上边界：已经「滚过去」的元素同样直接揭示 —— 否则用户往回滚时
           会看到一段空白，而那段内容其实早该出现了。 */
        if (r.top < vh * 0.94) {
          el.classList.add("is-revealed");
        } else {
          rest.push(el);
        }
      }
      pending = rest;
    }

    var run = raf(sweep);
    on(window, "scroll", run, { passive: true });
    on(window, "resize", run, { passive: true });
    run();
    window.setTimeout(run, 420);
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(function () { run(); });
    }
  }

  /* ======================================================================
     7. 进入视口后的编排：数字滚动 / 条形图 / 路由图
     ====================================================================== */
  function whenVisible(el, fn, onceOnly) {
    if (!el) return;
    if (!("IntersectionObserver" in window)) { fn(); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        fn();
        if (onceOnly !== false) io.unobserve(entry.target);
      });
    }, { rootMargin: "0px 0px -12% 0px", threshold: 0.2 });
    io.observe(el);
  }

  function initCounters() {
    $$("[data-count]").forEach(function (el) {
      var target = parseFloat(el.dataset.count || "0");
      whenVisible(el.parentNode || el, function () {
        if (reduceMotion || !target) { el.textContent = String(target); return; }
        var start = performance.now();
        var dur = 1300;
        (function step(now) {
          var p = Math.min(1, (now - start) / dur);
          var eased = 1 - Math.pow(1 - p, 3);
          el.textContent = String(Math.round(target * eased));
          if (p < 1) requestAnimationFrame(step);
          else el.textContent = String(target);
        })(start);
      });
    });
  }

  function initBarsAndRoute() {
    var bars = $(".lp-bars[data-live]");
    if (bars) {
      $$(".lp-bar", bars).forEach(function (bar, i) {
        var track = $(".lp-bar__track i", bar);
        if (track) track.style.setProperty("--bd", (0.12 * i).toFixed(2) + "s");
      });
      whenVisible(bars, function () { bars.classList.add("is-live"); });
    }
    var route = $(".lp-route");
    whenVisible(route, function () { if (route) route.classList.add("is-live"); });
  }

  /* ======================================================================
     8. 玻璃 / 模糊演示台
     ====================================================================== */
  function initGlassLab() {
    var stage = $("#lpLabStage");
    if (!stage) return;
    var blur = $("#lpBlur");
    var sat = $("#lpSat");
    var alpha = $("#lpAlpha");
    var blurOut = $("#lpBlurOut");
    var satOut = $("#lpSatOut");
    var alphaOut = $("#lpAlphaOut");
    var caption = $("#lpLabCaption");
    var code = $("#lpLabCode");

    function apply() {
      var b = blur ? blur.value : "20";
      var s = sat ? sat.value : "180";
      var a = alpha ? alpha.value : "62";
      stage.style.setProperty("--lab-blur", b + "px");
      stage.style.setProperty("--lab-sat", s + "%");
      stage.style.setProperty("--lab-alpha", (parseFloat(a) / 100).toFixed(2));
      if (blurOut) blurOut.textContent = b;
      if (satOut) satOut.textContent = s;
      if (alphaOut) alphaOut.textContent = a;
      if (caption) caption.textContent = "blur(" + b + "px) saturate(" + s + "%)";
      if (code) {
        code.textContent =
          "backdrop-filter: blur(" + b + "px) saturate(" + s + "%);\n" +
          "background: rgba(255, 255, 255, " + (parseFloat(a) / 100).toFixed(2) + ");";
      }
    }
    [blur, sat, alpha].forEach(function (input) { on(input, "input", apply); });
    apply();

    /* 背景动画开关 */
    var liveBtn = $('[data-lab-toggle="live"]');
    on(liveBtn, "click", function () {
      var paused = stage.classList.toggle("is-paused");
      liveBtn.setAttribute("aria-pressed", paused ? "false" : "true");
    });

    /* 折射增强：真身在 vendored glassfx，这里只加/去 .glass-refract */
    var refractBtn = $('[data-lab-toggle="refract"]');
    on(refractBtn, "click", function () {
      var layer = $("#lpLabFront") || $("#lpLabRefract");
      if (!layer) return;
      var on_ = !layer.classList.contains("glass-refract");
      var commit = function () {
        layer.classList.toggle("glass-refract", on_);
        refractBtn.setAttribute("aria-pressed", on_ ? "true" : "false");
      };
      if (on_ && KV.glassInit) {
        /* 滤镜由 glassfx 运行时注入，先确保它加载完成再加类 */
        Promise.resolve(KV.glassInit()).then(commit).catch(commit);
        toast("折射依赖 Chromium 的 backdrop-filter: url()");
      } else {
        commit();
      }
    });

    /* 演示台内的光标柔光 */
    if (canHover && !reduceMotion) {
      var cursor = $(".lp-lab__cursor");
      on(stage, "pointermove", function (e) {
        if (!cursor) return;
        var r = stage.getBoundingClientRect();
        cursor.style.transform = "translate3d(" +
          (e.clientX - r.left - r.width / 2).toFixed(1) + "px," +
          (e.clientY - r.top - r.height / 2).toFixed(1) + "px,0)";
      });
    }
  }

  /* ======================================================================
     9. API 标签页
     ====================================================================== */
  function initTabs() {
    var tabs = $$("#lpApiTabs .lp-tab");
    if (!tabs.length) return;
    var indicator = $(".lp-api__indicator");
    var panes = $$(".lp-pane");

    function moveIndicator(tab) {
      if (!indicator || !tab) return;
      indicator.style.left = tab.offsetLeft + "px";
      indicator.style.width = tab.offsetWidth + "px";
    }

    function select(tab, focus) {
      tabs.forEach(function (t) {
        var hit = t === tab;
        t.classList.toggle("is-active", hit);
        t.setAttribute("aria-selected", hit ? "true" : "false");
        if (hit && focus) t.focus();
      });
      panes.forEach(function (p) {
        p.classList.toggle("is-active", p.dataset.pane === tab.dataset.pane);
      });
      moveIndicator(tab);
    }

    tabs.forEach(function (tab, i) {
      on(tab, "click", function () { select(tab); });
      on(tab, "keydown", function (e) {
        var next = null;
        if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
        if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
        if (next) { e.preventDefault(); select(next, true); }
      });
    });

    select(tabs[0]);
    var remeasure = raf(function () {
      var active = tabs.filter(function (t) { return t.classList.contains("is-active"); })[0];
      moveIndicator(active);
    });
    on(window, "resize", remeasure, { passive: true });
    /* 字体加载完成后宽度会变，再量一次 */
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(remeasure);
    }
    window.setTimeout(remeasure, 600);
  }

  /* ======================================================================
     10. FAQ 手风琴
        —— details 默认带 open（无 JS 时内容可读），JS 接管后用
           grid-template-rows 做真正的高度插值
     ====================================================================== */
  function initFaq() {
    var items = $$("#lpFaq .lp-faq__item");
    if (!items.length) return;
    items.forEach(function (item, i) {
      item.open = true; /* 交给我们控制开合，避免原生瞬时折叠 */
      item.classList.toggle("is-open", i === 0);
      var summary = $("summary", item);
      on(summary, "click", function (e) {
        e.preventDefault();
        var willOpen = !item.classList.contains("is-open");
        items.forEach(function (other) {
          other.classList.remove("is-open");
          other.open = true;
        });
        if (willOpen) item.classList.add("is-open");
      });
    });
  }

  /* ======================================================================
     11. 复制按钮
     ====================================================================== */
  function initCopy() {
    $$("[data-copy]").forEach(function (btn) {
      on(btn, "click", function () {
        var sel = btn.dataset.copy;
        var text = "";
        if (sel === "self") {
          var code = $("code", btn.parentNode);
          text = code ? code.textContent : "";
        } else if (sel) {
          var node = $(sel);
          text = node ? node.textContent : "";
        }
        if (!text) return;
        var done = function (ok) {
          toast(ok ? "已复制到剪贴板" : "复制失败，请手动选择", ok ? "ok" : "info");
        };
        if (KV.copy) {
          KV.copy(text).then(done, function () { done(false); });
          return;
        }
        try {
          navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
        } catch (e) { done(false); }
      });
    });
  }

  /* ======================================================================
     启动
     ====================================================================== */
  function boot() {
    [initChrome, initSplitText, initTyping, initPointerGlow, initTilt,
     initRevealFallback, initCounters, initBarsAndRoute, initGlassLab,
     initTabs, initFaq, initCopy]
      .forEach(function (fn) { safe(fn)(); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
