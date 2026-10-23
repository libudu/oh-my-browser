// ==UserScript==
// @name         小红书列表 · 图片与视频下载（实况仅图片）
// @namespace    oh-my-browser/xiaohongshu-images
// @version      1.1.0
// @description  悬停笔记卡片下载详情图片或纯视频笔记；实况仅保存静态图，不使用列表缩略图。
// @match        https://www.xiaohongshu.com/*
// @match        https://xiaohongshu.com/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        unsafeWindow
// @connect      xhscdn.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const CARD = 'section.note-item';
  const BUTTON = 'xhs-image-download-button';
  const savedMedia = new Map();
  let downloading = false;

  function unwrap(value) {
    return value?.__v_isRef ? value.value : value;
  }

  function noteFromState(state, id) {
    const map = unwrap(unwrap(state?.note)?.noteDetailMap);
    const entry = unwrap(typeof map?.get === 'function' ? map.get(id) : map?.[id]);
    const note = unwrap(entry?.note);
    return note && String(note.noteId || note.note_id || id) === id ? note : null;
  }

  // 仅解析 JSON 字面量、undefined 和 Map/Set 的字面量参数，不执行网页脚本。
  function readObjectLiteral(text, start) {
    if (text[start] !== '{') throw new Error('详情数据不是对象');
    let cursor = start;
    const fail = () => new SyntaxError(`详情数据包含不支持或不完整的表达式（位置 ${cursor}）`);
    const skipSpace = () => { while (/\s/.test(text[cursor] || '') && cursor < text.length) cursor++; };
    const expect = char => {
      skipSpace();
      if (text[cursor] !== char) throw fail();
      cursor++;
    };

    function readString() {
      const begin = cursor++;
      while (cursor < text.length) {
        const char = text[cursor++];
        if (char === '\\') cursor++;
        else if (char === '"') return JSON.parse(text.slice(begin, cursor));
      }
      throw fail();
    }

    function readValue(depth) {
      if (depth > 256) throw fail();
      skipSpace();
      const char = text[cursor];
      if (char === '"') return readString();
      if (char === '{') {
        cursor++;
        const object = {};
        skipSpace();
        if (text[cursor] === '}') { cursor++; return object; }
        while (cursor < text.length) {
          skipSpace();
          if (text[cursor] !== '"') throw fail();
          const key = readString();
          expect(':');
          // defineProperty 避免 __proto__ 被解释为原型赋值。
          Object.defineProperty(object, key, {
            value: readValue(depth + 1), enumerable: true, configurable: true, writable: true,
          });
          skipSpace();
          if (text[cursor] === '}') { cursor++; return object; }
          expect(',');
        }
        throw fail();
      }
      if (char === '[') {
        cursor++;
        const array = [];
        skipSpace();
        if (text[cursor] === ']') { cursor++; return array; }
        while (cursor < text.length) {
          array.push(readValue(depth + 1));
          skipSpace();
          if (text[cursor] === ']') { cursor++; return array; }
          expect(',');
        }
        throw fail();
      }
      const remaining = text.slice(cursor);
      const constructor = /^new\s+(Map|Set)\s*\(/.exec(remaining);
      if (constructor) {
        cursor += constructor[0].length;
        skipSpace();
        const entries = text[cursor] === ')' ? [] : readValue(depth + 1);
        expect(')');
        if (!Array.isArray(entries)) throw fail();
        if (constructor[1] === 'Set') return new Set(entries);
        if (!entries.every(entry => Array.isArray(entry) && entry.length === 2)) throw fail();
        return new Map(entries);
      }
      const literal = /^(true|false|null|undefined)(?![\w$])/.exec(remaining);
      if (literal) {
        cursor += literal[0].length;
        return { true: true, false: false, null: null, undefined: null }[literal[0]];
      }
      const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(remaining);
      if (number) { cursor += number[0].length; return Number(number[0]); }
      throw fail();
    }
    return readValue(0);
  }

  function noteFromDocument(doc, id) {
    for (const script of doc.scripts) {
      const text = script.textContent || '';
      if (!text.includes('__INITIAL_STATE__')) continue;
      const assignment = /(?:window\.)?__INITIAL_STATE__\s*=\s*/.exec(text);
      if (!assignment) continue;
      const state = readObjectLiteral(text, assignment.index + assignment[0].length);
      const note = noteFromState(state, id);
      if (note) return note;
    }
    return null;
  }

  function imageUrl(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    let url;
    try { url = new URL(raw, 'https://www.xiaohongshu.com'); }
    catch { return null; }
    if (!['http:', 'https:'].includes(url.protocol) ||
      !/(^|\.)xhscdn\.com$/i.test(url.hostname) ||
      /(?:video|sns-bak)/i.test(url.hostname) ||
      /\.(?:mp4|mov|m4v|m3u8|ts|webm)(?:$|[!/?])/i.test(url.pathname) ||
      /\/stream\//i.test(url.pathname)) return null;
    // nc_* 是卡片封面，nd_prv_* 是详情预览，均不能冒充详情默认图。
    if (/!(?:nc_|nd_prv_)/i.test(url.pathname)) return null;
    url.protocol = 'https:';
    return url.href;
  }

  function selectImages(note) {
    if (note?.type === 'video') throw new Error('这是视频笔记，没有可下载的详情图片');
    const list = note?.imageList || note?.image_list;
    if (!Array.isArray(list) || !list.length) throw new Error('详情中没有图片列表');
    return list.map((image, index) => {
      // 只读取静态图片字段。绝不遍历 stream、video 或 masterUrl。
      const info = image.infoList || image.info_list || [];
      const defaults = info.filter(item => (item.imageScene || item.image_scene) === 'WB_DFT');
      const candidates = [image.urlDefault, image.url_default, ...defaults.map(item => item.url)];
      const url = candidates.map(imageUrl).find(Boolean);
      if (!url) throw new Error(`第 ${index + 1} 张图片缺少详情地址，已停止，未回退到缩略图`);
      return { index, url };
    });
  }

  function videoUrl(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    let url;
    try { url = new URL(raw); }
    catch { return null; }
    if (!['http:', 'https:'].includes(url.protocol) ||
      !/(^|\.)xhscdn\.com$/i.test(url.hostname) || !/\.mp4$/i.test(url.pathname)) return null;
    url.protocol = 'https:';
    return url.href;
  }

  function selectVideo(note) {
    // 必须先确认是视频笔记；图文中的 imageList[].stream 永远不参与选择。
    if (note?.type !== 'video') throw new Error('不是纯视频笔记');
    const stream = note.video?.media?.stream;
    const candidates = Object.values(stream || {}).filter(Array.isArray).flat().map(item => {
      const urls = [item.masterUrl || item.master_url,
        ...(item.backupUrls || item.backup_urls || [])].map(videoUrl).filter(Boolean);
      return { item, urls: [...new Set(urls)] };
    }).filter(candidate => candidate.urls.length);
    candidates.sort((a, b) =>
      (Number(b.item.width) * Number(b.item.height) || 0) -
        (Number(a.item.width) * Number(a.item.height) || 0) ||
      (Number(b.item.avgBitrate || b.item.avg_bitrate) || 0) -
        (Number(a.item.avgBitrate || a.item.avg_bitrate) || 0));
    if (!candidates.length) throw new Error('详情中没有可下载的 MP4 视频地址，请打开笔记后重试');
    return { index: 0, urls: candidates[0].urls };
  }

  function cardLink(card) {
    const links = Array.from(card.querySelectorAll('a[href]'));
    const candidates = links.map(link => {
      try {
        const url = new URL(link.href, location.href);
        if (url.origin !== location.origin) return null;
        const match = url.pathname.match(/\/(?:explore|discovery\/item)\/([a-f\d]{24})\/?$/i) ||
          url.pathname.match(/^\/user\/profile\/[a-f\d]{24}\/([a-f\d]{24})\/?$/i);
        return match ? { id: match[1], url } : null;
      } catch { return null; }
    }).filter(Boolean);
    const id = card.getAttribute('data-note-id');
    const matching = candidates.filter(item => !id || item.id === id);
    const result = matching.find(item => item.url.searchParams.has('xsec_token')) || matching[0];
    if (!result) throw new Error('没有找到笔记详情链接，请刷新页面');
    // 统一用详情 SSR 路由，保留卡片上的访问令牌和来源参数。
    result.url.pathname = `/explore/${result.id}`;
    result.url.hash = '';
    return result;
  }

  function openDetailImages(id, expectedCount) {
    const mask = document.querySelector('.note-detail-mask');
    const container = document.querySelector('#noteContainer');
    if (!container) return null;
    const openId = mask?.getAttribute('note-id') ||
      location.pathname.match(/\/(?:explore|discovery\/item)\/([a-f\d]{24})/)?.[1];
    if (openId !== id || container.getAttribute('data-type') === 'video') return null;
    const slides = container.querySelectorAll('.note-slider .swiper-slide');
    const images = new Map();
    for (const slide of slides) {
      const index = Number(slide.getAttribute('data-swiper-slide-index') ?? slide.getAttribute('data-index'));
      if (!Number.isInteger(index) || index < 0) continue;
      const img = slide.querySelector('.note-slider-img img, img.note-slider-img, .img-container img');
      const url = imageUrl(img?.currentSrc || img?.src);
      if (url) images.set(index, { index, url });
    }
    // Swiper 会复制首尾页，按逻辑下标去重并检查完整性。
    if (!expectedCount || images.size !== expectedCount) return null;
    const sorted = [...images.values()].sort((a, b) => a.index - b.index);
    return sorted.every((image, index) => image.index === index) ? sorted : null;
  }

  async function fetchNote(url, id) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch(url.href, {
        credentials: 'include', signal: controller.signal,
        headers: { Accept: 'text/html' },
      });
      if (!response.ok) throw new Error(`详情请求失败（HTTP ${response.status}）`);
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      const note = noteFromDocument(doc, id);
      if (!note) throw new Error('未取得笔记详情，请确认已登录且这篇笔记可以正常打开');
      return note;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('读取详情超时，请重试');
      throw error;
    } finally { clearTimeout(timer); }
  }

  async function loadNote(id, url) {
    let note;
    try { note = noteFromState(unsafeWindow.__INITIAL_STATE__, id); }
    catch { /* 部分脚本管理器限制页面对象访问，继续读取 HTML。 */ }
    const hasMedia = value => value?.type === 'video'
      ? Object.values(value.video?.media?.stream || {}).some(list => Array.isArray(list) && list.length)
      : value?.imageList?.length || value?.image_list?.length;
    if (!hasMedia(note)) note = noteFromDocument(document, id);
    if (!hasMedia(note)) note = await fetchNote(url, id);
    if (note?.type === 'video') return { note, kind: 'video', media: [selectVideo(note)] };
    const images = selectImages(note);
    return { note, kind: 'image', media: openDetailImages(id, images.length) || images };
  }

  function detectImage(bytes) {
    const starts = (...values) => values.every((value, i) => bytes[i] === value);
    const ascii = (start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
    if (starts(0xff, 0xd8, 0xff)) return { ext: 'jpg', mime: 'image/jpeg' };
    if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { ext: 'png', mime: 'image/png' };
    if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
    if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return { ext: 'gif', mime: 'image/gif' };
    if (ascii(4, 4) === 'ftyp') {
      const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
      if (size < 16 || size > bytes.length) return null;
      const brands = [ascii(8, 4)];
      for (let i = 16; i + 4 <= size; i += 4) brands.push(ascii(i, 4));
      // MP4 的 isom/mp4* 等品牌不能通过；只接收明确的静态图格式。
      if (brands.includes('avif')) return { ext: 'avif', mime: 'image/avif' };
      if (brands.some(brand => ['heic', 'heix'].includes(brand))) return { ext: 'heic', mime: 'image/heic' };
    }
    return null;
  }

  function requestImage(url) {
    if (!imageUrl(url)) return Promise.reject(new Error('已拦截非图片或缩略图地址'));
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'arraybuffer', timeout: 45000,
        headers: { Referer: 'https://www.xiaohongshu.com/', Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
        onload(response) {
          try {
            if (response.status < 200 || response.status >= 300) throw new Error(`图片请求失败（HTTP ${response.status}）`);
            if (response.finalUrl && !imageUrl(response.finalUrl)) throw new Error('图片被重定向到非图片地址');
            if (/^content-type:\s*video\//im.test(response.responseHeaders || '')) throw new Error('已拦截视频响应');
            const bytes = new Uint8Array(response.response);
            const format = detectImage(bytes);
            if (!format) throw new Error('响应不是支持的静态图片，已拒绝保存（可能是视频或验证页面）');
            resolve({ blob: new Blob([bytes], { type: format.mime }), ext: format.ext });
          } catch (error) { reject(error); }
        },
        onerror: () => reject(new Error('图片网络请求失败')),
        ontimeout: () => reject(new Error('图片下载超时')),
      });
    });
  }

  function detectVideo(bytes) {
    if (bytes.length < 16 || detectImage(bytes)) return null;
    const ascii = (start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
    if (ascii(4, 4) !== 'ftyp') return null;
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (size < 16 || size > bytes.length) return null;
    const brands = [ascii(8, 4)];
    for (let i = 16; i + 4 <= size; i += 4) brands.push(ascii(i, 4));
    return brands.some(brand => /^(?:isom|iso[2-9]|mp4[12]|avc1|dash|M4V )$/.test(brand))
      ? { ext: 'mp4', mime: 'video/mp4' } : null;
  }

  function requestVideo(url) {
    if (!videoUrl(url)) return Promise.reject(new Error('已拦截非 MP4 视频地址'));
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'arraybuffer', timeout: 180000,
        headers: { Referer: 'https://www.xiaohongshu.com/', Accept: 'video/mp4,application/octet-stream;q=0.9,*/*;q=0.8' },
        onload(response) {
          try {
            if (response.status < 200 || response.status >= 300) throw new Error(`视频请求失败（HTTP ${response.status}）`);
            if (response.finalUrl && !videoUrl(response.finalUrl)) throw new Error('视频被重定向到非 MP4 地址');
            const bytes = new Uint8Array(response.response);
            const format = detectVideo(bytes);
            if (!format) throw new Error('响应不是支持的 MP4 视频，已拒绝保存（可能是图片或验证页面）');
            resolve({ blob: new Blob([bytes], { type: format.mime }), ext: format.ext });
          } catch (error) { reject(error); }
        },
        onerror: () => reject(new Error('视频网络请求失败')),
        ontimeout: () => reject(new Error('视频下载超时')),
      });
    });
  }

  async function requestVideoWithFallback(urls) {
    let lastError;
    for (const url of urls) {
      try { return await requestVideo(url); }
      catch (error) { lastError = error; }
    }
    throw lastError || new Error('没有可下载的视频地址');
  }

  function safeName(value) {
    return String(value || '').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/[.\s]+$/g, '').trim().slice(0, 70) || '小红书笔记';
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

  function notify(message, error = false) {
    let toast = document.getElementById('xhs-image-download-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'xhs-image-download-toast';
      toast.setAttribute('role', 'status');
      document.body.append(toast);
    }
    toast.textContent = message;
    toast.dataset.error = String(error);
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => toast.remove(), error ? 12000 : 5000);
  }

  async function downloadCard(card, button) {
    if (downloading) return notify('正在下载另一篇笔记，请稍候');
    downloading = true;
    button.disabled = true;
    button.dataset.busy = 'true';
    button.textContent = '读取详情…';
    let successes = 0;
    let total = 0;
    let done;
    let kind;
    try {
      const { id, url } = cardLink(card);
      const result = await loadNote(id, url);
      const { note, media } = result;
      kind = result.kind;
      const isVideo = kind === 'video';
      total = media.length;
      const key = `${id}:${kind}`;
      done = savedMedia.get(key) || new Set();
      if (done.size === total) done = new Set(); // 完整下载后，下一次点击允许重新下载。
      savedMedia.set(key, done);
      successes = done.size;
      const author = note.user?.nickname || note.user?.nickName || '';
      const title = note.title || card.querySelector('.title')?.textContent || '小红书笔记';
      const prefix = `${safeName(author)}_${safeName(title)}_${id}`;
      const failures = [];
      for (const item of media) {
        if (done.has(item.index)) continue;
        button.textContent = isVideo ? '下载视频…' : `下载 ${item.index + 1}/${total}`;
        try {
          const { blob, ext } = await (isVideo ? requestVideoWithFallback(item.urls) : requestImage(item.url));
          await saveBlob(blob, `${prefix}_${String(item.index + 1).padStart(2, '0')}.${ext}`);
          done.add(item.index);
          successes++;
        } catch (error) {
          failures.push(`${isVideo ? '视频' : `第 ${item.index + 1} 张`}：${error.message}`);
          // 权限配置错误时无需继续请求剩余图片。
          if (/油猴|权限|白名单|不支持油猴/.test(error.message)) break;
        }
      }
      if (failures.length) throw new Error(failures.join('；'));
      button.textContent = isVideo ? '视频已下载' : `已下载 ${successes} 张`;
      notify(isVideo ? '已保存视频' : `已保存 ${successes} 张详情图片（不包含实况视频）`);
    } catch (error) {
      button.textContent = total ? `重试 ${successes}/${total}` : '重试下载';
      notify(`${total ? `已保存 ${successes}/${total} ${kind === 'video' ? '个视频' : '张图片'}。` : ''}${error.message}`, true);
      console.warn('[小红书下载]', error.message);
    } finally {
      downloading = false;
      button.disabled = false;
      delete button.dataset.busy;
    }
  }

  function attachButtons() {
    for (const card of document.querySelectorAll(CARD)) {
      if (card.querySelector(`.${BUTTON}`)) continue;
      if (getComputedStyle(card).position === 'static') card.classList.add('xhs-image-download-relative');
      const button = document.createElement('button');
      button.className = BUTTON;
      button.type = 'button';
      button.textContent = '↓ 下载';
      button.title = '下载这篇笔记的详情图片或视频（实况只保存静态图）';
      button.setAttribute('aria-label', button.title);
      for (const event of ['pointerdown', 'mousedown', 'dblclick']) {
        button.addEventListener(event, e => e.stopPropagation());
      }
      button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        void downloadCard(card, button);
      });
      card.append(button);
    }
  }

  function start() {
    GM_addStyle(`
      .xhs-image-download-relative { position: relative !important; }
      ${CARD} > .${BUTTON} {
        position: absolute; top: 9px; right: 9px; z-index: 30;
        display: block; padding: 7px 11px; border: 1px solid rgba(255,255,255,.6);
        border-radius: 18px; background: rgba(20,20,20,.8); color: #fff;
        font: 500 12px/1.3 system-ui, sans-serif; cursor: pointer;
        opacity: 0; pointer-events: none; transition: opacity .15s, background .15s;
        box-shadow: 0 2px 8px #0003;
      }
      ${CARD}:hover > .${BUTTON}, ${CARD}:focus-within > .${BUTTON},
      ${CARD} > .${BUTTON}[data-busy="true"] { opacity: 1; pointer-events: auto; }
      ${CARD} > .${BUTTON}:hover { background: #ff2442; }
      ${CARD} > .${BUTTON}:focus-visible { opacity: 1; outline: 2px solid #ff2442; outline-offset: 2px; }
      ${CARD} > .${BUTTON}:disabled { cursor: progress; }
      @media (hover: none) { ${CARD} > .${BUTTON} { opacity: 1; pointer-events: auto; } }
      #xhs-image-download-toast {
        position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%);
        z-index: 2147483647; max-width: min(640px, 88vw); padding: 13px 18px;
        border-radius: 12px; background: #222f; color: white; font: 14px/1.6 system-ui;
        white-space: pre-wrap; overflow-wrap: anywhere; box-shadow: 0 4px 24px #0003;
      }
      #xhs-image-download-toast[data-error="true"] { background: #93213bf5; }
    `);
    attachButtons();
    let timer;
    new MutationObserver(records => {
      if (!records.some(record => [...record.addedNodes].some(node =>
        node.nodeType === 1 && (node.matches?.(CARD) || node.querySelector?.(CARD))))) return;
      clearTimeout(timer);
      timer = setTimeout(attachButtons, 100);
    }).observe(document.body, { childList: true, subtree: true });
  }

  // Node 的离线验证入口；网页环境不会导出或暴露下载 API。
  if (typeof module !== 'undefined' && module.exports && typeof document === 'undefined') {
    module.exports = { noteFromState, readObjectLiteral, noteFromDocument, imageUrl,
      selectImages, selectVideo, videoUrl, cardLink, openDetailImages, detectImage, detectVideo,
      safeName, requestImage, requestVideo, requestVideoWithFallback, saveBlob, loadNote, downloadCard, start };
  } else { start(); }
})();
