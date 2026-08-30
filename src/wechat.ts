/**
 * Desktop-only WeChat capture channel for Journal Partner.
 *
 * The transport follows Tencent's public iLink protocol. The implementation
 * is intentionally isolated from the journal writer: this module owns login,
 * credentials, polling, replay protection, and acknowledgements; the host
 * decides how a received message is written into a Daily Note.
 *
 * Protocol behavior was independently adapted from Tencent's MIT-licensed
 * openclaw-weixin client and obsidian-wechat-diary v0.3.0 (MIT). See
 * THIRD_PARTY_NOTICES.md.
 */

import { App, Modal, Notice, Platform, Setting } from 'obsidian';
import qrcode from 'qrcode-generator';

import type { JournalPartnerSettings } from './section';
import { t } from './i18n';

const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com';
const CHANNEL_VERSION = '2.4.6';
const CLIENT_VERSION_HEADER = '132102';
const BOT_AGENT = 'JournalPartner/2.19.0';
const SECRET_BOT_TOKEN = 'journal-partner-wechat-ilink-bot-token';

const LONG_POLL_TIMEOUT_MS = 35_000;
const HTTP_TIMEOUT_GRACE_MS = 5_000;
const QR_FETCH_TIMEOUT_MS = 15_000;
const QR_LOCAL_TTL_MS = 5 * 60_000;
const LOGIN_TOTAL_TIMEOUT_MS = 8 * 60_000;
const SEND_TIMEOUT_MS = 15_000;
const STALE_TOKEN_ERRCODE = -14;
const SESSION_PAUSE_MS = 60 * 60_000;
const MAX_RECENT_MESSAGE_IDS = 200;

type JsonObject = Record<string, unknown>;

interface SecretStorageLike {
  getSecret(key: string): string | null;
  setSecret(key: string, value: string): void;
}

interface JsonResponse<T> {
  json: T;
  timeout?: false;
}

interface TimeoutResponse {
  timeout: true;
}

type ILinkResponse<T> = JsonResponse<T> | TimeoutResponse;

