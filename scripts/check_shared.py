#!/usr/bin/env python3
"""跨页共享层校验（防止「一次改动只生效一页」的漂移复发）

背景：
    历史上 8 个页面各写各的 formatBytes / toast / 复制逻辑，
    37 个 CSS 类在不同页面定义不一致，样式表加载顺序有 6 种组合。
    结果是「改一个页面，另外 7 个不受影响」，维护成本极高。
    本脚本用来把这些漂移钉死在提交前。

检查项：
    A. 共享层禁改名单：各页不得再自行实现已收敛到 app-core.js 的能力
    B. 样式表加载顺序：8 页必须完全一致
    C. 跨页重复 CSS 类：同一个类名在多页各自定义（应上收到 design-system.css）
    D. 共享层被页面重定义：design-system.css 里的类又在页面 <style> 里定义
    E. mobile-refactor.css 死选择器回潮：已清理的类不得再次出现

用法： python3 scripts/check_shared.py
退出码：0 = 通过，1 = 发现问题
"""
import io
import os
import re
import sys
from collections import defaultdict

PAGES = ['index.html', 'admin.html', 'gallery.html', 'paste.html',
         'share.html', 'preview.html', 'webdav.html', 'login.html']

SHARED_CSS = 'design-system.css'
SHARED_JS = 'app-core.js'

# ---------------------------------------------------------------- A. 禁改名单
# 这些能力已收在 app-core.js（window.KVault）。页面里再写一份 = 漂移起点。
BANNED_JS = [
    (re.compile(r'Math\.floor\s*\(\s*Math\.log\s*\(\s*bytes'),
     '手写 formatBytes（改用 KVault.formatBytes）'),
    (re.compile(r'function\s+fallbackCopy'),
     '手写 fallbackCopy（KVault.copy 已含降级）'),
    (re.compile(r'execCommand\s*\(\s*[\'"]copy[\'"]'),
     '手写 execCommand("copy")（改用 KVault.copy）'),
    (re.compile(r'fa-triangle-exclamation[\'"]\s*:\s*[\'"]\s*fa-triangle-exclamation'),
     '手写 toast 图标映射（改用 KVault.toastIcon）'),
]

# ------------------------------------------------- B. 期望的样式表加载顺序
EXPECTED_CSS_ORDER = [
    'font-awesome',        # 图标字体，必须是第一个样式表
    'design-system.css',   # 唯一共享样式层
    'theme.css',
]
EXPECTED_SCRIPT_ORDER = [
    'theme.js',
    'app-core.js',         # 共享 JS 层必须早于页面主脚本
]


def read(path):
    return io.open(path, encoding='utf-8').read()


def style_blocks(html):
    """取出页面内所有 <style> 块的内容，并剥掉 CSS 注释"""
    body = '\n'.join(re.findall(r'<style[^>]*>(.*?)</style>', html, re.S))
    return re.sub(r'/\*.*?\*/', '', body, flags=re.S)


def top_level_blocks(css):
    """用最小括号配平切出「顶层规则」，把 @media 之类的条件块单独标出来。

    返回 [(selector, in_at_rule_bool), ...]
    —— 页面在 `@media (pointer:coarse)` 里调 `.btn{height:48px}` 是
       HIG 触控目标的正当条件覆盖，不算「重定义共享组件」。
       只有「无条件」覆盖共享组件类才是真正危险的。
    """
    out = []
    i, n = 0, len(css)
    while i < n:
        # 找下一个 '{'
        open_i = css.find('{', i)
        if open_i < 0:
            break
        prelude = css[i:open_i]
        # 配平找到对应 '}'
        depth, j = 1, open_i + 1
        while j < n and depth:
            if css[j] == '{':
                depth += 1
            elif css[j] == '}':
                depth -= 1
            j += 1
        block = css[open_i + 1:j - 1]
        prelude_clean = re.sub(r'/\*.*?\*/', '', prelude, flags=re.S).strip()
        is_at = prelude_clean.lstrip().startswith('@')
        if is_at:
            # 递归下探条件块内部
            for sel, _ in top_level_blocks(block):
                out.append((sel, True))
        else:
            # prelude 可能含上一条规则的残留（已闭合的部分），取最后一段
            sel = prelude_clean.split('}')[-1].strip()
            if sel:
                out.append((sel, False))
        i = j
    return out


