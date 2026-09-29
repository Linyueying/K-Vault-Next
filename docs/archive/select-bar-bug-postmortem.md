# 底部操作栏抽搐 Bug —— 复盘

> [!NOTE]
> **归档快照，不代表当前状态。** 本目录是历史记录，不再随代码更新。
> 它的价值是「当初为什么这么判断」，不是「现在该怎么做」——当前做法请看
> [`../../agents/AI-OPERATIONS.md`](../agents/AI-OPERATIONS.md)。
>
> **注意**：文中提到的文件路径与当时的仓库结构一致，部分已经迁移
> （如 CSS/JS 现位于 `assets/css/`、`assets/js/`）。

> **一次具体问题的复盘文档。** 与 [`AI-OPERATIONS.md`](../agents/AI-OPERATIONS.md) 的分工：
> 那份是仓库的长期操作手册（怎么搭环境、怎么验、怎么推）；这份记录**底部操作栏抽搐 Bug
> 的完整排障链路**——「报告怎么说 → 实测证伪 → 真根因 → 修了什么 → 怎么验的」。
>
> 日期：2026-09-29 · 分支：`dev`

---

## 1. 收到的报告，以及被证伪的部分

报告描述的现象（逐帧）是准的：**取消勾选让已选项归零后，底部「已选 X 项」操作栏先突兀消失、
退回普通浏览模式，不到一秒又无过渡地弹回，复选框重新出现。** 但报告给的三条归因里，有两条不成立：

| 报告归因 | 实测结论 |
| --- | --- |
| 状态竞争 / `watch` 竞态导致重复渲染 | ❌ 不成立。`index.js` **没有任何 watch**，`grep -n 'watch\|\$watch'` 零命中；`resultSelectMode` 全局只有 3 处赋值（初始化、`toggleSelectMode` 取反、`handleClearResults` 清空） |
| 组件未按预期卸载、被异常重新挂载 | ❌ 不成立。卸载时机正常，是**被用户的下一次点击重新唤起** |
| 缺少进出场缓动过渡 | ⚠ 半成立。`collapse` 本来就有 0.5s/0.44s 的 `grid-template-rows` 插值（实测高度 `134→122→…→0` 二十帧），肉眼可见，并非"没有动画"；真正缺的是**计数数字的过渡** |

**教训：复出来的视频/截图只能证明"看起来像"，不能证明"因为是"。** 本次如果直接按报告去加 `watch` 守卫、
改竞态，会完全修不到点上。逐帧采样相比录屏的优势在于能拿到 `resultSelectMode` 的真值和元素的可命中性。

---

## 2. 复现环境

GitHub 直连被墙（`curl https://github.com` → `SSL_ERROR_SYSCALL`），按 [`AI-OPERATIONS.md`](../agents/AI-OPERATIONS.md)
的惯例走 `ghfast.top` 镜像拉取：

```bash
git clone --depth 1 "https://ghfast.top/github.com/Linyueying/K-Vault-Next.git" K-Vault-Next
```

验证用的是**轻量静态服务 + Python Playwright**，而不是 `wrangler pages dev` 全栈：

- 全栈栈只能跑 `.mjs` 脚本且需要上传真文件，链路长、一次跑几十秒；
- 本 Bug 是纯前端渲染/命中问题，**不依赖后端**。起个静态服务、往 `app.uploadedFiles` 注入三条假数据
  （注意 `url` 要唯一，`getCleanFileUrl` 拿它做 `:key`），几百毫秒就能跑一轮。

```bash
python3 -m http.server 8123 --bind 127.0.0.1 &   # 注意要到仓库根目录起，vendor/ 才有
```

环境里已有 `~/.cache/ms-playwright/chromium-1208`，无需再装。

---

## 3. 排查过程：三个实验

采样器统一走 `requestAnimationFrame` 逐帧记录：
`resultSelectMode` 真值、`selectedCount`、`.collapse` 高度、`elementFromPoint` 命中到的元素、
按钮文案、复选框数量。**最后一列是关键**——它回答"用户这一指点下去，命中的到底是谁"。

### 实验 1：单纯取消勾选（`repro_select_bar.py`）

```
t=2582 mode=True cnt=1 bar=True h=134 check=3 btns=[全选|完成]
t=2648 mode=True cnt=0 bar=True h=134 check=3 btns=[全选|完成]
mode 变化序列: True
```

