import * as vscode from 'vscode';
import { ChromeDevToolsService } from '../services/ChromeDevToolsService';

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
                        padding: 4px 8px;
                        border-bottom: 1px solid var(--vscode-panel-border);
                    }
                    tr {
                        cursor: pointer;
                    }
                    tr:hover {
                        background-color: var(--vscode-list-hoverBackground);
                    }
                    tr.highlighted {
                        background-color: var(--vscode-editor-findMatchHighlightBackground);
                    }
                    tr.highlighted:hover {
                        background: var(--vscode-editor-findMatchHighlightBackground);
                        filter: brightness(110%);
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
                    .tab-indicator {
                        display: inline-block;
                        width: 8px;
                        height: 8px;
                        border-radius: 50%;
                        margin: 0 auto;
                        vertical-align: middle;
                        position: relative;
                    }

                    .tab-indicator.permanent {
                        background-color: var(--vscode-charts-blue);
                    }

                    .tab-indicator.preview {
                        border: 1px solid var(--vscode-charts-blue);
                        background: transparent;
                    }

                    .tab-indicator.combined {
                        background-color: var(--vscode-charts-blue);
                    }

                    .tab-indicator.combined::after {
                        content: '';
                        position: absolute;
                        top: -2px;
                        left: -2px;
                        right: -2px;
                        bottom: -2px;
                        border: 1px solid var(--vscode-charts-blue);
                        border-radius: 50%;
                    }
                    
                    tr:not(.has-tab):not(.is-preview) .tab-indicator {
                        visibility: hidden;
                    }

                    .col-tab { 
                        width: 20px; 
                        text-align: center;
                        padding: 6px 0;
                    }

                    tr:nth-child(even) {
                        background-color: rgba(128, 128, 128, 0.04);
                    }

                    tr:hover {
                        background-color: var(--vscode-list-hoverBackground);
                    }

                    tr.highlighted {
                        background-color: var(--vscode-editor-findMatchHighlightBackground);
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
                    <button class="button" id="choose-tab-button" title="Choose a tab from the browser to hook into">Select tab</button>
                    <button class="button" id="refresh-page-button" title="Refresh the content of the tab (⌘R)">Refresh page</button>
                    </div>
                </div>
                <div class="toolbar">
                    <input type="text" class="search-box" placeholder="Filter request URLs..." id="search">
                    <input type="text" class="search-box" placeholder="Highlight responses containing..." id="highlight">
                </div>
                <div class="table-container">
                    <table>
                        <thead>
                            <tr>
                                <th class="col-time" data-sort="timestamp">Time</th>
                                <th class="col-size" data-sort="size">Size</th>
                                <th class="col-tab"></th>
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
                    const highlightInput = document.getElementById('highlight');
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

                    function shouldHighlight(response) {
                        const highlightText = highlightInput.value.toLowerCase();
                        if (!highlightText) return false;
                        
                        // If we already have the body in our cache, use it
                        if (response.body) {
                            return response.body.toLowerCase().includes(highlightText);
                        }
                        
                        // Otherwise, request it and mark as pending
                        pendingHighlights.add(response.id);
                        vscode.postMessage({ 
                            command: 'getResponseBody', 
                            id: response.id 
                        });
                        
                        return false;
                    }

                    let pendingHighlights = new Set();

                    function updateTable() {
                        const searchText = searchInput.value;
                        const filteredResponses = filterResponses(searchText);
                        
                        responsesTable.innerHTML = filteredResponses.map(response => {
                            const isHighlighted = shouldHighlight(response);
                            const hasTab = response.hasTab;
                            const isPreview = response.isPreview;
                            let indicatorClass = '';
                            if (hasTab && isPreview) {
                                indicatorClass = 'combined';
                            } else if (hasTab) {
                                indicatorClass = 'permanent';
                            } else if (isPreview) {
                                indicatorClass = 'preview';
                            }
                            return \`
                                <tr data-id="\${response.id}" class="\${isHighlighted ? 'highlighted' : ''} \${hasTab ? 'has-tab' : ''} \${isPreview ? 'is-preview' : ''}">
                                    <td class="col-time">\${formatTimestamp(response.timestamp)}</td>
                                    <td class="col-size">\${formatBytes(response.size)}</td>
                                    <td class="col-tab">
                                        <span class="tab-indicator \${indicatorClass}"></span>
                                    </td>
                                    <td class="col-url">\${response.url}</td>
                                </tr>
                            \`;
                        }).join('');

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

                    // Set up filtering and highlighting
                    searchInput.addEventListener('input', () => {
                        updateTable();
                    });

                    highlightInput.addEventListener('input', () => {
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
                                    size: message.size,
                                    hasTab: false,
                                    isPreview: false
                                });
                                
                                sortResponses();
                                updateTable();
                            }
                        } else if (message.command === 'responseBody') {
                            // Update the response body in our cache
                            const response = responses.find(r => r.id === message.id);
                            if (response) {
                                response.body = message.body;
                                if (pendingHighlights.has(message.id)) {
                                    pendingHighlights.delete(message.id);
                                    updateTable();
                                }
                            }
                        } else if (message.command === 'updateOpenState') {
                            const response = responses.find(r => r.id === message.id);
                            if (response) {
                                if (message.isPermanent) {
                                    response.hasTab = message.isOpen;
                                } else {
                                    response.isPreview = message.isOpen;
                                }
                                updateTable();
                            }
                        }
                    });
                </script>
            </body>
            </html>
        `;
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