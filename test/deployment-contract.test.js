const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

describe('deployment entrypoint contract', function () {
  const root = path.resolve(__dirname, '..');

  it('keeps Cloudflare Pages deployment rooted at repository static pages', function () {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

    assert.match(pkg.scripts.build, /No build step required/);
    assert.doesNotMatch(pkg.scripts.build, /frontend|vite|dist/);
    assert.strictEqual(pkg.scripts['pages:deploy'], 'npx wrangler pages deploy .');
  });

  it('does not keep old frontend build assets as deployable UI', function () {
    const removedPaths = [
      'frontend/index.html',
      'frontend/landing',
      'frontend/src',
      'frontend/package.json',
      'frontend/vite.config.js',
      'frontend/Dockerfile',
      'frontend/nginx.conf',
      'server/Dockerfile',
      '_nuxt',
    ];

    for (const relativePath of removedPaths) {
      assert.strictEqual(fs.existsSync(path.join(root, relativePath)), false, `${relativePath} should not exist`);
    }
  });

  it('exposes Cloudflare Pages as the only deployment entrypoint', function () {
    const removedPaths = [
      'Dockerfile',
      'docker-compose.yml',
      '.dockerignore',
      'docker',
      path.join('server', '.dockerignore'),
      'README-DOCKER.md',
      'README-DOCKER-EN.md',
      path.join('.github', 'workflows', 'docker-image.yml'),
      path.join('.github', 'workflows', 'docker-smoke.yml'),
      path.join('scripts', 'docker-ci-smoke.js'),
      path.join('scripts', 'docker-storage-doctor.js'),
      path.join('scripts', 'bootstrap-env.js'),
      path.join('scripts', 'bootstrap-env.sh'),
      path.join('scripts', 'storage-regression.js'),
    ];

    for (const relativePath of removedPaths) {
      assert.strictEqual(fs.existsSync(path.join(root, relativePath)), false, `${relativePath} should not exist`);
    }

    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    for (const scriptName of Object.keys(pkg.scripts)) {
      assert.doesNotMatch(scriptName, /^docker:/, `package.json script "${scriptName}" should have been removed`);
    }
    assert.strictEqual(pkg.scripts['regression:storage'], undefined);
  });
});