**结论：`selectedCount` 归零不会触碰 `resultSelectMode`。** 底栏原地保留、按钮置灰——即当前的
设计就是方案 B。报告里"归零即退出"的那一段，必然另有触发点。

### 实验 2：操作路径矩阵（`repro_matrix.py`）

对三条路径逐一采样：点 check 圈取消、点「全选/全不选」清零、点「完成」退出。

前两条 `flip=0`（模式纹丝不动）。第三条暴露了另一件事：

```
t=9625 mode=False cnt=0 check=3 btns=[全选|完成]   ← 状态已翻转
t=9836 mode=False cnt=0 check=3 btns=[全选|完成]   ← 210ms 过去，UI 还停在旧状态
t=9856 mode=False cnt=0 check=0 btns=[选择|清空]   ← 231ms 后才跟上
```

模式翻转与 DOM 更新之间有 **~230ms 错位**。根因是 `index.html` 的写法：外层 div 用
`:key="resultSelectMode ? 'sel' : 'normal'"` 换身份、内部再套 `v-if/v-else`，Vue 在一帧里
要判两层身份，配合 `mode="out-in"`（旧节点 leave 0.18s 走完才允许新节点 enter）就成了这个空档。

### 实验 3：退场期间再点一次（**决定性**，详见第 4 节）

---

## 4. 真根因：离场节点仍在参与命中测试

**Vue 的 `<transition>` 在 leave 期间不移除元素**——DOM 节点带着动画留在页面上，且只要没显式
关掉 `pointer-events`，它**依然可被点击**。用户点完「完成」，手指惯性在同一个坐标再落一次，
命中的还是那个正在淡出的「完成」按钮，于是刚退出的选择模式被重新唤起。

`t=bed8d……` 实测（点「完成」后间隔 120ms 再点同一坐标）：

```
mode 序列 : False -> True
底栏高度  : 134 -> 108 -> 72 -> 36 -> 0 -> 11 -> 22 -> 52 -> 88 -> 134
                                        ↑ 已经收没了        ↑ 又反向弹回
```

这就是报告里"神秘地、无用户交互地弹回"的全部真相——**有交互，只是报告者没意识到**。

顺带挖到一个报告没提、**风险比闪烁更大**的问题：leave 结束（约 200~400ms）后，「完成」腾出的
屏幕位置会被刚进场的「清空」接管。此时落下的第二次点击会误把清空 armed，文案突跳为「确认清空」，
**再点一次就真的清空整份交付结果**（数据丢失）。

---

## 5. 修复清单（4 文件，+58 / -13）

| 文件 | 改动 | 治的是哪一条 |
| --- | --- | --- |
| `design-system.css` | 在 `.collapse` 段后新增集中收口：`.collapse/.ctrl/.check/.taskAct/.menu/.bar/.count` 的 `-leave-active` 一律 `pointer-events: none` | **根因**。设计系统里 `.list` 与 `.rowAct` 早就写了这行，这几个漏了——是系统性疏漏，不是单点笔误，故一次性补全并登记 |
| `index.html` | 结果区按钮组由「外层 div 换 `:key` + 内部 v-if/v-else」改为**两个兄弟分支各自带 key** | 230ms 状态错位（消掉多余的一次 identity 判断） |
| `index.html` + `index.css` | 底栏计数接入现成的 `<transition name="count" mode="out-in">` + `:key="selectedCount"`；新增 `.selection-bar--empty` 弱化态（`--text-muted` / `opacity .5`，带 `transition`） | "数字生硬跳变"；0 项时的视觉噪声 |
| `index.js` | `lastSelectModeAt` 时间戳 + `handleClearResults` 450ms 内不接受 arm | 误触清空的第二道保险（第一道是上面的 `pointer-events`） |

### 关于「0 项时该不该保留」的选择

报告给了 A（归零自动退出）/ B（原地保留置灰）两个方案，**最终选了 B**，理由：

1. 选 A 就必须在归零时引入一次额外的模式翻转，而**每一次模式翻转都是这次抽搐的复发点**——
   等于一边修 flips、一边主动新增 flips；
2. 「取消最后一个勾」把多选模式关掉，用户想顺手改选另一个文件还得再点一次「选择」。

