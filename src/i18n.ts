/**
 * Lightweight i18n for Journal Partner.
 *
 * No third-party dependency: a single translation table keyed by semantic
 * strings, plus a `t()` helper and locale-aware date/number formatting.
 * Default language is English; Chinese is the second language.
 */

import type { Moment } from 'moment';

export type Language = 'en' | 'zh';

type Dict = { [key: string]: string };

const EN: Dict = {
  // ── Common ─────────────────────────────────────────────────────────────
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.save': 'Save',
  'common.clear': 'Clear',
  'common.edit': 'Edit',
  'common.copy': 'Copy',
  'common.remote': 'Remote',
  'common.local': 'Local',
  'common.year': 'year',
  'common.years': 'years',
  'common.day': 'day',
  'common.days': 'days',
  'common.entry': 'entry',
  'common.entries': 'entries',
  'common.audio': 'audio',
  'common.audios': 'audios',
  'common.word': 'word',
  'common.words': 'words',
  'common.recording': 'recording',
  'common.recordings': 'recordings',
  'common.folderPlaceholder': 'Pick or search a folder path',

  // ── Tab / view names ───────────────────────────────────────────────────
  'tab.capture': 'Journal Partner',
  'tab.review': 'Random Review',
  'tab.stats': 'Yearly Stats',

  // ── Commands ───────────────────────────────────────────────────────────
  'cmd.openSidebar': 'Open Journal Partner sidebar',

  // ── WeChat capture ────────────────────────────────────────────────────
  'wechat.desktopOnly': 'WeChat capture is available in the Obsidian desktop app only',
  'wechat.secretStorageRequired': 'WeChat binding requires Obsidian 1.11.4+ so the bot credential can be stored securely',
  'wechat.status.mobile': 'Desktop only. The rest of Journal Partner still works on mobile.',
  'wechat.status.unbound': 'Not bound. Scan once, then messages sent to the WeChat bot are recorded automatically.',
  'wechat.status.disabled': 'Bound, but background capture is paused.',
  'wechat.status.connecting': 'Connecting to WeChat…',
  'wechat.status.connected': 'Connected ({owner}). The capture pipeline runs while Obsidian is open.',
  'wechat.status.retrying': 'Can’t reach the WeChat service; retrying in the background.',
  'wechat.status.paused': 'Tencent requested a cooldown. Retrying in about {minutes} minute(s).',
  'wechat.status.error': 'WeChat capture stopped: {msg}',
  'wechat.bind': 'Scan to bind',
  'wechat.rebind': 'Scan again',
  'wechat.disconnect': 'Disconnect',
  'wechat.disconnectTitle': 'Disconnect WeChat',
  'wechat.disconnectConfirm': 'Remove the local bot credential and stop receiving WeChat messages? Existing journal entries are unchanged.',
  'wechat.qrTitle': 'Bind WeChat capture',
  'wechat.qrFetching': 'Fetching a QR code…',
  'wechat.qrWaiting': 'Waiting for scan…',
  'wechat.qrScanned': 'Scanned. Confirm the binding on your phone…',
  'wechat.qrRefreshed': 'The QR code expired and was refreshed. Please scan again.',
  'wechat.qrHint': 'Scan with WeChat and confirm on the page that opens. Availability depends on Tencent enabling the ClawBot channel for your account.',
  'wechat.qrAlt': 'WeChat binding QR code',
  'wechat.openQrPage': 'Open Tencent’s QR page',
  'wechat.qrFetchTimeout': 'Timed out while fetching the QR code',
  'wechat.qrInvalidResponse': 'The login response is missing required credentials',
  'wechat.qrLoginTimeout': 'Login timed out. Close this dialog and try again.',
  'wechat.qrTooManyRefreshes': 'The QR code expired repeatedly. Please try again later.',
  'wechat.qrFailed': 'Could not start WeChat binding: {msg}',
  'wechat.verifyNeeded': 'WeChat requires an extra verification code.',
  'wechat.verifyPrompt': 'Enter the number shown in WeChat on your phone.',
  'wechat.verifyCode': 'Verification code',
  'wechat.verifySubmit': 'Submit',
  'wechat.verifyBlocked': 'Verification was temporarily blocked. Please try again later.',
  'wechat.alreadyBoundNoCredential': 'Tencent reports this bot was bound before, but no usable credential exists on this device. Use another WeChat account or clear the old binding from its original client.',
  'wechat.voiceNoTranscript': '[Voice message — WeChat did not provide a transcript]',
  'wechat.writeRejected': 'The Daily Note could not be written',
  'wechat.replyRecorded': 'Recorded ✓',
  'wechat.sendTimeout': 'WeChat acknowledgement timed out',

  // ── Notices ────────────────────────────────────────────────────────────
  'notice.dailyNotesRequired': 'Please enable Obsidian’s core "Daily Notes" plugin first',
  'notice.writeFailed': 'Write failed: {msg}',
  'notice.protocolNeedText': 'Quick capture needs at least a text or audio parameter',
  'notice.recorded': '{tag} Recorded: {preview}{ellipsis}',
  'notice.timestampReadonly': '⏰ Timestamp cannot be modified',
  'notice.invalidRegex': '❌ Invalid regular expression',
  'notice.imageStaged': 'Image staged — written to note on submit',
  'notice.imageSavedLocal': 'Image saved locally, written to note on submit',
  'notice.imageFailed': 'Image handling failed: {msg}',
  'notice.imageNoDrag': 'Images can’t be dragged in — paste them into the input (Ctrl/Cmd+V)',
  'notice.sttFailed': 'Transcription failed: {msg}',
  'notice.recSaveFailed': 'Recording save failed: {msg}',
  'notice.recAutoStopped': 'Recording auto-stopped (5 min max)',
  'notice.micFailed': 'Cannot access microphone: {msg}',
  'notice.taskDone': '✓ Task completed',
  'notice.taskUndone': '○ Task marked incomplete',
  'notice.taskToggleFailed': 'Failed to toggle task state',
  'notice.cleared': '🧹 Cleared',
  'notice.clearedWithTrash': '🧹 Cleared, {trashed}/{total} recording file(s) moved to trash',
  'notice.copied': '📋 Copied',
  'notice.copyFailed': 'Copy failed: {msg}',
  'notice.fileNotFound': 'Daily note not found',
  'notice.contentChanged': 'Note content changed, refresh and retry',
  'notice.updated': '✏️ Updated',
  'notice.saveFailed': 'Save failed: {msg}',
  'notice.deleted': '🗑️ Deleted',
  'notice.memoDeletedNoAudio': '🗑️ Memo deleted (audio file already gone)',
  'notice.memoAndAudioDeleted': '🗑️ Deleted memo and {trashed} recording file(s)',
  'notice.memoDeletedTrashed': '🗑️ Memo deleted; {trashed}/{total} recording file(s) moved to trash',
  'notice.audioLinkRemoved': '🎤️ Recording link removed (file already gone)',
  'notice.audioDeletedKeepMemo': '🎤️ Deleted {trashed} recording file(s) (memo kept)',
  'notice.audioLinkRemovedTrashed': '🎤️ Link removed; {trashed}/{total} recording file(s) moved to trash',
  'notice.statsLoadFailed': 'Load failed: {msg}',
  'notice.noFileForDate': '{date} has no daily note',
  'notice.openFailed': 'Open failed',
  'notice.contentEmpty': 'Content cannot be empty',
  'notice.wechatBound': 'WeChat capture is connected',
  'notice.wechatAlreadyBound': 'This WeChat bot is already connected; the existing credential is being used',
  'notice.wechatDisconnected': 'WeChat capture disconnected; existing journal entries were kept',

  // ── Timeline UI ────────────────────────────────────────────────────────
  'timeline.searchPlaceholder': 'Search notes…',
  'timeline.searchInput': 'Type keywords to search',
  'timeline.searching': 'Searching…',
  'timeline.searchNoResults': 'No records match “{query}”',
  'timeline.tagNoResults': 'No notes tagged #{tag}',
  'timeline.filteringTag': 'Filtering #{tag}…',
  'timeline.noResults': 'No matching records',
  'timeline.emptyToday': 'No memos yet — write something →',
  'timeline.noMemos': 'No memos',
  'timeline.end': '— Loaded back to the earliest note —',
  'timeline.home': 'Timeline',
  'timeline.matches': '{count} match(es)',
  'timeline.daysAgo': ' · {n} day(s) ago',
  'timeline.daysLater': ' · {n} day(s) later',
  'timeline.today': ' · Today',
  'timeline.yesterday': ' · Yesterday',
  'timeline.tomorrow': ' · Tomorrow',
  'timeline.weekdayZh': ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][0],

  // ── Review mode ────────────────────────────────────────────────────────
  'review.noPastNotes': 'No past notes to review yet',
  'review.emptyDay': 'No journal content this day',

  // ── Stats ──────────────────────────────────────────────────────────────
  'stats.loading': 'Loading journal data…',
  'stats.noData': 'No data',
  'stats.tenThousand': 'k',
  'stats.tenThousandWord': 'k words',
  'stats.word': 'words',
  'stats.writingDays': 'Recording days',
  'stats.totalEntries': 'Total entries',
  'stats.recordings': 'Recordings',
  'stats.longestStreak': 'Longest streak',
  'stats.yearsRange': '{start}–{end} years',
  'stats.dayUnit': 'days',
  'stats.entryUnit': 'entries',
  'stats.audioUnit': 'recordings',
  'stats.legendLess': 'Less',
  'stats.legendMore': 'More',
  'stats.notWritten': 'not written',
  'stats.footer': '{days} days · {words} words · {entries} entries{audios}',
  'stats.footerAudios': ' · {n} recordings',
  'stats.title': '{year}',

  // ── Settings tab ───────────────────────────────────────────────────────
  'settings.heading.timestamp': 'Timestamp Settings',
  'settings.heading.wechat': 'WeChat Capture',
  'settings.heading.tags': 'Tag Settings',
  'settings.heading.colors': 'Color Settings',
  'settings.heading.stt': 'Speech-to-Text',
  'settings.heading.other': 'Other',
  'settings.heading.language': 'Language',
  'settings.wechatIntro': 'Use WeChat as a remote inbox: text and voice transcripts are appended to the matching Daily Note’s Journal section. The connection is direct to Tencent iLink; there is no author-operated relay server or AI rewriting.',
  'settings.wechatStatus': 'Binding status',
  'settings.wechatEnabled': 'Background capture',
  'settings.wechatEnabledDesc': 'Long-poll for new messages while Obsidian desktop is open. Messages received after downtime use their original creation time when available.',
  'settings.targetHeading': 'Journal heading',
  'settings.targetHeadingDesc': 'Heading that activates the plugin, e.g. Journal',
  'settings.headingLevel': 'Heading level',
  'settings.headingLevelDesc': 'Level of the target heading, H2 = ## Journal',
  'settings.readonly': 'Read-only protection',
  'settings.readonlyDesc': 'When on, existing timestamps can’t be edited in the editor',
  'settings.autoTimestamp': 'Auto-insert on Enter',
  'settings.autoTimestampDesc': 'Pressing Enter inside the Journal section inserts the current time on the new line',
  'settings.pattern': 'Match regex',
  'settings.patternDesc': 'Regex for timestamp detection, default \\d{2}:\\d{2} (HH:MM)',
  'settings.sortOrder': 'Sort order',
  'settings.sortOrderDesc': 'Order of journal entries in the timeline',
  'settings.sortDesc': 'Newest first (default)',
  'settings.sortAsc': 'Oldest first',
  'settings.preview': 'Preview:',
  'settings.previewSample': 'Here is the journal content…',
  'settings.presetTags': 'Preset tags',
  'settings.presetTagsDesc': 'Quick-insert tags, pick from the # icon at the lower-left of the input. One tag per line.',
  'settings.addTag': '+ Add tag',
  'settings.addTagTooltip': 'Add a preset tag',
  'settings.deleteTagTooltip': 'Delete this tag',
  'settings.defaultTags': 'Default tags',
  'settings.defaultTagsDesc': 'Tags applied every time the input opens (shown as chips above the input). None by default.',
  'settings.maxDiaryTags': 'Max diary tags shown',
  'settings.maxDiaryTagsDesc': 'How many tags the tag-filter menu shows for the daily summary (by frequency + recency). 0 = show all.',
  'settings.noPresetTags': 'Please add tags under "Preset tags" first.',
  'settings.recordingFolder': 'Recording folder',
  'settings.recordingFolderDesc': 'Vault-relative folder for recordings. Empty uses Obsidian’s attachment folder.',
  'settings.imageFolder': 'Image folder',
  'settings.imageFolderDesc': 'Vault-relative folder for pasted/uploaded images. Empty uses Obsidian’s attachment folder.',
  'settings.sttEndpoint': 'Transcription endpoint',
  'settings.sttEndpointDesc': 'OpenAI-compatible /audio/transcriptions URL. Empty disables transcription.',
  'settings.sttApiKey': 'API Key',
  'settings.sttApiKeyDesc': 'Sent as a Bearer token. Use your OpenAI / Groq / self-hosted key.',
  'settings.sttModel': 'Model',
  'settings.sttModelDesc': 'model field in multipart, e.g. whisper-1, whisper-large-v3.',
  'settings.sttLanguage': 'Language',
  'settings.sttLanguageDesc': 'ISO-639-1 language hint, e.g. zh, en. Empty lets the model auto-detect.',
  'settings.sttRealtime': 'Realtime transcription',
  'settings.sttRealtimeDesc': 'Transcribes live while recording, splitting sentences at pauses. Off = transcribe the whole clip once.',
  'settings.textColor': 'Text color',
  'settings.textColorDesc': 'Foreground color of the timestamp badge (left: light ☀, right: dark 🌙)',
  'settings.bgColor': 'Background color',
  'settings.bgColorDesc': 'Background color of the timestamp badge (left: light ☀, right: dark 🌙)',
  'settings.sttGuide': 'Transcription uses an OpenAI-compatible /audio/transcriptions endpoint. Set the endpoint and API key to enable it; leave blank to disable and record audio only. You can also use the system dictation (double-tap Fn on macOS / iOS keyboard mic) into the input instead.',
  'settings.sttGuideRealtime': 'Realtime mode: transcribes as you speak, splitting sentences at pauses. After stopping, the realtime draft is kept by default (fast); enable “re-transcribe the full clip” below to replace it with a full-audio transcription (more accurate, but slower).',
  'settings.sttProvider': 'Provider',
  'settings.sttEndpointCol': 'Endpoint',
  'settings.sttModelCol': 'Model',
  'settings.sttCost': 'Cost',
  'settings.sttNote': 'Notes',
  'settings.sttFree': 'Free',
  'settings.sttHasFreeQuota': 'Free tier available',
  'settings.sttPaid': 'Paid',
  'settings.sttCNRecommended': 'Direct from mainland China, good Chinese quality, key after real-name registration',
  'settings.sttFast': 'Very fast, requires network access',
  'settings.sttOfficial': 'Official API, requires internet',
  'settings.sttGoodCN': 'Excellent Chinese, note the API format',
  'settings.sttSelfHosted': 'Docker-deployed OpenAI-compatible service, private',
  'settings.sttHint': 'Note: quotas and model names follow each provider’s site and may change. SenseVoiceSmall is currently listed as free on SiliconFlow → ',
  'settings.sttPricing': 'SiliconFlow pricing',
  'settings.sttApiKeyShowHide': 'Show/hide API Key',
  'settings.sttRealtimeMode': 'Realtime transcription',
  'settings.urlCopy': 'Click to copy',
  'settings.urlCopied': 'URL copied',
  'settings.sttProviderSiliconFlow': 'SiliconFlow (recommended in CN)',
  'settings.sttProviderGroq': 'Groq',
  'settings.sttProviderOpenAI': 'OpenAI',
  'settings.sttProviderBailian': 'Alibaba Bailian',
  'settings.sttProviderSelfHosted': 'Self-hosted faster-whisper',
  'settings.submitShortcut': 'Submit shortcut',
  'settings.submitShortcutDesc': 'Keyboard combo to submit an entry in the input box',
  'settings.appleShortcut': 'Apple Shortcut',
  'settings.appleShortcutDesc': 'Use with the iPhone Action Button to quickly record into your journal',
  'settings.getShortcut': 'Get Shortcut',
  'settings.resetDefault': 'Restore default',
  'settings.vaultRoot': 'Vault root',
  'settings.sameFolder': 'Same folder as the note',
  'settings.pickFolder': 'Pick folder',
  'settings.language': 'Language',
  'settings.languageDesc': 'Interface language (default English)',
  'settings.urlTitle': 'URL Scheme',
  'settings.urlDesc': 'Callable from any browser / Shortcuts / automation: opens the sidebar and starts recording.',
  'settings.resetShortcut': 'Restore default',

  // ── Input / capture UI ─────────────────────────────────────────────────
  'capture.placeholder': 'Record this moment — use @ or [[ to link a file',
  'capture.submitting': 'Writing…',
  'capture.recording': 'Recording…',
  'capture.transcribing': 'Transcribing…',
  'capture.realtimeTranscribing': 'Realtime transcribing…',
  'capture.tagPickerTitle': 'Choose tags',
  'capture.tagPickerClose': 'Close tag picker',
  'capture.noPresetTags': 'No preset tags — add them in plugin settings',
  'capture.clearTitle': 'Clear input box',
  'capture.clearConfirm': 'Clear the input box?',
  'capture.clearConfirmWithAudio': 'Clear the input box? This will also delete {n} recording file(s) (moved to trash, recoverable).',
  'capture.removeTag': 'Remove {tag}',
  'capture.filterAll': 'All',
  'capture.filterTask': 'Tasks only',
  'capture.filterMemo': 'Memos only',
  'capture.filter': 'Filter',
  'capture.noTags': 'No tags',
  'capture.clearTagFilter': 'Clear tag filter',
  'capture.searchNotes': 'Search notes',
  'capture.backToTimeline': 'Back to timeline',
  'capture.filterByTag': 'Filter by tag',
  'capture.insertTag': 'Insert preset tag',
  'capture.uploadImage': 'Upload image',
  'capture.record': 'Record',
  'capture.toggleTask': 'Toggle task mode',
  'capture.removeImage': 'Remove image',
  'capture.openNote': 'Open note',
  'capture.backToTop': 'Back to top',

  // ── Context menu / delete dialog ───────────────────────────────────────
  'menu.deleteMemo': 'Delete memo',
  'menu.deleteAudioOnly': 'Delete recording only (keep text)',
  'menu.deleteAudioOnlyPlural': 'Delete {n} recording file(s) (keep text)',
  'menu.deleteMemoAndAudio': 'Delete memo and recording file(s)',
  'menu.deleteAudio': 'Delete recording file(s)',
  'menu.confirmDelete': 'Delete this memo?',
  'menu.confirmDeleteWithAudio': 'Delete this memo’s recording file(s)? The memo text will be kept.',
  'menu.audioToTrash': 'Recording file(s) to be moved to trash (recoverable):',
  'menu.audioAlsoDeleted': 'Recording file(s) also deleted (moved to trash, recoverable):',
  'menu.emptyMemo': '(empty memo)',
  'menu.editTitle': 'Edit {timestamp}',
};

