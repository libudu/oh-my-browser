// ==UserScript==
// @name         互传网页版：文件夹
// @namespace    linpicio.easyshare
// @version      1.2.0
// @description  多选实际文件夹筛选图片和视频，沿用互传原有的选择、下载、删除和排序操作
// @match        http://192.168.1.91/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @noframes
// ==/UserScript==

(() => {
  "use strict";

  // 针对当前手机提供的 Web EasyShare web2.1.0.9；端口变化无需改脚本。
  if (window.__easyshareFolders || window.__easyshareVideoFolders) return;
  window.__easyshareFolders = true;
  // 占用旧标记，避免旧版脚本随后加载时重复包装 Redux。
  window.__easyshareVideoFolders = true;

  const FILTER = "LINPICIO_EASYSHARE_FOLDER";
  const IMAGE_GROUP = "互传文件夹";
  const media = {
    video: {
      label: "视频",
      receive: "RECEIVE_POSTS_VIDEOLIST",
      clearSelection: "PAGE_VIDEO_NORMAL_SHOW_OPERATION_BUTTON",
      clearPage: "CLEAR_VIDEO_PAGE_DATA",
      info: "videoInfo",
      loading: "videoNormalListLoading",
      container: "videoList_con",
    },
    image: {
      label: "图片",
      receive: "RECEIVE_POSTS_CALLERY",
      clearSelection: "PAGE_IMAGE_CALLERY_SHOW_OPERATION_BUTTON",
      clearPage: "CLEAR_IMAGECALLERY_PAGE_DATA",
      info: "imageCalleryInfo",
      loading: "imageGalleryLoading",
      container: "imageContainer",
    },
  };
  for (const channel of Object.values(media)) {
    channel.fullPayload = null;
    // null 表示全部；空 Set 表示不显示文件。图片和视频各自保留筛选条件。
    channel.selectedFolders = null;
    channel.folders = [];
    channel.search = "";
  }
  const UNKNOWN = "(无法识别文件夹)";
  const wrappedFactories = new WeakSet();
  let store = null;
  let webpackRequire = null;
  let panel = null;
  let folderList = null;
  let caption = null;
  let searchInput = null;
  let title = null;
  let activeChannel = null;
  let scheduled = false;
  let listDirty = true;
  let hooked = false;
  let failed = false;
  let lastBlocked = null;

  function folderOf(item) {
    const path = typeof item.savePath === "string" ? item.savePath : "";
    const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
    const separator = normalized.lastIndexOf("/");
    return separator > 0 ? normalized.slice(0, separator) : UNKNOWN;
  }

  function itemsOf(channel, payload) {
    if (!payload) return [];
    if (channel === media.video) return payload.videoList || [];
    return (payload.foldersNameArray || []).flatMap(
      (group) => payload.detailMap[group]?.photoInfo?.photoList || [],
    );
  }

  function rebuildFolders(channel) {
    const counts = new Map();
    for (const item of itemsOf(channel, channel.fullPayload)) {
      const path = folderOf(item);
      counts.set(path, (counts.get(path) || 0) + 1);
    }
    channel.folders = Array.from(counts, ([path, count]) => ({ path, count }));
    channel.folders.sort((a, b) =>
      a.path.localeCompare(b.path, "zh-CN", { numeric: true }),
    );
    if (channel.selectedFolders !== null) {
      const available = new Set(
        [...channel.selectedFolders].filter((path) => counts.has(path)),
      );
      if (available.size !== channel.selectedFolders.size)
        channel.selectedFolders = available;
    }
    listDirty = true;
  }

  function retainItems(channel, payload, predicate) {
    if (channel === media.video) {
      const videoList = payload.videoList.filter(predicate);
      return { ...payload, videoList, count: videoList.length, isSelected: false };
    }
    const detailMap = {};
    const foldersNameArray = [];
    let count = 0;
    for (const group of payload.foldersNameArray) {
      const detail = payload.detailMap[group];
      const photoList = detail.photoInfo.photoList.filter(predicate);
      if (!photoList.length) continue;
      foldersNameArray.push(group);
      detailMap[group] = {
        ...detail,
        iconPath: photoList[0].savePath,
        folderCnt: photoList.length,
        photoInfo: {
          ...detail.photoInfo,
          photoList,
          count: photoList.length,
          isSelected: false,
        },
      };
      count += photoList.length;
    }
    return { ...payload, detailMap, foldersNameArray, count, isSelected: false };
  }

  function visiblePayload(channel) {
    const { fullPayload, selectedFolders } = channel;
    const json = retainItems(
      channel, fullPayload,
      (item) => selectedFolders === null || selectedFolders.has(folderOf(item)),
    );
    if (channel === media.video || selectedFolders === null) return json;
    // 用一个原生相册合并多个实际目录，原生预览、拖选和批量操作仍使用真实路径。
    const photoList = itemsOf(channel, json);
    return {
      ...json,
      foldersNameArray: photoList.length ? [IMAGE_GROUP] : [],
      detailMap: photoList.length
        ? {
            [IMAGE_GROUP]: {
              iconPath: photoList[0].savePath,
              folderCnt: photoList.length,
              photoInfo: { photoList, count: photoList.length, isSelected: false },
            },
          }
        : {},
    };
  }

  function clearNativeSelection(channel, json) {
    // 原网页依赖共享选择表和索引锚点；只隐藏 DOM 会导致批量操作选错文件。
    const shared = webpackRequire(2).a;
    if (channel === media.video) {
      shared.videoSelected.clear();
      shared.videoIsRecordSelect = true;
      shared.videoList = json.videoList;
    } else {
      shared.imageGallery.clear();
      shared.imageGalleryInfo = json;
      const Selection = webpackRequire(59).a;
      for (const group of json.foldersNameArray) {
        const selection = new Selection();
        selection.list = json.detailMap[group].photoInfo.photoList;
        selection.count = selection.list.length;
        shared.imageGallery.put(group, selection);
      }
    }
    webpackRequire(20).a.setAnchor(0);
  }

  function applyFilter(originalReducer, previous, channel, action = {}, keepGroup = false) {
    const json = visiblePayload(channel);
    clearNativeSelection(channel, json);
    let next = originalReducer(previous, {
      ...action, type: channel.receive, json,
    });
    const currentGroup = previous?.getIn(["CommonData", "imageCalleryCurrentGroup"]);
    if (keepGroup && channel === media.image &&
        json.foldersNameArray.includes(currentGroup)) {
      next = originalReducer(next, {
        type: "HANDLE_IMAGE_CALLERY_CURRENT_GROUP_CHANGE", currentGroup,
      });
    }
    return originalReducer(next, { type: channel.clearSelection, show: false });
  }

  function enhanceReducer(originalReducer) {
    return (previous, action) => {
      if (action.type === "Initialize") {
        for (const channel of Object.values(media)) {
          channel.fullPayload = null;
          channel.selectedFolders = null;
          rebuildFolders(channel);
        }
      }

      const receiving = Object.values(media).find(
        (channel) => action.type === channel.receive,
      );
      const validPayload = receiving === media.video
        ? Array.isArray(action.json?.videoList)
        : Array.isArray(action.json?.foldersNameArray) && action.json?.detailMap;
      if (receiving && validPayload) {
        // 复制完整列表；刷新、排序响应替换缓存，筛选和删除不会改写响应对象。
        receiving.fullPayload = retainItems(receiving, action.json, () => true);
        rebuildFolders(receiving);
        return applyFilter(originalReducer, previous, receiving, action);
      }

      const filtering = media[action.media];
      if (action.type === FILTER && filtering?.fullPayload) {
        if (interactionBlocked(previous, filtering)) return previous;
        filtering.selectedFolders =
          action.folders === null ? null : new Set(action.folders);
        listDirty = true;
        return applyFilter(originalReducer, previous, filtering);
      }

      let next = originalReducer(previous, action);
      for (const channel of Object.values(media)) {
        if (!channel.fullPayload || !previous || action.type === channel.clearPage)
          continue;
        const before = previous.getIn(["CommonData", channel.info]);
        const after = next.getIn(["CommonData", channel.info]);
        if (before && after && before !== after) {
          // 单个/批量删除及手机推送更新仍由原 reducer 执行，然后同步缓存。
          const remaining = new Set(
            itemsOf(channel, after.toJS()).map((item) => item.savePath),
          );
          const removed = new Set(
            itemsOf(channel, before.toJS())
              .filter((item) => !remaining.has(item.savePath))
              .map((item) => item.savePath),
          );
          if (removed.size) {
            channel.fullPayload = retainItems(
              channel, channel.fullPayload,
              (item) => !removed.has(item.savePath),
            );
            rebuildFolders(channel);
            next = applyFilter(originalReducer, next, channel, {}, true);
          }
        }
      }
      return next;
    };
  }

  function captureCreateStore(originalCreateStore) {
    return (reducer, ...args) => {
      const result = originalCreateStore(enhanceReducer(reducer), ...args);
      store = result;
      hooked = true;
      store.subscribe(scheduleUi);
      scheduleUi();
      return result;
    };
  }

  function wrapChunk(chunk) {
    // 815 是当前版本的应用入口，101 是 Redux；只包装入口的 require。
    const factory = chunk?.[1]?.[815];
    if (typeof factory !== "function" || wrappedFactories.has(factory)) return;
    const wrapped = function (module, exports, require) {
      webpackRequire = require;
      const redux = require(101);
      if (typeof redux.c !== "function") {
        failed = true;
        scheduleUi();
        return factory.call(this, module, exports, require);
      }
      const replacement = { ...redux, c: captureCreateStore(redux.c) };
      const interceptedRequire = new Proxy(require, {
        apply(target, thisArg, args) {
          return String(args[0]) === "101"
            ? replacement
            : Reflect.apply(target, thisArg, args);
        },
      });
      return factory.call(this, module, exports, interceptedRequire);
    };
    wrappedFactories.add(wrapped);
    chunk[1][815] = wrapped;
  }

  // Webpack 启动时会替换 push，并保存旧 push。每层闭包保留自己的委托，避免递归。
  const queue = (window.webpackJsonpairtoolweb =
    window.webpackJsonpairtoolweb || []);
  for (const chunk of queue) wrapChunk(chunk);
  let push = interceptPush(queue.push);
  function interceptPush(delegate) {
    return function (...chunks) {
      for (const chunk of chunks) wrapChunk(chunk);
      return Reflect.apply(delegate, this, chunks);
    };
  }
  Object.defineProperty(queue, "push", {
    configurable: true,
    get: () => push,
    set: (delegate) => {
      push = interceptPush(delegate);
    },
  });

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function addStyles() {
    if (document.getElementById("esvf-style")) return;
    const style = document.createElement("style");
    style.id = "esvf-style";
    style.textContent = `
      #esvf-panel { position:fixed; z-index:9990; width:272px; max-width:calc(100vw - 24px);
        box-sizing:border-box; padding:12px; background:#fff; color:#333; border:1px solid #ddd;
        border-radius:8px; box-shadow:0 3px 16px #0002; font:13px/1.5 "Microsoft YaHei",sans-serif; }
      #esvf-panel * { box-sizing:border-box; }
      #esvf-panel[hidden] { display:none; }
      #videoList_con.esvf-layout > .videoList,
      #imageContainer.esvf-layout > .imageList {
        width:calc(100% - var(--esvf-offset)) !important;
        margin-left:var(--esvf-offset) !important;
      }
      #imageContainer.esvf-layout > .imgGroupList {
        margin-left:296px;
      }
      #imageContainer.esvf-merged > .imgGroupList,
      #imageContainer.esvf-layout > .imgGroupListNoData { display:none; }
      .esvf-title { font-size:15px; font-weight:bold; margin-bottom:5px; }
      .esvf-caption { margin-bottom:9px; color:#666; overflow-wrap:anywhere; }
      .esvf-search { display:block; width:100%; height:32px; padding:5px 8px; margin-bottom:8px;
        color:#333; background:white; border:1px solid #ccc; border-radius:4px; }
      .esvf-list { overflow-y:auto; max-height:46vh; }
      .esvf-folder { display:block; width:100%; padding:8px; margin:0 0 4px; text-align:left;
        color:#333; background:#f7f7f7; border:1px solid transparent; border-radius:4px; cursor:pointer; }
      .esvf-folder:hover { background:#edf5ff; }
      .esvf-folder[aria-pressed="true"], .esvf-folder[aria-checked="true"] {
        color:#1666b5; background:#e5f2ff; border-color:#91c6f7; }
      .esvf-folder:disabled { cursor:wait; opacity:.6; }
      .esvf-name { display:block; font-weight:bold; overflow-wrap:anywhere; }
      .esvf-check { display:inline-block; width:15px; height:15px; margin-right:6px;
        border:1px solid #aaa; border-radius:3px; vertical-align:middle; text-align:center;
        font-size:12px; line-height:13px; background:white; }
      .esvf-folder[aria-checked="true"] .esvf-check { background:#1666b5; border-color:#1666b5; color:white; }
      .esvf-path { display:block; font-size:11px; color:#777; overflow-wrap:anywhere; }
      .esvf-note { margin-top:8px; color:#777; font-size:11px; }
      #esvf-error { position:fixed; z-index:9999; bottom:16px; right:16px; max-width:340px;
        padding:12px; color:#333; background:#fff6d9; border:1px solid #e2c06a; border-radius:6px; }
    `;
    document.head.append(style);
  }

  function mountPanel() {
    if (panel?.isConnected) return;
    addStyles();
    panel = element("aside");
    panel.id = "esvf-panel";
    panel.setAttribute("aria-label", "互传文件夹筛选");
    panel.hidden = true;
    title = element("div", "esvf-title");
    panel.append(title);
    caption = element("div", "esvf-caption");
    panel.append(caption);
    const input = element("input", "esvf-search");
    input.type = "search";
    input.placeholder = "搜索文件夹名称或路径";
    input.setAttribute("aria-label", input.placeholder);
    searchInput = input;
    input.addEventListener("input", () => {
      if (!activeChannel) return;
      activeChannel.search = input.value.toLocaleLowerCase().trim();
      listDirty = true;
      scheduleUi();
    });
    panel.append(input);
    folderList = element("div", "esvf-list");
    panel.append(folderList);
    panel.append(
      element(
        "div",
        "esvf-note",
        "勾选多个文件夹可合并显示；更改文件夹筛选会清空当前文件选择。",
      ),
    );
    // 面板挂到 body，避免 React 重绘或拖选接管它。
    for (const event of ["mousedown", "touchstart", "keydown"]) {
      panel.addEventListener(event, (e) => e.stopPropagation());
    }
    document.body.append(panel);
    listDirty = true;
  }

  function chooseFolder(path) {
    const channel = activeChannel;
    if (!store || !channel?.fullPayload) return;
    const { selectedFolders } = channel;
    if (interactionBlocked(store.getState(), channel)) return;
    if (path === null && selectedFolders === null) return;
    let selection = null;
    if (path !== null) {
      selection = new Set(selectedFolders || []);
      if (selection.has(path)) selection.delete(path);
      else selection.add(path);
    }
    store.dispatch({
      type: FILTER,
      media: channel === media.image ? "image" : "video",
      folders: selection === null ? null : [...selection],
    });
    const container = document.getElementById(channel.container);
    if (container) {
      container.scrollTop = 0;
      for (const child of container.querySelectorAll("*")) {
        if (child.scrollTop) child.scrollTop = 0;
      }
    }
  }

  function interactionBlocked(state, channel) {
    // 删除确认和执行期间保持索引稳定，等待原网页完成操作后再允许切换。
    return Boolean(
      state.getIn(["CommonData", channel.loading]) ||
      state.getIn(["ImageFullScreen", "ImageFullScreenShow"]) ||
      state.getIn(["Dialog", "show"]) ||
      state.getIn(["Dialog", "isDeleteing"]) ||
      state.getIn(["DialogWithFunc", "show"]) ||
      state.getIn(["Loading", "show"]),
    );
  }

  function folderButton(channel, path, count, loading) {
    const { selectedFolders } = channel;
    const button = element("button", "esvf-folder");
    button.type = "button";
    button.disabled = loading;
    if (path === null) {
      button.setAttribute("aria-pressed", String(selectedFolders === null));
      button.append(element("span", "esvf-name", `全部${channel.label} (${count})`));
    } else {
      const checked = selectedFolders?.has(path) || false;
      button.setAttribute("role", "checkbox");
      button.setAttribute("aria-checked", String(checked));
      button.title = path;
      const name = element("span", "esvf-name");
      const mark = element("span", "esvf-check", checked ? "✓" : "");
      mark.setAttribute("aria-hidden", "true");
      name.append(
        mark,
        document.createTextNode(`${path.split("/").pop()} (${count})`),
      );
      button.append(name);
      button.append(
        element(
          "span",
          "esvf-path",
          path.replace(/^\/storage\/emulated\/0\//, "内部存储/"),
        ),
      );
    }
    button.addEventListener("click", () => chooseFolder(path));
    return button;
  }

  function updateUi() {
    scheduled = false;
    if (!document.body || !document.head) return;
    if (!hooked) {
      if (failed && !document.getElementById("esvf-error")) {
        addStyles();
        const warning = element(
          "div",
          "",
          "互传文件夹脚本未接入：请刷新页面，并确认 Tampermonkey 允许用户脚本。若仍无效，互传网页版本可能已变化。",
        );
        warning.id = "esvf-error";
        document.body.append(warning);
      }
      return;
    }
    mountPanel();
    const state = store.getState();
    let channel = null;
    if (state.getIn(["PageSwitch", "ImageListShow"]) &&
        state.getIn(["PageSwitch", "ImageGalleryPageShow"])) channel = media.image;
    else if (state.getIn(["PageSwitch", "VideoListShow"]) &&
        state.getIn(["PageSwitch", "VideoNormalPageShow"])) channel = media.video;
    const active = channel &&
      !state.getIn(["CommonData", "isSearching"]) &&
      state.getIn(["PageSwitch", "showMainPage"]);
    if (channel !== activeChannel) {
      activeChannel = channel;
      listDirty = true;
      lastBlocked = null;
      searchInput.value = channel?.search || "";
    }
    const modalOpen =
      state.getIn(["Dialog", "show"]) ||
      state.getIn(["DialogWithFunc", "show"]) ||
      state.getIn(["Loading", "show"]) ||
      state.getIn(["ImageFullScreen", "ImageFullScreenShow"]);
    panel.hidden = !active || Boolean(modalOpen);
    if (!active || modalOpen) return;
    const container = document.getElementById(channel.container);
    if (!container) {
      panel.hidden = true;
      return;
    }
    const bounds = container.getBoundingClientRect();
    // 留出原列表的空间，面板不参与 React 的 DOM 管理。
    panel.style.left = `${Math.max(12, bounds.left + 12)}px`;
    panel.style.top = `${Math.max(12, bounds.top + 12)}px`;
    const { fullPayload, selectedFolders, folders, search } = channel;
    const merged = channel === media.image && selectedFolders !== null;
    container.classList.add("esvf-layout");
    container.classList.toggle("esvf-merged", merged);
    container.style.setProperty(
      "--esvf-offset",
      channel === media.image && !merged && fullPayload?.count ? "438px" : "296px",
    );
    const loading = Boolean(
      state.getIn(["CommonData", channel.loading]),
    );
    const blocked = interactionBlocked(state, channel);
    const total = fullPayload?.count || 0;
    const visible = state.getIn(["CommonData", channel.info, "count"]) || 0;
    title.textContent = `${channel.label}文件夹 · 多选`;
    const selectionText =
      selectedFolders === null
        ? "全部文件夹"
        : `已选 ${selectedFolders.size} 个文件夹`;
    caption.textContent = fullPayload
      ? `共 ${folders.length} 个文件夹 · ${selectionText} · 当前 ${visible} / 共 ${total} 个${channel.label}${loading ? " · 正在更新" : ""}`
      : `正在等待${channel.label}列表…`;
    if (blocked !== lastBlocked) {
      lastBlocked = blocked;
      listDirty = true;
    }
    if (!listDirty) return;
    listDirty = false;
    const fragment = document.createDocumentFragment();
    fragment.append(folderButton(channel, null, total, blocked || !fullPayload));
    let matched = 0;
    for (const folder of folders) {
      if (search && !folder.path.toLocaleLowerCase().includes(search)) continue;
      fragment.append(folderButton(channel, folder.path, folder.count, blocked));
      matched++;
    }
    if (search && !matched)
      fragment.append(element("div", "esvf-note", "没有匹配的文件夹"));
    folderList.replaceChildren(fragment);
  }

  function scheduleUi() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(updateUi);
  }

  function observePage() {
    new MutationObserver((records) => {
      // 只关注原网页，避免面板自身刷新引发循环。
      if (records.some((record) => !panel?.contains(record.target)))
        scheduleUi();
    }).observe(document.body, { childList: true, subtree: true });
    scheduleUi();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", observePage, { once: true });
  } else observePage();
  window.addEventListener("resize", scheduleUi);
  window.setTimeout(() => {
    if (!hooked) {
      failed = true;
      scheduleUi();
    }
  }, 15000);
})();
