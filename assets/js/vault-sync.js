/*!
 * vault-sync.js —— 密码库多端同步客户端（独立可复用模块）
 *
 * 定位：挂载到 window.VaultSync，**不触碰 DOM / Vue**，负责：
 *   1. 本地密文信封与服务端版本号（revision）的持久化管理；
 *   2. 对接专用接口 `/api/manage/vault`（GET / PUT / DELETE）；
 *   3. 乐观锁冲突（409 VAULT_CONFLICT）自动拉取 → 解密 → VaultCore.mergeVaultDocs 合并 → 重推；
 *   4. 轻量级元信息轮询（`?metaOnly=1`），快速感知其他设备的变更。
 *
 * 二次开发扩展点：
 *   - `endpoint`: 可替换为自定义同步后端或带用户前缀的多租户端点；
 *   - `fetchImpl`: 可注入自定义 fetch（便于 Node 单测或代理层包装）；
 *   - `storage`: 可替换为 IndexedDB / 内存存储适配器。
 */
(function (global) {
  "use strict";

  var DEFAULT_ENDPOINT = "./api/manage/vault";
  var LS_STATE_V2 = "kvault.vault.state.v2";
  var LS_DEVICE_ID = "kvault.vault.deviceId";
  var LS_LEGACY_ENVELOPE = "kvault.vault.envelope";
  var LS_LEGACY_PASTE_ID = "kvault.vault.pasteId";
  var MAX_CONFLICT_RETRIES = 3;

  function defaultStorage() {
    return typeof global.localStorage !== "undefined" ? global.localStorage : null;
  }

  function safeJsonParse(raw, fallback) {
    try {
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function getOrCreateDeviceId(storage) {
    var st = storage || defaultStorage();
    var existing = "";
    try { existing = st ? (st.getItem(LS_DEVICE_ID) || "") : ""; } catch (e) {}
    if (existing) return existing;
    var core = global.VaultCore;
    var id = "dev_" + (core && core.uuid ? core.uuid().slice(0, 12) : Math.random().toString(36).slice(2, 14));
    try { if (st) st.setItem(LS_DEVICE_ID, id); } catch (e) {}
    return id;
  }

  function isValidEnvelope(env) {
    return Boolean(env && typeof env === "object" && Number(env.v) === 1 && env.kdf && env.enc && typeof env.ct === "string" && env.ct);
  }

  function createClient(options) {
    var opts = options || {};
    var endpoint = opts.endpoint || DEFAULT_ENDPOINT;
    var storage = opts.storage || defaultStorage();
    var fetchImpl = opts.fetchImpl || (typeof global.fetch === "function" ? global.fetch.bind(global) : null);
    var core = opts.core || global.VaultCore;
    var deviceId = opts.deviceId || getOrCreateDeviceId(storage);

    function readLocalState() {
      if (!storage) {
        return { revision: 0, envelope: null, updatedAt: 0, pendingPush: false };
      }
      var raw = null;
      try { raw = storage.getItem(LS_STATE_V2); } catch (e) {}
      var parsed = safeJsonParse(raw, null);
      if (parsed && typeof parsed === "object" && isValidEnvelope(parsed.envelope)) {
        return {
          revision: Math.max(0, Number(parsed.revision) || 0),
          envelope: parsed.envelope,
          updatedAt: Number(parsed.updatedAt) || 0,
          pendingPush: Boolean(parsed.pendingPush),
        };
      }
      // 兼容升级：读取旧版 localStorage 信封
      var legacyRaw = null;
      try { legacyRaw = storage.getItem(LS_LEGACY_ENVELOPE); } catch (e) {}
      var legacyEnv = safeJsonParse(legacyRaw, null);
      if (isValidEnvelope(legacyEnv)) {
        return {
          revision: 0,
          envelope: legacyEnv,
          updatedAt: Number(legacyEnv.meta && legacyEnv.meta.updatedAt) || 0,
          pendingPush: false,
        };
      }
      return { revision: 0, envelope: null, updatedAt: 0, pendingPush: false };
    }

    function writeLocalState(next) {
      if (!storage) return;
      var payload = {
        revision: Math.max(0, Number(next && next.revision) || 0),
        envelope: next && isValidEnvelope(next.envelope) ? next.envelope : null,
        updatedAt: Number(next && next.updatedAt) || 0,
        pendingPush: Boolean(next && next.pendingPush),
      };
      try {
        if (payload.envelope) {
          storage.setItem(LS_STATE_V2, JSON.stringify(payload));
          storage.removeItem(LS_LEGACY_ENVELOPE);
          storage.removeItem(LS_LEGACY_PASTE_ID);
        } else {
          storage.removeItem(LS_STATE_V2);
        }
      } catch (e) {}
    }

    async function requestJson(url, reqOpts) {
      if (!fetchImpl) throw new Error("当前环境缺少 fetch 实现。");
      var init = Object.assign({ credentials: "include", cache: "no-store" }, reqOpts || {});
      var headers = Object.assign({ Accept: "application/json" }, init.headers || {});
      if (init.body != null && typeof init.body !== "string") {
        init.body = JSON.stringify(init.body);
        headers["Content-Type"] = "application/json";
      }
      init.headers = headers;

      var res = await fetchImpl(url, init);
      var data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      return { status: res.status, ok: res.ok, data: data };
    }

    /** 拉取云端记录（或仅元信息） */
    async function pull(pullOpts) {
      var metaOnly = Boolean(pullOpts && pullOpts.metaOnly);
      var sep = endpoint.indexOf("?") > -1 ? "&" : "?";
      var url = endpoint + sep + (metaOnly ? "metaOnly=1&" : "") + "_t=" + Date.now();
      var res = await requestJson(url, { method: "GET" });
      if (!res.ok || !res.data || !res.data.ok) {
        var msg = (res.data && (res.data.error || res.data.message)) || ("HTTP " + res.status);
        var err = new Error(msg);
        err.status = res.status;
        throw err;
      }
      return {
        exists: Boolean(res.data.exists),
        revision: Math.max(0, Number(res.data.revision) || 0),
        updatedAt: Number(res.data.updatedAt) || 0,
        updatedBy: String(res.data.updatedBy || ""),
        byteSize: Number(res.data.byteSize) || 0,
        envelope: metaOnly ? undefined : (isValidEnvelope(res.data.envelope) ? res.data.envelope : null),
      };
    }

    /** 推送密文信封（带乐观锁 expectedRevision） */
    async function push(params) {
      var env = params && params.envelope;
      if (!isValidEnvelope(env)) throw new Error("待同步的密文信封无效。");
      var expectedRevision = Math.max(0, Number(params && params.expectedRevision) || 0);
      var force = Boolean(params && params.force);

      var res = await requestJson(endpoint, {
        method: "PUT",
        body: {
          envelope: env,
          expectedRevision: expectedRevision,
          deviceId: deviceId,
          force: force,
        },
      });

      if (res.status === 409 && res.data && res.data.code === "VAULT_CONFLICT") {
        return {
          status: "conflict",
          remote: {
            exists: Boolean(res.data.exists !== false),
            revision: Math.max(0, Number(res.data.revision) || 0),
            updatedAt: Number(res.data.updatedAt) || 0,
            updatedBy: String(res.data.updatedBy || ""),
            byteSize: Number(res.data.byteSize) || 0,
            envelope: isValidEnvelope(res.data.envelope) ? res.data.envelope : null,
          },
        };
      }

      if (!res.ok || !res.data || !res.data.ok) {
        var msg = (res.data && (res.data.error || res.data.message)) || ("HTTP " + res.status);
        var err = new Error(msg);
        err.status = res.status;
        throw err;
      }

      return {
        status: "ok",
        revision: Math.max(1, Number(res.data.revision) || (expectedRevision + 1)),
        updatedAt: Number(res.data.updatedAt) || Date.now(),
        updatedBy: String(res.data.updatedBy || deviceId),
        byteSize: Number(res.data.byteSize) || 0,
      };
    }

    /**
     * 解密云端信封。若云端使用同一把派生密钥（相同 salt/iterations）直接解密；
     * 若 KDF 参数已变更（另一台设备改过主密码），抛错并标记 code = 'KDF_CHANGED'。
     */
    async function decryptRemoteEnvelope(remoteEnv, key, kdf) {
      if (!isValidEnvelope(remoteEnv)) {
        throw new Error("云端返回了无效的密文信封。");
      }
      var localSaltB64 = core.b64encode(kdf.salt);
      if (
        remoteEnv.kdf.salt !== localSaltB64 ||
        Number(remoteEnv.kdf.iterations) !== Number(kdf.iterations)
      ) {
        var kdfErr = new Error("云端主密码已变更，请重新解锁。");
        kdfErr.code = "KDF_CHANGED";
        throw kdfErr;
      }
      try {
        return await core.decryptVault(remoteEnv, key);
      } catch (e) {
        var decErr = new Error("无法使用当前密钥解密云端数据（可能主密码已在其他设备变更）。");
        decErr.code = "DECRYPT_FAILED";
        throw decErr;
      }
    }

    /**
     * 完整双向收敛同步：
     *   - 无本地未推送修改时：先走 `?metaOnly=1` 快速比对版本号，仅云端有新版本才拉取解密并合并；
     *   - 有本地修改时：加密推送，遇 409 自动拉取云端版本 → 条目级合并 → 重推（最多 3 轮）。
     *
     * @returns {Promise<{action:string, doc?:object, envelope?:object, revision:number, updatedAt:number, remote?:object}>}
     */
    async function sync(params) {
      if (!core) throw new Error("VaultCore 未加载。");
      var doc = params.doc;
      var key = params.key;
      var kdf = params.kdf;
      var hasLocalChanges = Boolean(params.hasLocalChanges);
      var force = Boolean(params.force);
      var localState = readLocalState();
      var baseRevision = params.revision != null ? Math.max(0, Number(params.revision) || 0) : localState.revision;

      // 情况 A：仅拉取检查（本地无未推送变更）
      if (!hasLocalChanges && !localState.pendingPush && !force) {
        var meta = await pull({ metaOnly: true });
        if (!meta.exists) {
          // 云端尚无记录而本地已有内容 → 立刻补推到云端，避免“仅本地孤岛”
          if (doc) {
            hasLocalChanges = true;
            baseRevision = 0;
          } else {
            return { action: "noop", revision: 0, updatedAt: 0 };
          }
        } else if (meta.revision === baseRevision && baseRevision > 0) {
          return { action: "noop", revision: baseRevision, updatedAt: meta.updatedAt };
        } else {
          var full = await pull({ metaOnly: false });
          if (!full.exists || !full.envelope) {
            return { action: "noop", revision: baseRevision, updatedAt: 0 };
          }
          var remoteDoc;
          try {
            remoteDoc = await decryptRemoteEnvelope(full.envelope, key, kdf);
          } catch (e) {
            if (e.code === "KDF_CHANGED" || e.code === "DECRYPT_FAILED") {
              writeLocalState({ revision: full.revision, envelope: full.envelope, updatedAt: full.updatedAt, pendingPush: false });
              return { action: "reauth_required", revision: full.revision, updatedAt: full.updatedAt, envelope: full.envelope, remote: full };
            }
            throw e;
          }
          var pulledDoc = doc ? core.mergeVaultDocs(doc, remoteDoc) : remoteDoc;
          writeLocalState({ revision: full.revision, envelope: full.envelope, updatedAt: full.updatedAt, pendingPush: false });
          return {
            action: "pulled",
            doc: pulledDoc,
            envelope: full.envelope,
            revision: full.revision,
            updatedAt: full.updatedAt,
          };
        }
      }

      // 情况 B：有本地修改需要推送（含 409 自动合并重试）
      var workingDoc = doc;
      var expectedRev = baseRevision;
      var mergedDuringSync = false;

      for (var attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt += 1) {
        workingDoc.updatedAt = Math.max(Number(workingDoc.updatedAt) || 0, Date.now());
        var env = await core.encryptVault(workingDoc, key, kdf);
        // 先落盘本地密文并标记 pendingPush，保证即使断网/切后台也不丢修改
        writeLocalState({ revision: expectedRev, envelope: env, updatedAt: workingDoc.updatedAt, pendingPush: true });

        var pushRes = await push({
          envelope: env,
          expectedRevision: expectedRev,
          force: force && attempt === 0,
        });

        if (pushRes.status === "ok") {
          writeLocalState({
            revision: pushRes.revision,
            envelope: env,
            updatedAt: pushRes.updatedAt,
            pendingPush: false,
          });
          return {
            action: mergedDuringSync ? "merged" : "pushed",
            doc: workingDoc,
            envelope: env,
            revision: pushRes.revision,
            updatedAt: pushRes.updatedAt,
          };
        }

        // 409 冲突：解密云端最新版并做条目级无损合并，下一轮以新 revision 重试
        var remote = pushRes.remote;
        if (!remote || !remote.envelope) {
          // 极端情况：服务端记录被清空，退回 revision 0 重试
          expectedRev = 0;
          continue;
        }

        var conflictRemoteDoc;
        try {
          conflictRemoteDoc = await decryptRemoteEnvelope(remote.envelope, key, kdf);
        } catch (e) {
          if (e.code === "KDF_CHANGED" || e.code === "DECRYPT_FAILED") {
            return {
              action: "reauth_required",
              revision: remote.revision,
              updatedAt: remote.updatedAt,
              envelope: remote.envelope,
              remote: remote,
            };
          }
          throw e;
        }

        workingDoc = core.mergeVaultDocs(workingDoc, conflictRemoteDoc);
        expectedRev = remote.revision;
        mergedDuringSync = true;
      }

      throw new Error("多端并发写入频繁，自动合并重试次数已达上限，请稍后再试。");
    }

    return {
      deviceId: deviceId,
      endpoint: endpoint,
      readLocalState: readLocalState,
      writeLocalState: writeLocalState,
      pull: pull,
      push: push,
      sync: sync,
    };
  }

  global.VaultSync = {
    DEFAULT_ENDPOINT: DEFAULT_ENDPOINT,
    createClient: createClient,
    getOrCreateDeviceId: getOrCreateDeviceId,
  };
})(typeof window !== "undefined" ? window : globalThis);
