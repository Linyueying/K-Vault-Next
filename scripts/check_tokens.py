#!/usr/bin/env python3
"""全站样式一致性校验：
   1. 每个页面引用的 CSS 变量（var(--x)）是否都有定义
   2. 每个页面引用的动画名（animation / @keyframes）是否都能找到定义
   3. 共享层里定义了、却全站无人引用的 @keyframes（死动画）

用法： python3 scripts/check_tokens.py

==============================================================================
为什么必须扫描 assets/css/*.css（本脚本最重要的一条设计约束）
==============================================================================
项目早期 CSS 全部内联在页面 <style> 里，那时只扫 HTML 就够。后来 CSS 外置到
`assets/css/`（index.css / airdrop.css / mobile-refactor.css …），脚本没跟着改，
结果是**两头失真**：

  · 假阳性：index.css 里真实引用的 `titleIn` / `bounceDown` 被判成
    「共享层定义了但无人引用」的死关键帧 —— 它们活得好好的，只是不活在 HTML 里。
  · 假阴性：外置 CSS 里引用的未定义变量一格都查不到，盲区。

所以「可见定义」的正确算法是：**共享层 + 该页 <link> 引入的每个 CSS + 本页内联
<style> + JS 动态注入的变量**，四者取并集。硬编码文件列表会再次腐化，因此
CSS 清单从各页的 <link> 标签里**实时解析**，加新样式表无需改脚本。

关于「JS 动态注入的变量」（如 admin.html 的 `--vt-pos`，由 Vue `:style` 绑定写入）：
它们没有 CSS 定义处，但由运行时赋值，属合法用法。判定依据是页面里出现
`setProperty('--x'` 或 `:style="{'--x': ...}"`，不能靠「CSS 里搜不到就报错」。
这类变量通常自带 `var(--x, fallback)`，即使注入失败也有兜底。
"""
import re
import sys
import io
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHARED = 'assets/css/design-system.css'
CSS_DIR = 'assets/css'
PAGES = ['index.html', 'admin.html', 'gallery.html', 'paste.html',
         'share.html', 'preview.html', 'webdav.html', 'login.html']

VAR_DEF = re.compile(r'(--[a-zA-Z0-9-]+)\s*:')
VAR_USE = re.compile(r'var\(\s*(--[a-zA-Z0-9-]+)')
KF_DEF = re.compile(r'@keyframes\s+([a-zA-Z0-9_-]+)')
ANIM_USE = re.compile(r'animation(?:-name)?\s*:\s*([^;]+);')
# 页面 <link> 引入的外置样式表（只认本站 assets/css 下的，跳过 vendor）
CSS_LINK = re.compile(r'<link[^>]+href="(/assets/css/[A-Za-z0-9._-]+\.css)"')
# 页面 <script> 引入的外置 JS（动态变量的注入点，如 airdrop.js 的 '--ad-p'）
JS_LINK = re.compile(r'<script[^>]+src="(/assets/js/[A-Za-z0-9._-]+\.js)"')
# JS 动态注入自定义属性的两种写法
DYN_SETTER = re.compile(r"setProperty\(\s*['\"](--[a-zA-Z0-9-]+)")
DYN_BIND = re.compile(r"['\"](--[a-zA-Z0-9-]+)['\"]\s*:")

RESERVED = {'none', 'inherit', 'initial', 'unset', 'linear', 'infinite',
            'alternate', 'backwards', 'forwards', 'both', 'ease', 'reverse',
            'ease-in', 'ease-out', 'ease-in-out', 'running', 'paused', 'normal'}


def strip_css_comments(t):
    return re.sub(r'/\*.*?\*/', '', t, flags=re.S)


def read(rel):
    with io.open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def style_blocks(html):
    """页面内联 <style> 拼成的 CSS 文本"""
    return strip_css_comments('\n'.join(re.findall(r'<style[^>]*>(.*?)</style>', html, re.S)))


def linked_css(html):
    """按 <link> 出现顺序返回该页引入的外置 CSS 相对路径"""
    out = []
    for m in CSS_LINK.finditer(html):
        rel = m.group(1).lstrip('/')
        if rel not in out:
            out.append(rel)
    return out


