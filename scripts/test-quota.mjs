import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { makeMigratedEnv } from './test-utils.mjs';
const db = makeMigratedEnv()._db;
const DB = { prepare(sql){ const st=db.prepare(sql); let b=[]; return { bind(...a){b=a;return this;}, async first(){const r=st.get(...b);return r===undefined?null:r;}, async all(){return {results:st.all(...b)};}, async run(){const i=st.run(...b);return {meta:{changes:i.changes}};} }; } };
function KV(){ const m=new Map(); return { async put(k,v,o){m.set(k,{value:v,metadata:o?.metadata});}, async get(k){const e=m.get(k);return e?e.value:null;}, async getWithMetadata(k){const e=m.get(k);return e?{value:e.value,metadata:e.metadata}:null;}, async delete(k){m.delete(k);} }; }
const { registerFileRecord, consumeDownloadQuota, refundQuota, readDownloadCount } = await import('/workspace/K-Vault-Next/functions/utils/file-record.js');
let pass=0,fail=0; const ck=(n,c)=>{c?(pass++,console.log('  ✅',n)):(fail++,console.log('  ❌',n));};

console.log('\n[1] 原子预占：限额 2，第 3 次必须被拒');
{
  const env={DB,img_url:KV()};
  await registerFileRecord(env,'r2:q.png',{fileName:'q.png',storageType:'r2',TimeStamp:1,shareMaxDownloads:2});
  const a=await consumeDownloadQuota(env,'r2:q.png');
  const b=await consumeDownloadQuota(env,'r2:q.png');
  const c=await consumeDownloadQuota(env,'r2:q.png');
  ck('第1次 ok', a.ok===true);
  ck('第2次 ok', b.ok===true);
  ck('第3次 limited', c.limited===true);
  ck('计数=2', (await readDownloadCount(env,'r2:q.png'))===2);
}

console.log('\n[2] 回滚：预占后响应失败应退回配额');
{
  const env={DB,img_url:KV()};
  await registerFileRecord(env,'r2:r.png',{fileName:'r.png',storageType:'r2',TimeStamp:1,shareMaxDownloads:5});
  await consumeDownloadQuota(env,'r2:r.png');   // 预占 → 1
  let n=await readDownloadCount(env,'r2:r.png');
  ck('预占后=1', n===1);
  await refundQuota(env,'r2:r.png');            // 回滚 → 0
  n=await readDownloadCount(env,'r2:r.png');
  ck('回滚后=0', n===0);
}

console.log('\n[3] 回滚下限：计数 0 时回滚不得变负');
{
  const env={DB,img_url:KV()};
  await registerFileRecord(env,'r2:z.png',{fileName:'z.png',storageType:'r2',TimeStamp:1,shareMaxDownloads:5});
  await refundQuota(env,'r2:z.png');
  await refundQuota(env,'r2:z.png');
  ck('计数不低于 0', (await readDownloadCount(env,'r2:z.png'))===0);
}

console.log('\n[4] 不限次（max=0）：预占应始终成功');
{
  const env={DB,img_url:KV()};
  await registerFileRecord(env,'r2:u.png',{fileName:'u.png',storageType:'r2',TimeStamp:1});
  for(let i=0;i<5;i++){ const r=await consumeDownloadQuota(env,'r2:u.png'); if(!r.ok){ck('第'+(i+1)+'次失败',false);break;} }
  ck('5 次全部成功', (await readDownloadCount(env,'r2:u.png'))===5);
}

console.log('\n[5] D1 未绑定：回落 disabled，调用方走 KV');
{
  const env={img_url:KV()};
  const r=await consumeDownloadQuota(env,'r2:n.png');
  ck('disabled=true', r.disabled===true);
  const rf=await refundQuota(env,'r2:n.png');
  ck('回滚安全 no-op', rf.ok===false);
}

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail?1:0);
