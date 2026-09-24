// 共享的 playwright-core 解析器：脚本放在仓库里也不怕找不到依赖
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

export async function loadPlaywright() {
  const candidates = [
    process.env.PW_CORE,                       // 手动指定
    'playwright-core',                         // 常规 node 解析
    '/tmp/node_modules/playwright-core',       // 本项目历史上用过
    `${process.env.HOME}/node_modules/playwright-core`,
  ];
  const tried = [];
  for (const c of candidates) {
    if (!c) continue;
    tried.push(c);
    try {
      if (c.startsWith('/')) {
        if (!fs.existsSync(c)) continue;
        const mod = await import(pathToFileURL(c + '/index.js').href);
        // playwright-core 是 CJS，具名导出挂在 default 上
        return mod.chromium ? mod : mod.default;
      }
      const mod = await import(c);
      return mod.chromium ? mod : mod.default;
    } catch { /* 继续试下一个 */ }
  }
  console.error('找不到 playwright-core。任选其一安装：');
  console.error('  npm i -D playwright-core            # 装进本仓库');
  console.error('  npm i -g playwright-core            # 装成全局');
  console.error('或设置环境变量 PW_CORE=/path/to/playwright-core');
  console.error('试过的路径：' + tried.join(', '));
  process.exit(2);
}

// Chromium 可执行文件：优先环境变量，其次常见安装位置
export function findChrome() {
  const cands = [
    process.env.CHROME_PATH,
    '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  // 兜底：在 ms-playwright 缓存里找任意一个 chromium
  const base = '/root/.cache/ms-playwright';
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base)) {
      const p = `${base}/${d}/chrome-linux64/chrome`;
      if (d.startsWith('chromium') && fs.existsSync(p)) return p;
    }
  }
  console.error('找不到 Chromium。设置 CHROME_PATH=/path/to/chrome，或：');
  console.error('  npx playwright install chromium');
  process.exit(2);
}
