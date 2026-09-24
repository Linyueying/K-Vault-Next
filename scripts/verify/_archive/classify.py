import io, re, importlib.util
from collections import defaultdict

spec = importlib.util.spec_from_file_location('cs', 'scripts/check_shared.py')
cs = importlib.util.module_from_spec(spec); spec.loader.exec_module(cs)
PAGES = cs.PAGES

def rules_of(css, cls):
    out = []
    for sel, body, in_at in cs.iter_rules_ex(css):
        if in_at: continue
        if not re.search(r'\.' + re.escape(cls) + r'(?![\w-])', sel): continue
        if re.search(r':(?!:)[a-z-]', sel): continue
        parts = [s.strip() for s in re.split(r'[\s>+~]+', sel) if s.strip()]
        simple = [p for p in parts if re.search(r'\.' + re.escape(cls) + r'(?![\w-])', p)]
        if len(parts) > 1 or len(simple) != 1: continue
        if len(re.findall(r'\.', simple[0])) != 1: continue
        out.append((sel, body.strip()))
    return out

def props(css, cls):
    """提取该类的属性字典（同一属性后写的覆盖先写的）"""
    d = {}
    for _, body in rules_of(css, cls):
        for m in re.finditer(r'([a-zA-Z-]+)\s*:\s*([^;]+)', body):
            d[m.group(1).lower()] = re.sub(r'\s+', ' ', m.group(2)).strip()
    return d

per_page_css = {p: cs.style_blocks(cs.read(p)) for p in PAGES}
owner = defaultdict(list)
for p in PAGES:
    for c in cs.css_classes(per_page_css[p]):
        owner[c].append(p)

IGNORE_PREFIX = ('is-', 'has-', 'v-', 'js-', 'no-', 'swiper')
dup = {c: ps for c, ps in owner.items()
       if len(ps) >= 2 and not c.startswith(IGNORE_PREFIX) and c not in cs.MODIFIER_ALLOW}
shared = cs.css_classes(cs.read('design-system.css'))
pending = {c: ps for c, ps in dup.items() if c not in shared}

print('%-24s %-6s %s' % ('类名', '页数', '属性差异概览'))
print('=' * 110)
for c in sorted(pending):
    ps = pending[c]
    allprops = {p: props(per_page_css[p], c) for p in ps}
    # 找所有页面属性名集合的差异
    keysets = {p: set(v.keys()) for p, v in allprops.items()}
    common = set.intersection(*keysets.values()) if keysets else set()
    union = set.union(*keysets.values()) if keysets else set()
    differ = union - common
    # 比对共有属性是否同值
    val_diff = set()
    for k in common:
        vals = {re.sub(r'\s+','',allprops[p].get(k,'')) for p in ps}
        if len(vals) > 1:
            val_diff.add(k)
    print('%-24s %-6d 共有属性=%d 差异属性=%s 值不同=%s'
          % ('.' + c, len(ps), len(common),
             (','.join(sorted(differ))[:55] if differ else '无'),
             (','.join(sorted(val_diff))[:40] if val_diff else '无')))