interface QrResponse extends JsonObject {
  qrcode?: string;
  qrcode_img_content?: string;
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

interface QrStatusResponse extends JsonObject {
  status?: string;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
  redirect_host?: string;
  ret?: number;
  errcode?: number;
}

interface MessageItem {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { text?: string };
}

interface WeixinMessage {
  seq?: number | string;
  message_id?: number | string;
  from_user_id?: string;
  create_time_ms?: number;
  message_type?: number;
  message_state?: number;
  context_token?: string;
  item_list?: MessageItem[];
}

interface UpdatesResponse extends JsonObject {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

interface WechatHost {
  app: App;
  settings: JournalPartnerSettings;
  saveSettings(): Promise<void>;
  persistWechatState(): Promise<void>;
  writeWechatMessage(text: string, createdAtMs?: number): Promise<boolean>;
}

type StatusKind =
  | 'mobile'
  | 'unbound'
  | 'disabled'
  | 'connecting'
  | 'connected'
  | 'retrying'
  | 'paused'
  | 'error';

function responseCode(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const obj = value as { ret?: unknown; errcode?: unknown };
  if (typeof obj.ret === 'number' && obj.ret !== 0) return obj.ret;
  if (typeof obj.errcode === 'number' && obj.errcode !== 0) return obj.errcode;
  return 0;
}

async function getHttps(): Promise<typeof import('https')> {
  if (!Platform.isDesktopApp) throw new Error(t('wechat.desktopOnly'));
  // Deliberately imported only after the desktop guard so the rest of Journal
  // Partner keeps loading on mobile.
  return import('https');
}

function getBuffer(): typeof import('buffer').Buffer {
  // eslint-disable-next-line no-undef -- Buffer is provided by Obsidian desktop's Node runtime
  return Buffer;
}

function randomUin(): string {
  const value = Math.floor(Math.random() * 0xffffffff) >>> 0;
  return getBuffer().from(String(value), 'utf8').toString('base64');
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

class ILinkClient {
  token = '';
  baseUrl = '';

  private readonly agent: import('https').Agent;
  private readonly inFlight = new Set<import('http').ClientRequest>();
  private readonly https: typeof import('https');

  private constructor(https: typeof import('https')) {
    this.https = https;
    this.agent = new https.Agent({ keepAlive: true, maxSockets: 2 });
  }

  static async create(): Promise<ILinkClient> {
    return new ILinkClient(await getHttps());
  }

  destroy(): void {
    for (const request of this.inFlight) request.destroy();
    this.inFlight.clear();
    this.agent.destroy();
  }

  private baseInfo(): JsonObject {
    return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT };
  }

  private commonHeaders(): Record<string, string> {
    return {
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': CLIENT_VERSION_HEADER,
    };
  }

  private async requestJson<T extends JsonObject>(
    base: string,
    endpoint: string,
    method: 'GET' | 'POST',
    body: JsonObject | null,
    timeoutMs: number,
  ): Promise<ILinkResponse<T>> {
    const url = new URL(endpoint, base.endsWith('/') ? base : `${base}/`);
    const bodyBuffer = method === 'POST'
      ? getBuffer().from(JSON.stringify(body ?? {}), 'utf8')
      : null;
    const headers: Record<string, string> = {
      ...this.commonHeaders(),
    };
    if (bodyBuffer) {
      headers['Content-Type'] = 'application/json';
      headers.AuthorizationType = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = randomUin();
      headers['Content-Length'] = String(bodyBuffer.length);
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
    }

    return new Promise<ILinkResponse<T>>((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      const request = this.https.request(url, { method, headers, agent: this.agent }, response => {
        response.setEncoding('utf8');
        let raw = '';
        response.on('data', chunk => { raw += String(chunk); });
        response.on('end', () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          this.inFlight.delete(request);
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`iLink HTTP ${status}: ${raw.slice(0, 160)}`));
            return;
          }
          try {
            resolve({ json: JSON.parse(raw) as T });
          } catch {
            reject(new Error(`iLink returned invalid JSON: ${raw.slice(0, 160)}`));
          }
        });
      });
      this.inFlight.add(request);
      const timer = window.setTimeout(() => {
        timedOut = true;
        request.destroy(new Error('ilink-timeout'));
      }, timeoutMs);
      request.on('error', error => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        this.inFlight.delete(request);
        if (timedOut) resolve({ timeout: true });
        else reject(error);
      });
      if (bodyBuffer) request.end(bodyBuffer);
      else request.end();
    });
  }

  async getQrCode(localTokens: string[]): Promise<{ ticket: string; pageUrl: string }> {
    const result = await this.requestJson<QrResponse>(
      FIXED_BASE_URL,
      'ilink/bot/get_bot_qrcode?bot_type=3',
      'POST',
      { local_token_list: localTokens, base_info: this.baseInfo() },
      QR_FETCH_TIMEOUT_MS,
    );
    if ('timeout' in result) throw new Error(t('wechat.qrFetchTimeout'));
    const code = responseCode(result.json);
    if (code !== 0) throw new Error(`iLink QR ret=${code} ${result.json.errmsg ?? ''}`.trim());
    const ticket = String(result.json.qrcode ?? '');
    const pageUrl = String(result.json.qrcode_img_content ?? '');
    if (!ticket || !pageUrl) throw new Error(t('wechat.qrInvalidResponse'));
    return { ticket, pageUrl };
  }

  pollQrStatus(base: string, ticket: string, verifyCode?: string): Promise<ILinkResponse<QrStatusResponse>> {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(ticket)}`;
    if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
    return this.requestJson<QrStatusResponse>(base, endpoint, 'GET', null, LONG_POLL_TIMEOUT_MS + HTTP_TIMEOUT_GRACE_MS);
  }

  getUpdates(cursor: string, timeoutMs: number): Promise<ILinkResponse<UpdatesResponse>> {
    return this.requestJson<UpdatesResponse>(
      this.baseUrl || FIXED_BASE_URL,
      'ilink/bot/getupdates',
      'POST',
      { get_updates_buf: cursor, base_info: this.baseInfo() },
      timeoutMs + HTTP_TIMEOUT_GRACE_MS,
    );
  }

  async sendText(toUserId: string, text: string, contextToken: string): Promise<void> {
    const characters = Array.from(text);
    for (let offset = 0; offset < characters.length; offset += 4000) {
      const chunk = characters.slice(offset, offset + 4000).join('');
      const message: JsonObject = {
        from_user_id: '',
        to_user_id: toUserId,
        client_id: `journal-partner:${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text: chunk } }],
      };
      if (contextToken) message.context_token = contextToken;
      const result = await this.requestJson<JsonObject>(
        this.baseUrl || FIXED_BASE_URL,
        'ilink/bot/sendmessage',
        'POST',
        { msg: message, base_info: this.baseInfo() },
        SEND_TIMEOUT_MS,
      );
      if ('timeout' in result) throw new Error(t('wechat.sendTimeout'));
      const code = responseCode(result.json);
      if (code !== 0) throw new Error(`iLink send ret=${code}`);
    }
  }
}

