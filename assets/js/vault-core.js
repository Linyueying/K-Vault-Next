/*!
 * vault-core.js —— 密码库（vault.html）的纯逻辑层
 *
 * 定位：与 app-core.js 同构的 IIFE，挂到 window.VaultCore，**不触碰 DOM / Vue**。
 * 只放可独立测试的算法：加解密、TOTP、密码生成、安全检查、导入导出。
 *
 * 为什么单独一份而不是塞进页面
 *   - 项目「无构建」约束下，页面里只该有 UI 逻辑；密码学/生成器/编解码是纯函数，
 *     抽出来既能被 vault.html 复用，也能被 node 直接 require 做单元验证。
 *   - 与 app-core.js（window.KVault）保持同一种形态：经典 <script> IIFE，无模块系统。
 *
 * 环境要求
 *   - 依赖 Web Crypto（crypto.subtle）。它只在安全上下文（HTTPS / localhost）可用，
 *     调用方应先 isWebCryptoAvailable() 判断，不可用时给出阻断提示。
 *   - 不使用任何外部依赖（CSP 只允许 'self'，且项目坚持零运行时依赖）。
 */
(function (global) {
  "use strict";

  /* ================================================================== *
   * 基础工具：字节 / base64 / 随机数 / uuid
   * ================================================================== */

  var KDF_ITERATIONS = 600000;   // PBKDF2-SHA256 迭代（Bitwarden 现行默认）
  var SALT_BYTES = 16;
  var IV_BYTES = 12;

  function isWebCryptoAvailable() {
    return !!(global.crypto && global.crypto.subtle && typeof global.crypto.subtle.importKey === "function");
  }

  /** 加密安全随机字节 */
  function randomBytes(length) {
    var n = Math.max(0, Number(length) || 0);
    var bytes = new Uint8Array(n);
    global.crypto.getRandomValues(bytes);
    return bytes;
  }

  /** [0, max) 上的均匀随机整数（拒绝采样，避免取模偏置） */
  function randomInt(max) {
    var m = Math.floor(Number(max) || 0);
    if (m <= 1) return 0;
    var limit = Math.floor(0x100000000 / m) * m;
    var buf = new Uint32Array(1);
    var x;
    do {
      global.crypto.getRandomValues(buf);
      x = buf[0];
    } while (x >= limit);
    return x % m;
  }

  /** RFC4122 v4 uuid（优先用原生 randomUUID） */
  function uuid() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return global.crypto.randomUUID();
    }
    var b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var hex = [];
    for (var i = 0; i < 16; i += 1) hex.push(b[i].toString(16).padStart(2, "0"));
    return hex.slice(0, 4).join("") + "-" + hex.slice(4, 6).join("") + "-" +
      hex.slice(6, 8).join("") + "-" + hex.slice(8, 10).join("") + "-" + hex.slice(10).join("");
  }

  /**
   * 字节 -> base64。
   * **必须分块**：String.fromCharCode.apply 一次传超大数组会超出调用栈上限
   * （密码库整库序列化后可能上百 KB），因此按 32KB 切片喂入。
   */
  function b64encode(bytes) {
    var arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var chunk = 0x8000;
    var parts = "";
    for (var i = 0; i < arr.length; i += chunk) {
      parts += String.fromCharCode.apply(null, arr.subarray(i, i + chunk));
    }
    return global.btoa(parts);
  }

  /** base64 -> 字节 */
  function b64decode(str) {
    var bin = global.atob(String(str || ""));
    var len = bin.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  /** base64url（URL 安全，去 padding）——用于 otpauth 等场景的展示 */
  function b64urlEncode(bytes) {
    return b64encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  /* ================================================================== *
   * 加密：PBKDF2 派生 + AES-GCM
   *   零知识：主密码与派生密钥永不落盘；云端/本地只存密文信封。
   * ================================================================== */

  var enc = new TextEncoder();

  function deriveKey(password, saltBytes, iterations) {
    if (!isWebCryptoAvailable()) return Promise.reject(new Error("当前环境不支持 Web Crypto，无法加密。"));
    var iters = Math.max(1, Math.floor(Number(iterations) || KDF_ITERATIONS));
    return global.crypto.subtle
      .importKey("raw", enc.encode(String(password || "")), { name: "PBKDF2" }, false, ["deriveKey"])
      .then(function (baseKey) {
        return global.crypto.subtle.deriveKey(
          { name: "PBKDF2", salt: saltBytes, iterations: iters, hash: "SHA-256" },
          baseKey,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"]
        );
      });
  }

  /**
   * 用已有密钥加密整个 vault 文档，产出信封。
   * @param {object} doc     明文 VaultDoc
   * @param {CryptoKey} key  派生密钥
   * @param {{iterations:number, salt:Uint8Array}} kdf  KDF 参数（写进信封，非敏感）
   */
  function encryptVault(doc, key, kdf) {
    var iv = randomBytes(IV_BYTES);
    var plaintext = enc.encode(JSON.stringify(doc));
    return global.crypto.subtle
      .encrypt({ name: "AES-GCM", iv: iv, tagLength: 128 }, key, plaintext)
      .then(function (cipherBuf) {
        return {
          v: 1,
          kdf: { name: "PBKDF2", hash: "SHA-256", iterations: kdf.iterations, salt: b64encode(kdf.salt) },
          enc: { name: "AES-GCM", iv: b64encode(iv), tagLength: 128 },
          ct: b64encode(new Uint8Array(cipherBuf)),
          meta: {
            itemCount: (doc.items || []).length,
            folderCount: (doc.folders || []).length,
            deletedCount: (doc.deleted || []).length,
            updatedAt: Number(doc.updatedAt || 0),
          },
        };
      });
  }

  /** 解密信封 -> 明文 VaultDoc。密码错误与密文损坏同会抛 OperationError。 */
  function decryptVault(envelope, key) {
    if (!envelope || Number(envelope.v) !== 1 || !envelope.enc || !envelope.ct) {
      return Promise.reject(new Error("密码库格式不受支持或已损坏。"));
    }
    var iv = b64decode(envelope.enc.iv);
    var ct = b64decode(envelope.ct);
    return global.crypto.subtle
      .decrypt({ name: "AES-GCM", iv: iv, tagLength: envelope.enc.tagLength || 128 }, key, ct)
      .then(function (plainBuf) {
        return JSON.parse(new TextDecoder().decode(plainBuf));
      });
  }

  /**
   * 解锁：主密码 + 信封 -> { key, kdf, doc }。
   * 抛错即「主密码错误或数据已损坏」（AES-GCM 无法区分二者）。
   */
  function openVault(password, envelope) {
    var salt = b64decode(envelope.kdf.salt);
    var iterations = Number(envelope.kdf.iterations) || KDF_ITERATIONS;
    return deriveKey(password, salt, iterations).then(function (key) {
      return decryptVault(envelope, key).then(function (doc) {
        return { key: key, kdf: { iterations: iterations, salt: salt }, doc: doc };
      });
    });
  }

  /**
   * 首次封库：生成新盐、派生新密钥并加密。
   * @returns {Promise<{key, kdf, envelope}>}
   */
  function sealVault(doc, password, iterations) {
    var iters = Math.max(1, Math.floor(Number(iterations) || KDF_ITERATIONS));
    var salt = randomBytes(SALT_BYTES);
    return deriveKey(password, salt, iters).then(function (key) {
      return encryptVault(doc, key, { iterations: iters, salt: salt }).then(function (envelope) {
        return { key: key, kdf: { iterations: iters, salt: salt }, envelope: envelope };
      });
    });
  }

  /* ================================================================== *
   * TOTP（RFC 6238）：纯前端生成两步验证码
   *   仅实现 HMAC-SHA1/SHA256/SHA512 + 动态截断，够覆盖 otpauth 常见形态。
   * ================================================================== */

  var B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

  /** base32（RFC 4648）-> 字节；容忍空格、连字符、小写、缺失 padding */
  function base32ToBytes(input) {
    var clean = String(input || "").toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
    if (!clean) return new Uint8Array(0);
    var bits = 0;
    var value = 0;
    var out = [];
    for (var i = 0; i < clean.length; i += 1) {
      var idx = B32_ALPHABET.indexOf(clean[i]);
      if (idx === -1) continue; // 忽略非法字符（有些站点会混入空格/符号）
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        out.push((value >>> bits) & 0xff);
      }
    }
    return new Uint8Array(out);
  }

  var TOTP_ALGO = { SHA1: "SHA-1", SHA256: "SHA-256", SHA512: "SHA-512" };

  /**
   * 解析 TOTP 配置。支持两种输入：
   *   - otpauth://totp/Label?secret=XXX&digits=6&period=30&algorithm=SHA1&issuer=Y
   *   - 裸 base32 密钥（默认 6 位 / 30 秒 / SHA1）
   */
  function parseTotpConfig(input) {
    var raw = String(input || "").trim();
    var config = { secret: "", digits: 6, period: 30, algorithm: "SHA1", issuer: "", label: "" };
    if (!raw) return config;

    if (/^otpauth:\/\//i.test(raw)) {
      try {
        var url = new URL(raw);
        // URL 的 pathname 对不同 scheme 解析不一，这里用 searchParams 取键值
        var params = url.searchParams;
        config.secret = (params.get("secret") || "").trim();
        var digits = Number.parseInt(params.get("digits") || "", 10);
        if (Number.isFinite(digits) && digits >= 6 && digits <= 10) config.digits = digits;
        var period = Number.parseInt(params.get("period") || "", 10);
        if (Number.isFinite(period) && period > 0 && period <= 300) config.period = period;
        var algo = (params.get("algorithm") || "SHA1").toUpperCase().replace(/[-_]/g, "");
        if (TOTP_ALGO[algo]) config.algorithm = algo;
        config.issuer = params.get("issuer") || "";
        var path = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
        if (path) {
          var idx = path.indexOf(":");
          config.label = idx > -1 ? path.slice(idx + 1) : path;
          if (!config.issuer && idx > -1) config.issuer = path.slice(0, idx);
        }
        return config;
      } catch (e) {
        // 解析失败按裸密钥处理
      }
    }
    config.secret = raw;
    return config;
  }

  /** 8 字节大端计数器 */
  function counterBytes(counter) {
    var buf = new Uint8Array(8);
    var n = Number(counter) || 0;
    for (var i = 7; i >= 0; i -= 1) {
      buf[i] = n & 0xff;
      n = Math.floor(n / 256);
    }
    return buf;
  }

  /**
   * 计算当前 TOTP 验证码。
   * @param {string} secretInput  base32 密钥或 otpauth URI
   * @param {object} [opts]       { digits, period, algorithm }
   * @param {number} [timeMs]     指定时间（毫秒），默认 Date.now()
   * @returns {Promise<{code, secondsLeft, period, config}>}
   */
  function calcTotpNow(secretInput, opts, timeMs) {
    var base = parseTotpConfig(secretInput);
    var cfg = Object.assign({}, base, opts || {});
    var secretBytes = base32ToBytes(cfg.secret);
    if (!secretBytes.length) return Promise.reject(new Error("TOTP 密钥无效。"));
    if (!isWebCryptoAvailable()) return Promise.reject(new Error("当前环境不支持 Web Crypto。"));

    var now = Number(timeMs) || Date.now();
    var period = cfg.period || 30;
    var counter = Math.floor(now / 1000 / period);
    var hashName = TOTP_ALGO[cfg.algorithm] || "SHA-1";

    return global.crypto.subtle
      .importKey("raw", secretBytes, { name: "HMAC", hash: hashName }, false, ["sign"])
      .then(function (key) {
        return global.crypto.subtle.sign("HMAC", key, counterBytes(counter));
      })
      .then(function (sigBuf) {
        var hmac = new Uint8Array(sigBuf);
        var offset = hmac[hmac.length - 1] & 0x0f;
        var bin =
          ((hmac[offset] & 0x7f) << 24) |
          ((hmac[offset + 1] & 0xff) << 16) |
          ((hmac[offset + 2] & 0xff) << 8) |
          (hmac[offset + 3] & 0xff);
        var code = String(bin % Math.pow(10, cfg.digits)).padStart(cfg.digits, "0");
        var passed = (now / 1000) % period;
        return {
          code: code,
          secondsLeft: Math.max(0, Math.ceil(period - passed)),
          period: period,
          config: cfg,
        };
      });
  }

  /* ================================================================== *
   * 密码生成器：密码 / 口令短语 / PIN
   * ================================================================== */

  var CHARSET = {
    uppercase: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    lowercase: "abcdefghijklmnopqrstuvwxyz",
    numbers: "0123456789",
    special: "!@#$%^&*_-+=:;,.?~",
  };
  var AMBIGUOUS = "ILOlo01|";

  var DEFAULT_SPECIAL = CHARSET.special;

  function defaultGeneratorSettings() {
    return {
      mode: "password",
      // 密码
      length: 16,
      uppercase: true,
      lowercase: true,
      numbers: true,
      special: true,
      avoidAmbiguous: false,
      minUppercase: 0,
      minLowercase: 0,
      minNumbers: 0,
      minSpecial: 0,
      // 口令短语
      words: 6,
      separator: "-",
      capitalize: true,
      includeNumber: false,
      // PIN
      pinLength: 6,
    };
  }

  function normalizeGeneratorSettings(raw) {
    var s = Object.assign(defaultGeneratorSettings(), raw || {});
    s.length = Math.min(128, Math.max(5, Number.parseInt(s.length, 10) || 16));
    s.words = Math.min(20, Math.max(3, Number.parseInt(s.words, 10) || 6));
    s.pinLength = Math.min(64, Math.max(3, Number.parseInt(s.pinLength, 10) || 6));
    s.separator = String(s.separator == null ? "-" : s.separator).slice(0, 3);
    ["uppercase", "lowercase", "numbers", "special", "avoidAmbiguous", "capitalize", "includeNumber"].forEach(
      function (k) { s[k] = !!s[k]; }
    );
    s.minUppercase = Math.min(9, Math.max(0, Number.parseInt(s.minUppercase, 10) || 0));
    s.minLowercase = Math.min(9, Math.max(0, Number.parseInt(s.minLowercase, 10) || 0));
    s.minNumbers = Math.min(9, Math.max(0, Number.parseInt(s.minNumbers, 10) || 0));
    s.minSpecial = Math.min(9, Math.max(0, Number.parseInt(s.minSpecial, 10) || 0));
    if (!s.uppercase) s.minUppercase = 0;
    if (!s.lowercase) s.minLowercase = 0;
    if (!s.numbers) s.minNumbers = 0;
    if (!s.special) s.minSpecial = 0;
    if (!["password", "passphrase", "pin"].includes(s.mode)) s.mode = "password";
    return s;
  }

  function filterAmbiguous(chars) {
    var out = "";
    for (var i = 0; i < chars.length; i += 1) {
      if (AMBIGUOUS.indexOf(chars[i]) === -1) out += chars[i];
    }
    return out;
  }

  function pickFrom(chars) {
    return chars[randomInt(chars.length)];
  }

  /** 原地 Fisher-Yates 洗牌 */
  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i -= 1) {
      var j = randomInt(i + 1);
      var t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  function generatePassword(rawSettings) {
    var s = normalizeGeneratorSettings(rawSettings);
    var pools = {
      uppercase: s.uppercase ? (s.avoidAmbiguous ? filterAmbiguous(CHARSET.uppercase) : CHARSET.uppercase) : "",
      lowercase: s.lowercase ? (s.avoidAmbiguous ? filterAmbiguous(CHARSET.lowercase) : CHARSET.lowercase) : "",
      numbers: s.numbers ? (s.avoidAmbiguous ? filterAmbiguous(CHARSET.numbers) : CHARSET.numbers) : "",
      special: s.special ? CHARSET.special : "",
    };
    var all = pools.uppercase + pools.lowercase + pools.numbers + pools.special;
    if (!all) return "";

    var chars = [];
    var mins = [
      ["uppercase", s.minUppercase],
      ["lowercase", s.minLowercase],
      ["numbers", s.minNumbers],
      ["special", s.minSpecial],
    ];
    mins.forEach(function (pair) {
      var pool = pools[pair[0]];
      if (!pool) return;
      for (var i = 0; i < pair[1] && chars.length < s.length; i += 1) chars.push(pickFrom(pool));
    });
    while (chars.length < s.length) chars.push(pickFrom(all));
    return shuffle(chars).slice(0, s.length).join("");
  }

  function generatePassphrase(rawSettings, wordlist) {
    var s = normalizeGeneratorSettings(rawSettings);
    var list = (wordlist && wordlist.length ? wordlist : defaultWordlist());
    if (!list.length) return "";
    var parts = [];
    for (var i = 0; i < s.words; i += 1) {
      var w = list[randomInt(list.length)];
      if (s.capitalize) w = w.charAt(0).toUpperCase() + w.slice(1);
      parts.push(w);
    }
    if (s.includeNumber) {
      parts[randomInt(parts.length)] += String(randomInt(10));
    }
    return parts.join(s.separator);
  }

  function generatePin(rawSettings) {
    var s = normalizeGeneratorSettings(rawSettings);
    var out = "";
    for (var i = 0; i < s.pinLength; i += 1) out += String(randomInt(10));
    return out;
  }

  function defaultWordlist() {
    var raw = (global.VaultWordlist && global.VaultWordlist.words) || "";
    if (Array.isArray(raw)) return raw;
    return String(raw).split(/\s+/).filter(Boolean);
  }

  /**
   * 强度评估 -> 1..4（弱/一般/良好/强）。
   * 基于字符池大小 × 长度的信息熵，叠加常见模式惩罚。
   */
  function estimateStrength(password) {
    var pw = String(password || "");
    if (!pw) return 0;
    var pool = 0;
    if (/[a-z]/.test(pw)) pool += 26;
    if (/[A-Z]/.test(pw)) pool += 26;
    if (/[0-9]/.test(pw)) pool += 10;
    if (/[^a-zA-Z0-9]/.test(pw)) pool += 32;
    var entropy = pw.length * (pool > 0 ? Math.log2(pool) : 0);

    if (/^(.)\1+$/.test(pw)) entropy = Math.min(entropy, 10);            // 纯重复
    if (/^(0123|1234|abcd|qwer|asdf|password|admin|letmein)/i.test(pw)) entropy = Math.min(entropy, 20);
    if (/^\d+$/.test(pw)) entropy = Math.min(entropy, pw.length * 3.3);  // 纯数字上限

    if (entropy < 40) return 1;
    if (entropy < 60) return 2;
    if (entropy < 90) return 3;
    return 4;
  }

  var STRENGTH_LABELS = { 0: "", 1: "弱", 2: "一般", 3: "良好", 4: "强" };
  function strengthLabel(level) {
    return STRENGTH_LABELS[level] || "";
  }

  /* ================================================================== *
   * 安全检查：弱密码 + 重复使用（纯本地，不发起任何网络请求）
   * ================================================================== */

  var COMMON_WEAK = [
    "password", "123456", "12345678", "123456789", "qwerty", "abc123", "111111",
    "1234567", "letmein", "welcome", "monkey", "dragon", "iloveyou", "admin",
    "login", "passw0rd", "p@ssw0rd", "qwerty123", "1q2w3e4r", "000000",
    "888888", "666666", "123123", "zxcvbnm", "asdfgh", "11111111", "sunshine",
  ];

  /** 本地弱密码启发式（对照 NodeWarden 的 isWeakPassword） */
  function isWeakPassword(password, context) {
    var pw = String(password || "");
    if (!pw) return false;
    if (pw.length < 10) return true;
    var lower = pw.toLowerCase();
    if (COMMON_WEAK.indexOf(lower) > -1) return true;
    if (/^(.)\1+$/.test(pw)) return true;                       // 单一字符重复
    if (/^\d+$/.test(pw) && pw.length < 12) return true;        // 短纯数字
    if (/^(?:0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef|qwer|asdf|zxcv)/i.test(pw)) return true;
    var username = context && context.username ? String(context.username).toLowerCase() : "";
    if (username && username.length >= 3 && lower.indexOf(username) > -1) return true;
    var classes = 0;
    if (/[a-z]/.test(pw)) classes += 1;
    if (/[A-Z]/.test(pw)) classes += 1;
    if (/[0-9]/.test(pw)) classes += 1;
    if (/[^a-zA-Z0-9]/.test(pw)) classes += 1;
    if (pw.length < 14 && classes < 3) return true;
    return false;
  }

  function sha1Hex(text) {
    if (!isWebCryptoAvailable()) return Promise.resolve("");
    return global.crypto.subtle
      .digest("SHA-1", enc.encode(String(text || "")))
      .then(function (buf) {
        return Array.from(new Uint8Array(buf)).map(function (b) {
          return b.toString(16).padStart(2, "0");
        }).join("");
      });
  }

  /**
   * 扫描登录类条目：标记弱密码与重复使用。
   * 用 SHA-1 摘要分组做重复检测，避免在结果里以明文参与比较。
   * @returns {Promise<{checked, weak, reused, results}>}
   */
  function analyzePasswords(items) {
    var logins = (items || []).filter(function (it) {
      return it && it.type === "login" && it.login && it.login.password;
    });
    if (!logins.length || !isWebCryptoAvailable()) {
      return Promise.resolve({ checked: 0, weak: 0, reused: 0, results: [] });
    }
    return Promise.all(
      logins.map(function (it) {
        return sha1Hex(it.login.password).then(function (hash) { return { item: it, hash: hash }; });
      })
    ).then(function (hashed) {
      var counts = {};
      hashed.forEach(function (h) { counts[h.hash] = (counts[h.hash] || 0) + 1; });
      var results = hashed.map(function (h) {
        var weak = isWeakPassword(h.item.login.password, { username: h.item.login.username });
        var reused = counts[h.hash] > 1;
        return {
          id: h.item.id,
          name: h.item.name || "（无名称）",
          username: h.item.login.username || "",
          password: h.item.login.password,
          weak: weak,
          reused: reused,
          reusedCount: counts[h.hash],
        };
      });
      return {
        checked: results.length,
        weak: results.filter(function (r) { return r.weak; }).length,
        reused: results.filter(function (r) { return r.reused; }).length,
        results: results,
      };
    });
  }

  /* ================================================================== *
   * 导入导出：原生 JSON + Bitwarden JSON/CSV
   *   type 映射：login=1, note=2, card=3, identity=4（与 Bitwarden 对齐）
   * ================================================================== */

  var TYPE_TO_BW = { login: 1, note: 2, card: 3, identity: 4 };
  var BW_TO_TYPE = { 1: "login", 2: "note", 3: "card", 4: "identity" };
  var FIELD_TYPE_TO_BW = { text: 0, hidden: 1, boolean: 2 };
  var BW_TO_FIELD_TYPE = { 0: "text", 1: "hidden", 2: "boolean" };

  function nativeExport(doc) {
    return JSON.stringify({ format: "kvault-vault", version: 1, exportedAt: Date.now(), vault: doc }, null, 2);
  }

  function nativeImport(parsed) {
    var doc = parsed && parsed.vault ? parsed.vault : parsed;
    if (!doc || typeof doc !== "object" || !Array.isArray(doc.items)) {
      throw new Error("不是有效的密码库 JSON。");
    }
    return doc;
  }

  function toBitwardenFolder(folder) {
    return { id: folder.id, name: folder.name };
  }

  function toBitwardenItem(item) {
    var base = {
      id: item.id,
      type: TYPE_TO_BW[item.type] || 1,
      name: item.name || "",
      notes: item.notes || "",
      favorite: !!item.favorite,
      folderId: item.folderId || null,
      reprompt: item.reprompt ? 1 : 0,
      fields: (item.fields || []).map(function (f) {
        return { name: f.name, value: f.type === "boolean" ? (f.value ? "true" : "false") : f.value, type: FIELD_TYPE_TO_BW[f.type] || 0 };
      }),
      creationDate: new Date(Number(item.createdAt) || Date.now()).toISOString(),
      revisionDate: new Date(Number(item.updatedAt) || Date.now()).toISOString(),
    };
    if (item.type === "login") {
      base.login = {
        username: (item.login && item.login.username) || "",
        password: (item.login && item.login.password) || "",
        totp: (item.login && item.login.totp) || "",
        uris: ((item.login && item.login.uris) || []).filter(function (u) { return u && u.uri; }).map(function (u) {
          return { uri: u.uri, match: u.match == null ? null : u.match };
        }),
      };
    } else if (item.type === "card") {
      base.card = {
        cardholderName: (item.card && item.card.cardholderName) || "",
        brand: (item.card && item.card.brand) || "",
        number: (item.card && item.card.number) || "",
        expMonth: (item.card && item.card.expMonth) || "",
        expYear: (item.card && item.card.expYear) || "",
        code: (item.card && item.card.code) || "",
      };
    } else if (item.type === "identity") {
      base.identity = Object.assign({
        title: "", firstName: "", middleName: "", lastName: "", username: "", company: "",
        ssn: "", passportNumber: "", licenseNumber: "", email: "", phone: "",
        address1: "", address2: "", address3: "", city: "", state: "", postalCode: "", country: "",
      }, item.identity || {});
    } else {
      base.secureNote = { type: 0 };
    }
    return base;
  }

  function toBitwardenJson(doc) {
    return {
      encrypted: false,
      folders: (doc.folders || []).map(toBitwardenFolder),
      items: (doc.items || []).map(toBitwardenItem),
    };
  }

  function fromBitwardenItem(raw) {
    var type = BW_TO_TYPE[raw.type] || "login";
    var item = {
      id: raw.id || uuid(),
      type: type,
      name: raw.name || "",
      folderId: raw.folderId || null,
      favorite: !!raw.favorite,
      notes: raw.notes || "",
      reprompt: raw.reprompt === 1 || raw.reprompt === true,
      fields: (raw.fields || []).map(function (f) {
        var ft = BW_TO_FIELD_TYPE[f.type] || "text";
        return {
          id: uuid(),
          name: f.name || "",
          type: ft,
          value: ft === "boolean" ? (String(f.value) === "true") : (f.value == null ? "" : f.value),
        };
      }),
      createdAt: raw.creationDate ? Date.parse(raw.creationDate) || Date.now() : Date.now(),
      updatedAt: raw.revisionDate ? Date.parse(raw.revisionDate) || Date.now() : Date.now(),
      deletedAt: null,
      passwordHistory: [],
    };
    if (type === "login") {
      item.login = {
        username: (raw.login && raw.login.username) || "",
        password: (raw.login && raw.login.password) || "",
        totp: (raw.login && raw.login.totp) || "",
        uris: ((raw.login && raw.login.uris) || []).filter(function (u) { return u && u.uri; }).map(function (u) {
          return { uri: u.uri, match: u.match == null ? null : u.match };
        }),
      };
    } else if (type === "card") {
      item.card = Object.assign(
        { cardholderName: "", number: "", brand: "", expMonth: "", expYear: "", code: "" },
        raw.card || {}
      );
    } else if (type === "identity") {
      item.identity = Object.assign(
        {
          title: "", firstName: "", middleName: "", lastName: "", username: "", company: "",
          ssn: "", passportNumber: "", licenseNumber: "", email: "", phone: "",
          address1: "", address2: "", address3: "", city: "", state: "", postalCode: "", country: "",
        },
        raw.identity || {}
      );
    } else {
      item.note = {};
    }
    return item;
  }

  function fromBitwardenJson(obj) {
    if (!obj || !Array.isArray(obj.items)) throw new Error("不是有效的 Bitwarden JSON。");
    return {
      schema: 1,
      vaultId: uuid(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      settings: {},
      folders: (obj.folders || []).map(function (f) { return { id: f.id, name: f.name || "未命名", createdAt: Date.now(), updatedAt: Date.now() }; }),
      items: obj.items.map(fromBitwardenItem),
      deleted: [],
    };
  }

  /* ---------- CSV ---------- */

  var CSV_HEADER = ["folder", "favorite", "type", "name", "notes", "fields", "reprompt", "login_uri", "login_username", "login_password", "login_totp"];

  function csvEscape(value) {
    var s = value == null ? "" : String(value);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toBitwardenCsv(doc) {
    var folderName = {};
    (doc.folders || []).forEach(function (f) { folderName[f.id] = f.name; });
    var lines = [CSV_HEADER.join(",")];
    (doc.items || []).forEach(function (item) {
      var bwType = { login: "login", note: "note", card: "card", identity: "identity" }[item.type] || "login";
      var fieldsText = "";
      if (item.type === "login") {
        fieldsText = (item.fields || []).map(function (f) {
          return f.name + ": " + (f.type === "boolean" ? (f.value ? "true" : "false") : f.value);
        }).join("\n");
      } else {
        // 非登录类型：把类型化字段以 "前缀.字段: 值" 塞进 fields 列，保证往返不丢
        var obj = item.card || item.identity || {};
        fieldsText = Object.keys(obj).filter(function (k) { return obj[k]; }).map(function (k) {
          return item.type + "." + k + ": " + obj[k];
        }).join("\n");
      }
      var row = [
        item.folderId && folderName[item.folderId] ? folderName[item.folderId] : "",
        item.favorite ? "1" : "",
        bwType,
        item.name || "",
        item.notes || "",
        fieldsText,
        item.reprompt ? "1" : "",
        item.type === "login" && item.login && item.login.uris[0] ? item.login.uris[0].uri : "",
        item.type === "login" && item.login ? item.login.username || "" : "",
        item.type === "login" && item.login ? item.login.password || "" : "",
        item.type === "login" && item.login ? item.login.totp || "" : "",
      ];
      lines.push(row.map(csvEscape).join(","));
    });
    return lines.join("\r\n");
  }

  /** 健壮 CSV 解析：支持引号包裹、字段内逗号/换行、CRLF、BOM */
  function parseCsv(text) {
    var s = String(text || "").replace(/^\uFEFF/, "");
    var rows = [];
    var row = [];
    var field = "";
    var inQuotes = false;
    var i = 0;
    while (i < s.length) {
      var ch = s[i];
      if (inQuotes) {
        if (ch === '"') {
          if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false;
          i += 1;
          continue;
        }
        field += ch;
        i += 1;
        continue;
      }
      if (ch === '"') { inQuotes = true; i += 1; continue; }
      if (ch === ",") { row.push(field); field = ""; i += 1; continue; }
      if (ch === "\r") { i += 1; continue; }
      if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i += 1; continue; }
      field += ch;
      i += 1;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (r) { return r.length > 1 || (r.length === 1 && r[0] !== ""); });
  }

  function csvToBitwardenItems(text) {
    var rows = parseCsv(text);
    if (rows.length < 2) return { folders: [], items: [] };
    var header = rows[0].map(function (h) { return String(h).trim().toLowerCase(); });
    var idx = {};
    header.forEach(function (h, i) { idx[h] = i; });
    var folders = [];
    var folderIds = {};
    var items = rows.slice(1).map(function (r) {
      function cell(name) {
        var i = idx[name];
        return i == null ? "" : (r[i] == null ? "" : r[i]);
      }
      var typeName = (cell("type") || "login").toLowerCase();
      var type = ["login", "note", "card", "identity"].includes(typeName) ? typeName : "login";
      var folderName = cell("folder");
      var folderId = null;
      if (folderName) {
        if (!folderIds[folderName]) {
          folderIds[folderName] = uuid();
          folders.push({ id: folderIds[folderName], name: folderName, createdAt: Date.now(), updatedAt: Date.now() });
        }
        folderId = folderIds[folderName];
      }
      var raw = {
        id: uuid(),
        type: TYPE_TO_BW[type],
        name: cell("name"),
        notes: cell("notes"),
        favorite: cell("favorite") === "1" || cell("favorite").toLowerCase() === "true",
        folderId: folderId,
        reprompt: cell("reprompt") === "1",
        fields: [],
        login: {
          username: cell("login_username"),
          password: cell("login_password"),
          totp: cell("login_totp"),
          uris: cell("login_uri") ? [{ uri: cell("login_uri"), match: null }] : [],
        },
      };
      // fields 列：登录用 "标签: 值" 行；其他类型是 "type.field: 值"
      var fieldsText = cell("fields");
      if (fieldsText) {
        fieldsText.split(/\r?\n/).forEach(function (line) {
          var ci = line.indexOf(":");
          if (ci === -1) return;
          var nm = line.slice(0, ci).trim();
          var val = line.slice(ci + 1).trim();
          if (type !== "login" && nm.indexOf(".") > -1) return; // type.field 归位逻辑留待扩展
          raw.fields.push({ name: nm, value: val, type: 0 });
        });
      }
      return raw;
    });
    return { folders: folders, items: items };
  }

  function fromBitwardenCsv(text) {
    var parsed = csvToBitwardenItems(text);
    return {
      schema: 1,
      vaultId: uuid(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      settings: {},
      folders: parsed.folders,
      items: parsed.items.map(fromBitwardenItem),
      deleted: [],
    };
  }

  /* ================================================================== *
   * 导出
   * ================================================================== */

  global.VaultCore = {
    KDF_ITERATIONS: KDF_ITERATIONS,
    // crypto
    isWebCryptoAvailable: isWebCryptoAvailable,
    randomBytes: randomBytes,
    randomInt: randomInt,
    uuid: uuid,
    b64encode: b64encode,
    b64decode: b64decode,
    b64urlEncode: b64urlEncode,
    deriveKey: deriveKey,
    encryptVault: encryptVault,
    decryptVault: decryptVault,
    openVault: openVault,
    sealVault: sealVault,
    // totp
    base32ToBytes: base32ToBytes,
    parseTotpConfig: parseTotpConfig,
    calcTotpNow: calcTotpNow,
    // generator
    CHARSET: CHARSET,
    AMBIGUOUS: AMBIGUOUS,
    defaultGeneratorSettings: defaultGeneratorSettings,
    normalizeGeneratorSettings: normalizeGeneratorSettings,
    generatePassword: generatePassword,
    generatePassphrase: generatePassphrase,
    generatePin: generatePin,
    estimateStrength: estimateStrength,
    strengthLabel: strengthLabel,
    // security
    isWeakPassword: isWeakPassword,
    analyzePasswords: analyzePasswords,
    // portable
    TYPE_TO_BW: TYPE_TO_BW,
    BW_TO_TYPE: BW_TO_TYPE,
    nativeExport: nativeExport,
    nativeImport: nativeImport,
    toBitwardenJson: toBitwardenJson,
    fromBitwardenJson: fromBitwardenJson,
    toBitwardenCsv: toBitwardenCsv,
    fromBitwardenCsv: fromBitwardenCsv,
    parseCsv: parseCsv,
  };
})(typeof window !== "undefined" ? window : globalThis);
