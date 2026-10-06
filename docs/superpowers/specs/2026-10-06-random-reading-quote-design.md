# 输入框「随机读书划线」按钮 — 设计文档

**日期**：2026-10-06
**修订**：v2 — 数据源改为微信读书官方 API key + 本地持久化缓存
**状态**：Draft，待确认
**基线**：`origin/main` (2.20.1，已快进到本地)

---

## 实现状态（MVP 已落地）

分支 `feat/random-reading-quote`，已构建并部署到 vault（2.20.1 + 本功能）。

按"先最简单"的原则，落地时**砍掉了预热**（§3.4）与部分设置项；其余按本文档实现：

| 项 | 状态 |
| --- | --- |
| 输入框 tag 之后的书本按钮（`book-open`） | ✅ |
| 官方 API key + 按需分片缓存（内存 → 磁盘 7 天 TTL → 网络） | ✅ |
| 笔记本列表缓存（24h TTL，分页拉全 563 本） | ✅ |
| 热门划线（`/book/bestbookmarks` 全章节 top20 + 共读人数） | ✅ |
| 加权随机：我的 1 / 热门加权 4 | ✅ 实测热门加权项占 46% |
| **只抽自己的划线**（他人热门永不插入，热门仅作权重） | ✅ 按你的要求改为 §4 |
| 选书：过滤划线少的书 + 已读完优先 | ✅ 阈值 10 → 池子 277/563，已读完占 84.2% |
| 前缀包含去重 | ✅ 实测《谈谈方法》20 条热门中 **7 条**判定为重复（精确匹配只能抓 5 条） |
| 连点替换 / 手打不覆盖 | ✅ |
| **Ctrl/Cmd+点击 = 同一本书再抽一条** | ✅ 含 macOS Ctrl+点击陷阱处理，见 §5.1 |
| **回顾划线自动加标签**（`quoteTag`，替换默认标签） | ✅ 14 个归一化用例通过，见 §5.2 |
| 模板占位符 + 空值清理 | ✅（占位符 `{quote} {title} {author} {chapter} {date} {time} {link} {count}`） |
| 划线时间 `{date}` / `{time}`（来自 `createTime`，已进默认模板） | ✅ 我自己的划线 100% 有时间，不再有没时间的他人划线 |
| 设置面板（key / 两个开关 / 权重滑块 / 模板 / 清缓存） | ✅ |
| **预热（preheat）与进度 UI** | ❌ 砍掉，见 §3.4 |
| **我的想法 💭（`/review/list/mine`）** | ❌ 砍掉（每本多 1 次请求），P1 |
| 本地笔记兜底源（附录 A） | ❌ 未接线，方案保留 |

---

## 0. 已确认的产品决策

| # | 决策 | 来源 |
| --- | --- | --- |
| 1 | 按钮放在 `.jp-capture-button-row` 的 **tag 之后** | 你确认 |
| 2 | **包含热门划线**（他人划线），且**热门权重更高** | 你确认 |
| 3 | **必须做本地持久化缓存**，不能每次点都打接口 | 你确认 |
| 4 | 数据源：**微信读书官方 API key**，不依赖 weread 插件同步 | 你提出，已实测验证可行 |

---

## 1. 目标与非目标

### 目标

在输入框左下角加一个书本图标按钮：点一下，把一条随机划线（金句）填进输入框，自动带双链、作者等信息；连续点击换一条；按 NOTE 进今天日记。

1. 一次点击 = 一行可直接提交的文本（`[[书名双链]]` + 作者）。
2. 连点换一条；**不破坏**用户手打的内容。
3. 只读，绝不回写微信读书数据。
4. **缓存优先**：日常点击走本地缓存，不产生网络请求。

### 非目标

- 不复刻完整回顾面板 / 间隔重复（P2）
- 不做分享卡片
- 不写回 weread 笔记文件

---

## 2. 数据源：官方 API key（已实测）

### 2.1 网关

```
POST https://i.weread.qq.com/api/agent/gateway
Authorization: Bearer wrk-xxxxxxxx
Content-Type: application/json

{ "api_name": "/book/bookmarklist", "skill_version": "1.0.4", "bookId": "..." }
```

你自己已经配好的 key（`wereadApiKey`，`apiKeyValid: true`，在 weread 插件设置里）**实测可用**，所有接口调用成功。

