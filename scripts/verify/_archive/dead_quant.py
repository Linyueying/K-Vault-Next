import io, re, importlib.util

spec = importlib.util.spec_from_file_location('cs', 'scripts/check_shared.py')
cs = importlib.util.module_from_spec(spec); spec.loader.exec_module(cs)

css = io.open('mobile-refactor.css', encoding='utf-8').read()
lines = css.splitlines()

# 已知的死类（全仓库 HTML 中不存在）
DEAD = ['header-content', 'nav-links', 'home-btn', 'el-dropdown', 'el-select-dropdown',
        'header-actions', 'dropdown-menu']

# 逐行标注：该行是否只服务死类
def line_is_dead(line):
    s = line.strip()
    if not s or s.startswith('/*') or s.startswith('*') or s.startswith('}'):
        return False
    for d in DEAD:
        if re.search(r'\.' + re.escape(d) + r'\b', s):
            return True
    return False

dead_lines = [i + 1 for i, l in enumerate(lines) if line_is_dead(l)]
print('mobile-refactor.css 总行数:', len(lines))
print('疑似只服务死类的行数:', len(dead_lines))

# 统计涉及死类的规则块（选择器 + 其声明体）
dead_blocks = []
i, n = 0, len(css)
while i < n:
    oi = css.find('{', i)
    if oi < 0:
        break
    prelude = css[i:oi]
    depth, j = 1, oi + 1
    while j < n and depth:
        if css[j] == '{': depth += 1
        elif css[j] == '}': depth -= 1
        j += 1
    sel = re.sub(r'/\*.*?\*/', '', prelude, flags=re.S).strip().split('}')[-1].strip()
    if any(re.search(r'\.' + re.escape(d) + r'\b', sel) for d in DEAD):
        body = css[oi + 1:j - 1]
        dead_blocks.append((sel, body, css[:i].count('\n') + 1, css[:j].count('\n')))
    i = j

print('涉及死类的规则块数:', len(dead_blocks))
tot = 0
for sel, body, l1, l2 in dead_blocks:
    tot += (l2 - l1)
print('这些块共计行数（约）:', tot)
print()
print('前 20 个死块:')
for sel, body, l1, l2 in dead_blocks[:20]:
    print('  L%-4d-%-4d %s' % (l1, l2, sel[:78]))