export class WechatCaptureManager {
  private readonly host: WechatHost;
  private client: ILinkClient | null = null;
  private running = false;
  private disposed = false;
  private generation = 0;
  private statusKind: StatusKind;
  private statusDetail = '';
  private readonly statusListeners = new Set<() => void>();
  private loginModal: WechatQrLoginModal | null = null;

  constructor(host: WechatHost) {
    this.host = host;
    this.statusKind = Platform.isDesktopApp ? 'unbound' : 'mobile';
  }

  startWhenReady(): void {
    if (this.disposed) return;
    if (!Platform.isDesktopApp) {
      this.setStatus('mobile');
      return;
    }
    if (this.bindState() === 'bound' && this.host.settings.wechatEnabled) {
      void this.start();
    } else {
      this.setStatus(this.bindState() === 'bound' ? 'disabled' : 'unbound');
    }
  }

  unload(): void {
    this.disposed = true;
    this.loginModal?.close();
    this.loginModal = null;
    this.stop();
    this.statusListeners.clear();
  }

  watchStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  bindState(): 'bound' | 'unbound' {
    return this.getBotToken() && this.host.settings.wechatUserId ? 'bound' : 'unbound';
  }

  getStatusDescription(): string {
    switch (this.statusKind) {
      case 'mobile': return t('wechat.status.mobile');
      case 'unbound': return t('wechat.status.unbound');
      case 'disabled': return t('wechat.status.disabled');
      case 'connecting': return t('wechat.status.connecting');
      case 'connected': {
        const owner = this.host.settings.wechatUserId;
        const shortOwner = owner.length > 18 ? `${owner.slice(0, 18)}…` : owner;
        return t('wechat.status.connected', { owner: shortOwner });
      }
      case 'retrying': return t('wechat.status.retrying');
      case 'paused': return t('wechat.status.paused', { minutes: this.statusDetail });
      case 'error': return t('wechat.status.error', { msg: this.statusDetail });
    }
  }

  openLogin(): void {
    if (!Platform.isDesktopApp) {
      new Notice(t('wechat.desktopOnly'));
      return;
    }
    this.loginModal?.close();
    this.loginModal = new WechatQrLoginModal(this.host.app, this, () => {
      this.loginModal = null;
    });
    this.loginModal.open();
  }

  openDisconnectConfirmation(): void {
    const modal = new Modal(this.host.app);
    modal.onOpen = () => {
      modal.titleEl.setText(t('wechat.disconnectTitle'));
      modal.contentEl.createEl('p', { text: t('wechat.disconnectConfirm') });
      new Setting(modal.contentEl)
        .addButton(button => button.setButtonText(t('common.cancel')).onClick(() => modal.close()))
        .addButton(button => button.setButtonText(t('wechat.disconnect')).setWarning().onClick(() => {
          modal.close();
          void this.disconnect();
        }));
    };
    modal.onClose = () => modal.contentEl.empty();
    modal.open();
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.host.settings.wechatEnabled = enabled;
    await this.host.persistWechatState();
    if (enabled) this.startWhenReady();
    else {
      this.stop();
      this.setStatus(this.bindState() === 'bound' ? 'disabled' : 'unbound');
    }
  }

  async acceptLogin(credentials: {
    botToken: string;
    botId: string;
    userId: string;
    baseUrl: string;
  }): Promise<void> {
    if (this.disposed) return;
    this.stop();
    const sameBot = this.host.settings.wechatBotId === credentials.botId
      && this.host.settings.wechatUserId === credentials.userId;
    this.setBotToken(credentials.botToken);
    Object.assign(this.host.settings, {
      wechatEnabled: true,
      wechatBotId: credentials.botId,
      wechatUserId: credentials.userId,
      wechatBaseUrl: normalizeBaseUrl(credentials.baseUrl),
      wechatUpdateCursor: sameBot ? this.host.settings.wechatUpdateCursor : '',
      wechatRecentMessageIds: sameBot ? this.host.settings.wechatRecentMessageIds : [],
      wechatContextToken: sameBot ? this.host.settings.wechatContextToken : '',
      wechatPauseUntil: 0,
    });
    await this.host.persistWechatState();
    await this.start();
    new Notice(t('notice.wechatBound'));
  }

