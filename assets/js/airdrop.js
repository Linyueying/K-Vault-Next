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
 * 关于进度动画
 * ============================================================================
 *
 * 中间那个"文件包"的位置由真实的上传/下载进度驱动（XHR progress /
 * 流式读取的字节数），不是固定时长的动画。这一点很重要：进度条走到头
 * 但文件还在传，比进度条慢一点更让人不安。多文件时进度是聚合后的整体进度。
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

  // 等待相位连续 5 分钟没有任何进展 → 自动暂停轮询（挂机是最大的浪费源）。
  // 暂停 ≠ 取消：房间还在（TTL 内），点「继续等待」立即恢复。
  const IDLE_PAUSE_MS = 5 * 60 * 1000;

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
      // 后端下发的能力：{ enabled, guestAllowed, nodes:[{key,label,maxBytes}], ttlMinutes }
      capability: { type: Object, default: () => ({}) },
      // index 页当前选的存储节点（如 'r2' / 'telegram' / 'auto'），用于默认选中
      defaultNode: { type: String, default: '' },
      baseUrl: { type: String, default: '' }
    },

    emits: ['close', 'toast', 'request-open'],

    data() {
      return {
        role: null, // 'send' | 'recv'
        phase: 'choose', // choose|joining|waiting|linked|picking|uploading|staged|waiting-file|downloading|done|failed
        code: '',
        token: '',
        session: null,
        joinCode: '',
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
        scanning: false,
        scanStream: null,
        scanTimer: null,
        pendingCode: '',
        fileInputKey: 0,
        doneCount: 0,
        linkPulse: false
      };
    },

    computed: {
      /** 功能是否可用（后端关闭 / 没有中转节点） */
      available() {
        return Boolean(this.capability && this.capability.enabled);
      },

      /** 当前用户是否被允许使用 */
      permitted() {
        if (!this.available) return false;
        if (this.isGuest && !this.capability.guestAllowed) return false;
        return true;
      },

      /** 当前环境可用节点列表 */
      nodeList() {
        return Array.isArray(this.capability && this.capability.nodes) ? this.capability.nodes : [];
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

      digits() {
        return String(this.code || '').split('');
      },

      /** 舞台只在"已经建立关系"之后出现：选角色时不该有个空舞台 */
      stageVisible() {
        return Boolean(this.role) && this.phase !== 'choose' && this.phase !== 'failed';
      },

      upLive() {
        return ['linked', 'picking', 'uploading', 'staged', 'waiting-file', 'downloading', 'done'].includes(this.phase);
      },

      upFlowing() {
        return this.phase === 'uploading';
      },

      downLive() {
        return ['staged', 'downloading', 'done'].includes(this.phase) ||
          (this.role === 'recv' && ['linked', 'waiting-file'].includes(this.phase));
      },

      downFlowing() {
        return this.phase === 'downloading';
      },

      meNodeState() {
        if (this.phase === 'done') return 'is-done';
        if (this.upLive) return 'is-live';
        return '';
      },

      cloudNodeState() {
        if (this.phase === 'done') return 'is-done';
        if (['staged', 'downloading'].includes(this.phase)) return 'is-live';
        if (this.phase === 'uploading') return 'is-live is-active';
        return '';
      },

      peerNodeState() {
        if (this.phase === 'done') return 'is-done';
        if (this.upLive) return 'is-live';
        return '';
      },

      /** 当前进度值（0~1），驱动进度环与文件包位置 */
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
          linked: '已连接',
          picking: '选择中转节点与文件',
          uploading: '正在上传到存储节点',
          staged: '已送达存储节点',
          'waiting-file': '等待对方发送文件',
          downloading: '正在接收文件',
          done: '投送完成',
          failed: '本次投送已中断'
        };
        return map[this.phase] || '';
      },

      statusSub() {
        const map = {
          choose: '两端都在本页打开隔空投送，一端发送、一端接收。',
          joining: '也可以直接扫对方屏幕上的二维码。',
          waiting: '让对方扫描二维码，或把这 8 位连接码告诉对方。',
          linked: this.role === 'send' ? '对方已就位，选好节点和文件即可发送。' : '连接已建立，等对方选择文件。',
          picking: this.nodeList.length > 1 ? '选择中转节点，再选取要发送的文件（可多选）。' : `中转节点：${this.backendLabel} · 单文件上限 ${this.maxLabel}。`,
          uploading: '上传完成后对方会自动开始接收。',
          staged: '对方正在接收…',
          'waiting-file': '对方选好文件后会自动开始传送。',
          downloading: '接收完成后两端会同时收到提示。',
          done: '文件已保存到本地。',
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
        return ['waiting', 'linked', 'picking', 'uploading', 'staged', 'waiting-file', 'downloading'].includes(this.phase);
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
        if (p && /^[A-Za-z0-9]{8}$/.test(p)) {
          this.pendingCode = p.toUpperCase();
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
        if (!this.permitted) {
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
        this.role = null;
        this.phase = 'choose';
        this.code = '';
        this.token = '';
        this.session = null;
        this.joinCode = '';
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
        this.busy = false;
        this.leaving = false;
        this.pausedByIdle = false;
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
        if (!this.permitted) {
          this.notice = '当前身份不可使用隔空投送。';
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
        if (!this.permitted) {
          this.notice = '当前身份不可使用隔空投送。';
          this.noticeTone = 'warn';
          return;
        }
        this.role = 'recv';
        this.phase = 'joining';
      },

      async joinRoom() {
        const code = String(this.joinCode || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{8}$/.test(code)) {
          this.notice = '连接码为 8 位字母数字组合。';
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

      playLinkPulse() {
        this.linkPulse = true;
        this.notice = '';
        setTimeout(() => { this.linkPulse = false; }, 1600);
      },

      async startScan() {
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
              const m = /(?:airdrop=)?([A-Za-z0-9]{8})/.exec(hit.rawValue);
              const code = m ? m[1] : String(hit.rawValue).trim();
              if (/^[A-Za-z0-9]{8}$/.test(code)) {
                this.joinCode = code.toUpperCase();
                this.stopScan();
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
        this.poll();
      },

      stopPolling() {
        if (this.pollTimer) {
          clearTimeout(this.pollTimer);
          this.pollTimer = null;
        }
      },

      /** 当前该用哪一档节奏：传输中快拍，纯等待慢拍 */
      currentPollInterval() {
        if (this.role === 'recv' && (this.phase === 'waiting-file' || this.phase === 'downloading')) {
          return POLL_INTERVAL; // 对端正在传，要尽快接住 uploaded 的跃迁
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
          this.notice = '超过 5 分钟没有进展，已暂停等待。对方可能已离开；可点「继续等待」恢复，或取消本次投送。';
          this.noticeTone = 'info';
          return;
        }

        this.pollBusy = true;
        try {
          const res = await fetch(
            this.api('/api/airdrop/status?code=' + encodeURIComponent(this.code) + '&token=' + encodeURIComponent(this.token)),
            { credentials: 'same-origin', cache: 'no-store' }
          );
          const data = await res.json().catch(() => ({}));
          // 修复：主动取消/重置后，早前在途的轮询回包一律作废 ——
          // 否则自己点取消，却看到「对方取消了本次投送」。
          if (this.leaving || !this.code || !this.token) return;
          if (!res.ok) {
            if (res.status === 404) this.failWith(data.error || '连接码已失效。');
            return;
          }
          this.session = data.session;
          this.applyServerStatus(data.session);
        } catch (e) {
          /* 轮询失败不打断：下一拍会重试 */
        } finally {
          this.pollBusy = false;
          this.scheduleNextPoll();
        }
      },

      applyServerStatus(s) {
        if (!s) return;
        this.touchActivity(s);
        if (s.status === 'done') {
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
          if (s.status === 'waiting') {
            this.phase = 'waiting';
          } else if (s.status === 'linked') {
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
          this.phase = 'waiting-file';
        } else if (s.status === 'uploaded' && this.phase !== 'downloading' && this.phase !== 'done') {
          this.beginDownload();
        }
      },

      failWith(message) {
        this.stopPolling();
        this.errorMsg = message;
        this.phase = 'failed';
        this.notice = message;
        this.noticeTone = 'error';
        this.toast(message, 'error');
      },

      onFinished() {
        this.notice = '';
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

      async pickCloud() {
        this.cloudOpen = !this.cloudOpen;
        if (!this.cloudOpen || this.cloudFiles.length) return;
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
        } finally {
          this.cloudLoading = false;
        }
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
        this.phase = 'uploading';
        this.uploadProgress = 0;
        this.sentBytes = 0;
        const total = this.totalSelectedSize;
        const files = this.selectedFiles.slice();
        const last = files.length - 1;

        try {
          for (let i = 0; i < files.length; i += 1) {
            const f = files[i];
            const isFinal = i === last;
            const url = this.api('/api/airdrop/upload?code=' + encodeURIComponent(this.code) +
              '&token=' + encodeURIComponent(this.token) +
              '&node=' + encodeURIComponent(this.selectedNode) +
              '&final=' + (isFinal ? '1' : '0'));

            if (f.kind === 'local') {
              const form = new FormData();
              form.append('file', f.file, f.name);
              await this.xhrUpload(url, form, f.size, total);
            } else {
              const res = await fetch(url, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source: 'cloud', url: f.url, fileName: f.name })
              });
              const data = await res.json().catch(() => ({}));
              if (!res.ok) throw new Error(data.error || '发送失败');
              this.sentBytes += f.size;
              this.uploadProgress = total ? Math.min(1, this.sentBytes / total) : 1;
            }
          }
          this.uploadProgress = 1;
          this.phase = 'staged';
          this.toast('已上传到存储节点，等待对方接收', 'success');
        } catch (e) {
          this.failWith(e && e.message ? e.message : '发送失败。');
        } finally {
          this.busy = false;
        }
      },

      /**
       * 用 XHR 而不是 fetch：只有 XHR 能给出可靠的上传进度事件。
       * 云端文件是服务端自己拉的（不经过浏览器），所以那边没有进度可报。
       */
      xhrUpload(url, form, fileSize, total) {
        const self = this;
        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', url);
          xhr.withCredentials = true;
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && e.total) {
              const p = total ? (self.sentBytes + e.loaded) / total : Math.min(1, e.loaded / (e.total || 1));
              self.uploadProgress = Math.min(1, p);
            }
          };
          xhr.onload = () => {
            let data = {};
            try { data = JSON.parse(xhr.responseText || '{}'); } catch (e) { /* 非 JSON 忽略 */ }
            if (xhr.status >= 200 && xhr.status < 300) {
              self.sentBytes += fileSize;
              self.uploadProgress = total ? Math.min(1, self.sentBytes / total) : 1;
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
        if (this.phase === 'downloading' || this.phase === 'done') return;
        const files = (this.session && this.session.files) || [];
        if (!files.length) return;
        this.phase = 'downloading';
        this.downloadProgress = 0;
        this.receivedBytes = 0;
        this.doneCount = 0;
        const total = this.session.totalSize || files.reduce((a, f) => a + (f.size || 0), 0);

        try {
          for (let i = 0; i < files.length; i += 1) {
            const meta = files[i];
            const url = this.api('/api/airdrop/download?code=' + encodeURIComponent(this.code) +
              '&token=' + encodeURIComponent(this.token) + '&idx=' + i);
            const res = await fetch(url, { credentials: 'same-origin' });
            if (!res.ok) {
              let msg = '接收失败。';
              try { const d = await res.json(); msg = d.error || msg; } catch (e) { /* 忽略 */ }
              throw new Error(msg);
            }
            const name = fileNameFromHeader(res.headers.get('content-disposition')) || meta.name || ('airdrop-file-' + i);
            const chunks = [];
            let received = 0;
            if (res.body && typeof res.body.getReader === 'function') {
              const reader = res.body.getReader();
              for (;;) {
                const step = await reader.read();
                if (step.done) break;
                chunks.push(step.value);
                received += step.value.length;
                this.downloadProgress = total ? Math.min(1, (this.receivedBytes + received) / total) : Math.min(0.95, this.downloadProgress + 0.04);
              }
            } else {
              chunks.push(await res.arrayBuffer());
            }
            this.saveBlob(new Blob(chunks, { type: meta.type || 'application/octet-stream' }), name);
            this.receivedBytes += (meta.size || received);
            this.doneCount += 1;
            this.downloadProgress = total ? Math.min(1, this.receivedBytes / total) : 1;
          }

          // 全部接收完，通知后端完成并清理中转节点
          await fetch(this.api('/api/airdrop/complete'), {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: this.code, token: this.token })
          });
          this.phase = 'done';
          this.stopPolling();
          this.onFinished();
        } catch (e) {
          this.failWith(e && e.message ? e.message : '接收失败。');
        }
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
          this.notice = '已接收完成，但浏览器未能自动保存，请检查下载权限。';
          this.noticeTone = 'warn';
        }
      },

      // ── 取消 / 重来 ───────────────────────────────────
      async cancelRoom(silent) {
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
          this.toast('连接码已复制', 'success');
        } catch (e) {
          this.toast('复制失败，请手动记下连接码', 'error');
        }
      }
    },

    template: `
<transition name="dialog">
  <div class="modal-mask modal-mask--center" v-if="visible" @click.self="requestClose">
    <div class="modal ad-modal" role="dialog" aria-modal="true" aria-label="隔空投送" @click.stop>

      <div class="ad-head">
        <div class="ad-head__title">
          <i class="fas fa-paper-plane"></i>
          <span>隔空投送</span>
          <span class="ad-beta">BETA</span>
        </div>
        <div class="ad-head__spacer"></div>
        <button class="btn btn--ghost btn--icon" @click="requestClose" title="关闭">
          <i class="fas fa-xmark"></i>
        </button>
      </div>

      <div class="ad-body">

        <!-- 角色选择 -->
        <div class="ad-roles" v-if="phase === 'choose'">
          <button class="ad-role" :class="{ 'is-active': role === 'send' }" @click="chooseSend" :disabled="busy">
            <span class="ad-role__icon"><i class="fas fa-arrow-up-from-bracket"></i></span>
            <span class="ad-role__label">我要发送</span>
            <span class="ad-role__hint">生成二维码与连接码，等对方接入后选择文件</span>
          </button>
          <button class="ad-role" :class="{ 'is-active': role === 'recv' }" @click="chooseRecv">
            <span class="ad-role__icon" style="background:linear-gradient(140deg,#34d399,#10b981)">
              <i class="fas fa-arrow-down-to-bracket"></i>
            </span>
            <span class="ad-role__label">我要接收</span>
            <span class="ad-role__hint">扫描对方二维码，或输入 8 位连接码</span>
          </button>
        </div>

        <!-- 三节点舞台 -->
        <div class="ad-stage" v-if="stageVisible">
          <div class="ad-node" :class="meNodeState">
            <span class="ad-node__pulse"></span>
            <i class="fas" :class="role === 'send' ? 'fa-mobile-screen' : 'fa-user'"></i>
            <span class="ad-node__label">我</span>
          </div>

          <div class="ad-track" :class="{ 'is-live': upLive, 'is-flowing': upFlowing }"
               :style="{ '--ad-p': activeProgress }">
            <span class="ad-track__fill"></span>
            <span class="ad-track__beam"></span>
            <span class="ad-packet"><i class="fas fa-file-lines"></i></span>
          </div>

          <div class="ad-node ad-node--cloud" :class="cloudNodeState">
            <span class="ad-node__pulse"></span>
            <i class="fas fa-cloud"></i>
            <span class="ad-node__label">存储节点</span>
          </div>

          <div class="ad-track" :class="{ 'is-live': downLive, 'is-flowing': downFlowing }"
               :style="{ '--ad-p': activeProgress }">
            <span class="ad-track__fill"></span>
            <span class="ad-track__beam"></span>
            <span class="ad-packet"><i class="fas fa-file-lines"></i></span>
          </div>

          <div class="ad-node" :class="peerNodeState">
            <span class="ad-node__pulse"></span>
            <i class="fas fa-user-group"></i>
            <span class="ad-node__label">对方</span>
          </div>
        </div>

        <!-- 发端：二维码 + 连接码 -->
        <div class="ad-code" v-if="role === 'send' && phase === 'waiting'">
          <div class="ad-qr-wrap">
            <div class="ad-qr" v-html="qrSvg" @click="copyCode" title="点击复制连接码"></div>
          </div>
          <div class="ad-digits">
            <span class="ad-digit" v-for="(d, i) in digits" :key="i"
                  :style="{ 'animation-delay': (i * 0.045) + 's' }">{{ d }}</span>
          </div>
          <button class="btn btn--sm" @click="copyCode">
            <i class="fas fa-copy"></i><span>复制连接码</span>
          </button>
        </div>

        <!-- 收端：输入连接码 / 扫码 -->
        <div class="ad-join" v-if="role === 'recv' && phase === 'joining'">
          <input class="ad-code-input" v-model="joinCode" maxlength="8" placeholder="8 位连接码"
                 @keyup.enter="joinRoom" aria-label="连接码" />
          <div class="ad-actions">
            <button class="ad-btn ad-btn--primary" @click="joinRoom" :disabled="busy">
              <i class="fas fa-link"></i><span>连接</span>
            </button>
            <button class="ad-btn" @click="startScan" :disabled="scanning">
              <i class="fas fa-camera"></i><span>{{ scanning ? '扫描中…' : '扫码' }}</span>
            </button>
          </div>
          <video v-show="scanning" ref="scanVideo" muted playsinline
                 style="width:100%;max-width:280px;border-radius:var(--r-md);background:#000"></video>
        </div>

        <!-- 状态文案 -->
        <div class="ad-status" v-if="phase !== 'choose'">
          <div class="ad-status__title">
            <span v-if="phase === 'done'"><i class="fas fa-circle-check" style="color:var(--c-success)"></i> {{ statusTitle }}</span>
            <span v-else-if="inFlight">{{ statusTitle }}<span class="ad-dots"><i></i><i></i><i></i></span></span>
            <span v-else>{{ statusTitle }}</span>
          </div>
          <div class="ad-status__sub">{{ statusSub }}</div>
        </div>

        <!-- 发端：选择中转节点 -->
        <div class="ad-nodes" v-if="role === 'send' && (phase === 'picking' || (phase === 'linked' && !selectedFiles.length))">
          <div class="ad-nodes__label">中转节点</div>
          <div class="ad-nodes__row">
            <button class="ad-node-pick" v-for="n in nodeList" :key="n.key"
                    :class="{ 'is-on': selectedNode === n.key }" @click="selectedNode = n.key">
              <i class="fas" :class="n.key === 'r2' ? 'fa-cloud' : 'fa-paper-plane'"></i>
              <span>{{ n.label }}</span>
              <small>≤ {{ formatSizeLabel(n.maxBytes) }}</small>
            </button>
          </div>
        </div>

        <!-- 发端：选择文件来源 -->
        <div class="ad-actions" v-if="role === 'send' && (phase === 'picking' || (phase === 'linked' && !selectedFiles.length))">
          <button class="ad-btn ad-btn--primary" @click="pickLocal">
            <i class="fas fa-folder-open"></i><span>从本地选取</span>
          </button>
          <button class="ad-btn" @click="pickCloud" :disabled="cloudLoading">
            <i class="fas fa-cloud-arrow-up"></i><span>{{ cloudLoading ? '读取中…' : '从云端选取' }}</span>
          </button>
        </div>

        <!-- 云端文件列表（多选） -->
        <div class="ad-cloud" v-if="cloudOpen && cloudFiles.length">
          <button class="ad-cloud__row" v-for="f in cloudFiles" :key="f.key" @click="selectCloudFile(f)">
            <i class="fas" :class="isCloudSelected(f) ? 'fa-check-circle' : 'fa-file'" :style="isCloudSelected(f) ? 'color:var(--c-success)' : 'color:var(--primary)'"></i>
            <span class="ad-cloud__name">{{ f.name }}</span>
            <span class="ad-cloud__size">{{ formatSizeLabel(f.size) }}</span>
          </button>
        </div>
        <div class="ad-cloud" v-else-if="cloudOpen && !cloudLoading && !cloudFiles.length">
          <div class="ad-cloud__empty">云端暂无可选文件</div>
        </div>

        <!-- 已选文件清单（多文件） -->
        <div class="ad-files" v-if="role === 'send' && selectedFiles.length">
          <div class="ad-files__head">
            <span>已选择 {{ selectedFiles.length }} 个文件</span>
            <span v-if="totalSelectedSize">{{ formatSizeLabel(totalSelectedSize) }}</span>
          </div>
          <div class="ad-files__list">
            <div class="ad-file" v-for="(f, i) in selectedFiles" :key="i">
              <span class="ad-file__icon"><i class="fas fa-file-lines"></i></span>
              <span class="ad-file__meta">
                <span class="ad-file__name">{{ f.name }}</span>
                <span class="ad-file__size">{{ formatSizeLabel(f.size) }} · 来自{{ f.kind === 'local' ? '本地' : '云端' }}</span>
              </span>
              <button class="btn btn--ghost btn--icon btn--sm" @click="removeFile(i)" title="移除" :disabled="phase !== 'picking'">
                <i class="fas fa-xmark"></i>
              </button>
            </div>
          </div>
          <button class="ad-btn ad-btn--primary ad-btn--send" v-if="phase === 'picking'" @click="sendAll" :disabled="!canSend">
            <i class="fas fa-paper-plane"></i>
            <span>{{ oversize ? '有文件超出节点上限' : ('发送 ' + selectedFiles.length + ' 个文件') }}</span>
          </button>
        </div>

        <!-- 收端：对方已发来的文件清单 -->
        <div class="ad-files" v-if="role === 'recv' && session && session.files && session.files.length && (phase === 'waiting-file' || phase === 'downloading' || phase === 'done')">
          <div class="ad-files__head">
            <span>共 {{ session.fileCount }} 个文件</span>
            <span v-if="session.totalSize">{{ formatSizeLabel(session.totalSize) }}</span>
          </div>
          <div class="ad-files__list">
            <div class="ad-file" v-for="(f, i) in session.files" :key="i">
              <span class="ad-file__icon"><i class="fas" :class="(phase === 'done' || f.status === 'downloaded') ? 'fa-circle-check' : 'fa-file-lines'" :style="(phase === 'done' || f.status === 'downloaded') ? 'color:var(--c-success)' : ''"></i></span>
              <span class="ad-file__meta">
                <span class="ad-file__name">{{ f.name }}</span>
                <span class="ad-file__size">{{ formatSizeLabel(f.size) }}</span>
              </span>
            </div>
          </div>
        </div>

        <!-- 传输进度 -->
        <div class="ad-progress" v-if="phase === 'uploading' || phase === 'downloading'">
          <svg class="ad-ring" viewBox="0 0 62 62" :style="{ '--ad-p': activeProgress }">
            <circle class="ad-ring__bg" cx="31" cy="31" r="26"></circle>
            <circle class="ad-ring__val" cx="31" cy="31" r="26"></circle>
          </svg>
          <div class="ad-progress__text">{{ Math.round(activeProgress * 100) }}%</div>
          <div class="ad-progress__sub">{{ phase === 'uploading' ? '上传到存储节点' : ('接收中 ' + doneCount + '/' + (session ? session.fileCount : 0)) }}</div>
        </div>

        <!-- 完成 -->
        <div class="ad-done" v-if="phase === 'done'">
          <svg class="ad-check" viewBox="0 0 84 84" aria-hidden="true">
            <circle class="ad-check__circle" cx="42" cy="42" r="34"></circle>
            <path class="ad-check__mark" d="M26 43 L38 55 L58 32"></path>
          </svg>
        </div>

        <!-- 提示条 -->
        <div class="ad-note" :class="{ 'ad-note--warn': noticeTone === 'warn', 'ad-note--error': noticeTone === 'error' }"
             v-if="notice">
          <i class="fas" :class="noticeTone === 'error' ? 'fa-circle-exclamation' : (noticeTone === 'warn' ? 'fa-triangle-exclamation' : 'fa-circle-info')"></i>
          <span>{{ notice }}</span>
        </div>

      </div>

      <div class="ad-foot">
        <span>
          <i class="fas fa-server"></i> 节点 {{ backendLabel }} · 单文件上限 {{ maxLabel }}
        </span>
        <button class="btn btn--sm" v-if="pausedByIdle" @click="resumeWaiting">
          <i class="fas fa-rotate-right"></i><span>继续等待</span>
        </button>
        <button class="btn btn--sm" v-if="inFlight" @click="cancelRoom(false)">取消投送</button>
        <button class="btn btn--sm" v-else-if="phase === 'failed' || phase === 'done'" @click="reset">再来一次</button>
      </div>

      <input type="file" :key="fileInputKey" ref="fileInput" style="display:none" multiple @change="onFilePicked" />

    </div>
  </div>
</transition>
    `
  };

  AirdropPanel.methods.formatSizeLabel = formatSize;

  window.AirdropPanel = AirdropPanel;
})();
