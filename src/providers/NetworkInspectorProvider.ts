import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChromeDevToolsService } from '../services/ChromeDevToolsService';
import { PlaylistUrlService } from '../services/PlaylistUrlService';

export class NetworkInspectorProvider {
    private panel: vscode.WebviewPanel | undefined;
    private disposables: vscode.Disposable[] = [];
    private responseListener: vscode.Disposable | undefined;
    private currentEditor: vscode.TextEditor | undefined;
    private openResponseIds: Set<string> = new Set();
    private currentPreviewId: string | undefined;

    constructor(
        private context: vscode.ExtensionContext,
        private chromeService: ChromeDevToolsService,
        private log: (message: string) => void,
        private playlistUrlService: PlaylistUrlService
    ) {
        // Register our custom m3u8-response scheme
        this.disposables.push(
            vscode.workspace.registerTextDocumentContentProvider('m3u8-response', {
                provideTextDocumentContent: () => ''
            })
        );
    }

    private getWebviewContent(): string {
        const templatePath = path.join(this.context.extensionPath, 'out', 'templates', 'networkInspector.html');
        let content = fs.readFileSync(templatePath, 'utf8');
        
        // Replace platform-specific keyboard shortcut
        content = content.replace('${process.platform === \'darwin\' ? \'⌘\' : \'Ctrl\'}', 
            process.platform === 'darwin' ? '⌘' : 'Ctrl');
        
        return content;
    }

