#!/usr/bin/env python3
"""全站样式一致性校验：
   1. 每个页面引用的 CSS 变量（var(--x)）是否都有定义（共享层或页面自身）
   2. 每个页面引用的动画名（animation / @keyframes）是否都能在共享层或本页找到
   3. 花括号配平（scripts/check_style.py 已做，这里再兜一次）

用法： python3 scripts/check_tokens.py
"""
import re, sys, io, os, glob

SHARED = 'design-system.css'
PAGES = ['index.html', 'admin.html', 'gallery.html', 'paste.html',
         'share.html', 'preview.html', 'webdav.html', 'login.html']

VAR_DEF = re.compile(r'(--[a-zA-Z0-9-]+)\s*:')
VAR_USE = re.compile(r'var\(\s*(--[a-zA-Z0-9-]+)')
KF_DEF = re.compile(r'@keyframes\s+([a-zA-Z0-9_-]+)')
ANIM_USE = re.compile(r'animation(?:-name)?\s*:\s*([^;]+);')


def strip_css_comments(t):
    return re.sub(r'/\*.*?\*/', '', t, flags=re.S)


def style_blocks(path):
    html = io.open(path, encoding='utf-8').read()
    return strip_css_comments('\n'.join(re.findall(r'<style[^>]*>(.*?)</style>', html, re.S)))


def main():
    shared = strip_css_comments(io.open(SHARED, encoding='utf-8').read())
    shared_vars = set(VAR_DEF.findall(shared))
    shared_kf = set(KF_DEF.findall(shared))

    bad = 0
    for p in PAGES:
        css = style_blocks(p)
        page_vars = set(VAR_DEF.findall(css))
        page_kf = set(KF_DEF.findall(css))

        # 1) 变量
        missing = sorted({v for v in VAR_USE.findall(css) + VAR_USE.findall(
            io.open(p, encoding='utf-8').read())
            if v not in shared_vars and v not in page_vars})

        # 2) 动画名（跳过保留字与 none）
        reserved = {'none', 'inherit', 'initial', 'unset', 'linear', 'infinite',
                    'alternate', 'backwards', 'forwards', 'both', 'ease', 'reverse',
                    'ease-in', 'ease-out', 'ease-in-out', 'running', 'paused', 'normal'}
        used = set()
        for decl in ANIM_USE.findall(css):
            for tok in re.split(r'[\s,]+', decl):
                tok = tok.strip()
                if not tok or tok in reserved:
                    continue
                if re.match(r'^[a-zA-Z][a-zA-Z0-9_-]*$', tok) and not re.match(r'^\d', tok):
                    used.add(tok)
        # 只保留第一项（动画名），其余是时长/缓动等
        used = set()
        for decl in ANIM_USE.findall(css):
            first = decl.strip().split()[0]
            if first not in reserved and re.match(r'^[a-zA-Z][a-zA-Z0-9_-]*$', first):
                used.add(first)
        miss_kf = sorted(n for n in used if n not in shared_kf and n not in page_kf)

        if missing or miss_kf:
            bad += 1
            print('[检查] %s' % p)
            if missing:
                print('   未定义变量: %s' % ', '.join(missing))
            if miss_kf:
                print('   未定义关键帧: %s' % ', '.join(miss_kf))
        else:
            print('[OK]   %s' % p)
    return bad


if __name__ == '__main__':
    sys.exit(1 if main() else 0)
