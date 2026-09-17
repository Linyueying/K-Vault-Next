#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const keyTargets = ['CONFIG_ENCRYPTION_KEY', 'SESSION_SECRET'];

const placeholderValues = new Set([
  'replace_with_a_long_random_secret',
  'replace_with_another_long_random_secret',
  'replace_me',
  'change_me',
  'changeme',
  'your_secret_here',
  'your_session_secret',
  'placeholder',
]);

const placeholderPatterns = [
  /^replace_with/i,
  /^change_this/i,
  /^your[_-]?(secret|password)/i,
  /^example$/i,
  /^default$/i,
  /^todo$/i,
  /^<.+>$/,
];

function usage() {
  console.log('Usage: node scripts/bootstrap-env.js [--env-path path] [--example-path path]');
}

function parseArgs(argv) {
  const output = {
    envFile: path.join(repoRoot, '.env'),
    exampleFile: path.join(repoRoot, '.env.example'),
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      output.help = true;
      continue;
    }

    if (arg === '--env-path' && argv[i + 1]) {
      output.envFile = path.resolve(repoRoot, argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--env-path=')) {
      output.envFile = path.resolve(repoRoot, arg.slice('--env-path='.length));
      continue;
    }

    if (arg === '--example-path' && argv[i + 1]) {
      output.exampleFile = path.resolve(repoRoot, argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--example-path=')) {
      output.exampleFile = path.resolve(repoRoot, arg.slice('--example-path='.length));
      continue;
    }
  }

  return output;
}

function escapeRegExp(input) {
  return String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function parseEnvValue(raw) {
  let value = String(raw || '').trim();

  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  const commentPos = value.indexOf(' #');
  if (commentPos >= 0) {
    value = value.slice(0, commentPos).trim();
  }

  return value;
}

function readEnvValue(content, key) {
  const matcher = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=\\s*(.*)$`, 'm');
  const matched = content.match(matcher);
  if (!matched) return '';
  return parseEnvValue(matched[1]);
}

function upsertEnvValue(content, key, value) {
  const eol = getEol(content || '\n');
  const matcher = new RegExp(`^(\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=\\s*).*$`, 'm');

  if (matcher.test(content)) {
    return content.replace(matcher, (_, prefix) => `${prefix}${value}`);
  }

  const suffix = content && !content.endsWith('\n') && !content.endsWith('\r\n') ? eol : '';
  return `${content}${suffix}${key}=${value}${eol}`;
}

function isPlaceholder(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return true;
  if (placeholderValues.has(normalized)) return true;
  return placeholderPatterns.some((pattern) => pattern.test(normalized));
}

function generateSecret() {
  return crypto.randomBytes(48).toString('base64url');
}

function ensureEnvFile(envFile, exampleFile) {
  if (fs.existsSync(envFile)) {
    return false;
  }
  if (!fs.existsSync(exampleFile)) {
    throw new Error(`Template file not found: ${exampleFile}`);
  }

  fs.copyFileSync(exampleFile, envFile);
  return true;
}

function run() {
  const options = parseArgs(process.argv);
  if (options.help) {
    usage();
    return;
  }

  const envFile = options.envFile;
  const exampleFile = options.exampleFile;

  const created = ensureEnvFile(envFile, exampleFile);
  let content = fs.readFileSync(envFile, 'utf8');
  const generatedKeys = [];

  for (const key of keyTargets) {
    const current = readEnvValue(content, key);
    if (!isPlaceholder(current)) continue;
    content = upsertEnvValue(content, key, generateSecret());
    generatedKeys.push(key);
  }

  if (generatedKeys.length > 0) {
    fs.writeFileSync(envFile, content, 'utf8');
  }

  if (created) {
    console.log(`[bootstrap-env] Created ${path.basename(envFile)} from ${path.basename(exampleFile)}.`);
  }
  if (generatedKeys.length > 0) {
    console.log(`[bootstrap-env] Generated secure values for: ${generatedKeys.join(', ')}.`);
  } else {
    console.log('[bootstrap-env] CONFIG_ENCRYPTION_KEY and SESSION_SECRET already configured, no changes made.');
  }
}

try {
  run();
} catch (error) {
  console.error(`[bootstrap-env] ${error.message}`);
  process.exit(1);
}
