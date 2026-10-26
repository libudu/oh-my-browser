const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "script.js"), "utf8");

function setup() {
  class SelectionMap extends Map {
    put(key, value) { this.set(key, value); }
  }
  class Selection {
    constructor() {
      this.selectedItems = new SelectionMap();
      this.isRecordSelect = true;
      this.isGroupSelected = false;
    }
  }
  const shared = { videoSelected: new SelectionMap(), imageGallery: new SelectionMap() };
  const anchor = { value: 99, setAnchor(value) { this.value = value; } };
  const modules = { 2: { a: shared }, 20: { a: anchor }, 59: { a: Selection } };
  const context = {
    window: { addEventListener() {}, setTimeout() {} },
    document: { readyState: "loading", addEventListener() {} },
    requestAnimationFrame() {},
  };
  vm.runInNewContext(source.replace("  function captureCreateStore(", `
    window.testing = {
      media, enhanceReducer, itemsOf,
      setRequire(require) { webpackRequire = require; },
    };
    function captureCreateStore(`), context);
  const api = context.window.testing;
  api.setRequire((id) => modules[id]);

  // 模拟原网页的数据更新；测试脚本必须透传未知操作、识别真正的文件删除。
  function stateOf(data) {
    return {
      data,
      getIn(keys) {
        const value = keys.reduce((parent, key) => parent?.[key], data);
        return value && typeof value === "object" ? { toJS: () => value } : value;
      },
    };
  }
  const initial = () => stateOf({ CommonData: {}, PageSelectedMap: {} });
  const nativeReducer = (state = initial(), action) => {
    if (action.type === "Initialize") return initial();
    const receiving = Object.values(api.media).find((channel) => channel.receive === action.type);
    if (receiving) {
      return stateOf({ ...state.data, CommonData: {
        ...state.data.CommonData, [receiving.info]: action.json,
      } });
    }
    const clearing = Object.values(api.media).find((channel) => channel.clearSelection === action.type);
    if (clearing) {
      return stateOf({ ...state.data, PageSelectedMap: {
        ...state.data.PageSelectedMap, [clearing.info]: action.show,
      } });
    }
    const clearPage = Object.values(api.media).find((channel) => channel.clearPage === action.type);
    if (clearPage) {
      return stateOf({ ...state.data, CommonData: {
        ...state.data.CommonData,
        [clearPage.info]: clearPage === api.media.image
          ? { count: 0, foldersNameArray: [], detailMap: {} }
          : { count: 0, videoList: [] },
      } });
    }
    if (action.type === "test/native-update") {
      return stateOf({ ...state.data, CommonData: {
        ...state.data.CommonData, [action.info]: action.payload,
      } });
    }
    return state;
  };
  const reducer = api.enhanceReducer(nativeReducer);
  let state = initial();
  return {
    ...api, shared, anchor, stateOf,
    dispatch(action) { state = reducer(state, action); return state; },
    receive(kind, json) { return this.dispatch({ type: api.media[kind].receive, json }); },
    filter(kind, folders) {
      return this.dispatch({ type: "LINPICIO_EASYSHARE_FOLDER", media: kind, folders });
    },
    payload(kind) { return state.data.CommonData[api.media[kind].info]; },
  };
}

const image = (savePath) => ({ savePath, fileName: savePath.split("/").pop(), isPhoto: true });
const images = () => ({
  count: 3, sortCondition: 5, foldersNameArray: ["Camera", "Downloads"],
  detailMap: {
    Camera: { folderCnt: 2, photoInfo: { count: 2, photoList: [
      image("/DCIM/Camera/a.jpg"), image("/Pictures/Camera/b.jpg"),
    ] } },
    Downloads: { folderCnt: 1, photoInfo: { count: 1, photoList: [image("/Download/c.png")] } },
  },
});
const videos = () => ({ count: 2, sortCondition: 0, videoList: [
  { savePath: "/Movies/a.mp4" }, { savePath: "/Download/b.mp4" },
] });
const paths = (app, kind) => Array.from(app.itemsOf(app.media[kind], app.payload(kind)), (item) => item.savePath);

