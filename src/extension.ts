import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DecorationManager } from './decorations/DecorationManager';
import { M3U8DocumentLinkProvider } from './providers/DocumentLinkProvider';
import { M3U8FoldingRangeProvider } from './providers/FoldingRangeProvider';
import { M3U8HoverProvider } from './providers/HoverProvider';
import { M3U8RemoteContentProvider } from './providers/RemoteContentProvider';
import { RemotePlaylistService } from './services/RemotePlaylistService';
import { SCTE35Service } from './services/SCTE35Service';
import { HLSTagInfo, RemoteDocumentContent, RemotePlaylistInfo } from './types';

// Global state
let outputChannel: vscode.OutputChannel;
let decorationManager: DecorationManager;
let remotePlaylistService: RemotePlaylistService;
let scte35Service: SCTE35Service;
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

export function activate(context: vscode.ExtensionContext) {
    // Create output channel for logging
    outputChannel = vscode.window.createOutputChannel('M3U8 / HLS');
    context.subscriptions.push(outputChannel);

    log('M3U8 / HLS extension activating...');

    // Load tag definitions
    const tagDefinitions = loadHLSTagDefinitions(context);

    // Initialize services and managers
    decorationManager = new DecorationManager(context, tagDefinitions);
    remotePlaylistService = new RemotePlaylistService(
        remotePlaylistMap,
        remoteDocumentContentMap,
        context,
        log
    );
    scte35Service = new SCTE35Service(tagDefinitions);

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
        vscode.commands.registerCommand('m3u8._handleUriClick', async (...args) => {
            if (!args || args.length === 0) {
                log('No arguments provided to _handleUriClick');
                return;
            }
            const uri = args[0];
            await remotePlaylistService.handleUriClick(uri);
        }),
        vscode.commands.registerCommand('m3u8.parseSCTE35', (line: string) => {
            scte35Service.parseSCTE35Line(line);
        })
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
    
    // Clean up all refresh intervals
    for (const [_, info] of remotePlaylistMap) {
        if (info.refreshInterval) {
            clearInterval(info.refreshInterval);
        }
    }
    remotePlaylistMap.clear();
    remoteDocumentContentMap.clear();
} 