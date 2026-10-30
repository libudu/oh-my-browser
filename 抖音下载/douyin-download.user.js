// ==UserScript==
// @name         抖音喜欢与TA的作品 · 视频与图集下载
// @namespace    oh-my-browser/douyin-download
// @version      1.2.3
// @description  在喜欢列表、TA的作品卡片左上角显示下载按钮，下载当前页面数据提供的视频或图集静态图片。
// @match        https://www.douyin.com/*
// @match        https://douyin.com/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      douyin.com
// @connect      douyinvod.com
// @connect      douyinpic.com
// @connect      byteimg.com
// @connect      ibyteimg.com
// @connect      pstatp.com
// @connect      bytecdn.cn
// @connect      bytedance.com
// @connect      snssdk.com
// @connect      amemv.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';
  const BUTTON = 'omb-douyin-download';
  const HOST = 'omb-douyin-card';
  const LINKS = 'a[href*="/video/"], a[href*="/note/"], a[href*="modal_id="]';
  const saved = new Map();
  let downloading = false;

  // 每个作品单独存储，避免不同标签页同时下载时覆盖整份记录。
  function isDownloaded(id) {
    return typeof GM_getValue === 'function' && GM_getValue(`downloaded:v1:${id}`, false) === true;
  }
  function syncDownloadMark(button, id, reset = false) {
    const marked = isDownloaded(id);
    const changed = button.dataset.downloadId !== id || button.dataset.downloaded !== String(marked);
    button.dataset.downloadId = id;
    button.dataset.downloaded = String(marked);
    if ((reset || changed) && button.dataset.busy !== 'true') {
      button.textContent = marked ? '✓ 已下载' : '↓ 下载';
    }
  }
  function markDownloaded(id) {
    try { GM_setValue(`downloaded:v1:${id}`, true); }
    catch { throw new Error('文件已保存，但下载标记未能持久保存，请检查油猴存储权限'); }
    for (const button of document.querySelectorAll?.(`.${BUTTON}`) || []) {
      if (button.dataset?.downloadId === id) syncDownloadMark(button, id);
    }
  }


  // 作品 ID 必须保持字符串，19 位整数不能转成 Number。
  function workId(work) { return String(work?.aweme_id || work?.awemeId || ''); }
  function mediaUrl(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    try {
      const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
        !/(^|\.)(douyin\.com|douyinvod\.com|douyinpic\.com|byteimg\.com|ibyteimg\.com|pstatp\.com|bytecdn\.cn|bytedance\.com|snssdk\.com|amemv\.com)$/i.test(url.hostname) ||
        /\.(m3u8|mpd)(?:$|\/)/i.test(url.pathname)) return null;
      // 保留完整签名与处理后缀，不改写 playwm 或拼接所谓原图地址。
      return url.href;
    } catch { return null; }
  }
  function urls(address) {
    const list = typeof address === 'string' ? [address] : Array.isArray(address) ? address :
      address?.url_list || address?.urlList || (address?.src ? [address.src] : []);
    return [...new Set((Array.isArray(list) ? list : [])
      .map(item => mediaUrl(typeof item === 'string' ? item : item?.src || item?.url)).filter(Boolean))];
  }
  function selectMedia(work) {
    const images = work.images || work.imagePostInfo?.images || work.image_post_info?.images;
    const type = Number(work.aweme_type ?? work.awemeType);
    if (Array.isArray(images) && images.length) {
      return { kind: 'image', media: images.map((image, index) => {
        const candidates = [image.display_image, image.displayImage, image, image.download_url_list];
        const addresses = [...new Set(candidates.flatMap(urls))];
        if (!addresses.length) throw new Error(`第 ${index + 1} 张缺少图片地址，请打开作品后重试`);
        // 实况与小红书脚本一致：只保存静态图片，不读取 image.video。
        return { index, urls: addresses };
      }) };
    }
    if ([68, 150].includes(type)) throw new Error('图集数据尚未加载，请打开作品后返回重试');
    const video = work.video;
    const rates = video?.bit_rate || video?.bitRate || video?.bitRateList || [];
    const candidates = (Array.isArray(rates) ? rates : []).map(rate => ({
      address: rate.play_addr || rate.playAddr,
      width: rate.play_addr?.width || rate.playAddr?.width || rate.width || 0,
      height: rate.play_addr?.height || rate.playAddr?.height || rate.height || 0,
      bitrate: Number(rate.bit_rate || rate.bitRate || rate.bitrate) || 0,
    }));
    const primary = video?.play_addr || video?.playAddr;
    candidates.push({ address: primary, width: primary?.width || video?.width || 0,
      height: primary?.height || video?.height || 0, bitrate: 0 });
    const valid = candidates.map(item => ({ ...item, urls: urls(item.address) }))
      .filter(item => item.urls.length)
      .sort((a, b) => (b.width * b.height - a.width * a.height) || b.bitrate - a.bitrate);
    if (!valid.length) throw new Error('没有可下载的视频地址，请先打开这条作品再返回重试');
    return { kind: 'video', media: [{ index: 0, urls: [...new Set(valid.flatMap(item => item.urls))] }] };
  }

  // 有界遍历页面已有数据，只读取自有数据属性；不执行 getter 或页面脚本。
  function findWork(root, id, maxDepth = 10) {
    const seen = new WeakSet();
    const queue = [[root, 0]];
    let fallback = null;
    for (let cursor = 0; cursor < queue.length && cursor < 18000; cursor++) {
      const [value, depth] = queue[cursor];
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      if (workId(value) === id) {
        fallback = value;
        try { selectMedia(value); return value; } catch { /* 继续寻找完整记录。 */ }
      }
      if (depth >= maxDepth) continue;
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (['return', 'child', 'sibling', 'alternate', 'stateNode', '_owner'].includes(key)) continue;
        const next = descriptor.value;
        if (next && typeof next === 'object' && queue.length < 18000) queue.push([next, depth + 1]);
      }
    }
    return fallback;
  }
  function jsonState(text) {
    const raw = text.trim();
    for (const candidate of [raw, (() => { try { return decodeURIComponent(raw); } catch { return ''; } })()]) {
      try { return JSON.parse(candidate); } catch { /* 非 JSON 不执行。 */ }
    }
    // 仅提取 _ROUTER_DATA 等赋值中的平衡 JSON 对象，拒绝函数和表达式。
    const match = /(?:window\.)?_(?:ROUTER_DATA|SSR_DATA)\s*=\s*(\{)/.exec(raw);
    if (!match) return null;
    const start = match.index + match[0].length - 1;
    let depth = 0, inString = false, escape = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try { return JSON.parse(raw.slice(start, i + 1)); } catch { return null; }
      }
    }
    return null;
  }
  function workFromDocument(doc, id) {
    let fallback = null;
    for (const script of doc.querySelectorAll('script')) {
      if (!['RENDER_DATA', '__NEXT_DATA__', '__UNIVERSAL_DATA_FOR_REHYDRATION__'].includes(script.id) &&
        script.type !== 'application/json' && !/_(ROUTER_DATA|SSR_DATA)\s*=/.test(script.textContent || '')) continue;
      const work = findWork(jsonState(script.textContent || ''), id);
      if (work) {
        fallback = work;
        try { selectMedia(work); return work; } catch { /* 下一个状态。 */ }
      }
    }
    return fallback;
  }
  function cardInfo(card) {
    const links = card.matches?.('a[href]') ? [card] : [...card.querySelectorAll(LINKS)];
    for (const link of links) {
      try {
        const url = new URL(link.getAttribute('href'), 'https://www.douyin.com');
        if (!/(^|\.)douyin\.com$/i.test(url.hostname)) continue;
        const match = url.pathname.match(/^\/(video|note)\/(\d+)\/?$/);
        const id = match?.[2] || url.searchParams.get('modal_id');
        if (id && /^\d{10,25}$/.test(id)) return { id, url: `https://www.douyin.com/${match?.[1] || 'video'}/${id}` };
      } catch { /* 下一个链接。 */ }
    }
    for (const attr of ['data-aweme-id', 'data-item-id']) {
      const id = card.getAttribute(attr);
      if (id && /^\d{10,25}$/.test(id)) return { id, url: `https://www.douyin.com/video/${id}` };
    }
    // “TA的作品”的侧栏卡片可能只有 React 点击事件，没有 href 或 data ID。
    const work = singleReactWork(card);
    if (work) {
      const id = workId(work);
      return { id, url: `https://www.douyin.com/video/${id}` };
    }
    throw new Error('没有找到作品 ID，请刷新页面重试');
  }
  function reactRoots(node) {
    const roots = [];
    for (const key of Object.getOwnPropertyNames(node)) {
      if (!/^__react(?:Props|Fiber|InternalInstance)\$/.test(key)) continue;
      const react = Object.getOwnPropertyDescriptor(node, key)?.value;
      if (key.startsWith('__reactProps')) roots.push(react);
      else roots.push(react?.memoizedProps, react?.pendingProps);
    }
    return roots;
  }
  function singleReactWork(node) {
    const queue = reactRoots(node).map(root => [root, 0]);
    const seen = new WeakSet(), works = new Map();
    // 只检查这个 DOM 节点自身的 props。不能沿 Fiber.return 读到整个作者列表。
    for (let cursor = 0; cursor < queue.length && cursor < 1500; cursor++) {
      const [value, depth] = queue[cursor];
      if (!value || typeof value !== 'object' || seen.has(value)) continue;
      seen.add(value);
      const id = workId(value);
      if (/^\d{10,25}$/.test(id)) {
        works.set(id, value);
        if (works.size > 1) return null;
        continue;
      }
      if (depth >= 7) continue;
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (['return', 'child', 'sibling', 'alternate', 'stateNode', '_owner', 'ref'].includes(key)) continue;
        if (descriptor.value && typeof descriptor.value === 'object') {
          // 遍历被截断时不能断言列表中只有一条作品。
          if (queue.length >= 1500) return null;
          queue.push([descriptor.value, depth + 1]);
        }
      }
    }
    return works.size === 1 ? works.values().next().value : null;
  }
  function isAvatarMedia(media) {
    // 作者入口也可能携带当前作品的 props，不能仅凭 awemeId 认作作品卡片。
    let node = media;
    for (let depth = 0; node && depth < 7; depth++, node = node.parentElement) {
      const label = ['class', 'data-e2e', 'aria-label', 'alt'].map(attr => node.getAttribute?.(attr) || '').join(' ');
      if (/avatar|头像/i.test(label)) return true;
      if (node.tagName === 'A') {
        try {
          const url = new URL(node.getAttribute('href'), 'https://www.douyin.com');
          if (/^\/user(?:\/|$)/.test(url.pathname) && !url.searchParams.has('modal_id')) return true;
        } catch { /* 非链接。 */ }
      }
    }
    return false;
  }
  function isWorkCover(media, work) {
    const video = work.video || {};
    const images = work.images || work.imagePostInfo?.images || work.image_post_info?.images || [];
    const covers = [video.cover, video.origin_cover, video.originCover, video.dynamic_cover,
      video.dynamicCover, work.cover, work.coverUrl,
      ...(Array.isArray(images) ? images.flatMap(image => [image, image.display_image, image.displayImage]) : [])]
      .flatMap(urls);
    // 只为真实作品封面添加 React 兜底按钮，不把播放器头像/控制区当成卡片。
    const path = raw => {
      const valid = mediaUrl(raw);
      return valid ? new URL(valid).pathname.split('~')[0] : null;
    };
    const source = media.tagName === 'VIDEO' ? media.poster || media.getAttribute?.('poster') :
      media.currentSrc || media.src || media.getAttribute?.('src');
    const mediaPath = path(source);
    return Boolean(mediaPath && covers.some(url => path(url) === mediaPath));
  }
  function collectReactCards(cards) {
    const hoverCards = new Set();
    let pageDoc = document;
    try { pageDoc = unsafeWindow.document || document; } catch { /* 脚本管理器隔离回退。 */ }
    for (const media of pageDoc.querySelectorAll('img, video')) {
      if (isAvatarMedia(media)) continue;
      // 已有普通列表卡片时不向其内部重复加按钮。
      let ancestor = media.parentElement, covered = false;
      for (let depth = 0; ancestor && depth < 7; depth++, ancestor = ancestor.parentElement) {
        if (cards.has(ancestor)) { covered = true; break; }
      }
      if (covered) continue;
      let node = media.parentElement;
      for (let depth = 0; node && node !== pageDoc.body && depth < 6; depth++, node = node.parentElement) {
        if (['A', 'BUTTON'].includes(node.tagName)) continue;
        const work = singleReactWork(node);
        if (!work || !isWorkCover(media, work)) continue;
        cards.add(node);
        hoverCards.add(node);
        break;
      }
    }
    return hoverCards;
  }
  function workFromCard(card, id) {
    // 油猴隔离环境中的 DOM 包装不一定能看见 React 属性，优先用页面侧 DOM。
    let pageCard = card;
    try { pageCard = unsafeWindow.document.querySelector(`[data-omb-douyin-id="${id}"]`) || card; } catch { /* 降级。 */ }
    const nodes = [pageCard, ...pageCard.querySelectorAll('a, img')].slice(0, 20);
    for (const start of nodes) {
      let node = start;
      for (let level = 0; node && level < 4; level++, node = node.parentElement) {
        for (const key of Object.getOwnPropertyNames(node)) {
          if (!/^__react(?:Props|Fiber|InternalInstance)\$/.test(key)) continue;
          const react = node[key];
          const work = findWork(key.startsWith('__reactProps') ? react :
            [react?.memoizedProps, react?.pendingProps, react?.memoizedState], id);
          if (work) { try { selectMedia(work); return work; } catch { /* 下一个节点。 */ } }
        }
      }
    }
    return null;
  }
  async function loadWork(card, info) {
    let work = workFromCard(card, info.id);
    if (work) return work;
    for (const name of ['RENDER_DATA', '_ROUTER_DATA', '_SSR_DATA', '__INITIAL_STATE__']) {
      try {
        const state = unsafeWindow[name];
        work = findWork(typeof state === 'string' ? jsonState(state) : state, info.id);
        if (work) { selectMedia(work); return work; }
      } catch { /* 当前页面没有该状态。 */ }
    }
    work = workFromDocument(document, info.id);
    if (work) { try { selectMedia(work); return work; } catch { /* 请求详情。 */ } }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(info.url, { credentials: 'include', signal: controller.signal });
      if (!response.ok) throw new Error(`读取详情失败（HTTP ${response.status}）`);
      work = workFromDocument(new DOMParser().parseFromString(await response.text(), 'text/html'), info.id);
      if (!work) throw new Error('未取得作品数据，请在已登录页面打开这条作品，返回列表后重试；若仍失败，请刷新页面');
      return work;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('读取作品详情超时，请重试');
      throw error;
    } finally { clearTimeout(timer); }
  }

  function detectMedia(bytes, kind) {
    const ascii = (start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
    const starts = (...values) => values.every((value, i) => bytes[i] === value);
    if (kind === 'image') {
      if (starts(255, 216, 255)) return { ext: 'jpg', mime: 'image/jpeg' };
      if (starts(137, 80, 78, 71, 13, 10, 26, 10)) return { ext: 'png', mime: 'image/png' };
      if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
      if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return { ext: 'gif', mime: 'image/gif' };
    }
    if (bytes.length < 16 || ascii(4, 4) !== 'ftyp') return null;
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (size < 16 || size > bytes.length || size > 4096) return null;
    const brands = [ascii(8, 4)];
    for (let i = 16; i + 4 <= size; i += 4) brands.push(ascii(i, 4));
    if (brands.some(b => ['avif', 'avis', 'heic', 'heix', 'mif1', 'msf1'].includes(b))) {
      if (kind !== 'image') return null;
      if (brands.includes('avif') && !brands.includes('avis')) return { ext: 'avif', mime: 'image/avif' };
      if (brands.some(b => ['heic', 'heix'].includes(b))) return { ext: 'heic', mime: 'image/heic' };
      return null;
    }
    return kind === 'video' && brands.some(b => /^(isom|iso[2-9]|mp4[12]|avc1|dash|M4V )$/.test(b))
      ? { ext: 'mp4', mime: 'video/mp4' } : null;
  }
  function requestMedia(url, kind) {
    if (!mediaUrl(url)) return Promise.reject(new Error('不支持的媒体地址'));
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({ method: 'GET', url, responseType: 'arraybuffer',
        timeout: kind === 'video' ? 180000 : 45000,
        headers: { Referer: 'https://www.douyin.com/' },
        onload(response) {
          try {
            if (response.status < 200 || response.status >= 300) throw new Error(`媒体请求失败（HTTP ${response.status}）`);
            if (response.finalUrl && !mediaUrl(response.finalUrl)) throw new Error('媒体跳转到不支持的域名');
            const bytes = new Uint8Array(response.response);
            const format = detectMedia(bytes, kind);
            if (!format) throw new Error(`响应不是有效${kind === 'video' ? ' MP4 视频' : '图片'}（可能是验证页或不支持的格式）`);
            resolve({ blob: new Blob([bytes], { type: format.mime }), ext: format.ext });
          } catch (error) { reject(error); }
        },
        onerror: () => reject(new Error('媒体请求失败，请检查网络和油猴的站点访问权限')),
        ontimeout: () => reject(new Error('媒体下载超时，请重试')),
      });
    });
  }
  async function requestWithFallback(addresses, kind) {
    let last;
    for (const url of addresses) {
      try { return await requestMedia(url, kind); } catch (error) { last = error; }
    }
    throw last || new Error('没有可用的媒体地址');
  }

  function saveBlob(blob, name) {
    return new Promise((resolve, reject) => {
      const objectUrl = URL.createObjectURL(blob);
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        URL.revokeObjectURL(objectUrl);
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(new Error('保存超时，请检查油猴下载权限')), 65000);
      try {
        GM_download({
          url: objectUrl, name, saveAs: false, conflictAction: 'uniquify', timeout: 60000,
          onload: () => finish(),
          ontimeout: () => finish(new Error('保存超时')),
          onerror: (result) => {
            const messages = {
              not_enabled: '请在油猴设置中启用下载功能（下载模式选择“浏览器 API”）',
              not_permitted: '请授予油猴下载文件的权限',
              not_whitelisted: '请在油猴下载扩展名白名单中允许 jpg/png/webp/gif/avif/heic/mp4',
              not_supported: '当前浏览器不支持油猴下载功能',
            };
            finish(new Error(messages[result?.error] || '文件保存失败或已取消'));
          },
        });
      } catch (error) { finish(error); }
    });
  }

  function safeName(value) {
    return String(value || '').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/[.\s]+$/g, '').trim().slice(0, 60) || '抖音作品';
  }
  function notify(message, error = false) {
    let toast = document.getElementById('omb-douyin-toast');
    if (!toast) {
      toast = document.createElement('div'); toast.id = 'omb-douyin-toast';
      toast.setAttribute('role', 'status'); document.body.append(toast);
    }
    toast.textContent = message; toast.dataset.error = String(error);
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => toast.remove(), error ? 12000 : 5000);
  }
  async function downloadCard(card, button) {
    if (downloading) return notify('正在下载另一条作品，请稍候');
    downloading = true; button.disabled = true; button.dataset.busy = 'true'; button.textContent = '读取作品…';
    let count = 0, total = 0, id = card.dataset.ombDouyinId;
    const label = text => { if (card.dataset.ombDouyinId === id) button.textContent = text; };
    try {
      const info = cardInfo(card); id = info.id;
      const work = await loadWork(card, info);
      const { kind, media } = selectMedia(work); total = media.length;
      const key = `${id}:${kind}`;
      let done = saved.get(key) || new Set();
      if (done.size === total) done = new Set();
      saved.set(key, done);
      if (saved.size > 200) saved.delete(saved.keys().next().value);
      count = done.size;
      const prefix = `${safeName(work.author?.nickname)}_${safeName(work.desc || work.previewTitle)}_${id}`;
      const failures = [];
      for (const item of media) {
        if (done.has(item.index)) continue;
        label(kind === 'video' ? '下载视频…' : `下载 ${item.index + 1}/${total}`);
        try {
          const { blob, ext } = await requestWithFallback(item.urls, kind);
          await saveBlob(blob, `${prefix}_${String(item.index + 1).padStart(2, '0')}.${ext}`);
          done.add(item.index); count++;
          // 任一文件落盘即记录，不等待整篇完成；之后取消其他文件也保留标记。
          if (!isDownloaded(id)) markDownloaded(id);
          if (card.dataset.ombDouyinId === id) syncDownloadMark(button, id);
        } catch (error) {
          failures.push(`${item.index + 1}：${error.message}`);
          if (/油猴|权限|白名单/.test(error.message)) break;
        }
      }
      if (failures.length) throw new Error(failures.join('；'));
      label('✓ 已下载');
      notify(kind === 'video' ? '视频已保存' : `已保存 ${count} 张图片（实况仅保存静态图）`);
    } catch (error) {
      label(id && isDownloaded(id)
        ? (count > 0 && count < total ? `✓ 已下载 ${count}/${total}` : '✓ 已下载') : '重试下载');
      notify(`${total ? `已保存 ${count}/${total}。` : ''}${error.message}`, true);
      console.warn('[抖音下载]', error.message);
    } finally { downloading = false; button.disabled = false; delete button.dataset.busy; }
  }

  function attachButtons() {
    const cards = new Set();
    for (const link of document.querySelectorAll(LINKS)) {
      if (!link.querySelector('img, video') && !link.closest('li, [data-aweme-id], [data-item-id]')) continue;
      const card = link.closest('li, [data-aweme-id], [data-item-id]') || link.parentElement;
      if (card && card !== document.body) cards.add(card);
    }
    for (const card of document.querySelectorAll('[data-aweme-id], [data-item-id]')) cards.add(card);
    const reactCards = collectReactCards(cards);
    for (const card of cards) {
      // 同样排除带 data-aweme-id 等属性的头像容器。
      if (isAvatarMedia(card)) continue;
      const work = singleReactWork(card);
      if (![...card.querySelectorAll('img, video')].some(media =>
        !isAvatarMedia(media) && (!work || isWorkCover(media, work)))) continue;
      let info;
      try { info = cardInfo(card); } catch { continue; }
      // 不把包含多条作品的列表容器当成一张卡片。
      if ([...card.querySelectorAll(LINKS)].some(a => {
        try { return cardInfo(a).id !== info.id; } catch { return false; }
      })) continue;
      let button = [...card.children].find(node => node.classList.contains(BUTTON));
      // 喜欢列表保留常显；作者作品和弹层中的 React 卡片改为悬停显示。
      let likesPage = false, modalOpen = false;
      try {
        const params = new URL(location.href).searchParams;
        likesPage = params.get('showTab') === 'like';
        modalOpen = Boolean(params.get('modal_id'));
      } catch { /* 其他页面。 */ }
      const inDialog = card.closest?.('[role="dialog"], [aria-modal="true"], [data-e2e="feed-modal"]');
      card.dataset.ombDouyinHover = String(reactCards.has(card) || !likesPage || modalOpen || Boolean(inDialog));
      if (card.dataset.ombDouyinId !== info.id) {
        card.dataset.ombDouyinId = info.id;
        if (button) syncDownloadMark(button, info.id, true);
      }
      if (button) { syncDownloadMark(button, info.id); continue; }
      card.classList.add(HOST);
      if (getComputedStyle(card).position === 'static') card.classList.add('omb-douyin-relative');
      button = document.createElement('button'); button.type = 'button'; button.className = BUTTON;
      button.textContent = '↓ 下载'; button.title = '下载视频或整篇图集（实况仅静态图片）';
      syncDownloadMark(button, info.id, true);
      button.setAttribute('aria-label', button.title);
      for (const event of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'keydown', 'keyup']) {
        button.addEventListener(event, e => e.stopPropagation());
      }
      button.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation(); void downloadCard(card, button);
      });
      card.append(button);
    }
  }
  function start() {
    GM_addStyle(`
      .omb-douyin-relative { position: relative !important; }
      .${HOST} > .${BUTTON} {
        position: absolute; top: 9px; left: 9px; z-index: 50; display: block;
        padding: 7px 11px; border: 1px solid #ffffff99; border-radius: 18px;
        background: #161823dc; color: white; font: 500 12px/1.3 system-ui, sans-serif;
        cursor: pointer; box-shadow: 0 2px 8px #0004; pointer-events: auto;
      }
      .${HOST} > .${BUTTON}:hover { background: #fe2c55; }
      .${HOST} > .${BUTTON}:focus-visible { outline: 2px solid #fe2c55; outline-offset: 2px; }
      .${HOST} > .${BUTTON}:disabled { cursor: progress; opacity: .85; }
      .${HOST}[data-omb-douyin-hover="true"] > .${BUTTON} {
        opacity: 0; pointer-events: none; transition: opacity .15s;
      }
      .${HOST}[data-omb-douyin-hover="true"]:hover > .${BUTTON},
      .${HOST}[data-omb-douyin-hover="true"]:focus-within > .${BUTTON},
      .${HOST}[data-omb-douyin-hover="true"] > .${BUTTON}[data-busy="true"] {
        opacity: 1; pointer-events: auto;
      }
      .${HOST} > .${BUTTON}[data-downloaded="true"],
      .${HOST} > .${BUTTON}[data-downloaded="true"]:hover {
        background: #facc15; color: #422006; border-color: #fde68a;
        opacity: 1; pointer-events: auto;
      }
      @media (hover: none) {
        .${HOST}[data-omb-douyin-hover="true"] > .${BUTTON} { opacity: 1; pointer-events: auto; }
      }
      #omb-douyin-toast {
        position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%);
        z-index: 2147483647; max-width: min(640px, 88vw); padding: 13px 18px;
        border-radius: 12px; background: #222f; color: white; font: 14px/1.6 system-ui;
        white-space: pre-wrap; overflow-wrap: anywhere; box-shadow: 0 4px 24px #0003;
      }
      #omb-douyin-toast[data-error="true"] { background: #93213bf5; }
    `);
    attachButtons();
    window.addEventListener('focus', attachButtons);
    let timer;
    new MutationObserver(records => {
      if (!records.some(record => !record.target.closest?.(`.${BUTTON}, #omb-douyin-toast`) &&
        (record.type === 'attributes' || [...record.addedNodes, ...record.removedNodes].some(node =>
          node.nodeType === 1 && !node.matches?.(`.${BUTTON}, #omb-douyin-toast`))))) return;
      clearTimeout(timer); timer = setTimeout(attachButtons, 150);
    }).observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['href', 'src', 'srcset', 'poster', 'data-aweme-id', 'data-item-id'] });
  }

  if (typeof module !== 'undefined' && module.exports && typeof document === 'undefined') {
    module.exports = { workId, mediaUrl, urls, selectMedia, findWork, jsonState, workFromDocument,
      cardInfo, workFromCard, loadWork, detectMedia, requestMedia, requestWithFallback, safeName,
      saveBlob, downloadCard, reactRoots, singleReactWork, isAvatarMedia, isWorkCover, collectReactCards, attachButtons,
      isDownloaded, syncDownloadMark, markDownloaded, start };
  } else { start(); }
})();
