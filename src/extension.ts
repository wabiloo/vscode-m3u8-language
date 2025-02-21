import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DecorationManager } from './decorations/DecorationManager';
import { M3U8DocumentLinkProvider } from './providers/DocumentLinkProvider';
import { M3U8FoldingRangeProvider } from './providers/FoldingRangeProvider';
import { M3U8HoverProvider } from './providers/HoverProvider';
import { NetworkInspectorProvider } from './providers/NetworkInspectorProvider';
import { M3U8RemoteContentProvider } from './providers/RemoteContentProvider';
import { ChromeDevToolsService } from './services/ChromeDevToolsService';
import { RemotePlaylistService } from './services/RemotePlaylistService';
import { SCTE35Service } from './services/SCTE35Service';
import { SegmentPreviewService } from './services/SegmentPreviewService';
import { HLSTagInfo, RemoteDocumentContent, RemotePlaylistInfo } from './types';

// Global state
let outputChannel: vscode.OutputChannel;
let decorationManager: DecorationManager;
let remotePlaylistService: RemotePlaylistService;
let scte35Service: SCTE35Service;
let chromeDevToolsService: ChromeDevToolsService;
let networkInspectorProvider: NetworkInspectorProvider;
let segmentPreviewService: SegmentPreviewService;
const remotePlaylistMap = new Map<string, RemotePlaylistInfo>();
const remoteDocumentContentMap = new Map<string, RemoteDocumentContent>();

function log(message: string) {
    console.log(message);
    outputChannel?.appendLine(message);
}

function loadHLSTagDefinitions(context: vscode.ExtensionContext): Record<string, HLSTagInfo> {
    const jsonPath = path.join(context.extensionPath, 'hls-tags.json');
    const jsonContent = fs.readFileSync(jsonPath, 'utf8');
    return JSON.parse(jsonContent);
}

function isValidUrl(str: string): boolean {
    try {
        new URL(str);
        return true;
    } catch {
        return false;
    }
}

