# ⚠️⚠️⚠️ 一次性改造工具，已对 mobile-refactor.css 执行过，绝不可重跑。
# 重跑会再次改写 mobile-refactor.css（该文件已是清理后的最终 433 行状态），
# 把已交付的结果改坏。如需再清理 CSS，请用上一级的 dead-selectors.mjs 先判死。

"""从 mobile-refactor.css 剪除死选择器令牌 —— 基于真正的 CSS 词法扫描。

与上一版的关键区别：
  这里不再「按行猜选择器」，而是先把整个文件切成 token 流
  （选择器 / '{' / 声明体 / '}'），无论选择器跨几行都能正确识别。
  只有处于「选择器位置」的 token 才会被剪枝；声明体与 @media 条件
  一律原样保留，因此不可能误伤活代码。
"""
import re

PATH = '/workspace/K-Vault-Next/mobile-refactor.css'
src = open(PATH, encoding='utf-8').read()

DEAD_CLASSES = {
    'header-content', 'home-btn', 'nav-links', 'status-panel',
    'stats-text', 'stats-loaded',
    'el-dropdown', 'el-select-dropdown', 'el-card', 'el-dialog',
    'el-message-box', 'el-input__inner', 'el-dropdown-menu', 'el-dropdown-link',
    'header-theme-toggle', 'header-title', 'header-actions',
    'theme-toggle-btn', 'theme-admin-toggle', 'theme-auto-inline-toggle',
}

def token_is_dead(tok):
    tok = tok.strip()
    if not tok:
        return True
    classes = re.findall(r'\.([A-Za-z0-9_-]+)', tok)
    if not classes:
        return False          # body / :root / * 等，保留
    return any(c in DEAD_CLASSES for c in classes)

# ---- 扫描：找出每一段「选择器区间」的字符范围 (start, end) ----
# 选择器区间 = 从上一个规则结束之后，到某个 '{' 之前的非空非注释内容
# 但要排除 at-rule（@media ... { ），at-rule 的前导不是选择器
sel_ranges = []
depth = 0
i = 0
n = len(src)
seg_start = 0           # 当前累积段的起点
at_block_start = None   # 最近一次 '@' 出现位置

in_comment = False
in_string = None

while i < n:
    ch = src[i]

    if in_comment:
        if src.startswith('*/', i):
            in_comment = False
            i += 2
            continue
        i += 1
        continue

    if ch == '/' and i + 1 < n and src[i+1] == '*':
        in_comment = True
        i += 2
        continue

    if ch == '{':
        # 这一段 src[seg_start:i] 就是「选择器或 at-rule 条件」
        prelude = src[seg_start:i]
        is_at = prelude.lstrip().startswith('@')
        if not is_at and depth >= 0:
            # @media/@supports 内部的选择器也要处理；depth 表示当前已在几层 at-rule 里
            sel_ranges.append((seg_start, i, depth))
        depth += 1
        seg_start = i + 1
        i += 1
        continue

    if ch == '}':
        depth -= 1
        seg_start = i + 1
        i += 1
        continue

    if ch == ';' and depth == 0:
        seg_start = i + 1
        i += 1
        continue

    i += 1

# ---- 反向替换，避免下标漂移 ----
removed_tokens = 0
removed_whole = 0
result = src

for start, end, d in sorted(sel_ranges, key=lambda r: -r[0]):
    raw = src[start:end]
    # 保留前后空白
    lead = re.match(r'^(\s*)', raw).group(1)
    trail = re.search(r'(\s*)$', raw).group(1)
    core = raw.strip()
    if not core:
        continue

    tokens = core.split(',')
    live, dead = [], []
    for t in tokens:
        (dead if token_is_dead(t) else live).append(t)

    if not dead:
        continue

    if not live:
        # 整条规则删除：从 start 一路删到匹配的 '}'（含）
        j = end
        dd = 0
        while j < n:
            if src[j] == '{':
                dd += 1
            elif src[j] == '}':
                dd -= 1
                if dd == 0:
                    j += 1
                    break
            j += 1
        # 连同其后紧邻的换行一起删除
        while j < n and src[j] == '\n' and src[j-1] == '\n':
            break
        result = result[:start] + result[j:]
        removed_whole += 1
        continue

    # 部分死：重建选择器，保持缩进风格
    kept = [re.sub(r'\s+', ' ', t).strip() for t in live]
    kept = [k for k in kept if k]
    if len(kept) == 1:
        new_core = kept[0]
    else:
        new_core = (',\n' + lead).join(kept)
    new_raw = lead + new_core + trail
    # 若新内容与旧内容完全相同则跳过
    if new_raw != raw:
        result = result[:start] + new_raw + result[end:]
        removed_tokens += len(dead)

open(PATH, 'w', encoding='utf-8').write(result)

print(f"删除整条规则数: {removed_whole}")
print(f"修剪选择器令牌数: {removed_tokens}")
print(f"行数: {len(src.split(chr(10)))} -> {len(result.split(chr(10)))}")
print(f"括号平衡: {result.count('{')} / {result.count('}')} -> {result.count('{') == result.count('}')}")
