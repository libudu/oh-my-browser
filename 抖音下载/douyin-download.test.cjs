'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const api = require('./douyin-download.user.js');
const ID = '7616399587141737704';
const videoUrl = 'https://v3.douyinvod.com/video/tos/test?signature=a%2Fb&x=1';
const imageUrl = 'https://p3.douyinpic.com/tos-cn-i/test~tplv.jpeg?sign=original';
const work = () => ({ aweme_id: ID, desc: '作品', video: { play_addr: { url_list: [videoUrl] }, cover: { url_list: [imageUrl] } } });
const ftyp = brand => {
  const result = Buffer.alloc(24);
  result.writeUInt32BE(24); result.write('ftyp', 4); result.write(brand, 8); result.write(brand, 16);
  return result;
};
let storage;
beforeEach(() => {
  storage = new Map();
  global.GM_getValue = (key, fallback) => storage.has(key) ? storage.get(key) : fallback;
  global.GM_setValue = (key, value) => storage.set(key, value);
});
afterEach(() => {
  delete global.GM_xmlhttpRequest; delete global.GM_download; delete global.document;
  delete global.unsafeWindow; delete global.getComputedStyle;
  delete global.GM_getValue; delete global.GM_setValue; delete global.location;
});

test('签名和图片处理后缀完整保留，拒绝伪造域名、blob、分片清单', () => {
  assert.equal(api.mediaUrl(videoUrl), videoUrl);
  assert.equal(api.mediaUrl(imageUrl), imageUrl);
  for (const url of ['blob:https://www.douyin.com/123', 'https://douyinpic.com.evil.com/a',
    'https://evil.com/a.mp4', 'javascript:alert(1)', 'https://v3.douyinvod.com/a.m3u8']) {
    assert.equal(api.mediaUrl(url), null);
  }
});
test('视频按清晰度和码率排序并保留备用地址，不下载封面', () => {
  const item = work();
  item.video.cover = { url_list: [imageUrl] };
  item.video.bit_rate = [
    { play_addr: { width: 720, height: 1280, url_list: [videoUrl + '&low=1'] }, bit_rate: 9999 },
    { play_addr: { width: 1080, height: 1920, url_list: [videoUrl + '&high=1', videoUrl + '&backup=1'] }, bit_rate: 100 },
  ];
  const result = api.selectMedia(item);
  assert.equal(result.kind, 'video');
  assert.equal(result.media[0].urls[0], videoUrl + '&high=1');
  assert.equal(result.media[0].urls[1], videoUrl + '&backup=1');
  assert.ok(!result.media[0].urls.includes(imageUrl));
});
test('兼容页面 camelCase 地址字段', () => {
  const item = { awemeId: ID, video: { playAddr: [{ src: videoUrl }] } };
  assert.equal(api.selectMedia(item).media[0].urls[0], videoUrl);
  item.video.playAddr = { urlList: [videoUrl] };
  assert.equal(api.selectMedia(item).media[0].urls[0], videoUrl);
  item.video.bitRateList = [{ playAddr: [{ src: videoUrl + '&high=1' }], width: 1080, height: 1920, bitrate: 3000 }];
  assert.equal(api.selectMedia(item).media[0].urls[0], videoUrl + '&high=1');
});
test('图集只读静态图，即便带顶层视频和实况也不会下载视频', () => {
  const item = { ...work(), aweme_type: 68, images: [
    { url_list: [imageUrl], video: { play_addr: { url_list: [videoUrl] } } },
    { displayImage: { urlList: [imageUrl + '&second=1'] } },
  ] };
  const result = api.selectMedia(item);
  assert.equal(result.kind, 'image');
  assert.equal(result.media.length, 2);
  assert.deepEqual(result.media[0].urls, [imageUrl]);
  assert.throws(() => api.selectMedia({ ...work(), aweme_type: 68, images: [] }), /图集/);
  assert.throws(() => api.selectMedia({ images: [{}] }), /第 1 张/);
});
test('只匹配完整字符串 ID，跳过不完整记录及其他作品，循环对象不会卡住', () => {
  const state = { short: { aweme_id: ID }, other: { ...work(), aweme_id: ID.slice(0, -1) + '5' },
    nested: { aweme_detail: work() } };
  state.self = state;
  Object.defineProperty(state, 'trap', { enumerable: true, get() { throw new Error('getter 不应执行'); } });
  assert.equal(api.findWork(state, ID), state.nested.aweme_detail);
  assert.equal(api.findWork(state, '1234567890'), null);
});
test('解析 URL 编码 RENDER_DATA 和带转义字符的 router JSON，不执行表达式', () => {
  const state = { loaderData: { item_list: [work()] }, text: '花括号 } 和引号 " 和斜杠 \\' };
  assert.deepEqual(api.jsonState(encodeURIComponent(JSON.stringify(state))), state);
  assert.deepEqual(api.jsonState('window._ROUTER_DATA = ' + JSON.stringify(state) + ';alert(1)'), state);
  assert.equal(api.jsonState('window._ROUTER_DATA = {"value": alert(1)};'), null);
  assert.equal(api.jsonState('window._ROUTER_DATA = {"value":'), null);
});
test('详情文档可查找目标作品，忽略无关脚本', () => {
  const doc = { querySelectorAll: () => [
    { id: '', type: '', textContent: 'throw new Error("不执行")' },
    { id: 'RENDER_DATA', type: '', textContent: encodeURIComponent(JSON.stringify({ detail: work() })) },
  ] };
  assert.equal(api.workFromDocument(doc, ID).aweme_id, ID);
});
test('从卡片链接或属性提取精确作品 ID', () => {
  const link = href => ({ getAttribute: () => href });
  const card = { matches: () => false, querySelectorAll: () => [link(`/note/${ID}`)], getAttribute: () => null };
  assert.deepEqual(api.cardInfo(card), { id: ID, url: `https://www.douyin.com/note/${ID}` });
  card.querySelectorAll = () => [link(`https://evil.com/video/${ID}`)];
  assert.throws(() => api.cardInfo(card), /作品 ID/);
  card.querySelectorAll = () => [link(`/?modal_id=${ID}`)];
  assert.equal(api.cardInfo(card).id, ID);
});
test('文件头校验区分视频、图片和验证页面', () => {
  assert.equal(api.detectMedia(ftyp('isom'), 'video').ext, 'mp4');
  assert.equal(api.detectMedia(ftyp('avif'), 'image').ext, 'avif');
  assert.equal(api.detectMedia(ftyp('avif'), 'video'), null);
  assert.equal(api.detectMedia(ftyp('isom'), 'image'), null);
  assert.equal(api.detectMedia(Buffer.from([255, 216, 255, 0]), 'image').ext, 'jpg');
  for (const input of [Buffer.from('<html>请验证</html>'), Buffer.alloc(0), Buffer.from([255, 216, 255])]) {
    assert.equal(api.detectMedia(input, 'video'), null);
  }
});
test('请求失败或返回验证 HTML 后使用备用地址，保留请求签名', async () => {
  const requests = [];
  global.GM_xmlhttpRequest = options => {
    requests.push(options.url);
    options.onload({ status: 200, response: requests.length === 1 ? Buffer.from('<html>验证</html>') : ftyp('isom') });
  };
  const result = await api.requestWithFallback([videoUrl, videoUrl + '&backup=1'], 'video');
  assert.equal(result.ext, 'mp4'); assert.equal(result.blob.size, 24);
  assert.deepEqual(requests, [videoUrl, videoUrl + '&backup=1']);
});
test('拒绝错误域名重定向和错误媒体格式', async () => {
  global.GM_xmlhttpRequest = options => options.onload({ status: 200,
    finalUrl: 'https://evil.com/file', response: ftyp('isom') });
  await assert.rejects(api.requestMedia(videoUrl, 'video'), /域名/);
  global.GM_xmlhttpRequest = options => options.onload({ status: 200, response: ftyp('isom') });
  await assert.rejects(api.requestMedia(imageUrl, 'image'), /有效图片/);
});
test('GM_download 保存真正媒体 Blob，权限失败可读', async () => {
  global.GM_download = options => {
    assert.ok(options.url.startsWith('blob:')); assert.equal(options.name, '作品.mp4'); options.onload();
  };
  await api.saveBlob(new Blob([ftyp('isom')]), '作品.mp4');
  global.GM_download = options => options.onerror({ error: 'not_permitted' });
  await assert.rejects(api.saveBlob(new Blob(['a']), '作品.jpg'), /权限/);
});
test('文件名清理 Windows 非法字符', () => {
  assert.equal(api.safeName('作品:/\\?*<>|". '), '作品_________');
  assert.equal(api.safeName(''), '抖音作品');
});

