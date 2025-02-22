import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { URL } from 'url';
import * as vscode from 'vscode';
import { RemoteDocumentContent, RemotePlaylistInfo } from '../types';
import { PlaylistUrlService } from './PlaylistUrlService';

export class RemotePlaylistService {
    private statusBarItem: vscode.StatusBarItem;
    private countdownInterval?: NodeJS.Timeout;
    private baseDecorationType!: vscode.TextEditorDecorationType;
    private linkDecorationType!: vscode.TextEditorDecorationType;
    private downloadStatusBarItem: vscode.StatusBarItem;

    constructor(
        private remotePlaylistMap: Map<string, RemotePlaylistInfo>,
        private remoteDocumentContentMap: Map<string, RemoteDocumentContent>,
        private context: vscode.ExtensionContext,
        private log: (message: string) => void,
        private playlistUrlService: PlaylistUrlService
    ) {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.command = 'm3u8.toggleAutoRefresh';
        this.statusBarItem.tooltip = 'Click to toggle auto-refresh';
        this.context.subscriptions.push(this.statusBarItem);

        this.downloadStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
        this.context.subscriptions.push(this.downloadStatusBarItem);

        this.updateStatusBar(false);
        this.initializeDecorationTypes();

        // Subscribe to active editor changes
        this.context.subscriptions.push(
            vscode.window.onDidChangeActiveTextEditor(() => {
                this.updateStatusBarVisibility();
            })
        );
        
        // Initial visibility check
        this.updateStatusBarVisibility();
    }

    private initializeDecorationTypes() {
        // Create base decoration type
        this.baseDecorationType = vscode.window.createTextEditorDecorationType({
            before: {
                contentText: '',
                margin: '0 0 0 8px'
            }
        });

        // Create link decoration type
        this.linkDecorationType = vscode.window.createTextEditorDecorationType({
            textDecoration: 'underline',
            cursor: 'pointer',
            color: '#3794ff'
        });
    }

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

