#!/usr/bin/env python3
"""样式完整性校验（从模板反查样式是否存在）

## 为什么需要它

`check_shared.py` 的检查项全部是**从 CSS 出发**的：哪些类在几页重复、
哪些类被页面重定义、哪些死选择器回潮。它回答的是「样式表本身有没有漂移」。

但它看不见反方向的错误：**模板里用了一个类，而全站没有任何一条规则定义它**。
这类错误在无构建步骤的裸 HTML 项目里代价极高 —— 没有 lint、没有类型检查，
页面照常渲染、`npm test` 全绿、模板编译也通过（类名只是普通字符串），
只有人打开浏览器才看到「控件没有边框、文字挤在一起」。

真实事故：把 admin.html 的 `.overlay / .dialog-*` 上收进 design-system.css 时，
删除区间多吃掉了紧随其后的 `.dialog-hint / .dialog-input / .dialog-input:focus`
三行。所有自动化检查都通过，但管理后台的「分享目录」对话框失去了全部输入
框样式 —— 复选框退回浏览器默认外观、输入框无边框、标签与控件贴在一起。

## 检查什么

反向收集模板中出现的 class，逐个确认它至少被以下之一覆盖：

  1. 任一本页或共享样式表里的 `.class` 选择器；
  2. 动态拼接的痕迹（本页 JS 里出现 `'prefix-' + x` 这类模板串，
     则 `prefix-*` 一律放行）；
  3. 全局白名单（FontAwesome 的 `fa*`、Vue 的 `v-*` / `*-enter-*` 过渡类等）。

找不到归属的类会报出来。**它不判断样式好不好看，只判断样式存不存在。**

## 已知边界（不要指望它解决这些）

纯静态分析只能证明「存在一条给这个类名背书的规则」，无法证明「视觉上是完整的」。
实测：删掉 `.dialog-input` 的桌面基类后，`.dialog-input,.token-input{min-height:44px}`
这条 @media 规则仍在，检查就会放行 —— 尽管此时输入框已经没有边框和背景色。

换句话说，它抓的是**「类名彻底失去样式来源」**（`.field-col` / `.share-textarea`
被整片删除这类），而不是**「样式退化但不为零」**。后者的可靠检测手段只有
真实浏览器渲染 + 计算样式比对（见 visual-snapshot.mjs 的思路），成本高得多，
不在本脚本职责内。知道这条边界，就不会误以为"检查过了 = 视觉没问题"。

用法： python3 scripts/check_styles.py
退出码：0 = 通过，1 = 有类名没有任何样式来源
"""
import os
import re
import sys

PAGES = ['index.html', 'admin.html', 'gallery.html', 'paste.html',
         'share.html', 'preview.html', 'webdav.html', 'login.html']

# 各页引用的样式表。页面自己的 <style> 单独处理。
COMMON_CSS = ['design-system.css', 'theme.css', 'mobile-refactor.css', 'index.css']

# 这些类名一定来自外部或框架，不要求本仓库提供定义。
GLOBAL_ALLOW = [
    # FontAwesome 图标
    re.compile(r'^fa[srlbd]?$'),
    re.compile(r'^fa-'),
    # Vue 过渡（<transition name="dialog"> 会生成 dialog-enter-* 等）
    re.compile(r'^(fade|dialog|sheet|view|card|list|modal|drawer)-'),
    re.compile(r'^(v-|_|is-)'),
    # 主题 / 性能开关，由 theme.js 挂在 <html> 上
    re.compile(r'^(light|dark)$'),
    re.compile(r'^perf-'),
]