def iter_rules(css):
    """遍历所有规则，产出 (selector, body)。"""
    for sel, body, _ in iter_rules_ex(css):
        yield sel, body


def iter_rules_ex(css, in_at=False):
    """遍历所有规则，产出 (selector, body, in_at_rule)。

    in_at_rule=True 表示该规则位于 @media / @supports 等条件块内部。
    这类规则是响应式适配，属于正当覆盖，不应与「无条件重写」混为一谈。
    """
    i, n = 0, len(css)
    while i < n:
        open_i = css.find('{', i)
        if open_i < 0:
            break
        prelude = css[i:open_i]
        depth, j = 1, open_i + 1
        while j < n and depth:
            if css[j] == '{':
                depth += 1
            elif css[j] == '}':
                depth -= 1
            j += 1
        body = css[open_i + 1:j - 1]
        sel = re.sub(r'/\*.*?\*/', '', prelude, flags=re.S).strip()
        sel = sel.split('}')[-1].strip()
        if sel.startswith('@'):
            for s2, b2, _ in iter_rules_ex(body, True):
                yield s2, b2, True
        elif sel:
            yield sel, body, in_at
        i = j


def css_classes(css):
    """提取「真正的类选择器」。

    两个必须避开的坑（否则误报淹没有效信号）：
      1. 注释里的文件名（如 design-system.css）会被 .xxx 正则误当成类名
         —— 注释已在 style_blocks 里剥掉。
      2. 只在「选择器区域」里取类名，不要在声明体里取。
         否则 url(...) / content:"..." 里的点号也会被算进来。
    做法：先切到每个 { 之前的选择器片段，再在其中提取 .class。
    """
    names = set()
    # 只看 { 之前的部分：把每条规则的「选择器」截出来
    for m in re.finditer(r'([^{}]*)\{', css):
        selector = m.group(1)
        # 丢掉 @media / @keyframes 等 at-rule 的参数里出现的点号
        selector = re.sub(r'@[^{]*', ' ', selector)
        # 丢掉百分比关键帧（0% / 33.3% 里的 .3 会被误判）
        selector = re.sub(r'\d+\.\d+%', ' ', selector)
        for c in re.finditer(r'\.([a-zA-Z_][a-zA-Z0-9_-]*)', selector):
            names.add(c.group(1))
    return names


# 这些名字是「组件内部的修饰/状态类」，天然会在多页出现，
# 且通常与宿主选择器绑在一起写（.act.danger），不属于「重复实现同一组件」。
MODIFIER_ALLOW = {
    'danger', 'warn', 'success', 'error', 'info', 'check', 'active',
    'open', 'show', 'hidden', 'disabled', 'loading', 'selected', 'primary',
    'ghost', 'icon', 'sm', 'lg', 'round', 'block', 'danger-item',
}


def css_loaded_order(html):
    """按出现顺序返回 <link rel=stylesheet> 的规范化名字。

    只统计 <head> 里的样式表：那才是「基础层加载顺序」。
    页面 <body> 末尾故意后挂的覆盖层（如 mobile-refactor.css）不在此列，
    它们靠「后加载」赢得级联，属于正当用法 —— 见 LATE_LOAD_CSS。
    """
    head = html.split('</head>')[0] if '</head>' in html else html
    out = []
    for m in re.finditer(r'<link[^>]+rel=["\']?stylesheet["\']?[^>]*>', head, re.I):
        tag = m.group(0)
        href = re.search(r'href=["\']([^"\']+)', tag)
        if not href:
            continue
        url = href.group(1)
        if re.search(r'font-?awesome|all(\.min)?\.css', url, re.I):
            out.append('font-awesome')
        else:
            out.append(url.split('/')[-1].split('?')[0])
    return out


def body_loaded_css(html):
    """<body> 里后挂的样式表（覆盖层）"""
    body = html.split('</head>')[-1]
    return [m.group(1).split('/')[-1].split('?')[0]
            for m in re.finditer(r'<link[^>]+rel=["\']?stylesheet["\']?[^>]*href=["\']([^"\']+)', body, re.I)]


