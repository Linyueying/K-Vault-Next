# 上传 / 下载链路优化（正确性、内存、配额、延迟）

> 本篇记录一次针对后端上传下载链路的系统性改造：
> **改了什么、为什么这么改、上线要注意什么**。
> 想了解整体架构请看 [`architecture.md`](./architecture.md)。

> **没有开关**：本页涉及的四项延迟优化（Telegram 路径缓存、记录定位缓存、
> 公开文件字节缓存、上传后预热）**恒定开启**，不读环境变量、不读 KV，
> 后台也没有对应的设置面板。它们的共同特征是「关掉只会变慢，不会更正确」，
> 而每一项都处在下载请求的必经之路上 —— 做成可配置就得在热路径上多读一次
> 配置、多写一层「配置读失败该降级成什么」的兜底，换来的只是一个没人需要
> 的选项。需要临时停用时改 `functions/utils/` 下的常量重新部署。
> 与它们相关的*一致性*由写路径主动失效保证（见§六点五），不靠用户配置。

改造围绕四条不变量展开，优先级为 **正确性 > 内存安全 > 配额与成本 > 延迟**：

1. 内存应当随**分片大小**增长，而不是随**文件大小**增长。
2. 对象存储与元数据库无法天然同事务，因此上传必须**可重入、可恢复**。
3. 「检查配额」和「消耗配额」必须是**同一个原子操作**；没有成功交付字节，不应扣次数。
4. 无效请求的成本必须接近 **O(1)**；缓存应保存**定位信息**，而不是重复搬运字节。

---

## 一、R2 分片 `complete` 变成可重入状态机

**问题**：`functions/api/chunked-upload/complete.js` 原本是线性流程
`mp.complete() → head 校验 → 写元数据 → 删任务`。
只要中间任何一步失败，客户端重发 `complete` 就会再调一次 `mp.complete()` ——
而 `uploadId` 已失效，必然抛错并触发 `abort`，用户被迫全量重传。

**现在**：相位持久化在任务 KV 上（与任务同 TTL 90 分钟）。

```text
uploading → object_ready → （写元数据）→ done
```

| 相位 | 重入行为 |
| :--- | :--- |
| `uploading` | 正常校验 parts → `mp.complete()` |
| `object_ready` | **跳过** `mp.complete()`，直接 head 校验 → 写元数据 |
| 任务已删除 | 查 `upload-done:<uploadId>`（10 分钟），命中则**重放同一响应** |

配套的三处判断：

- **`mp.complete()` 抛错不再无条件 abort。**
  「结果未知」≠「确实失败」：先 `head()` 目标对象 ——
  · 存在且大小相符 → 视为已合并，落 `object_ready` 继续；
  · `head` 自身失败（瞬时错误）→ **不 abort**，保留任务返回 `503 R2_COMPLETE_RETRY`；
  · 确认不存在 → 才 abort 清理。
- **`object_ready` 相位下元数据写入失败不再回滚删除对象。**
  对象与任务都保留，重试从「写元数据」续跑；删掉对象反而让重试永远失败。
- **成功响应写入 10 分钟快照**（`upload-done:<uploadId>`）。
  网络抖动导致客户端没收到响应而重发时，重放同一结果，而不是「任务不存在」。

---

## 二、分片上传：先验任务，再读字节

**问题**：`chunk.js` 无条件 `request.formData()`，无效任务（不存在 / 无权 / 越界 /
大小不符）也要先付出一次完整的 multipart 解析 —— 对 50MB 分片就是一份白白占用的 isolate 内存。

**现在**：

- 协议：`POST /api/chunked-upload/chunk?uploadId=<id>&chunkIndex=<n>`，
  body 直接是分片字节（`Content-Type: application/octet-stream`）。
- 服务端顺序：**鉴权 → 读任务 → 校验归属/范围/精确大小 → 才读 body**。
- 旧客户端（FormData 携带坐标）仍走兼容路径，校验强度不降低。

**大小校验从「估算」改为「精确」**（`computeExpectedChunkSize()`）：

```js
非末片 = chunkSize
末片   = fileSize - chunkSize × (totalChunks - 1)
```

旧的「平均分片大小 × 2」软上限允许约 2 倍偏差通过，错位分片要到 complete 才暴露。
旧任务没有 `chunkSize` 字段时回落启发式（只放宽、不误拒）；
任务数据自相矛盾（末片被算成 ≤ 0）时返回 `null` 报错，绝不猜成 0 字节。

**省掉一次拷贝**：multipart 路径是「运行时缓冲 → formData File → arrayBuffer()」两份拷贝，
原始 body 路径只有一份。

---

## 三、直传上限收口 + 早期门禁

**问题**：`upload.js` 在**解析完整 multipart 之后**才校验大小，却允许
R2 / S3 / WebDAV / GitHub 直传 **100MB**；随后各分支又执行 `file.arrayBuffer()`。
100MB 文件会以 multipart File、ArrayBuffer、后端请求体多种形态同时驻留，逼近 128MB isolate 上限。
前端上限是 40MB、分片路径也是 40MB，绕过前端直接打接口就能踩到这个坑。