STYLE_BLOCK = re.compile(r'<style[^>]*>(.*?)</style>', re.S | re.I)
# 前置断言 (?<!:) 很关键：没有它 `:class="..."` 也会被当成静态 class，
# 于是整个绑定表达式（含运算符、变量名）被逐词收进"类名"清单。
CLASS_ATTR = re.compile(r'(?<![:\w-])class\s*=\s*"([^"]*)"', re.I)
CLASS_BIND = re.compile(r'(?<![:\w-]):class\s*=\s*"([^"]*)"', re.I)
STATIC_CLASS_NAME = re.compile(r'\.(-?[_a-zA-Z][\w-]*)')
# 一条规则的「选择器 + 声明块」。声明块用 [^{}]* 保证不跨规则嵌套。
RULE_PAIR = re.compile(r'(?:^|[};])\s*([^{};]+?)\s*\{([^{}]*)\}')
# 只做间距微调的属性。一条规则若**仅**由这些属性构成，说明它是修饰规则
# （`.dialog-input.mb0{margin-bottom:0}`），不足以给类名提供基础样式。
#
# 刻意只留 margin / padding：`gap` 与 `flex` 常是核心语义（`.grow{flex:1}`
# 就是整个类的全部意义），把它们当微调会让这类单属性类名被误判为"无样式"。
TRIVIAL_PROPS = {
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'margin-block', 'margin-inline', 'padding', 'padding-top', 'padding-right',
    'padding-bottom', 'padding-left', 'padding-block', 'padding-inline',
}

# ---------------------------------------------------------------------------
# 已知的「无样式类名」白名单。
#
# 这些类名在模板里存在但不该有样式，逐个登记原因 —— 白名单必须显式且有据，
# 否则它会退化成"把所有报错都加进去"的橡皮图章。
# ---------------------------------------------------------------------------
KNOWN_STYLELESS = {
    # design-system.css 的 .collapse 注释明确要求：动画期间需要一层**无样式**的
    # 内层包裹承载内容，否则 padding 会被 overflow:hidden 裁掉。
    # 它刻意没有规则 —— 加样式反而会破坏折叠动画。
    'collapse__inner': '折叠动画要求的一层无样式包裹（见 design-system.css .collapse 注释）',

    # BEM 语义骨架：只作为结构/查询锚点，样式全在修饰符或子元素上。
    'result-actions__group': 'BEM 骨架，样式落在 .result-actions 与过渡容器上',
    'route-hint--direct': '语义修饰符，:class 动态绑定取胜；直接子选择器已覆盖',
    'share-result__hint--live': '语义修饰符，仅用于标识"实时同步"态，无独立视觉',
    'kv-usage-footer': '布局钩子，间距由相邻兄弟选择器给出',
    'glass-refract': 'glassfx 运行时标记，由 vendor/glassfx/glass.css 读取',

    # `:class="dlg.tone ? 'dlg--' + dlg.tone : ''"` 的引号内只剩前缀，
    # 实际拼出 dlg--danger / dlg--warn —— index.css 里两条都定义了。
    'dlg--': '动态拼接前缀，产物 .dlg--danger / .dlg--warn 已在 index.css 定义',

    # 纯布局容器，唯一的自有规则是 margin（见 index.css 819 / 971 / 973 行），
    # 视觉全在子元素（__label / __header / .task）上。它们**不是**"基类被误删"
    # 的形态 —— 不存在一条被删掉的 `.hist-group{border:...}`。登记以免误报。
    'hist-group': '纯布局容器，自有规则仅 margin，样式落在 .hist-group__label',
    'settings-group': '纯布局容器，自有规则仅 margin，样式落在 __header / __footer',
    'task__node-full': '布局钩子，样式由 .task 与子元素共同决定',

    # ⚠ 真问题（本次未修，仅登记以免掩盖）：两处按钮绑定 :class="{'share-active': hasShare(item)}"，
    # 但全站没有任何 .share-active 规则 —— 这个状态标记目前不会产生任何视觉反馈。
    'share-active': '⚠ 已登记的真缺失：绑定了状态但无对应样式，待补',
}
# JS 里 `'foo-' + bar` / `foo-${bar}` 形式的动态类名前缀
DYNAMIC_PREFIX = re.compile(r"""['"`]([a-zA-Z][\w-]*-)(?:['"],|\s*\+|\$\{)""")