export function activate(context: vscode.ExtensionContext) {
    // Create output channel for logging
    outputChannel = vscode.window.createOutputChannel('M3U8 / HLS');
    context.subscriptions.push(outputChannel);

    log('M3U8 / HLS extension activating...');

    // Load tag definitions
    const tagDefinitions = loadHLSTagDefinitions(context);

    // Initialize services
    decorationManager = new DecorationManager(context, tagDefinitions);
    remotePlaylistService = new RemotePlaylistService(remotePlaylistMap, remoteDocumentContentMap, context, log);
    segmentPreviewService = new SegmentPreviewService(context, log, remotePlaylistService);
    scte35Service = new SCTE35Service(tagDefinitions);
    chromeDevToolsService = new ChromeDevToolsService(log);
    networkInspectorProvider = new NetworkInspectorProvider(context, chromeDevToolsService, log);

    // Register providers
    context.subscriptions.push(
        vscode.languages.registerHoverProvider('m3u8', new M3U8HoverProvider(tagDefinitions)),
        vscode.languages.registerFoldingRangeProvider('m3u8', new M3U8FoldingRangeProvider(tagDefinitions)),
        vscode.languages.registerDocumentLinkProvider(
            { language: 'm3u8', scheme: '*' },
            new M3U8DocumentLinkProvider(remotePlaylistMap, log)
        ),
        vscode.workspace.registerTextDocumentContentProvider(
            'm3u8-remote',
            new M3U8RemoteContentProvider(remoteDocumentContentMap)
        ),
        vscode.languages.registerCodeLensProvider('m3u8', {
            provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
                const codeLenses: vscode.CodeLens[] = [];
                
                for (let i = 0; i < document.lineCount; i++) {
                    const line = document.lineAt(i);
                    const text = line.text;
                    
                    // Only show code lens for EXT tags with SCTE35 data
                    if (text.startsWith('#EXT')) {
                        const tagInfo = scte35Service.extractTag(text);
                        if (tagInfo && tagDefinitions[tagInfo.tag]?.scte35) {
                            const range = new vscode.Range(i, 0, i, text.length);
                            const command = {
                                title: 'Parse SCTE-35',
                                command: 'm3u8.parseSCTE35',
                                arguments: [text]
                            };
                            codeLenses.push(new vscode.CodeLens(range, command));
                        }
                    }
                }
                
                return codeLenses;
            }
        })
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('m3u8.openRemotePlaylist', () => remotePlaylistService.openRemotePlaylist()),
        vscode.commands.registerCommand('m3u8.refreshPlaylist', () => remotePlaylistService.refreshCurrentPlaylist()),
        vscode.commands.registerCommand('m3u8.toggleAutoRefresh', () => remotePlaylistService.toggleAutoRefresh()),
        vscode.commands.registerCommand('m3u8._handleUriClick', async (uri: string, baseUri?: string, args?: any[]) => {
            if (!uri) {
                log('No URI provided to _handleUriClick');
                return;
            }
            
            // The mode can come from the keybinding args
            const mode = args?.[0] || 'preview';
            
            log(`Handling URI click for ${uri} with mode ${mode}`);
            if (mode === 'preview') {
                await vscode.commands.executeCommand('m3u8._previewSegment', uri, baseUri);
            } else if (mode === 'download') {
                await vscode.commands.executeCommand('m3u8._downloadSegment', uri, baseUri);
            }
        }),
        vscode.commands.registerCommand('m3u8._previewSegment', async (uriOrSelection?: string | vscode.Selection) => {
            let uri: string | undefined;
            let baseUri: string | undefined;

            // If a string is provided, it's a direct URI from a link click
            if (typeof uriOrSelection === 'string') {
                uri = uriOrSelection;
            } else {
                // Otherwise get the URL from the selection
                const editor = vscode.window.activeTextEditor;
                if (!editor) return;

                // Get the line at the cursor position
                const position = editor.selection.active;
                const line = editor.document.lineAt(position.line);
                const text = line.text.trim();

                // Extract the URL from the line
                let url = text;
                if (text.startsWith('#')) {
                    // Try to extract URL from tag attributes
                    const uriMatch = text.match(/URI="([^"]+)"|URI=([^,\s"]+)/);
                    if (!uriMatch) return;
                    url = uriMatch[1] || uriMatch[2];
                }

                // Get the base URI from the document
                baseUri = remotePlaylistMap.get(editor.document.uri.toString())?.uri;
                
                // Resolve the URL if it's relative
                uri = baseUri && !isValidUrl(url) ? new URL(url, baseUri).toString() : url;
            }

            if (uri) {
                await segmentPreviewService.showSegmentPreview(uri);
            }
        }),
        vscode.commands.registerCommand('m3u8._downloadSegment', async (uriOrSelection?: string | vscode.Selection) => {
            let uri: string | undefined;
            let baseUri: string | undefined;

            // If a string is provided, it's a direct URI from a link click
            if (typeof uriOrSelection === 'string') {
                uri = uriOrSelection;
            } else {
                // Otherwise get the URL from the selection
                const editor = vscode.window.activeTextEditor;
                if (!editor) return;

                // Get the line at the cursor position
                const position = editor.selection.active;
                const line = editor.document.lineAt(position.line);
                const text = line.text.trim();

                // Extract the URL from the line
                let url = text;
                if (text.startsWith('#')) {
                    // Try to extract URL from tag attributes
                    const uriMatch = text.match(/URI="([^"]+)"|URI=([^,\s"]+)/);
                    if (!uriMatch) return;
                    url = uriMatch[1] || uriMatch[2];
                }

                // Get the base URI from the document
                baseUri = remotePlaylistMap.get(editor.document.uri.toString())?.uri;
                
                // Resolve the URL if it's relative
                uri = baseUri && !isValidUrl(url) ? new URL(url, baseUri).toString() : url;
            }

            if (uri) {
                await remotePlaylistService.downloadSegment(uri);
            }
        }),
        vscode.commands.registerCommand('m3u8.parseSCTE35', async (line?: string) => {
            // If line is provided (from code lens), parse it directly
            if (line) {
                scte35Service.parseSCTE35Line(line);
                return;
            }

            // Otherwise prompt user for input
            const input = await vscode.window.showInputBox({
                prompt: 'Enter SCTE35 data (base64 or hex format)',
                placeHolder: 'e.g. /DAvAAAAAAAAAP/wFAUAAAABf+/+c2nALv4AKctgAAEBAQAA6Q4D9A== or 0xFC302F00...',
                validateInput: (value) => {
                    if (!value) return 'Please enter SCTE35 data';
                    // Basic format validation
                    if (!value.startsWith('/') && !value.startsWith('0x')) {
                        return 'SCTE35 data must start with "/" (base64) or "0x" (hex)';
                    }
                    return null;
                }
            });

            if (input) {
                // Create a mock tag line based on the input format
                const tagLine = input.startsWith('0x')
                    ? `#EXT-X-DATERANGE:SCTE35-CMD=${input}`
                    : `#EXT-OATCLS-SCTE35:${input}`;
                scte35Service.parseSCTE35Line(tagLine);
            }
        }),
        vscode.commands.registerCommand('m3u8.openNetworkInspector', () => networkInspectorProvider.show())
    );

    // Register event handlers
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) {
                decorationManager.updateDecorations(editor);
                decorationManager.updateLinkDecorations(editor);
            }
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
            const editor = vscode.window.activeTextEditor;
            if (editor && event.document === editor.document) {
                decorationManager.updateDecorations(editor);
                decorationManager.updateLinkDecorations(editor);
            }
        }),
        vscode.workspace.onDidCloseTextDocument(document => {
            const playlistInfo = remotePlaylistMap.get(document.uri.toString());
            if (playlistInfo?.refreshInterval) {
                clearInterval(playlistInfo.refreshInterval);
            }
            remotePlaylistMap.delete(document.uri.toString());
            remoteDocumentContentMap.delete(document.uri.toString());
        })
    );

    // Initial update for the active editor
    if (vscode.window.activeTextEditor) {
        decorationManager.updateDecorations(vscode.window.activeTextEditor);
        decorationManager.updateLinkDecorations(vscode.window.activeTextEditor);
    }
}

export function deactivate() {
    decorationManager.dispose();
    remotePlaylistService.dispose();
    scte35Service.dispose();
    chromeDevToolsService.dispose();
    networkInspectorProvider.dispose();
    segmentPreviewService.dispose();
    
    // Clean up all refresh intervals
    for (const [_, info] of remotePlaylistMap) {
        if (info.refreshInterval) {
            clearInterval(info.refreshInterval);
        }
    }
    remotePlaylistMap.clear();
    remoteDocumentContentMap.clear();
} 