`skill_version` 建议发 **1.0.4**（服务端会返回 `upgrade_info` 提示 1.0.3 已过时；weread 插件里写死了 1.0.3）。

### 2.2 本功能需要的 4 个接口（逐条实测）

| 接口 | 参数 | 实测返回 | 用途 |
| --- | --- | --- | --- |
| `/user/notebooks` | `count:300, lastSort` | **563 本**有笔记的书、`totalNoteCount: 17626`、分 2 页（300/页）；`books[].book` 里直接含 `title` / `author` / `cover` | 随机选书的池子；书名作者不用再调 `/book/info` |
| `/book/bookmarklist` | `bookId` | **我的全部划线，不分页**（《The Science and Art of Longevity》一次返回 769 条）；字段 `markText` `chapterUid` `range` `bookmarkId` `createTime`；同响应带 `chapters[].title` 章节名和 `synckey` | 我的划线 + 章节名 |
| `/book/bestbookmarks` | `bookId, chapterUid:0` | `chapterUid=0` = **全章节**，按热度排序返回 **top 20**，每条带 `totalCount`（共读人数，实测 1020/864/736…），书内热门总数 `totalCount: 379` | 热门划线 + **权重来源** |
| `/review/list/mine` | `bookid, count` | 我的想法，`review.abstract`（对应划线）+ `review.content`（我写的） | 可选：附上我的 💭 |

实测样例：`/book/bestbookmarks` 返回首条 `「那些始终遵循正道的人，即使走慢一些，也会比那些跑步前行却偏离正道的人走得更远。」1020 人`。

### 2.3 为什么 API 比解析本地笔记更好

| 维度 | 官方 API | 本地 weread 笔记（v1 设计） |
| --- | --- | --- |
| 解析成本 | 结构化 JSON | 573 篇 markdown，**11 种格式变体**（含 `# 高亮划线 🔥`、322 篇无 `title`、10 篇 title≠文件名、同名文件…） |
| 热门划线 | **书级 top20 + 共读人数**，1 次调用 | 依赖插件开 `syncPopularHighlightsToggle`；是"每章 20 条"的混合，无书级热度排序 |
| 书名 / 作者 / 章节 | JSON 直接给 | 要回退文件名、处理别名 |
| 新鲜度 | 请求即最新 | 依赖插件同步 |
| 离线 | ❌ | ✅ |
| 配额 | 有（未公开额度） | 无 |

→ **主数据源用 API；本地笔记解析退化为可选兜底**（附录 A，解析器已写完并实测 99.97% 覆盖）。

### 2.4 实测得到的两个坑

1. **热门与我自己的划线会重复，且文本是前缀包含关系**：
   同一条划线，热门版本 `range 2415-2461`（46 字，截断），我的版本 `range 2415-2548`（133 字）。
   → 去重**不能只比 `(chapterUid, range)` 精确相等**，要按 `chapterUid` 分组后做**归一化文本的前缀/包含匹配**（《谈谈方法》实测：精确匹配 5 条重叠，包含匹配后覆盖同一批）。
2. **有些书没有热门数据**：《The Science and Art of Longevity》`/book/bestbookmarks` 返回 `items: []`、`totalCount: null`（英文书）。必须优雅降级为"只用我的划线"。

### 2.5 调用成本

| 场景 | 调用数 |
| --- | --- |
| 冷启动全量预热（563 本 × 2） | ≈ **1126 次** |
| 增量刷新（带 `synckey`） | 每本 1 次，且只回传变更 |
| **命中缓存的日常点击** | **0 次** |
| 缓存未命中的单次点击 | 2 次（该书划线 + 热门） |

---

## 3. 缓存设计（本功能的核心）

原则：**点击路径默认零网络**；网络只在后台预热/刷新时发生。

### 3.1 存储位置与结构

用 `app.vault.adapter` 写到插件自己的目录（`this.manifest.dir`），**不进 vault 文件索引、不进 data.json**（settings 会被频繁 `saveSettings()` 重写，塞 5MB 数据是灾难）：

```
.obsidian/plugins/journal-partner/cache/
├── index.json              # 笔记本列表 + 每本元数据（≈100KB）
└── books/
    ├── 3300105328.json     # 单本划线 + 热门 + synckey（≈5-30KB）
    └── ...                 # 563 个分片
```

