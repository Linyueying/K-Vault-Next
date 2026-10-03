/**
 * 三页 Vue 模板的**编译期**校验。
 *
 * 为什么需要它：index / admin / share 都是「无构建步骤」的原生 HTML ——
 * 模板直接写在 DOM 里，由 Vue 全局构建在浏览器里现编译。模板里写错一个
 * 指令，本地没有任何环节会报错，只有页面打开时整块白屏才被发现。
 *
 * 这里在 Node 里跑同一份编译器（vendor/vue.global.prod.min.js），把 #app
 * 的内容编译一遍：语法错误在提交前就炸出来。
 *
 * 只做编译期检查、不做渲染 —— 渲染要完整 DOM，成本远高于收益。
 * 配合 scripts/check_shared.py 的「模板标识符是否都有定义」一起用。
 *
 * 用法：node scripts/verify-templates.mjs
 */
import fs from 'fs';
import vm from 'vm';

const PAGES = ['index.html', 'admin.html', 'share.html', 'gallery.html', 'paste.html', 'preview.html', 'webdav.html'];

/** 以 `<div id="app">` 为根，按 div 深度配平取出它的 innerHTML。 */
function appTemplate(src) {
  const open = /<div[^>]*\bid="app"[^>]*>/i.exec(src);
  if (!open) return null;
  const start = open.index + open[0].length;
  let depth = 1;
  let i = start;
  while (i < src.length) {
    // 脚本 / 样式里的 `<div>` 是字符串内容，不能计入深度
    if (/^<script\b/i.test(src.slice(i, i + 7))) {
      const end = src.indexOf('</script>', i);
      i = end === -1 ? src.length : end + 9;
      continue;
    }
    if (/^<style\b/i.test(src.slice(i, i + 6))) {
      const end = src.indexOf('</style>', i);
      i = end === -1 ? src.length : end + 8;
      continue;
    }
    if (/^<div\b/i.test(src.slice(i, i + 4))) { depth += 1; i += 4; continue; }
    if (/^<\/div>/i.test(src.slice(i, i + 6))) {
      depth -= 1;
      i += 6;
      if (depth === 0) return src.slice(start, i - 6);
      continue;
    }
    i += 1;
  }
  return null;
}

/**
 * Vue 的 compiler-dom 在编译期用 document.createElement('div') 做浏览器原生
 * 实体解码，所以这里必须给一个能用的 DOM 存根：只返回空串会让编译器读到
 * undefined（属性分支走的是 children[0].getAttribute()），一进来就抛异常。
 *
 * 存根只需负责「&amp; / &quot; / &#39; 这类实体还原」和「剥掉标签」——
 * 编译期校验不关心解码后的具体文本，只关心能不能把模板走完。
 */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
function decodeEntities(text) {
  return String(text).replace(/&(#?\w+);/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : m);
}
const decoder = {
  innerHTML: '',
  textContent: '',
  get children() {
    const matched = /foo="([\s\S]*?)"/.exec(this.innerHTML);
    const raw = matched ? matched[1] : '';
    return [{ getAttribute: () => decodeEntities(raw) }];
  },
};
Object.defineProperty(decoder, 'innerHTML', {
  get() { return this._html || ''; },
  set(value) {
    this._html = String(value);
    this.textContent = decodeEntities(String(value).replace(/<[^>]*>/g, ''));
  },
});
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  navigator: {},
  location: { href: 'http://localhost/s/example' },
  document: { createElement: () => decoder },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
// 找不到就炸，不要静默放行：readFileSync 缺失文件会抛 ENOENT，但上面的
// `if (!fs.existsSync(file)) continue` 模式会让没找到的文件被"跳过"，
// 最终输出「0 页失败」的假绿灯。
const VUE_BUNDLE = 'assets/vendor/vue.global.prod.min.js';
if (!fs.existsSync(VUE_BUNDLE)) {
  console.error('❌ 找不到 ' + VUE_BUNDLE + ' —— 放弃检查（否则会给出假通过）');
  process.exit(1);
}
vm.runInContext(fs.readFileSync(VUE_BUNDLE, 'utf-8'), sandbox);

const Vue = sandbox.Vue;
if (!Vue || typeof Vue.compile !== 'function') {
  console.error('无法从 ' + VUE_BUNDLE + ' 取到 Vue.compile');
  process.exit(1);
}

let failed = 0;
let checked = 0;
for (const file of PAGES) {
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, 'utf-8');
  const tpl = appTemplate(src);
  if (tpl === null) {
    // 不是所有页面都用 #app 作为 Vue 根，跳过即可
    continue;
  }
  checked += 1;
  const warns = [];
  try {
    Vue.compile(tpl, {
      onError: (e) => { throw new Error((e && e.message) || String(e)); },
      onWarn: (w) => { warns.push(w && w.message ? w.message : String(w)); },
    });
    console.log('  [OK] ' + file + ' 模板编译通过（' + tpl.length + ' 字符）');
    for (const w of warns.slice(0, 5)) console.log('       warn: ' + w);
  } catch (e) {
    failed += 1;
    console.log('  [FAIL] ' + file + ' -> ' + (e && e.message ? e.message : String(e)));
  }
}

console.log('\n模板编译：' + checked + ' 页已校验，' + failed + ' 页失败');
process.exit(failed ? 1 : 0);