**现在**：

- 三者统一收口到 `MAX_IN_MEMORY_ASSEMBLY`（40MB），走分片通道可到 10GB。
- **Content-Length 早期门禁**：超过「上限 + 1MB 表单余量」的请求在解析 body **之前**返回 413。
- R2 直传不再 `arrayBuffer()`，Blob 直接交给 `R2_BUCKET.put()`（少一份整文件拷贝）。

---

## 四、下载配额：只有交付了字节才计数

**问题**：`shouldCountAsDownload()` 原本只排除 401/403/404/410，
于是上游 5xx、416 这类**一个字节都没交付**的响应也消耗配额，
客户端自动重试会把用户的下载次数刷光。

**现在**：只有 `200` / `206` 计次。配合既有的 D1 原子预占，
失败响应的预占会在 `waitUntil` 里退还（`refundCheckout`）。

「反复制造失败来绕过配额」不成立 —— 绕过配额的前提是拿到字节，
而拿到字节的那一次必然是 200/206，必然计数。

### 合集配额改为原子预占

旧实现是「读 bundle 判断是否超限 → 放行 → 事后 +1」，两步分离，
并发请求可以同时通过「未超限」判断而超发。

现在由 `consumeBundleDownloadQuota()` 用**一条 UPDATE** 完成：

```sql
UPDATE bundles
SET download_count = download_count + 1
WHERE slug = ? AND (max_downloads = 0 OR download_count < max_downloads)
```

- `limited` → 410；`ok` → 标记已计次，外层不再重复 +1，失败时退还。
- `disabled`（D1 未绑定）/ `error` → 回落到旧的读-判断，并**明确告警**；
  error 不会被伪装成 limited（存储故障 ≠ 配额用完）。
- 密码校验排在配额之前：密码不对不消耗任何配额。

---

## 五、无效请求的扇出与延迟

| 优化 | 说明 |
| :--- | :--- |
| 未命中负缓存 | 裸 ID 全候选键未命中时，在 **isolate 内存**记 15 秒（上限 256 条）。不写 KV：KV 写入额度远比读取稀缺，把负路径写进 KV 等于把放大攻击转移到写入侧 |
| 索引失效联动 | `putRecordIndex()` 写入时立即清除该 ID 的负缓存，避免刚上传的文件被 15 秒窗口钉成 404 |
| Telegram `file_path` 缓存 | isolate 内缓存 10 分钟 + **single-flight**：同一 fileId 的并发请求只打一次 Bot API。它只是指针，不含权限信息，缓存它不绕过任何闸门 |
| 统一 HEAD | S3 走 `HeadObject`、WebDAV 走 `HEAD`、Discord / HuggingFace 直发 `HEAD`。此前 HEAD 也是照着 GET 跑一遍、再把 body 丢掉 —— 字节已经跨网络走了一趟 |
| 缓存安全性判定 | 只有「公开 + 无密码 + 无有效期 + 无配额 + 非合集 + 非签名链」的文件允许进边缘缓存，判定集中在 `markPublicCacheable` |

### 只剩一层缓存：字节缓存

早期还有一层「给响应加 `Cache-Control: public, max-age=300`」的响应头缓存
（`PUBLIC_DOWNLOAD_CACHE`）。它已被移除：

- 收益与字节缓存高度重叠 —— 字节缓存命中时本来就带着 `Cache-Control`，
  未命中时加 5 分钟浏览器缓存省不了多少请求；
- 却额外引入**第二个残留窗口**，而这个窗口没有对应的清理路径
  （`purgeByteCache` 清的是字节缓存键，不是浏览器本地副本）。

现在「能不能缓存」只在 `markPublicCacheable()` 里判一次，判定结论
（`context.__kvPublicCacheable`）同时被存取两侧读取，不存在两处漂移。

### 缓存写入绝不能碰客户端那条流

写入侧**不用** `response.clone()`。`clone()` 内部是 `tee()`，两条分支共享
同一条管道：`cache.put()` 一旦失败（Cache API 拒绝、体积超限、isolate 被
回收），它会 cancel 自己那一支，而 tee 的 cancel 会传导到客户端正在读的
那一支 —— 下载当场断开。`catch` 救不了，因为断的是流，不是 Promise。

正确做法是在客户端那条流上截获（`pipeThrough` 一个累积型 `TransformStream`）：
客户端是唯一消费者，缓存只是旁路，写失败最多是没命中，不可能再影响下载。
累积到 64MB 就丢弃，绝不无界缓冲。

同源问题还有**旧缓存条目**：Cache API 不会因代码更新而失效。键里带一个版本段
（`BYTE_CACHE_VERSION`），改动写入逻辑时加一版，旧条目自然过期 —— 否则
「代码修好了，用户下载还是坏的，直到 TTL 到期」。

---

## 六、API v1 幂等改为强原子

`functions/utils/idempotency.js` + `api_idempotency` 表（迁移 `0014`）：