- 采用**按书分片**而非单一大文件：预热时要写 563 次，单大文件会反复重写数 MB；分片每次只写 5–30KB。总占用实测预估 **4–6 MB**。
- 参考实现：weread 插件就用同样手法写 `.weread-cache/popular-{bookId}.json`（`vault.adapter`，桌面/移动端都可用）。

```ts
interface QuoteCacheIndex {
  version: 1;
  fetchedAt: number;
  books: { bookId: string; title: string; author: string; cover?: string; noteCount: number; lastSort?: number }[];
}
interface QuoteCacheBook {
  version: 1;
  bookId: string;
  fetchedAt: number;
  synckey: number;           // /book/bookmarklist 的增量游标
  popularSynckey: number;    // /book/bestbookmarks 的增量游标
  highlights: { bookmarkId: string; markText: string; chapterUid: number; range: string; createTime: number }[];
  popular: { bookmarkId: string; markText: string; chapterUid: number; range: string; totalCount: number }[];
  thoughts?: { reviewId: string; abstract: string; content: string; createTime: number }[];
  chapters: { chapterUid: number; title: string }[];
}
```

### 3.2 三层读取

```
点击 → 内存 Map<bookId, QuoteCacheBook>
     → 未命中：读磁盘分片（cache/books/<id>.json）
     → 仍未命中：视为"未预热"，走后台补拉（本次点击先用同书请求兜底或换一本已缓存的书）
```

### 3.3 新鲜度策略

| 数据 | TTL | 刷新方式 |
| --- | --- | --- |
| 笔记本列表 `index.json` | 24 h | 后台刷新（2 次请求） |
| 单本划线 / 热门 | **7 天**（可配，对齐 weread 插件 `popularHighlightsCacheTtl` 默认 7） | 带 `synckey` 增量：`updated` 合并、`removed` 删除 |
| 我的想法 | 7 天 | 首次抽中该书时懒加载 1 次 |

- **stale-while-revalidate**：命中缓存立即返回，过期只在后台静默刷新，不阻塞点击。
- `synckey` 是这套缓存能便宜刷新的关键——增量请求只回传变化项。
- 设置面板提供「立即刷新」「清空缓存」和缓存状态（已缓存 N/563 本、占用大小、最近预热时间）。

### 3.4 预热（Preheat）

问题：563 本书随机抽，如果按需拉取，**每次点击都命中不了缓存**（每本只抽到一次）。所以必须有预热。

| 方案 | 说明 | 取舍 |
| --- | --- | --- |
| A. 首次点击触发后台全量预热 | 并发 3，563 本 × 2 ≈ 1126 次请求，约 1–2 分钟；点击立即可用（首批 20 本优先） | **采用**，默认开 |
| B. 每次点击顺带补拉 3 本 | 缓存缓慢增长，配额友好 | 作为 A 的降级（配额报错时切换） |
| C. 纯按需 | 每点 2 次请求 | 不满足"不要每次都请求接口" |

- 预热**优先级**：`noteCount` 多的书优先（抽中概率高、内容更丰富）。
- **配额/失败保护**：`errcode !== 0` 或 HTTP 失败 → 指数退避（1s→2s→4s→…上限 60s），连续 5 次失败暂停预热并 Notice；预热可随时中断，进度落盘可续。
- 预热**不阻塞 UI**：状态显示在按钮 title / 设置面板。

### 3.5 内存层

`Map<bookId, QuoteCacheBook>`，上限 200 本 LRU（避免常驻 5MB）。抽签池只依赖 `index`（轻量）与内存层。

---

## 4. 随机策略与权重

**只抽自己的划线**（他人热门划线永不插入），两步随机：

```
1. 选书：先按 quoteMinBookHighlights 过滤掉划线很少的书，再按「已读完 ×3」加权随机
2. 选句：在「我的划线」集合上加权随机（热门只作为权重信号）
```

### 选书规则（实测数据定标）

实测 563 本有笔记的书：noteCount 中位数 9、p25 = 2；`markedStatus === 4`（读完）208 本，且与 `progress >= 100` 完全等价 —— 所以"已完成"就取 `markedStatus === 4`。

| `quoteMinBookHighlights` | 池子大小 | 池内已读完 |
| --- | --- | --- |
| 0 | 563 | 208 |
| 5 | 356 | 196 |
| **10（默认）** | **277** | **177** |
| 20 | 209 | 161 |

