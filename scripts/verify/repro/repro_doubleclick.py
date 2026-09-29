"""验证核心假设：退场（leave）动画进行中的 DOM 节点仍占位且可点击
→ 用户在旧位置上再点一次会把已退出的选择模式重新唤起，形成「消失→闪回」抽搐。
"""
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8123"
CHROME = "/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome"

SAMPLER = """
() => {
  const proxy = () => document.querySelector('#app')._vnode.component.proxy;
  const snap = () => {
    const a = proxy();
    const bar = document.querySelector('.selection-bar');
    const collapse = bar ? bar.closest('.collapse') : null;
    // 用真实坐标做命中测试，模拟用户手指落到这个点
    let hit = null;
    if (window.__pt) {
      const el = document.elementFromPoint(window.__pt.x, window.__pt.y);
      hit = el ? (el.textContent || '').trim().slice(0, 10) : 'null';
    }
    return {
      t: Math.round(performance.now()),
      mode: a.resultSelectMode,
      cnt: a.selectedCount,
      h: collapse ? Math.round(collapse.getBoundingClientRect().height) : null,
      checks: document.querySelectorAll('.row .check').length,
      btns: [...document.querySelectorAll('.result-actions__group .text-btn')].map(b => b.textContent.trim()).join('|'),
      hit,
    };
  };
  window.__sample = async (ms) => {
    const out = []; const t0 = performance.now();
    await new Promise((res) => {
      const tick = () => { out.push(snap()); if (performance.now() - t0 < ms) requestAnimationFrame(tick); else res(); };
      requestAnimationFrame(tick);
    });
    return out;
  };
}
"""

SEED = """
() => {
  const a = document.querySelector('#app')._vnode.component.proxy;
  a.uploadedFiles = [1,2,3].map(i => ({
    url: 'https://example.invalid/file/d'+i, name:'d'+i+'.png', size:1024*i, selected:false,
  }));
  a.resultSelectMode = true;
  a.uploadedFiles[0].selected = true;
  return true;
}
"""


def report(name, frames):
    print(f"\n=========== {name} ===========")
    seen = set()
    for f in frames:
        k = (f["mode"], f["cnt"], f["h"], f["checks"], f["btns"])
        if k in seen:
            continue
        seen.add(k)
        print(
            f"  t={f['t']:>6} mode={str(f['mode']):>5} cnt={f['cnt']} barH={f['h']} "
            f"check={f['checks']} btns=[{f['btns']}] hitTest={f['hit']}"
        )
    seq = []
    for f in frames:
        if not seq or seq[-1] != f["mode"]:
            seq.append(f["mode"])
    hs = []
    for f in frames:
        if not hs or hs[-1] != f["h"]:
            hs.append(f["h"])
    print("  >> mode 序列:", " -> ".join("T" if x else "F" for x in seq))
    print("  >> 底栏高度 :", " -> ".join(str(x) for x in hs))
    flip = sum(1 for i in range(1, len(seq)) if seq[i] != seq[i - 1])
    print("  >> 判定:", "❌ 复现「退出→闪回」抽搐" if flip > 1 else f"无抖动(flip={flip})")
    return flip


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
        pg = b.new_page(viewport={"width": 390, "height": 844})
        pg.goto(f"{BASE}/index.html", wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_function("() => document.querySelector('#app')?._vnode?.component?.proxy", timeout=30000)
        pg.evaluate(SAMPLER)

        results = {}
        for gap in (80, 120, 200, 400):
            pg.evaluate(SEED)
            pg.wait_for_timeout(450)  # 等进入选择模式的动画完成

            btn = pg.locator(".result-actions__group .text-btn", has_text="完成")
            box = btn.bounding_box()
            cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
            pg.evaluate(f"() => window.__pt = {{x:{cx}, y:{cy}}}")

            pg.evaluate("() => { window.__res=null; window.__sample(3000).then(r=>window.__res=r); }")
            pg.mouse.click(cx, cy)       # 第 1 次点击：退出选择模式
            pg.wait_for_timeout(gap)     # 退场动画进行中
            pg.mouse.click(cx, cy)       # 第 2 次点击：用户手滑/惯性，落在同一位置
            pg.wait_for_function("() => window.__res !== null", timeout=9000)
            results[gap] = report(f"「完成」间隔 {gap}ms 后再点同一位置", pg.evaluate("() => window.__res"))
            pg.wait_for_timeout(700)

        print("\n\n================ 汇总 ================")
        for gap, flip in results.items():
            print(f"间隔 {gap:>4}ms -> flip={flip}  {'❌ 抽搐' if flip > 1 else 'OK'}")

        b.close()


main()
