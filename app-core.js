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
   * 同步状态追踪器（sync tracker）
   *   全站「数据同步状态」的唯一实现：黄=同步中 / 绿=已同步 / 红=失败。
   *   在 admin.html 与 index.html 共用；两页只负责把网络动作包进 track()，
   *   状态机、重试、去抖、原因文案都在这里，避免各写一份后互相漂移。
   *
   *   设计要点
   *     1. 引用计数：并发多个同步动作时，只有全部结束才算「已同步」，
   *        否则先完成的一个会把还在跑的另一个错误地标绿。
   *     2. 短暂延迟后自动重试 2 次（共最多 3 次尝试），退避为 600ms / 1500ms。
   *        重试期间保持「同步中」，不闪红 —— 用户只该看到真正的最终结果。
   *     3. 终态：成功 -> synced（短暂高亮后回 idle）；三次都失败 -> failed（常驻）。
   *     4. 订阅式：onChange(state) 回调，页面把 state 绑到 .sync-dot 的 class 上。
   * ------------------------------------------------------------------ */

  // 重试退避（毫秒）。第 N 次失败后等待 RETRY_BACKOFF[N-1] 再试下一次。
  var SYNC_RETRY_BACKOFF = [600, 1500];
  // 成功后绿点停留时长：够看清「刚刚同步成功」，又不会一直亮着干扰。
  var SYNC_SETTLED_HOLD = 2200;

  /**
   * 创建一个同步状态追踪器。
   *
   * @param {Object} opts
   *   - maxRetries {number}   失败后的额外重试次数，默认 2（即最多尝试 3 次）
   *   - backoff    {number[]} 每次重试前的等待毫秒数，默认 [600, 1500]
   *   - holdMs     {number}   成功后绿点停留时长，默认 2200
   *   - onChange   {Function} (state, detail) => void，状态变化时回调
   * @returns {Object} tracker
   *   - track(fn, meta)  {Function} 包住一个异步动作，返回其 Promise
   *   - state            {string} 当前态：idle | syncing | synced | failed
   *   - detail           {Object} 最近一次的结果细节（含 attempts / lastError）
   *   - subscribe(fn)    {Function} 注册回调，返回取消函数
   *   - reset()          {Function} 手动回到 idle（清掉红点）
   */
  function createSyncTracker(opts) {
    var o = opts || {};
    var maxRetries = o.maxRetries == null ? 2 : o.maxRetries;
    var backoff = o.backoff || SYNC_RETRY_BACKOFF;
    var holdMs = o.holdMs == null ? SYNC_SETTLED_HOLD : o.holdMs;

    var listeners = [];
    // 并发计数：>0 视为「同步中」。用计数而非布尔，避免并发互相覆盖。
    var pending = 0;
    var state = "idle";
    var detail = { attempts: 0, lastError: null, at: 0 };
    var holdTimer = null;

    function emit() {
      var snapshot = state;
      var info = detail;
      listeners.forEach(function (fn) {
        try { fn(snapshot, info); } catch (e) { /* 订阅者出错不影响状态机 */ }
      });
    }

    function set(newState, extra) {
      if (extra) detail = Object.assign({}, detail, extra);
      if (state === newState) { emit(); return; }
      state = newState;
      emit();
    }

    function clearHold() {
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    }

    function sleep(ms) {
      return new Promise(function (r) { setTimeout(r, ms); });
    }

    /**
     * 包住一个异步动作，自动处理「同步中 -> 已同步 / 失败 + 重试」。
     *
     * @param {Function} fn    () => Promise，真正的网络动作
     * @param {Object}   meta  可选，{ label: '目录列表', settle: 'evidence' }
     *   - settle:'evidence'：请求成功只代表「云端已接受」，绿点改由验证管理器
     *     在拿到确切 KV 同步证据后点亮（confirmSynced）。KV 最终一致窗口内
     *     黄点会一直亮着 —— 刻意语义：绿点 = 亲眼确认到变更，不是 = 请求成功。
     * @returns {Promise}      与 fn 同解；失败时抛出最后一次的错误
     */
    function track(fn, meta) {
      var m = meta || {};
      var settleEvidence = m.settle === "evidence";
      clearHold();
      pending += 1;
      set("syncing", {
        label: m.label || "",
        attempts: 0,
        lastError: null,
      });

      var attempts = 0;
      // 递归重试：attempts 记的是「已经尝试过的次数」
      function attempt() {
        attempts += 1;
        return Promise.resolve()
          .then(fn)
          .then(function (res) {
            detail = Object.assign({}, detail, { attempts: attempts, lastError: null, at: Date.now() });
            pending -= 1;
            if (pending <= 0) {
              pending = 0;
              if (settleEvidence) {
                /* 云端已接受请求，但 KV 传播需要时间：保持黄点，
                   由验证管理器读到「确切同步证据」后再点亮绿点 */
                set("syncing", {
                  label: m.label || "",
                  attempts: attempts,
                  lastError: null,
                  verifying: true,
                  timedOut: false,
                  at: Date.now(),
                });
              } else {
                set("synced");
                // 绿点只作短暂确认，随后自然回到 idle（灰）
                holdTimer = setTimeout(function () {
                  if (state === "synced" && pending === 0) set("idle");
                }, holdMs);
              }
            }
            return res;
          })
          .catch(function (err) {
            if (attempts <= maxRetries) {
              var wait = backoff[Math.min(attempts - 1, backoff.length - 1)] || 600;
              detail = Object.assign({}, detail, { attempts: attempts, lastError: err, at: Date.now() });
              return sleep(wait).then(attempt);
            }
            // 重试耗尽：真正的失败
            detail = Object.assign({}, detail, { attempts: attempts, lastError: err, at: Date.now() });
            pending -= 1;
            if (pending <= 0) pending = 0;
            set("failed");
            throw err;
          });
      }

      return attempt();
    }

    /* 验证管理器专用：保持/回到黄点并更新说明字段。
       每次传入固定字段集合整体覆盖，避免残留上一轮的 timedOut 等标记。 */
    function holdPending(extra) {
      clearHold();
      set("syncing", Object.assign({
        label: "", attempts: 0, lastError: null,
        verifying: true, timedOut: false, at: Date.now(),
      }, extra || {}));
    }

    /* 验证管理器专用：拿到确切证据后点亮绿点（短暂停留后回 idle）。
       仍有 track 在跑（pending > 0）时不点亮，返回 false 供调用方稍后重试。 */
    function confirmSynced() {
      clearHold();
      if (pending > 0) return false;
      set("synced");
      holdTimer = setTimeout(function () {
        if (state === "synced" && pending === 0) set("idle");
      }, holdMs);
      return true;
    }

    function subscribe(fn) {
      if (typeof fn !== "function") return function () {};
      listeners.push(fn);
      // 立即回放当前状态，订阅方无需先判断初始值
      try { fn(state, detail); } catch (e) { /* noop */ }
      return function () {
        var i = listeners.indexOf(fn);
        if (i > -1) listeners.splice(i, 1);
      };
    }

    function reset() {
      clearHold();
      if (pending === 0) set("idle", { attempts: 0, lastError: null });
    }

    /* 供页面渲染「为什么会有延迟」的说明文案。
       内容是产品层面的解释（同步为什么要走后端、延迟为何不可避免），
       不是错误堆栈 —— 所以放在共享层，保证两页口径一致。 */
    function explain() {
      return [
        "同步需要把改动写到云端存储，这一趟往返是躲不掉的：",
        "",
        "1. 网络往返 —— 你的操作要先送到 Cloudflare 边缘节点，再由它写进存储。物理距离决定了最低延迟，无法在前端消除。",
        "2. 云端写入 —— 目录的增删改会逐个改写其中文件的元数据；文件越多，这一步越久。",
        "3. KV 最终一致 —— Cloudflare KV 的写入是全球最终一致的：请求成功后，新状态传播到读取端还需要一点时间（通常几秒，最长约 60 秒），这段时间里读到的仍可能是旧数据。",
        "4. 同步确认 —— 所以绿点必须等确凿证据：我们会回到云端 KV 重新读取，亲眼确认你的变更已经生效，才把黄点变绿。确认之前黄点一直亮着，绝不提前「报喜」。",
        "",
        "界面会先把改动立刻显示出来（乐观更新），同时后台静默完成真正的写入与验证。",
        "圆点就是这条后台链路的进度：黄=已提交/确认中，绿=已在云端 KV 确认，红=失败（已自动重试 2 次）。",
      ].join("\n");
    }

    return {
      track: track,
      subscribe: subscribe,
      reset: reset,
      explain: explain,
      holdPending: holdPending,
      confirmSynced: confirmSynced,
      get state() { return state; },
      get detail() { return detail; },
      get pending() { return pending; },
      STATE_IDLE: "idle",
      STATE_SYNCING: "syncing",
      STATE_SYNCED: "synced",
      STATE_FAILED: "failed",
    };
  }

  /* ------------------------------------------------------------------ *
   * 同步验证管理器（sync verifier）
   *   「确切 KV 同步证据」的唯一判定实现：写请求成功（黄点保持）后，
   *   周期性用 fresh 读回到云端 KV，直到亲眼看到本次变更已生效才点亮绿点。
   *   admin.html 与 index.html 共用这一份，避免两页判定口径漂移。
   *
   *   语义（与用户需求逐字对齐）：
   *     - 没有收到确切的 KV 目录同步证据 -> 黄点一直亮，绝不变绿；
   *     - 验证读失败（网络抖动等）不算写失败：不转红，静默继续验证；
   *     - 长时间未确认（超过 VERIFY_TIMEOUT，覆盖 KV 最长约 60s 的传播窗口）
   *       转入低频轮询继续等，黄点仍常亮；一旦证据到手立即变绿。
   *     - 全部证据到手的那一轮读回数据就是云端真实状态，直接应用到界面
   *       （所见即 KV 所存），并点亮绿点。
   * ------------------------------------------------------------------ */

  // 写成功后到首次验证读的等待：同边缘节点的写后读通常立即可见，稍等即可
  var SYNC_VERIFY_FIRST_DELAY = 600;
  // 验证轮询间隔
  var SYNC_VERIFY_INTERVAL = 2000;
  // 高频验证的最长持续时间（覆盖 KV 最长约 60s 的最终一致窗口 + 余量）
  var SYNC_VERIFY_TIMEOUT = 90000;
  // 超时后的低频轮询间隔（黄点保持，不放弃）
  var SYNC_VERIFY_SLOW_INTERVAL = 12000;

  /**
   * 创建验证管理器。
   *
   * @param {Object} opts
   *   - tracker   {Object}  createSyncTracker() 实例（状态点状态机）
   *   - fetcher   {Function} () => Promise<{ folders: [...] }>，fresh 读回云端目录
   *   - onApply   {Function} (folders) => void，证据数据应用到界面（可选）
   *   - firstDelay/interval/timeout/slowInterval {number} 时序参数（默认见上方常量）
   * @returns {Object}
   *   - queueVerify(expected, label)  登记一组待验证的预期变更并启动验证
   *       expected: [{ type:'create', path } | { type:'delete', path }
   *                  | { type:'rename', path:旧, to:新 }]
   */
  function createSyncVerifier(opts) {
    var o = opts || {};
    var tracker = o.tracker;
    var fetcher = o.fetcher;
    var onApply = typeof o.onApply === "function" ? o.onApply : null;
    var firstDelay = o.firstDelay == null ? SYNC_VERIFY_FIRST_DELAY : o.firstDelay;
    var interval = o.interval == null ? SYNC_VERIFY_INTERVAL : o.interval;
    var timeout = o.timeout == null ? SYNC_VERIFY_TIMEOUT : o.timeout;
    var slowInterval = o.slowInterval == null ? SYNC_VERIFY_SLOW_INTERVAL : o.slowInterval;

    // 待验证队列：[{ expected, label, startedAt, tries }]
    var queue = [];
    var timer = null;
    var pollSeq = 0; // 世代号：新登记会重启轮询，旧轮询的迟到回调按号作废

    function clearTimer() {
      if (timer) { clearTimeout(timer); timer = null; }
    }

    function expectedMet(expected, pathSet) {
      for (var i = 0; i < expected.length; i += 1) {
        var e = expected[i];
        if (!e) return false;
        if (e.type === "create") { if (!pathSet.has(e.path)) return false; }
        else if (e.type === "delete") { if (pathSet.has(e.path)) return false; }
        else if (e.type === "rename") {
          if (!pathSet.has(e.to) || pathSet.has(e.path)) return false;
        } else { return false; } // 未知类型保守视为未满足：保持黄点
      }
      return true;
    }

    function confirmWithRetry(left) {
      if (tracker.confirmSynced()) return;
      if (left <= 0) return; // 极端情况：放弃点绿，保持黄点（比错误报喜安全）
      setTimeout(function () { confirmWithRetry(left - 1); }, 400);
    }

    function loop(seq) {
      if (seq !== pollSeq) return;
      if (!queue.length) return;

      Promise.resolve().then(fetcher).then(function (data) {
        if (seq !== pollSeq) return;
        var folders = (data && data.folders) || [];
        var pathSet = new Set();
        for (var i = 0; i < folders.length; i += 1) {
          var p = folders[i] && folders[i].path != null ? String(folders[i].path) : "";
          if (p) pathSet.add(p);
        }

        var remaining = [];
        var allTimedOut = true;
        for (var j = 0; j < queue.length; j += 1) {
          var item = queue[j];
          if (expectedMet(item.expected, pathSet)) continue; // 证据到手，移出队列
          item.tries += 1;
          if (Date.now() - item.startedAt < timeout) allTimedOut = false;
          remaining.push(item);
        }

        if (!remaining.length) {
          /* 全部证据到手：这一轮读回的数据就是云端 KV 的真实状态，
             应用到界面（所见即所存），再点亮绿点 */
          queue = [];
          if (onApply) { try { onApply(folders); } catch (e) { /* 应用失败不影响状态点 */ } }
          confirmWithRetry(10);
          return;
        }

        queue = remaining;
        var head = queue[0];
        tracker.holdPending({
          label: head.label || "",
          attempts: head.tries,
          lastError: null,
          verifying: true,
          timedOut: allTimedOut,
          at: Date.now(),
        });
        /* 超时后转低频轮询继续等（黄点常亮，绝不放弃确认） */
        var wait = allTimedOut ? slowInterval : interval;
        timer = setTimeout(function () { loop(seq); }, wait);
      }).catch(function () {
        /* 验证读失败不是写失败：不转红，保持黄点静默重试 */
        if (seq !== pollSeq) return;
        var head = queue[0] || {};
        for (var k = 0; k < queue.length; k += 1) queue[k].tries += 1;
        tracker.holdPending({
          label: head.label || "",
          attempts: (queue[0] && queue[0].tries) || 0,
          lastError: null,
          verifying: true,
          timedOut: false,
          at: Date.now(),
        });
        timer = setTimeout(function () { loop(seq); }, interval);
      });
    }

    function queueVerify(expected, label) {
      if (!expected || !expected.length) return;
      queue.push({ expected: expected, label: label || "", startedAt: Date.now(), tries: 0 });
      /* 重启轮询世代：立即以新队列开始第一轮 fresh 验证 */
      pollSeq += 1;
      clearTimer();
      var seq = pollSeq;
      tracker.holdPending({
        label: label || "",
        attempts: 0,
        lastError: null,
        verifying: true,
        timedOut: false,
        at: Date.now(),
      });
      timer = setTimeout(function () { loop(seq); }, firstDelay);
    }

    return { queueVerify: queueVerify };
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

  /* ------------------------------------------------------------------ *
   * 液态玻璃增强层（glassfx）
   *   加载 vendored @ /vendor/glassfx/index.js —— 它挂一次共享 SVG 折射滤镜
   *   (#glassfx-refract)、并启动一个委托的指针监听，为每个 .glass 元素写入
   *   --glass-mx/--glass-my（光标跟随 bloom）。
   *   纯增强：加载失败 / 不支持时静默跳过，页面照旧（frosted 兜底）。
   *   CSS 已在 design-system.css 顶部 @import，无需此处再引。
   *   @returns {Promise<boolean>} 是否成功加载
   * ------------------------------------------------------------------ */
  function glassInit() {
    if (typeof document === "undefined") return Promise.resolve(false);
    if (glassInit._p) return glassInit._p; // 幂等：多页调用只加载一次

    glassInit._p = import("/vendor/glassfx/index.js")
      .then(function () { return true; })
      .catch(function () { return false; }); // 增强失败不影响主流程
    return glassInit._p;
  }

  /* ------------------------------------------------------------------ *
   * 滚动揭示（reveal on scroll）
   *   零依赖的 IntersectionObserver 微模块：给 [data-reveal] 元素在进入视口时
   *   加 .is-revealed，配合 CSS 只做 transform + opacity 过渡（Apple 风）。
   *   尊重 prefers-reduced-motion —— 命中时直接全量揭示，不做动画。
   *   @returns {() => void} 停止函数
   * ------------------------------------------------------------------ */
  function revealOnScroll(root) {
    var scope = root || document;
    var els = [].slice.call(scope.querySelectorAll("[data-reveal]"));
    if (!els.length) return function () {};

    var reduce = typeof window !== "undefined" && window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduce || !("IntersectionObserver" in window)) {
      els.forEach(function (el) { el.classList.add("is-revealed"); });
      return function () {};
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-revealed");
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });

    els.forEach(function (el) { io.observe(el); });
    return function () { io.disconnect(); };
  }

  window.KVault = {
    version: "1.3.0",
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
    glassInit: glassInit,
    revealOnScroll: revealOnScroll,
    createSyncTracker: createSyncTracker,
    createSyncVerifier: createSyncVerifier,
  };

  /* 自动初始化：纯增强、可失败。
     - glassfx：DOM 就绪后加载一次（注入折射滤镜 + 启动指针 bloom 追踪）
     - revealOnScroll：自动接管带 [data-reveal] 的元素
     任一步失败都静默跳过，不阻塞页面既有逻辑。 */
  if (typeof document !== "undefined") {
    var bootGlass = function () {
      try { glassInit(); } catch (e) { /* noop */ }
      try { revealOnScroll(document); } catch (e) { /* noop */ }
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", bootGlass, { once: true });
    } else {
      bootGlass();
    }
  }
})();
