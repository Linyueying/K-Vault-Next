"""修复后的功能回归：确认选择/取消/批量入口都还正常，且新增的过渡与弱化态生效。"""
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8123"
CHROME = "/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome"

SEED = """
() => {
  const a = document.querySelector('#app')._vnode.component.proxy;
  a.uploadedFiles = [1,2,3].map(i => ({
    url: 'https://example.invalid/file/f'+i, name:'f'+i+'.png', size:1024*i, selected:false,
  }));
  return a.uploadedFiles.length;
}
"""

STATE = """
() => {
  const a = document.querySelector('#app')._vnode.component.proxy;
  const bar = document.querySelector('.selection-bar');
  const info = document.querySelector('.selection-bar__info');
  const cnt = document.querySelector('.selection-bar__count');
  return {
    mode: a.resultSelectMode,
    n: a.selectedCount,
    barVisible: !!bar,
    empty: bar ? bar.classList.contains('selection-bar--empty') : null,
    infoText: info ? info.textContent.replace(/\\s+/g, ' ').trim() : '',
    hasCountSpan: !!cnt,
    countText: cnt ? cnt.textContent.trim() : '',
    checks: document.querySelectorAll('.row .check').length,
    rowActs: document.querySelectorAll('.row .row__actions').length,
    buttons: [...document.querySelectorAll('.result-actions__group .text-btn')].map(b => b.textContent.trim()).join('|'),
    disabledCount: document.querySelectorAll('.selection-bar .btn:disabled').length,
  };
}
"""

results = []


def check(name, cond, detail=""):
    results.append((name, cond, detail))
    print(f"  [{'PASS' if cond else 'FAIL'}] {name}" + (f"  {detail}" if detail else ""))


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
        pg = b.new_page(viewport={"width": 390, "height": 844})
        errs, warns = [], []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: warns.append(m.text) if m.type in ("warning", "error") else None)
        pg.goto(f"{BASE}/index.html", wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_function("() => document.querySelector('#app')?._vnode?.component?.proxy", timeout=30000)
        pg.evaluate(SEED)
        pg.wait_for_timeout(300)

        print("\n① 初始（非选择模式）")
        s = pg.evaluate(STATE)
        check("不在选择模式", s["mode"] is False, str(s))
        check("底栏不存在", s["barVisible"] is False)
        check("行内「…」菜单可见", s["rowActs"] == 3, f"rowActs={s['rowActs']}")
        check("按钮为 [选择|清空]", s["buttons"] == "选择|清空", s["buttons"])

        print("\n② 点「选择」进入多选")
        pg.click(".result-actions__group .text-btn:has-text('选择')")
        pg.wait_for_timeout(750)
        s = pg.evaluate(STATE)
        check("进入选择模式", s["mode"] is True)
        check("底栏出现", s["barVisible"] is True)
        check("复选框出现", s["checks"] == 3, f"checks={s['checks']}")
        check("按钮切换为 [全选|完成]", s["buttons"] == "全选|完成", s["buttons"])
        check("计数 span 已挂载", s["hasCountSpan"] is True)
        check("0 项时带弱化 class", s["empty"] is True, f"empty={s['empty']}")
        check("文案为「已选 0 项」", s["infoText"] == "已选 0 项", s["infoText"])
        check("0 项时 5 个按钮全部置灰", s["disabledCount"] == 5, f"disabled={s['disabledCount']}")

        print("\n③ 勾选 1 项")
        pg.click(".row >> nth=0")
        pg.wait_for_timeout(450)
        s = pg.evaluate(STATE)
        check("计数为 1", s["n"] == 1 and s["countText"] == "1", f"n={s['n']} text={s['countText']}")
        check("文案为「已选 1 项」", s["infoText"] == "已选 1 项", s["infoText"])
        check("弱化 class 移除", s["empty"] is False, f"empty={s['empty']}")
        check("按钮恢复可用", s["disabledCount"] < 5, f"disabled={s['disabledCount']}")

        print("\n④ 取消勾选归零")
        pg.click(".row >> nth=0")
        pg.wait_for_timeout(450)
        s = pg.evaluate(STATE)
        check("计数归零", s["n"] == 0 and s["countText"] == "0", f"n={s['n']}")
        check("仍停留在多选模式（不横跳）", s["mode"] is True)
        check("底栏原地保留", s["barVisible"] is True)
        check("重新带弱化 class", s["empty"] is True, f"empty={s['empty']}")

        print("\n⑤ 点「完成」退出")
        pg.click(".result-actions__group .text-btn:has-text('完成')")
        pg.wait_for_timeout(800)
        s = pg.evaluate(STATE)
        check("退出选择模式", s["mode"] is False)
        check("底栏已卸载", s["barVisible"] is False)
        check("行内「…」菜单回来", s["rowActs"] == 3, f"rowActs={s['rowActs']}")
        check("按钮回到 [选择|清空]", s["buttons"] == "选择|清空", s["buttons"])

        print("\n⑥ 再次进入（往返正常）")
        pg.click(".result-actions__group .text-btn:has-text('选择')")
        pg.wait_for_timeout(750)
        s = pg.evaluate(STATE)
        check("可重复进入", s["mode"] is True and s["barVisible"] is True)

        print("\n⑦ 「全选」仍可用")
        pg.click(".result-actions__group .text-btn:has-text('全选')")
        pg.wait_for_timeout(450)
        s = pg.evaluate(STATE)
        check("全选生效（3 项）", s["n"] == 3, f"n={s['n']}")

        # 行内菜单可用性
        pg.click(".result-actions__group .text-btn:has-text('完成')")
        pg.wait_for_timeout(800)
        pg.click(".row .row__actions .btn--icon >> nth=0")
        pg.wait_for_timeout(450)
        menuOpen = pg.evaluate("() => !!document.querySelector('.panel .menu')")
        check("行内「…」菜单能打开", menuOpen is True)

        print("\n控制台:", "无报错" if not errs and not warns else "")
        for e in errs:
            print("  pageerror:", e)
        for w in warns:
            print("  warn:", w)
        check("无 JS 报错 / 无 Vue 警告", not errs and not warns)

        b.close()

    bad = [r for r in results if not r[1]]
    print(f"\n=========== 汇总：{len(results) - len(bad)}/{len(results)} 通过 ===========")
    if bad:
        for n, _, d in bad:
            print("  ❌", n, d)
        raise SystemExit(1)
    print("全部通过 ✅")


main()