代码里当前已经是 B，所以这次只是把它的观感做顺（弱化 + 计数过渡），没动行为。
若日后要切到 A，只需在 `index.js` 加一条 watch `selectedCount` → `toggleSelectMode()`，**一行的事**。

---

## 6. 验证结果

静态守卫全过（含共享层，因为动了 `design-system.css`）：

```
check_style.py     OK（8 页模板）      check_tokens.py    exit=0
check_styles.py    OK（共享层 461 定义） check_shared.py    全部通过
check_functions.py OK
```

> `check_tokens.py` 报的 3 处（admin.html `--vt-pos`、share.html `--shadow-sm/--surface-3`、
> design-system.css 的 `bounceDown`/`titleIn` 无人引用）是**改动前就存在**的，与本次无关，未被拦截。

**闪回归归**（四种点击间隔，底栏高度序列）：

| 间隔 | 修复前 | 修复后 |
| --- | --- | --- |
| 80ms | `0 → 11 → 22 → 134` 弹回 | `134→…→0` 单调 ✅ |
| 120ms | `0 → 11 → 22 → 52 → 134` 弹回 | `134→…→0` 单调 ✅ |
| 200ms | 误 arm「清空」 | 文案保持「清空」✅ |
| 400ms | 误 arm「清空」 | 文案保持「清空」✅ |

修复后 `elementFromPoint` 在退场窗口里命中的是父容器而非旧按钮——即"穿透到不可交互层"，符合预期。
**功能回归 26/28 PASS**（`verify_fix.py`）：进出往返、全选、批量按钮置灰/恢复、行内「…」菜单均正常。

剩下 2 个 FAIL 已查明与改动无关，记录在这里免得下次重复排查：

- **控制台告警**：全是纯静态环境的产物——`/api/auth/check`、`/api/status` 等需要 Cloudflare Functions
  后端才有；外加我注入的假文件 URL（`https://example.invalid/...`）必然 `ERR_NAME_NOT_RESOLVED`。
- **「…」菜单打不开**：是**脚本自己的 bug**。每行有 2 个图标按钮，`nth=0` 是「复制直链」，第 2 个才是「更多操作」。
  换成行作用域的第 2 个后，菜单正常弹出 `预览|下载|创建分享`。

---

## 7. 复现 / 验证脚本

已随本次提交落在 **`scripts/verify/repro/`**，可直接重跑：

```bash
python3 -m http.server 8123 --bind 127.0.0.1 &   # 仓库根目录
python3 scripts/verify/repro/repro_doubleclick.py   # 根因复现：80/120/200/400ms 二次点击
python3 scripts/verify/repro/repro_matrix.py        # 操作路径矩阵
python3 scripts/verify/repro/verify_fix.py          # 修复后的功能回归
```

> 依赖 Python Playwright（项目里其他 verify 脚本是 Node `.mjs`，本环境 `node_modules` 未安装，
> 而 Python Playwright + chromium-1208 现成可用，故这几份用 Python 写）。

下面是**根因复现脚本**全文——它同时演示了这套排查方法论的关键：
采样必须覆盖「命中到了谁」，而不是只采高度和状态。

```python
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
```

---

## 8. 留给后来者的硬提醒

1. **新增 `<transition>` 时，同步登记 `-leave-active { pointer-events: none }`。**
   `design-system.css` 里那条集中规则现在是唯一的收口点，新增过渡请照着补，否则同一个坑会换个地方再犯。
2. **`out-in` 的两个分支必须写成兄弟节点**，不要在外层 div 上挂 `:key` 再在内部套 `v-if/v-else`——
   那会让 Vue 多判一次身份，代价就是 UI 比状态晚 200ms 以上。
3. **`.result-actions__group` 是登记在 `scripts/check_styles.py` 白名单里的「刻意无样式」BEM 骨架**，
   样式一直由 inline style 承担。若要给它补 CSS 规则，记得同步更新那份白名单，否则 `npm run check` 会报错。
4. **PAT 永远不要写进仓库文档。** 推送时按 `AI-OPERATIONS.md` 的写法用临时代入，不要把 token 落到文件里。
5. `AI-OPERATIONS.md` 里写的分支仍是 `Pre`，但仓库当前实际分支是 `dev`，照抄命令前先
   `git branch --show-current` 确认一下。
