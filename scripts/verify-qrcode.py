#!/usr/bin/env python3
"""
qrcode.js 正确性验证 —— 与 Python 参考实现逐位比对矩阵。

## 为什么需要它

`vendor/qrcode.js` 是手写的 QR 编码器，而 QR 规范里有几张**抄错一位就全盘
皆输**的表（纠错分块表、对齐图案坐标）与一段极易写错的综合除法。肉眼 review
是看不出来的 —— 错的码字照样能画出一张"看着很像二维码"的图，只是扫不出来。

所以它必须被**逐位比对**：拿同样的内容、同样的版本、同样的掩码，让参考
实现（Python `qrcode`）生成一个矩阵，与本仓库的实现逐格比较。

## 为什么比对时固定掩码

掩码选择依赖"惩罚分"算法，各家实现细节略有差异（规范只给出四条规则，
具体计数边界有解释空间）。掩码不同会让整张图都不同，从而淹没真正的错误。
这里先用本实现选出的掩码，再让参考实现**强制使用同一掩码**，于是比对聚焦在
"数据编码 + 纠错码字 + 布局"这三件真正容易写错的事上。

## 为什么参考实现要传 bytes

Python `qrcode` 会自动挑模式：纯数字走 numeric、纯大写走 alphanumeric。
而本实现只做 byte 模式（设计取舍见 qrcode.js 文件头）。传 `bytes` 可以强制
参考实现也用 byte 模式，否则差异只是"编码模式不同"，不是 bug。

## 用法

    pip install qrcode
    python3 scripts/verify-qrcode.py
"""
import json
import os
import subprocess
import sys

try:
    import qrcode
    from qrcode.constants import (
        ERROR_CORRECT_L,
        ERROR_CORRECT_M,
        ERROR_CORRECT_Q,
        ERROR_CORRECT_H,
    )
except ImportError:
    sys.exit('缺少依赖：pip install qrcode')

LEVELS = {
    'L': ERROR_CORRECT_L,
    'M': ERROR_CORRECT_M,
    'Q': ERROR_CORRECT_Q,
    'H': ERROR_CORRECT_H,
}

# 自定位到仓库根：不要写死绝对路径，否则仓库克隆到别处会立刻失效
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE_SNIPPET = """
const QR = require('%s/vendor/qrcode.js');
const m = QR.matrix(process.argv[1], {ecl: process.argv[2]});
console.log(JSON.stringify({
  version: m.version, mask: m.mask, size: m.size,
  modules: m.modules.map(r => r.map(v => v ? 1 : 0)),
}));
""" % ROOT

# 覆盖：短链接 / 长链接 / 中文 / 各纠错级别 / 需要版本信息的高版本（>=7）
CASES = [
    ('https://example.com/s/abc123', 'M'),
    ('https://vault.example.com/s/q3-receipts', 'M'),
    ('https://k-vault.pages.dev/s/2024-annual-meeting-photos', 'M'),
    ('a' * 120, 'M'),
    ('https://ex.com/s/' + 'x' * 90, 'L'),
    ('https://ex.com/s/' + 'y' * 140, 'M'),
    ('分享测试 https://ex.com/s/中文', 'M'),
    ('short', 'H'),
    ('https://ex.com/s/' + 'z' * 60, 'Q'),
    ('https://ex.com/s/' + 'v' * 100, 'H'),
    ('https://k-vault.pages.dev/s/vacation-2025', 'L'),
]


def main():
    fails = 0
    for text, ecl in CASES:
        proc = subprocess.run(
            ['node', '-e', NODE_SNIPPET, text, ecl],
            capture_output=True, text=True, cwd=ROOT,
        )
        if proc.returncode != 0:
            print('NODE ERROR  %-40s %s' % (text[:38], proc.stderr.strip().splitlines()[-1]))
            fails += 1
            continue

        mine = json.loads(proc.stdout)
        qr = qrcode.QRCode(
            version=mine['version'],
            error_correction=LEVELS[ecl],
            box_size=1, border=0,
            mask_pattern=mine['mask'],
        )
        qr.add_data(text.encode('utf-8'))
        qr.make(fit=False)
        ref = [[1 if cell else 0 for cell in row] for row in qr.get_matrix()]

        if len(ref) != mine['size']:
            print('SIZE MISMATCH %-38s ref=%d mine=%d' % (text[:38], len(ref), mine['size']))
            fails += 1
            continue

        diff = sum(
            1
            for r in range(mine['size'])
            for c in range(mine['size'])
            if ref[r][c] != mine['modules'][r][c]
        )
        if diff:
            fails += 1
        print(
            '%s v%-2d-%s mask%d size%-3d diff=%-4d :: %s'
            % ('OK  ' if diff == 0 else 'DIFF', mine['version'], ecl,
               mine['mask'], mine['size'], diff, text[:38])
        )

    print('\n%d/%d 通过' % (len(CASES) - fails, len(CASES)))
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
