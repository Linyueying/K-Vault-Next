"""复现：取消勾选导致「已选 0 项」底栏消失后又闪回抽搐。
逐帧采样 resultSelectMode / selection-bar 的存在性与高度 / 右上角按钮文案。
"""
import json
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8123"
CHROME = "/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome"

INSTALL_SAMPLER = """
() => {
  window.InstallSampler = () => {
    window.__res = null;
    const app = document.querySelector('#app')._vnode.component.proxy;
    const proxy = () => document.querySelector('#app')._vnode.component.proxy;
    const snap = () => {
      const a = proxy();
      const bar = document.querySelector('.selection-bar');
      const collapse = bar ? bar.closest('.collapse') : null;
      const btns = [...document.querySelectorAll('.result-actions__group .text-btn')].map(b => b.textContent.trim());
      const cs = bar ? getComputedStyle(bar) : null;
      return {
        t: Math.round(performance.now()),
        mode: a.resultSelectMode,
        cnt: a.selectedCount,
        barAlive: !!(collapse && collapse.isConnected),
        h: collapse ? Math.round(collapse.getBoundingClientRect().height) : null,
        op: cs ? Number(cs.opacity).toFixed(2) : null,
        checks: document.querySelectorAll('.row .check').length,
        rowActs: document.querySelectorAll('.row .row__actions').length,
        btns: btns.join('|'),
      };
    };
    window.__sample = async (ms) => {
      const out = [];
      const t0 = performance.now();
      await new Promise((res) => {
        const tick = () => {
          out.push(snap());
          if (performance.now() - t0 < ms) requestAnimationFrame(tick);
          else res();
        };
        requestAnimationFrame(tick);
      });
      return out;
    };
    return true;
  };
}
"""

# 注入 3 个假文件到交付结果列表
SEED_FILES = """
() => {
  const app = document.querySelector('#app')._vnode.component.proxy;
  app.uploadedFiles = [1, 2, 3].map((i) => ({
    url: 'https://example.invalid/file/repro-' + i,
    name: 'repro-' + i + '.png',
    size: 1024 * i,
    selected: false,
  }));
  return app.uploadedFiles.length;
}
"""


def dump(tag, frames):
    print(f"\n=== {tag} ===")
    prev = None
    for f in frames:
        # 只打印状态发生变化的帧，避免刷屏
        key = (f["mode"], f["cnt"], f["barAlive"], f["checks"], f["rowActs"], f["btns"])
        if key != prev:
            print(
                f"t={f['t']:>6} mode={str(f['mode']):>5} cnt={f['cnt']} bar={str(f['barAlive']):>5} "
                f"h={f['h']} op={f['op']} check={f['checks']} rowAct={f['rowActs']} btns=[{f['btns']}]"
            )
            prev = key
    m = [f["t"] for f in frames if f["mode"]]
    if m:
        # 检测 mode 是否出现 true->false->true 的非单调抖动
        seq = []
        for f in frames:
            if not seq or seq[-1] != f["mode"]:
                seq.append(f["mode"])
        print("mode 变化序列:", " -> ".join(str(x) for x in seq))


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
        pg = b.new_page(viewport={"width": 390, "height": 844})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(f"{BASE}/index.html", wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_function(
            "() => document.querySelector('#app') && document.querySelector('#app')._vnode && document.querySelector('#app')._vnode.component.proxy",
            timeout=30000,
        )
        print("app 已挂载")
        pg.evaluate(INSTALL_SAMPLER)
        pg.evaluate(INSTALL_SAMPLER)  # 定义 window.InstallSampler
        pg.evaluate("() => window.InstallSampler()")
        n = pg.evaluate(SEED_FILES)
        print("注入文件数 =", n)

        # ① 进入选择模式（点真实的「选择」按钮）
        pg.click(".result-actions__group .text-btn:has-text('选择')")
        pg.wait_for_timeout(700)
        print("\n[进入选择模式] resultSelectMode =", pg.evaluate("() => document.querySelector('#app')._vnode.component.proxy.resultSelectMode"))

        # ② 勾选第 1 行（真实点击整行 / check）
        pg.click(".row >> nth=0")
        pg.wait_for_timeout(500)
        print("[勾选] selectedCount =", pg.evaluate("() => document.querySelector('#app')._vnode.component.proxy.selectedCount"))

        # ③ 取消勾选 —— 同时开始逐帧采样
        pg.evaluate("() => { window.__res = null; window.__sample(2600).then(r => window.__res = r); }")
        pg.click(".row >> nth=0")
        pg.wait_for_function("() => window.__res !== null", timeout=8000)
        frames = pg.evaluate("() => window.__res")
        dump("取消勾选后的 2.6s 逐帧采样", frames)

        print("\n页面报错:", errs or "无")
        b.close()


main()
