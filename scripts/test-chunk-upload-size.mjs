/**
 * 分片上传大小校验回归测试。
 *
 * 覆盖：
 *   [A] 精确契约：非末片 = chunkSize
 *   [B] 精确契约：末片 = fileSize - chunkSize × (totalChunks - 1)
 *   [C] 无法整除 / 恰好整除的边界
 *   [D] 旧任务（无 chunkSize）回落 null，交由启发式兜底
 *   [E] 非法下标 / 非法任务数据返回 null（不误判为 0）
 *
 * 运行：node scripts/test-chunk-upload-size.mjs
 */

import { computeExpectedChunkSize } from '../functions/api/chunked-upload/chunk.js';

let pass = 0;
let fail = 0;

function check(label, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  ✅ ${label}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const MB = 1024 * 1024;

console.log('[A] 非末片恒等于 chunkSize');
{
  const task = { chunkSize: 20 * MB, fileSize: 100 * MB };
  check('第 0 片 = 20MB', computeExpectedChunkSize(task, 0, 5, 100 * MB) === 20 * MB);
  check('第 3 片 = 20MB', computeExpectedChunkSize(task, 3, 5, 100 * MB) === 20 * MB);
}

console.log('[B] 末片取剩余字节');
{
  const task = { chunkSize: 20 * MB, fileSize: 103 * MB };
  // 103MB = 20×5 + 3MB → 6 片，末片 3MB
  check('末片 = 3MB', computeExpectedChunkSize(task, 5, 6, 103 * MB) === 3 * MB);
  check('倒数第二片 = 20MB', computeExpectedChunkSize(task, 4, 6, 103 * MB) === 20 * MB);
}

console.log('[C] 整除与单分片边界');
{
  const exact = { chunkSize: 20 * MB, fileSize: 100 * MB };
  // 恰好整除时 totalChunks = 5，最后一（第 4）片仍是 20MB 而非 0
  check('整除时末片 = 20MB', computeExpectedChunkSize(exact, 4, 5, 100 * MB) === 20 * MB);

  const single = { chunkSize: 50 * MB, fileSize: 7 * MB };
  check('单分片 = 文件全大小', computeExpectedChunkSize(single, 0, 1, 7 * MB) === 7 * MB);

  // 末片被算成 <= 0 说明任务数据自相矛盾（totalChunks 多算了一片），
  // 必须返回 null 让调用方报错，而不是返回一个 0 字节的期望值。
  const broken = { chunkSize: 20 * MB, fileSize: 100 * MB };
  check('矛盾任务返回 null', computeExpectedChunkSize(broken, 5, 5, 100 * MB) === null);
}

console.log('[D] 旧任务回落启发式');
{
  const legacy = { fileSize: 100 * MB };
  check('缺少 chunkSize → null', computeExpectedChunkSize(legacy, 0, 5, 100 * MB) === null);
  const invalid = { chunkSize: 0, fileSize: 100 * MB };
  check('chunkSize 非法 → null', computeExpectedChunkSize(invalid, 0, 5, 100 * MB) === null);
}

console.log('[E] 越界与缺失参数');
{
  const task = { chunkSize: 20 * MB, fileSize: 100 * MB };
  check('下标越界 → null', computeExpectedChunkSize(task, 9, 5, 100 * MB) === null);
  check('负数下标 → null', computeExpectedChunkSize(task, -1, 5, 100 * MB) === null);
  check('空任务 → null', computeExpectedChunkSize(null, 0, 5, 100 * MB) === null);
}

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
if (fail > 0) process.exit(1);
