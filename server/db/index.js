const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function executeStatement(stmt, method, params) {
  if (params == null) {
    return stmt[method]();
  }
  if (Array.isArray(params)) {
    return stmt[method](...params);
  }
  return stmt[method](params);
}

function ensureColumn(db, table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

function initDatabase(dbPath) {
  const fullPath = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });

  const db = new DatabaseSync(fullPath);
  const schemaPath = path.resolve(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema);

  // Migrations for databases created before the token-platform refactor:
  // CREATE TABLE IF NOT EXISTS cannot add columns to an existing table.
  ensureColumn(db, 'api_tokens', 'policies_json', 'TEXT');
  ensureColumn(db, 'api_tokens', 'rotated_at', 'INTEGER');
  ensureColumn(db, 'idempotency_keys', 'status_code', 'INTEGER NOT NULL DEFAULT 200');

  return db;
}

function run(db, sql, params) {
  const stmt = db.prepare(sql);
  return executeStatement(stmt, 'run', params);
}

function get(db, sql, params) {
  const stmt = db.prepare(sql);
  return executeStatement(stmt, 'get', params);
}

function all(db, sql, params) {
  const stmt = db.prepare(sql);
  return executeStatement(stmt, 'all', params);
}

function transaction(db, callback) {
  db.exec('BEGIN');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function cleanupExpiredState(db) {
  const now = Date.now();
  run(db, 'DELETE FROM sessions WHERE expires_at <= ?', [now]);
  run(db, 'DELETE FROM chunk_uploads WHERE expires_at <= ?', [now]);
  try {
    run(db, 'DELETE FROM idempotency_keys WHERE expires_at <= ?', [now]);
    run(db, 'DELETE FROM sha_dedup_index WHERE expires_at <= ?', [now]);
  } catch {
    // Tables are created by schema.sql; tolerate databases mid-migration.
  }
}

module.exports = {
  initDatabase,
  ensureColumn,
  run,
  get,
  all,
  transaction,
  cleanupExpiredState,
};
