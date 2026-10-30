const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const script = require('./xiaohongshu-image-download.user.js');

const imageUrl = 'https://sns-webpic-qc.xhscdn.com/detail!nd_dft_webp_3';
const videoUrl = 'http://sns-video-v3.xhscdn.com/stream/1/110/258/note.mp4?sign=signature&t=expiry';
const backupUrl = 'http://sns-bak-v1.xhscdn.com/stream/1/110/258/note.mp4';
const mp4 = Buffer.from('000000206674797069736f6d0000020069736f6d69736f32617663316d703431', 'hex');
const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0);
const videoNote = () => ({
  type: 'video', title: '视频笔记',
  // 视频笔记也有封面，必须优先下载视频，不能误下载封面。
  imageList: [{ urlDefault: imageUrl }],
  video: { media: { stream: { EF4: [{
    width: 720, height: 1280, avgBitrate: 968319, format: 'mp4',
    masterUrl: videoUrl, backupUrls: [backupUrl],
  }], EF6: [] } } },
});

let storage;
beforeEach(() => {
  storage = new Map();
  global.GM_getValue = (key, fallback) => storage.has(key) ? storage.get(key) : fallback;
  global.GM_setValue = (key, value) => storage.set(key, value);
});
afterEach(() => {
  for (const key of ['GM_xmlhttpRequest', 'GM_download', 'unsafeWindow', 'document', 'location', 'fetch', 'GM_getValue', 'GM_setValue']) {
    delete global[key];
  }
});

function mockPage(note) {
  global.unsafeWindow = { __INITIAL_STATE__: { note: { noteDetailMap: { id: { note } } } } };
  global.document = { scripts: [], querySelector: () => null };
}

test('纯视频选择主视频及备用地址，保留签名并升级 HTTPS', () => {
  assert.deepEqual(script.selectVideo(videoNote()), {
    index: 0, urls: [videoUrl.replace('http:', 'https:'), backupUrl.replace('http:', 'https:')],
  });
  assert.equal(script.imageUrl(videoUrl), null);
});

test('选择最高分辨率的可下载 MP4，兼容下划线字段', () => {
  const note = videoNote();
  note.video.media.stream.EF5 = [
    { width: 2160, height: 3840, masterUrl: 'https://sns-video-v3.xhscdn.com/video.m3u8' },
    { width: 1080, height: 1920, master_url: backupUrl, backup_urls: [videoUrl] },
  ];
  assert.equal(script.selectVideo(note).urls[0], backupUrl.replace('http:', 'https:'));
  assert.throws(() => script.selectVideo({ type: 'video' }), /没有可下载/);
});

test('实况图只读取静态图字段，不触碰任何视频字段', async () => {
  const forbidden = () => { throw new Error('不应读取实况视频'); };
  const image = { urlDefault: imageUrl, livePhoto: true };
  for (const key of ['stream', 'video', 'masterUrl']) Object.defineProperty(image, key, { get: forbidden });
  const note = { type: 'normal', imageList: [image] };
  Object.defineProperty(note, 'video', { get: forbidden });
  assert.throws(() => script.selectVideo(note), /不是纯视频/);
  mockPage(note);
  const result = await script.loadNote('id', new URL('https://www.xiaohongshu.com/explore/id'));
  assert.equal(result.kind, 'image');
  assert.deepEqual(result.media, [{ index: 0, url: imageUrl }]);
});

test('视频有封面或没有 imageList 时都走视频分支，无需额外详情请求', async () => {
  for (const withCover of [true, false]) {
    const note = videoNote();
    if (!withCover) delete note.imageList;
    mockPage(note);
    global.fetch = () => assert.fail('已有完整视频数据，不应重新请求详情');
    const result = await script.loadNote('id', new URL('https://www.xiaohongshu.com/explore/id'));
    assert.equal(result.kind, 'video');
    assert.equal(result.media.length, 1);
    assert.equal(result.media[0].urls[0], videoUrl.replace('http:', 'https:'));
  }
});

