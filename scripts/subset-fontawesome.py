#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FontAwesome 子集化工具（scripts/subset-fontawesome.py）

背景
    项目全量引入 FontAwesome 6：all.min.css 约 100KB，webfonts 三个族共约 288KB。
    实际全站只用 100 多个图标，绝大多数 glyph 永远不会命中，属于纯浪费。

作用
    1. 扫描全部页面，收集真正用到的 fas / far / fab 图标名；
    2. 用 fontTools 把 fa-solid / fa-regular / fa-brands 三个 woff2 裁到只含这些 glyph；
    3. 重写 all.min.css：保留 @font-face、辅助类（fa-spin / fa-fw / fa-lg ...）、
       动画关键帧，以及被用到的图标 content 规则，删掉其余上千条图标规则。

可重复执行
    首次运行会把原始完整 CSS 备份为 all.min.css.full，之后每次运行都从 .full 读取，
    因此增删图标后重跑本脚本即可，不会因反复裁剪而丢失可用图标。

依赖
    pip3 install fonttools brotli
"""
import os
import re
import sys
import glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSS_MIN = os.path.join(ROOT, "vendor", "fontawesome", "css", "all.min.css")
CSS_FULL = CSS_MIN + ".full"          # 原始完整版（首次运行时备份）
WEBFONTS = os.path.join(ROOT, "vendor", "fontawesome", "webfonts")

# 需要扫描的页面（新增页面时补到这里）
PAGE_GLOBS = ["*.html", "demo/*.html"]

# 族前缀 -> 字体文件
FAMILY_FONTS = {
    "fas": "fa-solid-900.woff2",
    "far": "fa-regular-400.woff2",
    "fab": "fa-brands-400.woff2",
}
FAMILY_ALIAS = {
    "fas": "fas", "fa-solid": "fas",
    "far": "far", "fa-regular": "far",
    "fab": "fab", "fa-brands": "fab",
}

# 已知的「页面写了、但 FontAwesome 6 里并不存在」的图标名。
# 这些图标在页面上本来就渲染不出来（空白方块），子集化时跳过它们，
# 同时 --check 模式会提醒去修正 HTML。
KNOWN_MISSING = set()


def log(msg):
    sys.stdout.write(msg + "\n")


def human(n):
    for unit in ("B", "KB", "MB"):
        if n < 1024 or unit == "MB":
            return "%.1f%s" % (n, unit) if unit != "B" else "%d%s" % (n, unit)
        n /= 1024.0


def read_source_css():
    """优先读原始完整版，保证可重复执行。"""
    if os.path.exists(CSS_FULL):
        return open(CSS_FULL, encoding="utf-8").read(), CSS_FULL
    return open(CSS_MIN, encoding="utf-8").read(), CSS_MIN


def parse_codepoints(css):
    """解析 CSS，返回 {图标名: 码位字符串}。

    FontAwesome 的别名是多个选择器共享一条 content 规则，例如
        .fa-home-alt:before,.fa-home:before,.fa-house:before{content:"\\f015"}
    所以要把选择器组拆开逐个登记。
    """
    table = {}
    for m in re.finditer(r'([^{}]+)\{content:"\\([0-9a-fA-F]+)"\}', css):
        code = m.group(2)
        for sel in m.group(1).split(","):
            sel = sel.strip()
            mm = re.match(r"^\.fa-([\w-]+):before$", sel)
            if mm:
                table[mm.group(1)] = code
    return table


def collect_used_icons():
    """扫描页面，返回 {族: set(图标名)}。"""
    used = {"fas": set(), "far": set(), "fab": set()}
    files = []
    for pattern in PAGE_GLOBS:
        files.extend(sorted(glob.glob(os.path.join(ROOT, pattern))))
    for path in files:
        src = open(path, encoding="utf-8").read()
        # 形如 "fas fa-cloud"、"fab fa-github"，也可能是 JS 里拼接的字符串
        for m in re.finditer(r"\b(fas|far|fab|fa-solid|fa-regular|fa-brands)\s+fa-([\w-]+)", src):
            used[FAMILY_ALIAS[m.group(1)]].add(m.group(2))
    return used


def prune_css(css, keep_names):
    """删掉未被使用的图标 content 规则，其余内容（@font-face / 辅助类 / keyframes）原样保留。"""

    kept = {"n": 0}

    def repl(m):
        selectors, body = m.group(1), m.group(0)
        for sel in selectors.split(","):
            sel = sel.strip()
            mm = re.match(r"^\.fa-([\w-]+):before$", sel)
            if mm and mm.group(1) in keep_names:
                kept["n"] += 1
                return body
        return ""

    pruned, total = re.subn(r'([^{}]+)\{content:"\\([0-9a-fA-F]+)"\}', repl, css)
    return pruned, total, kept["n"]


def subset_font(filename, codepoints):
    """调用 fontTools 裁剪单个 woff2，返回 (裁剪前大小, 裁剪后大小)。"""
    from fontTools.subset import main as pyftsubset

    src = os.path.join(WEBFONTS, filename)
    tmp = src + ".subset"
    if not codepoints:
        return os.path.getsize(src), None
    unicodes = ",".join("U+%s" % cp.upper() for cp in sorted(codepoints))
    args = [
        src,
        "--unicodes=%s" % unicodes,
        "--flavor=woff2",
        "--output-file=%s" % tmp,
        "--no-hinting",          # 图标字形不需要 hinting
        "--layout-features=",    # 图标走 PUA 直映射，不需要 OpenType 特性表
        "--name-IDs=0,1,2,3,4,5,6",
        "--notdef-outline",
    ]
    pyftsubset(args)
    before = os.path.getsize(src)
    after = os.path.getsize(tmp)
    os.replace(tmp, src)
    return before, after


def main():
    check_only = "--check" in sys.argv
    css, src_path = read_source_css()
    log("读取源 CSS: %s (%s)" % (os.path.relpath(src_path, ROOT), human(len(css))))

    codepoints = parse_codepoints(css)
    used = collect_used_icons()

    missing = set()
    plan = {}
    for fam, names in used.items():
        cps = set()
        for name in names:
            if name in codepoints:
                cps.add(codepoints[name])
            elif name not in KNOWN_MISSING:
                missing.add((fam, name))
        plan[fam] = cps
        log("  %s 用到 %d 个图标 -> %d 个码位" % (fam, len(names), len(cps)))

    if missing:
        log("")
        log("!! 以下图标名在 FontAwesome 6 中不存在（页面会渲染成空白），请修正 HTML：")
        for fam, name in sorted(missing):
            log("   %s fa-%s" % (fam, name))
        if check_only:
            return 1

    all_keep = set()
    for fam, names in used.items():
        all_keep |= {n for n in names if n in codepoints}

    if check_only:
        log("")
        log("仅检查模式，未写文件。")
        return 0

    # 首次运行：备份原始完整版，供后续重复执行使用
    if not os.path.exists(CSS_FULL):
        with open(CSS_FULL, "w", encoding="utf-8") as f:
            f.write(css)
        log("")
        log("已备份原始完整 CSS -> %s" % os.path.relpath(CSS_FULL, ROOT))

    pruned, total, kept = prune_css(css, all_keep)
    log("")
    log("CSS 图标规则：共 %d 条，保留 %d 条；文件 %s -> %s" % (
        total, kept, human(len(css)), human(len(pruned))))
    with open(CSS_MIN, "w", encoding="utf-8") as f:
        f.write("/*! 本文件由 scripts/subset-fontawesome.py 自动生成（源：all.min.css.full），请勿手工编辑。 */\n")
        f.write(pruned)

    log("")
    for fam, fontfile in FAMILY_FONTS.items():
        before, after = subset_font(fontfile, plan.get(fam) or set())
        if after is None:
            log("   %-22s 未使用，跳过" % fontfile)
        else:
            log("   %-22s %s -> %s  (省 %s)" % (
                fontfile, human(before), human(after), human(before - after)))

    total_before = sum(os.path.getsize(os.path.join(WEBFONTS, f)) for f in os.listdir(WEBFONTS))
    log("")
    log("webfonts 目录当前总计: %s" % human(total_before))
    return 0


if __name__ == "__main__":
    sys.exit(main())
