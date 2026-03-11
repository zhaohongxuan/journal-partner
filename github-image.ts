import { App, MarkdownView, Notice, Modal } from 'obsidian';
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

    // Use document-level paste event to intercept before Obsidian processes it
    this.plugin.registerDomEvent(document, 'paste', (evt: ClipboardEvent) => {
      // Check if there are image files in clipboard
      const files = evt.clipboardData?.files;
      if (!files) return;

      let hasImage = false;
      for (let i = 0; i < files.length; i++) {
        if (files[i].type.startsWith('image/')) {
          hasImage = true;
          break;
        }
      }

      if (hasImage) {
        // Completely prevent default paste behavior
        evt.preventDefault();
        evt.stopPropagation();
        evt.stopImmediatePropagation();
        
        // Handle image upload
        this.handleImagePaste(evt);
      }
    }, true); // Use capture phase to intercept early
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
        evt.stopPropagation();
        evt.stopImmediatePropagation();
        
        // Create preview URL
        const reader = new FileReader();
        reader.onload = async (e) => {
          const previewUrl = e.target?.result as string;
          
          // Show confirmation modal and wait for user choice
          const action = await new Promise<'github' | 'local' | null>((resolve) => {
            const modal = new ImageConfirmModal(this.app, file, previewUrl, resolve);
            modal.open();
          });
          
          // Execute based on user choice
          if (action === 'github') {
            await this.uploadAndInsertImage(file);
          } else if (action === 'local') {
            // Use Obsidian's default paste behavior
            await this.saveImageLocally(file);
          }
          // If null, do nothing (user cancelled)
        };
        reader.readAsDataURL(file);
        break;
      }
    }
  }

  /**
   * Save image to Obsidian's attachment folder
   */
  private async saveImageLocally(file: File) {
    try {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view) return;

      const arrayBuffer = await file.arrayBuffer();
      const filename = file.name;
      
      // Save to Obsidian attachments folder
      const attachmentFolder = 'assets';
      try {
        await this.app.vault.createBinary(attachmentFolder + '/' + filename, arrayBuffer);
      } catch (err) {
        // If folder doesn't exist, create it first
        try {
          await this.app.vault.createFolder(attachmentFolder);
          await this.app.vault.createBinary(attachmentFolder + '/' + filename, arrayBuffer);
        } catch (e) {
          // Fallback to root
          await this.app.vault.createBinary(filename, arrayBuffer);
        }
      }

      // Insert markdown link
      const cursor = view.editor.getCursor();
      const linkPath = attachmentFolder + '/' + filename;
      view.editor.replaceRange('![image](' + linkPath + ')\n', cursor);
      new Notice('✅ 图片已保存到本地');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      new Notice('❌ 保存失败: ' + msg);
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
    // Construct raw GitHub URL directly
    const rawUrl = 'https://raw.githubusercontent.com/' + 
      options.owner + '/' + 
      options.repo + '/' + 
      options.branch + '/' + 
      path;
    return rawUrl;
  }
}

/**
 * Modal dialog for confirming image paste action
 */
class ImageConfirmModal extends Modal {
  action: 'github' | 'local' | null = null;

  constructor(
    app: App,
    private imageFile: File,
    private imageUrl: string,
    private onResolve: (action: 'github' | 'local' | null) => void
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    // Title
    const title = contentEl.createEl('h2', { text: '图片粘贴确认' });
    title.style.marginTop = '0';

    // Image preview
    const previewContainer = contentEl.createEl('div');
    previewContainer.style.cssText = 'margin: 16px 0; text-align: center;';

    const img = previewContainer.createEl('img');
    img.src = this.imageUrl;
    img.style.cssText = 'max-width: 100%; max-height: 300px; border-radius: 8px; border: 1px solid var(--divider-color);';

    // File info
    const infoContainer = contentEl.createEl('div');
    infoContainer.style.cssText = 'background: var(--background-secondary); padding: 12px; border-radius: 6px; margin: 12px 0; font-size: 0.9em; color: var(--text-muted);';
    infoContainer.innerHTML = '<strong>文件名:</strong> ' + this.imageFile.name + '<br/>' +
      '<strong>文件大小:</strong> ' + (this.imageFile.size / 1024).toFixed(2) + ' KB';

    // Action description
    const desc = contentEl.createEl('p');
    desc.textContent = '请选择如何处理这张图片：';
    desc.style.cssText = 'margin: 16px 0 12px; font-weight: 500;';

    // Button container - horizontal layout
    const buttonContainer = contentEl.createEl('div');
    buttonContainer.style.cssText = 'display: flex; flex-direction: row; gap: 10px; margin-top: 16px; justify-content: flex-end;';

    // Cancel button (leftmost)
    const cancelBtn = buttonContainer.createEl('button');
    cancelBtn.textContent = '❌ 取消';
    cancelBtn.style.cssText = 'flex: 1; padding: 12px 16px; background: var(--background-secondary); color: var(--text-normal); border: 1px solid var(--divider-color); border-radius: 8px; cursor: pointer; font-weight: 500; transition: all 0.2s ease;';
    cancelBtn.addEventListener('click', () => {
      this.action = null;
      this.close();
    });
    cancelBtn.addEventListener('mouseenter', () => {
      cancelBtn.style.background = 'var(--background-secondary-alt)';
      cancelBtn.style.transform = 'translateY(-2px)';
    });
    cancelBtn.addEventListener('mouseleave', () => {
      cancelBtn.style.background = 'var(--background-secondary)';
      cancelBtn.style.transform = 'translateY(0)';
    });

    // Local button (middle)
    const localBtn = buttonContainer.createEl('button');
    localBtn.textContent = '💾 保存到本地';
    localBtn.style.cssText = 'flex: 1; padding: 12px 16px; background: var(--background-tertiary); color: var(--text-normal); border: 1px solid var(--divider-color); border-radius: 8px; cursor: pointer; font-weight: 500; transition: all 0.2s ease;';
    localBtn.addEventListener('click', () => {
      this.action = 'local';
      this.close();
    });
    localBtn.addEventListener('mouseenter', () => {
      localBtn.style.background = 'var(--interactive-normal)';
      localBtn.style.transform = 'translateY(-2px)';
    });
    localBtn.addEventListener('mouseleave', () => {
      localBtn.style.background = 'var(--background-tertiary)';
      localBtn.style.transform = 'translateY(0)';
    });

    // GitHub button (primary, rightmost)
    const githubBtn = buttonContainer.createEl('button');
    githubBtn.textContent = '📤 上传到 GitHub';
    githubBtn.style.cssText = 'flex: 1.2; padding: 12px 16px; background: var(--interactive-accent); color: var(--text-on-accent); border: none; border-radius: 8px; cursor: pointer; font-weight: 600; transition: all 0.2s ease; box-shadow: 0 2px 8px rgba(124, 58, 237, 0.3);';
    githubBtn.addEventListener('click', () => {
      this.action = 'github';
      this.close();
    });
    githubBtn.addEventListener('mouseenter', () => {
      githubBtn.style.transform = 'translateY(-2px)';
      githubBtn.style.boxShadow = '0 4px 12px rgba(124, 58, 237, 0.4)';
    });
    githubBtn.addEventListener('mouseleave', () => {
      githubBtn.style.transform = 'translateY(0)';
      githubBtn.style.boxShadow = '0 2px 8px rgba(124, 58, 237, 0.3)';
    });
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
    // Trigger the callback with the user's choice
    this.onResolve(this.action);
  }
}
