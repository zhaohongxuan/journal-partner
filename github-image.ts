import { App, MarkdownView, Notice } from 'obsidian';
import type JournalPartnerPlugin from './main';

/**
 * GitHub Image Hosting Module
 * Handles pasting images and uploading them to GitHub
 */
export class GitHubImageHosting {
  constructor(
    private plugin: JournalPartnerPlugin,
    private app: App
  ) {}

  /**
   * Register paste event listener
   */
  register() {
    if (!this.plugin.settings.enableImageHosting) return;

    this.plugin.registerDomEvent(document, 'paste', (evt: ClipboardEvent) => {
      this.handleImagePaste(evt);
    });
  }

  /**
   * Handle image paste events
   */
  private async handleImagePaste(evt: ClipboardEvent) {
    const files = evt.clipboardData?.files;
    if (!files) return;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.type.startsWith('image/')) {
        evt.preventDefault();
        await this.uploadAndInsertImage(file);
        break;
      }
    }
  }

  /**
   * Upload image to GitHub and insert markdown link
   */
  private async uploadAndInsertImage(file: File) {
    const { gitHubToken, gitHubOwner, gitHubRepo, imagePath, gitHubBranch } = this.plugin.settings;

    if (!gitHubToken || !gitHubOwner || !gitHubRepo) {
      new Notice('❌ GitHub 配置不完整，请在插件设置中配置');
      return;
    }

    const notice = new Notice('📤 上传图片到 GitHub...');

    try {
      const blob = new Blob([file], { type: file.type });
      const filename = this.generateImageFilename(file.type);
      const url = await this.uploadImageToGitHub(blob, filename, {
        token: gitHubToken,
        owner: gitHubOwner,
        repo: gitHubRepo,
        branch: gitHubBranch,
        folder: imagePath,
      });

      notice.hide();

      // Insert markdown image link
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view) {
        const cursor = view.editor.getCursor();
        const markdownLink = '![image](' + url + ')\n';
        view.editor.replaceRange(markdownLink, cursor);
        new Notice('✅ 图片已上传并插入');
      }
    } catch (error) {
      notice.hide();
      const msg = error instanceof Error ? error.message : String(error);
      new Notice('❌ 上传失败: ' + msg);
    }
  }

  /**
   * Generate unique image filename with timestamp
   */
  private generateImageFilename(mimeType: string): string {
    const ext = mimeType.split('/')[1] || 'png';
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const random = Math.random().toString(36).slice(2, 7);
    return year + '-' + month + '-' + day + '_' + hours + '-' + minutes + '-' + seconds + '_' + random + '.' + ext;
  }

  /**
   * Upload image blob to GitHub REST API
   */
  private async uploadImageToGitHub(
    blob: Blob,
    filename: string,
    options: {
      token: string;
      owner: string;
      repo: string;
      branch: string;
      folder: string;
    }
  ): Promise<string> {
    // Convert blob to base64
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64Content = btoa(binary);

    const path = options.folder ? options.folder + '/' + filename : filename;
    const apiUrl = 'https://api.github.com/repos/' + options.owner + '/' + options.repo + '/contents/' + path;

    const response = await fetch(apiUrl, {
      method: 'PUT',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + options.token,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        message: 'Add image: ' + filename,
        content: base64Content,
        branch: options.branch,
        committer: {
          name: 'Journal Partner Plugin',
          email: 'noreply@obsidian.local',
        },
      }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error('GitHub API ' + response.status + ': ' + JSON.stringify(errData));
    }

    const data = await response.json();
    return data.download_url;
  }
}