- 过滤后池内已读完占 **63.9%**，再乘 `FINISHED_BOOK_BOOST = 3` → 预期抽中已读完的占 **84.2%**（20 万次蒙特卡洛实测 84.2%）。
- 阈值会把池子清空时自动回退到全量，不会抽不出东西。
- `noteCount` 直接来自 `/user/notebooks`，**过滤小书不额外花请求**。

### 权重（句中）

| 类别 | 权重 |
| --- | --- |
| 我的普通划线 | `1` |
| 我的划线 **且**是热门划线 | `1 + quotePopularWeight`（默认 **3** → 权重 4） |

- 《谈谈方法》实测：40 条候选 = 33 条普通（权重 1）+ 7 条热门加权（权重 4），权重和 **61**，热门加权项占 28/61 ≈ 46%。
- 关闭 `quoteBoostPopular` 后全部权重回到 1。
- 可选（P1）：按共读人数细分权重 `quotePopularWeight × (1 + log10(人数))`。

### 去重（必须处理前缀包含）

热门数据只用来给"我的划线"打加权标记，配对时要处理截断差异：

```
同一 chapterUid 下 → 归一化文本（去空白）
  → 热门文本是我方文本的子串（或反之）即视为同一条
  → 该条我的划线获得加权；文本取较长的一方（热门常为截断版）
```

实测《谈谈方法》：热门 20 条中 **7 条**与我重复 —— 按 `(chapterUid, range)` 精确匹配只能抓到 5 条，前缀包含匹配多抓 2 条。

### 防重复

进程内 ring buffer 记录最近 30 条的 key（`bookId:chapterUid:range`），命中就重摇（最多 8 本，且同一轮不重复试同一本）。

---

## 5. 交互与插入

### 按钮

- 位置：`.jp-capture-button-row` 内 **tag 之后**（你指定）。
- 图标：lucide `book-open`；`aria-label` = `capture.randomQuote` → `随机引用一条划线`。
- CSS：把 `.jp-capture-quote-btn` 加进已有两条共享选择器列表（`styles.css` 460–465 基础态 / 484–490 hover 态），无需新样式。

### 点击行为

| 输入框状态 | 行为 |
| --- | --- |
| 自上次插入后用户**没改过** | **替换**上次插入那一段 → 连点即"再抽一张" |
| 用户改过 / 首次点 | 光标处插入（无焦点则追加末尾），**绝不覆盖**手打内容 |

插入后：textarea 聚焦、光标落到末尾、`refreshSubmitState()` + `autoResizeTextarea()`。抽签期间按钮加 `is-loading` 防重入。

### 5.1 Ctrl/Cmd+点击 = 同一本书再抽一条

抽到一本喜欢的书、想顺着多看几条时，按住 **Ctrl 或 Cmd** 点击书本图标 → 从**上次那本书**里再抽一条（`pickRandomQuote(..., { bookId })`）。首次点击没有"上次的书"，自动退化为普通随机。

**macOS 上的坑（必须处理）**：macOS 把 Ctrl+点击当作右键，浏览器**不会派发 `click` 事件**，只派发 `contextmenu`。如果只监听 `click`，用户按 Ctrl 点击将毫无反应。所以：

- `click` 且 `ctrlKey || metaKey` → 同书再抽
- `contextmenu` → `preventDefault()` 后同样触发同书再抽（该按钮没有自己的右键菜单，劫持无副作用）
- 两种事件在部分平台可能**都**派发 → 用 300ms 去重戳 + `quoteBusy` 双重防抖，避免一次手势抽两条

设置项 `quoteSameBookReroll`（默认开）可整体关闭该手势；关闭后右键也不再被拦截。按钮 tooltip 会随设置变化（每次点击时刷新）。

**行为细节**：同书模式**绕过** `quoteMinBookHighlights` 池过滤（这本书已经被选中过一次，用户是明确点名要它），但仍走长度过滤与去重；该书抽空了则提示 `quote.sameBookEmpty`。

**实测**（打桩 requestUrl + vault adapter 的集成测试）：同书再抽命中内存缓存时 **0 次网络请求**；未缓存时 1 本书 2 次请求。

### 5.2 回顾划线自动加标签

