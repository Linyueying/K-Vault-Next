/**
 * 隔空投送（Airdrop · Beta）—— 前端组件
 *
 * ============================================================================
 * 这是一个**独立 Vue 组件**（Options API，与首页同一套写法），由 index.js
 * 注册为 <airdrop-panel>。之所以不塞进 index.js：那个文件已经四千多行，
 * 而这个功能有自己完整的一套状态机，混进去会让两边都难读。
 *
 * ============================================================================
 * 两端的状态机（同一个房间，两种视角）
 * ============================================================================
 *
 *   发端：choose → waiting（亮二维码）→ linked → picking（选节点 + 选文件）
 *         → uploading（逐文件上传，聚合进度）→ staged（已到中转节点，等对方取）→ done
 *
 *   收端：choose → joining（输码/扫码）→ linked → waiting-file（等对方发）
 *         → downloading（逐文件自动接收）→ done
 *
 * 两端都靠轮询推进（约 1.1s 一次）。没有 WebSocket 可用，而这个功能的
 * 状态跃迁频率低到轮询完全够用 —— 代价是"已连接"最多有 1 秒延迟，
 * 实测在隔空投送这种"盯着屏幕等"的场景里感知不到。
 *
 * ============================================================================
 * 中转节点（v2）
 * ============================================================================
 *
 * 发端在界面上**选择**中转节点（R2 / Telegram），默认值沿用 index 页当前
 * 选的节点（defaultNode prop）。后端只校验节点可用与单文件上限，不替用户
 * 做主。KV 已移除。
 *
 * ============================================================================
 * 权限：发送权与接收权是两个独立开关
 * ============================================================================
 *
 * 后端下发的 capability 里有两个互不相关的开关：
 *   · guestAllowed        —— 访客能否**发起**投送（当发端）。缺省 false。
 *   · guestReceiveAllowed —— 访客能否**接收**投送（当收端）。缺省 true。
 *
 * 所以本组件的权限判定也必须是两个（maySend / mayReceive），不能合成一个
 * "permitted"：授权用户开好房间、把连接码/二维码递到对方手里，对方哪怕
 * 是访客也应该能收 —— 这正是隔空投送的意义。早年用单一 permitted 判定，
 * 结果访客扫码连收端口都进不去。
 *
 * ⚠️ 命名注意：canSend 这个名字**已经被占用**（发送按钮的可用态：是否选了
 * 文件、是否在忙、是否超限），与权限无关。这里刻意用 maySend / mayReceive，
 * 避免覆盖那个 computed 导致发送按钮静默失效。
 *
 * ============================================================================
 * 关于进度动画
 * ============================================================================
 *
 * 进度条由 XHR 上传进度与接收流的字节数驱动。多文件传输显示聚合进度，
 * 最后一份响应确认前保留完成空间。
 *
 * ============================================================================
 * 关于「完成」的时序（为什么没有人为延迟）
 * ============================================================================
 *
 * 收端读完文件后逐个确认，服务端处理 complete 成功后显示完成。
 * 发端通过轮询看到服务端的 done 状态后显示完成。
 * ============================================================================
 */