    async show() {
        if (this.panel) {
            this.panel.reveal();
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'networkInspector',
            'M3U8 Network Inspector',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        this.panel.webview.html = this.getWebviewContent();

        // Handle messages from the webview
        this.panel.webview.onDidReceiveMessage(async message => {
            if (message.command === 'debug') {
                this.log(message.message);
                return;
            }

            if (message.command === 'addTab') {
                // Connect to Chrome to add a new tab
                try {
                    await this.chromeService.connect();
                } catch (error) {
                    this.log(`Failed to add tab: ${error}`);
                }
                return;
            }

            if (message.command === 'removeTab') {
                try {
                    await this.chromeService.disconnectTab(message.tabId);
                } catch (error) {
                    this.log(`Failed to remove tab: ${error}`);
                }
                return;
            }

            if (message.command === 'setTabLabel') {
                try {
                    await this.chromeService.setTabLabel(message.tabId, message.label);
                } catch (error) {
                    this.log(`Failed to set tab label: ${error}`);
                }
                return;
            }

            if (message.command === 'togglePause') {
                try {
                    this.chromeService.togglePause();
                } catch (error) {
                    this.log(`Failed to toggle pause: ${error}`);
                }
                return;
            }

            if (message.command === 'refreshPage') {
                // Refresh the specified tab
                try {
                    await this.chromeService.refreshPage(message.tabId);
                } catch (error) {
                    this.log(`Failed to refresh page: ${error}`);
                }
                return;
            }

            if (message.command === 'getResponseBody') {
                const cached = this.chromeService.getResponse(message.id);
                if (cached) {
                    this.panel?.webview.postMessage({
                        command: 'responseBody',
                        id: message.id,
                        body: cached.body
                    });
                }
                return;
            }

            const cached = this.chromeService.getResponse(message.id);
            if (!cached) { return; }

            if (message.command === 'openResponse') {
                await this.showResponseInTab({ ...cached, id: message.id }, false);
            } else if (message.command === 'openResponseNewTab') {
                await this.showResponseInTab({ ...cached, id: message.id }, true);
            }
        });

        // Handle panel disposal
        this.panel.onDidDispose(() => {
            if (this.responseListener) {
                this.responseListener.dispose();
                this.responseListener = undefined;
            }
            // Clean up all CDP sessions when the panel is closed
            this.chromeService.disconnectAllTabs();
            this.panel = undefined;
        }, null, this.disposables);

        // Clean up any existing response listener
        if (this.responseListener) {
            this.responseListener.dispose();
        }

        // Listen for new responses
        this.responseListener = this.chromeService.onDidUpdateResponses(response => {
            if (this.panel) {
                this.panel.webview.postMessage({
                    command: 'addResponse',
                    id: response.id,
                    url: response.url,
                    timestamp: response.timestamp,
                    size: response.size,
                    title: response.title,
                    isValidM3U8: response.isValidM3U8,
                    isMultiVariant: response.isMultiVariant,
                    mediaSequence: response.mediaSequence,
                    discontinuitySequence: response.discontinuitySequence,
                    fromCache: response.fromCache,
                    status: response.status,
                    statusText: response.statusText,
                    tabId: response.tabId,
                    tabColor: response.tabColor,
                    tabLabel: response.tabLabel
                });
            }
        });

        try {
            await this.chromeService.connect();
        } catch (error) {
            this.log(`Failed to connect to Chrome: ${error}`);
        }
    }

    private notifyOpenStateChanged(id: string, isOpen: boolean, isPermanent: boolean = false) {
        if (this.panel) {
            this.panel.webview.postMessage({
                command: 'updateOpenState',
                id,
                isOpen,
                isPermanent
            });
        }
    }

    private async showResponseInTab(cached: { url: string; body: string; timestamp: number; id: string }, forceNewTab: boolean = false) {
        const basename = this.getBasename(cached.url);
        const timestamp = this.formatTimestamp(cached.timestamp);
        const tabTitle = `${basename} (${timestamp})`;

        // Add comment as first line
        let modifiedBody = `# (${timestamp}) ${basename}\n# ${cached.url}\n${cached.body}`;

        // Clear previous preview tab indicator if this is not a new tab
        if (!forceNewTab && this.currentPreviewId && this.currentPreviewId !== cached.id) {
            this.notifyOpenStateChanged(this.currentPreviewId, false, false);
        }

        if (forceNewTab || !this.currentEditor || this.currentEditor.document.isClosed) {
            // Create a new untitled document
            const doc = await vscode.workspace.openTextDocument({ 
                content: modifiedBody,
                language: 'm3u8'
            });
            
            // Store the base URL in the PlaylistUrlService
            this.playlistUrlService.setDocumentBaseUrl(doc.uri.toString(), cached.url);
            
            this.currentEditor = await vscode.window.showTextDocument(doc, {
                preview: true,
                preserveFocus: true,
                viewColumn: vscode.ViewColumn.Beside
            });

            if (!forceNewTab) {
                this.currentPreviewId = cached.id;
            }

            // Track that this response has an open tab
            this.openResponseIds.add(cached.id);
            this.notifyOpenStateChanged(cached.id, true, forceNewTab);

            // Listen for document close
            const disposable = vscode.workspace.onDidCloseTextDocument(closedDoc => {
                if (closedDoc === doc) {
                    this.openResponseIds.delete(cached.id);
                    this.notifyOpenStateChanged(cached.id, false, forceNewTab);
                    if (this.currentPreviewId === cached.id) {
                        this.currentPreviewId = undefined;
                    }
                    // Clean up the base URL when document is closed
                    this.playlistUrlService.removeDocumentBaseUrl(doc.uri.toString());
                    disposable.dispose();
                }
            });
            this.disposables.push(disposable);
        } else {
            // Update content of existing document
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(
                this.currentEditor.document.positionAt(0),
                this.currentEditor.document.positionAt(this.currentEditor.document.getText().length)
            );
            edit.replace(this.currentEditor.document.uri, fullRange, modifiedBody);
            await vscode.workspace.applyEdit(edit);
            
            // Update the base URL
            this.playlistUrlService.setDocumentBaseUrl(this.currentEditor.document.uri.toString(), cached.url);
            
            if (!forceNewTab) {
                this.currentPreviewId = cached.id;
            }

            // Update the indicator for the new response
            this.openResponseIds.add(cached.id);
            this.notifyOpenStateChanged(cached.id, true, forceNewTab);

            // Ensure the editor stays in the same column without focus
            await vscode.window.showTextDocument(this.currentEditor.document, {
                preview: true,
                preserveFocus: true,
                viewColumn: this.currentEditor.viewColumn
            });
        }
    }

    private getBasename(url: string): string {
        try {
            const urlObj = new URL(url);
            const pathname = urlObj.pathname;
            return pathname.split('/').pop() || urlObj.hostname;
        } catch {
            return url.split('/').pop() || url;
        }
    }

    private formatTimestamp(timestamp: number): string {
        const date = new Date(timestamp);
        if (isNaN(date.getTime())) return '';
        
        const pad = (n: number) => n.toString().padStart(2, '0');
        const hours = pad(date.getHours());
        const minutes = pad(date.getMinutes());
        const seconds = pad(date.getSeconds());
        const millis = pad(date.getMilliseconds()).slice(0, 2);
        return `${hours}:${minutes}:${seconds}.${millis}`;
    }

    dispose() {
        if (this.responseListener) {
            this.responseListener.dispose();
        }
        if (this.panel) {
            this.panel.dispose();
        }
        this.disposables.forEach(d => d.dispose());
    }
} 