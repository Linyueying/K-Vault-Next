"""操作路径矩阵：定位哪一个交互路径会让 resultSelectMode 发生「退出→闪回」抖动。"""
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
    const group = document.querySelector('.result-actions__group');
    const cs = bar ? getComputedStyle(bar) : null;
    return {
      t: Math.round(performance.now()),
      mode: a.resultSelectMode,
      cnt: a.selectedCount,
      alive: !!(collapse && collapse.isConnected),
      h: collapse ? Math.round(collapse.getBoundingClientRect().height) : null,
      op: cs ? Number(cs.opacity).toFixed(2) : null,
      groups: document.querySelectorAll('.result-actions__group').length,
      checks: document.querySelectorAll('.row .check').length,
      btns: [...document.querySelectorAll('.result-actions__group .text-btn')].map(b => b.textContent.trim()).join('|'),
      info: (document.querySelector('.selection-bar__info') || {}).textContent || '',
    };
  };
  window.__sample = async (ms) => {
    const out = [];
    const t0 = performance.now();
    await new Promise((res) => {
      const tick = () => {
        out.push(snap());
        if (performance.now() - t0 < ms) requestAnimationFrame(tick); else res();
      };
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
    url: 'https://example.invalid/file/m'+i, name:'m'+i+'.png', size:1024*i, selected:false,
  }));
  return a.uploadedFiles.length;
}
"""


def compress(frames):
    """只保留状态发生变化的帧"""
    out, prev = [], None
    for f in frames:
        k = (f["mode"], f["cnt"], f["alive"], f["h"], f["op"], f["checks"], f["btns"], f["info"])
        if k != prev:
            out.append(f)
            prev = k
    return out


def report(name, frames):
    print(f"\n=========== 场景：{name} ===========")
    seq, hseq = [], []
    for f in frames:
        if not seq or seq[-1] != f["mode"]:
            seq.append(f["mode"])
        if not hseq or hseq[-1] != f["h"]:
            hseq.append(f["h"])
    for f in compress(frames):
        print(
            f"  t={f['t']:>6} mode={str(f['mode']):>5} cnt={f['cnt']} alive={str(f['alive']):>5} "
            f"h={f['h']} op={f['op']} groups={f['groups']} check={f['checks']} btns=[{f['btns']}] info={f['info'].strip()[:12]}"
        )
    print("  >> resultSelectMode 序列 :", " -> ".join("T" if x else "F" for x in seq))
    print("  >> 底栏高度序列        :", " -> ".join(str(x) for x in hseq))
    flip = sum(1 for i in range(1, len(seq)) if seq[i] != seq[i - 1])
    verdict = "❌ 存在模式抖动" if flip > 1 else ("模式单次变化" if flip == 1 else "模式未变")
    print("  >> 判定:", verdict, f"(flip={flip})")
    return flip


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
        pg = b.new_page(viewport={"width": 390, "height": 844})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(f"{BASE}/index.html", wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_function(
            "() => document.querySelector('#app')?._vnode?.component?.proxy", timeout=30000
        )
        pg.evaluate(SAMPLER)
        pg.evaluate(SEED)

        # 统一前置：进入选择模式 + 勾选第 1 行
        pg.click(".result-actions__group .text-btn:has-text('选择')")
        pg.wait_for_timeout(650)
        pg.click(".row >> nth=0")
        pg.wait_for_timeout(400)
        baseline = pg.evaluate(
            "() => { const a=document.querySelector('#app')._vnode.component.proxy; return {m:a.resultSelectMode,c:a.selectedCount}; }"
        )
        print("前置状态:", baseline)

        scenarios = []

        # 场景 1：点 check 圈取消勾选
        scenarios.append(("点 check 圈取消勾选", lambda: pg.click(".row .check >> nth=0")))

        # 场景 2：点「全选/全不选」清零
        scenarios.append(("点「全选」后再「全不选」清零", lambda: (pg.click(".result-actions__group .text-btn:has-text('全选')"), None)))

        # 场景 3：点「完成」退出选择模式
        scenarios.append(("点「完成」退出选择模式", lambda: pg.click(".result-actions__group .text-btn:has-text('完成')")))

        for name, act in scenarios:
            pg.evaluate("() => { window.__res=null; window.__sample(2400).then(r=>window.__res=r); }")
            try:
                act()
            except Exception as e:
                print(f"  !! 动作失败: {e}")
            try:
                pg.wait_for_function("() => window.__res !== null", timeout=9000)
                report(name, pg.evaluate("() => window.__res"))
            except Exception as e:
                print(name, "采样超时", e)

            # 复位到「选择模式 + 勾选 1 项」
            pg.wait_for_timeout(500)
            pg.evaluate(SEED)
            pg.wait_for_timeout(150)
            st = pg.evaluate(
                "() => { const a=document.querySelector('#app')._vnode.component.proxy; return {m:a.resultSelectMode}; }"
            )
            if not st["m"]:
                pg.click(".result-actions__group .text-btn:has-text('选择')")
                pg.wait_for_timeout(650)
            try:
                pg.click(".row >> nth=0")
                pg.wait_for_timeout(400)
            except Exception:
                pass

        print("\n页面报错:", errs or "无")
        b.close()


main()