(function () {
  'use strict';

  // 轮询节奏分两档（自适应）：
  //   · 传输中 1.1s —— 对端正在传/收，跃迁要尽快接住，这段延迟直接可感；
  //   · 纯等待 3s —— 等配对 / 选文件 / 等对方来取，期间没有任何会变的东西，
  //     1.1s 是纯浪费。一次投送的生命周期里等待占绝大部分，这一档能砍掉
  //     一半以上的信令请求数。
  const POLL_INTERVAL = 1100;
  const POLL_IDLE_INTERVAL = 3000;

  // 等待相位长时间没有任何进展 → 自动暂停轮询（挂机是最大的浪费源）。
  // 暂停 ≠ 取消：房间还在（TTL 内），点「继续等待」立即恢复。
  //
  // 阈值取 6 分钟：默认房间只有 5 分钟，正常情况下房间会先过期，这条不会触发；
  // 它只在管理员把 TTL 调得较长（后台可配 1 ~ 1440 分钟）时兜底，
  // 防止有人挂着房间过夜。这样两条规则不会在同一刻打架。
  const IDLE_PAUSE_MS = 6 * 60 * 1000;

  // 状态轮询的单请求超时。移动网络下 fetch 可能挂死不返回，pollBusy 卡死
  // 会断掉整条轮询链 —— 表现就是"对方早完成了，发端永远停在对方正在接收"。
  const STATUS_TIMEOUT = 8000;

  const CODE_PATTERN = /^[0-9]{6}$/;
  const RISK_REASONS = {
    active: '可执行文件、脚本或带活动内容',
    archive: '压缩包内的文件类型未知',
    filename: '文件名可能隐藏真实类型',
  };

  function codeFromScan(raw) {
    const text = String(raw || '').trim();
    if (CODE_PATTERN.test(text)) return text;
    try {
      const url = new URL(text);
      const code = url.searchParams.get('airdrop') || '';
      if (url.origin === window.location.origin && CODE_PATTERN.test(code)) return code;
    } catch (_) {}
    return '';
  }

  function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return (v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
  }

  // Short, original cues synthesized on demand. One master gain controls all playing notes.
  const AdSound = (() => {
    const floor = 0.0001;
    let ctx;
    let master;
    let currentCue;
    let enabled = true;

    try { enabled = localStorage.getItem('kvault.airdrop.sound') !== '0'; } catch (_) {}

    async function unlock() {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!enabled || !Audio) return false;
      try {
        if (!ctx) {
          ctx = new Audio();
          master = ctx.createGain();
          master.gain.value = 0.55;
          master.connect(ctx.destination);
        }
        if (ctx.state !== 'running') await ctx.resume();
        return ctx.state === 'running';
      } catch (_) {
        return false;
      }
    }

    // Each entry is frequency, offset, duration and peak. Upper partials decay before the fundamental.
    const cues = {
      link: [[493.88, 0, 0.16, 0.09], [739.99, 0.075, 0.27, 0.10]],
      sent: [[440, 0, 0.13, 0.075], [554.37, 0.07, 0.18, 0.078], [659.25, 0.14, 0.29, 0.085]],
      done: [[523.25, 0, 0.22, 0.085], [659.25, 0.075, 0.22, 0.08], [880, 0.155, 0.38, 0.10]],
      recv: [[349.23, 0, 0.14, 0.058], [523.25, 0.065, 0.22, 0.074]],
      scan: [[698.46, 0, 0.13, 0.072]],
      error: [[392, 0, 0.17, 0.072], [293.66, 0.10, 0.24, 0.062]]
    };

    function voice(bus, freq, start, length, peak, release) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.frequency.value = freq;
      env.gain.setValueAtTime(floor, start);
      env.gain.linearRampToValueAtTime(peak, start + 0.012);
      env.gain.exponentialRampToValueAtTime(floor, start + length);
      osc.connect(env);
      env.connect(bus);
      osc.onended = () => {
        osc.disconnect();
        env.disconnect();
        release();
      };
      osc.start(start);
      osc.stop(start + length + 0.012);
    }

    function play(name) {
      if (!enabled || ctx?.state !== 'running' || !cues[name]) return;
      try {
        const now = ctx.currentTime;
        if (currentCue) currentCue.gain.setTargetAtTime(floor, now, 0.025);
        const bus = ctx.createGain();
        bus.connect(master);
        currentCue = bus;
        let voices = cues[name].length * 2;
        const release = () => {
          voices -= 1;
          if (voices) return;
          bus.disconnect();
          if (currentCue === bus) currentCue = null;
        };
        for (const [freq, offset, length, peak] of cues[name]) {
          const start = now + 0.012 + offset;
          voice(bus, freq, start, length, peak, release);
          voice(bus, freq * 2, start, length * 0.45, peak * 0.12, release);
        }
      } catch (_) { /* Audio never interrupts a transfer. */ }
    }

    async function setEnabled(next) {
      enabled = Boolean(next);
      try { localStorage.setItem('kvault.airdrop.sound', enabled ? '1' : '0'); } catch (_) {}
      if (master) master.gain.setTargetAtTime(enabled ? 0.55 : floor, ctx.currentTime, 0.015);
      if (currentCue && !enabled) currentCue.gain.setTargetAtTime(floor, ctx.currentTime, 0.015);
      if (enabled && await unlock()) play('scan');
    }

    return { unlock, play, setEnabled, get enabled() { return enabled; } };
  })();

  /** 从 Content-Disposition 里取文件名（兜底用，正常情况下服务端已写好） */
  function fileNameFromHeader(header) {
    const raw = String(header || '');
    const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(raw);
    if (utf8) {
      try {
        return decodeURIComponent(utf8[1]);
      } catch (e) {
        /* 编码异常就用 ASCII 兜底名 */
      }
    }
    const plain = /filename="([^"]+)"/i.exec(raw);
    return plain ? plain[1] : '';
  }

  const AirdropPanel = {
    name: 'AirdropPanel',

    props: {
      visible: { type: Boolean, default: false },
      // 当前访问者是否为访客（未登录）
      isGuest: { type: Boolean, default: false },
      // 后端下发的能力：
      // { enabled, guestAllowed, guestReceiveAllowed, nodes:[{key,label,maxBytes}], ttlMinutes }
      capability: { type: Object, default: () => ({}) },
      // index 页当前选的存储节点（如 'r2' / 'telegram' / 'auto'），用于默认选中
      defaultNode: { type: String, default: '' },
      baseUrl: { type: String, default: '' }
    },

    emits: ['close', 'toast', 'request-open'],

    data() {
      return {
        role: null, // 'send' | 'recv'
        phase: 'choose',
        code: '',
        token: '',
        session: null,
        /* 房间到期倒计时：expiresAt 由服务端下发（建房间时已钉死），
           nowTick 每秒推一下驱动重算。两者都为 0 表示还没有房间。 */
        expiresAt: 0,
        nowTick: 0,
        joinCode: '',
        pairingExpiresAt: 0,
        riskAccepted: false,
        errorMsg: '',
        notice: '',
        noticeTone: 'info', // info|warn|error
        pollTimer: null,
        pollBusy: false,
        leaving: false, // 正在主动离开（取消/关面板）：在途轮询的回包一律作废
        pausedByIdle: false, // C：等待相位 5 分钟无进展后自动暂停
        lastActivityAt: 0, // 最近一次「世界变了」的时间戳（状态/文件数/进度）
        activityKey: '', // 上次快照，用于识别真正的变化
        busy: false,
        uploadProgress: 0,
        downloadProgress: 0,
        selectedNode: '', // 选中的中转节点 key
        selectedFiles: [], // [{ kind:'local'|'cloud', name, size, type, file?, url? }]
        sentBytes: 0,
        receivedBytes: 0,
        cloudOpen: false,
        cloudFiles: [],
        cloudLoading: false,
        /* 收端在微信/QQ 内置浏览器里被守卫拦下（已引导去系统浏览器）。
           置位后停止轮询并显示"去浏览器打开"的说明，不再反复进 beginDownload。 */
        guardBlocked: false,
        scanning: false,
        scanStream: null,
        scanTimer: null,
        tickTimer: null,
        pendingCode: '',
        fileInputKey: 0,
        doneCount: 0,
        linkPulse: false,
        soundOn: AdSound.enabled,
        opener: null,
        copiedTick: false, // 复制连接码后的短暂"已复制"反馈（~2s）
      };
    },

    computed: {
      /** 功能是否可用（后端关闭 / 没有中转节点） */
      available() {
        return Boolean(this.capability && this.capability.enabled);
      },

      /** 当前用户能否**发起**投送（当发端）。访客取决于 guestAllowed */
      maySend() {
        if (!this.available) return false;
        if (this.isGuest && !this.capability.guestAllowed) return false;
        return true;
      },

      /**
       * 当前用户能否**接收**投送（当收端）。访客取决于 guestReceiveAllowed
       * （缺省 true）—— 授权用户开好房间后，访客就应该能扫码接收。
       * capability 里没这个字段时按 true 处理（老后端/兜底响应），
       * 否则会把"能收"误判成"不能收"，正好复现本次要修的缺陷。
       */
      mayReceive() {
        if (!this.available) return false;
        if (this.isGuest && this.capability.guestReceiveAllowed === false) return false;
        return true;
      },

      /** 当前环境可用节点列表 */
      nodeList() {
        return Array.isArray(this.capability && this.capability.nodes) ? this.capability.nodes : [];
      },

      /** 云端选取窗口底部显示的「已选 N 个」—— 只数来自云端的那些 */
      cloudPickedCount() {
        return this.selectedFiles.filter((f) => f.kind === 'cloud').length;
      },

      /** 房间剩余秒数；无房间时返回 0 */
      expiresInSec() {
        const deadline = this.phase === 'waiting'
          ? this.pairingExpiresAt || this.expiresAt : this.expiresAt;
        if (!deadline) return 0;
        return Math.max(0, Math.ceil((deadline - (this.nowTick || Date.now())) / 1000));
      },

      /** 剩余时间文案：>60s 显示「M:SS」，否则显示「Ns」 */
      expiresLabel() {
        const s = this.expiresInSec;
        if (!s) return '';
        if (s >= 60) {
          const m = Math.floor(s / 60);
          const r = s % 60;
          return m + ':' + String(r).padStart(2, '0');
        }
        return s + 's';
      },

      /** 剩余不足 1 分钟时高亮提醒，让用户知道要抓紧 */
      expiresUrgent() {
        return this.expiresAt > 0 && this.expiresInSec <= 60;
      },

      /** 仅在「房间已建好且尚未结束」时展示倒计时 */
      showCountdown() {
        return this.expiresAt > 0
          && this.phase !== 'choose'
          && this.phase !== 'joining'
          && this.phase !== 'done'
          && this.phase !== 'failed';
      },

      /** 发端选中的节点信息 */
      selectedNodeInfo() {
        return this.nodeList.find((n) => n.key === this.selectedNode) || this.nodeList[0] || null;
      },

      maxBytes() {
        return Number((this.selectedNodeInfo && this.selectedNodeInfo.maxBytes) || 0);
      },

      maxLabel() {
        return this.maxBytes ? formatSize(this.maxBytes) : '—';
      },

      /** 选中的节点标签，用于底部状态条 */
      backendLabel() {
        return this.selectedNodeInfo ? this.selectedNodeInfo.label : '未选择';
      },

      totalSelectedSize() {
        return this.selectedFiles.reduce((a, f) => a + (Number(f.size) || 0), 0);
      },

      /** 二维码内容：扫码的人直接带着连接码落到本页 */
      shareUrl() {
        if (!this.code) return '';
        try {
          const u = new URL(window.location.href);
          u.search = '?airdrop=' + this.code;
          u.hash = '';
          return u.toString();
        } catch (e) {
          return '';
        }
      },

      qrSvg() {
        if (!this.code || typeof window === 'undefined' || !window.QRCode) return '';
        const url = this.shareUrl;
        let text = this.code;
        if (url && url.length <= 180) {
          try {
            if (!window.QRCode.canEncode || window.QRCode.canEncode(url, 'M')) text = url;
          } catch (e) {
            text = this.code;
          }
        }
        try {
          return window.QRCode.toSvg(text, { ecl: 'M', margin: 1, dark: 'currentColor' });
        } catch (e) {
          return '';
        }
      },

      /** 舞台只在"已经建立关系"之后出现：选角色时不该有个空舞台 */
      stageVisible() {
        return Boolean(this.role) && this.phase !== 'choose' && this.phase !== 'failed';
      },

      /** 是否正在传输中：只有这两相才在环形里显示百分比读数 */
      transferring() {
        return this.phase === 'uploading' || this.phase === 'downloading';
      },

      paired() {
        return ['linked', 'picking', 'uploading', 'staged', 'waiting-file', 'review', 'downloading', 'done'].includes(this.phase);
      },

      /** 当前进度值（0~1），驱动进度环 */
      activeProgress() {
        if (this.phase === 'uploading') return this.uploadProgress;
        if (this.phase === 'downloading') return this.downloadProgress;
        return 0;
      },

      statusTitle() {
        const map = {
          choose: '选择这一端要做什么',
          joining: '输入对方的连接码',
          waiting: '等待对方连接',
          review: '等待确认文件风险',
          linked: '已连接',
          picking: '选择中转节点与文件',
          uploading: '正在上传到存储节点',
          staged: '已送达存储节点',
          'waiting-file': '等待对方发送文件',
          downloading: '正在接收文件',
          guard: '请在浏览器中打开',
          done: '投送完成',
          failed: '本次投送已中断'
        };
        return map[this.phase] || '';
      },

      statusSub() {
        const map = {
          choose: '两端都在本页打开隔空投送，一端发送、一端接收。',
          joining: '也可以直接扫对方屏幕上的二维码。',
          waiting: '让对方扫二维码，或输入这 6 位数字连接码。',
          review: '确认前浏览器不会下载文件。',
          linked: this.role === 'send' ? '对方已就位，选好节点和文件即可发送。' : '连接已建立，等对方选择文件。',
          picking: this.nodeList.length > 1 ? '选择中转节点，再选取要发送的文件（可多选）。' : `中转节点：${this.backendLabel} · 单文件上限 ${this.maxLabel}。`,
          uploading: '上传后会检查文件类型。有风险提示时，等待对方决定是否接收。',
          staged: '文件已就绪，等待对方接收。',
          'waiting-file': '等待发送方选择文件。',
          downloading: this.session?.fileCount ? `已接收 ${this.doneCount} / ${this.session.fileCount} 个文件` : '',
          /* 内置浏览器（微信/QQ）里下载根本落不了盘，已引导去系统浏览器重开。
             这里给出明确出口，避免用户以为是卡住了。 */
          guard: '微信 / QQ 内置浏览器无法保存文件，请点右上角「···」选择「在浏览器打开」，或复制本页链接到系统浏览器 —— 对方发来的文件还在等你接收。',
          done: this.role === 'send' ? '对方已接收文件。' : '文件已交给浏览器保存。',
          failed: this.errorMsg || '可以重新开始一次投送。'
        };
        return map[this.phase] || '';
      },

      canSend() {
        return this.selectedFiles.length > 0 && !this.busy && this.phase === 'picking' && !this.oversize;
      },

      oversize() {
        return this.selectedFiles.some((f) => this.maxBytes && f.size > this.maxBytes);
      },

      inFlight() {
        return ['waiting', 'linked', 'picking', 'uploading', 'staged', 'waiting-file', 'review', 'downloading'].includes(this.phase);
      },

      riskItems() {
        return Array.isArray(this.session?.risks) ? this.session.risks : [];
      },

      riskReasonsUnavailable() {
        return !Array.isArray(this.session?.risks);
      }
    },

    watch: {
      visible(next) {
        if (next) this.onOpen();
        else this.onClose();
      }
    },

    mounted() {
      try {
        document.addEventListener('visibilitychange', this.onVisibilityChange);
      } catch (e) { /* 非浏览器环境忽略 */ }
      try {
        const p = new URLSearchParams(window.location.search).get('airdrop');
        if (CODE_PATTERN.test(p || '')) {
          this.pendingCode = p;
          this.$emit('request-open');
        }
      } catch (e) {
        /* URL 解析失败就当作普通进入 */
      }
    },

    beforeUnmount() {
      try {
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
      } catch (e) { /* 非浏览器环境忽略 */ }
      this.stopPolling();
      this.stopTick();
      this.stopScan();
    },

    methods: {
      // ── 生命周期 ──────────────────────────────────────
      onOpen() {
        this.errorMsg = '';
        this.notice = '';
        if (!this.available) {
          this.notice = '隔空投送当前未开启，或没有可用的中转存储节点。';
          this.noticeTone = 'warn';
          return;
        }
        if (!this.maySend && !this.mayReceive) {
          this.notice = '当前未开放访客使用隔空投送，请登录后重试。';
          this.noticeTone = 'warn';
          return;
        }
        if (this.pendingCode) {
          this.role = 'recv';
          this.joinCode = this.pendingCode;
          this.pendingCode = '';
          this.phase = 'joining';
          this.$nextTick(() => this.joinRoom());
        }
      },

      onClose() {
        this.stopPolling();
        this.stopScan();
        if (this.code && this.token && this.inFlight) {
          this.cancelRoom(true);
        }
      },

      focusDialog() {
        const panel = this.$refs.dialog;
        if (panel && !panel.contains(document.activeElement)) this.$refs.closeDialog?.focus({ preventScroll: true });
      },

      requestClose() {
        if (this.inFlight) {
          this.notice = '投送进行中，请先取消或等待完成。';
          this.noticeTone = 'warn';
          return;
        }
        this.$emit('close');
      },

      reset() {
        this.stopPolling();
        this.stopTick();
        /* 必须停扫码：收端点「扫码」后直接点取消，走的就是 reset() 这条路。
           此前只在 beforeUnmount / onClose / backToChoose 里停，唯独漏了
           cancelRoom（它两条分支都收敛到 reset），结果是摄像头指示灯常亮、
           scanTimer 每 320ms 空转。stopScan 本身幂等，无条件调用安全。 */
        this.stopScan();
        this.role = null;
        this.phase = 'choose';
        this.code = '';
        this.token = '';
        this.session = null;
        this.expiresAt = 0;
        this.nowTick = 0;
        this.joinCode = '';
        this.pairingExpiresAt = 0;
        this.riskAccepted = false;
        this.errorMsg = '';
        this.notice = '';
        this.uploadProgress = 0;
        this.downloadProgress = 0;
        this.selectedNode = '';
        this.selectedFiles = [];
        this.sentBytes = 0;
        this.receivedBytes = 0;
        this.doneCount = 0;
        this.cloudOpen = false;
        this.cloudFiles = [];
        this.guardBlocked = false;
        this.busy = false;
        this.leaving = false;
        this.pausedByIdle = false;
        clearTimeout(this.copyTickTimer);
        this.copiedTick = false;
        this.lastActivityAt = 0;
        this.activityKey = '';
        this.fileInputKey += 1;
      },

      toast(message, tone) {
        this.$emit('toast', message, tone || 'info');
      },

      api(path) {
        const base = this.baseUrl || '';
        return base + path;
      },

      // ── 发端 ──────────────────────────────────────────
      async chooseSend() {
        AdSound.unlock(); // 手势内解锁音频上下文（浏览器自动播放策略）
        if (!this.maySend) {
          this.notice = '当前身份不能发起投送，请登录后重试。';
          this.noticeTone = 'warn';
          return;
        }
        this.busy = true;
        this.errorMsg = '';
        try {
          const res = await fetch(this.api('/api/airdrop/create'), {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store'
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            this.errorMsg = data.error || '创建投送房间失败。';
            this.notice = this.errorMsg;
            this.noticeTone = 'error';
            return;
          }
          this.role = 'send';
          this.code = data.code;
          this.token = data.senderToken;
          // 到期时刻由服务端钉死（建房间时 = created_at + TTL），
          // 前端只负责倒计时展示，不自行推算，避免两端时钟差造成误判。
          this.expiresAt = Number(data.expiresAt) || 0;
          this.pairingExpiresAt = Number(data.pairingExpiresAt) || 0;
          // 默认节点：沿用 index 页当前选择；若不在可用列表里则取第一个可用节点
          this.selectedNode = (this.defaultNode && this.nodeList.some((n) => n.key === this.defaultNode))
            ? this.defaultNode
            : (this.nodeList[0] ? this.nodeList[0].key : '');
          this.phase = 'waiting';
          this.activityKey = '';
          this.lastActivityAt = Date.now();
          this.startPolling();
        } catch (e) {
          this.notice = '网络异常，无法创建投送房间。';
          this.noticeTone = 'error';
        } finally {
          this.busy = false;
        }
      },

      // ── 收端 ──────────────────────────────────────────
      chooseRecv() {
        AdSound.unlock(); // 手势内解锁音频上下文
        if (!this.mayReceive) {
          this.notice = '当前未开放访客接收投送，请登录后重试。';
          this.noticeTone = 'warn';
          return;
        }
        this.role = 'recv';
        this.phase = 'joining';
      },

      /**
       * 接收端在「输入连接码 / 扫码」阶段尚未建立会话（无 code / token），
       * 直接退回角色选择即可，不需要通知后端取消。这是之前唯一没有退路的相位：
       * 它不在 inFlight 列表内，页脚的「取消投送」不渲染，头部又只有整面板关闭，
       * 导致进入接收端后无法切换成发端。
       */
      backToChoose() {
        this.stopPolling();
        this.stopScan();
        this.reset();
      },

      async joinRoom() {
        if (this.busy) return;
        AdSound.unlock();
        const code = this.joinCode.trim();
        if (!CODE_PATTERN.test(code)) {
          this.notice = '请输入 6 位数字连接码。';
          this.noticeTone = 'warn';
          return;
        }
        this.busy = true;
        try {
          const res = await fetch(this.api('/api/airdrop/join'), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code })
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            this.errorMsg = data.error || '加入失败。';
            this.notice = this.errorMsg;
            this.noticeTone = 'error';
            if (data.requireLogin) this.notice += '（请先登录）';
            return;
          }
          this.code = data.code;
          this.token = data.receiverToken;
          this.expiresAt = Number(data.expiresAt) || 0;
          this.phase = 'linked';
          this.activityKey = '';
          this.lastActivityAt = Date.now();
          this.playLinkPulse();
          this.startPolling();
        } catch (e) {
          this.notice = '网络异常，无法连接对方。';
          this.noticeTone = 'error';
        } finally {
          this.busy = false;
        }
      },

      updateJoinCode(event) {
        const input = event.target;
        const digits = input.value.normalize('NFKC').replace(/[^0-9]/g, '').slice(0, 6);
        input.value = digits;
        this.joinCode = digits;
      },

      riskReasonText(reasons) {
        return reasons.map(reason => RISK_REASONS[reason]).filter(Boolean).join('、');
      },

      showRiskReview() {
        this.phase = 'review';
        this.$nextTick(() => this.$refs.cancelRisk?.focus({ preventScroll: true }));
      },

      acceptRisk() {
        if (this.phase !== 'review' || this.leaving) return;
        this.riskAccepted = true;
        this.beginDownload();
      },

      dismissPanel() {
        if (this.phase === 'review') this.cancelRoom(false);
        else if (this.cloudOpen) this.closeCloudPicker();
        else this.requestClose();
      },

      playLinkPulse() {
        this.linkPulse = true;
        this.notice = '';
        AdSound.play('link');
        setTimeout(() => { this.linkPulse = false; }, 1600);
      },

      toggleSound() {
        AdSound.setEnabled(!this.soundOn);
        this.soundOn = AdSound.enabled;
      },

      async startScan() {
        AdSound.unlock(); // 点「扫码」同样是手势
        if (typeof window === 'undefined' || !('BarcodeDetector' in window)) {
          this.notice = '当前浏览器不支持页面内扫码，请用系统相机扫描二维码（扫码后会直接打开本页并自动填好连接码）。';
          this.noticeTone = 'info';
          return;
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          this.notice = '无法调用摄像头，请手动输入连接码。';
          this.noticeTone = 'warn';
          return;
        }
        this.scanning = true;
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
          this.scanStream = stream;
          await this.$nextTick();
          const video = this.$refs.scanVideo;
          if (!video) throw new Error('取像失败');
          video.srcObject = stream;
          await video.play();

          const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
          this.scanTimer = setInterval(async () => {
            try {
              const results = await detector.detect(video);
              const hit = results && results[0];
              if (!hit || !hit.rawValue) return;
              const code = codeFromScan(hit.rawValue);
              if (code) {
                this.joinCode = code;
                this.stopScan();
                AdSound.play('scan'); // 命中反馈：摄像头里"扫到了"
                this.joinRoom();
              }
            } catch (e) {
              /* 单帧识别失败很常见，继续下一帧 */
            }
          }, 320);
        } catch (e) {
          this.scanning = false;
          this.stopScan();
          this.notice = '摄像头打开失败，请手动输入连接码。';
          this.noticeTone = 'warn';
        }
      },

      stopScan() {
        if (this.scanTimer) {
          clearInterval(this.scanTimer);
          this.scanTimer = null;
        }
        if (this.scanStream) {
          this.scanStream.getTracks().forEach((t) => t.stop());
          this.scanStream = null;
        }
        this.scanning = false;
      },

      // ── 轮询 ──────────────────────────────────────────
      startPolling() {
        this.stopPolling();
        this.startTick();
        this.poll();
      },

      stopPolling() {
        if (this.pollTimer) {
          clearTimeout(this.pollTimer);
          this.pollTimer = null;
        }
      },

      /**
       * 房间倒计时的本地节拍器。
       *
       * 纯本地 —— 只把 nowTick 推一下让 expiresInSec 重算，不发任何请求，
       * 因此不产生 D1 读。过期时刻以服务端下发的 expiresAt 为准，
       * 本地时钟只负责"把它显示出来"。
       */
      startTick() {
        if (this.tickTimer) return;
        this.nowTick = Date.now();
        this.tickTimer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return;
          this.nowTick = Date.now();
        }, 1000);
      },

      stopTick() {
        if (this.tickTimer) {
          clearInterval(this.tickTimer);
          this.tickTimer = null;
        }
      },

      /** 当前该用哪一档节奏：传输中快拍，纯等待慢拍 */
      currentPollInterval() {
        // 收端：等对方发 / 正在下 —— 都处在"对端随时会推进"的状态，快拍
        if (this.role === 'recv' && (this.phase === 'waiting-file' || this.phase === 'downloading')) {
          return POLL_INTERVAL;
        }
        // 发端 staged = 文件已全部落地、正等对方取走。这是发端**唯一**会
        // 感知到"已送达"的阶段，此刻用快拍：慢拍下 done 最多要等 3s 才被
        // 看到，而用户正盯着屏幕等那句"已送达"。投送本身是短命操作，
        // 这段快拍的额外请求量可忽略；真正的长时间挂机是 waiting（等配对），
        // 那一档仍走慢拍。
        if (this.role === 'send' && this.phase === 'staged') {
          return POLL_INTERVAL;
        }
        return POLL_IDLE_INTERVAL;
      },

      /**
       * 自续链：每拍结束后按当前节奏排下一拍，而不是固定 setInterval。
       * 好处：相位切换时下一拍立刻按新节奏走；页面隐藏 / 已暂停时干脆不排。
       */
      scheduleNextPoll() {
        if (this.pollTimer) return;
        if (!this.code || !this.token || this.leaving) return;
        if (!this.inFlight || this.pausedByIdle) return;
        if (typeof document !== 'undefined' && document.hidden) return;
        this.pollTimer = setTimeout(() => {
          this.pollTimer = null;
          this.poll();
        }, this.currentPollInterval());
      },

      /** C：当前是否处于「没有任何事在发生」的等待相位 */
      isIdleWaitPhase() {
        if (this.role === 'send') {
          return this.phase === 'waiting' || this.phase === 'staged';
        }
        // 收端只有「对方连上了但一个文件都还没发」才算空等；
        // status=uploading 说明可能有大文件正在路上，绝不能按空闲算。
        return this.role === 'recv' && this.phase === 'waiting-file'
          && this.session?.status === 'linked';
      },

      /** 任何「世界变了」的信号都刷新活跃时钟：状态、文件数、下载进度都算 */
      touchActivity(s) {
        const key = [s.status, s.fileCount ?? '', s.downloadedCount ?? '', s.progress ?? ''].join('|');
        if (key !== this.activityKey) {
          this.activityKey = key;
          this.lastActivityAt = Date.now();
        }
      },

      /** C 的出口：用户点「继续等待」，立即补一拍并恢复轮询链 */
      resumeWaiting() {
        this.pausedByIdle = false;
        this.lastActivityAt = Date.now();
        this.notice = '';
        this.noticeTone = 'info';
        this.poll();
      },

      /** A：页面看不见就停，「实时」对看不见的页面毫无意义 */
      onVisibilityChange() {
        if (typeof document === 'undefined') return;
        if (document.hidden) {
          this.stopPolling();
        } else if (this.code && this.token && this.inFlight && !this.pausedByIdle) {
          this.poll(); // 回到前台立刻补一拍，顺带恢复轮询链
        }
      },

      async poll() {
        if (!this.code || !this.token || this.pollBusy || this.leaving || this.pausedByIdle) return;

        // C：等待相位下 5 分钟无进展 → 自动暂停（房间保留，可恢复）
        if (this.isIdleWaitPhase() && this.lastActivityAt
            && Date.now() - this.lastActivityAt > IDLE_PAUSE_MS) {
          this.pausedByIdle = true;
          this.stopPolling();
          this.notice = '长时间没有进展，已暂停等待。对方可能已离开；可点「继续等待」恢复，或取消本次投送。';
          this.noticeTone = 'info';
          return;
        }

        this.pollBusy = true;
        const { code, token } = this;
        // 移动网络下 fetch 可能无限期挂起：不设超时的话 pollBusy 永远卡在
        // true，自续链从此断掉，而且回到前台也救不回来（poll 会因 pollBusy
        // 直接早退）。8s 无响应就放弃这一拍，下一拍照常重试。
        const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const abortTimer = ctrl ? setTimeout(() => ctrl.abort(), STATUS_TIMEOUT) : null;
        try {
          const res = await fetch(
            this.api('/api/airdrop/status?code=' + encodeURIComponent(this.code) + '&token=' + encodeURIComponent(this.token)),
            { credentials: 'same-origin', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined }
          );
          const data = await res.json().catch(() => ({}));
          // 修复：主动取消/重置后，早前在途的轮询回包一律作废 ——
          // 否则自己点取消，却看到「对方取消了本次投送」。
          if (this.leaving || this.code !== code || this.token !== token) return;
          if (!res.ok) {
            if (res.status === 404) {
              // 房间到期（或码不对）——过期后不再轮询，D1 读到此为止
              this.failWith(data.error || '连接码已失效或房间已过期。');
            }
            return;
          }
          this.session = data.session;
          this.applyServerStatus(data.session);
        } catch (e) {
          /* 超时 / 网络错误都不打断：下一拍会重试 */
        } finally {
          if (abortTimer) clearTimeout(abortTimer);
          this.pollBusy = false;
          this.scheduleNextPoll();
        }
      },

      applyServerStatus(s) {
        if (!s) return;
        this.touchActivity(s);
        // 以服务端下发的到期时刻为准（每拍校准一次，前端时钟漂移不影响判定）
        if (s.expiresAt) this.expiresAt = Number(s.expiresAt) || this.expiresAt;
        if (s.status === 'done') {
          // 收端可能先收到 complete 的成功响应，也可能先轮询到终态。
          if (this.phase === 'done') return;
          this.phase = 'done';
          this.stopPolling();
          this.onFinished();
          return;
        }
        if (s.status === 'cancelled') {
          this.failWith('对方取消了本次投送。');
          return;
        }
        if (s.status === 'failed') {
          this.failWith(s.error || '传输失败。');
          return;
        }

        if (this.role === 'send') {
          if (s.status === 'linked') {
            if (this.phase === 'waiting') {
              this.phase = 'linked';
              this.playLinkPulse();
            }
            setTimeout(() => {
              if (this.phase === 'linked') this.phase = 'picking';
            }, 900);
          } else if (s.status === 'uploading') {
            // 自己正在上传，phase 已由 sendAll 设定，不覆盖
          } else if (s.status === 'uploaded') {
            this.phase = 'staged';
          }
        } else if (s.status === 'linked' || s.status === 'uploading') {
          if (!['review', 'downloading'].includes(this.phase)) this.phase = 'waiting-file';
        } else if (s.status === 'uploaded' && !['review', 'downloading', 'done'].includes(this.phase)) {
          this.beginDownload();
        }
      },

      failWith(message) {
        this.stopPolling();
        AdSound.play('error');
        this.errorMsg = message;
        this.phase = 'failed';
        this.notice = message;
        this.noticeTone = 'error';
        this.toast(message, 'error');
      },

      onFinished() {
        this.notice = '';
        AdSound.play('done');
        this.toast('隔空投送已完成', 'success');
      },

      // ── 文件选择（多文件）─────────────────────────────
      pickLocal() {
        const input = this.$refs.fileInput;
        if (input) input.click();
      },

      onFilePicked(e) {
        const files = Array.from(e.target.files || []);
        e.target.value = '';
        for (const file of files) {
          this.addSelected({
            kind: 'local',
            name: file.name,
            size: file.size,
            type: file.type,
            file
          });
        }
      },

      /**
       * 打开云端选取窗口。
       *
       * 不再做成主面板里的内联折叠列表 —— 小屏下 .ad-body 的 flex 纵向布局
       * 会把它压成一条缝。独立窗口有自己的高度与滚动容器，不受主面板分配。
       * 每次都重新拉一遍列表：云端文件随时可能增删，缓存一份只会让用户
       * 看到过期结果。
       */
      async pickCloud() {
        this.cloudOpen = true;
        this.cloudLoading = true;
        try {
          const res = await fetch(this.api('/api/manage/list?limit=200'), {
            credentials: 'same-origin',
            cache: 'no-store'
          });
          if (res.status === 401) {
            this.notice = '需要登录才能从云端选取文件。';
            this.noticeTone = 'warn';
            this.cloudOpen = false;
            return;
          }
          const data = await res.json().catch(() => ({}));
          const keys = Array.isArray(data.keys) ? data.keys : [];
          this.cloudFiles = keys
            .map((x) => {
              const meta = x.metadata || {};
              return { key: x.name, name: meta.fileName || x.name, size: Number(meta.fileSize) || 0 };
            })
            .filter((x) => x.name);
          if (!this.cloudFiles.length) {
            this.notice = '云端暂无可选文件。';
            this.noticeTone = 'info';
          }
        } catch (e) {
          this.notice = '读取云端文件列表失败。';
          this.noticeTone = 'error';
          this.cloudOpen = false;
        } finally {
          this.cloudLoading = false;
        }
      },

      /** 关闭云端选取窗口（选择结果已实时落到 selectedFiles，无需额外提交） */
      closeCloudPicker() {
        this.cloudOpen = false;
        this.cloudFiles = [];
      },

      /** 云端文件：点击即加入/移出选择（支持多选） */
      selectCloudFile(item) {
        const url = '/file/' + encodeURIComponent(item.key);
        const existing = this.selectedFiles.findIndex((f) => f.kind === 'cloud' && f.url === url);
        if (existing >= 0) {
          this.selectedFiles.splice(existing, 1);
          return;
        }
        this.addSelected({
          kind: 'cloud',
          name: item.name,
          size: item.size,
          type: '',
          url
        });
      },

      isCloudSelected(item) {
        const url = '/file/' + encodeURIComponent(item.key);
        return this.selectedFiles.some((f) => f.kind === 'cloud' && f.url === url);
      },

      addSelected(file) {
        this.selectedFiles.push(file);
        this.notice = '';
        if (this.maxBytes && file.size > this.maxBytes) {
          this.notice = `「${file.name}」${formatSize(file.size)}，超出当前节点上限 ${this.maxLabel}，发送时会被拦截。`;
          this.noticeTone = 'warn';
        }
      },

      removeFile(index) {
        this.selectedFiles.splice(index, 1);
      },

      clearFiles() {
        this.selectedFiles = [];
      },

      // ── 发送（多文件，逐文件上传）────────────────────────
      async sendAll() {
        if (!this.canSend) return;
        if (!this.selectedNode) {
          this.notice = '请先选择中转节点。';
          this.noticeTone = 'warn';
          return;
        }
        this.busy = true;
        // 发送开始时收起云端选择窗口：否则上传/完成态它仍会挂在下面，
        // 且里面的行仍可点击，造成「投送完成后还能选择文件」的错觉。
        this.cloudOpen = false;
        this.cloudFiles = [];
        this.phase = 'uploading';
        this.uploadProgress = 0;
        this.sentBytes = 0;
        const total = this.totalSelectedSize;
        const files = this.selectedFiles.slice();
        const last = files.length - 1;
        const { code, token, selectedNode } = this;
        const active = () => !this.leaving && this.code === code && this.token === token
          && ['uploading', 'staged'].includes(this.phase);

        try {
          for (let i = 0; i < files.length; i += 1) {
            if (!active()) return;
            const f = files[i];
            const isFinal = i === last;
            const url = this.api('/api/airdrop/upload?code=' + encodeURIComponent(code) +
              '&token=' + encodeURIComponent(token) +
              '&node=' + encodeURIComponent(selectedNode) +
              '&final=' + (isFinal ? '1' : '0'));

            if (f.kind === 'local') {
              const form = new FormData();
              form.append('file', f.file, f.name);
              await this.xhrUpload(url, form, f.size, total, active);
            } else {
              const res = await fetch(url, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source: 'cloud', url: f.url, fileName: f.name })
              });
              const data = await res.json().catch(() => ({}));
              if (!active()) return;
              if (!res.ok) throw new Error(data.error || '发送失败');
              this.sentBytes += f.size;
              this.uploadProgress = total ? Math.min(1, this.sentBytes / total) : 1;
            }
          }
          if (!active()) return;
          this.uploadProgress = 1;
          this.phase = 'staged';
          AdSound.play('sent');
          this.toast('已上传到存储节点，等待对方接收', 'success');
        } catch (e) {
          if (active()) this.failWith(e && e.message ? e.message : '发送失败。');
        } finally {
          if (this.code === code && this.token === token) this.busy = false;
        }
      },

      /**
       * 用 XHR 而不是 fetch：只有 XHR 能给出可靠的上传进度事件。
       * 云端文件是服务端自己拉的（不经过浏览器），所以那边没有进度可报。
       */
      xhrUpload(url, form, fileSize, total, active) {
        const self = this;
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', url);
          xhr.withCredentials = true;
          xhr.upload.onprogress = (e) => {
            if (active() && e.lengthComputable && e.total) {
              const fraction = Math.min(1, e.loaded / e.total);
              const p = total ? (self.sentBytes + fileSize * fraction) / total : fraction;
              self.uploadProgress = Math.min(0.99, p);
            }
          };
          xhr.onload = () => {
            let data = {};
            try { data = JSON.parse(xhr.responseText || '{}'); } catch (e) { /* 非 JSON 忽略 */ }
            if (xhr.status >= 200 && xhr.status < 300) {
              if (active()) {
                self.sentBytes += fileSize;
                self.uploadProgress = total ? Math.min(1, self.sentBytes / total) : 1;
              }
              resolve(data);
            } else {
              reject(new Error(data.error || ('上传失败（HTTP ' + xhr.status + '）')));
            }
          };
          xhr.onerror = () => reject(new Error('网络异常，上传失败。'));
          xhr.send(form);
        });
      },

      // ── 接收（多文件，逐文件下载）────────────────────────
      async beginDownload() {
        if (this.leaving || this.phase === 'downloading' || this.phase === 'done') return;
        // 已被内置浏览器守卫拦下（已弹引导、已尝试唤端到系统浏览器）：
        // 不要再来一遍，也不要继续轮询 —— 见下方 guardBlocked 的说明。
        if (this.guardBlocked) return;
        const files = (this.session && this.session.files) || [];
        if (!files.length) return;
        if (!this.riskAccepted && (this.riskReasonsUnavailable || this.riskItems.length)) {
          this.showRiskReview();
          return;
        }
        /* 微信 / QQ 内置浏览器：就算 fetch 把字节全拿到了，也基本没法落盘
           （iOS 尤其如此，连「文件」App 都进不去）。与其让用户看着进度条
           走完却什么都没收到，不如直接把他引到系统浏览器里重开本次投送
           —— shareUrl 带 ?airdrop=CODE，打开即自动进入接收端。 */
        const kv = (typeof window !== 'undefined') ? window.KVault : null;
        if (kv && typeof kv.guardDownload === 'function' && kv.guardDownload(this.shareUrl || window.location.href, '')) {
          /* guardDownload 命中说明：已弹「请用浏览器打开」引导，并已尝试
             唤端到系统浏览器。此刻**必须停掉轮询**——
             否则 phase 停在 'waiting-file'，而服务端状态已是 'uploaded'，
             每一拍都会重新进 beginDownload 又立刻 return，形成每 1.1s
             一次的空转（一直打到房间过期才由 404 收敛），白烧 D1，
             而且界面永远停在"等对方发送"，与"对方其实早传完了"不符。 */
          this.guardBlocked = true;
          this.stopPolling();
          this.phase = 'guard';
          return;
        }
        this.phase = 'downloading';
        AdSound.play('recv');
        this.downloadProgress = 0;
        this.receivedBytes = 0;
        this.doneCount = 0;
        const total = this.session.totalSize || files.reduce((a, f) => a + (f.size || 0), 0);
        const { code, token } = this;
        const active = () => !this.leaving && this.code === code && this.token === token && this.phase === 'downloading';
        const downloadUrl = this.api('/api/airdrop/download?code=' + encodeURIComponent(code) +
          '&token=' + encodeURIComponent(token));

        try {
          for (let i = 0; i < files.length; i += 1) {
            if (!active()) return;
            const meta = files[i];
            const url = downloadUrl + '&idx=' + i;
            const chunks = [];
            let received = 0;
            let expectedLength = Number(meta.size) > 0 ? Number(meta.size) : null;
            let receipt = '';
            let name = meta.name || ('airdrop-file-' + i);
            const MAX_RECV_ATTEMPTS = 5;

            for (let attempt = 1; attempt <= MAX_RECV_ATTEMPTS; attempt += 1) {
              if (!active()) return;
              const headers = this.riskAccepted ? { 'X-KVault-Accept-Risk': '1' } : {};
              if (received > 0) headers.Range = 'bytes=' + received + '-';

              const controller = typeof AbortController === 'function' ? new AbortController() : null;
              let stallTimer = null;
              const resetStall = () => {
                if (!controller) return;
                if (stallTimer) clearTimeout(stallTimer);
                stallTimer = setTimeout(() => { try { controller.abort(); } catch (_) {} }, 45000);
              };

              try {
                resetStall();
                const res = await fetch(url, {
                  credentials: 'same-origin',
                  headers,
                  signal: controller ? controller.signal : undefined
                });
                if (!res.ok && res.status !== 206) {
                  let msg = '接收失败。';
                  try { const d = await res.json(); msg = d.error || msg; } catch (e) { /* 忽略 */ }
                  const httpErr = new Error(msg);
                  httpErr.status = res.status;
                  httpErr.retryAfterMs = (Number(res.headers.get('Retry-After')) || 0) * 1000;
                  throw httpErr;
                }
                const nextReceipt = res.headers.get('X-KVault-Download-Receipt');
                if (nextReceipt) receipt = nextReceipt;
                if (!receipt) throw new Error('未收到下载回执，请重新开始投送。');

                const headerName = fileNameFromHeader(res.headers.get('content-disposition'));
                if (headerName) name = headerName;

                if (res.status === 200) {
                  if (received > 0) {
                    chunks.length = 0;
                    received = 0;
                  }
                  const lenRaw = res.headers.get('Content-Length');
                  if (lenRaw !== null && /^\d+$/.test(lenRaw)) expectedLength = Number(lenRaw);
                } else if (res.status === 206) {
                  const cr = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(res.headers.get('Content-Range') || '');
                  if (cr) expectedLength = Number(cr[3]);
                }

                if (res.body && typeof res.body.getReader === 'function') {
                  const reader = res.body.getReader();
                  for (;;) {
                    resetStall();
                    const step = await reader.read();
                    if (!active()) {
                      await reader.cancel().catch(() => {});
                      return;
                    }
                    if (step.done) break;
                    chunks.push(step.value);
                    received += step.value.byteLength;
                    this.downloadProgress = total ? Math.min(1, (this.receivedBytes + received) / total) : Math.min(0.95, this.downloadProgress + 0.04);
                  }
                } else {
                  const ab = await res.arrayBuffer();
                  chunks.push(new Uint8Array(ab));
                  received += ab.byteLength;
                }

                if (expectedLength !== null && received < expectedLength) {
                  const truncErr = new Error('连接中断，正在尝试断点续传…');
                  truncErr.transient = true;
                  throw truncErr;
                }
                break;
              } catch (err) {
                if (!active()) return;
                const status = Number(err && err.status);
                const retryable = !status || status === 408 || status === 429 || (status >= 500 && status <= 599) || Boolean(err && err.transient);
                if (!retryable || attempt >= MAX_RECV_ATTEMPTS) throw err;
                if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                  await new Promise((resolve) => {
                    const onOnline = () => resolve();
                    window.addEventListener('online', onOnline, { once: true });
                    setTimeout(() => { window.removeEventListener('online', onOnline); resolve(); }, 30000);
                  });
                }
                if (!active()) return;
                const exp = Math.min(10000, 400 * Math.pow(2, attempt - 1));
                const wait = Math.max(Math.floor(150 + Math.random() * exp), Number(err && err.retryAfterMs) || 0);
                await new Promise((resolve) => setTimeout(resolve, wait));
              } finally {
                if (stallTimer) clearTimeout(stallTimer);
              }
            }

            if (!active()) return;
            const blob = new Blob(chunks, { type: meta.type || 'application/octet-stream' });
            if (expectedLength !== null && blob.size !== expectedLength) {
              throw new Error('文件未完整接收，请重新开始投送。');
            }
            this.saveBlob(blob, name);
            if (!await this.confirmDelivery(url, { headers: { 'X-KVault-Download-Receipt': receipt } }, active)) return;
            this.receivedBytes += blob.size;
            this.doneCount += 1;
            this.downloadProgress = total ? Math.min(1, this.receivedBytes / total) : 1;
          }

          const completed = await this.confirmDelivery(this.api('/api/airdrop/complete'), {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, token })
          }, active);
          if (!completed) return;
          this.phase = 'done';
          this.stopPolling();
          this.onFinished();
        } catch (e) {
          if (active()) this.failWith(e && e.message ? e.message : '接收失败。');
        }
      },

      async confirmDelivery(url, options, active) {
        let message = '服务端未确认接收完成。已下载的文件可在浏览器下载记录中查看。';
        for (let attempt = 0; attempt < 5 && active(); attempt += 1) {
          if (attempt) await new Promise(resolve => setTimeout(resolve, 800));
          if (!active()) return false;
          const controller = typeof AbortController === 'function' ? new AbortController() : null;
          const timeout = controller ? setTimeout(() => controller.abort(), STATUS_TIMEOUT) : null;
          let response;
          try {
            response = await fetch(url, {
              ...options, method: 'POST', credentials: 'same-origin', signal: controller?.signal
            });
          } catch (_) {
            continue;
          } finally {
            if (timeout) clearTimeout(timeout);
          }
          if (!active()) return false;
          if (response.ok) return true;
          const data = await response.json().catch(() => ({}));
          message = data.error || message;
          if (response.status < 500 && response.status !== 429) break;
        }
        if (active()) throw new Error(message);
        return false;
      },

      saveBlob(blob, name) {
        try {
          const href = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = href;
          a.download = name;
          a.rel = 'noopener';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(href), 4000);
        } catch (e) {
          throw new Error('浏览器未能开始保存文件，请检查下载权限。');
        }
      },

      // ── 取消 / 重来 ───────────────────────────────────
      async cancelRoom(silent) {
        if (this.leaving) return;
        if (!this.code || !this.token) {
          this.reset();
          return;
        }
        // 先立旗再发请求：取消期间在途的轮询回包（很可能已经是 cancelled）
        // 不许再改 UI，否则自己点取消却看到「对方取消了本次投送」。
        this.leaving = true;
        try {
          await fetch(this.api('/api/airdrop/cancel'), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: this.code, token: this.token })
          });
        } catch (e) {
          /* 取消失败也照样退出界面：房间会自己过期 */
        }
        this.reset();
        if (!silent) {
          this.notice = '已取消本次投送。';
          this.noticeTone = 'info';
        }
      },

      async copyCode() {
        try {
          await navigator.clipboard.writeText(this.code);
          this.copiedTick = true;
          AdSound.play('scan');
          this.toast('连接码已复制', 'success');
          // 反馈停留 2s 后还原；copyTickTimer 用于连点时重置节拍
          clearTimeout(this.copyTickTimer);
          this.copyTickTimer = setTimeout(() => { this.copiedTick = false; }, 2000);
        } catch (e) {
          this.toast('复制失败，请手动记下连接码', 'error');
        }
      },

      /** 按文件名 / MIME 挑一个细颗粒图标，而不是清一色 fa-file-lines */
      fileIcon(f) {
        const name = String(f && f.name || '').toLowerCase();
        const type = String(f && f.type || '').toLowerCase();
        const ext = (name.match(/\.([a-z0-9]+)$/) || [])[1] || '';
        if (type.startsWith('image/')) return { icon: 'fa-file-image', cls: 'is-image' };
        if (type.startsWith('video/')) return { icon: 'fa-file-video', cls: 'is-video' };
        if (type.startsWith('audio/')) return { icon: 'fa-file-audio', cls: 'is-audio' };
        if (type === 'application/pdf' || ext === 'pdf') return { icon: 'fa-file-pdf', cls: 'is-pdf' };
        if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return { icon: 'fa-file-zipper', cls: 'is-archive' };
        if (['js', 'mjs', 'ts', 'py', 'java', 'go', 'rs', 'html', 'css', 'json', 'sh'].includes(ext)) return { icon: 'fa-file-code', cls: 'is-code' };
        if (['doc', 'docx', 'md', 'txt'].includes(ext)) return { icon: 'fa-file-word', cls: 'is-doc' };
        if (['xls', 'xlsx', 'csv'].includes(ext)) return { icon: 'fa-file-excel', cls: 'is-sheet' };
        if (['ppt', 'pptx'].includes(ext)) return { icon: 'fa-file-powerpoint', cls: 'is-slide' };
        return { icon: 'fa-file-lines', cls: '' };
      },

    },

    template: `
<transition name="dialog" @before-enter="opener = $event.ownerDocument.activeElement" @after-enter="focusDialog" @after-leave="opener?.focus()">
  <div class="modal-mask modal-mask--center ad-mask" v-if="visible" @click.self="dismissPanel">
    <div ref="dialog" class="modal ad-modal" role="dialog" aria-modal="true" aria-labelledby="ad-title"
         @click.stop @keydown.esc.stop="dismissPanel">
      <header class="ad-head" :inert="phase === 'review'">
        <span class="ad-grip" aria-hidden="true"></span>
        <div class="ad-brand">
          <span class="ad-mark" aria-hidden="true"><i aria-hidden="true" class="fas fa-paper-plane"></i></span>
          <h2 id="ad-title">隔空投送</h2>
        </div>
        <div class="ad-head__tools">
          <span class="ad-countdown" v-if="showCountdown" :class="{ 'is-urgent': expiresUrgent }"
                :aria-label="'连接剩余时间 ' + expiresLabel" title="连接剩余时间">{{ expiresLabel }}</span>
          <button type="button" class="ad-icon-btn" @click="toggleSound"
                  :title="soundOn ? '关闭提示音' : '打开提示音'"
                  aria-label="提示音" :aria-pressed="soundOn">
            <i class="fas" :class="soundOn ? 'fa-music' : 'fa-ban'" aria-hidden="true"></i>
          </button>
          <button type="button" ref="closeDialog" class="ad-icon-btn" @click="requestClose" aria-label="关闭隔空投送" title="关闭">
            <i class="fas fa-xmark" aria-hidden="true"></i>
          </button>
        </div>
      </header>

      <div class="ad-body" :inert="phase === 'review'">

        <div class="ad-stage" v-if="phase === 'choose'">
          <div class="ad-orbit" aria-hidden="true">
            <i class="ad-orbit__ripple"></i>
            <span><i class="fas fa-paper-plane"></i></span>
          </div>
          <p>两台设备打开此站点，用二维码或连接码配对。</p>
        </div>

        <div class="ad-roles" v-if="phase === 'choose'">
          <button type="button" class="ad-role" @click="chooseSend" :disabled="busy || !maySend">
            <span class="ad-role__icon"><i class="fas fa-upload" aria-hidden="true"></i></span>
            <strong>{{ busy ? '正在创建连接…' : '发送' }}</strong>
            <small>{{ maySend ? '创建连接' : '登录后可发送' }}</small>
          </button>
          <button type="button" class="ad-role" @click="chooseRecv" :disabled="busy || !mayReceive">
            <span class="ad-role__icon ad-role__icon--recv"><i class="fas fa-arrow-down" aria-hidden="true"></i></span>
            <strong>接收</strong>
            <small>{{ mayReceive ? '扫码或输入连接码' : '当前不可接收' }}</small>
          </button>
        </div>

        <div class="ad-flow" v-if="stageVisible && phase !== 'guard'"
             :class="{ 'is-pulse': linkPulse, 'is-paired': paired, 'is-done': phase === 'done',
                       'is-waiting': phase === 'waiting', 'is-transferring': transferring, 'is-receiving': role === 'recv' }">
          <div class="ad-flow__devices" aria-hidden="true">
            <span class="ad-device"><span class="ad-device__icon"><i aria-hidden="true" class="fas" :class="role === 'send' ? 'fa-upload' : 'fa-arrow-down'"></i></span>此设备</span>
            <span class="ad-flow__bridge"><span class="ad-flow__signal"></span><i aria-hidden="true" class="fas" :class="phase === 'done' ? 'fa-check' : 'fa-link'"></i></span>
            <span class="ad-device"><span class="ad-device__icon"><i aria-hidden="true" class="fas" :class="paired ? 'fa-check' : 'fa-paper-plane'"></i></span>对方设备</span>
          </div>
          <div v-if="transferring" class="ad-progress">
            <div class="ad-progress__track">
              <progress :value="activeProgress" max="1" :aria-label="role === 'send' ? '上传进度' : '接收进度'"></progress>
              <span class="ad-progress__fill" :style="{ transform: 'scaleX(' + activeProgress + ')' }" aria-hidden="true"></span>
            </div>
            <span aria-hidden="true">{{ Math.round(activeProgress * 100) }}%</span>
          </div>
        </div>

        <div class="ad-status" v-if="phase !== 'choose'">
          <div role="status">
            <div :key="phase" class="ad-status__message">
              <h3 class="ad-status__title">{{ statusTitle }}</h3>
              <p class="ad-status__sub" v-if="statusSub">{{ statusSub }}</p>
            </div>
          </div>
          <button type="button" class="ad-btn ad-btn--primary" v-if="phase === 'guard'" @click="reset">重新开始</button>
        </div>

        <!-- 发端：二维码 + 连接码 -->
        <div class="ad-code" v-if="role === 'send' && phase === 'waiting'">
          <div class="ad-qr-wrap">
            <div class="ad-qr" v-html="qrSvg" role="img" aria-label="投送连接二维码"></div>
          </div>
          <div class="ad-code__details">
            <span>连接码</span>
            <code class="ad-digits">{{ code }}</code>
            <button type="button" class="ad-btn" @click="copyCode">
              <i class="fas" :class="copiedTick ? 'fa-check' : 'fa-copy'" aria-hidden="true"></i>
              {{ copiedTick ? '已复制' : '复制连接码' }}
            </button>
          </div>
        </div>

        <!-- 收端：输入连接码 / 扫码 -->
        <div class="ad-join" v-if="role === 'recv' && phase === 'joining'">
          <input class="ad-code-input" :value="joinCode" placeholder="6 位数字连接码"
                 @input="updateJoinCode" @keyup.enter="joinRoom" aria-label="连接码"
                 autocomplete="off" spellcheck="false" inputmode="numeric" />
          <div class="ad-actions">
            <button class="ad-btn ad-btn--primary" @click="joinRoom" :disabled="busy">
              <i aria-hidden="true" class="fas fa-link"></i><span>{{ busy ? '连接中…' : '连接' }}</span>
            </button>
            <button class="ad-btn" @click="startScan" :disabled="scanning">
              <i aria-hidden="true" class="fas fa-magnifying-glass"></i><span>{{ scanning ? '扫描中…' : '扫码' }}</span>
            </button>
          </div>
          <div class="ad-scanbox" v-show="scanning">
            <video ref="scanVideo" muted playsinline></video>
          </div>
          <button class="ad-back" @click="backToChoose">
            <i aria-hidden="true" class="fas fa-chevron-left"></i><span>返回重新选择</span>
          </button>
        </div>

        <!-- 发端：选择中转节点 -->
        <div class="ad-nodes" v-if="role === 'send' && (phase === 'picking' || (phase === 'linked' && !selectedFiles.length))">
          <div class="ad-nodes__label">中转节点</div>
          <div class="ad-nodes__row">
            <button class="ad-node-pick" v-for="n in nodeList" :key="n.key"
                    :class="{ 'is-on': selectedNode === n.key }" :aria-pressed="selectedNode === n.key"
                    @click="selectedNode = n.key">
              <i aria-hidden="true" class="fas" :class="n.key === 'r2' ? 'fa-cloud' : 'fa-paper-plane'"></i>
              <span>{{ n.label }}</span>
              <small>≤ {{ formatSizeLabel(n.maxBytes) }}</small>
            </button>
          </div>
        </div>

        <!-- 发端：选择文件来源 -->
        <div class="ad-actions" v-if="role === 'send' && (phase === 'picking' || (phase === 'linked' && !selectedFiles.length))">
          <button class="ad-btn ad-btn--primary" @click="pickLocal">
            <i aria-hidden="true" class="fas fa-folder-open"></i><span>从本地选取</span>
          </button>
          <button class="ad-btn" @click="pickCloud" :disabled="cloudLoading">
            <i aria-hidden="true" class="fas fa-cloud-arrow-up"></i><span>{{ cloudLoading ? '读取中…' : '从云端选取' }}</span>
          </button>
        </div>

        <!-- 已选文件清单（多文件） -->
        <div class="ad-files" v-if="role === 'send' && selectedFiles.length">
          <div class="ad-files__head">
            <span>已选择 {{ selectedFiles.length }} 个文件</span>
            <span v-if="totalSelectedSize">{{ formatSizeLabel(totalSelectedSize) }}</span>
          </div>
          <div class="ad-files__list">
            <div class="ad-file" v-for="(f, i) in selectedFiles" :key="i" :style="{ animationDelay: Math.min(i, 5) * 32 + 'ms' }">
              <span class="ad-file__icon" :class="fileIcon(f).cls"><i aria-hidden="true" class="fas" :class="fileIcon(f).icon"></i></span>
              <span class="ad-file__meta">
                <span class="ad-file__name">{{ f.name }}</span>
                <span class="ad-file__size">{{ formatSizeLabel(f.size) }} · 来自{{ f.kind === 'local' ? '本地' : '云端' }}</span>
              </span>
              <!-- 只有选文件阶段可移除；传输/完成后这颗 × 只是视觉噪音，直接不渲染 -->
              <button class="btn btn--ghost btn--icon btn--sm" v-if="phase === 'picking'" @click="removeFile(i)" title="移除">
                <i aria-hidden="true" class="fas fa-xmark"></i>
              </button>
            </div>
          </div>
        </div>
        <!-- 收端：对方已发来的文件清单 -->
        <div class="ad-files" v-if="role === 'recv' && session && session.files && session.files.length && (phase === 'waiting-file' || phase === 'review' || phase === 'downloading' || phase === 'done')">
          <div class="ad-files__head">
            <span>共 {{ session.fileCount }} 个文件</span>
            <span v-if="session.totalSize">{{ formatSizeLabel(session.totalSize) }}</span>
          </div>
          <div class="ad-files__list">
            <div class="ad-file" v-for="(f, i) in session.files" :key="i" :style="{ animationDelay: Math.min(i, 5) * 32 + 'ms' }"
                 :class="{ 'is-live': phase === 'downloading' && i === doneCount, 'is-done': phase === 'done' || f.status === 'downloaded' }">
              <span class="ad-file__icon" :class="fileIcon(f).cls">
                <i aria-hidden="true" class="fas" :class="(phase === 'done' || f.status === 'downloaded') ? 'fa-circle-check' : fileIcon(f).icon"></i>
              </span>
              <span class="ad-file__meta">
                <span class="ad-file__name">{{ f.name }}</span>
                <span class="ad-file__size">
                  {{ formatSizeLabel(f.size) }}
                  <template v-if="phase === 'downloading' && i === doneCount"> · 接收中…</template>
                </span>
              </span>
            </div>
          </div>
        </div>

        <!-- 提示条 -->
        <div class="ad-note" role="status" :class="{ 'ad-note--warn': noticeTone === 'warn', 'ad-note--error': noticeTone === 'error' }"
             v-if="notice && (phase !== 'failed' || notice !== statusSub)">
          <i aria-hidden="true" class="fas" :class="noticeTone === 'error' ? 'fa-circle-exclamation' : (noticeTone === 'warn' ? 'fa-triangle-exclamation' : 'fa-circle-info')"></i>
          <span>{{ notice }}</span>
        </div>

      </div>

      <div class="ad-foot" :inert="phase === 'review'" v-if="pausedByIdle || inFlight || phase === 'failed' || phase === 'done'">
        <button class="ad-btn ad-btn--primary ad-btn--send" v-if="role === 'send' && phase === 'picking' && selectedFiles.length" @click="sendAll" :disabled="!canSend">
          <i aria-hidden="true" class="fas fa-paper-plane"></i>
          <span>{{ oversize ? '有文件超出节点上限' : ('发送 ' + selectedFiles.length + ' 个文件') }}</span>
        </button>
        <span v-if="role === 'send' && phase !== 'failed' && phase !== 'done'">{{ backendLabel }} · 单文件上限 {{ maxLabel }}</span>
        <button class="btn btn--sm" v-if="pausedByIdle" @click="resumeWaiting">
          <i aria-hidden="true" class="fas fa-rotate-right"></i><span>继续等待</span>
        </button>
        <button class="btn btn--sm" v-if="inFlight" @click="cancelRoom(false)">取消投送</button>
        <button class="btn btn--sm" v-else-if="phase === 'failed' || phase === 'done'" @click="reset">再来一次</button>
      </div>

      <transition name="veil">
        <div v-if="phase === 'review'" class="ad-cloudwin-mask">
          <section class="ad-cloudwin ad-risk" role="alertdialog" aria-modal="true"
            aria-labelledby="ad-risk-title" aria-describedby="ad-risk-description">
            <div class="ad-cloudwin__head">
              <h3 id="ad-risk-title"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i> 投送有风险提示</h3>
            </div>
            <div class="ad-cloudwin__body ad-risk__body">
              <p id="ad-risk-description">仅在确认发送方可信且你预期收到这些文件时继续。文件类型提示无法判断文件是否含恶意内容。</p>
              <p v-if="riskReasonsUnavailable">暂未收到文件风险检查结果。</p>
              <ul v-else>
                <li v-for="(file, index) in riskItems.slice(0, 12)" :key="index">
                  <bdi>{{ file.name }}</bdi>
                  <small>{{ riskReasonText(file.reasons) }}</small>
                </li>
              </ul>
              <p v-if="riskItems.length > 12">另有 {{ riskItems.length - 12 }} 个文件触发提示。</p>
            </div>
            <div class="ad-cloudwin__foot">
              <button type="button" ref="cancelRisk" class="ad-btn ad-btn--primary" @click="cancelRoom(false)" :disabled="leaving">取消接收</button>
              <button type="button" class="ad-btn" @click="acceptRisk" :disabled="leaving">继续接收</button>
            </div>
          </section>
        </div>
      </transition>

      <input type="file" :key="fileInputKey" ref="fileInput" style="display:none" multiple @change="onFilePicked" />

      <!-- 云端选取：独立窗口
           为什么不内联在主面板里：主面板 .ad-body 是 flex 纵向布局且自身
           滚动，内联的列表在小屏上会被 flex 压缩成一条缝（高度被挤到接近 0，
           内部滚动也够不着）。独立成覆盖层后有自己确定的高度与滚动容器，
           不再受主面板 flex 分配的摆布，小屏也能正常看/点。 -->
      <transition name="veil">
      <div class="ad-cloudwin-mask" v-if="cloudOpen" @click.self="closeCloudPicker">
        <div class="ad-cloudwin" role="dialog" aria-modal="true" aria-label="从云端选取文件" @click.stop>
          <div class="ad-cloudwin__head">
            <div class="ad-cloudwin__title">
              <i aria-hidden="true" class="fas fa-cloud-arrow-up"></i>
              <span>从云端选取</span>
            </div>
            <button class="btn btn--ghost btn--icon" @click="closeCloudPicker" title="关闭">
              <i aria-hidden="true" class="fas fa-xmark"></i>
            </button>
          </div>

          <div class="ad-cloudwin__body">
            <div class="ad-cloudwin__hint" v-if="cloudLoading">
              <i aria-hidden="true" class="fas fa-spinner fa-spin"></i><span>正在读取云端文件…</span>
            </div>
            <div class="ad-cloudwin__hint" v-else-if="!cloudFiles.length">
              <i aria-hidden="true" class="fas fa-inbox"></i><span>云端暂无可选文件</span>
            </div>
            <template v-else>
              <button class="ad-cloudwin__row" v-for="f in cloudFiles" :key="f.key"
                      :class="{ 'is-picked': isCloudSelected(f) }" @click="selectCloudFile(f)">
                <i aria-hidden="true" class="fas" :class="isCloudSelected(f) ? 'fa-check-circle' : 'fa-file'"></i>
                <span class="ad-cloudwin__name">{{ f.name }}</span>
                <span class="ad-cloudwin__size">{{ formatSizeLabel(f.size) }}</span>
              </button>
            </template>
          </div>

          <div class="ad-cloudwin__foot">
            <span class="ad-cloudwin__count">已选 {{ cloudPickedCount }} 个</span>
            <button class="ad-btn ad-btn--primary" @click="closeCloudPicker">完成</button>
          </div>
        </div>
      </div>
      </transition>

    </div>
  </div>
</transition>
    `
  };

  AirdropPanel.methods.formatSizeLabel = formatSize;

  window.AirdropPanel = AirdropPanel;
})();