  private async disconnect(): Promise<void> {
    this.stop();
    this.setBotToken('');
    Object.assign(this.host.settings, {
      wechatEnabled: false,
      wechatBotId: '',
      wechatUserId: '',
      wechatBaseUrl: '',
      wechatUpdateCursor: '',
      wechatRecentMessageIds: [],
      wechatContextToken: '',
      wechatPauseUntil: 0,
    });
    await this.host.saveSettings();
    this.setStatus('unbound');
    new Notice(t('notice.wechatDisconnected'));
  }

  private secretStorage(): SecretStorageLike | null {
    return this.host.app.secretStorage;
  }

  getBotToken(): string {
    const fromSecretStorage = this.secretStorage()?.getSecret(SECRET_BOT_TOKEN);
    return fromSecretStorage || '';
  }

  private setBotToken(token: string): void {
    const storage = this.secretStorage();
    if (storage) {
      storage.setSecret(SECRET_BOT_TOKEN, token);
      return;
    }
    if (token) throw new Error(t('wechat.secretStorageRequired'));
  }

  private setStatus(kind: StatusKind, detail = ''): void {
    this.statusKind = kind;
    this.statusDetail = detail;
    for (const listener of this.statusListeners) listener();
  }

  private async start(): Promise<void> {
    if (this.disposed || this.running || !Platform.isDesktopApp) return;
    if (!this.host.settings.wechatEnabled || this.bindState() !== 'bound') return;
    this.running = true;
    this.generation += 1;
    const generation = this.generation;
    this.setStatus('connecting');
    let client: ILinkClient;
    try {
      client = await ILinkClient.create();
    } catch (error) {
      if (generation !== this.generation) return;
      this.running = false;
      this.setStatus('error', error instanceof Error ? error.message : String(error));
      return;
    }
    if (!this.running || this.disposed || generation !== this.generation) {
      client.destroy();
      return;
    }
    client.token = this.getBotToken();
    client.baseUrl = this.host.settings.wechatBaseUrl;
    this.client = client;
    void this.pollLoop(client, generation).catch(error => {
      if (!this.running || generation !== this.generation) return;
      console.error('[Journal Partner] WeChat pipeline stopped', error);
      this.running = false;
      this.client = null;
      this.setStatus('error', error instanceof Error ? error.message : String(error));
    });
  }

  private stop(): void {
    this.running = false;
    this.generation += 1;
    this.client?.destroy();
    this.client = null;
  }

  private async pollLoop(client: ILinkClient, generation: number): Promise<void> {
    let failures = 0;
    let pollTimeout = LONG_POLL_TIMEOUT_MS;
    const active = () => this.running && this.client === client && this.generation === generation;

    while (active()) {
      const pauseUntil = this.host.settings.wechatPauseUntil || 0;
      if (pauseUntil > Date.now()) {
        const minutes = Math.max(1, Math.ceil((pauseUntil - Date.now()) / 60_000));
        this.setStatus('paused', String(minutes));
        await sleep(Math.min(60_000, pauseUntil - Date.now()));
        continue;
      }

      try {
        const response = await client.getUpdates(this.host.settings.wechatUpdateCursor, pollTimeout);
        if (!active()) break;
        if ('timeout' in response) {
          failures = 0;
          this.setStatus('connected');
          continue;
        }

        const code = responseCode(response.json);
        if (code === STALE_TOKEN_ERRCODE) {
          this.host.settings.wechatPauseUntil = Date.now() + SESSION_PAUSE_MS;
          await this.host.persistWechatState();
          continue;
        }
        if (code !== 0) throw new Error(`iLink getupdates ret=${code}`);

        failures = 0;
        this.setStatus('connected');
        if (typeof response.json.longpolling_timeout_ms === 'number'
          && response.json.longpolling_timeout_ms > 0) {
          pollTimeout = response.json.longpolling_timeout_ms;
        }

        const messages = Array.isArray(response.json.msgs) ? response.json.msgs : [];
        for (const message of messages) {
          if (!active()) return;
          await this.handleIncoming(client, message);
        }
        if (typeof response.json.get_updates_buf === 'string') {
          this.host.settings.wechatUpdateCursor = response.json.get_updates_buf;
          await this.host.persistWechatState();
        }
      } catch (error) {
        if (!active()) break;
        failures += 1;
        console.warn('[Journal Partner] WeChat poll failed', error);
        this.setStatus('retrying');
        await sleep(failures >= 3 ? 30_000 : 2_000);
        if (failures >= 3) failures = 0;
      }
    }
  }

