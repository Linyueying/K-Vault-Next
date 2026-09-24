import io, re, importlib.util
from collections import defaultdict

spec = importlib.util.spec_from_file_location('cs', 'scripts/check_shared.py')
cs = importlib.util.module_from_spec(spec); spec.loader.exec_module(cs)

PAGES = cs.PAGES

def rules_of(css, cls):
    """返回该类的基础规则体（排除伪类/后代/at-rule），用于比对是否一致"""
    out = []
    for sel, body, in_at in cs.iter_rules_ex(css):
        if in_at:
            continue
        if not re.search(r'\.' + re.escape(cls) + r'(?![\w-])', sel):
            continue
        if re.search(r':(?!:)[a-z-]', sel):
            continue
        parts = [s.strip() for s in re.split(r'[\s>+~]+', sel) if s.strip()]
        simple = [p for p in parts if re.search(r'\.' + re.escape(cls) + r'(?![\w-])', p)]
        if len(parts) > 1 or len(simple) != 1:
            continue
        if len(re.findall(r'\.', simple[0])) != 1:
            continue
        out.append((sel, body.strip()))
    return out

def norm(body):
    return re.sub(r'\s+', ' ', body).strip()

# 收集所有未上收的重复类
per_page_classes = {}
per_page_css = {}
for p in PAGES:
    html = cs.read(p)
    css = cs.style_blocks(html)
    per_page_css[p] = css
    per_page_classes[p] = cs.css_classes(css)

owner = defaultdict(list)
for p, cl in per_page_classes.items():
    for c in cl:
        owner[c].append(p)

IGNORE_PREFIX = ('is-', 'has-', 'v-', 'js-', 'no-', 'swiper')
dup = {c: ps for c, ps in owner.items()
       if len(ps) >= 2 and not c.startswith(IGNORE_PREFIX) and c not in cs.MODIFIER_ALLOW}
shared = cs.css_classes(cs.read('design-system.css'))
pending = {c: ps for c, ps in dup.items() if c not in shared}

print('未上收重复类总数:', len(pending))
print('=' * 100)

identical = {}
differing = {}
for c in sorted(pending):
    bodies = {}
    for p in pending[c]:
        rs = rules_of(per_page_css[p], c)
        bodies[p] = [norm(b) for _, b in rs]
    # 该类的所有页面规则是否完全一致
    vals = list(bodies.values())
    allsame = all(v == vals[0] for v in vals) and len(vals[0]) > 0
    if allsame:
        identical[c] = (pending[c], bodies)
    else:
        differing[c] = (pending[c], bodies)

print('\n### 定义完全一致的类（可安全上收）:', len(identical))
for c in sorted(identical):
    ps, bodies = identical[c]
    p0 = ps[0]
    body = ' | '.join(bodies[p0])
    print('  .%-22s [%s]  %s' % (c, ','.join(x.replace('.html','') for x in ps), body[:110]))

print('\n### 定义不一致的类（需逐个判断，不能直接上收）:', len(differing))
for c in sorted(differing):
    ps, bodies = differing[c]
    print('  .%-22s [%s]' % (c, ','.join(x.replace('.html','') for x in ps)))
    for p in ps:
        print('        %-14s %s' % (p.replace('.html',''), ' | '.join(bodies[p])[:100]))