def anim_names(text):
    """从 `animation: ...;` / `animation-name: ...;` 里取动画名（第一项）"""
    names = set()
    for decl in ANIM_USE.findall(text):
        first = decl.strip().split()[0]
        if first in RESERVED:
            continue
        if re.match(r'^[a-zA-Z][a-zA-Z0-9_-]*$', first):
            names.add(first)
    for m in re.finditer(r'animation-name\s*:\s*([^;]+);', text):
        for tok in re.split(r'[\s,]+', m.group(1)):
            tok = tok.strip()
            if tok and tok not in RESERVED and re.match(r'^[a-zA-Z][a-zA-Z0-9_-]*$', tok):
                names.add(tok)
    return names


def linked_js(html):
    """该页引入的外置 JS —— 可能为元素注入自定义属性（如 airdrop.js 的 --ad-p）"""
    out = []
    for m in JS_LINK.finditer(html):
        rel = m.group(1).lstrip('/')
        if rel not in out:
            out.append(rel)
    return out


def dynamic_vars(texts):
    """由 JS / Vue :style 绑定注入的自定义属性 —— 无 CSS 定义处，视为已定义。

    texts 要包含页面 HTML 全文**以及**该页引入的外置 JS：动态变量常常不在
    页面里而在 JS 中（airdrop.js 的 `{'--ad-p': ringProgress}` 就是），只扫
    HTML 会把合法用法误判成未定义。
    """
    found = set()
    for t in texts:
        found |= set(DYN_SETTER.findall(t))
        found |= set(DYN_BIND.findall(t))
    return found


def main():
    if not os.path.exists(os.path.join(ROOT, SHARED)):
        print('[FAIL] 共享层缺失 —— 放弃检查（否则会给出假通过）：%s' % SHARED)
        return 1

    shared = strip_css_comments(read(SHARED))
    shared_vars = set(VAR_DEF.findall(shared))
    shared_kf = set(KF_DEF.findall(shared))

    # 全站所有外置 CSS（不管被哪页引入），用于「孤儿关键帧」判定：
    # 只要任何一处还在引用，它就不是死的。
    all_css = []
    if os.path.isdir(os.path.join(ROOT, CSS_DIR)):
        for name in sorted(os.listdir(os.path.join(ROOT, CSS_DIR))):
            if name.endswith('.css'):
                rel = '%s/%s' % (CSS_DIR, name)
                if rel != SHARED:
                    all_css.append((rel, strip_css_comments(read(rel))))

    bad = 0

    for p in PAGES:
        html = read(p)
        inline = style_blocks(html)

        # 该页可见的样式来源：内联 + 引入的外置 CSS（共享层单独并入）
        sources = [('内联 <style>', inline)]
        for rel in linked_css(html):
            if rel == SHARED:
                continue
            sources.append((rel, strip_css_comments(read(rel))))

        js_texts = [read(rel) for rel in linked_js(html)]
        defs = set(shared_vars) | dynamic_vars([html] + js_texts)
        kf_defs = set(shared_kf)
        for _, text in sources:
            defs |= set(VAR_DEF.findall(text))
            kf_defs |= set(KF_DEF.findall(text))

        problems = []

        for label, text in sources:
            missing = sorted(v for v in VAR_USE.findall(text) if v not in defs)
            if missing:
                problems.append('   未定义变量（%s）: %s' % (label, ', '.join(missing)))

            miss_kf = sorted(anim_names(text) - kf_defs)
            if miss_kf:
                problems.append('   未定义关键帧（%s）: %s' % (label, ', '.join(miss_kf)))

        # 页面正文里的 var()（Vue :style / 行内 style 属性）
        body_missing = sorted(v for v in VAR_USE.findall(html) if v not in defs)
        if body_missing:
            problems.append('   未定义变量（页面正文）: %s' % ', '.join(body_missing))

        if problems:
            bad += 1
            print('[检查] %s' % p)
            print('\n'.join(problems))
        else:
            print('[OK]   %s' % p)

    # 共享层死关键帧：全站（所有外置 CSS + 所有页面）都无人引用才算死
    referenced = anim_names(shared)
    for _, text in all_css:
        referenced |= anim_names(text)
    for p in PAGES:
        referenced |= anim_names(style_blocks(read(p)))
        referenced |= anim_names(read(p))

    orphan_kf = sorted(shared_kf - referenced)
    if orphan_kf:
        bad += 1
        print('[检查] %s' % SHARED)
        print('   定义了但全站无人引用的关键帧（删掉引用后忘了删定义？）: %s'
              % ', '.join(orphan_kf))

    return bad


if __name__ == '__main__':
    sys.exit(1 if main() else 0)