test('视频缓存只有封面时继续解析文档，支持 SSR Map 详情结构', async () => {
  mockPage({ type: 'video', imageList: [{ urlDefault: imageUrl }] });
  document.scripts = [{ textContent: `window.__INITIAL_STATE__={"note":{"noteDetailMap":new Map([["id",{"note":${JSON.stringify(videoNote())}}]])}}` }];
  const result = await script.loadNote('id', new URL('https://www.xiaohongshu.com/explore/id'));
  assert.equal(result.kind, 'video');
});

test('拒绝外部站点、blob 和分段播放地址', async () => {
  for (const url of ['blob:https://www.xiaohongshu.com/id', 'https://xhscdn.com.evil.test/video.mp4',
    'https://example.com/video.mp4', 'https://sns-video-v3.xhscdn.com/video.m3u8']) {
    assert.equal(script.videoUrl(url), null);
    await assert.rejects(script.requestVideo(url), /已拦截/);
  }
});

test('识别 MP4，拒绝图片、HTML、截断文件及未知容器', () => {
  assert.deepEqual(script.detectVideo(mp4), { ext: 'mp4', mime: 'video/mp4' });
  const avif = Buffer.from(mp4);
  avif.write('avif', 8);
  for (const bytes of [jpeg, avif, Buffer.from('<html>verification</html>'), mp4.subarray(0, 10), Buffer.alloc(32)]) {
    assert.equal(script.detectVideo(bytes), null);
  }
  assert.equal(script.detectImage(mp4), null);
});

test('MP4 请求成功后返回视频 Blob；主地址失败自动尝试备用 CDN', async () => {
  const requests = [];
  global.GM_xmlhttpRequest = options => {
    requests.push(options.url);
    if (requests.length === 1) return options.onload({ status: 403 });
    options.onload({ status: 200, finalUrl: options.url, response: mp4 });
  };
  const { blob, ext } = await script.requestVideoWithFallback(script.selectVideo(videoNote()).urls);
  assert.equal(requests.length, 2);
  assert.equal(requests[1], backupUrl.replace('http:', 'https:'));
  assert.equal(ext, 'mp4');
  assert.equal(blob.type, 'video/mp4');
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), mp4);
});

test('视频请求拒绝图片、验证页面和站外重定向；图片请求继续拒绝 MP4', async () => {
  for (const response of [
    { response: jpeg }, { response: Buffer.from('<html>verification</html>') },
    { response: mp4, finalUrl: 'https://example.com/note.mp4' },
  ]) {
    global.GM_xmlhttpRequest = options => options.onload({ status: 200, ...response });
    await assert.rejects(script.requestVideo(videoUrl), /拒绝保存|重定向/);
  }
  global.GM_xmlhttpRequest = options => options.onload({ status: 200, response: mp4 });
  await assert.rejects(script.requestImage(imageUrl), /拒绝保存/);
});

test('点击视频卡片完成 MP4 保存并显示视频成功提示', async () => {
  const id = '6ad488f2000000002a00cef8';
  const note = videoNote();
  mockPage(note);
  unsafeWindow.__INITIAL_STATE__.note.noteDetailMap[id] = { note };
  const toast = { dataset: {}, remove() {}, setAttribute() {} };
  document.getElementById = () => toast;
  global.location = { href: 'https://www.xiaohongshu.com/user/profile/test', origin: 'https://www.xiaohongshu.com' };
  const card = {
    querySelectorAll: () => [{ href: `https://www.xiaohongshu.com/explore/${id}` }],
    getAttribute: () => id,
    querySelector: () => null,
  };
  const button = { dataset: {} };
  const saved = [];
  global.GM_xmlhttpRequest = options => options.onload({ status: 200, response: mp4 });
  global.GM_download = options => { saved.push(options); options.onload(); };
  await script.downloadCard(card, button);
  assert.equal(saved.length, 1);
  assert.match(saved[0].name, /_01\.mp4$/);
  assert.equal(button.textContent, '视频已下载');
  assert.equal(button.disabled, false);
  assert.equal(toast.textContent, '已保存视频');
  assert.equal(button.dataset.downloaded, 'true');
  assert.equal(script.isDownloaded(id), true);
  // 全部成功后再次点击允许重新保存。
  await script.downloadCard(card, button);
  assert.equal(saved.length, 2);
});

