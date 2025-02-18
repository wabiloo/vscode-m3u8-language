import * as vscode from 'vscode';
import { ChromeDevToolsService } from '../services/ChromeDevToolsService';

export class NetworkInspectorProvider {
    private panel: vscode.WebviewPanel | undefined;
    private virtualDocUri: vscode.Uri;
    private virtualDocProvider: NetworkResponseProvider;
    private disposables: vscode.Disposable[] = [];

    constructor(
        private context: vscode.ExtensionContext,
        private chromeService: ChromeDevToolsService,
        private log: (message: string) => void
    ) {
        this.virtualDocUri = vscode.Uri.parse('m3u8-network://response');
        this.virtualDocProvider = new NetworkResponseProvider();
        this.disposables.push(
            vscode.workspace.registerTextDocumentContentProvider('m3u8-network', this.virtualDocProvider)
        );
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

        this.updateWebviewContent();

        // Open the virtual document for displaying responses
        vscode.workspace.openTextDocument(this.virtualDocUri).then(doc => {
            vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
        });

        // Handle messages from the webview
        this.panel.webview.onDidReceiveMessage(async message => {
            const cached = this.chromeService.getResponse(message.id);
            if (!cached) { return; }

            if (message.command === 'openResponse') {
                // Update the single virtual document
                this.virtualDocProvider.update(cached.body, this.virtualDocUri);
            } else if (message.command === 'openResponseNewTab') {
                // Open a new text document
                const doc = await vscode.workspace.openTextDocument({
                    content: cached.body,
                    language: 'm3u8'
                });
                vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
            }
        });

        // Handle panel disposal
        this.panel.onDidDispose(() => {
            this.panel = undefined;
        }, null, this.disposables);

        // Listen for new responses
        this.chromeService.onDidUpdateResponses(response => {
            if (this.panel) {
                this.panel.webview.postMessage({
                    command: 'addResponse',
                    id: response.id,
                    url: response.url
                });
            }
        });

        try {
            await this.chromeService.connect();
        } catch (error) {
            this.log(`Failed to connect to Chrome: ${error}`);
        }
    }

    private updateWebviewContent() {
        if (!this.panel) { return; }

        this.panel.webview.html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>M3U8 Network Inspector</title>
                <style>
                    body {
                        padding: 20px;
                        color: var(--vscode-foreground);
                        font-family: var(--vscode-font-family);
                        background-color: var(--vscode-editor-background);
                    }
                    .response-list {
                        list-style: none;
                        padding: 0;
                        margin: 0;
                    }
                    .response-item {
                        padding: 8px;
                        margin: 4px 0;
                        cursor: pointer;
                        background-color: var(--vscode-editor-lineHighlightBackground);
                        border: 1px solid var(--vscode-editor-lineHighlightBorder);
                        border-radius: 4px;
                    }
                    .response-item:hover {
                        background-color: var(--vscode-list-hoverBackground);
                    }
                    .empty-state {
                        text-align: center;
                        margin-top: 40px;
                        color: var(--vscode-descriptionForeground);
                    }
                </style>
            </head>
            <body>
                <h3>M3U8 Network Responses</h3>
                <p class="empty-state" id="empty-state">Waiting for M3U8 responses...</p>
                <ul class="response-list" id="responses"></ul>
                <script>
                    const vscode = acquireVsCodeApi();
                    const emptyState = document.getElementById('empty-state');
                    const responsesList = document.getElementById('responses');

                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.command === 'addResponse') {
                            emptyState.style.display = 'none';
                            const li = document.createElement('li');
                            li.className = 'response-item';
                            li.textContent = message.url;
                            li.onclick = (e) => {
                                if (e.ctrlKey || e.metaKey) {
                                    vscode.postMessage({ command: 'openResponseNewTab', id: message.id });
                                } else {
                                    vscode.postMessage({ command: 'openResponse', id: message.id });
                                }
                            };
                            responsesList.appendChild(li);
                        }
                    });
                </script>
            </body>
            </html>
        `;
    }

    dispose() {
        if (this.panel) {
            this.panel.dispose();
        }
        this.disposables.forEach(d => d.dispose());
    }
}

class NetworkResponseProvider implements vscode.TextDocumentContentProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    onDidChange = this._onDidChange.event;
    private content = '';

    provideTextDocumentContent(_uri: vscode.Uri): string {
        return this.content;
    }

    update(newContent: string, uri: vscode.Uri) {
        this.content = newContent;
        this._onDidChange.fire(uri);
    }

    dispose() {
        this._onDidChange.dispose();
    }
} 