    private async fetchBinaryContent(uri: string): Promise<Buffer> {
        return new Promise((resolve, reject) => {
            const url = new URL(uri);
            const protocol = url.protocol === 'https:' ? https : http;
            
            const request = protocol.get(uri, (response) => {
                if (response.statusCode !== 200) {
                    reject(new Error(`Failed to fetch content: ${response.statusCode}`));
                    return;
                }

                const chunks: Buffer[] = [];
                response.on('data', (chunk: Buffer) => chunks.push(chunk));
                response.on('end', () => resolve(Buffer.concat(chunks)));
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
            this.log('Refresh failed: Current document is not a remote playlist');
            vscode.window.showWarningMessage('Current document is not a remote playlist');
            return;
        }

        this.log(`Refreshing playlist ${playlistInfo.uri}`);
        try {
            const content = await this.fetchRemotePlaylist(playlistInfo.uri);
            const edit = new vscode.WorkspaceEdit();
            const range = new vscode.Range(
                editor.document.positionAt(0),
                editor.document.positionAt(editor.document.getText().length)
            );
            edit.replace(editor.document.uri, range, content);
            await vscode.workspace.applyEdit(edit);
            this.log('Playlist refresh successful');
        } catch (error: any) {
            const errorMessage = `Failed to refresh playlist: ${error.message}`;
            this.log(errorMessage);
            vscode.window.showErrorMessage(errorMessage);
        }
    }

    private getTargetDuration(content: string): number {
        const match = content.match(/#EXT-X-TARGETDURATION:(\d+)/);
        return match ? parseInt(match[1], 10) : 4;
    }

    private isMultiVariantPlaylist(content: string): boolean {
        return this.playlistUrlService.isMultiVariantPlaylist(content);
    }

    async toggleAutoRefresh() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const docUri = editor.document.uri.toString();
        const playlistInfo = this.remotePlaylistMap.get(docUri);
        if (!playlistInfo) {
            this.log('Toggle auto-refresh failed: Current document is not a remote playlist');
            vscode.window.showWarningMessage('Current document is not a remote playlist');
            return;
        }

        this.log(`Toggle auto-refresh for ${playlistInfo.uri}`);

        // Check if this is a multi-variant playlist
        const docContent = this.remoteDocumentContentMap.get(docUri);
        if (!docContent) {
            this.log('Toggle auto-refresh failed: No content found for playlist');
            return;
        }

        if (this.isMultiVariantPlaylist(docContent.content)) {
            this.log('Toggle auto-refresh failed: Auto-refresh is not available for multi-variant playlists');
            vscode.window.showWarningMessage('Auto-refresh is not available for multi-variant playlists');
            return;
        }

        // If auto-refresh is enabled, disable it
        if (playlistInfo.autoRefreshEnabled) {
            this.disableAutoRefresh(playlistInfo);
            return;
        }

        // Otherwise, prompt for interval and enable
        await this.enableAutoRefresh(docUri, playlistInfo);
    }

    private isValidM3u8Document(editor?: vscode.TextEditor): boolean {
        if (!editor) {
            return false;
        }

        // Check if it's a remote M3U8 document
        if (editor.document.uri.scheme === 'm3u8-remote') {
            return true;
        }

        // Check if it's a local M3U8 file
        return editor.document.fileName.toLowerCase().endsWith('.m3u8');
    }

    private updateStatusBarVisibility() {
        const editor = vscode.window.activeTextEditor;
        if (this.isValidM3u8Document(editor)) {
            this.statusBarItem.show();
        } else {
            this.statusBarItem.hide();
        }
    }

    private updateStatusBar(enabled: boolean, nextRefresh?: number) {
        if (!enabled) {
            this.statusBarItem.text = "M3U8 $(sync-ignored)";
            if (this.countdownInterval) {
                clearInterval(this.countdownInterval);
                this.countdownInterval = undefined;
            }
            this.updateStatusBarVisibility();
            return;
        }

        if (nextRefresh) {
            const updateCountdown = () => {
                const now = Date.now();
                const remaining = Math.ceil((nextRefresh - now) / 1000);
                if (remaining > 0) {
                    this.statusBarItem.text = `M3U8 $(sync) ${remaining}s`;
                }
            };
            
            updateCountdown();
            this.countdownInterval = setInterval(updateCountdown, 1000);
        }
        
        this.statusBarItem.show();
    }

    private disableAutoRefresh(playlistInfo: RemotePlaylistInfo) {
        this.log('Disabling auto-refresh');
        if (playlistInfo.refreshInterval) {
            clearInterval(playlistInfo.refreshInterval);
            playlistInfo.refreshInterval = undefined;
        }
        playlistInfo.autoRefreshEnabled = false;
        this.updateStatusBar(false);
        this.log('Auto-refresh disabled');
    }

    private async enableAutoRefresh(docUri: string, playlistInfo: RemotePlaylistInfo) {
        const docContent = this.remoteDocumentContentMap.get(docUri);
        const defaultInterval = docContent ? this.getTargetDuration(docContent.content) : 4;
        this.log(`Prompting for refresh interval (default: ${defaultInterval}s from ${defaultInterval === 4 ? 'default value' : '#EXT-X-TARGETDURATION'})`);

        const intervalStr = await vscode.window.showInputBox({
            prompt: 'Enter refresh interval in seconds',
            value: defaultInterval.toString(),
            placeHolder: `Default is ${defaultInterval} seconds (from #EXT-X-TARGETDURATION or 4 if not found)`,
            validateInput: value => {
                const num = parseInt(value, 10);
                return (!isNaN(num) && num > 0) ? null : 'Please enter a positive number';
            }
        });

        if (intervalStr === undefined) {
            this.log('User cancelled auto-refresh setup');
            return; // User cancelled
        }

        const interval = parseInt(intervalStr, 10) * 1000; // Convert to milliseconds
        this.log(`Setting up auto-refresh with ${interval/1000}s interval`);
        
        // Clear any existing interval first
        if (playlistInfo.refreshInterval) {
            this.log('Clearing existing refresh interval');
            clearInterval(playlistInfo.refreshInterval);
        }
        
        const scheduleNextRefresh = () => {
            this.log(`Auto-refreshing playlist ${playlistInfo.uri}`);
            this.refreshCurrentPlaylist();
            this.updateStatusBar(true, Date.now() + interval);
        };

        playlistInfo.refreshInterval = setInterval(scheduleNextRefresh, interval);
        playlistInfo.autoRefreshEnabled = true;
        
        // Initial countdown
        this.updateStatusBar(true, Date.now() + interval);
        this.log('Auto-refresh enabled');
    }

    private async getDefaultDownloadPath(): Promise<vscode.Uri> {
        // Try to get Downloads folder first
        try {
            // On Windows: %USERPROFILE%\Downloads
            // On macOS: $HOME/Downloads
            // On Linux: $HOME/Downloads
            const homeDir = process.env.HOME || process.env.USERPROFILE || '';
            const downloadsPath = vscode.Uri.file(path.join(homeDir, 'Downloads'));
            
            // Check if Downloads folder exists
            await vscode.workspace.fs.stat(downloadsPath);
            return downloadsPath;
        } catch {
            // Fallback to home directory if Downloads doesn't exist
            const homeDir = process.env.HOME || process.env.USERPROFILE || '';
            return vscode.Uri.file(homeDir);
        }
    }

    private showAutoHideMessage(message: string, timeout: number = 3000): void {
        const disposable = vscode.window.setStatusBarMessage(message);
        setTimeout(() => disposable.dispose(), timeout);
    }

    public showDownloadStatus(message: string): void {
        this.downloadStatusBarItem.text = message;
        this.downloadStatusBarItem.show();
    }

    public hideDownloadStatus(): void {
        this.downloadStatusBarItem.hide();
    }

    public async downloadSegment(uri: string, initSegmentUri?: string): Promise<void> {
        try {
            // Show download status
            this.showDownloadStatus(`$(cloud-download) Downloading segment...`);

            this.log(`Downloading segment from ${uri}`);

            // If we have an init segment, download it first
            let initContent: Buffer | undefined;
            if (initSegmentUri) {
                this.showDownloadStatus(`$(cloud-download) Downloading init segment...`);
                this.log(`Downloading init segment from ${initSegmentUri}`);
                initContent = await this.fetchBinaryContent(initSegmentUri);
            }

            // Download the main segment
            this.showDownloadStatus(`$(cloud-download) Downloading media segment...`);
            const content = await this.fetchBinaryContent(uri);
            
            // Get the default name from the URI
            const defaultName = uri.split('/').pop() || 'segment';

            // Get the last used directory for this playlist
            const editor = vscode.window.activeTextEditor;
            const playlistUri = editor?.document.uri.toString();
            const lastDir = playlistUri ? 
                this.context.globalState.get<string>(`lastDownloadDir.${playlistUri}`) : 
                undefined;

            // Determine the default save location
            let defaultUri: vscode.Uri;
            if (lastDir) {
                defaultUri = vscode.Uri.file(path.join(lastDir, defaultName));
            } else {
                const defaultPath = await this.getDefaultDownloadPath();
                defaultUri = vscode.Uri.joinPath(defaultPath, defaultName);
            }
            
            // Update status to show we're waiting for save location
            this.showDownloadStatus(`$(cloud-download) Select where to save...`);
            
            // Show save dialog
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri,
                filters: { 'All files': ['*'] }
            });
            
            if (saveUri) {
                // Update status to show we're saving
                this.showDownloadStatus(`$(cloud-download) Saving segment...`);
                
                // If we have an init segment, concatenate it with the main segment
                const finalContent = initContent ? 
                    Buffer.concat([initContent, content]) : 
                    content;

                await vscode.workspace.fs.writeFile(saveUri, finalContent);
                
                // Remember the directory for next time
                if (playlistUri) {
                    const dirPath = path.dirname(saveUri.fsPath);
                    await this.context.globalState.update(`lastDownloadDir.${playlistUri}`, dirPath);
                }
                
                this.log(`Segment downloaded successfully to ${saveUri.fsPath}`);
                
                // Show success in status bar briefly
                this.showDownloadStatus(`$(check) Segment downloaded`);
                setTimeout(() => this.hideDownloadStatus(), 3000);
                
                // Also show a clickable notification to open the folder
                const openFolder = 'Open Folder';
                const message = await vscode.window.showInformationMessage(
                    `Segment downloaded to ${saveUri.fsPath}`,
                    { title: openFolder }
                );
                if (message?.title === openFolder) {
                    const folderUri = vscode.Uri.file(path.dirname(saveUri.fsPath));
                    vscode.commands.executeCommand('revealFileInOS', folderUri);
                }
            } else {
                // User cancelled the save dialog
                this.hideDownloadStatus();
            }
        } catch (error: any) {
            const errorMessage = `Failed to download segment: ${error.message}`;
            this.log(errorMessage);
            
            // Show error in status bar briefly
            this.showDownloadStatus(`$(error) Download failed`);
            setTimeout(() => this.hideDownloadStatus(), 3000);
            
            vscode.window.showErrorMessage(errorMessage);
        }
    }

    async handleUriClick(uri: string, mode: 'preview' | 'download' = 'preview', isFromMultivariant: boolean = false) {
        this.log(`handleUriClick called with uri: ${uri}, mode: ${mode}, isFromMultivariant: ${isFromMultivariant}`);
        
        if (this.isValidUrl(uri)) {
            try {
                // If we're coming from a multivariant playlist, directly handle as playlist
                if (isFromMultivariant) {
                    await this.handlePlaylistUri(uri);
                    return;
                }

                // Otherwise check if we're in a multi-variant playlist
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    const docUri = editor.document.uri.toString();
                    const docContent = this.remoteDocumentContentMap.get(docUri);
                    if (docContent && this.isMultiVariantPlaylist(docContent.content)) {
                        // This is a variant playlist, handle as playlist
                        await this.handlePlaylistUri(uri);
                        return;
                    }
                }

                // Otherwise, try to detect content type
                this.log(`Fetching content from: ${uri}`);
                const content = await this.fetchRemotePlaylist(uri);

                // Check if it's a playlist or segment by looking for HLS tags
                const isPlaylist = content.includes('#EXTM3U');
                
                if (!isPlaylist) {
                    this.log('URI points to a segment');
                    const baseUri = editor?.document.uri.toString() ? 
                        this.remoteDocumentContentMap.get(editor.document.uri.toString())?.uri : 
                        undefined;
                    
                    if (mode === 'download') {
                        await this.downloadSegment(uri, baseUri);
                    } else {
                        await vscode.commands.executeCommand('m3u8._previewSegment', uri, baseUri);
                    }
                    return;
                }
                
                await this.handlePlaylistUri(uri);
            } catch (error: any) {
                const errorMessage = `Failed to open/download: ${error.message}`;
                this.log(errorMessage);
                vscode.window.showErrorMessage(errorMessage);
            }
        } else {
            await this.handleLocalUri(uri);
        }
    }

