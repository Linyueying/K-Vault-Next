/**
 * D1 执行结果的统一解读。
 *
 * @module d1-result
 *
 * ============================================================================
 * 为什么需要这个模块
 * ============================================================================
 *
 * Cloudflare D1 的 `stmt.run()` 返回形状是：
 *
 *     { success: true, meta: { changes: 1, last_row_id: 7, ... }, results: [...] }
 *
 * **受影响行数在 `res.meta.changes`**，顶层没有 `changes`。
 *
 * 但下面这种写法太顺手了：
 *
 *     const updated = Number(res?.changes) || 0;   // ← 恒为 0
 *
 * `res.changes` 永远是 `undefined`，`|| 0` 把 0 兜住，于是「更新成功」被
 * 判成「没有这一行」。调用方据此返回 `TOKEN_NOT_FOUND` / 404 —— 而数据
 * **其实已经改了**。这类「假报错 + 真生效」是最难排查的一种：
 * 用户看到失败去重试，重试又"失败"，但每次操作都真的落库了。
 *
 * 更隐蔽的是：测试替身如果顺手同时给出顶层 `changes` 和 `meta.changes`，
 * 这个 bug 在单测里完全看不出来 —— 替身比现实更宽容，等于没测。所以
 * 本模块既给生产代码用，也提醒测试替身**只**提供 `meta.changes`。
 *
 * 这里保留对顶层 `changes` 的兼容读取，纯粹是为了容忍旧形状/第三方替身，
 * 判定顺序仍是 meta 优先。
 */

/**
 * 从 D1 `run()` 结果中取出受影响行数。
 *
 * @param {{ meta?: { changes?: number }, changes?: number }|null|undefined} res
 * @returns {number} 受影响行数；无法判定时为 0
 */
export function changedCount(res) {
  if (!res) return 0;
  if (res.meta && typeof res.meta.changes === 'number') return res.meta.changes;
  if (typeof res.changes === 'number') return res.changes;
  return 0;
}
