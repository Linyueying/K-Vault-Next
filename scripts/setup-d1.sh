#!/usr/bin/env bash
#
# 一键创建 D1 数据库并写入 wrangler.toml。
#
# 这是整个 D1 迁移里**唯一**需要手动做的事——Cloudflare 没有「部署时建库」
# 的 API，数据库实例本身必须由 CLI 创建。建表不用你管，运行时自动完成。
#
# 用法：
#   bash scripts/setup-d1.sh                 # 创建默认名 k_vault 并写入配置
#   bash scripts/setup-d1.sh --name mydb     # 指定数据库名
#   bash scripts/setup-d1.sh --id <uuid>     # 库已存在，只把 id 写进配置
#   bash scripts/setup-d1.sh --apply         # 顺带执行 migrations/*.sql（可选兜底）
#   bash scripts/setup-d1.sh --dry-run       # 只打印将执行的操作
#
set -euo pipefail

DB_NAME="k_vault"
DB_ID=""
APPLY=0
DRY_RUN=0
TOML="wrangler.toml"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)   DB_NAME="${2:?--name 需要一个值}"; shift 2 ;;
    --id)     DB_ID="${2:?--id 需要一个值}"; shift 2 ;;
    --apply)  APPLY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '3,13p' "$0"; exit 0 ;;
    *) echo "未知参数: $1（用 --help 查看用法）" >&2; exit 1 ;;
  esac
done

info() { printf '\033[36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

[[ -f "$TOML" ]] || die "找不到 $TOML —— 请在项目根目录运行本脚本"

# 优先用本地装的 wrangler，否则走 npx
if [[ -x "./node_modules/.bin/wrangler" ]]; then
  WRANGLER="./node_modules/.bin/wrangler"
else
  WRANGLER="npx --yes wrangler"
fi

# ---------------------------------------------------------------------------
# 从 wrangler 输出里提取 database_id（兼容 --json 与人类可读两种格式）
# ---------------------------------------------------------------------------
extract_id() {
  node -e '
    const raw = process.argv[1] || "";
    let id = "";
    try {
      const parsed = JSON.parse(raw);
      const list = parsed.d1_databases || parsed.result?.d1_databases ||
                   (Array.isArray(parsed) ? parsed : []);
      id = (list[0] || {}).database_id || parsed.uuid || parsed.id || "";
    } catch (_) {
      const patterns = [
        /database_id\s*=\s*"([^"]+)"/,
        /"database_id"\s*:\s*"([^"]+)"/,
        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
      ];
      for (const re of patterns) {
        const m = re.exec(raw);
        if (m) { id = m[1]; break; }
      }
    }
    process.stdout.write(id);
  ' "$1"
}

UUID_RE='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

# ---------------------------------------------------------------------------
# 1. 拿到 database_id
# ---------------------------------------------------------------------------
if [[ -n "$DB_ID" ]]; then
  [[ "$DB_ID" =~ $UUID_RE ]] || die "--id 不像一个 database_id（应为 UUID 格式）: $DB_ID"
  ok "使用传入的 database_id: $DB_ID"
elif [[ "$DRY_RUN" -eq 1 ]]; then
  warn "dry-run：跳过创建，database_id 保持占位符"
