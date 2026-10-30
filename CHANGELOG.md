# Changelog

All notable changes to **Journal Partner** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.23.0] — 2026-10-30

### Added

- **移动端自动弹出键盘**：在手机端打开（或切回）记录视图时，自动聚焦输入框并唤起系统键盘，无需再手点一次输入框。
  - 覆盖入口：图标 / 命令 / URL 协议 / 切回标签页，以及**应用从后台回到前台**和**冷启动布局就绪**（视图常驻后台时不会触发 onOpen，需要额外监听）。
  - 冷启动/前台唤醒时输入框可能尚未绘制，会在随后数秒内持续重试；用户一触摸即取消，绝不抢焦点。
  - 不会抢走搜索框、弹窗等其它输入框的焦点。
  - 新增设置项 `mobileAutoFocusInput`（默认开启），可在「移动端自动弹出键盘」中关闭。

## [2.22.1] — 2026-10-28

### Fixed

- **修复社区插件目录下架（无法在 Obsidian 内搜索安装）**：`manifest.json` 的 `description` 长度 271 字符，超过 Obsidian 自动审核的 250 字符上限（高风险项），导致 2.21.0 发布后插件被从社区目录移除、「Add to Obsidian」按钮置灰。现缩短为 217 字符。

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
