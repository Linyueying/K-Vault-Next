(function () {
  "use strict";

  const prefix = "kvault:transfer:";
  const limit = 200;
  const idPattern = /^[a-z0-9-]{12,64}$/;
  let writes = 0;

  function read(id) {
    if (!idPattern.test(id || "")) return null;
    try {
      const record = JSON.parse(localStorage.getItem(prefix + id));
      if (record?.id !== id || !["success", "failed"].includes(record.status)) return null;
      return record;
    } catch (_) {
      return null;
    }
  }

  function list() {
    const records = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const record = read(key.slice(prefix.length));
      if (record) records.push(record);
    }
    return records.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function save(record) {
    if (!idPattern.test(record.id || "")) return false;
    try {
      const key = prefix + record.id;
      if (record.status !== "success" && read(record.id)?.status === "success") return true;
      localStorage.setItem(key, JSON.stringify(record));
      if (++writes % 25 === 1) {
        for (const older of list().slice(limit)) localStorage.removeItem(prefix + older.id);
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function withLock(id, run) {
    if (!navigator.locks) return run(true);
    return navigator.locks.request(prefix + id, { ifAvailable: true }, (lock) => run(Boolean(lock)));
  }

  window.KVaultTransferRecords = { prefix, idPattern, read, list: () => list().slice(0, limit), save, withLock };
})();
