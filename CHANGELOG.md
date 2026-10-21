# Changelog

All notable changes to **Journal Partner** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.21.0] — 2026-10-07

### Added

- **随机回顾读书划线**：记录输入框左下角（标签按钮之后）新增书本图标，点一下从微信读书随机抽一条**自己划的线**插入输入框，连点换一条，`Ctrl/Cmd+点击`（macOS 上右键同效）从同一本书再抽。
  - 数据源走**微信读书官方 agent gateway**（API Key），不依赖 weread 插件的同步结果；用到 `/user/notebooks`、`/book/bookmarklist`、`/book/bestbookmarks` 三个接口。
  - **只抽自己的划线**，他人的热门划线永不插入；热门仅作加权信号（普通划线 1，既是自己的又热门的 `1 + quotePopularWeight`，默认 3）。
  - 去重按同章内**归一化文本前缀包含**匹配 —— 热门版常是截断版（实测同一条 46 字 vs 133 字），只比 `(chapterUid, range)` 会漏掉重复。
  - **选书会筛**：跳过划线少于 `quoteMinBookHighlights`（默认 10）的书，已读完（`markedStatus === 4`）的书权重 ×3。
  - 自动带上书名双链与作者，`{date}` / `{time}` 输出**划线时刻**；模板占位符 `{quote} {title} {author} {chapter} {date} {time} {link} {count}`，可空占位符连同其前分隔符一起清理。
  - 本地分片缓存 `<pluginDir>/cache/`（笔记本列表 24h、单本 7d TTL），命中缓存时**零网络请求**。
  - 新增设置：`wereadApiKey` / `quoteBoostPopular` / `quotePopularWeight` / `quoteMinBookHighlights` / `quoteSameBookReroll` / `quoteTag` / `quoteTemplate`。
- **习惯打卡**：时间线顶部固定一排习惯胶囊，点一下即可打卡。
  - **无独立状态存储**：习惯「今天完成」= 今天 `## Journal` 里存在一条已勾选且文本匹配该习惯的任务（`- [x] 07:12 #log/habit 早起`），因此编辑器里勾、时间线里勾、顶部栏勾三处天然一致。
  - 当天还没有节点时追加一条已完成任务；已有节点则**原地翻转 checkbox**，反复点击不堆叠重复节点。
  - 每个习惯独立配置名称、图标（弹出式网格选择器 —— 原生 `<select>` 的 `<option>` 无法承载 SVG）、打卡标签（归一化，非法值忽略）、可选 frontmatter 属性。
  - frontmatter 镜像由总开关控制，**默认关闭**；开启后写布尔 `true` / `false`，不写数字也不删键。
  - 编辑器打开今天的日记时，打卡会同时 dispatch 到 CodeMirror 缓冲，避免画面不同步。
  - 旧的全局 `habitTag` 设置会**迁移**到已有习惯，避免升级后新打卡丢标签。
  - 新增设置：`habits` / `habitMirrorFrontmatter`。
- 设计文档 `docs/superpowers/specs/2026-10-06-random-reading-quote-design.md`（含真实语料与 API 实测数据）。

### Fixed

- **日常时间线与收藏列表误用搜索文案「N 条匹配」**：`formatDateHeader()` 的副标题写死了 `timeline.matches`，而它实际只被**日常时间线**消费（搜索结果自己另写了一遍）—— 于是正常写日记的时间线也在显示「N 条匹配」，收藏列表同样。现抽出 `countLabel(count, variant)` 按列表性质区分：日常/收藏 = `N 条记录`，搜索/标签筛选 = `N 条匹配`。
- 英文单复数修正：`1 entry` / `N entries`（此前沿用 `match(es)` 的写法）。

### Changed

- `habitFrontmatterValue()` 内联 —— 值策略已确定为纯布尔，该包装不再承载任何决策。
- 移除无人使用的 i18n key `timeline.noResults`（搜索/标签筛选空态各有自己的 key）。
- `manifest.json` 描述补充两个新功能。

## [2.12.3] — 2026-08-17

### Changed

- **去掉 capture 视图顶部的滚动吸附**：输入卡片 + 时间线工具栏此前固定在滚动容器顶部（sticky），现改为随内容一起滚动。
- **回到顶部按钮位置**：桌面端保持贴近底部；移动端上移到导航栏之上，避免被遮挡（导航栏自动隐藏后按钮贴近底部）。

### Fixed

- **移动端底部导航栏自动隐藏失效**：CSS 选择器误用 `.mobile-toolbar`（Obsidian 移动端底栏真实类名是 `.mobile-navbar`），导致导航栏一直展示。已修正选择器，滚动时导航栏随方向隐藏/显示。
- **顶部 tab 与视图顶部的缝隙**：移除为 sticky 头部预留的 12px 顶部内边距（sticky 已去掉，不再需要）。

## [2.10.0] — 2026-08-06

### Added

- **时间戳颜色支持深色/白天主题独立配置**：颜色设置拆分为独立分组，每行包含白天与深色两个颜色选择器，主题切换时自动生效；每个颜色项提供「恢复默认」重置按钮。
  - 新增设置项 `timestampColorDark` / `timestampBgColorDark`（默认 `#a78bfa` / `#2e1065`）。
  - 颜色变量改为按主题注入样式表（`:root` 与 `.theme-dark`），替代原先的 `<html>` 内联变量，并清理旧内联值以保证迁移平滑。
- **侧边栏 bubble 右键编辑**：在时间线条目右键菜单新增「编辑」项，弹窗内可修改该条目正文（支持多行、保留录音链接），保存后写回当日日记文件，原列表标记与时间戳保持不变。
  - `⌘/Ctrl+Enter` 快速保存，空内容阻止保存。

### Changed

- `buildEntryLine` 新增可选 `marker` 参数，便于编辑时复用多行格式并保留原列表标记。
- 新增 `editEntryInSection` 工具函数，按 `lineIndex` 定位条目并替换其头行与续行。

## [2.9.0]

- Autocomplete 增强：支持 `[[` wiki-link 语法、`#` 标签触发修复与占位符优化。

## [2.8.0]

- 引入 obsidianmd eslint，CI 在每次 push / PR 时运行 lint；修复既有 lint 错误。

## [2.7.0]

- 时间线排序方式设置（最新在上 / 最早在上）。