  private messageKey(message: WeixinMessage): string {
    if (message.seq !== undefined) return `s:${String(message.seq)}`;
    if (message.message_id !== undefined) return `m:${String(message.message_id)}`;
    return '';
  }

  private async handleIncoming(client: ILinkClient, message: WeixinMessage): Promise<void> {
    if (!message || message.message_type === 2 || message.message_state === 1) return;
    const fromUserId = message.from_user_id ?? '';
    if (!fromUserId || fromUserId !== this.host.settings.wechatUserId) return;

    const key = this.messageKey(message);
    if (key && this.host.settings.wechatRecentMessageIds.includes(key)) return;

    let text = '';
    let hasVoice = false;
    let hasText = false;
    for (const item of message.item_list ?? []) {
      if (item.type === 1 && item.text_item) {
        text += item.text_item.text ?? '';
        hasText = true;
      } else if (item.type === 3 && item.voice_item) {
        text += item.voice_item.text ?? '';
        hasVoice = true;
      }
    }
    if (!hasText && !hasVoice) return;

    const trimmed = text.trim();
    const body = hasVoice && !hasText
      ? `🎤 ${trimmed || t('wechat.voiceNoTranscript')}`
      : trimmed;
    if (!body) return;

    const createdAtMs = typeof message.create_time_ms === 'number' && message.create_time_ms > 0
      ? message.create_time_ms
      : undefined;
    const written = await this.host.writeWechatMessage(body, createdAtMs);
    if (!written) throw new Error(t('wechat.writeRejected'));

    if (key) {
      this.host.settings.wechatRecentMessageIds.push(key);
      if (this.host.settings.wechatRecentMessageIds.length > MAX_RECENT_MESSAGE_IDS) {
        this.host.settings.wechatRecentMessageIds.splice(
          0,
          this.host.settings.wechatRecentMessageIds.length - MAX_RECENT_MESSAGE_IDS,
        );
      }
    }
    if (message.context_token) this.host.settings.wechatContextToken = message.context_token;
    await this.host.persistWechatState();

    try {
      await client.sendText(fromUserId, t('wechat.replyRecorded'), this.host.settings.wechatContextToken);
    } catch (error) {
      console.warn('[Journal Partner] WeChat acknowledgement failed', error);
    }
  }
}

class WechatQrLoginModal extends Modal {
  private readonly manager: WechatCaptureManager;
  private readonly onFinished: () => void;
  private client: ILinkClient | null = null;
  private aborted = false;
  private statusEl!: HTMLElement;
  private qrWrapEl!: HTMLElement;
  private verifyWrapEl!: HTMLElement;
  private verifyResolver: ((value: string | null) => void) | null = null;

  constructor(app: App, manager: WechatCaptureManager, onFinished: () => void) {
    super(app);
    this.manager = manager;
    this.onFinished = onFinished;
  }

  onOpen(): void {
    this.titleEl.setText(t('wechat.qrTitle'));
    this.contentEl.addClass('jp-wechat-qr-modal');
    this.statusEl = this.contentEl.createEl('p', {
      cls: 'jp-wechat-qr-status',
      text: t('wechat.qrFetching'),
    });
    this.qrWrapEl = this.contentEl.createDiv({ cls: 'jp-wechat-qr-wrap' });
    this.verifyWrapEl = this.contentEl.createDiv({ cls: 'jp-wechat-verify-wrap' });
    this.verifyWrapEl.hide();
    this.contentEl.createEl('p', {
      cls: 'setting-item-description jp-wechat-qr-hint',
      text: t('wechat.qrHint'),
    });
    void this.run();
  }

  onClose(): void {
    this.aborted = true;
    this.verifyResolver?.(null);
    this.verifyResolver = null;
    this.client?.destroy();
    this.client = null;
    this.contentEl.empty();
    this.onFinished();
  }

  private setStatus(text: string): void {
    if (!this.aborted) this.statusEl.setText(text);
  }

  private renderQr(pageUrl: string): void {
    this.qrWrapEl.empty();
    try {
      const qr = qrcode(0, 'M');
      qr.addData(pageUrl);
      qr.make();
      this.qrWrapEl.createEl('img', {
        cls: 'jp-wechat-qr-image',
        attr: { src: qr.createDataURL(6, 8), alt: t('wechat.qrAlt') },
      });
    } catch {
      this.qrWrapEl.createEl('a', {
        text: t('wechat.openQrPage'),
        href: pageUrl,
        attr: { target: '_blank', rel: 'noopener' },
      });
    }
  }

