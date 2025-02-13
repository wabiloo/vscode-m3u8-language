import { SCTE35 } from 'scte35';
import * as vscode from 'vscode';
import { HLSTagInfo } from '../types';

export class SCTE35Service {
    private panel: vscode.WebviewPanel | undefined;
    private parser: SCTE35;
    private tagDefinitions: Record<string, HLSTagInfo>;

    private readonly UPID_TYPES = {
        0x00: 'Not Used',
        0x01: 'User Defined (deprecated)',
        0x02: 'ISCI (deprecated)',
        0x03: 'Ad-ID',
        0x04: 'UMID',
        0x05: 'ISAN (deprecated)',
        0x06: 'ISAN',
        0x07: 'TID',
        0x08: 'TI',
        0x09: 'ADI',
        0x0A: 'EIDR',
        0x0B: 'ATSC Content Identifier',
        0x0C: 'MPU',
        0x0D: 'MID',
        0x0E: 'ADS Information',
        0x0F: 'URI',
        0x10: 'UUID',
        0x11: 'SCR'
    } as const;

    private readonly SEGMENTATION_TYPES = {
        0x00: 'Not Indicated',
        0x01: 'Content Identification',
        0x02: 'Call Ad Server',
        0x10: 'Program Start',
        0x11: 'Program End',
        0x12: 'Program Early Termination',
        0x13: 'Program Breakaway',
        0x14: 'Program Resumption',
        0x15: 'Program Runover Planned',
        0x16: 'Program Runover Unplanned',
        0x17: 'Program Overlap Start',
        0x18: 'Program Blackout Override',
        0x19: 'Program Start - In Progress',
        0x20: 'Chapter Start',
        0x21: 'Chapter End',
        0x22: 'Break Start',
        0x23: 'Break End',
        0x24: 'Opening Credit Start',
        0x25: 'Opening Credit End',
        0x26: 'Closing Credit Start',
        0x27: 'Closing Credit End',
        0x30: 'Provider Advertisement Start',
        0x31: 'Provider Advertisement End',
        0x32: 'Distributor Advertisement Start',
        0x33: 'Distributor Advertisement End',
        0x34: 'Provider Placement Opportunity Start',
        0x35: 'Provider Placement Opportunity End',
        0x36: 'Distributor Placement Opportunity Start',
        0x37: 'Distributor Placement Opportunity End',
        0x38: 'Provider Overlay Placement Opportunity Start',
        0x39: 'Provider Overlay Placement Opportunity End',
        0x3A: 'Distributor Overlay Placement Opportunity Start',
        0x3B: 'Distributor Overlay Placement Opportunity End',
        0x40: 'Unscheduled Event Start',
        0x41: 'Unscheduled Event End',
        0x50: 'Network Start',
        0x51: 'Network End',
        0x60: 'Alternative Content Opportunity Start',
        0x61: 'Alternative Content Opportunity End'
    } as const;

