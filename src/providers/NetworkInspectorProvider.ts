import * as vscode from 'vscode';
import { ChromeDevToolsService } from '../services/ChromeDevToolsService';

export class NetworkInspectorProvider {
    private panel: vscode.WebviewPanel | undefined;
    private disposables: vscode.Disposable[] = [];
    private responseListener: vscode.Disposable | undefined;
    private currentEditor: vscode.TextEditor | undefined;

    constructor(
        private context: vscode.ExtensionContext,
        private chromeService: ChromeDevToolsService,
        private log: (message: string) => void
    ) {
        // Register our custom m3u8-response scheme
        this.disposables.push(
            vscode.workspace.registerTextDocumentContentProvider('m3u8-response', {
                provideTextDocumentContent: () => ''
            })
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

        // Handle messages from the webview
        this.panel.webview.onDidReceiveMessage(async message => {
            if (message.command === 'chooseTab') {
                // Reconnect to Chrome to select a new tab
                try {
                    await this.chromeService.connect();
                } catch (error) {
                    this.log(`Failed to choose tab: ${error}`);
                }
                return;
            }

            if (message.command === 'refreshPage') {
                // Refresh the current page
                try {
                    await this.chromeService.refreshPage();
                } catch (error) {
                    this.log(`Failed to refresh page: ${error}`);
                }
                return;
            }

            const cached = this.chromeService.getResponse(message.id);
            if (!cached) { return; }

            if (message.command === 'openResponse') {
                await this.showResponseInTab(cached, false);
            } else if (message.command === 'openResponseNewTab') {
                await this.showResponseInTab(cached, true);
            }
        });

        // Handle panel disposal
        this.panel.onDidDispose(() => {
            if (this.responseListener) {
                this.responseListener.dispose();
                this.responseListener = undefined;
            }
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
                    title: response.title
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
                        display: flex;
                        flex-direction: column;
                        height: 100vh;
                        margin: 0;
                        box-sizing: border-box;
                    }
                    .toolbar {
                        margin-bottom: 10px;
                        display: flex;
                        gap: 8px;
                        align-items: center;
                    }
                    .search-box {
                        padding: 4px 8px;
                        background: var(--vscode-input-background);
                        color: var(--vscode-input-foreground);
                        border: 1px solid var(--vscode-input-border);
                        border-radius: 2px;
                        flex-grow: 1;
                    }
                    .search-box:focus {
                        outline: 1px solid var(--vscode-focusBorder);
                        border-color: transparent;
                    }
                    .table-container {
                        flex-grow: 1;
                        overflow: auto;
                        border: 1px solid var(--vscode-panel-border);
                        border-radius: 4px;
                    }
                    table {
                        width: 100%;
                        border-collapse: collapse;
                        table-layout: fixed;
                    }
                    th {
                        background: var(--vscode-editor-background);
                        position: sticky;
                        top: 0;
                        z-index: 1;
                        padding: 8px;
                        text-align: left;
                        border-bottom: 1px solid var(--vscode-panel-border);
                        cursor: pointer;
                        user-select: none;
                    }
                    th:hover {
                        background: var(--vscode-list-hoverBackground);
                    }
                    th::after {
                        content: '';
                        display: inline-block;
                        width: 0;
                        margin-left: 4px;
                    }
                    th.sort-asc::after {
                        content: '▲';
                    }
                    th.sort-desc::after {
                        content: '▼';
                    }
                    td {
                        padding: 6px 8px;
                        border-bottom: 1px solid var(--vscode-panel-border);
                    }
                    tr {
                        cursor: pointer;
                    }
                    tr:hover {
                        background: var(--vscode-list-hoverBackground);
                    }
                    .col-time { width: 80px; }
                    .col-size { width: 80px; text-align: right; }
                    .col-url { width: auto; }
                    .empty-state {
                        text-align: center;
                        padding: 40px;
                        color: var(--vscode-descriptionForeground);
                    }
                    .header {
                        margin-bottom: 12px;
                        color: var(--vscode-foreground);
                        display: flex;
                        align-items: center;
                        gap: 8px;
                    }
                    .header-text {
                        flex-grow: 1;
                    }
                    .header-title {
                        font-weight: 600;
                        margin-bottom: 4px;
                    }
                    .header-url {
                        color: var(--vscode-descriptionForeground);
                        font-size: 0.9em;
                    }
                    .legend {
                        margin-top: 8px;
                        padding: 8px;
                        color: var(--vscode-descriptionForeground);
                        font-size: 0.9em;
                        border-top: 1px solid var(--vscode-panel-border);
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                    }
                    .keyboard-shortcut {
                        padding: 2px 4px;
                        background: var(--vscode-textBlockQuote-background);
                        border-radius: 3px;
                        font-family: var(--vscode-editor-font-family);
                    }
                    .button {
                        padding: 4px 8px;
                        background: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        border-radius: 2px;
                        cursor: pointer;
                    }
                    .button:hover {
                        background: var(--vscode-button-hoverBackground);
                    }
                    .button:active {
                        background: var(--vscode-button-background);
                        opacity: 0.8;
                    }
                </style>
            </head>
            <body>
                <div class="header">
                    <div class="header-text">
                        <div class="header-title" id="header-title"></div>
                        <div class="header-url" id="header-url"></div>
                    </div>
                    <div style="display: flex; gap: 8px;">
                    <button class="button" id="choose-tab-button" title="Choose a different tab">Choose tab</button>
                    <button class="button" id="refresh-page-button" title="Refresh page (⌘R)">Refresh page</button>
                    </div>
                </div>
                <div class="toolbar">
                    <input type="text" class="search-box" placeholder="Filter URLs..." id="search">
                </div>
                <div class="table-container">
                    <table>
                        <thead>
                            <tr>
                                <th class="col-time" data-sort="timestamp">Time</th>
                                <th class="col-size" data-sort="size">Size</th>
                                <th class="col-url" data-sort="url">URL</th>
                            </tr>
                        </thead>
                        <tbody id="responses"></tbody>
                    </table>
                    <div id="empty-state" class="empty-state">Waiting for M3U8 responses...</div>
                </div>
                <div class="legend">
                    <div>
                        <span class="keyboard-shortcut">${process.platform === 'darwin' ? '⌘' : 'Ctrl'}+Click</span> to open response in a new tab
                    </div>
                    <button class="button" id="clear-button">Clear</button>
                </div>
                <script>
                    const vscode = acquireVsCodeApi();
                    const emptyState = document.getElementById('empty-state');
                    const responsesTable = document.getElementById('responses');
                    const searchInput = document.getElementById('search');
                    const headerTitle = document.getElementById('header-title');
                    const headerUrl = document.getElementById('header-url');
                    let responses = [];
                    let currentSort = { column: 'timestamp', direction: 'desc' };

                    function getBasename(url) {
                        try {
                            const urlObj = new URL(url);
                            const pathname = urlObj.pathname;
                            return pathname.split('/').pop() || urlObj.hostname;
                        } catch {
                            return url.split('/').pop() || url;
                        }
                    }

                    function formatTime(date) {
                        const pad = (n) => n.toString().padStart(2, '0');
                        return \`\${pad(date.getHours())}:\${pad(date.getMinutes())}:\${pad(date.getSeconds())}\`;
                    }

                    function updateHeader(url, title) {
                        if (!url) return;
                        const time = formatTime(new Date());
                        headerTitle.textContent = title || 'Monitoring...';
                        headerUrl.textContent = \`\${getBasename(url)} (\${time})\`;
                    }

                    function formatBytes(bytes) {
                        if (bytes === undefined || bytes === null || bytes === 0) return '0 B';
                        const k = 1024;
                        const sizes = ['B', 'KB', 'MB', 'GB'];
                        const i = Math.floor(Math.log(bytes) / Math.log(k));
                        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
                    }

                    function formatTimestamp(timestamp) {
                        if (!timestamp) return '';
                        const date = new Date(timestamp);
                        if (isNaN(date.getTime())) return '';
                        
                        const pad = (n) => n.toString().padStart(2, '0');
                        const hours = pad(date.getHours());
                        const minutes = pad(date.getMinutes());
                        const seconds = pad(date.getSeconds());
                        const millis = pad(date.getMilliseconds()).slice(0, 2);
                        return \`\${hours}:\${minutes}:\${seconds}.\${millis}\`;
                    }

                    function sortResponses() {
                        responses.sort((a, b) => {
                            let valueA = a[currentSort.column];
                            let valueB = b[currentSort.column];
                            
                            if (currentSort.column === 'timestamp' || currentSort.column === 'size') {
                                valueA = Number(valueA) || 0;
                                valueB = Number(valueB) || 0;
                            }
                            
                            if (valueA < valueB) return currentSort.direction === 'asc' ? -1 : 1;
                            if (valueA > valueB) return currentSort.direction === 'asc' ? 1 : -1;
                            return 0;
                        });
                    }

                    function filterResponses(searchText) {
                        return responses.filter(response => 
                            response.url.toLowerCase().includes(searchText.toLowerCase())
                        );
                    }

                    function updateTable() {
                        const searchText = searchInput.value;
                        const filteredResponses = filterResponses(searchText);
                        
                        responsesTable.innerHTML = filteredResponses.map(response => \`
                            <tr data-id="\${response.id}">
                                <td class="col-time">\${formatTimestamp(response.timestamp)}</td>
                                <td class="col-size">\${formatBytes(response.size)}</td>
                                <td class="col-url">\${response.url}</td>
                            </tr>
                        \`).join('');

                        emptyState.style.display = filteredResponses.length ? 'none' : 'block';
                    }

                    // Set up sorting
                    document.querySelectorAll('th[data-sort]').forEach(th => {
                        th.addEventListener('click', () => {
                            const column = th.dataset.sort;
                            if (currentSort.column === column) {
                                currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
                            } else {
                                currentSort.column = column;
                                currentSort.direction = 'desc';
                            }

                            // Update sort indicators
                            document.querySelectorAll('th').forEach(header => {
                                header.classList.remove('sort-asc', 'sort-desc');
                            });
                            th.classList.add(\`sort-\${currentSort.direction}\`);

                            sortResponses();
                            updateTable();
                        });
                    });

                    // Set up filtering
                    searchInput.addEventListener('input', () => {
                        updateTable();
                    });

                    // Handle row clicks
                    responsesTable.addEventListener('click', (e) => {
                        const row = e.target.closest('tr');
                        if (!row) return;
                        
                        const id = row.dataset.id;
                        if (e.ctrlKey || e.metaKey) {
                            vscode.postMessage({ command: 'openResponseNewTab', id });
                        } else {
                            vscode.postMessage({ command: 'openResponse', id });
                        }
                    });

                    // Handle clear button click
                    document.getElementById('clear-button').addEventListener('click', () => {
                        responses = [];
                        updateTable();
                    });

                    // Handle refresh button clicks
                    document.getElementById('choose-tab-button').addEventListener('click', () => {
                        vscode.postMessage({ command: 'chooseTab' });
                    });

                    document.getElementById('refresh-page-button').addEventListener('click', () => {
                        vscode.postMessage({ command: 'refreshPage' });
                    });

                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.command === 'addResponse') {
                            if (message.id === 'tab-info') {
                                // Clear existing responses when switching tabs
                                responses = [];
                                updateTable();
                                // Update header with selected tab info
                                updateHeader(message.url, message.title);
                            } else {
                                responses.unshift({
                                    id: message.id,
                                    url: message.url,
                                    timestamp: message.timestamp,
                                    size: message.size
                                });
                                
                                sortResponses();
                                updateTable();
                            }
                        }
                    });
                </script>
            </body>
            </html>
        `;
    }

    private async showResponseInTab(cached: { url: string; body: string; timestamp: number }, forceNewTab: boolean = false) {
        const basename = this.getBasename(cached.url);
        const timestamp = this.formatTimestamp(cached.timestamp);
        const tabTitle = `${basename} (${timestamp})`;

        // Add comment line after #EXTM3U
        let modifiedBody = cached.body;
        if (modifiedBody.startsWith('#EXTM3U')) {
            const date = new Date(cached.timestamp);
            modifiedBody = modifiedBody.replace('#EXTM3U', `#EXTM3U\n# ${this.formatTimestamp(cached.timestamp)} - ${cached.url}`);
        }

        if (forceNewTab || !this.currentEditor || this.currentEditor.document.isClosed) {
            // Create a new untitled document
            const doc = await vscode.workspace.openTextDocument({ 
                content: modifiedBody,
                language: 'm3u8'
            });
            
            this.currentEditor = await vscode.window.showTextDocument(doc, {
                preview: false,
                viewColumn: vscode.ViewColumn.Beside,
                preserveFocus: true
            });
        } else {
            // Update content of existing document
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(
                this.currentEditor.document.positionAt(0),
                this.currentEditor.document.positionAt(this.currentEditor.document.getText().length)
            );
            edit.replace(this.currentEditor.document.uri, fullRange, modifiedBody);
            await vscode.workspace.applyEdit(edit);
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