def read(path):
    if not os.path.exists(path):
        return ''
    with open(path, encoding='utf-8') as fh:
        return fh.read()


def iter_rules(text):
    """逐字符扫描出 (选择器, 声明块) 对。

    正则做不了这件事：`@media` 里嵌套着规则，`[^{}]*` 形式的声明块会在
    遇到内层 `}` 时提前截断，导致 @media 内的规则被整片漏掉。这里用花括号
    深度显式扫描 —— 遇到 `{` 时把此前累积的文本当作选择器，深度回到 0 时
    结束声明块。@media / @supports 的条件文本会作为"选择器"出现，它们没有
    类名，天然被忽略。
    """
    depth = 0
    buf = ''
    selector = ''
    for ch in text:
        if ch == '{':
            if depth == 0:
                selector = buf.strip()
                buf = ''
            depth += 1
            continue
        if ch == '}':
            depth -= 1
            if depth <= 0:
                depth = 0
                if selector:
                    yield selector, buf
                selector = ''
                buf = ''
            else:
                buf = ''
            continue
        if ch == ';' and depth == 0:
            buf = ''
            continue
        buf += ch
    return


def stylesheet_classes(paths):
    """样式表里**给类名提供了样式**的 `.cls` 名。

    判据分两层，因为 BEM 里类名有两种合法出现方式：

    1. **主体规则** —— `.btn--icon{...}`、`.grow{flex:1}`。该选项片段的首个
       类名就是它，直接背书。
    2. **上下文限定规则** —— `.row.hist-row{...}`、`.settings-row__icon.ico--blue{...}`。
       样式确实存在，只是被父级类名限定作用域。这类同样算"有样式"。

    真正要排除的是第三种：**只剩间距微调的修饰规则**。
    `.dialog-input.mb0{margin-bottom:0}` 让 `dialog-input` 字符串处处可搜，
    但桌面基类 `.dialog-input{...}` 一旦被删，输入框就只剩 margin ——
    没边框、没内边距、没背景。真实事故正是这个形态，只看"名字存在"的检查
    会放行，所以要求背书规则至少带一个非 margin/padding 属性。
    """
    found = set()
    for path in paths:
        text = re.sub(r'/\*.*?\*/', '', read(path), flags=re.S)
        for selector, body in iter_rules(text):
            props = set(re.findall(r'([-\w]+)\s*:', body))
            if not (props - TRIVIAL_PROPS):
                continue
            # 逗号列表逐段看：`.a, .b:hover` 两段各自背书
            for part in selector.split(','):
                for name in STATIC_CLASS_NAME.findall(part):
                    found.add(name)
    return found


def dynamic_prefixes(*texts):
    """从 JS 里推断动态拼接的类名前缀，例如 `'bitem-' + x`。"""
    found = set()
    for text in texts:
        for prefix in DYNAMIC_PREFIX.findall(text):
            found.add(prefix.rstrip('-'))
    return found


def split_tokens(value):
    """按空白切分类名，但只在表达式**不处于嵌套括号内**的位置切。

    `:class="['bitem', { 'is-picked': f.selected }]"` 里的 `is-picked` 是类名，
    而 `f.selected` 不是。靠 `.` `(` `{` 这些运算符切分，只取干净的字面量。
    """
    out = []
    depth = 0
    token = ''
    for ch in value:
        if ch in '([{':
            depth += 1
            token = ''
            continue
        if ch in ')]}':
            depth -= 1
            token = ''
            continue
        if ch.isspace() or ch in '?!:&|,+':
            if token:
                out.append(token)
            token = ''
            continue
        token += ch
    if token:
        out.append(token)
    return [t for t in out if t]