- 主键 `(token_id, idem_key)` 做原子 `INSERT ... ON CONFLICT DO NOTHING` 预占，
  并发同 key 只有一个请求能拿到 `acquired`。
- `processing / completed` 双状态；`completed` 重放 24 小时内保存的**精确响应**，
  并带 `Idempotency-Replayed: true`。
- 相同 key 不同 `request_hash` → 冲突；`request_hash` 由文件元信息与全部上传选项计算，
  **不再为算哈希而读完整文件**。
- `updated_at` 兼任租约：超过 15 分钟未推进的 `processing` 可被条件接管，
  接管后旧持有者无法再 `complete`/`release`。
- D1 未绑定或故障时回落 KV（best effort），键名改用 SHA-256，不再用 32 位 FNV。

---

## 六点五、没有开关，只有写路径失效

四项优化不读配置：Telegram 路径持久化恒开、记录缓存两级恒开、
字节缓存恒开（TTL 3600s / 单文件 64MB 为常量）、上传后预热恒开
（超过单文件上限自动跳过）。`config:perf` 这个 KV 键已经不存在，
`CONFIG_GROUPS` 里也没有 `perf` —— 后台不会再下发、也不会再接受这一组。

**为什么不留开关**：这四项每一项都在下载请求的必经之路上。做成可配置意味着
每个请求多一次配置读取、以及一套「配置读失败该降级成什么」的兜底逻辑，
而换来的只是一个「关掉会变慢」的选项。固定值让判定退化成常量比较，
没有 IO、没有失败分支。

代价是**一致性必须由写路径保证** —— 见下一节。这也是不做开关的真正前提：
如果失效逻辑有缺口，开关就是唯一的补救手段；缺口补上了，开关自然多余。

### 缓存必须跟着写操作失效

字节缓存命中时**不查任何元数据**（那正是它能把 TTFB 压到几十毫秒的原因），
所以「文件状态变了」这件事无法在读取侧补救，只能在写入侧主动清：

| 写操作 | 为什么必须清 | 位置 |
| :--- | :--- | :--- |
| 删除文件 | 否则「后台已删除、链接还能完整下载」，最长持续一个 TTL | `api/manage/delete/[id].js` → `purgeEdgeCache` |
| 改名 | 缓存的是整个响应，含 `Content-Disposition` 里的旧文件名 | `api/manage/editName/[id].js` |
| 加密码 / 设有效期 / 设次数上限 | 缓存命中会绕过这些闸门，密码形同虚设 | `api/manage/share/[id].js`、`api/v1/file/[[path]]/share.js` |

`purgeByteCache()` 会展开一个 ID 的所有等价写法（`c.png` ↔ `r2:c.png` ↔ 各存储前缀），
因为缓存键取自 URL 路径、可能是裸 ID 也可能是带前缀的 kvKey。
清理失败只记日志：残留副本仍会随 TTL 自然过期，不该让删除本身失败。

**记录缓存（`reccache:*`）的失效更保守**：只在「本 isolate 确实读过这条记录」
时才清 KV 副本。无条件展开删除会让上传路径每次付 ~12 次 KV 写
（免费额度 1000 写/天，几天就烧完），而那会拖垮真正必须成功的元数据写入。
漏删的代价有上界 —— 跨 isolate 的副本最多存活 60 秒，且只影响文件名这类
展示字段；删除时字节缓存与上游对象都已先一步清掉。

---

## 七、上线注意

1. **D1 迁移 `0014_api_idempotency.sql`**：由 `schema.js` 的懒迁移自动建表，
   无需手工执行；`.sql` 文件由 `npm run d1:migrations` 从 `schema.js` 生成，不要手改。
2. **前后端需同版本部署**：分片协议改为「查询参数 + 原始 body」后，
   新前端依赖服务端支持该形态。服务端保留 FormData 兼容路径，
   旧前端也能正常工作，反之（新服务端 + 旧前端）同样安全。
3. **直传上限从 100MB 降到 40MB**：依赖直传大文件的脚本需改用分片上传
   （`scripts/kvault-upload.mjs` 与网页端均支持）。
4. **合集配额语义变严**：此前并发会超发，现在严格不超；纯 KV 部署仍是**近似**限制，
   需要硬保证请绑定 D1。

---

## 八、尚未做的架构升级

按投入产出排序，均不改变现有外部契约：

1. **S3 原生 multipart**：当前 S3 客户端需计算完整 payload SHA-256，
   不能直接流式化；应改用原生 multipart 或支持流式签名的实现。
2. **R2 直传流式化**：目前仍是「请求体 → R2」的单次 put，
   进一步可让 `request.body` 直通 `put()`（需先确认 R2 对未知长度流的支持边界）。
3. **分片状态迁到 D1**：`part-state:*` 现在是每片一个 KV key，
   恢复时要先 list 再逐键 get；迁移到 `upload_parts` 表后可一次查询取全，
   并承载任务状态与幂等提交。
4. **公共文件预签名直链**：仅对「公共 + 无配额」的 S3 文件可评估 302 到预签名 URL，
   彻底省掉 Worker 中转；受保护文件继续代理。
