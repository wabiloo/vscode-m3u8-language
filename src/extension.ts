import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DecorationManager } from './decorations/DecorationManager';
import { M3U8DocumentLinkProvider } from './providers/DocumentLinkProvider';
import { M3U8FoldingRangeProvider } from './providers/FoldingRangeProvider';
import { M3U8HoverProvider } from './providers/HoverProvider';
import { M3U8RemoteContentProvider } from './providers/RemoteContentProvider';
import { RemotePlaylistService } from './services/RemotePlaylistService';
import { HLSTagInfo, RemoteDocumentContent, RemotePlaylistInfo } from './types';

// Global state
let outputChannel: vscode.OutputChannel;
let decorationManager: DecorationManager;
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
    outputChannel = vscode.window.createOutputChannel('M3U8');
    context.subscriptions.push(outputChannel);

    log('M3U8 extension activating...');

    // Load tag definitions
    const tagDefinitions = loadHLSTagDefinitions(context);

    // Initialize services and managers
    decorationManager = new DecorationManager(context, tagDefinitions);
    const remotePlaylistService = new RemotePlaylistService(
        remotePlaylistMap,
        remoteDocumentContentMap,
        context,
        log
    );

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
        )
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
    
    // Clean up all refresh intervals
    for (const [_, info] of remotePlaylistMap) {
        if (info.refreshInterval) {
            clearInterval(info.refreshInterval);
        }
    }
    remotePlaylistMap.clear();
    remoteDocumentContentMap.clear();
} 