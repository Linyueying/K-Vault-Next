#!/usr/bin/env python3
"""校验 functions/ 下的 Cloudflare Functions：语法 + 未定义符号。

为什么需要这个脚本
------------------
`functions/` 里的模块是 ESM。调用了一个**忘记 import** 的函数时，Node 的语法
检查（`node --check`）**不会**报错——它只查语法，不做标识符解析；Wrangler
本地 dev 也不会在教学式地提前失败，只在**真正请求到那条分支**时才抛
`ReferenceError`，返回 500。

真实事故（commit e8150bb 引入，直到本次才发现）：
  `functions/api/status.js` 调用了 `isAuthRequired(env)`，但该文件只 import 了
  `checkAuthentication`。结果是 `/api/status` 全量 500 —— 前端 `checkStorageTarget()`
  拿不到任何后端状态，`r2Available` 恒为 false，表现为「R2 明明绑好了却提示未配置」。
  同一个提交改的 `upload.js` / `upload-from-url.js` 都正确 import 了，只有这个文件漏了。

本脚本做两件事：
  1. `node --check` 全部 .js —— 抓语法错误。
  2. 轻量标识符解析 —— 对每个模块，找出「被当作函数调用、但既没有 import 进来、
     也不是本地声明（function/const/let/var/class）、也不是参数/解构、也不是
     全局内置」的名字，判定为疑似未定义符号。

第 2 步是启发式的（不引入 acorn/eslint 这类依赖），目标是拦住「漏 import」这一类
高频错误，而不是做完整的类型分析。若确有刻意为之的动态引用，可在该行写
`// check_functions: ignore` 豁免。

用法： python3 scripts/check_functions.py [file ...]
      不带参数时递归扫描 functions/ 下全部 .js
"""
import io
import os
import re
import subprocess
import sys
import glob


# JS 内置 / 运行时全局（Cloudflare Workers + 通用语言内置）。
# 这些不需要 import，出现在调用位置是合法的。
BUILTINS = {
    # 语言内置
    'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
    'Function', 'Promise', 'Proxy', 'Reflect', 'Date', 'RegExp', 'Error',
    'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError',
    'URIError', 'AggregateError', 'Map', 'Set', 'WeakMap', 'WeakSet',
    'WeakRef', 'FinalizationRegistry', 'ArrayBuffer', 'SharedArrayBuffer',
    'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array',
    'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array',
    'BigInt64Array', 'BigUint64Array', 'JSON', 'Math', 'Intl', 'Atomics',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'decodeURI',
    'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'eval',
    'escape', 'unescape',
    'structuredClone', 'queueMicrotask', 'setTimeout', 'clearTimeout',
    'setInterval', 'clearInterval', 'console',
    # Web / Workers 平台全局
    'fetch', 'Request', 'Response', 'Headers', 'FormData', 'Blob', 'File',
    'URL', 'URLSearchParams', 'AbortController', 'AbortSignal', 'TextEncoder',
    'TextDecoder', 'crypto', 'btoa', 'atob', 'ReadableStream',
    'WritableStream', 'TransformStream', 'ByteLengthQueuingStrategy',
    'CountQueuingStrategy', 'caches', 'self', 'globalThis', 'process',
    'Buffer', 'crypto', 'navigator', 'location', 'WebSocket',
}


def extract_imported_names(src):
    """收集所有 import 语句绑定的名字（含 default / namespace / 具名 / 别名）。"""
    names = set()

    # import default, { a, b as c } from '...'
    # import * as ns from '...'
    # import { a } from '...'
    for m in re.finditer(r'\bimport\b([^;]*?)\bfrom\b', src, re.S):
        clause = m.group(1)

        # 具名部分 { a, b as c }
        for brace in re.finditer(r'\{([^}]*)\}', clause, re.S):
            for part in brace.group(1).split(','):
                part = part.strip()
                if not part:
                    continue
                if ' as ' in part:
                    names.add(part.split(' as ')[-1].strip())
                else:
                    names.add(part)
            # 去掉具名段，剩下的才是 default / namespace
            clause = clause.replace(brace.group(0), ' ')

        # * as ns
        for ns in re.finditer(r'\*\s*as\s+([A-Za-z_$][\w$]*)', clause):
            names.add(ns.group(1))
            clause = clause.replace(ns.group(0), ' ')

        # 剩余裸标识符 = default import
        for d in re.finditer(r'(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?=,|$)', clause):
            names.add(d.group(1))

    return {n for n in names if n}


def extract_declared_names(src):
    """收集本地声明的名字：function / class / const / let / var / 解构。"""
    names = set()

    for m in re.finditer(
        r'\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)', src
    ):
        names.add(m.group(1))

    for m in re.finditer(r'\bclass\s+([A-Za-z_$][\w$]*)', src):
        names.add(m.group(1))

    # const/let/var 后面可能是「标识符」或「解构模式」
    for m in re.finditer(r'\b(?:const|let|var)\s+([^;=\n]+)', src):
        decl = m.group(1)
        # 具名解构 { a, b: c }
        for brace in re.finditer(r'\{([^}]*)\}', decl, re.S):
            for part in brace.group(1).split(','):
                part = part.strip()
                if ':' in part:
                    names.add(part.split(':')[-1].strip())
                elif part and re.match(r'^[A-Za-z_$][\w$]*$', part):
                    names.add(part)
            decl = decl.replace(brace.group(0), ' ')
        # 数组解构 [a, b]
        for br in re.finditer(r'\[([^\]]*)\]', decl, re.S):
            for part in br.group(1).split(','):
                part = part.strip()
                if re.match(r'^[A-Za-z_$][\w$]*$', part):
                    names.add(part)
            decl = decl.replace(br.group(0), ' ')
        # 裸标识符
        for d in re.finditer(r'^\s*([A-Za-z_$][\w$]*)\s*$', decl):
            names.add(d.group(1))

    # 解构赋值：const { a } = ... 已在上面覆盖
    # 函数参数与箭头函数参数
    for m in re.finditer(r'\(([^()]*)\)\s*(?:=>|\{)', src):
        params = m.group(1)
        if len(params) > 300:
            continue
        for part in params.split(','):
            part = part.strip()
            # 去掉默认值 / 剩余参数 / 类型式写法
            part = part.split('=')[0].strip().lstrip('.').strip()
            if ':' in part:
                part = part.split(':')[-1].strip()
            if re.match(r'^[A-Za-z_$][\w$]*$', part):
                names.add(part)

    # 单个未加括号的参数：async x => ...  / x => ...
    for m in re.finditer(r'(?:^|[,(=\s])([A-Za-z_$][\w$]*)\s*=>', src):
        names.add(m.group(1))

    # catch (e) / for (const x of ...) / for (const [k,v] of ...)
    for m in re.finditer(r'\bcatch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)', src):
        names.add(m.group(1))

    # 对象的简写方法/属性也常与同名函数混淆，这里不处理（启发式够用）

    return {n for n in names if n}