def script_loaded_order(html):
    out = []
    for m in re.finditer(r'<script[^>]+src=["\']([^"\']+)', html, re.I):
        out.append(m.group(1).split('/')[-1].split('?')[0])
    return out


# ------------------------------------------------- 共享组件类的允许例外
# 格式：{ 页面: { 允许的类名: '理由' } }
# 只有在「该页面确实是某个组件的唯一实现者 / 有意保留独立外观」时才登记，
# 并必须写明理由。这里的每一项都应在后续收敛时逐个消除。
CRITICAL_EXCEPTIONS = {
    'gallery.html': {
        'theme-toggle-round':
            'gallery 自绘的圆形图标按钮（40px 仅图标），与 theme.css 的'
            '带文字胶囊按钮是两套设计，保留其独立外观；'
            '该按钮通过 data-theme-toggle 走共享行为，仅样式独立。',
    },
}


# ------------------------------------------------- 加载顺序的允许例外
# 某些「覆盖层」样式表被**有意**排在基础层之后，靠级联赢得优先级。
# 这类文件必须显式登记，避免变成「不知不觉又插了一层」。
LATE_LOAD_CSS = {
    'mobile-refactor.css':
        '移动端覆盖层：必须在 design-system.css / theme.css 之后加载才能生效'
        '（内含量覆盖规则）。目前由 gallery / preview / webdav / login 四页引入。'
        '重要认知：它【不是】共享层 —— 全文件 71 个 class 里只有 .btn 一个被 4 页以上使用，'
        '其余全是单页/两页的移动端专属布局增量（.header-title 只有 webdav 用、'
        '.preview-close 只有 gallery 用 …）。因此不能整体上收进 design-system.css，'
        '否则会把 webdav 的头部规则、gallery 的预览规则强加给其余 6 页。'
        '已于 2024 收敛：删除 350 行指向「8 页均不存在」的类的死代码'
        '（.header-content / .nav-links / .home-btn / .status-panel / .el-* 等），'
        '781 -> 433 行，清理前后 132 项计算样式快照逐一比对完全一致。',
}


