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
    首次运行会把原始完整 CSS 备份为 all.min.css.full、把原始完整字体备份为
    *.woff2.full，之后每次运行都从 .full 读取，因此增删图标后重跑本脚本即可，
    不会因反复裁剪而丢失字形。

    注意：裁剪是有损的。若 .full 缺失、而当前字体已是子集，脚本会判定「原版
    不可用」并跳过该族（保留现有文件），避免用子集当源而静默丢字形。

已知限制
    fa-regular-400.woff2.full 在仓库中缺失：历史上的那次本地化提交里，regular
    族的原始字体已损坏（glyf 表不完整），无法作为裁剪源。当前 regular 子集只含
    页面实际用到的 fa-clock / fa-bookmark 两个字形，够用；若日后要给页面新增
    far 图标，需先从 FontAwesome 6.4.2 官方包取回完好的 fa-regular-400.woff2，
    存为 vendor/fontawesome/webfonts/fa-regular-400.woff2.full 再重跑本脚本。

    （不要用 npm 上更新的 @fortawesome/fontawesome-free 顶替：本项目锁定
    6.4.2，7.x 的码位与 6.4.2 有出入，混用会导致图标错位。）

依赖
    pip3 install fonttools brotli
"""
import os
import re
import sys
import glob
import shutil

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
# 各族「完整原版」至少应有的码位数（真实值远大于此）。
# 用途：当 *.woff2.full 缺失时，判断当前文件到底是完整原版还是已被裁剪的子集——
# 只有前者才适合当裁剪源，把子集当源会静默丢掉本就不在其中的字形。
FAMILY_MIN_CODEPOINTS = {"fas": 500, "far": 50, "fab": 200}
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


def codepoint_count(path):
    """返回字体包含的码位数；文件损坏/不可读时返回 -1。"""
    from fontTools.ttLib import TTFont
    try:
        return len(TTFont(path).getBestCmap())
    except Exception:
        return -1


def font_source(family, filename):
    """返回裁剪用的源字体路径；源不可用时返回 None。

    优先读 *.woff2.full（原始完整字体）。若不存在，说明是首次运行：
    仅当当前文件看起来是「完整原版」时才把它备份为 .full —— 与 CSS 的
    all.min.css.full 同一套「原版留档」策略。

    为什么必须留档：裁剪是有损的，从一个已裁剪的字体再裁不可能找回
    丢掉的字形。若源本身已是子集（或已损坏），返回 None 交由调用方跳过，
    宁可保留现有文件并告警，也不要产出静默缺字形的字体。
    """
    cur = os.path.join(WEBFONTS, filename)
    full = cur + ".full"
    if os.path.exists(full):
        return full if codepoint_count(full) > 0 else None
    if codepoint_count(cur) < FAMILY_MIN_CODEPOINTS.get(family, 0):
        return None
    shutil.copyfile(cur, full)
    return full


def subset_font(family, filename, codepoints):
    """调用 fontTools 裁剪单个 woff2，返回 (裁剪前大小, 裁剪后大小)。

    源不可用时返回 (None, None)，由 main 打印告警并保留现有文件。
    """
    from fontTools.subset import main as pyftsubset

    src = font_source(family, filename)
    if src is None or not codepoints:
        return None, None
    dst = os.path.join(WEBFONTS, filename)
    tmp = dst + ".subset"
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
    os.replace(tmp, dst)
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
        cps = plan.get(fam) or set()
        if not cps:
            log("   %-22s 未使用，跳过" % fontfile)
            continue
        try:
            before, after = subset_font(fam, fontfile, cps)
        except Exception as e:
            log("   %-22s 裁剪失败（%s），保留现有文件" % (fontfile, e))
            continue
        if before is None:
            log("   %-22s 原版不可用（无 %s.full 且当前文件已是子集），保留现有文件"
                % (fontfile, fontfile))
            continue
        log("   %-22s %s -> %s  (省 %s)" % (
            fontfile, human(before), human(after), human(before - after)))

    total_before = sum(
        os.path.getsize(os.path.join(WEBFONTS, f))
        for f in os.listdir(WEBFONTS)
        if not f.endswith((".full", ".subset"))
    )
    log("")
    log("webfonts 目录当前总计: %s" % human(total_before))
    return 0


if __name__ == "__main__":
    sys.exit(main())