def find_suspect_calls(path, src):
    """找出「被调用但未声明」的标识符。

    只检查 `name(` 形式，且排除：
      - 前面是 . 的（成员调用 obj.method()）
      - 前面是关键字 new / typeof / function 等
      - 前面是标识符字符的（aFunctionCall）
    """
    problems = []
    declared = extract_declared_names(src)
    imported = extract_imported_names(src)
    known = declared | imported | BUILTINS

    lines = src.split('\n')
    seen = set()
    in_template = False

    for idx, line in enumerate(lines, 1):
        # 注释行整行跳过
        stripped = line.strip()
        if stripped.startswith('//') or stripped.startswith('*') or stripped.startswith('/*'):
            continue
        if 'check_functions: ignore' in line:
            continue

        # 去掉行内 // 注释（简单处理，避免把 URL 里的 :// 误判）
        code = re.sub(r'(?<!:)//.*$', '', line)

        # 去掉字符串 / 模板字面量，避免把文案里的 "xxx(" 当成调用
        code = re.sub(r'`[^`]*`', '``', code)
        code = re.sub(r"'[^']*'", "''", code)
        code = re.sub(r'"[^"]*"', '""', code)
        # 正则字面量：/.../flags —— 里面的 (...) 不是函数调用
        code = re.sub(r'(?<![\w)\]])/(?:\\.|\[[^\]]*\]|[^/\n\\])+/[gimsuy]*', '/RE/', code)
        # 去掉 `${...}` 的残余与对象字面量的裸键
        code = re.sub(r'\b(constructor|get|set)\s*\(', ' ', code)

        # 类方法定义：`name(args) {` 或 `name(args);` 出现在类体里，
        # 它们不是「调用」而是「声明」。用一个简单的先前是否处于
        # class 体的启发式——只要该行是 `  name(...` 且行尾不是 `)` 收尾的调用，
        # 就跳过。这里用更粗暴但可靠的办法：匹配 `^\s*(static\s+)?(async\s+)?name\s*\(`
        # 且整行以 `{` 结尾的，认定为方法定义。
        if re.match(r'^\s*(static\s+)?(async\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{\s*$', code):
            continue

        # 处于多行模板字符串（GraphQL query 等）内部的行整体跳过
        if in_template:
            if '`' in code:
                in_template = False
            continue
        if code.count('`') % 2 == 1:
            in_template = True
            continue

        for m in re.finditer(r'(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(', code):
            name = m.group(1)

            # 关键字
            if name in ('if', 'for', 'while', 'switch', 'catch', 'return',
                        'typeof', 'instanceof', 'new', 'delete', 'void', 'in',
                        'of', 'do', 'else', 'function', 'await', 'yield',
                        'case', 'throw', 'class', 'extends', 'super', 'this',
                        'async'):
                continue

            # 形如 `key: value(` 的对象字面量属性名 / `key(` 的简写方法，
            # 以及 `.catch(...)` 之类，都是合法成员，跳过。
            before = code[:m.start(1)].rstrip()
            if re.search(r'\b(new|typeof|void|delete|instanceof|await|yield)\s*$', before):
                continue
            # 前一非空字符是 { , : 或 => 时，几乎都是对象简写方法/属性
            if before and before[-1] in '{,:':
                continue
            if re.search(r'=>\s*$', before):
                continue

            if name in known:
                continue

            key = (idx, name)
            if key in seen:
                continue
            seen.add(key)
            problems.append((idx, name))

    return problems


def check_file(path):
    problems = []

    with io.open(path, encoding='utf-8') as f:
        src = f.read()

    # 语法检查
    r = subprocess.run(
        ['node', '--check', path],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    if r.returncode != 0:
        problems.append('node --check 失败:\n%s' % r.stdout.strip())

    # 未定义符号检查
    for line, name in find_suspect_calls(path, src):
        problems.append('第 %d 行疑似未定义符号 `%s`（忘记 import？）'
                        % (line, name))

    return problems


def main(paths):
    bad = 0
    for p in paths:
        problems = check_file(p)
        # 只对有问题或 functions/ 下的文件输出，保持简洁
        if problems:
            bad += 1
            print('[检查] %s' % p)
            for x in problems:
                print('   - %s' % x)

    if not bad:
        print('[OK]   functions/ 全部通过（语法 + 符号解析）')
    return bad


if __name__ == '__main__':
    args = sys.argv[1:]
    if not args:
        args = sorted(glob.glob('functions/**/*.js', recursive=True))
    sys.exit(1 if main(args) else 0)
