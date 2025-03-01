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
import { PlaylistUrlService } from './services/PlaylistUrlService';
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
let playlistUrlService: PlaylistUrlService;
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
    outputChannel = vscode.window.createOutputChannel('M3U8 Language');
    context.subscriptions.push(outputChannel);

    log('M3U8 / HLS extension activating...');

    // Load tag definitions
    const tagDefinitions = loadHLSTagDefinitions(context);

    // Create services
    playlistUrlService = new PlaylistUrlService(log);
    decorationManager = new DecorationManager(context, tagDefinitions);
    remotePlaylistService = new RemotePlaylistService(remotePlaylistMap, remoteDocumentContentMap, context, log, playlistUrlService);
    segmentPreviewService = new SegmentPreviewService(context, log, remotePlaylistService);
    scte35Service = new SCTE35Service(tagDefinitions);
    chromeDevToolsService = new ChromeDevToolsService(log);
    networkInspectorProvider = new NetworkInspectorProvider(context, chromeDevToolsService, log, playlistUrlService);

    // Create providers
    const documentLinkProvider = new M3U8DocumentLinkProvider(remotePlaylistMap, log, playlistUrlService);
    const foldingRangeProvider = new M3U8FoldingRangeProvider(tagDefinitions);
    const hoverProvider = new M3U8HoverProvider(tagDefinitions, playlistUrlService, remotePlaylistMap);
    const remoteContentProvider = new M3U8RemoteContentProvider(remoteDocumentContentMap);

    // Register providers
    context.subscriptions.push(
        vscode.languages.registerHoverProvider('m3u8', hoverProvider),
        vscode.languages.registerFoldingRangeProvider('m3u8', foldingRangeProvider),
        vscode.languages.registerDocumentLinkProvider(
            { language: 'm3u8', scheme: '*' },
            documentLinkProvider
        ),
        vscode.workspace.registerTextDocumentContentProvider(
            'm3u8-remote',
            remoteContentProvider
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
                            // For DATERANGE tags, only show CodeLens if they actually contain SCTE35 data
                            if (tagInfo.tag === 'EXT-X-DATERANGE') {
                                // Check if the tag contains any SCTE35 attributes
                                const hasScte35Data = 
                                    tagInfo.params.includes('SCTE35-CMD=') || 
                                    tagInfo.params.includes('SCTE35-OUT=') || 
                                    tagInfo.params.includes('SCTE35-IN=');
                                
                                if (!hasScte35Data) {
                                    continue; // Skip this tag if it doesn't contain SCTE35 data
                                }
                            }
                            
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
        vscode.commands.registerCommand('m3u8._handleUriClick', async (uri: string, isFromMultivariant?: boolean, args?: any[]) => {
            if (!uri) {
                log('No URI provided to _handleUriClick');
                return;
            }
            
            // If this is from a multivariant playlist, directly handle it as a playlist
            if (isFromMultivariant) {
                await remotePlaylistService.handlePlaylistUri(uri);
                return;
            }
            
            // The mode can come from the keybinding args
            const mode = args?.[0] || 'play';
            log(`Handling URI click for ${uri} with mode ${mode}`);
            
            // Handle as a segment with preview/download mode
            if (mode === 'play') {
                await vscode.commands.executeCommand('m3u8._playSegment', uri);
            } else if (mode === 'download') {
                await vscode.commands.executeCommand('m3u8._downloadSegment', uri);
            }
        }),
        vscode.commands.registerCommand('m3u8._playSegment', async (uri?: string, isFromMultivariant?: boolean, initSegmentUri?: string) => {
            if (typeof uri === 'string') {
                await segmentPreviewService.showSegmentPreview(uri, initSegmentUri);
            } else {
                // Handle selection case
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

                // Get the base URI from the document and resolve the URL if it's relative
                const baseUri = remotePlaylistMap.get(editor.document.uri.toString())?.uri;
                const resolvedUrl = baseUri && !isValidUrl(url) ? new URL(url, baseUri).toString() : url;

                // Find the nearest init segment if any
                let nearestInitSegment: string | undefined;
                for (let i = position.line; i >= 0; i--) {
                    const currentLine = editor.document.lineAt(i).text.trim();
                    if (currentLine.startsWith('#EXT-X-MAP:')) {
                        const initMatch = currentLine.match(/URI="([^"]+)"|URI=([^,\s"]+)/);
                        if (initMatch) {
                            const initUri = initMatch[1] || initMatch[2];
                            nearestInitSegment = baseUri && !isValidUrl(initUri) ? 
                                new URL(initUri, baseUri).toString() : 
                                initUri;
                            break;
                        }
                    }
                }

                await segmentPreviewService.showSegmentPreview(resolvedUrl, nearestInitSegment);
            }
        }),
        vscode.commands.registerCommand('m3u8._downloadSegment', async (uri?: string, isFromMultivariant?: boolean, initSegmentUri?: string) => {
            if (isFromMultivariant) {
                // If this is a variant playlist URI, open it instead of downloading
                if (typeof uri === 'string') {
                    await remotePlaylistService.handlePlaylistUri(uri);
                }
                return;
            }

            // Show status immediately
            remotePlaylistService.showDownloadStatus('$(cloud-download) Preparing download...');

            if (typeof uri === 'string') {
                await remotePlaylistService.downloadSegment(uri, initSegmentUri);
            } else {
                // Handle selection case
                const editor = vscode.window.activeTextEditor;
                if (!editor) {
                    remotePlaylistService.hideDownloadStatus();
                    return;
                }

                // Get the line at the cursor position
                const position = editor.selection.active;
                const line = editor.document.lineAt(position.line);
                const text = line.text.trim();

                // Extract the URL from the line
                let url = text;
                if (text.startsWith('#')) {
                    // Try to extract URL from tag attributes
                    const uriMatch = text.match(/URI="([^"]+)"|URI=([^,\s"]+)/);
                    if (!uriMatch) {
                        remotePlaylistService.hideDownloadStatus();
                        return;
                    }
                    url = uriMatch[1] || uriMatch[2];
                }

                // Get the base URI from the document and resolve the URL if it's relative
                const baseUri = remotePlaylistMap.get(editor.document.uri.toString())?.uri;
                const resolvedUrl = baseUri && !isValidUrl(url) ? new URL(url, baseUri).toString() : url;

                // Find the nearest init segment if any
                let nearestInitSegment: string | undefined;
                for (let i = position.line; i >= 0; i--) {
                    const currentLine = editor.document.lineAt(i).text.trim();
                    if (currentLine.startsWith('#EXT-X-MAP:')) {
                        const initMatch = currentLine.match(/URI="([^"]+)"|URI=([^,\s"]+)/);
                        if (initMatch) {
                            const initUri = initMatch[1] || initMatch[2];
                            nearestInitSegment = baseUri && !isValidUrl(initUri) ? 
                                new URL(initUri, baseUri).toString() : 
                                initUri;
                            break;
                        }
                    }
                }

                await remotePlaylistService.downloadSegment(resolvedUrl, nearestInitSegment);
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
                // Update the multivariant context when the editor changes
                const isMultiVariant = editor.document.languageId === 'm3u8' && 
                    (editor.document.getText().includes('#EXT-X-STREAM-INF:') || 
                     editor.document.getText().includes('#EXT-X-MEDIA:'));
                vscode.commands.executeCommand('setContext', 'm3u8.isMultiVariantPlaylist', isMultiVariant);

                decorationManager.updateDecorations(editor);
                decorationManager.updateLinkDecorations(editor);
            }
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
            const editor = vscode.window.activeTextEditor;
            if (editor && event.document === editor.document) {
                // Update the multivariant context when the document changes
                const isMultiVariant = editor.document.languageId === 'm3u8' && 
                    (editor.document.getText().includes('#EXT-X-STREAM-INF:') || 
                     editor.document.getText().includes('#EXT-X-MEDIA:'));
                vscode.commands.executeCommand('setContext', 'm3u8.isMultiVariantPlaylist', isMultiVariant);

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