def main():
    bad = 0
    print('=' * 74)
    print('跨页共享层校验  (scripts/check_shared.py)')
    print('=' * 74)

    # ---------------------------------------------------------- A. 禁改名单
    print('\n[A] 页面禁用：已收敛到 app-core.js 的能力')
    a_bad = 0
    for p in PAGES:
        html = read(p)
        # 排除注释行，避免把「说明文字」当成违规代码
        code = '\n'.join(l for l in html.splitlines()
                         if not l.strip().startswith(('/*', '*', '//')))
        hits = []
        for rx, why in BANNED_JS:
            if rx.search(code):
                hits.append(why)
        if hits:
            a_bad += 1
            print('  [检查] %s' % p)
            for h in hits:
                print('        %s' % h)
    if not a_bad:
        print('  [OK]   8 页均无重复实现')
    bad += a_bad

    # ------------------------------------------------- B. 样式/脚本加载顺序
    print('\n[B] 样式表与脚本加载顺序一致性')
    orders = {}
    for p in PAGES:
        html = read(p)
        orders[p] = (css_loaded_order(html), script_loaded_order(html))

    ref_page = 'index.html'
    ref_css, ref_js = orders[ref_page]
    # 基准里不含覆盖层；检查时把登记过的覆盖层从各页顺序里摘掉再比
    late_allowed = set(LATE_LOAD_CSS)
    b_bad = 0
    for p in PAGES:
        css, js = orders[p]
        css_cmp = [c for c in css if c not in late_allowed]
        probs = []
        # 顺序必须与基准一致（子序列语义：允许各页只加载部分，但相对顺序不能变）
        idx, ok = 0, True
        for name in ref_css:
            if idx < len(css_cmp) and css_cmp[idx] == name:
                idx += 1
        if idx != len(css_cmp):
            ok = False
            probs.append('CSS 顺序 %s 与基准不一致，基准为 %s' % (css, ref_css))
        idx = 0
        for name in ref_js:
            if idx < len(js) and js[idx] == name:
                idx += 1
        if idx != len(js):
            ok = False
            probs.append('JS 顺序 %s 与基准不一致，基准为 %s' % (js, ref_js))
        # 未登记的覆盖层 = 新插了一层，必须显式登记（在下方 used_late 统一处理）
        if probs:
            b_bad += 1
            print('  [检查] %s' % p)
            for x in probs:
                print('        %s' % x)
    if not b_bad:
        print('  [OK]   8 页基础加载顺序一致')
        print('         CSS  : %s' % ' -> '.join(ref_css))
        print('         JS   : %s' % ' -> '.join(ref_js))

    # 覆盖层使用情况：只允许出现在已登记的文件里
    used_late = {}
    for p in PAGES:
        for c in orders[p][0]:
            if c.endswith('refactor.css') or c in late_allowed:
                used_late.setdefault(c, []).append(p)
    for name, ps in sorted(used_late.items()):
        if name in LATE_LOAD_CSS:
            print('  [说明] 覆盖层 %s 由 %d 页引入（%s）'
                  % (name, len(ps), ', '.join(ps)))
            print('         %s' % LATE_LOAD_CSS[name])
        else:
            b_bad += 1
            print('  [检查] 出现未登记的覆盖层样式表 %s（引入页：%s）'
                  % (name, ', '.join(ps)))
            print('         若确为有意后加载，请登记到 LATE_LOAD_CSS 并写明理由。')
    bad += b_bad

    # ---------------------------------------------- C. 跨页重复的 CSS 类定义
    print('\n[C] 跨页重复定义的 CSS 类（应上收到 design-system.css）')
    per_page = {}
    for p in PAGES:
        per_page[p] = css_classes(style_blocks(read(p)))

    owner = defaultdict(list)
    for p, classes in per_page.items():
        for c in classes:
            owner[c].append(p)

    # 只报「非工具类」：.is-/has- 状态类、修饰/状态类不算漂移
    IGNORE_PREFIX = ('is-', 'has-', 'v-', 'js-', 'no-', 'swiper')
    dup = {c: ps for c, ps in owner.items()
           if len(ps) >= 2
           and not c.startswith(IGNORE_PREFIX)
           and c not in MODIFIER_ALLOW}

    shared_raw = read(SHARED_CSS)
    shared_classes = css_classes(shared_raw)
    # 已在共享层定义、页面里又重复的，才是真正该删的；共享层没有的属于「待上收」
    redefined = {c: ps for c, ps in dup.items() if c in shared_classes}
    pending = {c: ps for c, ps in dup.items() if c not in shared_classes}

    # 「共享层已定义 + 页面又写」要区分两种性质：
    #   A) 页面重写了共享层同名的**属性**（真覆盖，危险，必须修）
    #   B) 页面只补了共享层没有的**增量属性**（如 .card{padding}），无害
    # 这里做属性级比对，把 A 和 B 分开报，避免误报淹没真问题。
    def rule_decls(css, cls):
        """把某类的**基础规则**声明合并（用于属性名比对）。

        四重过滤，只保留「真正无条件重写共享组件」的规则：
          1. 选择器末尾恰好是该类（.card { … }）——
             排除 .card-sub / .card-header 这类同前缀的别的类；
          2. 选择器里不含伪类（:hover/:focus…）—— 状态样式不算基础属性；
          3. 选择器是「裸的」该类，不带后代/兄弟限定 ——
             .dlg__actions .btn / .hist-card__foot .btn 是页面作用域收敛，
             属于正当用法，不是重写共享组件；
          4. 规则不在 @media 等条件块内 —— 响应式/触控适配是正当覆盖
             （例如 @media (max-width:680px){ .toast{…} }）。
        """
        props = set()
        for sel, body, in_at in iter_rules_ex(css):
            if in_at:
                continue
            if not re.search(r'\.' + re.escape(cls) + r'(?![\w-])', sel):
                continue
            # 2) 伪类 -> 跳过
            if re.search(r':(?!:)[a-z-]', sel):
                continue
            # 3) 拆成简单选择器；若该组件的简单选择器不止一个，或它前面还有
            #    别的东西（后代/兄弟），则视为作用域限定，跳过
            parts = [s.strip() for s in re.split(r'[\s>+~]+', sel) if s.strip()]
            simple = [p for p in parts if re.search(r'\.' + re.escape(cls) + r'(?![\w-])', p)]
            if len(parts) > 1 or len(simple) != 1:
                continue
            # 该简单选择器里除了 .cls 不能再带别的类（.actions.btn 算直接改）
            if len(re.findall(r'\.', simple[0])) != 1:
                continue
            for d in re.finditer(r'([a-zA-Z-]+)\s*:', body):
                props.add(d.group(1).lower())
        return props

    truly_overriding = {}
    additive_only = {}
    for c in redefined:
        shared_props = rule_decls(shared_raw, c)
        for p in redefined[c]:
            page_props = rule_decls(style_blocks(read(p)), c)
            overlap = page_props & shared_props
            if overlap:
                truly_overriding.setdefault(c, []).append(p)
            else:
                additive_only.setdefault(c, []).append(p)

    c_bad = 0
    if truly_overriding:
        c_bad += 1
        print('  [检查] 页面重写了共享层同名属性（真覆盖，应删除）: %d 个类'
              % len(truly_overriding))
        for c in sorted(truly_overriding)[:25]:
            print('        .%s  <- %s' % (c, ', '.join(truly_overriding[c])))
        if len(truly_overriding) > 25:
            print('        ... 另有 %d 个' % (len(truly_overriding) - 25))
    if additive_only:
        print('  [提示] 共享层已定义、页面仅追加原共享层没有的属性（无害增量）: %d 个类'
              % len(additive_only))
        for c in sorted(additive_only)[:15]:
            print('        .%s  <- %s' % (c, ', '.join(additive_only[c])))
        if len(additive_only) > 15:
            print('        ... 另有 %d 个' % (len(additive_only) - 15))
    if pending:
        print('  [提示] 跨页重复但尚未上收（本次不判失败，建议逐步收敛）: %d 个'
              % len(pending))
        for c in sorted(pending)[:15]:
            print('        .%s  <- %s' % (c, ', '.join(pending[c])))
        if len(pending) > 15:
            print('        ... 另有 %d 个' % (len(pending) - 15))
    if not c_bad:
        print('  [OK]   无「共享层已定义却被页面重定义」的类')
    bad += c_bad

    # ------------------------------------------- D. 共享层关键类是否被页面覆盖
    print('\n[D] 共享层关键组件类是否被「无条件」覆盖定义')
    print('    （@media 内的条件覆盖属正当用法，不在此列）')
    CRITICAL = ['btn', 'btn--primary', 'btn--ghost', 'btn--icon',
                'toast', 'toast--error', 'toast--success',
                'modal', 'modal__panel', 'theme-toggle-round']
    d_bad = 0
    for p in PAGES:
        blocks = top_level_blocks(style_blocks(read(p)))
        # 只看无条件块（不在 @media 内的）
        unconditional = set()
        for sel, in_at in blocks:
            if in_at:
                continue
            # 只关心「裸的组件类选择器」（.btn { ... }）。
            # 形如 .actions .btn / .hist-card__foot .btn 是**后代限定**的页面增量，
            # 属于正当作用域收敛，不是「重定义共享组件」。
            # 判定：把后代选择器拆开，若该组件类恰好是选择器的「最后一段」，
            # 且选择器里还有别的限定词，则跳过。
            parts = [s.strip() for s in re.split(r'[\s>+~]+', sel) if s.strip()]
            for c in re.finditer(r'\.([a-zA-Z_][a-zA-Z0-9_-]*)', sel):
                name = c.group(1)
                if name not in CRITICAL:
                    continue
                # 该组件类是否是「唯一选择器」或「最后一个选择器且带前导限定」
                is_scoped = len(parts) > 1
                if is_scoped:
                    last = parts[-1]
                    # 若最后一段含多个类（.actions.btn）也算共享组件被直接改
                    if last.lstrip().startswith('.' + name) and len(
                            re.findall(r'\.', last)) == 1:
                        continue
                    if '.' + name not in last:
                        continue
                unconditional.add(name)
        hit = sorted(unconditional)
        allow = CRITICAL_EXCEPTIONS.get(p, {})
        excused = [h for h in hit if h in allow]
        hit = [h for h in hit if h not in allow]
        if excused:
            for h in excused:
                print('  [豁免] %s .%s —— %s' % (p, h, allow[h]))
        if hit:
            d_bad += 1
            print('  [检查] %s 无条件覆盖共享组件类: %s'
                  % (p, ', '.join('.' + h for h in hit)))
    if not d_bad:
        print('  [OK]   各页未无条件覆盖共享组件类')
    bad += d_bad

    # ------------------------------------------------------------------
    # E. mobile-refactor.css 里不再出现「确认为死」的那批类
    #    该文件历史上塞了大量指向 .header-content / .nav-links / .home-btn /
    #    .status-panel / .el-* 等「8 个页面里一个都没有」的类的死规则，
    #    占全文件近一半。已剪除，此处加机械守卫防止回潮。
    #
    #    注意：这里只针对**已确认清理过的那批类名**做硬性拦截。
    #    文件里另有若干「防御性」规则（如 .toolbar / .storage-btn 之类当前
    #    无页面使用、但保留着以防将来加页），它们无害，不做拦截 —— 只提示。
    # ------------------------------------------------------------------
    print('\n[E] mobile-refactor.css 是否残留已确认清理过的死选择器')
    e_bad = 0
    mr = 'mobile-refactor.css'
    # 这批类已全站确认不存在，且已从文件里删除。若再次出现即为回潮。
    BANNED_DEAD_SELECTORS = [
        'header-content', 'nav-links', 'home-btn', 'status-panel',
        'stats-text', 'stats-loaded', 'header-theme-toggle', 'theme-toggle-btn',
        'theme-admin-toggle', 'theme-auto-inline-toggle',
        'el-dropdown', 'el-select-dropdown', 'el-card', 'el-dialog',
        'el-message-box', 'el-input__inner',
    ]
    if not os.path.exists(mr):
        print('  [跳过] 文件不存在')
    else:
        mr_css = read(mr)
        bare = re.sub(r'/\*.*?\*/', '', mr_css, flags=re.S)
        sel_zone = re.sub(r'\{[^{}]*\}', ' ', bare)
        present = [c for c in BANNED_DEAD_SELECTORS
                   if re.search(r'\.' + re.escape(c) + r'\b', sel_zone)]
        if present:
            e_bad = 1
            print('  [检查] 以下类已确认全站不存在并被清理过，又出现了：')
            for c in present:
                print('         .%s' % c)
        else:
            print('  [OK]   无回潮（%d 个已清理类均未复现）'
                  % len(BANNED_DEAD_SELECTORS))

        # 附加提示（不影响结果）：仍然指向「当前无页面使用」的类
        used = set()
        for html_path in PAGES:
            src = read(html_path)
            for m in re.finditer(r'''class\s*=\s*["']([^"']*)["']''', src):
                for t in m.group(1).split():
                    if re.fullmatch(r'[a-zA-Z][a-zA-Z0-9_-]*', t):
                        used.add(t)
        for js in sorted(f for f in os.listdir('.') if f.endswith('.js')):
            src = read(js)
            for m in re.finditer(r'''classList\.(?:add|remove|toggle)\(\s*["']([^"']+)["']''', src):
                for t in m.group(1).split():
                    if re.fullmatch(r'[a-zA-Z][a-zA-Z0-9_-]*', t):
                        used.add(t)
        mr_classes = set(re.findall(
            r'\.([a-zA-Z][a-zA-Z0-9_-]*)', sel_zone))
        idle = sorted(c for c in mr_classes if c not in used)
        if idle:
            print('  [提示] 另有 %d 个类当前无页面使用（防御性规则，未拦截）：%s'
                  % (len(idle), ', '.join('.' + c for c in idle[:12])
                     + (' …' if len(idle) > 12 else '')))
        bad += e_bad

    print('\n' + '=' * 74)
    if bad:
        print('结果：%d 项检查未通过' % bad)
    else:
        print('结果：全部通过')
    print('=' * 74)
    return bad


if __name__ == '__main__':
    sys.exit(1 if main() else 0)