test("图片按实际路径区分同名文件夹，并合并多个目录；不修改响应", () => {
  const app = setup();
  const payload = images();
  const original = JSON.stringify(payload);
  app.receive("image", payload);
  assert.equal(app.media.image.folders.length, 3);
  app.filter("image", ["/DCIM/Camera", "/Download"]);
  assert.deepEqual(paths(app, "image"), ["/DCIM/Camera/a.jpg", "/Download/c.png"]);
  assert.equal(app.payload("image").count, 2);
  assert.equal(app.payload("image").sortCondition, 5);
  assert.equal(app.payload("image").foldersNameArray.length, 1);
  assert.equal(JSON.stringify(payload), original);
  app.filter("image", []);
  assert.equal(app.payload("image").count, 0);
  assert.deepEqual(paths(app, "image"), []);
  app.filter("image", null);
  assert.deepEqual(Array.from(app.payload("image").foldersNameArray), ["Camera", "Downloads"]);
  assert.equal(app.payload("image").count, 3);
});

test("图片和视频筛选独立，重置原生选择及 Shift 锚点", () => {
  const app = setup();
  app.receive("image", images());
  app.receive("video", videos());
  app.shared.videoSelected.set("/Movies/a.mp4", true);
  app.filter("video", ["/Movies"]);
  assert.equal(app.shared.videoSelected.size, 0);
  assert.equal(app.shared.videoIsRecordSelect, true);
  assert.equal(app.anchor.value, 0);
  app.filter("image", ["/Download"]);
  const group = app.shared.imageGallery.get(app.payload("image").foldersNameArray[0]);
  assert.equal(group.isRecordSelect, true);
  assert.equal(group.selectedItems.size, 0);
  assert.equal(group.count, 1);
  assert.deepEqual(Array.from(group.list, (item) => item.savePath), ["/Download/c.png"]);
  assert.deepEqual(paths(app, "video"), ["/Movies/a.mp4"]);
  app.filter("image", null);
  assert.deepEqual(paths(app, "video"), ["/Movies/a.mp4"]);
});

test("删除筛选中的最后一张图片后，切回全部不会恢复已删除文件", () => {
  const app = setup();
  app.receive("image", images());
  app.filter("image", ["/Download"]);
  app.dispatch({ type: "test/native-update", info: "imageCalleryInfo", payload: {
    count: 0, foldersNameArray: [], detailMap: {},
  } });
  assert.equal(app.media.image.selectedFolders.size, 0);
  app.filter("image", null);
  assert.deepEqual(paths(app, "image"), ["/DCIM/Camera/a.jpg", "/Pictures/Camera/b.jpg"]);
  assert.equal(app.payload("image").count, 2);
});

test("批量删除视频同步缓存，保留筛选外的文件", () => {
  const app = setup();
  app.receive("video", videos());
  app.filter("video", ["/Movies"]);
  app.dispatch({ type: "test/native-update", info: "videoInfo", payload: { count: 0, videoList: [] } });
  app.filter("video", null);
  assert.deepEqual(paths(app, "video"), ["/Download/b.mp4"]);
});

test("排序与刷新替换完整缓存并保留筛选；刷新清空页面不会抹除缓存", () => {
  const app = setup();
  app.receive("image", images());
  app.filter("image", ["/Download"]);
  app.dispatch({ type: app.media.image.clearPage });
  assert.equal(app.payload("image").count, 0);
  assert.equal(app.media.image.fullPayload.count, 3);
  const refreshed = images();
  refreshed.detailMap.Downloads.photoInfo.photoList.unshift(image("/Download/d.png"));
  refreshed.sortCondition = 0;
  app.receive("image", refreshed);
  assert.deepEqual(paths(app, "image"), ["/Download/d.png", "/Download/c.png"]);
  assert.equal(app.payload("image").sortCondition, 0);
  app.dispatch({ type: "Initialize" });
  assert.equal(app.media.image.fullPayload, null);
  assert.equal(app.media.video.fullPayload, null);
  assert.equal(app.media.image.selectedFolders, null);
});

test("加载、删除对话框及图片全屏预览期间禁止切换文件夹", () => {
  for (const block of [
    { CommonData: { imageGalleryLoading: true } },
    { Dialog: { show: true } },
    { Dialog: { isDeleteing: true } },
    { DialogWithFunc: { show: true } },
    { Loading: { show: true } },
    { ImageFullScreen: { ImageFullScreenShow: true } },
  ]) {
    const app = setup();
    app.receive("image", images());
    const blocked = app.stateOf(block);
    const reducer = app.enhanceReducer((state) => state);
    assert.equal(reducer(blocked, {
      type: "LINPICIO_EASYSHARE_FOLDER", media: "image", folders: [],
    }), blocked);
    assert.equal(app.media.image.selectedFolders, null);
  }
});
