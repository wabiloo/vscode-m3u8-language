import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import * as vscode from 'vscode';
import { RemoteDocumentContent, RemotePlaylistInfo } from '../types';

export class RemotePlaylistService {
    constructor(
        private remotePlaylistMap: Map<string, RemotePlaylistInfo>,
        private remoteDocumentContentMap: Map<string, RemoteDocumentContent>,
        private context: vscode.ExtensionContext,
        private log: (message: string) => void
    ) {}

    async fetchRemotePlaylist(uri: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const url = new URL(uri);
            const protocol = url.protocol === 'https:' ? https : http;
            
            const request = protocol.get(uri, (response) => {
                if (response.statusCode !== 200) {
                    reject(new Error(`Failed to fetch playlist: ${response.statusCode}`));
                    return;
                }

                let data = '';
                response.on('data', (chunk) => data += chunk);
                response.on('end', () => resolve(data));
            });

            request.on('error', (error) => reject(error));
            request.end();
        });
    }

    async openRemotePlaylist() {
        const lastUsedUrl = this.context.globalState.get<string>('lastUsedM3u8Url');
        
        const uri = await vscode.window.showInputBox({
            prompt: 'Enter the URL of the M3U8 playlist',
            placeHolder: lastUsedUrl || 'https://example.com/playlist.m3u8',
            value: lastUsedUrl || ''
        });

        if (!uri) return;

        try {
            const content = await this.fetchRemotePlaylist(uri);
            
            // Create a virtual document URI with the remote URL as the filename
            const documentUri = vscode.Uri.parse(`m3u8-remote:/${encodeURIComponent(uri)}`);
            
            // Store the content before creating the document
            this.remoteDocumentContentMap.set(documentUri.toString(), {
                content,
                uri
            });
            
            const doc = await vscode.workspace.openTextDocument(documentUri);
            await vscode.window.showTextDocument(doc);
            
            // Store remote playlist info
            this.remotePlaylistMap.set(doc.uri.toString(), {
                uri,
                autoRefreshEnabled: false,
                refreshInterval: undefined
            });

            // Save the URL for next time
            await this.context.globalState.update('lastUsedM3u8Url', uri);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to fetch playlist: ${error.message}`);
        }
    }

    async refreshCurrentPlaylist() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const docUri = editor.document.uri.toString();
        const playlistInfo = this.remotePlaylistMap.get(docUri);
        if (!playlistInfo) {
            vscode.window.showWarningMessage('Current document is not a remote playlist');
            return;
        }

        try {
            const content = await this.fetchRemotePlaylist(playlistInfo.uri);
            const edit = new vscode.WorkspaceEdit();
            const range = new vscode.Range(
                editor.document.positionAt(0),
                editor.document.positionAt(editor.document.getText().length)
            );
            edit.replace(editor.document.uri, range, content);
            await vscode.workspace.applyEdit(edit);
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to refresh playlist: ${error.message}`);
        }
    }

    toggleAutoRefresh() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const docUri = editor.document.uri.toString();
        const playlistInfo = this.remotePlaylistMap.get(docUri);
        if (!playlistInfo) {
            vscode.window.showWarningMessage('Current document is not a remote playlist');
            return;
        }

        if (playlistInfo.autoRefreshEnabled) {
            if (playlistInfo.refreshInterval) {
                clearInterval(playlistInfo.refreshInterval);
                playlistInfo.refreshInterval = undefined;
            }
            playlistInfo.autoRefreshEnabled = false;
            vscode.window.showInformationMessage('Auto-refresh disabled');
        } else {
            const interval = vscode.workspace.getConfiguration('m3u8.features').get<number>('autoRefreshInterval', 10) * 1000;
            playlistInfo.refreshInterval = setInterval(() => this.refreshCurrentPlaylist(), interval);
            playlistInfo.autoRefreshEnabled = true;
            vscode.window.showInformationMessage(`Auto-refresh enabled (${interval/1000}s interval)`);
        }
    }

    async handleUriClick(uri: string) {
        this.log(`handleUriClick called with uri: ${uri}`);
        
        if (this.isValidUrl(uri)) {
            try {
                this.log(`Fetching remote playlist: ${uri}`);
                const content = await this.fetchRemotePlaylist(uri);
                
                // Create a virtual document URI with the remote URL as the filename
                const documentUri = vscode.Uri.parse(`m3u8-remote:/${encodeURIComponent(uri)}`);
                
                // Store the content before creating the document
                this.remoteDocumentContentMap.set(documentUri.toString(), {
                    content,
                    uri
                });
                
                const doc = await vscode.workspace.openTextDocument(documentUri);
                await vscode.window.showTextDocument(doc);
                
                this.remotePlaylistMap.set(doc.uri.toString(), {
                    uri,
                    autoRefreshEnabled: false,
                    refreshInterval: undefined
                });
                
                this.log(`Successfully opened remote playlist: ${uri}`);
            } catch (error: any) {
                const errorMessage = `Failed to open playlist: ${error.message}`;
                this.log(errorMessage);
                vscode.window.showErrorMessage(errorMessage);
            }
        } else {
            // Handle local file
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (!workspaceFolder) {
                this.log('No workspace folder found for local file');
                return;
            }

            const localPath = vscode.Uri.joinPath(workspaceFolder.uri, uri);
            this.log(`Attempting to open local file: ${localPath}`);
            
            try {
                const doc = await vscode.workspace.openTextDocument(localPath);
                await vscode.window.showTextDocument(doc);
                this.log(`Successfully opened local file: ${localPath}`);
            } catch (error: any) {
                const errorMessage = `Failed to open local file: ${error.message}`;
                this.log(errorMessage);
                vscode.window.showErrorMessage(errorMessage);
            }
        }
    }

    private isValidUrl(str: string): boolean {
        try {
            new URL(str);
            return true;
        } catch {
            return false;
        }
    }
} 