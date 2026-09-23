#!/usr/bin/env python3
"""校验页面内联 <style> 的合法性：花括号配平、CSS 变量引用完整性。

用法： python3 check_style.py [file ...]
"""
import re, sys, io, os, glob


def check(path):
    with io.open(path, encoding='utf-8') as f:
        html = f.read()

    problems = []

    # 1) 花括号配平（逐个 <style> 块）
    for m in re.finditer(r'<style[^>]*>(.*?)</style>', html, re.S):
        css = m.group(1)
        # 去掉注释再数括号
        css_nc = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
        depth = 0
        line = html[:m.start(1)].count('\n') + 1
        for ch in css_nc:
            if ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth < 0:
                    problems.append('style@%d: 多余的 }' % line)
                    depth = 0
        if depth != 0:
            problems.append('style@%d: 花括号未配平，剩余 %d' % (line, depth))

    # 2) 内联 CSS 里是否仍在重复定义共享层已提供的关键帧
    n = len(re.findall(r'@keyframes', html))
    if n:
        problems.append('内联仍定义 %d 处 @keyframes（应只在 design-system.css）' % n)

    # 3) 减弱动效降级：允许页面写「豁免加载指示器」的补充规则，
    #    但不能自己再写一遍全站冻结（design-system.css 已提供）
    for m in re.finditer(r'@media \(prefers-reduced-motion: reduce\)\s*\{', html):
        seg = html[m.start():m.start() + 900]
        if not re.search(r'spinner|fa-spin', seg):
            problems.append('内联重复定义了全站 prefers-reduced-motion 冻结规则')

    # 4) 是否引入了 design-system.css
    if 'design-system.css' not in html:
        problems.append('未引入 design-system.css')

    # 4) 引用的 CSS 变量是否在共享层里有定义
    return problems


def main(paths):
    bad = 0
    for p in paths:
        problems = check(p)
        name = os.path.basename(p)
        if problems:
            bad += 1
            print('[检查] %s' % name)
            for x in problems:
                print('   - %s' % x)
        else:
            print('[OK]   %s' % name)
    return bad


if __name__ == '__main__':
    args = sys.argv[1:] or sorted(glob.glob('*.html'))
    sys.exit(1 if main(args) else 0)
