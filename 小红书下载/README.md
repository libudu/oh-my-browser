# 小红书下载 · 开发参考

## 范围与文件

`xiaohongshu-image-download.user.js` 是独立运行的 Tampermonkey 脚本，无构建步骤或运行时依赖。当前目录未包含 npm 配置和自动化测试工程。

现有功能：悬停笔记卡片显示下载按钮，点击顺序下载整篇笔记的详情图片；支持动态加载卡片、进度提示和当前页面会话内的失败重试。

## 必须保留的行为

- 下载详情页提供的图片文件，不使用列表封面或预览缩略图，不转码、不压缩；不保证是作者上传的相机原文件。
- 实况只下载静态图片，不读取或请求 `stream`、`video`、`masterUrl` 等视频字段；视频笔记直接提示不支持。
- 保留图片 URL 的签名、查询参数和处理后缀，仅将 HTTP 升级为 HTTPS。缺少详情图片地址时明确报错，不降级下载小图。
- 下载按钮不触发卡片跳转；动态插入的卡片不重复添加按钮，不破坏已有定位样式。

## 实现入口与数据流

1. `start` / `attachButtons`：匹配 `section.note-item`，通过 `MutationObserver` 监听新增卡片。
2. `cardLink`：读取笔记 ID，优先使用含 `xsec_token` 的链接，保留访问参数并转为 `/explore/{id}`。
3. `loadNote`：依次尝试 `unsafeWindow.__INITIAL_STATE__`、当前文档的初始状态脚本、携带当前登录会话请求的详情 HTML。
4. 详情数据位置：`state.note.noteDetailMap[id].note.imageList`，兼容部分下划线字段、Vue ref 和 Map 形式的详情映射。`readObjectLiteral` 仅解析 JSON 字面量、`undefined`、参数同样为字面量的 `new Map(...)` / `new Set(...)`，不使用 `eval` 或执行网页脚本；字符串内容保持不变。
5. `selectImages`：使用 `urlDefault` 或 `infoList` 中 `imageScene === 'WB_DFT'` 的地址。`openDetailImages` 在同一笔记详情已打开且轮播图片完整时，优先采用 DOM 实际图片地址，按轮播逻辑下标去重、排序。
6. `requestImage`：通过 `GM_xmlhttpRequest` 获取二进制，限制 CDN 地址并检查响应状态、重定向、MIME 和文件头。`detectImage` 识别 jpg/png/webp/gif/avif/heic，拒绝视频、HTML 和未知格式。
7. `saveBlob`：通过对象 URL 和 `GM_download` 保存，结束后释放 URL。`downloadCard` 控制全局单篇下载，成功项按笔记 ID 和图片下标记录；部分失败后只重试未成功项，全部成功后再次点击可重新下载。

文件名：`作者_标题_笔记ID_两位序号.实际格式`，由 `safeName` 清理非法字符。

## 修改后的验证

在本目录执行：

```sh
node --check xiaohongshu-image-download.user.js
```

浏览器回归重点：悬停显示和点击不跳转、滚动新增卡片、整篇图片顺序、实况无 MP4、失败重试、下载权限错误提示。修改解析逻辑时同时检查当前页面数据，站点字段和选择器可能变化。

已观察样例：「“痴人日记”1」（`6a522fc600000000210159df`）有 6 张实况图；列表封面后缀为 `nc_n_webp_mw_1`，详情静态图为 `nd_dft_*_webp_3`。这些是排查线索，不应硬编码成唯一详情格式。此前已核对页面数据，尚未完成油猴实际保存验证。

脚本底部保留 Node 环境的 `module.exports`，可用于补充离线测试。新增功能时保持脚本可独立安装，按需更新元数据版本及权限。
