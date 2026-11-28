"""核对两个 FAIL 的性质：404 资源来源、「…」菜单是否真被破坏。"""
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8123"
CHROME = "/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome"

SEED = """
() => {
  const a = document.querySelector('#app')._vnode.component.proxy;
  a.uploadedFiles = [1,2,3].map(i => ({
    url: 'https://example.invalid/file/g'+i, name:'g'+i+'.png', size:1024*i, selected:false,
  }));
  return true;
}
"""


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
        pg = b.new_page(viewport={"width": 390, "height": 844})

        failed = []
        pg.on(
            "requestfailed",
            lambda r: failed.append(("FAILED", r.url, r.failure)),
        )
        pg.on("response", lambda r: failed.append((r.status, r.url, "")) if r.status >= 400 else None)

        pg.goto(f"{BASE}/index.html", wait_until="domcontentloaded", timeout=60000)
        pg.wait_for_function("() => document.querySelector('#app')?._vnode?.component?.proxy", timeout=30000)
        pg.evaluate(SEED)
        pg.wait_for_timeout(1500)

        print("=== 非 2xx 响应 / 失败请求 ===")
        seen = set()
        for status, url, extra in failed:
            key = url
            if key in seen:
                continue
            seen.add(key)
            print(f"  {status}  {url[:110]}" + (f"   {extra}" if extra else ""))

        # 行内菜单：第 2 个图标按钮才是「更多操作」
        icon_count = pg.evaluate("() => document.querySelectorAll('.row .row__actions .btn--icon').length")
        print(f"\n=== 行内菜单 ===\n每行 icon 按钮数 = {icon_count}（第 1 个是复制直链，第 2 个才是…）")
        pg.click(".row >> nth=0 >> .row__actions .btn--icon >> nth=1")
        pg.wait_for_timeout(600)
        menu = pg.evaluate(
            "() => { const m = document.querySelector('.panel .menu'); return m ? [...m.querySelectorAll('.menu__item')].map(i=>i.textContent.trim()).join('|') : null; }"
        )
        print("菜单项 =", menu)
        print("菜单能否打开:", "✅ PASS" if menu else "❌ FAIL")

        b.close()


main()