else
  info "检查 wrangler 与登录状态…"
  $WRANGLER --version >/dev/null 2>&1 || die "wrangler 不可用，先执行 npm i 或 npm i -D wrangler"

  if ! $WRANGLER whoami >/dev/null 2>&1; then
    warn "尚未登录 Cloudflare，准备唤起登录…"
    $WRANGLER login || die "登录失败"
  fi
  ok "wrangler 就绪"

  info "创建 D1 数据库：$DB_NAME"
  set +e
  CREATE_OUT="$($WRANGLER d1 create "$DB_NAME" --json 2>&1)"
  CREATE_RC=$?
  set -e

  if [[ "$CREATE_RC" -ne 0 ]]; then
    # 多数情况是库已存在 —— 退而从列表里找同名库的 id
    if printf '%s' "$CREATE_OUT" | grep -qi 'already exists\|already been created'; then
      warn "数据库 $DB_NAME 已存在，改从清单里取 id…"
      LIST_OUT="$($WRANGLER d1 list --json 2>&1)"
      DB_ID="$(node -e '
        const raw = process.argv[1];
        try {
          const parsed = JSON.parse(raw);
          const list = Array.isArray(parsed) ? parsed : (parsed.d1_databases || []);
          const hit = list.find((d) => d.name === process.argv[2]);
          process.stdout.write((hit || {}).database_id || "");
        } catch (_) { process.stdout.write(""); }
      ' "$LIST_OUT" "$DB_NAME")"
      [[ -n "$DB_ID" ]] || die "库已存在但拿不到 database_id，请到控制台复制后改用 --id 传入"
      ok "复用已有数据库：$DB_ID"
    else
      printf '%s\n' "$CREATE_OUT" >&2
      die "创建 D1 数据库失败（见上方 wrangler 输出）"
    fi
  else
    DB_ID="$(extract_id "$CREATE_OUT")"
    [[ -n "$DB_ID" ]] || die "创建成功但解析不出 database_id，原始输出：\n$CREATE_OUT"
    ok "已创建：$DB_ID"
  fi
fi

# ---------------------------------------------------------------------------
# 2. 写入 wrangler.toml
# ---------------------------------------------------------------------------
if [[ -n "$DB_ID" ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "dry-run：将把 $TOML 的 database_id 改为 $DB_ID"
  else
    # 只替换 database_id 那一行（本文件里只有一处）
    node -e '
      const fs = require("fs");
      const file = process.argv[1];
      const id = process.argv[2];
      const src = fs.readFileSync(file, "utf8");
      const out = src.replace(/^database_id\s*=\s*".*"\s*$/m, `database_id = "${id}"`);
      if (out === src) { console.error("没有找到可替换的 database_id 行"); process.exit(1); }
      fs.writeFileSync(file, out);
    ' "$TOML" "$DB_ID" || die "写入 $TOML 失败"
    ok "已写入 $TOML"
  fi
fi

# ---------------------------------------------------------------------------
# 3. 可选：立即执行 migrations（运行时会自动做，这里只是兜底 / 提前验证）
# ---------------------------------------------------------------------------
if [[ "$APPLY" -eq 1 ]]; then
  [[ -n "$DB_ID" ]] || die "--apply 需要 database_id（先别用 --dry-run）"
  for sql in migrations/*.sql; do
    [[ -f "$sql" ]] || continue
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "dry-run：将执行 $sql"
    else
      info "执行 $sql"
      $WRANGLER d1 execute "$DB_NAME" --remote --file="$sql" \
        || die "执行 $sql 失败"
    fi
  done
  ok "迁移执行完毕"
fi

# ---------------------------------------------------------------------------
# 收尾提示
# ---------------------------------------------------------------------------
cat <<EOF

────────────────────────────────────────────
接下来：

  1. 在 Cloudflare Pages 后台绑定 D1：
       Settings → Functions → D1 database bindings
       变量名必须是 \`DB\`，数据库选 $DB_NAME
     （wrangler.toml 只用于 CLI，Pages 的 binding 仍要在后台配）

  2. 保持 KV \`img_url\` 绑定不动 —— 未命中 D1 时会回落 KV，双保险

  3. 部署后访问自检端点确认：
       https://<你的域名>/api/admin/db-status
     看到 \`"verdict": "D1 已就绪，表与迁移均完整。"\` 就成了
     若显示迁移缺失，加 ?apply=1 再访问一次即可立即建表

  建表是运行时自动完成的，本脚本的 --apply 只是提前验证用的可选项。
────────────────────────────────────────────
EOF
