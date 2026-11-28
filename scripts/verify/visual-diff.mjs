// 视觉回归比对 —— 配合 visual-snapshot.mjs 使用
//
// 用法：node scripts/verify/visual-diff.mjs before.json after.json
// 退出码：0 = 完全一致，1 = 有差异（并逐属性打印）
import fs from 'node:fs';

const [before, after] = process.argv.slice(2);
if (!before || !after) {
  console.error('用法：node scripts/verify/visual-diff.mjs <before.json> <after.json>');
  process.exit(2);
}

const A = JSON.parse(fs.readFileSync(before, 'utf8'));
const B = JSON.parse(fs.readFileSync(after, 'utf8'));

if (JSON.stringify(A.props) !== JSON.stringify(B.props)) {
  console.error('警告：两次快照用的属性列表不同，比对结果不可信。');
}

const props = A.props;
const keys = [...new Set([...Object.keys(A.data), ...Object.keys(B.data)])].sort();

const diffs = [];
const disappear = [];
for (const k of keys) {
  const a = A.data[k], b = B.data[k];
  if (a === undefined) { disappear.push([k, '新增', b]); continue; }
  if (b === undefined) { disappear.push([k, '消失', a]); continue; }
  if (a === b) continue;
  if (a === null || b === null) { diffs.push([k, [['(元素缺失)', a, b]]]); continue; }
  const av = a.split('|'), bv = b.split('|');
  const changed = [];
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    if (av[i] !== bv[i]) changed.push([props[i] || `#${i}`, av[i], bv[i]]);
  }
  if (changed.length) diffs.push([k, changed]);
}

console.log(`比对项：${keys.length}`);
console.log(`不一致：${diffs.length}`);
if (disappear.length) {
  console.log(`\n条目增减（${disappear.length}）：`);
  for (const [k, kind, v] of disappear) console.log(`  [${kind}] ${k}`);
}
if (diffs.length) {
  console.log('\n差异明细（key 格式：视口|页面|选择器）：');
  for (const [k, changed] of diffs) {
    console.log(`  [${k}]`);
    for (const [pr, x, y] of changed) {
      console.log(`      ${pr}: ${JSON.stringify(x)} -> ${JSON.stringify(y)}`);
    }
  }
  console.log('\n有差异 —— 若这次改动本应「纯删死代码」，请逐条确认是否预期。');
  process.exit(1);
} else {
  console.log('\n✓ 计算样式完全一致（重构未改变渲染结果）');
}