设置 `quoteTag`（例如 `#log/reading`）后，**每次成功抽到划线就把该标签勾选到 chip 行**（输入框左上角），提交时由 `handleSubmit` 前置到条目里 —— 与手动点选标签走完全相同的那条路径。

- 归一化函数 `normalizeTag()`（`section.ts`）：`log/reading` / `#log/reading` / `  #log/reading  ` / `##log/reading` 都得到 `#log/reading`；含空格、`,`、第二个 `#` 等非法输入返回 `''`（静默不加），14 个用例全部通过。
- **用 chip 而不是写进文本**：连点换一条时不会重复堆叠标签；标签在输入框上方可见，符合"看起来更好看"。
- 提交成功后 `resetSelectedTags()` 恢复默认标签。
- 默认值 `''`：插件不应该替所有用户自动打标签。

**与 `defaultTags` 的关系：替换（不是叠加）**。`applyQuoteTag()` 直接把 `selectedTags` 置为 `[quoteTag]`，所以默认标签（如 `#log/thinking`）不会跟回顾条目混在一起：

```markdown
# 叠加（已弃用）        - 08:12 #log/thinking #log/reading “…” —— 作者《[[书]]》 2020-03-21
# 替换（当前行为）      - 08:12 #log/reading “…” —— 作者《[[书]]》 2020-03-21
```

副作用：抽签前手动勾选的其他标签也会被替换掉（抽签后可以再点回来）。

### 插入文本

默认模板（单行，最终成为 `- 07:20 <text>`）：

```markdown
- 07:20 “为什么我们记得过去，而非未来？” —— 卡洛·罗韦利《[[时间的秩序]]》
```

带我的 💭 时追加一行（续行缩进由 `buildEntryLine()` 处理）：

```markdown
- 07:20 “……” —— 作者《[[书名]]》  
  💭 我是谁？我在哪？我要去哪？
```

双链解析（重名与 title≠文件名都覆盖）：

```ts
function resolveLink(app: App, file: TFile, display: string): string {
  const safe = display.replace(/[|\]\[\]]/g, '').trim() || file.basename;
  const dest = app.metadataCache.getFirstLinkpathDest(file.basename, '');
  if (dest && dest.path !== file.path) return `[[${file.path}|${safe}]]`;
  if (safe !== file.basename) return `[[${file.basename}|${safe}]]`;
  return `[[${file.basename}]]`;
}
```

⚠️ 走 API 时书只有 `bookId`，**没有 vault 路径**。链接解析顺序：
1. 用 `metadataCache` 扫 `doc_type: weread-highlights-reviews` 的笔记，按 frontmatter `bookId` 建 `bookId → TFile` 映射（这一步复用附录 A 的发现逻辑，只读 frontmatter，极快）；
2. 命中 → 按上面的 `resolveLink` 生成双链；
3. 未命中（书没同步到本地）→ 降级为纯文本 `《书名》`，避免脏链接。

---

## 6. 代码结构

| 文件 | 改动 | 说明 |
| --- | --- | --- |
| `src/weread-api.ts` | **新增** ≈120 行 | 网关客户端：`callAgent()`、`getNotebooks()`、`getBookmarks()`、`getBestBookmarks()`、`getMyThoughts()`；错误归一化、并发限流、退避 |
| `src/quote-cache.ts` | **新增** ≈200 行 | 分片读写、内存 LRU、TTL 判定、`synckey` 增量合并、预热调度、状态统计 |
| `src/quotes.ts` | **新增** ≈150 行 | 类型、去重（前缀包含）、候选构造、加权随机、模板渲染、`resolveLink` |
| `src/capture-view.ts` | 小改 | `buildInputCard()` 加按钮；`insertRandomQuote()` / `insertIntoTextarea()`；`lastQuoteRange` 状态 |
| `src/section.ts` | 小改 | `JournalPartnerSettings` 新增字段 + `DEFAULT_SETTINGS` |
| `src/i18n.ts` | 小改 | EN / ZH 各约 12 个 key |
| `src/main.ts` | 小改 | 命令 `insert-random-quote`；设置面板「读书划线」分区；`onunload` 停止预热 |
| `styles.css` | 小改 | 把新按钮类加进两条共享选择器列表 |

---

## 7. 设置项