    private readonly COMMAND_TYPES = {
        0x00: 'Splice Null',
        0x05: 'Splice Insert',
        0x06: 'Time Signal',
        0x07: 'Bandwidth Reservation',
        0xFF: 'Private Command'
    } as const;

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
                        color: var(--vscode-textLink-foreground);
                    }
                    .field-name.length {
                        color: var(--vscode-editorLineNumber-foreground);
                    }
                    .field-value {
                        margin-left: 8px;
                        font-weight: bold;
                    }
                    .field-value.string { color: var(--vscode-debugTokenExpression-string); }
                    .field-value.number { color: var(--vscode-debugTokenExpression-number); }
                    .field-value.boolean.true { color: var(--vscode-testing-iconPassed); }
                    .field-value.boolean.false { color: var(--vscode-testing-iconFailed); }
                    .field-value.null { color: var(--vscode-debugTokenExpression-error); }
                    .field-value .description {
                        margin-left: 12px;
                        background-color: var(--vscode-badge-background);
                        color: var(--vscode-badge-foreground);
                        padding: 2px 6px;
                        border-radius: 4px;
                        font-size: 0.9em;
                        font-weight: normal;
                    }
                    .field-value .description.mapped {
                        background-color: var(--vscode-debugConsole-warningForeground);
                        color: var(--vscode-editor-background);
                    }
                    .field-value .description.segmentation {
                        background-color: var(--vscode-debugConsole-infoForeground);
                        color: var(--vscode-editor-background);
                    }
                    .field-value .bracket {
                        color: var(--vscode-symbolIcon-arrayForeground);
                        opacity: 0.8;
                    }
                    .field-value .bracket:first-of-type {
                        margin-left: 12px;
                    }
                    .field-value .description {
                        color: var(--vscode-textPreformat-foreground);
                        opacity: 0.8;
                    }
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
                    const state = {
                        parsedData: ${JSON.stringify(parsedData)},
                        originalPayload: '${originalPayload}'
                    };
                    vscode.setState(state);
                    function showJson() {
                        const currentState = vscode.getState();
                        vscode.postMessage({ 
                            command: 'showJson',
                            data: currentState
                        });
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

    private formatValue(value: any, propertyName: string = '', parentKey: string = ''): string {
        const type = this.getValueType(value);
        switch (type) {
            case 'string':
                return `<span class="field-value string">"${value}"</span>`;
            case 'number':
                if (propertyName.toLowerCase().includes('duration')) {
                    const seconds = (value / 90000).toFixed(1);
                    return `<span class="field-value number">${value}<span class="description">${seconds} seconds</span></span>`;
                }
                // Check if we're inside a segmentationUpid object
                if (parentKey === 'segmentationUpid') {
                    const char = String.fromCharCode(value);
                    return `<span class="field-value number">${value}<span class="description">${char}</span></span>`;
                }
                // Handle special numeric fields with mappings
                if (propertyName === 'segmentationUpidType') {
                    const desc = this.UPID_TYPES[value as keyof typeof this.UPID_TYPES] || 'Unknown';
                    return `<span class="field-value number">${value}<span class="description mapped">${desc}</span></span>`;
                }
                if (propertyName === 'segmentationTypeId') {
                    const desc = this.SEGMENTATION_TYPES[value as keyof typeof this.SEGMENTATION_TYPES] || 'Unknown';
                    return `<span class="field-value number">${value}<span class="description segmentation">${desc}</span></span>`;
                }
                if (propertyName === 'spliceCommandType') {
                    const desc = this.COMMAND_TYPES[value as keyof typeof this.COMMAND_TYPES] || 'Unknown';
                    return `<span class="field-value number">${value}<span class="description mapped">${desc}</span></span>`;
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

    private formatData(data: any, level: number = 0, parentKey: string = ''): string {
        if (!data) return '<div>Invalid SCTE-35 data</div>';

        let html = '';
        
        for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
            const formattedName = this.formatPropertyName(key);
            const type = this.getValueType(value);
            const isLength = key.endsWith('Length');

            html += '<div class="field">';
            html += `<span class="field-name${isLength ? ' length' : ''}">${formattedName}:</span>`;

            if (type === 'object' || type === 'array') {
                html += '<div class="object-container">';
                if (type === 'array' && Array.isArray(value)) {
                    value.forEach((item: unknown, index: number) => {
                        html += '<div class="field">';
                        html += `<span class="field-name">Item ${index + 1}:</span>`;
                        if (typeof item === 'object' && item !== null) {
                            html += '<div class="object-container">';
                            html += this.formatData(item, level + 1, key);
                            html += '</div>';
                        } else {
                            html += this.formatValue(item, key, parentKey);
                        }
                        html += '</div>';
                    });
                } else {
                    html += this.formatData(value, level + 1, key);
                }
                html += '</div>';
            } else {
                html += this.formatValue(value, key, parentKey);
            }

            html += '</div>';
        }

        return html;
    }

    public extractTag(line: string): { tag: string, params: string } | null {
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
                                if (message.data) {
                                    this.showJsonDocument(message.data.parsedData, message.data.originalPayload);
                                }
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