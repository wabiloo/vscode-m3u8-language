import { SCTE35 } from 'scte35';
import * as vscode from 'vscode';
import { HLSTagInfo } from '../types';

export class SCTE35Service {
    private panel: vscode.WebviewPanel | undefined;
    private parser: SCTE35;
    private tagDefinitions: Record<string, HLSTagInfo>;

    constructor(tagDefinitions: Record<string, HLSTagInfo>) {
        this.panel = undefined;
        this.parser = new SCTE35();
        this.tagDefinitions = tagDefinitions;
    }

    private createWebviewPanel(): vscode.WebviewPanel {
        const panel = vscode.window.createWebviewPanel(
            'scte35.view',
            'SCTE-35 Parser',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        panel.onDidDispose(() => {
            this.panel = undefined;
        });

        return panel;
    }

    private getWebviewContent(parsedData: any, originalPayload: string): string {
        return `<!DOCTYPE html>
        <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body {
                        padding: 20px;
                        font-family: var(--vscode-font-family);
                        color: var(--vscode-editor-foreground);
                        background-color: var(--vscode-editor-background);
                    }
                    .field {
                        margin: 4px 0;
                    }
                    .field-name {
                        font-weight: bold;
                        color: var(--vscode-textLink-foreground);
                    }
                    .field-value {
                        margin-left: 8px;
                    }
                    .field-value.string { color: var(--vscode-debugTokenExpression-string); }
                    .field-value.number { color: var(--vscode-debugTokenExpression-number); }
                    .field-value.boolean.true { color: var(--vscode-testing-iconPassed); }
                    .field-value.boolean.false { color: var(--vscode-testing-iconFailed); }
                    .field-value.null { color: var(--vscode-debugTokenExpression-error); }
                    .object-container {
                        margin-left: 20px;
                        padding-left: 10px;
                        border-left: 2px solid var(--vscode-textLink-activeForeground);
                    }
                    .original-payload {
                        font-family: var(--vscode-editor-font-family);
                        background-color: var(--vscode-textCodeBlock-background);
                        padding: 8px 12px;
                        border-radius: 4px;
                        word-break: break-all;
                    }
                    hr {
                        border: none;
                        height: 1px;
                        background-color: var(--vscode-textSeparator-foreground);
                        margin: 20px 0;
                    }
                    .toggle-container {
                        margin: 12px 0;
                        display: flex;
                        align-items: center;
                        gap: 8px;
                    }
                    .toggle-button {
                        background: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        padding: 4px 12px;
                        border-radius: 2px;
                        cursor: pointer;
                        font-family: var(--vscode-font-family);
                    }
                    .toggle-button:hover {
                        background: var(--vscode-button-hoverBackground);
                    }
                </style>
            </head>
            <body>
                <div class="original-payload">${originalPayload}</div>
                <hr>
                <div class="toggle-container">
                    <button class="toggle-button" onclick="showJson()">Show JSON</button>
                </div>
                <div id="formatted-view">
                    ${this.formatData(parsedData)}
                </div>
                <script>
                    const vscode = acquireVsCodeApi();
                    function showJson() {
                        vscode.postMessage({ command: 'showJson' });
                    }
                </script>
            </body>
        </html>`;
    }

    private formatPropertyName(name: string): string {
        // Special cases that should be fully capitalized
        const specialCases = ['crc', 'pid', 'pts', 'id', 'cw', 'upid'];
        
        // First split on camelCase
        const words = name
            .replace(/([A-Z])/g, ' $1') // Add space before capital letters
            .toLowerCase() // Convert to lowercase for consistent processing
            .trim()
            .split(' ');
        
        // Process each word
        const formattedWords = words.map(word => {
            // Check if the word (in lowercase) is in our special cases
            if (specialCases.includes(word.toLowerCase())) {
                return word.toUpperCase();
            }
            // Otherwise capitalize first letter only
            return word.charAt(0).toUpperCase() + word.slice(1);
        });
        
        return formattedWords.join(' ');
    }

    private getValueType(value: any): string {
        if (value === null) return 'null';
        if (Array.isArray(value)) return 'array';
        return typeof value;
    }

    private formatValue(value: any, propertyName: string = ''): string {
        const type = this.getValueType(value);
        switch (type) {
            case 'string':
                return `<span class="field-value string">"${value}"</span>`;
            case 'number':
                if (propertyName.toLowerCase().includes('duration')) {
                    const seconds = (value / 90000).toFixed(1);
                    return `<span class="field-value number">${value} (${seconds} s)</span>`;
                }
                return `<span class="field-value number">${value}</span>`;
            case 'boolean':
                return `<span class="field-value boolean ${value ? 'true' : 'false'}">${value}</span>`;
            case 'null':
                return `<span class="field-value null">null</span>`;
            default:
                return '';
        }
    }

    private formatData(data: any, level: number = 0): string {
        if (!data) return '<div>Invalid SCTE-35 data</div>';

        let html = '';
        
        for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
            const formattedName = this.formatPropertyName(key);
            const type = this.getValueType(value);

            html += '<div class="field">';
            html += `<span class="field-name">${formattedName}:</span>`;

            if (type === 'object' || type === 'array') {
                html += '<div class="object-container">';
                if (type === 'array' && Array.isArray(value)) {
                    value.forEach((item: unknown, index: number) => {
                        html += '<div class="field">';
                        html += `<span class="field-name">Item ${index + 1}:</span>`;
                        if (typeof item === 'object' && item !== null) {
                            html += '<div class="object-container">';
                            html += this.formatData(item, level + 1);
                            html += '</div>';
                        } else {
                            html += this.formatValue(item, key);
                        }
                        html += '</div>';
                    });
                } else {
                    html += this.formatData(value, level + 1);
                }
                html += '</div>';
            } else {
                html += this.formatValue(value, key);
            }

            html += '</div>';
        }

        return html;
    }