    public async handlePlaylistUri(uri: string) {
        this.log(`Opening playlist: ${uri}`);
        const content = await this.fetchRemotePlaylist(uri);
        
        // Create a virtual document URI with the remote URL as the filename
        const documentUri = vscode.Uri.parse(`m3u8-remote:/${encodeURIComponent(uri)}`);
        
        // Store the content before creating the document
        this.remoteDocumentContentMap.set(documentUri.toString(), {
            content,
            uri
        });
        
        const doc = await vscode.workspace.openTextDocument(documentUri);
        await vscode.window.showTextDocument(doc, {
            preview: false, // Don't reuse the tab
            preserveFocus: false // Give focus to the new tab
        });
        
        this.remotePlaylistMap.set(doc.uri.toString(), {
            uri,
            autoRefreshEnabled: false,
            refreshInterval: undefined
        });
        
        this.log(`Successfully opened remote playlist: ${uri}`);
    }

    private async handleLocalUri(uri: string) {
        // Handle local file - only if it's a playlist (ends with .m3u8 or .m3u)
        if (!uri.toLowerCase().endsWith('.m3u8') && !uri.toLowerCase().endsWith('.m3u')) {
            this.log('Local URI is not a playlist, ignoring click');
            return;
        }

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            this.log('No workspace folder found for local file');
            return;
        }

        const localPath = vscode.Uri.joinPath(workspaceFolder.uri, uri);
        this.log(`Attempting to open local playlist: ${localPath}`);
        
        try {
            const doc = await vscode.workspace.openTextDocument(localPath);
            await vscode.window.showTextDocument(doc);
            this.log(`Successfully opened local playlist: ${localPath}`);
        } catch (error: any) {
            const errorMessage = `Failed to open local playlist: ${error.message}`;
            this.log(errorMessage);
            vscode.window.showErrorMessage(errorMessage);
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

    dispose() {
        if (this.countdownInterval) {
            clearInterval(this.countdownInterval);
        }
        this.statusBarItem.dispose();
        this.downloadStatusBarItem.dispose();
    }
} 