| key | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `wereadApiKey` | string | `''` | 官方 API key（`wrk-…`），密码框显示、UI 打码、**不写日志** |
| `quoteBoostPopular` | boolean | `true` | 我的划线与热门重合时加权（**不等于**插入他人划线） |
| `quotePopularWeight` | number | `3` | 热门加权值（普通=1，热门=1+该值=4），滑块 0–10 |
| `quoteMinBookHighlights` | number | `10` | 划线数少于该值的书不参与抽取，滑块 0–50 |
| `quoteSameBookReroll` | boolean | `true` | Ctrl/Cmd+点击（macOS 上右键同效）从上次那本书再抽 |
| `quoteTag` | string | `''` | 抽到划线时自动勾选的标签，如 `#log/reading`；空 = 不加 |
| `quoteTemplate` | string | `“{quote}” —— {author}《{link}》 {date}` | 主模板 |
| `quoteSource` | `'api' \| 'local-notes'` | `'api'` | 未落地（附录 A） |
| `quoteFetchThoughts` / `quoteCacheTtlDays` / `quotePreheat*` / `quoteOnlyWithThought` / `quoteMinLength` / `quoteMaxLength` / `quoteThoughtTemplate` / `quoteAvoidRecent` | — | — | **未落地**，见上方"实现状态"；`FINISHED_BOOK_BOOST=3`、防重复 30、长度 8–200 目前是源码常量 |

**占位符**（落地版）：`{quote}` `{title}` `{author}` `{chapter}` `{date}` `{time}` `{link}` `{count}`（共读人数）
**空值清理**：可空占位符（`{author}` `{chapter}` `{date}` `{time}` `{count}`）为空时，连同**它前面的分隔符**一起删除，所以模板可以无条件书写 —— `… 《{link}》 · {date}` 在无日期时不会留下 ` · `；`{date}`/`{time}` 取 `/book/bookmarklist` 的 `createTime`（划线时刻），他人的纯热门划线没有该字段。

> 未落地：`quoteThoughtTemplate`、`quoteAvoidRecent`（防重复已内置为常量 30）、缓存状态 UI。

设置面板另加：缓存状态（已缓存 N/563、占用、最近预热时间）、「立即预热」「清空缓存」。

---

## 8. 边界与错误

| 场景 | 行为 |
| --- | --- |
| 未配置 key | 按钮点击 → Notice 引导去设置；若 `quoteSource='local-notes'` 则走本地 |
| key 失效（`errcode` 401/无效） | Notice 提示重新获取；暂停预热；不影响已缓存数据 |
| 配额耗尽 / 限流 | 指数退避 + 暂停预热，切到"按需补拉"模式；全量走缓存 |
| 该书无热门数据（英文书实测） | 降级为只用我的划线，不报错 |
| 该书无任何划线 | 重新随机另一本 |
| 全部候选被过滤空 | Notice `quote.none` |
| 离线 / 磁盘写失败 | 内存缓存继续工作，点击仍可用 |
| 书名未同步到本地 vault | 双链降级为纯文本《书名》 |
| 插入含换行 | 只可能来自自定义模板；`buildEntryLine()` 会做续行缩进 |

---

## 9. 测试计划

1. **权重与去重单元测试**（纯函数，最该测）：
   - 前缀包含去重：《谈谈方法》`2415-2461` vs `2415-2548` 必须合并为 1 条
   - 加权随机分布：权重 1/3/4 的抽样频率在 10 万次内落在 ±1% 区间
2. **缓存**：
   - 冷启动预热 → 563 分片落盘 → 断网后点击仍可用
   - 二次预热带 `synckey`，请求数应显著小于首次
   - TTL 过期触发后台刷新但不阻塞点击
   - 写盘失败降级为内存
3. **交互**：空框抽签 / 有字抽签（不覆盖）/ 连点两次（替换）/ 抽完直接 NOTE 写入 / 改字后再抽（追加）/ NOTE 清空后再抽
4. **双链**：`务虚笔记`（重名）→ 全路径；`刘擎西方现代思想讲义-3003669677`（title≠文件名）→ 别名；未同步书 → 纯文本
5. **i18n**：en / zh 无 missing key
6. **构建**：`npm run build` + `npm run lint`
7. **真机**：`npm run deploy` 后重载插件，确认按钮位置/图标/hover 与其它四个一致

---

## 10. 分期