  private askVerifyCode(): Promise<string | null> {
    this.verifyWrapEl.empty();
    this.verifyWrapEl.show();
    this.verifyWrapEl.createEl('p', { text: t('wechat.verifyPrompt') });
    let value = '';
    new Setting(this.verifyWrapEl)
      .addText(input => input.setPlaceholder(t('wechat.verifyCode')).onChange(next => { value = next.trim(); }))
      .addButton(button => button.setButtonText(t('wechat.verifySubmit')).setCta().onClick(() => {
        if (!value || !this.verifyResolver) return;
        this.verifyWrapEl.hide();
        this.verifyResolver(value);
        this.verifyResolver = null;
      }));
    return new Promise(resolve => { this.verifyResolver = resolve; });
  }

  private async run(): Promise<void> {
    let client: ILinkClient;
    try {
      client = await ILinkClient.create();
    } catch (error) {
      this.setStatus(t('wechat.qrFailed', {
        msg: error instanceof Error ? error.message : String(error),
      }));
      return;
    }
    this.client = client;
    const startedAt = Date.now();
    let refreshCount = 0;
    let pollBase = FIXED_BASE_URL;
    let verifyCode = '';

    try {
      let qr = await client.getQrCode(this.manager.getBotToken() ? [this.manager.getBotToken()] : []);
      let issuedAt = Date.now();
      this.renderQr(qr.pageUrl);
      this.setStatus(t('wechat.qrWaiting'));

      const refreshQr = async (): Promise<boolean> => {
        refreshCount += 1;
        if (refreshCount > 3) return false;
        qr = await client.getQrCode(this.manager.getBotToken() ? [this.manager.getBotToken()] : []);
        issuedAt = Date.now();
        verifyCode = '';
        pollBase = FIXED_BASE_URL;
        this.renderQr(qr.pageUrl);
        this.setStatus(t('wechat.qrRefreshed'));
        return true;
      };

      while (!this.aborted) {
        if (Date.now() - startedAt > LOGIN_TOTAL_TIMEOUT_MS) {
          this.setStatus(t('wechat.qrLoginTimeout'));
          return;
        }
        if (Date.now() - issuedAt > QR_LOCAL_TTL_MS) {
          if (!(await refreshQr())) {
            this.setStatus(t('wechat.qrTooManyRefreshes'));
            return;
          }
          continue;
        }

        let response: ILinkResponse<QrStatusResponse>;
        try {
          response = await client.pollQrStatus(pollBase, qr.ticket, verifyCode || undefined);
        } catch {
          await sleep(1000);
          continue;
        }
        if (this.aborted) return;
        if ('timeout' in response) continue;

        const status = String(response.json.status ?? '');
        if (status === 'confirmed') {
          const botToken = String(response.json.bot_token ?? '');
          const botId = String(response.json.ilink_bot_id ?? '');
          const userId = String(response.json.ilink_user_id ?? '');
          if (!botToken || !botId || !userId) {
            this.setStatus(t('wechat.qrInvalidResponse'));
            return;
          }
          await this.manager.acceptLogin({
            botToken,
            botId,
            userId,
            baseUrl: String(response.json.baseurl ?? ''),
          });
          this.close();
          return;
        }
        if (status === 'binded_redirect') {
          if (this.manager.bindState() === 'bound') {
            this.manager.startWhenReady();
            new Notice(t('notice.wechatAlreadyBound'));
            this.close();
          } else {
            this.setStatus(t('wechat.alreadyBoundNoCredential'));
          }
          return;
        }
        if (status === 'expired') {
          if (!(await refreshQr())) this.setStatus(t('wechat.qrTooManyRefreshes'));
          continue;
        }
        if (status === 'scaned_but_redirect') {
          pollBase = normalizeBaseUrl(String(response.json.redirect_host ?? '')) || FIXED_BASE_URL;
          continue;
        }
        if (status === 'need_verifycode') {
          this.setStatus(t('wechat.verifyNeeded'));
          verifyCode = await this.askVerifyCode() ?? '';
          if (!verifyCode) return;
          continue;
        }
        if (status === 'verify_code_blocked') {
          verifyCode = '';
          if (!(await refreshQr())) this.setStatus(t('wechat.verifyBlocked'));
          continue;
        }
        if (status === 'scaned') this.setStatus(t('wechat.qrScanned'));
        await sleep(1000);
      }
    } catch (error) {
      console.error('[Journal Partner] WeChat login failed', error);
      this.setStatus(t('wechat.qrFailed', {
        msg: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}