const ZH: Dict = {
  // ── Common ─────────────────────────────────────────────────────────────
  'common.cancel': '取消',
  'common.delete': '删除',
  'common.save': '保存',
  'common.clear': '清空',
  'common.edit': '编辑',
  'common.copy': '复制',
  'common.remote': '远程',
  'common.local': '本地',
  'common.year': '年',
  'common.years': '年',
  'common.day': '天',
  'common.days': '天',
  'common.entry': '条',
  'common.entries': '条',
  'common.audio': '段',
  'common.audios': '段',
  'common.word': '字',
  'common.words': '字',
  'common.recording': '段录音',
  'common.recordings': '段录音',
  'common.folderPlaceholder': '选择或搜索文件夹路径',

  // ── Tab / view names ───────────────────────────────────────────────────
  'tab.capture': 'Journal Partner',
  'tab.review': '随机回顾',
  'tab.stats': '年度统计',

  // ── Commands ───────────────────────────────────────────────────────────
  'cmd.openSidebar': '打开 Journal Partner 侧边栏',

  // ── 微信采集 ──────────────────────────────────────────────────────────
  'wechat.desktopOnly': '微信采集仅支持 Obsidian 桌面端',
  'wechat.secretStorageRequired': '微信绑定需要 Obsidian 1.11.4+，以便安全保存 bot 凭据',
  'wechat.status.mobile': '仅桌面端可用；Journal Partner 的其他功能仍可在移动端使用。',
  'wechat.status.unbound': '尚未绑定。扫码一次后，发给微信 bot 的消息会自动记入日记。',
  'wechat.status.disabled': '已绑定，但后台采集已暂停。',
  'wechat.status.connecting': '正在连接微信…',
  'wechat.status.connected': '已连接（{owner}）。Obsidian 打开期间会持续接收消息。',
  'wechat.status.retrying': '暂时连不上微信服务，正在后台重试。',
  'wechat.status.paused': '腾讯要求暂时冷却，约 {minutes} 分钟后重试。',
  'wechat.status.error': '微信采集已停止：{msg}',
  'wechat.bind': '扫码绑定',
  'wechat.rebind': '重新扫码',
  'wechat.disconnect': '解除绑定',
  'wechat.disconnectTitle': '解除微信绑定',
  'wechat.disconnectConfirm': '清除本机 bot 凭据并停止接收微信消息？已经写入的日记不会改变。',
  'wechat.qrTitle': '绑定微信采集',
  'wechat.qrFetching': '正在获取二维码…',
  'wechat.qrWaiting': '等待扫码…',
  'wechat.qrScanned': '已扫码，请在手机上确认绑定…',
  'wechat.qrRefreshed': '二维码已过期并自动刷新，请重新扫码。',
  'wechat.qrHint': '使用微信扫码并在打开的页面确认。能否使用取决于腾讯是否为你的账号开放 ClawBot 通道。',
  'wechat.qrAlt': '微信绑定二维码',
  'wechat.openQrPage': '打开腾讯二维码页面',
  'wechat.qrFetchTimeout': '获取二维码超时',
  'wechat.qrInvalidResponse': '登录响应缺少必要凭据',
  'wechat.qrLoginTimeout': '登录超时，请关闭窗口后重试。',
  'wechat.qrTooManyRefreshes': '二维码连续失效，请稍后再试。',
  'wechat.qrFailed': '无法开始微信绑定：{msg}',
  'wechat.verifyNeeded': '微信要求进行额外验证码确认。',
  'wechat.verifyPrompt': '请输入手机微信上显示的数字。',
  'wechat.verifyCode': '验证码',
  'wechat.verifySubmit': '提交',
  'wechat.verifyBlocked': '验证码暂时被限制，请稍后再试。',
  'wechat.alreadyBoundNoCredential': '腾讯提示这个 bot 以前绑定过，但本机没有可用凭据。请改用另一个微信账号，或回原客户端处理旧绑定。',
  'wechat.voiceNoTranscript': '［语音消息——微信未提供转写］',
  'wechat.writeRejected': 'Daily Note 写入失败',
  'wechat.replyRecorded': '已记下 ✓',
  'wechat.sendTimeout': '微信回执发送超时',

  // ── Notices ────────────────────────────────────────────────────────────
  'notice.dailyNotesRequired': '请先启用 Obsidian 自带的「Daily Notes」核心插件',
  'notice.writeFailed': '写入失败：{msg}',
  'notice.protocolNeedText': 'Quick capture 至少需要 text 或 audio 参数之一',
  'notice.recorded': '{tag} 已记录：{preview}{ellipsis}',
  'notice.timestampReadonly': '⏰ 时间戳不可修改',
  'notice.invalidRegex': '❌ 无效的正则表达式',
  'notice.imageStaged': '图片已暂存，提交时写入日记',
  'notice.imageSavedLocal': '图片已保存到本地，提交时写入日记',
  'notice.imageFailed': '图片处理失败：{msg}',
  'notice.imageNoDrag': '图片不支持拖拽，请在输入框内直接粘贴图片（Ctrl/Cmd+V）',
  'notice.sttFailed': '转写失败：{msg}',
  'notice.recSaveFailed': '录音保存失败：{msg}',
  'notice.recAutoStopped': '录音已自动停止（最长5分钟）',
  'notice.micFailed': '无法访问麦克风：{msg}',
  'notice.taskDone': '✓ 任务已完成',
  'notice.taskUndone': '○ 任务未完成',
  'notice.taskToggleFailed': '切换任务状态失败',
  'notice.cleared': '🧹 已清空',
  'notice.clearedWithTrash': '🧹 已清空，{trashed}/{total} 个录音文件移入回收站',
  'notice.copied': '📋 已复制',
  'notice.copyFailed': '复制失败：{msg}',
  'notice.fileNotFound': '找不到对应的日记文件',
  'notice.contentChanged': '日记内容已变化，请刷新后重试',
  'notice.updated': '✏️ 已更新',
  'notice.saveFailed': '保存失败：{msg}',
  'notice.deleted': '🗑️ 已删除',
  'notice.memoDeletedNoAudio': '🗑️ memo 已删除（录音文件已不存在）',
  'notice.memoAndAudioDeleted': '🗑️ 已删除 memo 和 {trashed} 个录音文件',
  'notice.memoDeletedTrashed': '🗑️ memo 已删除；{trashed}/{total} 个录音文件移入回收站',
  'notice.audioLinkRemoved': '🎙️ 录音链接已移除（文件已不存在）',
  'notice.audioDeletedKeepMemo': '🎙️ 已删除 {trashed} 个录音文件（memo 保留）',
  'notice.audioLinkRemovedTrashed': '🎙️ 链接已移除；{trashed}/{total} 个录音文件移入回收站',
  'notice.statsLoadFailed': '加载失败：{msg}',
  'notice.noFileForDate': '{date} 没有日记文件',
  'notice.openFailed': '打开失败',
  'notice.contentEmpty': '内容不能为空',
  'notice.wechatBound': '微信采集已连接',
  'notice.wechatAlreadyBound': '这个微信 bot 已连接过，继续使用现有凭据',
  'notice.wechatDisconnected': '微信采集已解除绑定，既有日记已保留',

  // ── Timeline UI ────────────────────────────────────────────────────────
  'timeline.searchPlaceholder': '搜索日记…',
  'timeline.searchInput': '输入关键词开始搜索',
  'timeline.searching': '搜索中…',
  'timeline.searchNoResults': '未找到包含「{query}」的记录',
  'timeline.tagNoResults': '没有找到带 #{tag} 的日记',
  'timeline.filteringTag': '筛选中 #{tag} …',
  'timeline.noResults': '没有匹配的记录',
  'timeline.emptyToday': '还没有 memo，写点什么吧 →',
  'timeline.noMemos': '还没有 memo',
  'timeline.end': '— 已加载到最早的日记 —',
  'timeline.home': '时间线',
  'timeline.matches': '{count} 条匹配',
  'timeline.daysAgo': ' · {n} 天前',
  'timeline.daysLater': ' · {n} 天后',
  'timeline.today': ' · 今天',
  'timeline.yesterday': ' · 昨天',
  'timeline.tomorrow': ' · 明天',

  // ── Review mode ────────────────────────────────────────────────────────
  'review.noPastNotes': '还没有过去的日记可以回顾',
  'review.emptyDay': '这天没有日记内容',

  // ── Stats ──────────────────────────────────────────────────────────────
  'stats.loading': '正在加载日记数据…',
  'stats.noData': '暂无数据',
  'stats.tenThousand': '万',
  'stats.tenThousandWord': '万字',
  'stats.word': '字',
  'stats.writingDays': '记录天数',
  'stats.totalEntries': '总条数',
  'stats.recordings': '录音数',
  'stats.longestStreak': '最长连续',
  'stats.yearsRange': '{start}–{end} 年',
  'stats.dayUnit': '天',
  'stats.entryUnit': '条',
  'stats.audioUnit': '段',
  'stats.legendLess': '少',
  'stats.legendMore': '多',
  'stats.notWritten': '未写',
  'stats.footer': '{days} 天 · {words} 字 · {entries} 条{audios}',
  'stats.footerAudios': ' · {n} 段录音',
  'stats.title': '{year} 年',

  // ── Settings tab ───────────────────────────────────────────────────────
  'settings.heading.timestamp': '时间戳设置',
  'settings.heading.wechat': '微信采集',
  'settings.heading.tags': '标签设置',
  'settings.heading.colors': '颜色设置',
  'settings.heading.stt': '语音转文字',
  'settings.heading.other': '其他',
  'settings.heading.language': '语言',
  'settings.wechatIntro': '把微信当作远程收件箱：文字和语音转写会追加到对应 Daily Note 的 Journal 区段。连接直达腾讯 iLink，不经过作者中转服务器，也不会调用 AI 改写。',
  'settings.wechatStatus': '绑定状态',
  'settings.wechatEnabled': '后台采集',
  'settings.wechatEnabledDesc': 'Obsidian 桌面端打开时长轮询新消息；离线后补收时，如消息带原始时间，会写回对应日期。',
  'settings.textColor': '文字颜色',
  'settings.textColorDesc': '时间戳徽标的前景色（左：白天 ☀　右：深色 🌙）',
  'settings.bgColor': '背景颜色',
  'settings.bgColorDesc': '时间戳徽标的背景色（左：白天 ☀　右：深色 🌙）',
  'settings.sttGuide': '录音转文字使用 OpenAI 兼容的 /audio/transcriptions 接口。填好转写地址与 API Key 即可开启；留空则关闭转写，麦克风仅作纯录音。也可不配置，直接用系统听写（macOS 双击 Fn / iOS 键盘麦克风）往输入框输入。',
  'settings.sttGuideRealtime': '实时转写模式：边说边出字，在停顿处切句并带上下文拼接。停止后默认保留实时草稿（快）；可在下方开启「停止后整段重转」用完整音频再转一次替换草稿（更准但需等待）。',
  'settings.sttProvider': '服务商',
  'settings.sttEndpointCol': '转写地址',
  'settings.sttModelCol': '模型',
  'settings.sttCost': '费用',
  'settings.sttNote': '说明',
  'settings.sttFree': '免费',
  'settings.sttHasFreeQuota': '有免费额度',
  'settings.sttPaid': '付费',
  'settings.sttCNRecommended': '国内可直连，中文质量好，注册实名后生成 Key',
  'settings.sttFast': '速度极快，需网络可达',
  'settings.sttOfficial': '官方接口，需外网',
  'settings.sttGoodCN': '中文优秀，注意接口格式',
  'settings.sttSelfHosted': 'Docker 部署 OpenAI 兼容服务，隐私无忧',
  'settings.sttHint': '提示：以上服务的额度与模型名以官网公示为准，可能随时调整。SenseVoiceSmall 当前在 SiliconFlow 标注为免费 → ',
  'settings.sttPricing': 'SiliconFlow 定价',
  'settings.sttProviderSiliconFlow': 'SiliconFlow（国内推荐）',
  'settings.sttProviderGroq': 'Groq',
  'settings.sttProviderOpenAI': 'OpenAI',
  'settings.sttProviderBailian': '阿里百炼',
  'settings.sttProviderSelfHosted': '自建 faster-whisper',
  'settings.sttApiKeyShowHide': '显示/隐藏 API Key',
  'settings.sttRealtimeMode': '实时转写模式',
  'settings.urlCopy': '点击复制',
  'settings.urlCopied': '已复制 URL',
  'settings.targetHeading': '日记标题',
  'settings.targetHeadingDesc': '插件生效的标题，如 Journal',
  'settings.headingLevel': '标题层级',
  'settings.headingLevelDesc': '目标标题的层级，H2 对应 ## Journal',
  'settings.readonly': '只读保护',
  'settings.readonlyDesc': '开启后，无法在编辑器中修改已存在的时间戳',
  'settings.autoTimestamp': '回车自动插入',
  'settings.autoTimestampDesc': '在 Journal 区块内按回车时，自动在新行插入当前时间',
  'settings.pattern': '匹配正则',
  'settings.patternDesc': '识别时间戳的正则表达式，默认 \\d{2}:\\d{2}（HH:MM）',
  'settings.sortOrder': '排序方式',
  'settings.sortOrderDesc': '时间线中日记条目的排列顺序',
  'settings.sortDesc': '最新在上（默认）',
  'settings.sortAsc': '最早在上',
  'settings.preview': '预览：',
  'settings.previewSample': '这里是日记内容…',
  'settings.presetTags': '预设标签',
  'settings.presetTagsDesc': '快速插入的标签，点击输入框左下角的 # 图标即可选择。每个标签独占一行。',
  'settings.addTag': '+ 添加标签',
  'settings.addTagTooltip': '添加一个预设标签',
  'settings.deleteTagTooltip': '删除该标签',
  'settings.defaultTags': '默认标签',
  'settings.defaultTagsDesc': '每次打开输入框时自动带上的标签（显示为输入框顶部的状态标签）。不选则默认为无。',
  'settings.maxDiaryTags': '日记标签展示数量',
  'settings.maxDiaryTagsDesc': '标签筛选菜单里「日记汇总」展示的标签数量上限（按高频+近期排名）。设为 0 则展示全部。',
  'settings.noPresetTags': '请先在「预设标签」中添加标签。',
  'settings.recordingFolder': '录音存放位置',
  'settings.recordingFolderDesc': 'Vault 相对路径，用于存放录音文件。留空则使用 Obsidian 附件文件夹。',
  'settings.imageFolder': '图片存放位置',
  'settings.imageFolderDesc': 'Vault 相对路径，用于存放粘贴/上传的图片。留空则使用 Obsidian 附件文件夹。',
  'settings.sttEndpoint': '转写地址',
  'settings.sttEndpointDesc': 'OpenAI 兼容的 /audio/transcriptions 地址。留空则关闭录音转文字。',
  'settings.sttApiKey': 'API Key',
  'settings.sttApiKeyDesc': '以 Bearer 形式发送的密钥。可填 OpenAI / Groq / 自建服务的密钥。',
  'settings.sttModel': '模型',
  'settings.sttModelDesc': 'multipart 中的 model 字段，如 whisper-1、whisper-large-v3。',
  'settings.sttLanguage': '语言',
  'settings.sttLanguageDesc': 'ISO-639-1 语言提示，如 zh、en。留空让模型自动识别。',
  'settings.sttRealtime': '实时转写',
  'settings.sttRealtimeDesc': '录音时边说边出字，在停顿处切句并带上下文拼接。关闭则录完整段后一次性转写。',
  'settings.submitShortcut': '提交快捷键',
  'settings.submitShortcutDesc': '在输入框中提交日记的快捷键组合',
  'settings.appleShortcut': 'Apple Shortcut',
  'settings.appleShortcutDesc': '配合 iPhone Action Button 使用，快速录音并写入日记',
  'settings.getShortcut': '获取捷径',
  'settings.resetDefault': '恢复默认',
  'settings.vaultRoot': 'Vault 根目录',
  'settings.sameFolder': '与日记同目录',
  'settings.pickFolder': '选择目录',
  'settings.language': '语言',
  'settings.languageDesc': '界面语言（默认英文）',
  'settings.urlTitle': 'URL Scheme',
  'settings.urlDesc': '可在浏览器地址栏、快捷指令、自动化 App 等任意位置调用，自动打开侧边栏并开始录音。',
  'settings.resetShortcut': '恢复默认',

  // ── Input / capture UI ─────────────────────────────────────────────────
  'capture.placeholder': '记录这一刻吧，使用 @ 或 [[ 引入文件',
  'capture.submitting': '写入中…',
  'capture.recording': '录音中…',
  'capture.transcribing': '转写中…',
  'capture.realtimeTranscribing': '实时转写中…',
  'capture.tagPickerTitle': '选择标签',
  'capture.tagPickerClose': '关闭标签选择',
  'capture.noPresetTags': '还没有预设标签，可在插件设置中添加',
  'capture.clearTitle': '清空输入框',
  'capture.clearConfirm': '确定清空输入框吗？',
  'capture.clearConfirmWithAudio': '确定清空输入框吗？将同时删除 {n} 个录音文件（移入回收站，可恢复）。',
  'capture.removeTag': '移除 {tag}',
  'capture.filterAll': '全部',
  'capture.filterTask': '仅任务',
  'capture.filterMemo': '仅备忘',
  'capture.filter': '过滤',
  'capture.noTags': '暂无标签',
  'capture.clearTagFilter': '清除标签筛选',
  'capture.searchNotes': '搜索日记',
  'capture.backToTimeline': '回到时间线主页',
  'capture.filterByTag': '按标签筛选',
  'capture.insertTag': '插入预设标签',
  'capture.uploadImage': '上传图片',
  'capture.record': '录音',
  'capture.toggleTask': '切换任务模式',
  'capture.removeImage': '移除图片',
  'capture.openNote': '打开日记',
  'capture.backToTop': '回到顶部',

  // ── Context menu / delete dialog ───────────────────────────────────────
  'menu.deleteMemo': '删除 memo',
  'menu.deleteAudioOnly': '仅删除录音文件（保留文字）',
  'menu.deleteAudioOnlyPlural': '仅删除 {n} 个录音文件（保留文字）',
  'menu.deleteMemoAndAudio': '删除 memo 和录音文件',
  'menu.deleteAudio': '删除录音文件',
  'menu.confirmDelete': '确定要删除这条 memo 吗？',
  'menu.confirmDeleteWithAudio': '确定要删除这条 memo 的录音文件吗？memo 文字会保留。',
  'menu.audioToTrash': '将移入回收站的录音文件（可恢复）：',
  'menu.audioAlsoDeleted': '附带删除的录音文件（移入回收站，可恢复）：',
  'menu.emptyMemo': '(空 memo)',
  'menu.editTitle': '编辑 {timestamp}',
};

