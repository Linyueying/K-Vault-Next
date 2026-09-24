# ⚠️⚠️⚠️ 一次性改造工具，已对 mobile-refactor.css 执行过，绝不可重跑。
# 重跑会再次改写 mobile-refactor.css（该文件已是清理后的最终 433 行状态），
# 把已交付的结果改坏。如需再清理 CSS，请用上一级的 dead-selectors.mjs 先判死。

"""从 mobile-refactor.css 中剪除「不存在于任何 HTML」的选择器令牌。

策略：
  - 选择器按逗号拆成多个 token，逐个判断是否死；
  - 若一条规则的所有 token 都死 → 整条规则删除；
  - 若只有部分 token 死 → 只删掉死的那个 token，保留规则本身；
  - 全程保持行结构，避免破坏 @media 嵌套。
"""
import re

PATH = '/workspace/K-Vault-Next/mobile-refactor.css'
src = open(PATH, encoding='utf-8').read()

# 这些 class 在 8 个 HTML 里【从未出现过】，对应选择器一律是死代码
DEAD_CLASSES = [
    'header-content', 'home-btn', 'nav-links', 'status-panel',
    'stats-text', 'stats-loaded',
    'el-dropdown', 'el-select-dropdown', 'el-card', 'el-dialog',
    'el-message-box', 'el-input__inner',
    'header-theme-toggle', 'header-title', 'header-actions',
    'theme-toggle-btn', 'theme-admin-toggle', 'theme-auto-inline-toggle',
]

def token_is_dead(tok):
    tok = tok.strip()
    if not tok:
        return True
    # 拆出该 token 里的所有 class 名
    classes = re.findall(r'\.([A-Za-z0-9_-]+)', tok)
    if not classes:
        return False  # 元素/伪类选择器（body、:root、* 等）不是死
    # 只要 token 命中了任一「确认不存在」的 class，就判死
    return any(c in DEAD_CLASSES for c in classes)

out_lines = []
i = 0
lines = src.split('\n')
n = len(lines)
removed_lines = 0

while i < n:
    line = lines[i]

    # 判断这一行是否是「选择器行的末尾」（以 { 结尾，且不是 @media/@supports）
    stripped = line.rstrip()
    if stripped.endswith('{') and not re.match(r'^\s*@', stripped):
        # 向后回溯组装完整选择器（可能跨多行）
        sel_lines = []
        j = i
        while j >= 0:
            sel_lines.insert(0, lines[j])
            if '{' in '\n'.join(sel_lines):
                break
            j -= 1
        # 提取 { 之前的部分
        whole = '\n'.join(sel_lines)
        brace_pos = whole.index('{')
        sel_text = whole[:brace_pos]

        # 按逗号拆分 top-level token
        tokens = [t for t in sel_text.split(',')]
        live_tokens = [t for t in tokens if not token_is_dead(t)]
        dead_tokens = [t for t in tokens if token_is_dead(t)]

        if not dead_tokens:
            # 无死 token，原样输出
            out_lines.append(line)
            i += 1
            continue

        if not live_tokens:
            # 全死 → 删除整条规则（选择器行 + 直到平衡的 }）
            depth = 0
            k = j
            while k < n:
                depth += lines[k].count('{') - lines[k].count('}')
                removed_lines += 1
                if depth == 0:
                    break
                k += 1
            i = k + 1
            continue

        # 部分死 → 重建选择器行（保留缩进），丢弃死 token
        indent = re.match(r'^(\s*)', lines[j]).group(1)
        # 保留原始 token 顺序
        kept_raw = [t for t in tokens if not token_is_dead(t)]
        # 清理每个 token 的首尾空白与换行
        kept_clean = []
        for t in kept_raw:
            t = re.sub(r'\s+', ' ', t).strip()
            if t:
                kept_clean.append(t)
        # 多 token 时每个占一行，便于阅读
        if len(kept_clean) == 1:
            new_sel = indent + kept_clean[0] + ' {'
        else:
            new_sel = (',\n' + indent).join(kept_clean)
            new_sel = indent + new_sel + ' {'
        out_lines.append(new_sel)
        # 丢掉原来的选择器多行（j..i-1 已被合并）
        removed_lines += (i - j)
        i += 1
        continue

    out_lines.append(line)
    i += 1

result = '\n'.join(out_lines)
open(PATH, 'w', encoding='utf-8').write(result)

print(f"原始行数: {n}")
print(f"结果行数: {len(result.split(chr(10)))}")
print(f"净减少: {n - len(result.split(chr(10)))}")
print(f"括号平衡: {result.count('{')} / {result.count('}')} -> {result.count('{') == result.count('}')}")
