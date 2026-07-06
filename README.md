# Journal Partner

一款陪你写日记的 Obsidian 插件。自动识别并高亮 Journal 区域的时间戳，让每一条记录的时间一目了然；配套一个**快速记录**侧边栏，让你随时把想法、图片、语音丢进今天的日记；并在同一个面板里集成**全量统计**，用热力图回顾一年的坚持。

![Obsidian plugin](https://img.shields.io/badge/Obsidian-Plugin-7c3aed?style=flat-square&logo=obsidian&logoColor=white)
![Version](https://img.shields.io/github/manifest-json/v/zhaohongxuan/journal-partner?style=flat-square&color=7c3aed&label=version)
![License](https://img.shields.io/github/license/zhaohongxuan/journal-partner?style=flat-square&color=7c3aed)

---
<img width="1672" height="941" alt="image" src="https://github.com/user-attachments/assets/4f4b8a8a-3942-4fcc-971e-d335ca5b2512" />


## 效果预览

在 `## Journal` 区域下，每行行首的 `HH:MM` 时间戳会被渲染为醒目的胶囊徽标：

```
## Journal

- 06:42 把我的工作笔记从 Obsidian 工作流中移出去
- 07:31 成功安装并配置了 OpenClaw！
- 08:10 多花点时间做自己的事情，跑步、读书、练字都行
```

↓ 渲染后时间戳高亮显示，颜色可自定义。

<img width="647" height="224" alt="image" src="https://github.com/user-attachments/assets/1ad2df5b-b918-46f5-822f-1fcee89bbf3c" />

---

## 功能

### ✍️ 时间戳与编辑增强

- **时间戳高亮**：在编辑器（Source / Live Preview）和阅读视图中均生效
- **自定义颜色**：在设置中用拾色器分别设置文字色和背景色，改动实时生效
- **自定义作用范围**：指定目标标题名称（如 `Journal`）和层级（如 `##`），插件只在该区域内生效
- **时间戳只读**：开启后无法在编辑器中修改已有时间戳，防止误删或误改
- **回车自动插入时间戳**：在 Journal 区块内按回车时，新行自动以当前 `HH:MM` 起头
- **Tab 缩进保留时间戳**：在条目首部按 Tab 时，时间戳与内容一起缩进，光标停在新位置
- **自定义正则**：默认匹配 `HH:MM` 格式，可修改为任意正则表达式以适配其他时间格式
- **圆形复选框**：可选地将 Journal 区域内的复选框渲染为圆形而非方形

### 🪶 快速记录侧边栏

打开「快速记录」侧边栏（羽毛笔图标或命令面板），即可在同一个面板里完成**速记**和**统计回顾**。顶部两个胶囊 Tab 居中切换：`记录` / `统计`。

#### 📝 记录 Tab

- **基于 Daily Notes**：自动写入今天日记的 `## Journal` 区段；若文件或区段不存在则自动创建（依赖 Obsidian 内置「Daily Notes」核心插件）
- **多行输入框**：支持系统语音输入法、回车换行；点击 NOTE 写入，自动保留 markdown 软换行结构
- **粘贴图片**：在输入框内直接 `⌘V` 粘贴剪贴板里的图片，插件自动保存到 Vault 附件目录并插入 `![](path)`；也支持把图片文件**拖拽**到输入框
- **图片按钮**：点击输入框下方的图片图标，从本地选择图片插入
- **麦克风录音**：一键录音，录音时实时显示对称胶囊波形 + 时长；停止后自动保存为附件（优先 `m4a`，不支持则 `webm`）并以 `![[audio.m4a]]` 嵌入，时间线上会渲染为可播放的音频条
- **实时语音转文字**：配置转写接口后，录音时**边说边出字**（VAD 在停顿处切句 + 跨段上下文，像语音输入法），停止时再用完整音频整段重转替换草稿，兼顾实时与准确。详见下方 [语音转文字](#️-语音转文字)
- **气泡时间线**：每条记录以「时间胶囊 + 内容气泡」呈现，带有平滑的连接弧线，颜色与时间戳样式同源
- **跨天无限滚动**：今天置顶；向下滚动自动加载更早有内容的日子，直到 365 天前为止
- **实时同步**：在主编辑器里改动当天日记，侧边栏对应日的时间线会就地刷新
- **Markdown 渲染**：支持双向链接、嵌入图片、加粗斜体等，所有原生 Obsidian 渲染特性均可用
- **日期栏排序按钮**：每个日期标题卡片的右上角都有排序切换按钮，按当日时间正序 / 倒序展示
- **右键管理 memo**：右键（或移动端长按）任意气泡，可复制原文、删除当前 memo；若该条 memo 附带录音，还会出现「删除 memo 和录音文件」与「仅删除录音文件」两个选项，录音走 Obsidian 回收站可恢复。可在设置中关闭「删除前确认」跳过对话框

<img width="1783" height="1166" alt="image" src="https://github.com/user-attachments/assets/78684cb8-c30b-449e-b348-914636021e23" />

#### 📊 统计 Tab

和记录 Tab 共享同一个侧边栏，点击「统计」胶囊即可切换。第一次打开会扫描所有 Daily Notes，之后改动日记会自动 300ms 防抖刷新。

- **全量 Hero**：顶部一张紧凑卡片展示**全部年份累计**的总字数（万位自动转换），副标题显示覆盖年份范围（如「2022–2026 年」）
- **4 项核心 KPI**：写作天数 / 总条数 / 录音数 / 最长连续，与 Hero 卡片内嵌显示，不再独立成卡
- **按年热力图**：每年一张 GitHub-style 热力图，7×53 网格、周一开头，5 档紫色浓度（按当日 memo 条数），鼠标悬停显示「YYYY年M月D日 · X 条 · Y 字」，点击非空格子在新 Tab 打开对应 Daily Note
- **兼容无时间戳日记**：用纯段落写的旧日记同样会被统计进字数 / 条数 / 写作天数 —— 不依赖 `- HH:MM` 格式
- **优雅降级**：没有时间戳时，「写作天数」仍能正确计数；「最常记录时段」类的指标仅在有时间戳的日记中显示

### 🔗 URL 协议（Action Button / Shortcuts 集成）

插件注册了 `obsidian://journal-partner` URL 协议，可以从任何能打开 URL 的地方（iOS Shortcuts、macOS Shortcuts、命令行 `open`）一键写入今天的日记，**无需打开 Obsidian 主界面**：

```
obsidian://journal-partner?text=<URL编码内容>
obsidian://journal-partner?text=<URL编码内容>&audio=<vault相对路径>
```

**参数：**

| 参数 | 必填 | 说明 |
|---|---|---|
| `text` | text/audio 至少一项 | 条目文字内容（URL 编码） |
| `audio` | text/audio 至少一项 | vault 内的音频附件相对路径，例如 `Assets/audio/2026-06-21_153012.m4a`，会以 `![[...]]` 嵌入，渲染成可播放的音频条 |
| `time` | 否 | `HH:MM` 格式，默认使用当前时间 |

**搭配 iPhone Action Button**：在 iOS Shortcuts 里创建一个捷径——
- 「听写文本」→「打开 URL」（仅文字）
- 「录音 → 听写文本 → 保存录音到 `Assets/audio/` → 打开 URL（text + audio 两个参数）」（文字 + 录音双轨）

把捷径设为 Action Button，按一下手机侧键就能听写并自动落到今天的日记，全程不打断当前操作。

> 💡 **一键导入**：插件设置面板提供了「获取捷径」按钮，或直接点这里 → [iCloud 捷径模板](https://www.icloud.com/shortcuts/2b5bbc7c721a4010807c4ed337245360)，添加到「快捷指令」app 即可使用。

---

## 安装

### 通过 BRAT 安装（推荐）

[BRAT](https://github.com/TfTHacker/obsidian42-brat)（Beta Reviewer's Auto-update Tool）能自动跟随本仓库的 release 升级，是目前推荐的安装方式：

1. 在 Obsidian 社区插件中搜索并安装 **BRAT**，启用它
2. 打开命令面板（⌘P）→ 执行 **BRAT: Add a beta plugin for testing**
3. 粘贴本仓库地址：`https://github.com/zhaohongxuan/journal-partner`
4. BRAT 会自动下载最新 release，并在 **设置 → 第三方插件** 中显示 **Journal Partner**，启用即可
5. （快速记录功能）确保 Obsidian 内置「Daily Notes」核心插件已启用

之后每次本仓库发布新版本，BRAT 都会在 Obsidian 启动时自动更新。

### 手动安装

1. 前往 [Releases](https://github.com/zhaohongxuan/journal-partner/releases) 下载最新版本的 `main.js`、`manifest.json`、`styles.css`
2. 将三个文件复制到你的 Vault 的 `.obsidian/plugins/journal-partner/` 目录下
3. 在 Obsidian 设置 → 第三方插件 中启用 **Journal Partner**
4. （快速记录功能）确保 Obsidian 内置「Daily Notes」核心插件已启用

---

## 使用快速记录

1. 点击左侧栏的羽毛笔图标，或在命令面板（⌘P）中执行 **「打开快速记录侧边栏」**
2. 默认进入「记录」Tab：在输入框中写下任何想法，按 NOTE 提交
3. 内容会以 `- HH:MM 文字` 的形式追加到今天日记的 `## Journal` 区段
4. 时间线顶端始终是今天，向下滚动可继续浏览历史日记
5. 切到「统计」Tab 查看全量累计 + 每年热力图

> 多行输入会被保存为带 markdown 软换行的列表项，渲染时保持段落结构。粘贴图片 / 录音后会自动保存到 Vault 附件目录（路径取自 Obsidian「附件文件夹」设置）。

---

## 🎙️ 语音转文字

在「快速记录」侧边栏点麦克风按钮开始录音，插件会在输入框上方显示实时波形与时长。配置好转写接口后，支持两种模式：

- **实时转写（默认开启）**：边说边出字。插件用 VAD（静音检测）在你说完一句话的停顿处切分音频，每段独立转写后追加到输入框；并把上一段末尾文本作为 `prompt` 喂给下一段，解决跨段同音词和断词问题。停止时再用完整音频做一次整段转写，替换掉实时拼出的草稿，得到既实时又准确的最终文本。
- **整段转写（关闭实时转写）**：录完整段后一次性转写，准确但无实时反馈。

转写完成后，文本与音频 embed（`![[audio.m4a]]`）会一起插入光标处。录音格式优先 `m4a`（`audio/mp4`），浏览器不支持时自动降级为 `webm`。

> 接口地址 / API Key 留空时，转写自动关闭，麦克风按钮仅作纯录音用。

---

## 设置说明

打开 Obsidian 设置 → 插件选项 → **Journal Partner**：

### 📍 作用范围

| 设置项 | 说明 | 默认值 |
|---|---|---|
| 目标标题名称 | 插件生效的标题文字（不含 `#`） | `Journal` |
| 标题层级 | 目标标题的层级 | `H2` |

### 🎨 时间戳样式

| 设置项 | 说明 | 默认值 |
|---|---|---|
| 文字颜色 | 时间戳徽标的前景色（同时影响时间线弧线、内容气泡底色） | `#7c3aed` |
| 背景颜色 | 时间戳徽标的背景色 | `#ede9fe` |

### ⚙️ 行为

| 设置项 | 说明 | 默认值 |
|---|---|---|
| 时间戳只读 | 防止在编辑器中修改已有时间戳 | 开启 |
| 回车自动插入时间戳 | 在 Journal 区块内按回车时自动插入当前时间 | 开启 |
| 圆形复选框 | 在日记区域内将 checkbox 渲染为圆形而非方形 | 关闭 |
| 删除前确认 | 右键删除 memo / 录音前弹出确认对话框 | 开启 |

### 🔧 高级

| 设置项 | 说明 | 默认值 |
|---|---|---|
| 时间戳匹配正则 | 识别时间戳的正则表达式 | `\d{2}:\d{2}` |

### 🎙️ 语音转文字

录音转文字使用 OpenAI 兼容的 `/audio/transcriptions` 接口，接口/Key 留空则关闭转写（仅保留纯录音）。

| 设置项 | 说明 | 默认值 |
|---|---|---|
| 转写接口地址 | OpenAI 兼容的音频转写地址，留空关闭转写 | 空 |
| API Key | 以 Bearer 形式发送的密钥 | 空 |
| 模型 | multipart 中的 `model` 字段 | `whisper-1` |
| 语言 | ISO-639-1 语言提示（如 `zh`、`en`），留空自动识别 | `zh` |
| 实时转写 | 录音时边说边出字，停止后整段重转替换草稿 | 开启 |

**国内推荐（免费、可直连）** —— 硅基流动 SiliconFlow 的 `FunAudioLLM/SenseVoiceSmall`：

```
转写接口地址: https://api.siliconflow.cn/v1/audio/transcriptions
模型:         FunAudioLLM/SenseVoiceSmall
语言:         zh
```

到 [siliconflow.cn](https://siliconflow.cn) 注册并实名后生成 API Key 填入即可，该模型常驻免费。也可填 OpenAI、Groq 或自建 faster-whisper 服务（OpenAI 兼容格式即可）。

---

## 开发

```bash
# 安装依赖
npm install

# 开发模式（保存自动重建）
npm run dev

# 生产构建
npm run build

# 部署到本地 Obsidian Vault（需在 deploy.sh 中配置 VAULT_PATH）
npm run deploy
```

构建产物为 `main.js`，与 `manifest.json`、`styles.css` 一起复制到插件目录即可。

---

## License

MIT