function pageFixture(item, linkless = false) {
  const makeNode = () => {
    const classes = new Set();
    return { dataset: {}, children: [], textContent: '', handlers: {},
      classList: { add: value => classes.add(value), contains: value => classes.has(value) },
      set className(value) { for (const cls of value.split(' ')) classes.add(cls); },
      setAttribute() {}, addEventListener(name, callback) { this.handlers[name] = callback; },
      append(node) { this.children.push(node); }, remove() {},
    };
  };
  const card = makeNode();
  card.getAttribute = () => null; card.matches = () => false;
  card.__reactProps$fixture = { awemeInfo: item };
  const link = { getAttribute: () => `/video/${card.__reactProps$fixture.awemeInfo.aweme_id}`,
    matches: () => true, closest: () => card, querySelector: () => ({}) };
  card.querySelectorAll = selector => selector === 'img, video' ? [cover] :
    !linkless && selector.startsWith('a[href') ? [link] : [];
  const cover = { tagName: 'IMG', src: imageUrl, parentElement: card, getAttribute: () => null };
  const toast = makeNode();
  global.document = { querySelectorAll: selector => selector === 'img, video' ? [cover] :
    !linkless && selector.startsWith('a[href') ? [link] : [],
    createElement: makeNode, body: makeNode(), getElementById: () => toast };
  global.unsafeWindow = { document: { querySelector: () => card,
    querySelectorAll: global.document.querySelectorAll, body: global.document.body } };
  global.getComputedStyle = () => ({ position: 'static' });
  return { card, cover, toast };
}