    private extractTag(line: string): { tag: string, params: string } | null {
        const match = line.match(/^#((?:EXT-)?(?:X-)?[A-Z0-9-]+)(?::(.*))?$/);
        if (!match) return null;
        return {
            tag: match[1],
            params: match[2] || ''
        };
    }

    private extractSCTE35Payload(line: string): string | null {
        const tagInfo = this.extractTag(line);
        if (!tagInfo) return null;

        const tagDef = this.tagDefinitions[tagInfo.tag];
        if (!tagDef?.scte35) return null;

        if (tagDef.scte35 === 'base64') {
            return tagInfo.params;
        } else if (tagDef.scte35 === 'hex') {
            // Handle hex format in DATERANGE tag
            const hexMatches = [
                tagInfo.params.match(/SCTE35-CMD=(0x[0-9A-Fa-f]+)/),
                tagInfo.params.match(/SCTE35-OUT=(0x[0-9A-Fa-f]+)/),
                tagInfo.params.match(/SCTE35-IN=(0x[0-9A-Fa-f]+)/)
            ];
            
            for (const match of hexMatches) {
                if (match) {
                    return match[1];
                }
            }
        }

        return null;
    }

    private async showJsonDocument(parsedData: any, originalPayload: string) {
        // Create a new object with _encoded as first property
        const jsonData = {
            _serialized: originalPayload,
            ...parsedData
        };

        const doc = await vscode.workspace.openTextDocument({
            content: JSON.stringify(jsonData, null, 2),
            language: 'json'
        });
        await vscode.window.showTextDocument(doc, {
            viewColumn: this.panel?.viewColumn || vscode.ViewColumn.Active,
            preview: true
        });
    }

    public parseSCTE35Line(line: string) {
        try {
            const payload = this.extractSCTE35Payload(line);
            if (!payload) {
                throw new Error('No SCTE-35 payload found');
            }

            let parsedData;
            if (payload.startsWith('0x')) {
                // Handle hex format
                parsedData = this.parser.parseFromHex(payload.substring(2));
            } else {
                // Handle base64 format
                parsedData = this.parser.parseFromB64(payload);
            }

            if (!this.panel) {
                this.panel = this.createWebviewPanel();
                
                // Set up the message handler
                this.panel.webview.onDidReceiveMessage(
                    message => {
                        switch (message.command) {
                            case 'showJson':
                                this.showJsonDocument(parsedData, payload);
                                return;
                        }
                    },
                    undefined,
                    []
                );
            }

            this.panel.webview.html = this.getWebviewContent(parsedData, payload);
            this.panel.reveal();

        } catch (error) {
            vscode.window.showErrorMessage(`Failed to parse SCTE-35 data: ${error}`);
        }
    }

    dispose() {
        if (this.panel) {
            this.panel.dispose();
        }
    }
} 