# Changelog

All notable changes to **Journal Partner** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
