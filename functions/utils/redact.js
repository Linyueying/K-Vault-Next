/**
 * Secret redaction helpers (requirement #13).
 * Ensures full API Token secrets never leak into logs, error messages,
 * audit records or console output.
 *
 * ## 为什么必须锚定两个下划线（而不是 `kvault_` 后就任意匹配）
 *
 * Token 的形状是 `kvault_<tokenId>_<secret>`，其中 tokenId 与 secret 各自
 * 都**不含下划线**（见 api-token.js：tokenId 是 [A-Za-z0-9_-]{6,128}，
 * secret 由 randomString 生成，字符集里没有下划线）。
 *
 * 早先的写法是 `/kvault_[A-Za-z0-9_-]{6,}/`，它会把任何以 `kvault_` 开头的
 * 标识符都吞掉 —— 包括 **MCP 工具名**（`kvault_upload_file` 等）。后果是
 * 错误信息变成 `kvault_***REDACTED***`，模型读不懂是哪个工具出了问题，
 * 反而降低了可诊断性。
 *
 * 锚定 `_[secret]` 之后：真 Token 仍然被完整脱敏，工具名与其它以 kvault_
 * 开头的普通标识符保持原样。
 */
const TOKEN_PATTERN = /kvault_[A-Za-z0-9-]+_[A-Za-z0-9_-]{16,}/g;
const REDACTED = 'kvault_***REDACTED***';

export function redactSecrets(input) {
  if (typeof input !== 'string') return input;
  return input.replace(TOKEN_PATTERN, REDACTED);
}

