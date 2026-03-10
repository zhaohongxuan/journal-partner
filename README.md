# Journal Partner

一款陪你写日记的 Obsidian 插件。自动识别并高亮 Journal 区域的时间戳，让每一条记录的时间一目了然，同时防止意外修改。

![Obsidian plugin](https://img.shields.io/badge/Obsidian-Plugin-7c3aed?style=flat-square&logo=obsidian&logoColor=white)
![License](https://img.shields.io/github/license/zhaohongxuan/journal-partner?style=flat-square)

---

## 效果预览

在 `## Journal` 区域下，每行行首的 `HH:MM` 时间戳会被渲染为醒目的胶囊徽标：

```
## Journal

- 06:42 把我的工作笔记从 Obsidian 工作流中移出去
- 07:31 成功安装并配置了 OpenClaw！
- 08:10 多花点时间做自己的事情，跑步、读书、练字都行
```

↓ 渲染后时间戳高亮显示，颜色可自定义。

---

## 功能

- **时间戳高亮**：在编辑器（Source / Live Preview）和阅读视图中均生效
- **自定义颜色**：在设置中用拾色器分别设置文字色和背景色，改动实时生效
- **自定义作用范围**：指定目标标题名称（如 `Journal`）和层级（如 `##`），插件只在该区域内生效
- **时间戳只读**：开启后无法在编辑器中修改已有时间戳，防止误删或误改
- **自定义正则**：默认匹配 `HH:MM` 格式，可修改为任意正则表达式以适配其他时间格式

---

## 安装

### 手动安装

1. 前往 [Releases](https://github.com/zhaohongxuan/journal-partner/releases) 下载最新版本的 `main.js`、`manifest.json`、`styles.css`
2. 将三个文件复制到你的 Vault 的 `.obsidian/plugins/journal-partner/` 目录下
3. 在 Obsidian 设置 → 第三方插件 中启用 **Journal Partner**

---

## 设置说明

打开 Obsidian 设置 → 插件选项 → **Journal Partner**：

| 设置项 | 说明 | 默认值 |
|---|---|---|
| 目标标题名称 | 插件生效的标题文字（不含 `#`） | `Journal` |
| 标题层级 | 目标标题的层级 | `H2` |
| 文字颜色 | 时间戳徽标的前景色 | `#7c3aed` |
| 背景颜色 | 时间戳徽标的背景色 | `#ede9fe` |
| 时间戳只读 | 防止在编辑器中修改已有时间戳 | 开启 |
| 时间戳匹配正则 | 识别时间戳的正则表达式 | `\d{2}:\d{2}` |

---

## 开发

```bash
# 安装依赖
npm install

# 开发模式（保存自动重建）
npm run dev

# 生产构建
npm run build
```

构建产物为 `main.js`，与 `manifest.json`、`styles.css` 一起复制到插件目录即可。

---

## License

MIT