const DICTS: Record<Language, Dict> = { en: EN, zh: ZH };

let currentLanguage: Language = 'en';

/** Set the active language. Returns the previous value. */
export function setLanguage(lang: Language): Language {
  const prev = currentLanguage;
  currentLanguage = lang;
  return prev;
}

export function getLanguage(): Language {
  return currentLanguage;
}

export function isChinese(): boolean {
  return currentLanguage === 'zh';
}

/**
 * Translate a key. Falls back to the English entry if the active language
 * misses the key, then to the raw key itself.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const dict = DICTS[currentLanguage];
  let text = dict[key] ?? EN[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return text;
}

// ── Locale-aware date / number helpers ─────────────────────────────────────

const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WEEKDAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Weekday short label for heatmap rows / date headers. */
export function weekdayShort(dayIndex: number): string {
  return isChinese() ? WEEKDAY_ZH[dayIndex] : WEEKDAY_EN[dayIndex];
}

/** Weekday label for the heatmap's sparse "一/三/五" row. */
export function heatmapWeekdayLabel(dayIndex: number): string {
  if (isChinese()) {
    return ['一', '二', '三', '四', '五', '六', '日'][dayIndex];
  }
  return WEEKDAY_EN[dayIndex];
}

/** Month label for the heatmap row, e.g. "1月" or "Jan". */
export function monthLabel(monthIndex: number): string {
  return isChinese() ? `${monthIndex + 1}月` : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][monthIndex];
}

/** Full date label, e.g. "2026年8月29日" or "Aug 29, 2026". */
export function formatDate(date: Moment): string {
  return isChinese()
    ? date.format('YYYY年M月D日')
    : date.format('MMM D, YYYY');
}

/** Relative day suffix used by date headers ("· 3 天前" / "· 3 days ago"). */
export function relativeDayLabel(diff: number): string {
  if (isChinese()) {
    if (diff === 0) return ' · 今天';
    if (diff === -1) return ' · 昨天';
    if (diff === 1) return ' · 明天';
    return diff < 0 ? ` · ${-diff} 天前` : ` · ${diff} 天后`;
  }
  if (diff === 0) return ' · Today';
  if (diff === -1) return ' · Yesterday';
  if (diff === 1) return ' · Tomorrow';
  return diff < 0 ? ` · ${-diff} day(s) ago` : ` · ${diff} day(s) later`;
}