test('已下载标记在脚本重载后恢复，其他笔记不染黄', () => {
  const id = '6ad488f2000000002a00cef8';
  global.document = {};
  script.markDownloaded(id);
  const fs = require('node:fs'), vm = require('node:vm');
  const context = { module: { exports: {} }, GM_getValue: global.GM_getValue, GM_setValue: global.GM_setValue };
  vm.runInNewContext(fs.readFileSync(require.resolve('./xiaohongshu-image-download.user.js'), 'utf8'), context);
  const button = { dataset: {} };
  context.module.exports.syncDownloadMark(button, id, true);
  assert.equal(button.textContent, '✓ 已下载');
  assert.equal(button.dataset.downloaded, 'true');
  context.module.exports.syncDownloadMark(button, '6ad488f2000000002a00cef9', true);
  assert.equal(button.textContent, '↓ 下载');
  assert.equal(button.dataset.downloaded, 'false');
});
test('图集只保存一张、其余失败时也持久标记已下载', async () => {
  const id = '6ad488f2000000002a00c001';
  const note = { type: 'normal', imageList: [{ urlDefault: imageUrl }, { urlDefault: imageUrl + '?second=1' }] };
  mockPage(note);
  unsafeWindow.__INITIAL_STATE__.note.noteDetailMap[id] = { note };
  const toast = { dataset: {}, remove() {} };
  document.getElementById = () => toast;
  global.location = { href: 'https://www.xiaohongshu.com/', origin: 'https://www.xiaohongshu.com' };
  const card = { querySelectorAll: () => [{ href: `https://www.xiaohongshu.com/explore/${id}` }],
    getAttribute: () => id, querySelector: () => null };
  const button = { dataset: {} };
  global.GM_xmlhttpRequest = options => options.onload({ status: options.url.includes('second') ? 500 : 200, response: jpeg });
  global.GM_download = options => options.onload();
  const warn = console.warn; console.warn = () => {};
  try {
    await script.downloadCard(card, button);
    assert.equal(script.isDownloaded(id), true);
    assert.equal(button.dataset.downloaded, 'true');
    assert.equal(button.textContent, '已下载 1/2');
    assert.match(toast.textContent, /已保存 1\/2/);
  } finally { console.warn = warn; }
});

for (const firstSaved of [true, false]) {
  test(firstSaved ? '第一张落盘即持久标记，随后取消其他图片不清除' : '所有图片都取消时不标记已下载', async () => {
    const id = firstSaved ? '6ad488f2000000002a00c002' : '6ad488f2000000002a00c003';
    const note = { type: 'normal', imageList: [{ urlDefault: imageUrl }, { urlDefault: imageUrl + '?second=1' }] };
    mockPage(note);
    unsafeWindow.__INITIAL_STATE__.note.noteDetailMap[id] = { note };
    const toast = { dataset: {}, remove() {} };
    document.getElementById = () => toast;
    global.location = { href: 'https://www.xiaohongshu.com/', origin: 'https://www.xiaohongshu.com' };
    const card = { querySelectorAll: () => [{ href: `https://www.xiaohongshu.com/explore/${id}` }],
      getAttribute: () => id, querySelector: () => null };
    const button = { dataset: {} };
    global.GM_xmlhttpRequest = options => {
      if (options.url.includes('second')) {
        assert.equal(script.isDownloaded(id), firstSaved);
        assert.equal(button.dataset.downloaded, String(firstSaved));
      }
      options.onload({ status: 200, response: jpeg });
    };
    global.GM_download = options => {
      if (firstSaved && /_01\.jpg$/.test(options.name)) options.onload();
      else options.onerror({ error: 'user_canceled' });
    };
    const timeout = global.setTimeout, warn = console.warn;
    global.setTimeout = (...args) => timeout(...args).unref(); console.warn = () => {};
    try {
      await script.downloadCard(card, button);
      assert.equal(script.isDownloaded(id), firstSaved);
      assert.equal(button.dataset.downloaded, String(firstSaved));
      assert.equal(button.textContent, firstSaved ? '已下载 1/2' : '重试 0/2');
      assert.match(toast.textContent, firstSaved ? /已保存 1\/2/ : /已保存 0\/2/);
    } finally { global.setTimeout = timeout; console.warn = warn; }
  });
}
