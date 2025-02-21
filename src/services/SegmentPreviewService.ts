import { URL } from 'url';
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
        return `<!DOCTYPE html>
        <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
                <style>
                    body {
                        margin: 0;
                        padding: 20px;
                        background-color: var(--vscode-editor-background);
                        color: var(--vscode-editor-foreground);
                        font-family: var(--vscode-font-family);
                        font-size: var(--vscode-font-size);
                    }
                    .segment-url {
                        word-break: break-all;
                        margin-bottom: 20px;
                        padding: 10px;
                        background-color: var(--vscode-input-background);
                        border: 1px solid var(--vscode-input-border);
                        border-radius: 4px;
                        cursor: pointer;
                    }
                    .segment-url:hover {
                        background-color: var(--vscode-list-hoverBackground);
                    }
                    .button-container {
                        margin-bottom: 20px;
                    }
                    .download-button {
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        padding: 8px 12px;
                        border-radius: 4px;
                        cursor: pointer;
                        font-family: var(--vscode-font-family);
                    }
                    .download-button:hover {
                        background-color: var(--vscode-button-hoverBackground);
                    }
                    video {
                        width: 100%;
                        max-width: 100%;
                        background-color: black;
                    }
                </style>
            </head>
            <body>
                <div class="segment-url" title="Cmd+Click in playlist to preview">${segmentUri}</div>
                <div class="button-container">
                    <button class="download-button" title="Download segment">Download Segment</button>
                </div>
                <video id="video" controls></video>
                <script>
                    const vscode = acquireVsCodeApi();
                    const video = document.getElementById('video');

                    // Handle cmd+click on segment URL
                    document.querySelector('.segment-url').addEventListener('click', (e) => {
                        if (e.metaKey || e.ctrlKey) {
                            vscode.postMessage({
                                command: 'downloadSegment',
                                uri: '${segmentUri}'
                            });
                        }
                    });

                    // Handle download button click
                    document.querySelector('.download-button').addEventListener('click', () => {
                        vscode.postMessage({
                            command: 'downloadSegment',
                            uri: '${segmentUri}'
                        });
                    });

                    // Request the playlist content for logging
                    vscode.postMessage({ command: 'requestPlaylist' });

                    // Handle messages from the extension
                    window.addEventListener('message', event => {
                        const message = event.data;
                        switch (message.command) {
                            case 'playlistContent':
                                // Log the playlist content for debugging
                                console.log('Generated HLS playlist:', message.content);
                                if (Hls.isSupported()) {
                                    const hls = new Hls({
                                        debug: true,
                                        enableWorker: false // Disable web workers in VS Code webview
                                    });

                                    // Add error handling
                                    hls.on(Hls.Events.ERROR, function(event, data) {
                                        console.log('HLS Error:', event, data);
                                        if (data.fatal) {
                                            switch(data.type) {
                                                case Hls.ErrorTypes.NETWORK_ERROR:
                                                    console.log('Fatal network error encountered');
                                                    hls.startLoad();
                                                    break;
                                                case Hls.ErrorTypes.MEDIA_ERROR:
                                                    console.log('Fatal media error encountered');
                                                    hls.recoverMediaError();
                                                    break;
                                                default:
                                                    console.log('Fatal error, cannot recover');
                                                    hls.destroy();
                                                    break;
                                            }
                                        }
                                    });

                                    // Add more event listeners for debugging
                                    hls.on(Hls.Events.MANIFEST_LOADING, () => {
                                        console.log('Manifest loading...');
                                    });
                                    hls.on(Hls.Events.MANIFEST_LOADED, (event, data) => {
                                        console.log('Manifest loaded:', data);
                                    });
                                    hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
                                        console.log('Manifest parsed:', data);
                                        video.play().catch(e => console.log('Play failed:', e));
                                    });
                                    hls.on(Hls.Events.LEVEL_LOADING, (event, data) => {
                                        console.log('Level loading:', data);
                                    });
                                    hls.on(Hls.Events.LEVEL_LOADED, (event, data) => {
                                        console.log('Level loaded:', data);
                                    });
                                    hls.on(Hls.Events.FRAG_LOADING, (event, data) => {
                                        console.log('Fragment loading:', data);
                                    });
                                    hls.on(Hls.Events.FRAG_LOADED, (event, data) => {
                                        console.log('Fragment loaded:', data);
                                    });

                                    const playlistUrl = '${this.panel?.webview.asWebviewUri(playlistUri)}';
                                    console.log('Loading playlist from:', playlistUrl);
                                    hls.loadSource(playlistUrl);
                                    hls.attachMedia(video);
                                } else {
                                    console.log('HLS.js is not supported');
                                }
                                break;
                        }
                    });
                </script>
            </body>
        </html>`;
    }

    public async showSegmentPreview(segmentUri: string, baseUri?: string) {
        try {
            // Resolve the full URI if it's relative
            const fullUri = baseUri ? new URL(segmentUri, baseUri).toString() : segmentUri;
            this.log(`Opening segment preview for ${fullUri}`);

            // Create a single-segment playlist
            const playlistContent = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXTINF:10.0,
${fullUri}
#EXT-X-ENDLIST`;

            // Log the playlist content to the output channel
            this.log('Generated HLS playlist for segment:');
            this.log(playlistContent);

            // Create the temporary playlist file
            this.tempPlaylistUri = await this.createTempPlaylist(playlistContent);
            this.log(`Created temporary playlist at: ${this.tempPlaylistUri.fsPath}`);

            // Create or show the webview panel
            if (!this.panel) {
                this.panel = this.createWebviewPanel(fullUri);
                
                // Handle messages from the webview
                this.panel.webview.onDidReceiveMessage(
                    async message => {
                        switch (message.command) {
                            case 'downloadSegment':
                                await this.remotePlaylistService.downloadSegment(message.uri);
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

            this.panel.webview.html = this.getWebviewContent(fullUri, this.tempPlaylistUri);
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