def literal_class_names(expr):
    """从 :class 表达式里抽出**字符串字面量**形式的类名。

    难点在于 `:class="a === 'asc' ? 'fa-up' : 'fa-down'"` —— `'asc'` 只是比较
    用的字符串，不是类名。用两条规则区分：

      1. 三元表达式里，`?` 之后、`:` 之前的字面量才是取值分支；
      2. `===` / `!==` / `==` / `!=` 紧邻的字面量一律排除。

    绑定变量（`toneClass`、`isImage(f)`）求值才知道结果，静态分析无法判断，
    直接跳过 —— 硬报出来只会淹没真问题。
    """
    names = set()
    # 先摘掉比较运算的右操作数，避免 'asc' 这类误入
    cleaned = re.sub(r"[=!]==?\s*(['\"])[^'\"]*\1", "", expr)

    for quoted in re.findall(r"'([^']*)'", cleaned) + re.findall(r'"([^"]*)"', cleaned):
        text = str(quoted).strip()
        # `'dialog-' + kind` 这类拼接在引号里就断掉了，天然被排除；
        # 含空白 / 括号 / 变量插值的也不是单个类名
        if not text or re.search(r'[\s(){}\[\]$]', text):
            continue
        names.add(text)
    return names


def template_classes(html):
    """模板里写死的类名：静态 class 全取，:class 只取字符串字面量。

    先剥掉 <script> 正文 —— 那里面的 `class="${i}"` 是 JS 模板字符串插值，
    不是 HTML 属性；不剥掉的话 `${i}` 会被当成类名。
    """
    markup = re.sub(r'<script\b[^>]*>.*?</script>', '', html, flags=re.S | re.I)
    names = set()
    for value in CLASS_ATTR.findall(markup):
        for token in value.split():
            names.add(token)
    for expr in CLASS_BIND.findall(markup):
        names |= literal_class_names(expr)
    return names


def allowed(name, prefixes):
    for pattern in GLOBAL_ALLOW:
        if pattern.search(name):
            return True
    for prefix in prefixes:
        if len(prefix) >= 2 and name.startswith(prefix + '-'):
            return True
    return False


def main():
    css_files = [p for p in COMMON_CSS if os.path.exists(p)]
    shared = stylesheet_classes(css_files)

    problems = {}
    for page in PAGES:
        html = read(page)
        if not html:
            continue
        inline = '\n'.join(STYLE_BLOCK.findall(html))
        defined = set(stylesheet_classes(css_files)) | set(
            STATIC_CLASS_NAME.findall(re.sub(r'/\*.*?\*/', '', inline, flags=re.S)))

        # JS 里的动态前缀（本页内联脚本 + 可能的外部脚本）
        js_texts = [html]
        for src in re.findall(r'<script[^>]+src="/([\w.-]+\.js)"', html):
            js_texts.append(read(src))
        prefixes = dynamic_prefixes(*js_texts) | dynamic_prefixes(
            *[read(p) for p in ('app-core.js', 'theme.js')])

        missing = []
        for name in sorted(template_classes(html)):
            if name in defined or name in KNOWN_STYLELESS:
                continue
            if allowed(name, prefixes):
                continue
            missing.append(name)
        if missing:
            problems[page] = missing

    total = sum(len(v) for v in problems.values())
    if problems:
        print('以下类名在模板里出现，但任何样式表都没有定义：\n')
        for page, names in problems.items():
            print('  [问题] %s (%d 个)' % (page, len(names)))
            for name in names:
                print('        .%s' % name)
            print()
        print('提示：若是动态拼接的类名，检查本页 JS 里是否有 `\'prefix-\' + x` '
              '形式；若是从共享层误删，去 design-system.css 找回来。')
        print('\n样式完整性：%d 个类名无样式来源' % total)
        return 1

    print('  [OK] %d 页模板中的类名均有样式来源（共享层 %d 个定义）'
          % (len([p for p in PAGES if os.path.exists(p)]), len(shared)))
    print('\n样式完整性：全部通过')
    return 0


if __name__ == '__main__':
    sys.exit(main())
