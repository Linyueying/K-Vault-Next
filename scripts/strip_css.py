#!/usr/bin/env python3
"""精确删除 HTML 内联 <style> 里的 CSS 块。

用法：
  python3 strip_css.py <file> "<spec>" ...

spec 语法：
  "marker"                删除以该行为起点、按花括号配平结束的一整个块
  "start>>end"            删除从含 start 的行到含 end 的行（含两端）
  "before=N:marker"       删除块时向前多带 N 行（通常是块上方的注释）

marker / start / end 都是「唯一子串」匹配。
"""
import sys, io, os


def find_line(lines, marker, start=0):
    for i in range(start, len(lines)):
        if marker in lines[i]:
            return i
    return -1


def block_end(lines, start):
    depth = 0
    for i in range(start, len(lines)):
        depth += lines[i].count('{') - lines[i].count('}')
        if depth == 0 and '{' in ''.join(lines[start:i + 1]):
            return i
    return -1


def strip(path, specs):
    with io.open(path, encoding='utf-8') as f:
        lines = f.read().split('\n')

    removed = []
    for spec in specs:
        before = 0
        if spec.startswith('before='):
            head, spec = spec.split(':', 1)
            before = int(head.split('=')[1])

        if '>>' in spec:
            to_block_end = spec.startswith('rblock:')
            if to_block_end:
                spec = spec[len('rblock:'):]
            a, b = spec.split('>>', 1)
            i = find_line(lines, a)
            if i < 0:
                print('  [MISS-A] %s :: %s' % (os.path.basename(path), a[:44]))
                continue
            j = find_line(lines, b, i + 1)
            if j < 0:
                print('  [MISS-B] %s :: %s' % (os.path.basename(path), b[:44]))
                continue
            if to_block_end and '{' in lines[j]:
                jb = block_end(lines, j)
                j = jb if jb >= 0 else j
            s, e = max(0, i - before), j
        else:
            i = find_line(lines, spec)
            if i < 0:
                print('  [MISS] %s :: %s' % (os.path.basename(path), spec[:44]))
                continue
            e = block_end(lines, i)
            if e < 0:
                print('  [BADBRACE] %s :: %s' % (os.path.basename(path), spec[:44]))
                continue
            s = max(0, i - before)

        removed.append((s + 1, e + 1, spec))
        del lines[s:e + 1]

    with io.open(path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))

    for s, e, m in removed:
        print('  [OK] %s :: %d-%d :: %s' % (os.path.basename(path), s, e, m[:52]))


if __name__ == '__main__':
    strip(sys.argv[1], sys.argv[2:])
