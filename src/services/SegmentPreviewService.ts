import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { RemotePlaylistService } from './RemotePlaylistService';

export class SegmentPreviewService {
    private panel: vscode.WebviewPanel | undefined;
    private tempPlaylistUri: vscode.Uri | undefined;

    constructor(
        private context: vscode.ExtensionContext,
        private log: (message: string) => void,
        private remotePlaylistService: RemotePlaylistService
    ) {}

    private async createTempPlaylist(content: string): Promise<vscode.Uri> {
        // Create a URI for a file in the extension's storage path
        const tempUri = vscode.Uri.joinPath(this.context.globalStorageUri, 'temp.m3u8');
        
        // Ensure the directory exists
        try {
            await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
        } catch (error) {
            // Directory might already exist
        }

        // Write the playlist content
        await vscode.workspace.fs.writeFile(tempUri, Buffer.from(content));
        return tempUri;
    }

    private createWebviewPanel(segmentUri: string): vscode.WebviewPanel {
        const panel = vscode.window.createWebviewPanel(
            'segmentPreview',
            'Segment Preview',
            {
                viewColumn: vscode.ViewColumn.Beside,
                preserveFocus: true
            },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    this.context.globalStorageUri,
                    vscode.Uri.joinPath(this.context.extensionUri, 'media')
                ]
            }
        );

        panel.onDidDispose(() => {
            this.panel = undefined;
            // Clean up the temporary file
            if (this.tempPlaylistUri) {
                vscode.workspace.fs.delete(this.tempPlaylistUri).then(undefined, (error: Error) => {
                    this.log(`Failed to delete temporary playlist: ${error}`);
                });
                this.tempPlaylistUri = undefined;
            }
        });

        return panel;
    }

    private getWebviewContent(segmentUri: string, playlistUri: vscode.Uri): string {
        const templatePath = path.join(this.context.extensionPath, 'src', 'templates', 'segmentPreview.html');
        let content = fs.readFileSync(templatePath, 'utf8');
        
        // Replace template variables
        content = content.replace(/\${segmentUri}/g, segmentUri);
        content = content.replace(/\${playlistUri}/g, this.panel?.webview.asWebviewUri(playlistUri).toString() || '');
        
        return content;
    }

    public async showSegmentPreview(segmentUri: string, initSegmentUri?: string) {
        try {
            this.log(`Opening segment preview for ${segmentUri}`);

            // Create a single-segment playlist
            let playlistContent = '#EXTM3U\n#EXT-X-VERSION:3\n';

            // Add init segment if present
            if (initSegmentUri) {
                this.log(`Adding init segment: ${initSegmentUri}`);
                playlistContent += `#EXT-X-MAP:URI="${initSegmentUri}"\n`;
            }

            playlistContent += `#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\n${segmentUri}\n#EXT-X-ENDLIST`;

            // Log the playlist content to the output channel
            this.log('Generated HLS playlist for segment:');
            this.log(playlistContent);

            // Create the temporary playlist file
            this.tempPlaylistUri = await this.createTempPlaylist(playlistContent);
            this.log(`Created temporary playlist at: ${this.tempPlaylistUri.fsPath}`);

            // Create or show the webview panel
            if (!this.panel) {
                this.panel = this.createWebviewPanel(segmentUri);
                
                // Handle messages from the webview
                this.panel.webview.onDidReceiveMessage(
                    async message => {
                        switch (message.command) {
                            case 'downloadSegment':
                                await this.remotePlaylistService.downloadSegment(message.uri, initSegmentUri);
                                break;
                            case 'requestPlaylist':
                                this.panel?.webview.postMessage({
                                    command: 'playlistContent',
                                    content: playlistContent
                                });
                                break;
                        }
                    },
                    undefined,
                    this.context.subscriptions
                );
            }

            this.panel.webview.html = this.getWebviewContent(segmentUri, this.tempPlaylistUri);
            this.panel.reveal(vscode.ViewColumn.Beside, true);

        } catch (error: any) {
            const errorMessage = `Failed to show segment preview: ${error.message}`;
            this.log(errorMessage);
            vscode.window.showErrorMessage(errorMessage);
        }
    }

    dispose() {
        if (this.panel) {
            this.panel.dispose();
        }
        // Clean up any temporary files
        if (this.tempPlaylistUri) {
            vscode.workspace.fs.delete(this.tempPlaylistUri).then(undefined, (error: Error) => {
                this.log(`Failed to delete temporary playlist: ${error}`);
            });
        }
    }
} 