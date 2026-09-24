import io, re, importlib.util
from collections import defaultdict

spec = importlib.util.spec_from_file_location('cs', 'scripts/check_shared.py')
cs = importlib.util.module_from_spec(spec); spec.loader.exec_module(cs)
PAGES = cs.PAGES

# 判断每个「重复类」在页面里到底是「独立类选择器」还是「复合选择器的一部分」
# 若在任一页面里它总是跟别的类/元素连写（.a.b 或 .a > .b），就不是独立组件类。
def usages(css, cls):
    """返回该类的所有使用现场：是独立选择器还是复合/后代的一部分"""
    sites = []
    for sel, body, in_at in cs.iter_rules_ex(css):
        if not re.search(r'(?<![\w-])\.' + re.escape(cls) + r'(?![\w-])', sel):
            continue
        # 取该选择器里包含 .cls 的那个简单选择器片段
        for part in re.split(r'[\s>+~]+', sel):
            if re.search(r'(?<![\w-])\.' + re.escape(cls) + r'(?![\w-])', part):
                n_classes = len(re.findall(r'\.', part))
                has_elem = bool(re.match(r'^[a-zA-Z]', part.strip()))
                sites.append((sel.strip(), 'compound' if (n_classes > 1 or has_elem) else 'standalone', in_at))
    return sites

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

print('类别 A：纯复合选择器（不是独立类，属误报）')
print('类别 B：存在独立定义（真正可上收的候选）')
print('=' * 100)
A, B = [], []
for c in sorted(pending):
    allsites = []
    for p in pending[c]:
        allsites += usages(per_page_css[p], c)
    has_standalone = any(k == 'standalone' for _, k, _ in allsites)
    if has_standalone:
        B.append(c)
    else:
        A.append(c)

print('\nA（复合/后代专属，误报）: %d 个' % len(A))
for c in A:
    print('   .%-22s [%s]' % (c, ','.join(x.replace('.html','') for x in pending[c])))

print('\nB（有独立定义，可考虑上收）: %d 个' % len(B))
for c in B:
    print('   .%-22s [%s]' % (c, ','.join(x.replace('.html','') for x in pending[c])))
