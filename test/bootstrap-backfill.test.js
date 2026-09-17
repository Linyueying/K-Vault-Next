const assert = require('assert');
const fs = require('node:fs');
const path = require('node:path');
const { createContainer } = require('../server/lib/container');

describe('Storage bootstrap backfill', function () {
  this.timeout(10000);

  const tmpRoot = path.join(__dirname, '..', 'data', `tmp-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const dbPath = path.join(tmpRoot, 'backfill.db');

  before(function () {
    fs.mkdirSync(tmpRoot, { recursive: true });
  });

  it('backfills github/huggingface profiles into existing telegram-only db', function () {
    const baseEnv = {
      CONFIG_ENCRYPTION_KEY: 'k_bootstrap_123456',
      SESSION_SECRET: 's_bootstrap_123456',
      DATA_DIR: tmpRoot,
      DB_PATH: dbPath,
      SETTINGS_STORE: 'sqlite',
      TG_BOT_TOKEN: '123:abc',
      TG_CHAT_ID: '123456',
      DEFAULT_STORAGE_TYPE: 'telegram',
    };

    const first = createContainer(baseEnv);
    const phase1Types = first.storageRepo.list(false).map((item) => item.type);
    assert.deepStrictEqual(phase1Types, ['telegram']);

    const second = createContainer({
      ...baseEnv,
      HF_TOKEN: 'hf_xxx',
      HF_REPO: 'u/dataset',
      GITHUB_TOKEN: 'ghp_xxx',
      GITHUB_REPO: 'u/repo',
    });

    const phase2Types = second.storageRepo.list(false).map((item) => item.type).sort();
    assert.deepStrictEqual(phase2Types, ['github', 'huggingface', 'telegram']);
  });
});
