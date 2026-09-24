/*!
 * app-core.js —— K-Vault-Next 跨页共享 JS 层
 *
 * 目的：把「8 个页面各写一份」的基础能力收敛到唯一实现。
 * 形态：IIFE + window.KVault，无模块系统、无构建步骤（守住项目「无构建」约束）。
 * 引入：<script src="/app-core.js"></script>，放在各页业务脚本之前。
 *
 * 设计约定
 *   - 所有方法的基准实现取自「功能最完整」的那个页面，不做最小公约数收敛。
 *   - 兼容期：toast 同时接受 message / text 字段；保留各页原有方法名可继续调用。
 *   - 任何一项都不改变现有页面的外观与行为，只把实现换成同一份。
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   * 文件大小格式化
   *   基准：admin.html 的 Intl 版本（带本地化千分位与小数分隔）
   *   opts.zero 用于保留 share.html 「0 时显示『未知大小』」的业务语义
   * ------------------------------------------------------------------ */
  var SIZE_FMT = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
  var SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];

  function formatBytes(bytes, opts) {
    var options = opts || {};
    var n = Number(bytes) || 0;
    if (n <= 0) return options.zero !== undefined ? options.zero : "0 B";
    var k = 1024;
    var i = Math.min(SIZE_UNITS.length - 1, Math.floor(Math.log(n) / Math.log(k)));
    return SIZE_FMT.format(n / Math.pow(k, i)) + " " + SIZE_UNITS[i];
  }

  /* ------------------------------------------------------------------ *
   * 提示消息（toast）
   *   基准：admin.html —— 时长随文本长度自适应（1400 + len*80，夹在 2600–6000ms）
   *   图标注解与各页保持一致
   * ------------------------------------------------------------------ */
  function toastIcon(type) {
    if (type === "error") return "fas fa-triangle-exclamation";
    if (type === "success") return "fas fa-circle-check";
    if (type === "undo") return "fas fa-arrow-rotate-left";
    return "fas fa-circle-info";
  }

  function toastDuration(message) {
    return Math.min(6000, Math.max(2600, 1400 + String(message).length * 80));
  }

  /**
   * 计算一条 toast 应该停留多久。
   * 页面可拿它替换自己写死的 setTimeout 时长，不改动自己的渲染逻辑。
   */
  function toastDelay(message) {
    return toastDuration(message);
  }

  /**
   * 往一个数组型 toasts 队列里推进一条记录，并自动安排移除。
   * 兼容期同时写入 message 与 text 两个字段，让各页模板（{{t.message}} 或 {{t.text}}）都能渲染。
   *
   * @param {Array}  list     页面的 toasts 数组（Vue reactive）
   * @param {Object} entry    调用方自定义字段，合并进记录
   * @param {Function} onRemove  到时回调，由页面执行 splice / filter
   * @param {Object} opts     { text, type, duration }
   * @returns {Object} 推入的记录
   */
  function pushToast(list, entry, onRemove, opts) {
    var options = opts || {};
    var text = options.text == null ? "" : String(options.text);
    var record = Object.assign(
      { id: Date.now() + Math.random(), text: text, message: text, type: options.type || "info" },
      entry || {}
    );
    if (Array.isArray(list)) list.push(record);
    var delay = options.duration || toastDuration(text);
    if (typeof onRemove === "function") {
      setTimeout(function () {
        onRemove(record);
      }, delay);
    }
    return record;
  }

  /* ------------------------------------------------------------------ *
   * 复制到剪贴板
   *   统一「能力检测 + Promise 拒绝兜底 + 老浏览器 execCommand 降级」三段式
   * ------------------------------------------------------------------ */
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (e) {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }

  /**
   * 复制文本，返回 Promise<boolean>。
   * 不用 reject —— 复制失败是常见情况，调用方通常只想 toast 一句。
   */
  function copy(text) {
    var value = text == null ? "" : String(text);
    if (!value) return Promise.resolve(false);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(value).then(
        function () {
          return true;
        },
        function () {
          return fallbackCopy(value);
        }
      );
    }
    return Promise.resolve(fallbackCopy(value));
  }

  /* ------------------------------------------------------------------ *
   * 带凭据的 JSON 请求
   *   统一 credentials:'include'、统一错误抛出、统一 401 语义
   * ------------------------------------------------------------------ */
  function fetchJSON(url, options) {
    var opts = options || {};
    var init = {
      method: opts.method || "GET",
      credentials: "include",
      headers: Object.assign({}, opts.headers || {}),
    };
    if (opts.body !== undefined) {
      if (typeof opts.body === "string" || opts.body instanceof FormData) {
        init.body = opts.body;
      } else {
        init.body = JSON.stringify(opts.body);
        init.headers["Content-Type"] = init.headers["Content-Type"] || "application/json";
      }
    }

    return fetch(url, init).then(function (res) {
      if (res.status === 401 && opts.onUnauthorized !== false) {
        // 未登录：交给调用方决定是否跳转（各页登录页路径不一致，默认不跳）
        var err401 = new Error("未登录或会话已过期");
        err401.status = 401;
        throw err401;
      }
      var ct = res.headers.get("content-type") || "";
      var parse = ct.indexOf("application/json") > -1 ? res.json() : res.text();
      return parse.then(function (data) {
        if (!res.ok) {
          var msg = data && data.error ? data.error : "请求失败（" + res.status + "）";
          var err = new Error(msg);
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * 时间格式化
   *   统一为「本地化的 YYYY-MM-DD HH:mm」，各页展示口径一致
   * ------------------------------------------------------------------ */
  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function formatTime(input, opts) {
    var options = opts || {};
    if (!input) return options.empty !== undefined ? options.empty : "—";
    var d = input instanceof Date ? input : new Date(input);
    if (isNaN(d.getTime())) return options.empty !== undefined ? options.empty : "—";
    var date = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
    if (options.dateOnly) return date;
    return date + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  /* ------------------------------------------------------------------ *
   * 其余小工具
   * ------------------------------------------------------------------ */
  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function debounce(fn, wait) {
    var timer = null;
    return function () {
      var ctx = this;
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () {
        fn.apply(ctx, args);
      }, wait || 200);
    };
  }

  window.KVault = {
    version: "1.0.0",
    formatBytes: formatBytes,
    formatSize: formatBytes, // 别名：多数页面用这个名字
    formatTime: formatTime,
    toastIcon: toastIcon,
    toastDuration: toastDuration,
    toastDelay: toastDelay,
    pushToast: pushToast,
    copy: copy,
    copyText: copy, // 别名
    fetchJSON: fetchJSON,
    escapeHtml: escapeHtml,
    debounce: debounce,
  };
})();