test('头像即便携带当前作品和已下载标记，也不能生成下载按钮', () => {
  const { card, cover } = pageFixture(work(), true);
  const avatarCard = { ...card, dataset: {}, children: [] };
  const avatar = { tagName: 'IMG', src: 'https://p3.douyinpic.com/aweme-avatar/author.jpeg',
    parentElement: avatarCard, getAttribute: () => null };
  avatarCard.querySelectorAll = selector => selector === 'img, video' ? [avatar] : [];
  const query = global.document.querySelectorAll;
  const withAvatar = selector => selector === 'img, video' ? [cover, avatar] : query(selector);
  global.document.querySelectorAll = withAvatar;
  global.unsafeWindow.document.querySelectorAll = withAvatar;
  api.markDownloaded(ID);
  assert.equal(api.singleReactWork(avatarCard).aweme_id, ID);
  api.attachButtons();
  assert.equal(avatarCard.children.length, 0);
  assert.equal(card.children.length, 1);
  assert.equal(card.children[0].dataset.downloaded, 'true');
});
test('头像语义和作者主页入口均被排除，普通作品封面仍可识别', () => {
  const { cover } = pageFixture(work(), true);
  assert.equal(api.isAvatarMedia(cover), false);
  assert.equal(api.isWorkCover(cover, work()), true);
  cover.src += '~tplv-webp.webp?signature=changed';
  assert.equal(api.isWorkCover(cover, work()), true);
  cover.getAttribute = attr => attr === 'alt' ? '用户头像' : null;
  assert.equal(api.isAvatarMedia(cover), true);
  cover.getAttribute = () => null;
  cover.parentElement = { tagName: 'A', getAttribute: attr => attr === 'href' ? '/user/author-id' : null };
  assert.equal(api.isAvatarMedia(cover), true);
  cover.parentElement.getAttribute = attr => attr === 'href' ? `/user/self?modal_id=${ID}` : null;
  assert.equal(api.isAvatarMedia(cover), false);
});
test('图集封面与视频 poster 可以识别，任意其他图片不能借作品 props 生成按钮', () => {
  const media = { tagName: 'IMG', src: imageUrl };
  assert.equal(api.isWorkCover(media, { images: [{ urlList: [imageUrl] }] }), true);
  assert.equal(api.isWorkCover({ tagName: 'VIDEO', poster: imageUrl }, work()), true);
  assert.equal(api.isWorkCover({ tagName: 'IMG', src: 'https://p3.douyinpic.com/author.jpeg' }, work()), false);
  assert.equal(api.isWorkCover(media, { aweme_id: ID }), false);
});
test('按钮位于单个卡片，重复扫描不重复添加，复用卡片后更新 ID，点击阻止跳转', async () => {
  const { card } = pageFixture(work());
  api.attachButtons(); api.attachButtons();
  assert.equal(card.children.length, 1);
  assert.equal(card.dataset.ombDouyinId, ID);
  assert.ok(card.classList.contains('omb-douyin-relative'));
  card.__reactProps$fixture.awemeInfo = { ...work(), aweme_id: '7616399587141737705' };
  card.children[0].textContent = '✓ 已下载';
  api.attachButtons();
  assert.equal(card.children.length, 1);
  assert.equal(card.dataset.ombDouyinId, '7616399587141737705');
  assert.equal(card.children[0].textContent, '↓ 下载');
  let stopped = false;
  card.children[0].handlers.pointerdown({ stopPropagation() { stopped = true; } });
  assert.ok(stopped);
});
test('TA的作品：没有 href/data ID 的封面卡片也添加按钮，复用后指向新作品', () => {
  const { card } = pageFixture(work(), true);
  api.attachButtons(); api.attachButtons();
  assert.equal(card.children.length, 1);
  assert.equal(card.dataset.ombDouyinId, ID);
  assert.equal(api.cardInfo(card).id, ID);
  assert.equal(api.workFromCard(card, ID).aweme_id, ID);
  const nextId = '7616399587141737706';
  card.__reactProps$fixture.awemeInfo = { ...work(), aweme_id: nextId };
  card.children[0].textContent = '✓ 已下载';
  api.attachButtons();
  assert.equal(card.children.length, 1);
  assert.equal(card.children[0].textContent, '↓ 下载');
  assert.equal(api.cardInfo(card).id, nextId);
  assert.equal(card.dataset.ombDouyinId, nextId);
  assert.equal(api.workFromCard(card, nextId).aweme_id, nextId);
});
test('TA的作品：通过 Fiber 自身 props 识别，不把整个作者列表或 Fiber 父级当作作品', () => {
  const node = { __reactFiber$fixture: { memoizedProps: { item: work() },
    return: { memoizedProps: { aweme_id: '7616399587141737705' } } } };
  assert.equal(api.singleReactWork(node).aweme_id, ID);
  node.__reactFiber$fixture.memoizedProps = {};
  assert.equal(api.singleReactWork(node), null);
  const list = { __reactProps$fixture: { items: [work(), { ...work(), aweme_id: '7616399587141737705' }] } };
  assert.equal(api.singleReactWork(list), null);
});
test('TA的作品：无链接视频卡片复用原有保存流程，点击阻止卡片播放跳转', async () => {
  const { card } = pageFixture(work(), true);
  api.attachButtons();
  const files = [];
  global.GM_xmlhttpRequest = options => options.onload({ status: 200, response: ftyp('isom') });
  global.GM_download = options => { files.push(options.name); options.onload(); };
  const originalTimeout = global.setTimeout;
  global.setTimeout = (...args) => originalTimeout(...args).unref();
  try {
    // 先确认 click handler 会取消默认跳转，再等待它触发的异步保存结束。
    let prevented = false, stopped = false;
    card.children[0].handlers.click({ preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(prevented && stopped);
    assert.equal(files.length, 1);
    assert.ok(files[0].includes(ID) && files[0].endsWith('.mp4'));
    assert.equal(card.children[0].textContent, '✓ 已下载');
    assert.equal(card.children[0].dataset.downloaded, 'true');
    assert.equal(api.isDownloaded(ID), true);
  } finally { global.setTimeout = originalTimeout; }
});
test('完整图集下载：部分失败后只补失败项，完成后再次点击重新下载全部', async () => {
  const item = { ...work(), aweme_type: 68, images: [{ url_list: [imageUrl] }, { url_list: [imageUrl + '&second=1'] }] };
  const { card, toast } = pageFixture(item);
  api.attachButtons();
  const button = card.children[0];
  const requests = [], files = [];
  let failSecond = true;
  global.GM_xmlhttpRequest = options => {
    requests.push(options.url);
    options.onload({ status: failSecond && options.url.includes('second') ? 500 : 200,
      response: Buffer.from([255, 216, 255, 0]) });
  };
  global.GM_download = options => { files.push(options.name); options.onload(); };
  // 提示计时器不延长测试进程生命周期。
  const originalTimeout = global.setTimeout;
  global.setTimeout = (...args) => originalTimeout(...args).unref();
  const originalWarn = console.warn; console.warn = () => {};
  try {
    await api.downloadCard(card, button);
    assert.equal(files.length, 1);
    assert.match(toast.textContent, /已保存 1\/2/);
    assert.equal(button.textContent, '✓ 已下载 1/2');
    assert.equal(api.isDownloaded(ID), true);
    assert.equal(button.dataset.downloaded, 'true');
    failSecond = false;
    await api.downloadCard(card, button);
    assert.equal(files.length, 2);
    assert.equal(requests.length, 3);
    assert.equal(requests[2], imageUrl + '&second=1');
    assert.equal(button.textContent, '✓ 已下载');
    assert.equal(button.disabled, false);
    assert.equal(api.isDownloaded(ID), true);
    assert.equal(button.dataset.downloaded, 'true');
    await api.downloadCard(card, button);
    assert.equal(files.length, 4);
    assert.ok(files.every(file => file.endsWith('.jpg') && file.includes(ID)));
  } finally { global.setTimeout = originalTimeout; console.warn = originalWarn; }
});

test('下载标记在脚本重新加载后恢复，复用为未下载作品时清除黄色', () => {
  const { card } = pageFixture(work(), true);
  api.attachButtons();
  api.markDownloaded(ID);
  api.attachButtons();
  assert.equal(card.children[0].dataset.downloaded, 'true');
  const fs = require('node:fs'), vm = require('node:vm');
  const context = { module: { exports: {} }, GM_getValue: global.GM_getValue, GM_setValue: global.GM_setValue };
  vm.runInNewContext(fs.readFileSync(require.resolve('./douyin-download.user.js'), 'utf8'), context);
  const restored = { dataset: {} };
  context.module.exports.syncDownloadMark(restored, ID, true);
  assert.equal(restored.dataset.downloaded, 'true');
  assert.equal(restored.textContent, '✓ 已下载');
  card.__reactProps$fixture.awemeInfo = { ...work(), aweme_id: '7616399587141737799' };
  api.attachButtons();
  assert.equal(card.children[0].dataset.downloaded, 'false');
  assert.equal(card.children[0].textContent, '↓ 下载');
});
test('TA的作品悬停显示，喜欢列表仍常显', () => {
  global.location = { pathname: '/user/self', href: 'https://www.douyin.com/user/self?showTab=like' };
  let fixture = pageFixture(work());
  api.attachButtons();
  assert.equal(fixture.card.dataset.ombDouyinHover, 'false');
  global.location.href += '&modal_id=' + ID;
  api.attachButtons();
  assert.equal(fixture.card.dataset.ombDouyinHover, 'true');
  fixture = pageFixture(work(), true);
  api.attachButtons();
  assert.equal(fixture.card.dataset.ombDouyinHover, 'true');
  global.location = { pathname: '/user/author', href: 'https://www.douyin.com/user/author' };
  fixture = pageFixture(work());
  api.attachButtons();
  assert.equal(fixture.card.dataset.ombDouyinHover, 'true');
});
test('标记按作品分别存储，不覆盖其他标签页记录；持久化失败明确报错', () => {
  global.document = {};
  api.markDownloaded(ID);
  const second = '7616399587141737798';
  api.markDownloaded(second);
  assert.ok(api.isDownloaded(ID) && api.isDownloaded(second));
  global.GM_setValue = () => { throw new Error('storage unavailable'); };
  assert.throws(() => api.markDownloaded('7616399587141737797'), /文件已保存.*未能持久保存/);
  assert.equal(api.isDownloaded('7616399587141737797'), false);
});

for (const firstSaved of [true, false]) {
  test(firstSaved ? '第一张保存后立即标黄，其余取消也保留标记' : '全部取消且没有保存成功时不标记', async () => {
    const id = firstSaved ? '7616399587141737781' : '7616399587141737782';
    const item = { ...work(), aweme_id: id, aweme_type: 68,
      images: [{ url_list: [imageUrl] }, { url_list: [imageUrl + '&second=1'] }] };
    const { card, toast } = pageFixture(item);
    api.attachButtons();
    const button = card.children[0];
    global.GM_xmlhttpRequest = options => {
      if (options.url.includes('second')) {
        assert.equal(api.isDownloaded(id), firstSaved);
        assert.equal(button.dataset.downloaded, String(firstSaved));
      }
      options.onload({ status: 200, response: Buffer.from([255, 216, 255, 0]) });
    };
    global.GM_download = options => {
      if (firstSaved && /_01\.jpg$/.test(options.name)) options.onload();
      else options.onerror({ error: 'user_canceled' });
    };
    const timeout = global.setTimeout, warn = console.warn;
    global.setTimeout = (...args) => timeout(...args).unref(); console.warn = () => {};
    try {
      await api.downloadCard(card, button);
      assert.equal(api.isDownloaded(id), firstSaved);
      assert.equal(button.dataset.downloaded, String(firstSaved));
      assert.equal(button.textContent, firstSaved ? '✓ 已下载 1/2' : '重试下载');
      assert.match(toast.textContent, firstSaved ? /已保存 1\/2/ : /已保存 0\/2/);
    } finally { global.setTimeout = timeout; console.warn = warn; }
  });
}
