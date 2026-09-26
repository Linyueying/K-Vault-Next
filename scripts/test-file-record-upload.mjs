// 验证：上传点保持原样调用 putRecordIndex(env, kvKey)，D1 应自动被写入
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { makeMigratedEnv } from './test-utils.mjs';
const db = makeMigratedEnv()._db;
const DB = { prepare(sql){ const st=db.prepare(sql); let b=[]; return { bind(...a){b=a;return this;}, async first(){const r=st.get(...b);return r===undefined?null:r;}, async all(){return {results:st.all(...b)};}, async run(){const i=st.run(...b);return {meta:{changes:i.changes}};} }; } };
function KV(){ const m=new Map(); return { async put(k,v,o){m.set(k,{value:v,metadata:o?.metadata});}, async get(k){const e=m.get(k);return e?e.value:null;}, async getWithMetadata(k){const e=m.get(k);return e?{value:e.value,metadata:e.metadata}:null;}, async delete(k){m.delete(k);} }; }

const { putRecordIndex, getRecordWithKey } = await import('/workspace/K-Vault-Next/functions/utils/file-record.js');

let pass=0,fail=0; const ck=(n,c)=>{ c?(pass++,console.log('  ✅',n)):(fail++,console.log('  ❌',n)); };

console.log('\n[A] 模拟真实上传点：先写 KV 元数据，再调 putRecordIndex(env, kvKey)');
{
  const kv = KV();
  await kv.put('r2:up1.png','',{metadata:{TimeStamp:1,fileName:'up1.png',fileSize:10,storageType:'r2',r2Key:'up1.png',ListType:'None',Label:'None',liked:false}});
  const env = { DB, img_url: kv };
  await putRecordIndex(env, 'r2:up1.png');      // ← 上传点原样的调用
  const r = await getRecordWithKey(env, 'r2:up1.png');
  ck('D1 自动登记成功', r.record?.metadata?.fileName === 'up1.png');
  ck('r2Key 保留', r.record?.metadata?.r2Key === 'up1.png');
}

console.log('\n[B] D1 未绑定：putRecordIndex 应安全 no-op');
{
  const kv = KV();
  await kv.put('r2:x.png','',{metadata:{fileName:'x.png',storageType:'r2'}});
  const env = { img_url: kv };                  // 无 DB
  await putRecordIndex(env, 'r2:x.png');
  ck('不抛错', true);
  const r = await getRecordWithKey(env, 'r2:x.png');
  ck('KV 读取仍正常', r.record?.metadata?.fileName === 'x.png');
}

console.log('\n[C] KV 无元数据时：静默跳过，不抛错');
{
  const env = { DB, img_url: KV() };
  await putRecordIndex(env, 'r2:missing.png');
  ck('不抛错且未写入', true);
}

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail?1:0);