| 阶段 | 内容 |
| --- | --- |
| **P0** | 按钮 + API 客户端 + 分片缓存 + 预热 + 加权随机（含热门）+ 去重 + 模板 + i18n + 测试 |
| P1 | 本地笔记作为免费预热源（附录 A）；`log10(人数)` 细分权重；Cmd+点击 = 同书再抽 |
| P2 | 完整回顾面板（按书 / 只看想法 / 每日 N 条），直接复用 `quotes.ts` + 缓存 |

---

## 附录 A：本地笔记兜底方案（`quoteSource: 'local-notes'`）

当没有 key、离线、或想省配额时，改用 weread 插件同步的 markdown。**解析器已完成并在你的 vault 上实测通过：22 170 / 22 176 = 99.97% 覆盖率**（573 篇笔记、16 551 条我的划线、398 条带我的想法）。

必须兼容的格式变体（全部来自真实文件实测）：

| # | 变体 | 实测 | 处理 |
| --- | --- | --- | --- |
| 1 | 区块标题带后缀 `# 高亮划线 🔥` | 42 篇 | 区块正则用 `^#\s*高亮划线`（用 `^# 高亮划线$` 会整篇解析为 0） |
| 2 | 老笔记 frontmatter 无 `title` | 322 / 573 | 书名回退文件名 |
| 3 | `title` ≠ 文件名 | 10 篇 | 链接目标用文件名、显示名用 title |
| 4 | 同名文件 | `务虚笔记` 在 `文学/` 与 `精品小说/` 各一份 | `getFirstLinkpathDest()` 校验，冲突用全路径 |
| 5 | 💭 两种写法 | `- 💭 x - ⏱ date`（354）/ `> 💭 x`（69） | 统一正则 |
| 6 | 划线正文跨行 | 常见 | 合并续行 + 压缩空白 |
| 7 | `📌🔥`（我的+热门）/ `🔥`（纯他人） | 820 / 5 601 | 按 marker 分类，`🔥 N 人共读` 取人数做权重 |
| 8 | 零划线笔记（公众号） | 30 篇 | 抽到就重摇 |
| 9 | 极短 / 极长划线 | <12 字 702 条；>200 字 638 条 | 长度过滤 8–200 |
| 10 | 正文含 `[text](<weread://…>)` | 2 046 条 | 剥链接外衣，保留 deeplink |
| 11 | 正文里 `# <书名>` 一级标题 | 42 篇 | 区块结束条件不能是"下一个 `#` 标题" |

解析算法要点：区块 = `^#\s*高亮划线` → `^#\s*(读书笔记|本书评论)`；块起点 `/^>\s*(📌🔥|📌|🔥)\s*(.*)$/`；块内提取正文、`💭`、`⏱`、`^anchor`、deeplink；最近一次 `^#{2,4}` 为章节。

**额外价值**：`bookId → TFile` 映射也来自这里（走 `metadataCache` 只读 frontmatter），用于把 API 的书名解析成 vault 双链。

---

## 附录 B：实测响应片段（脱敏）

```jsonc
// /user/notebooks
{ "totalBookCount": 563, "totalNoteCount": 17626, "hasMore": 1,
  "books": [{ "bookId": "3300105328", "noteCount": 40, "reviewCount": 0,
              "book": { "title": "谈谈方法", "author": "[法]勒内·笛卡尔", "cover": "..." } }] }

// /book/bookmarklist  → 我的划线（一次全量，不分页）
{ "updated": [{ "bookId": "3300105328", "chapterUid": 6, "bookmarkId": "3300105328_6_2415-2548",
                "range": "2415-2548", "markText": "我的第三条准则：……（133 字）", "createTime": 1791211637 }],
  "chapters": [{ "title": "第三部分 从该方法论中提炼出的几条行为准则", "chapterUid": 6 }], "synckey": 123 }

// /book/bestbookmarks (chapterUid=0) → 书级热门 top20
{ "totalCount": 379,
  "items": [{ "chapterUid": 6, "range": "2415-2461", "totalCount": 1020,
              "markText": "我的第三条准则：……（46 字，截断版）" }] }

// /review/list/mine → 我的想法（该书 0 条）
{ "totalCount": 0, "reviews": [], "hasMore": 0 }
```

> 注意：热门项与我的划线可能是**同一句的两个截断版本**，`(chapterUid, range)` 不相等 —— 见 §2.4。
