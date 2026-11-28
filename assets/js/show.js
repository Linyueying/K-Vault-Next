(() => {
  const VALID_STYLES = ['journal', 'gallery', 'filmstrip'];
  const STYLE_LABELS = {
    journal: '',
    gallery: 'DARKROOM GALLERY',
    filmstrip: 'CONTACT SHEET',
  };
  const THEME_COLORS = {
    journal: '#f7f3eb',
    gallery: '#11100e',
    filmstrip: '#f4f5f2',
  };

  const header = document.getElementById('show-header');
  const navTitle = document.getElementById('show-nav-title');
  const titleAnchor = document.getElementById('show-title-anchor');
  const wordmark = document.getElementById('show-wordmark');
  const eyebrowEl = document.getElementById('show-eyebrow');
  const introEl = document.getElementById('show-intro');
  const coverCopy = document.getElementById('show-cover-copy');
  const coverSection = document.getElementById('show-cover');
  const cover = document.getElementById('cover-work');
  const shareTools = document.getElementById('share-tools');
  const filterBar = document.getElementById('show-filter-bar');
  const statWorks = document.getElementById('show-stat-works');
  const statGroups = document.getElementById('show-stat-groups');
  const footerStyle = document.getElementById('show-footer-style');
  const grid = document.getElementById('journal-grid');
  const journal = document.getElementById('journal');
  const status = document.getElementById('gallery-status');
  const more = document.getElementById('more-work');
  const template = document.getElementById('stack-template');
  const dialog = document.getElementById('show-lightbox');
  const stage = dialog.querySelector('.lightbox__stage');
  const zoomMedia = dialog.querySelector('.lightbox__media');
  const downloadBtn = document.getElementById('lightbox-download');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const ease = 'cubic-bezier(.2,.8,.2,1)';

  const previewParam = new URLSearchParams(location.search).get('preview_style');
  const previewOverride = VALID_STYLES.includes(previewParam) ? previewParam : null;

  let settings = {
    enabled: true,
    style: previewOverride || document.documentElement.dataset.showStyle || 'journal',
    title: 'Show',
    eyebrow: '影像手记',
    intro: '用照片和视频记录值得分享的片刻。',
    pageSize: 12,
    showShareButton: true,
    showTagFilter: true,
    showCaptions: true,
    allowDownload: false,
  };
  let activeStyle = settings.style;
  let activeTagFilter = 'all';

  const stacks = new Map();
  const visible = new Set();
  const stackByNode = new WeakMap();
  const seen = new Set();
  const allItems = [];
  let heroMediaBox = null;
  let heroItemId = null;
  let cursor = null;
  let loading = false;
  let frame = 0;
  let navigation;
  let viewing = null;
  let viewingOpenedFromHero = false;
  let closing = false;
  let zoomAnimation = null;
  let innerZoomAnimation = null;
  let startupCover = null;
  let borrowedImage = null;
  let activeZoomMediaBox = null;
  let badgeGhosts = [];
  const badgeReturnAnimations = new WeakMap();

  function wrappedIndex(index, length) {
    return ((index % length) + length) % length;
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function animate(element, keyframes, duration, options = {}) {
    if (reduced.matches || !element?.animate) return null;
    return element.animate(keyframes, { duration, easing: ease, ...options });
  }

  function setWordmarkText(el, text) {
    el.textContent = '';
    el.append(document.createTextNode(text));
    const dot = document.createElement('span');
    dot.textContent = '.';
    dot.setAttribute('aria-hidden', 'true');
    el.append(dot);
  }

  function applySettings(incoming) {
    if (incoming && typeof incoming === 'object') {
      settings = { ...settings, ...incoming };
    }
    const chosen = previewOverride || (VALID_STYLES.includes(settings.style) ? settings.style : 'journal');
    activeStyle = chosen;
    document.documentElement.dataset.showStyle = chosen;
    document.documentElement.dataset.showCaptions = settings.showCaptions !== false ? 'on' : 'off';

    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.content = THEME_COLORS[chosen] || THEME_COLORS.journal;

    const titleText = String(settings.title || 'Show').trim() || 'Show';
    document.title = titleText + ' · K-Vault';
    setWordmarkText(wordmark, titleText);
    setWordmarkText(navTitle, titleText);

    if (eyebrowEl) {
      const eyebrowText = String(settings.eyebrow || '').trim();
      eyebrowEl.textContent = eyebrowText || '影像手记';
      eyebrowEl.hidden = !eyebrowText && settings.eyebrow === '';
    }
    if (introEl) {
      introEl.textContent = String(settings.intro || '用照片和视频记录值得分享的片刻。').trim();
    }
    if (shareTools) {
      shareTools.hidden = settings.showShareButton === false;
    }
    if (footerStyle) {
      footerStyle.textContent = STYLE_LABELS[chosen] || '';
    }
    measureScroll();
  }

  function readNavigation(scrollY) {
    const origin = titleAnchor.getBoundingClientRect();
    const target = navTitle.getBoundingClientRect();
    const originTop = origin.top + scrollY;
    const distance = originTop - target.top;
    const start = Math.max(0, Math.min(46, distance * .17));
    return {
      originTop,
      targetTop: target.top,
      dx: target.left - origin.left,
      scale: target.height / Math.max(1, origin.height),
      start,
      end: Math.max(start + 76, distance + origin.height * .23),
    };
  }

  function paintNavigation(scrollY) {
    const { originTop, targetTop, dx, scale, start, end } = navigation;
    const progress = Math.min(1, Math.max(0, (scrollY - start) / (end - start)));
    const docked = progress === 1;
    header.classList.toggle('is-scrolled', scrollY > 8);
    header.classList.toggle('has-title', docked);
    wordmark.classList.toggle('is-docked', docked);
    if (reduced.matches) return;

    const glide = progress * progress * (3 - 2 * progress);
    coverCopy.style.setProperty('--cover-copy-alpha', (1 - glide * .94).toFixed(3));
    if (docked) return;
    wordmark.style.setProperty('--wordmark-x', (dx * glide).toFixed(2) + 'px');
    wordmark.style.setProperty('--wordmark-y', ((targetTop - originTop + scrollY) * glide).toFixed(2) + 'px');
    wordmark.style.setProperty('--wordmark-scale', (1 + (scale - 1) * glide).toFixed(5));
  }

  function scheduleScroll() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const scrollY = Math.max(0, window.scrollY);
      navigation ??= readNavigation(scrollY);

      const height = window.innerHeight;
      const positions = (reduced.matches || activeStyle !== 'journal') ? [] : [...visible].map(stack => {
        const rect = stack.getBoundingClientRect();
        const position = Math.max(-1, Math.min(1, (height / 2 - rect.top - rect.height / 2) / height));
        return { stack, position, travel: Math.min(32, rect.height * .085) };
      });

      paintNavigation(scrollY);
      for (const { stack, position, travel } of positions) {
        stack.style.setProperty('--parallax-pile', (position * -16).toFixed(1) + 'px');
        stack.style.setProperty('--parallax-paper', (position * 9).toFixed(1) + 'px');
        stack.style.setProperty('--parallax-image', (position * travel).toFixed(1) + 'px');
      }
    });
  }

  function measureScroll() {
    navigation = null;
    scheduleScroll();
  }

  const motionObserver = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    for (const { target, isIntersecting } of entries) {
      if (isIntersecting) visible.add(target);
      else visible.delete(target);
      const stack = stackByNode.get(target);
      if (isIntersecting && stack) warmGroup(stack);
    }
    scheduleScroll();
  }, { rootMargin: '160px' }) : null;

  if (typeof ResizeObserver === 'function') {
    const layoutObserver = new ResizeObserver(measureScroll);
    layoutObserver.observe(titleAnchor);
    layoutObserver.observe(cover);
    layoutObserver.observe(header);
  }

  window.addEventListener('scroll', scheduleScroll, { passive: true });
  window.addEventListener('resize', measureScroll);
  window.addEventListener('pageshow', measureScroll);
  reduced.addEventListener?.('change', scheduleScroll);
  scheduleScroll();

  function ratioFrom(media, fallback) {
    return (media?.naturalWidth && media.naturalHeight && media.naturalWidth / media.naturalHeight) ||
      (media?.videoWidth && media.videoHeight && media.videoWidth / media.videoHeight) || fallback;
  }

  function startMedia(media, priority = 'auto') {
    if (!media?.dataset.source) return;
    if (media.tagName === 'IMG') media.fetchPriority = priority;
    media.src = media.dataset.source;
    delete media.dataset.source;
  }

  function warmGroup(stack, direction = 1, intentional = false) {
    if (activeStyle !== 'journal') {
      for (const card of stack.cards.values()) {
        const media = card.querySelector('img,video');
        if (media) startMedia(media, 'auto');
      }
      return;
    }
    if (!intentional && !stack.featured && !visible.has(stack.node)) return;
    const item = stack.items[stack.index];
    const front = stack.cards.get(item.id)?.querySelector('img,video');
    if (!front) return;
    startMedia(front, stack.featured && stack.index === 0 ? 'high' : 'auto');
    const ready = front.tagName === 'IMG' ? front.naturalWidth > 0 || front.hidden : front.readyState >= 1 || front.error;
    const connection = navigator.connection;
    if (!intentional && (!ready || connection?.saveData || /2g$/.test(connection?.effectiveType || ''))) return;
    if (stack.items.length < 2) return;

    const next = stack.items[wrappedIndex(stack.index + direction, stack.items.length)];
    if (next.kind === 'image' || intentional) {
      startMedia(stack.cards.get(next.id)?.querySelector('img,video'), intentional ? 'auto' : 'low');
    }
  }

  function createMedia(item, isZoom, allowStartup = true) {
    const video = item.kind === 'video';
    const early = allowStartup && startupCover?.id === item.id && !isZoom ? startupCover : null;
    const media = early ? early.image : document.createElement(video ? 'video' : 'img');
    if (early) startupCover = null;
    if (video) {
      media.preload = 'metadata';
      media.playsInline = true;
      media.controls = isZoom;
      media.setAttribute('aria-label', item.title);
      if (!isZoom) {
        media.muted = true;
        media.disablePictureInPicture = true;
      }
    } else {
      media.alt = isZoom ? item.title : '';
      media.draggable = false;
      media.decoding = 'async';
    }
    if (!early) {
      media.dataset.source = item.src;
      if (isZoom) startMedia(media, 'high');
    }
    return media;
  }

  function attachMedia(container, media) {
    const notice = document.createElement('span');
    notice.className = 'media-unavailable';
    notice.textContent = '当前浏览器暂时无法显示这份作品。';
    notice.hidden = true;
    if (media.tagName === 'IMG') {
      const reveal = () => { media.dataset.ready = 'true'; };
      if (media.complete && media.naturalWidth) reveal();
      else media.addEventListener('load', reveal, { once: true });
    }
    const showError = () => {
      media.hidden = true;
      notice.hidden = false;
    };
    if (media.dataset.failed) showError();
    else media.addEventListener('error', showError, { once: true });
    container.append(media, notice);
  }

  function addPlayBadgeIfVideo(frame, item) {
    if (item.kind !== 'video') return;
    const play = document.createElement('span');
    play.className = 'stack-card__play';
    play.textContent = '▶';
    play.setAttribute('aria-hidden', 'true');
    frame.append(play);
  }

  /* ── 样式一：纸感手记（默认）照片叠卡片 ── */
  function createJournalCard(stack, item) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'stack-card';
    card.setAttribute('aria-haspopup', 'dialog');
    card.setAttribute('aria-label', (item.kind === 'video' ? '播放 ' : '放大 ') + item.title);
    const frame = document.createElement('span');
    frame.className = 'stack-card__media';
    const media = createMedia(item, false);
    attachMedia(frame, media);
    const warmNeighbor = () => {
      if (stack.items[stack.index] === item) warmGroup(stack, stack.drag?.direction || 1);
    };
    media.addEventListener(item.kind === 'image' ? 'load' : 'loadedmetadata', warmNeighbor, { once: true });
    media.addEventListener('error', warmNeighbor, { once: true });
    addPlayBadgeIfVideo(frame, item);
    card.append(frame);
    card.addEventListener('click', () => {
      if (stack.moving || stack.drag || performance.now() < stack.suppressClickUntil || stack.items[stack.index] !== item) return;
      openViewer(stack, stack.index, frame, false);
    });
    return card;
  }

  function renderJournalStack(stack, direction = 1, intentional = false) {
    const { items, index, cards, pile, node } = stack;
    const order = [index, wrappedIndex(index + direction, items.length), wrappedIndex(index + 2 * direction, items.length)];
    const displayed = [...new Set(order)].map(position => items[position]);
    const ids = new Set(displayed.map(item => item.id));
    for (const [id, card] of cards) {
      if (ids.has(id)) continue;
      card.remove();
      cards.delete(id);
    }
    displayed.forEach((item, depth) => {
      let card = cards.get(item.id);
      if (!card) {
        card = createJournalCard(stack, item);
        cards.set(item.id, card);
        pile.append(card);
      }
      card.dataset.depth = String(depth);
      card.tabIndex = depth ? -1 : 0;
      if (depth) card.setAttribute('aria-hidden', 'true');
      else card.removeAttribute('aria-hidden');
    });
    const item = items[index];
    node.querySelector('.stack__count').textContent = (index + 1) + ' / ' + items.length;
    node.querySelector('.stack__controls').hidden = items.length < 2;
    if (stack.displayedId !== item.id) {
      node.querySelector('.stack__title').textContent = item.title;
      const caption = node.querySelector('.stack__caption');
      caption.hidden = !item.caption;
      caption.textContent = item.caption || '';
      if (stack.displayedId !== undefined) {
        const text = node.querySelector('.stack__text');
        stack.captionAnimation?.cancel();
        stack.captionAnimation = animate(text, [
          { opacity: .35, transform: 'translateY(4px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ], 240);
      }
      stack.displayedId = item.id;
    }
    warmGroup(stack, direction, intentional);
  }

  function setDrag(stack, offset) {
    stack.pile.style.setProperty('--drag', offset + 'px');
    stack.pile.style.setProperty('--drag-tilt', offset / 27 + 'deg');
    stack.pile.style.setProperty('--drag-lift', Math.min(Math.abs(offset) / 9, 15) + 'px');
  }

  async function moveStack(stack, direction) {
    if (stack.items.length < 2 || stack.moving) return;
    stack.moving = true;
    renderJournalStack(stack, direction, true);
    const top = stack.cards.get(stack.items[stack.index].id);
    const keepFocus = document.activeElement === top;
    const outgoing = animate(top, [
      { transform: getComputedStyle(top).transform, opacity: 1 },
      { transform: 'translate3d(' + (-direction * Math.max(180, stack.pile.clientWidth * .64)) + 'px,-12px,0) rotate(' + (-direction * 19) + 'deg)', opacity: 0 },
    ], 260, { fill: 'forwards' });
    if (outgoing) await outgoing.finished.catch(() => {});
    stack.index = wrappedIndex(stack.index + direction, stack.items.length);
    setDrag(stack, 0);
    renderJournalStack(stack);
    outgoing?.cancel();
    stack.moving = false;
    if (keepFocus) stack.cards.get(stack.items[stack.index].id).focus({ preventScroll: true });
  }

  function wireJournalStack(stack) {
    const { pile, node } = stack;
    node.querySelectorAll('[data-step]').forEach(button => {
      button.addEventListener('click', () => void moveStack(stack, Number(button.dataset.step)));
    });
    node.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || stack.items.length < 2) return;
      event.preventDefault();
      void moveStack(stack, event.key === 'ArrowLeft' ? -1 : 1);
    });

    pile.addEventListener('pointerdown', event => {
      if (stack.items.length < 2 || stack.moving || stack.drag || event.button !== 0 || !event.isPrimary) return;
      stack.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, offset: 0, direction: 0 };
    });
    pile.addEventListener('pointermove', event => {
      const drag = stack.drag;
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.direction) {
        if (Math.abs(dy) > 9 && Math.abs(dy) > Math.abs(dx)) {
          stack.drag = null;
          return;
        }
        if (Math.abs(dx) < 8) return;
        pile.setPointerCapture(event.pointerId);
        pile.dataset.dragging = 'true';
      }
      const direction = dx < 0 ? 1 : -1;
      if (direction !== drag.direction) renderJournalStack(stack, direction, true);
      drag.direction = direction;
      drag.offset = Math.max(-180, Math.min(180, dx * .82));
      setDrag(stack, drag.offset);
    });
    function endDrag(event) {
      const drag = stack.drag;
      if (!drag || event.pointerId !== drag.id) return;
      stack.drag = null;
      delete pile.dataset.dragging;
      if (drag.direction) stack.suppressClickUntil = performance.now() + 300;
      if (event.type === 'pointerup' && Math.abs(drag.offset) >= 42) {
        void moveStack(stack, drag.direction);
      } else {
        setDrag(stack, 0);
        renderJournalStack(stack);
      }
    }
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture', 'pointerleave']) pile.addEventListener(type, endDrag);
  }

  /* ── 样式二：暗房画廊（gallery）与样式三：极简印样（filmstrip）卡片构建 ── */
  function createGalleryTile(stack, item, idx, isHero = false) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = isHero ? 'gallery-tile gallery-tile--hero' : 'gallery-tile';
    tile.setAttribute('aria-haspopup', 'dialog');
    tile.setAttribute('aria-label', (item.kind === 'video' ? '播放 ' : '放大 ') + item.title);

    const mediaBox = document.createElement('span');
    mediaBox.className = 'gallery-tile__media';
    const media = createMedia(item, false, isHero);
    attachMedia(mediaBox, media);
    if (isHero) startMedia(media, 'high');
    addPlayBadgeIfVideo(mediaBox, item);

    const badge = document.createElement('span');
    badge.className = 'gallery-tile__index';
    badge.textContent = isHero ? ('FEATURED · ' + stack.label) : pad2(idx + 1);
    mediaBox.append(badge);

    const meta = document.createElement('span');
    meta.className = 'gallery-tile__meta';
    const title = document.createElement('strong');
    title.className = 'gallery-tile__title';
    title.textContent = item.title;
    meta.append(title);
    if (item.caption) {
      const cap = document.createElement('p');
      cap.className = 'gallery-tile__caption';
      cap.textContent = item.caption;
      meta.append(cap);
    }

    tile.append(mediaBox, meta);
    tile.addEventListener('click', () => {
      openViewer(stack, idx, mediaBox, isHero);
    });
    return { tile, mediaBox };
  }

  function createFilmFrame(stack, item, idx, isHero = false) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = isHero ? 'film-frame film-frame--hero' : 'film-frame';
    card.setAttribute('aria-haspopup', 'dialog');
    card.setAttribute('aria-label', (item.kind === 'video' ? '播放 ' : '放大 ') + item.title);

    const strip = document.createElement('span');
    strip.className = 'film-frame__strip';
    const code = document.createElement('strong');
    code.textContent = isHero ? '00A' : (pad2(idx + 1) + 'A');
    const kind = document.createElement('span');
    kind.textContent = (isHero ? stack.label + ' · ' : '') + (item.kind === 'video' ? 'VID' : 'IMG');
    strip.append(code, kind);

    const mediaBox = document.createElement('span');
    mediaBox.className = 'film-frame__media';
    const media = createMedia(item, false, isHero);
    attachMedia(mediaBox, media);
    if (isHero) startMedia(media, 'high');
    addPlayBadgeIfVideo(mediaBox, item);

    const meta = document.createElement('span');
    meta.className = 'film-frame__meta';
    const title = document.createElement('strong');
    title.className = 'film-frame__title';
    title.textContent = item.title;
    meta.append(title);
    if (item.caption) {
      const cap = document.createElement('p');
      cap.className = 'film-frame__caption';
      cap.textContent = item.caption;
      meta.append(cap);
    }

    card.append(strip, mediaBox, meta);
    card.addEventListener('click', () => {
      openViewer(stack, idx, mediaBox, isHero);
    });
    return { tile: card, mediaBox };
  }

  function renderGroup(stack) {
    if (activeStyle === 'journal') {
      renderJournalStack(stack);
      return;
    }
    const { items, cards, container } = stack;
    items.forEach((item, idx) => {
      if (cards.has(item.id)) return;
      const { tile } = activeStyle === 'gallery'
        ? createGalleryTile(stack, item, idx, false)
        : createFilmFrame(stack, item, idx, false);
      cards.set(item.id, tile);
      container.append(tile);
      if (visible.has(stack.node)) {
        const media = tile.querySelector('img,video');
        if (media) startMedia(media, 'auto');
      }
    });
    if (stack.countNode) {
      stack.countNode.textContent = activeStyle === 'filmstrip'
        ? pad2(items.length) + ' FRAMES'
        : items.length + ' 件作品';
    }
    if (stack.navNode) {
      stack.navNode.hidden = items.length < 2;
    }
  }

  function ensureHeroCard(firstStack, firstItem) {
    if (activeStyle === 'journal' || heroMediaBox) return;
    const { tile, mediaBox } = activeStyle === 'gallery'
      ? createGalleryTile(firstStack, firstItem, 0, true)
      : createFilmFrame(firstStack, firstItem, 0, true);
    heroMediaBox = mediaBox;
    heroItemId = firstItem.id;
    cover.replaceChildren(tile);
  }

  function updateStatsAndFilters() {
    if (statWorks) statWorks.textContent = pad2(allItems.length);
    if (statGroups) statGroups.textContent = pad2(stacks.size);

    if (!filterBar) return;
    if (settings.showTagFilter === false || stacks.size < 2) {
      filterBar.hidden = true;
      return;
    }

    filterBar.hidden = false;
    const buttons = [];
    const makeBtn = (key, text, count) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'show-filter__btn' + (activeTagFilter === key ? ' is-active' : '');
      btn.setAttribute('aria-pressed', String(activeTagFilter === key));
      btn.append(document.createTextNode(text));
      const c = document.createElement('span');
      c.className = 'show-filter__count';
      c.textContent = String(count);
      btn.append(c);
      btn.addEventListener('click', () => {
        activeTagFilter = key;
        applyTagFilter();
      });
      return btn;
    };

    buttons.push(makeBtn('all', '全部', allItems.length));
    for (const [key, stack] of stacks) {
      buttons.push(makeBtn(key, stack.label, stack.items.length));
    }
    filterBar.replaceChildren(...buttons);
  }

  function applyTagFilter() {
    let visibleJournalCount = 0;
    for (const [key, stack] of stacks) {
      const matched = activeTagFilter === 'all' || activeTagFilter === key;
      if (activeStyle === 'journal') {
        if (stack.featured) {
          stack.node.hidden = !matched;
        } else {
          stack.node.hidden = !matched;
          if (matched) visibleJournalCount += 1;
        }
      } else {
        stack.node.hidden = !matched;
        if (matched) visibleJournalCount += 1;
      }
    }
    if (activeStyle === 'journal') {
      journal.hidden = visibleJournalCount === 0;
    } else {
      journal.hidden = stacks.size === 0;
    }
    updateStatsAndFilters();
    measureScroll();
  }

  function createGroupNode(key, label, groupIndex) {
    if (activeStyle === 'journal') {
      const featured = !stacks.size;
      const node = template.content.firstElementChild.cloneNode(true);
      const heading = node.querySelector('h3');
      heading.textContent = label;
      if (featured) {
        const title = document.createElement('h2');
        title.textContent = heading.textContent;
        heading.replaceWith(title);
      }
      const pile = node.querySelector('.stack__pile');
      pile.setAttribute('aria-label', label);
      const stack = {
        key, label, node, pile, featured,
        items: [], cards: new Map(), index: 0,
        moving: false, drag: null, suppressClickUntil: 0,
      };
      (featured ? cover : grid).append(node);
      if (!featured) journal.hidden = false;
      wireJournalStack(stack);
      return stack;
    }

    if (activeStyle === 'gallery') {
      const room = document.createElement('section');
      room.className = 'exhibition-room';
      const head = document.createElement('div');
      head.className = 'exhibition-room__head';
      const h3 = document.createElement('h3');
      h3.className = 'exhibition-room__title';
      const num = document.createElement('span');
      num.textContent = pad2(groupIndex + 1);
      h3.append(num, document.createTextNode(label));
      const countNode = document.createElement('span');
      countNode.className = 'exhibition-room__count';
      head.append(h3, countNode);
      const container = document.createElement('div');
      container.className = 'gallery-grid';
      room.append(head, container);
      grid.append(room);
      journal.hidden = false;
      return {
        key, label, node: room, container, countNode, featured: false,
        items: [], cards: new Map(), index: 0,
      };
    }

    // filmstrip
    const chapter = document.createElement('section');
    chapter.className = 'film-chapter';
    const bar = document.createElement('div');
    bar.className = 'film-chapter__bar';
    const heading = document.createElement('div');
    heading.className = 'film-chapter__heading';
    const num = document.createElement('span');
    num.className = 'film-chapter__num';
    num.textContent = 'CH.' + pad2(groupIndex + 1);
    const h3 = document.createElement('h3');
    h3.className = 'film-chapter__title';
    h3.textContent = label;
    const countNode = document.createElement('span');
    countNode.className = 'film-chapter__count';
    heading.append(num, h3, countNode);

    const navNode = document.createElement('div');
    navNode.className = 'film-chapter__nav';
    navNode.hidden = true;
    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'film-chapter__btn';
    prevBtn.setAttribute('aria-label', '向左滚动印样');
    prevBtn.textContent = '‹';
    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'film-chapter__btn';
    nextBtn.setAttribute('aria-label', '向右滚动印样');
    nextBtn.textContent = '›';
    navNode.append(prevBtn, nextBtn);

    bar.append(heading, navNode);
    const rail = document.createElement('div');
    rail.className = 'film-rail';
    rail.setAttribute('role', 'region');
    rail.setAttribute('aria-label', label);

    const scrollRail = (dir) => {
      const step = Math.max(260, rail.clientWidth * 0.72);
      rail.scrollBy({ left: dir * step, behavior: reduced.matches ? 'auto' : 'smooth' });
    };
    prevBtn.addEventListener('click', () => scrollRail(-1));
    nextBtn.addEventListener('click', () => scrollRail(1));

    chapter.append(bar, rail);
    grid.append(chapter);
    journal.hidden = false;
    return {
      key, label, node: chapter, container: rail, countNode, navNode, featured: false,
      items: [], cards: new Map(), index: 0,
    };
  }

  function appendItems(items) {
    const updated = new Set();
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      allItems.push(item);
      const tag = String(item.tag || '').normalize('NFKC').trim();
      const key = tag.toLowerCase();
      const label = tag ? '#' + tag : '未加标签';
      let stack = stacks.get(key);
      if (!stack) {
        stack = createGroupNode(key, label, stacks.size);
        stacks.set(key, stack);
        stackByNode.set(stack.node, stack);
        if (motionObserver) motionObserver.observe(stack.node);
        else visible.add(stack.node);
      }
      stack.items.push(item);
      if (allItems.length === 1) ensureHeroCard(stack, item);
      updated.add(stack);
    }
    for (const stack of updated) {
      if (!stack.moving && !stack.drag) renderGroup(stack);
    }
    applyTagFilter();
  }

  /* ── Lightbox 与精准 FLIP 倾斜同步动画（分离阴影层、消除展开抖动与裁切闪烁） ── */
  function lockPageScroll() {
    const scrollbarWidth = Math.max(
      0,
      window.innerWidth - document.documentElement.clientWidth,
      window.innerWidth - document.body.clientWidth
    );
    // 先写入补偿宽度再切换 show-zoomed，避免先去掉 scrollbar-gutter 引发中间态重排导致 scroll anchoring 偏移
    document.documentElement.style.setProperty('--scrollbar-comp', scrollbarWidth + 'px');
    document.documentElement.classList.add('show-zoomed');
  }

  function unlockPageScroll() {
    document.documentElement.classList.remove('show-zoomed');
    document.documentElement.style.removeProperty('--scrollbar-comp');
  }

  function clearBadgeGhosts() {
    for (const entry of badgeGhosts) {
      entry.anim?.cancel();
      entry.ghost.remove();
    }
    badgeGhosts = [];
  }

  function snapshotMediaBadges(mediaBox) {
    if (!mediaBox || reduced.matches) return [];
    const badges = mediaBox.querySelectorAll(':scope > .gallery-tile__index, :scope > .stack-card__play');
    const snaps = [];
    for (const badge of badges) {
      const cs = getComputedStyle(badge);
      const rect = badge.getBoundingClientRect();
      const opacity = parseFloat(cs.opacity);
      badgeReturnAnimations.get(badge)?.cancel();
      badgeReturnAnimations.delete(badge);
      if (!rect.width || !rect.height || opacity <= 0.01) continue;
      snaps.push({ badge, rect, opacity });
    }
    return snaps;
  }

  function playBadgeOpenTransition(snaps) {
    clearBadgeGhosts();
    if (!snaps.length || reduced.matches) return;
    for (const { badge, rect, opacity } of snaps) {
      const ghost = badge.cloneNode(true);
      ghost.classList.add('lightbox__badge-ghost');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.style.left = rect.left + 'px';
      ghost.style.top = rect.top + 'px';
      ghost.style.width = rect.width + 'px';
      ghost.style.height = rect.height + 'px';
      dialog.append(ghost);
      const anim = animate(ghost, [
        { opacity },
        { opacity: 0 },
      ], 160, { fill: 'forwards' });
      const entry = { ghost, anim };
      badgeGhosts.push(entry);
      if (anim) {
        anim.finished.then(() => {
          ghost.remove();
          badgeGhosts = badgeGhosts.filter(item => item !== entry);
        }).catch(() => {});
      } else {
        ghost.remove();
        badgeGhosts = badgeGhosts.filter(item => item !== entry);
      }
    }
  }

  function setZoomActiveMediaBox(mediaBox) {
    if (activeZoomMediaBox && activeZoomMediaBox !== mediaBox) {
      delete activeZoomMediaBox.dataset.zoomActive;
    }
    activeZoomMediaBox = mediaBox || null;
    if (activeZoomMediaBox) {
      activeZoomMediaBox.dataset.zoomActive = 'true';
    }
  }

  function releaseZoomActiveMediaBox(animateReturn = false) {
    const box = activeZoomMediaBox;
    activeZoomMediaBox = null;
    if (!box) return;
    delete box.dataset.zoomActive;
    if (!animateReturn || reduced.matches) return;
    const badges = box.querySelectorAll(':scope > .gallery-tile__index, :scope > .stack-card__play');
    for (const badge of badges) {
      badgeReturnAnimations.get(badge)?.cancel();
      const anim = animate(badge, [
        { opacity: 0 },
        { opacity: 1 },
      ], 200);
      if (anim) {
        badgeReturnAnimations.set(badge, anim);
        anim.finished.then(() => {
          if (badgeReturnAnimations.get(badge) === anim) badgeReturnAnimations.delete(badge);
        }).catch(() => {});
      }
    }
  }

  function restoreViewerImage() {
    if (!borrowedImage) return;
    const { image, frame } = borrowedImage;
    image.alt = '';
    frame.prepend(image);
    borrowedImage = null;
  }

  function getMediaBoxForCurrent() {
    if (!viewing) return null;
    const item = viewing.items[viewing.index];
    if (viewingOpenedFromHero && item.id === heroItemId && heroMediaBox?.isConnected) {
      return heroMediaBox;
    }
    const card = viewing.cards.get(item.id);
    return card?.querySelector('.stack-card__media, .gallery-tile__media, .film-frame__media') || null;
  }

  function extractCardTransform(mediaBox) {
    const card = mediaBox.closest('.stack-card, .gallery-tile, .film-frame');
    let angle = 0;
    let scaleX = 1;
    let scaleY = 1;
    if (card) {
      const tr = getComputedStyle(card).transform;
      if (tr && tr !== 'none') {
        const m = new DOMMatrixReadOnly(tr);
        angle = Math.atan2(m.b, m.a);
        scaleX = Math.hypot(m.a, m.b) || 1;
        scaleY = Math.hypot(m.c, m.d) || 1;
      }
    }
    return { angle, scaleX, scaleY };
  }

  function snapshotMediaBox(mediaBox) {
    if (!mediaBox) return null;
    const rect = mediaBox.getBoundingClientRect();
    if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= window.innerHeight) {
      return null;
    }
    const { angle, scaleX, scaleY } = extractCardTransform(mediaBox);
    // 读取未旋转的真实布局尺寸（offsetWidth/Height），避免旋转后 getBoundingClientRect() 外接盒膨胀导致尺寸跳变
    const sw = (mediaBox.offsetWidth || rect.width) * scaleX;
    const sh = (mediaBox.offsetHeight || rect.height) * scaleY;
    const boxRadius = parseFloat(getComputedStyle(mediaBox).borderRadius) || 1;
    const img = mediaBox.querySelector('img');
    const rawInner = (!reduced.matches && img) ? getComputedStyle(img).transform : 'none';
    return {
      cx: rect.left + rect.width / 2,
      cy: rect.top + rect.height / 2,
      sw,
      sh,
      angle,
      boxRadius,
      rawInner,
    };
  }

  function computeZoomFromSnapshot(snap) {
    if (!snap) return null;
    const targetRect = zoomMedia.getBoundingClientRect();
    const tw = targetRect.width;
    const th = targetRect.height;
    if (!tw || !th) return null;

    // 旋转矩形的外接盒中心与原矩形中心严格一致
    const dx = snap.cx - (targetRect.left + tw / 2);
    const dy = snap.cy - (targetRect.top + th / 2);

    // 等比 cover 缩放 + clip-path 裁切，保留原始宽高比并精确对齐旋转卡片的四角与角度
    const coverScale = Math.max(snap.sw / tw, snap.sh / th);
    const insetX = Math.max(0, (tw - snap.sw / coverScale) / 2);
    const insetY = Math.max(0, (th - snap.sh / coverScale) / 2);
    const scaledRadius = snap.boxRadius / Math.max(.01, coverScale);
    const needsClip = insetX > .5 || insetY > .5;

    return {
      angle: snap.angle,
      coverScale,
      needsClip,
      transform: `translate3d(${dx.toFixed(2)}px,${dy.toFixed(2)}px,0) rotate(${snap.angle.toFixed(6)}rad) scale(${coverScale.toFixed(5)})`,
      clipPath: `inset(${insetY.toFixed(2)}px ${insetX.toFixed(2)}px ${insetY.toFixed(2)}px ${insetX.toFixed(2)}px round ${scaledRadius.toFixed(2)}px)`,
    };
  }

  function isIdentityTransform(tr) {
    return !tr || tr === 'none' || tr === 'matrix(1, 0, 0, 1, 0, 0)';
  }

  function scaleInnerTransform(rawTransform, coverScale) {
    if (isIdentityTransform(rawTransform)) return 'none';
    const m = new DOMMatrixReadOnly(rawTransform);
    const sx = Math.hypot(m.a, m.b) || 1;
    const sy = Math.hypot(m.c, m.d) || 1;
    // 内层位移在 zoomMedia 缩放坐标系内，需除以 coverScale 以与卡片屏幕像素严格对齐
    const tx = m.e / Math.max(.01, coverScale);
    const ty = m.f / Math.max(.01, coverScale);
    if (Math.abs(sx - 1) < .001 && Math.abs(sy - 1) < .001 && Math.abs(tx) < .1 && Math.abs(ty) < .1) {
      return 'none';
    }
    return `translate3d(${tx.toFixed(2)}px,${ty.toFixed(2)}px,0) scale(${sx.toFixed(5)},${sy.toFixed(5)})`;
  }

  function restingInnerTransform(mediaBox, coverScale = 1) {
    if (reduced.matches || !mediaBox || activeStyle !== 'journal') return 'none';
    const stackNode = mediaBox.closest('.photo-stack');
    const py = stackNode ? (parseFloat(getComputedStyle(stackNode).getPropertyValue('--parallax-image')) || 0) : 0;
    const scaledPy = py / Math.max(.01, coverScale);
    return `translate3d(0px,${scaledPy.toFixed(2)}px,0) scale(1.14)`;
  }

  function drawViewer(sourceMediaBox) {
    const item = viewing.items[viewing.index];
    const sourceBox = sourceMediaBox || getMediaBoxForCurrent();
    const source = sourceBox?.querySelector('img,video');
    let media = source;
    if (source?.tagName === 'IMG' && !source.hidden && source.complete && source.naturalWidth) {
      borrowedImage = { image: source, frame: source.parentElement };
      source.alt = item.title;
    } else {
      media = createMedia(item, true, false);
    }
    const updateRatio = () => zoomMedia.style.setProperty('--zoom-ratio', Math.min(3.2, Math.max(.33, ratioFrom(media, ratioFrom(source, 4 / 3)))));
    if (!borrowedImage) {
      media.addEventListener(item.kind === 'video' ? 'loadedmetadata' : 'load', updateRatio, { once: true });
    }
    zoomMedia.replaceChildren();
    updateRatio();
    if (borrowedImage) zoomMedia.append(media);
    else attachMedia(zoomMedia, media);

    dialog.querySelector('h2').textContent = item.title;
    const caption = dialog.querySelector('.lightbox__text p');
    caption.textContent = item.caption || '';
    caption.hidden = !item.caption;
    dialog.querySelector('.lightbox__count').textContent = (viewing.index + 1) + ' / ' + viewing.items.length;
    dialog.querySelector('.lightbox__controls').hidden = viewing.items.length < 2;
    if (downloadBtn) {
      if (settings.allowDownload && item.src) {
        downloadBtn.href = item.src + (item.src.includes('?') ? '&' : '?') + 'dl=1';
        downloadBtn.setAttribute('download', item.fileName || item.title || '');
        downloadBtn.hidden = false;
      } else {
        downloadBtn.hidden = true;
        downloadBtn.removeAttribute('href');
      }
    }
  }

  function openViewer(stack, itemIndex = stack.index, clickedMediaBox = null, fromHero = false) {
    if (dialog.open) return;
    viewing = stack;
    viewing.index = wrappedIndex(itemIndex, viewing.items.length);
    viewingOpenedFromHero = Boolean(fromHero);

    const sourceMediaBox = clickedMediaBox || getMediaBoxForCurrent();
    // 在弹窗盖住卡片（触发 :hover 退出）与锁滚动之前先采样源卡片几何、内层变换与角标位置
    const sourceSnap = snapshotMediaBox(sourceMediaBox);
    const badgeSnaps = snapshotMediaBadges(sourceMediaBox);
    setZoomActiveMediaBox(sourceMediaBox);

    drawViewer(sourceMediaBox);
    lockPageScroll();
    dialog.dataset.animating = 'true';
    dialog.showModal();
    playBadgeOpenTransition(badgeSnaps);

    const origin = computeZoomFromSnapshot(sourceSnap);
    const openRadius = activeStyle === 'filmstrip' ? '2px' : '6px';
    const openTransform = 'translate3d(0px,0px,0) rotate(0rad) scale(1)';
    const openClip = `inset(0px 0px 0px 0px round ${openRadius})`;

    zoomAnimation = animate(zoomMedia, origin ? (origin.needsClip ? [
      { transform: origin.transform, clipPath: origin.clipPath, opacity: 1 },
      { transform: openTransform, clipPath: openClip, opacity: 1 },
    ] : [
      { transform: origin.transform, opacity: 1 },
      { transform: openTransform, opacity: 1 },
    ]) : [
      { transform: 'translate3d(0px,0px,0) scale(.91)', opacity: 0 },
      { transform: 'translate3d(0px,0px,0) scale(1)', opacity: 1 },
    ], 420);

    const openAnim = zoomAnimation;
    if (openAnim) {
      openAnim.finished.then(() => {
        if (zoomAnimation === openAnim && !closing) delete dialog.dataset.animating;
      }).catch(() => {});
    } else {
      delete dialog.dataset.animating;
    }

    const startInner = (origin && borrowedImage) ? scaleInnerTransform(sourceSnap.rawInner, origin.coverScale) : 'none';
    if (startInner !== 'none') {
      innerZoomAnimation = animate(borrowedImage.image, [
        { transform: startInner },
        { transform: 'translate3d(0px,0px,0) scale(1)' },
      ], 420);
    }

    requestAnimationFrame(() => { if (dialog.open && !closing) dialog.dataset.open = 'true'; });
  }

  function stepViewer(direction) {
    if (!viewing || viewing.items.length < 2 || closing) return;
    zoomAnimation?.cancel();
    innerZoomAnimation?.cancel();
    clearBadgeGhosts();
    delete dialog.dataset.animating;
    restoreViewerImage();
    viewingOpenedFromHero = false;
    viewing.index = wrappedIndex(viewing.index + direction, viewing.items.length);
    if (activeStyle === 'journal') renderJournalStack(viewing);
    setZoomActiveMediaBox(getMediaBoxForCurrent());
    drawViewer();
    zoomAnimation = animate(zoomMedia, [
      { opacity: 0, transform: 'translate3d(' + (direction * 26) + 'px,0px,0) scale(.98)' },
      { opacity: 1, transform: 'translate3d(0px,0px,0) scale(1)' },
    ], 245);
  }

  async function closeViewer() {
    if (!viewing || closing) return;
    closing = true;
    clearBadgeGhosts();

    const openRadius = activeStyle === 'filmstrip' ? '2px' : '6px';
    const csMedia = getComputedStyle(zoomMedia);
    const startTransform = isIdentityTransform(csMedia.transform)
      ? 'translate3d(0px,0px,0) rotate(0rad) scale(1)'
      : csMedia.transform;
    const hadActiveClip = Boolean(csMedia.clipPath && csMedia.clipPath !== 'none');
    const startClip = hadActiveClip
      ? csMedia.clipPath
      : `inset(0px 0px 0px 0px round ${openRadius})`;
    const rawCurrentInner = borrowedImage ? getComputedStyle(borrowedImage.image).transform : 'none';
    const startInnerTransform = borrowedImage
      ? (isIdentityTransform(rawCurrentInner) ? 'translate3d(0px,0px,0) scale(1)' : rawCurrentInner)
      : 'none';

    zoomAnimation?.cancel();
    innerZoomAnimation?.cancel();

    const destMediaBox = getMediaBoxForCurrent();
    setZoomActiveMediaBox(destMediaBox);
    const card = destMediaBox?.closest('button') || viewing.cards.get(viewing.items[viewing.index].id);
    const destination = computeZoomFromSnapshot(snapshotMediaBox(destMediaBox));
    const video = zoomMedia.querySelector('video');
    if (video) video.pause();

    dialog.dataset.animating = 'true';
    delete dialog.dataset.open;

    const useClip = Boolean(destination && (destination.needsClip || hadActiveClip));
    const exit = animate(zoomMedia, destination ? (useClip ? [
      { transform: startTransform, clipPath: startClip, opacity: 1 },
      { transform: destination.transform, clipPath: destination.clipPath, opacity: 1 },
    ] : [
      { transform: startTransform, opacity: 1 },
      { transform: destination.transform, opacity: 1 },
    ]) : [
      { transform: startTransform, opacity: 1 },
      { transform: 'translate3d(0px,0px,0) scale(.92)', opacity: 0 },
    ], 310, { fill: 'forwards' });

    let innerExit = null;
    if (destination && borrowedImage) {
      const targetInner = restingInnerTransform(destMediaBox, destination.coverScale);
      if (targetInner !== 'none' || !isIdentityTransform(rawCurrentInner)) {
        innerExit = animate(borrowedImage.image, [
          { transform: startInnerTransform },
          { transform: targetInner === 'none' ? 'translate3d(0px,0px,0) scale(1)' : targetInner },
        ], 310, { fill: 'forwards' });
      }
    }

    if (exit) await exit.finished.catch(() => {});
    // 同一同步帧内还回图片并关闭灯箱，避免卡片空框闪烁与角度回弹抽搐
    innerExit?.cancel();
    restoreViewerImage();
    dialog.close();
    delete dialog.dataset.animating;
    exit?.cancel();
    zoomMedia.replaceChildren();
    unlockPageScroll();
    releaseZoomActiveMediaBox(Boolean(destination));
    viewing = null;
    viewingOpenedFromHero = false;
    closing = false;
    card?.focus({ preventScroll: true });
  }

  dialog.querySelector('[data-close]').addEventListener('click', closeViewer);
  dialog.querySelectorAll('[data-step]').forEach(button => {
    button.addEventListener('click', () => stepViewer(Number(button.dataset.step)));
  });
  dialog.addEventListener('click', event => {
    if (event.target === dialog || event.target === stage) void closeViewer();
  });
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    void closeViewer();
  });
  dialog.addEventListener('keydown', event => {
    if (event.target.tagName === 'VIDEO' || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    stepViewer(event.key === 'ArrowLeft' ? -1 : 1);
  });

  async function loadWorks() {
    if (loading) return;
    loading = true;
    more.disabled = true;
    status.textContent = '正在加载作品…';
    try {
      let isDisabled = false;
      for (let page = 0; page < 4; page += 1) {
        let data;
        const startup = cursor === null ? window.showStartup : null;
        if (startup) {
          delete window.showStartup;
          const initial = await startup;
          if (!initial) throw new Error();
          data = initial.page;
          startupCover = initial.coverImage;
        } else {
          const response = await fetch('/api/show' + (cursor ? '?before=' + cursor : ''), { cache: 'no-store' });
          if (!response.ok) throw new Error();
          data = await response.json();
        }
        if (cursor === null && data.settings) {
          applySettings(data.settings);
        }
        if (data.disabled) {
          isDisabled = true;
          cursor = null;
          break;
        }
        cursor = data.next;
        appendItems(data.items || []);
        if ((data.items && data.items.length) || !cursor) break;
      }
      if (isDisabled) {
        coverSection.hidden = true;
        filterBar.hidden = true;
        journal.hidden = true;
        status.textContent = 'Show 展示页当前未对外开放。';
        more.hidden = true;
      } else {
        coverSection.hidden = false;
        status.textContent = !stacks.size && !cursor ? '还没有发布的作品。' : '';
        more.textContent = '查看更多';
        more.hidden = !cursor;
      }
    } catch {
      status.textContent = '作品暂时加载失败。';
      more.textContent = '重试';
      more.hidden = false;
    } finally {
      more.disabled = false;
      loading = false;
    }
  }

  document.getElementById('share-page').addEventListener('click', async () => {
    const info = document.getElementById('share-status');
    const url = new URL('/show', location.href).href;
    if (navigator.share) {
      try {
        await navigator.share({ title: document.title, url });
        return;
      } catch (error) {
        if (error.name === 'AbortError') return;
      }
    }
    info.textContent = await KVault.copy(url) ? '链接已复制' : '可从地址栏复制链接';
  });

  more.addEventListener('click', loadWorks);
  void loadWorks();
})();
