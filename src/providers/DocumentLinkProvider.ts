import * as vscode from 'vscode';
import { PlaylistUrlService } from '../services/PlaylistUrlService';
import { RemotePlaylistInfo } from '../types';

export class M3U8DocumentLinkProvider implements vscode.DocumentLinkProvider {
    constructor(
        private remotePlaylistMap: Map<string, RemotePlaylistInfo>,
        private log: (message: string) => void,
        private playlistUrlService: PlaylistUrlService
    ) {}

    private getBaseUri(document: vscode.TextDocument): string | undefined {
        // First try to get the base URL from remote playlist map
        const remoteBaseUri = this.remotePlaylistMap.get(document.uri.toString())?.uri;
        if (remoteBaseUri) {
            return remoteBaseUri;
        }

        // If not found, try to get it from the PlaylistUrlService
        return this.playlistUrlService.getDocumentBaseUrl(document.uri.toString());
    }

    async provideDocumentLinks(document: vscode.TextDocument): Promise<vscode.DocumentLink[]> {
        this.log(`Providing document links for ${document.uri.toString()}`);
        const links: vscode.DocumentLink[] = [];
        const baseUri = this.getBaseUri(document);
        const isMultiVariant = this.playlistUrlService.isMultiVariantPlaylist(document.getText());
        this.log(`Document is ${isMultiVariant ? 'a multivariant playlist' : 'a regular playlist'}`);

        // Track the current init segment
        let currentInitSegment: { uri: string, resolvedUri: string } | undefined;

        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            const text = line.text.trim();
            
            if (text.startsWith('#')) {
                // Check for EXT-X-MAP tag first
                if (text.startsWith('#EXT-X-MAP:')) {
                    const uriMatch = text.match(/URI="([^"]+)"|URI=([^,\s"]+)/);
                    if (uriMatch) {
                        const uri = uriMatch[1] || uriMatch[2];
                        const resolvedUri = baseUri && !this.playlistUrlService.isValidUrl(uri) ? 
                            this.playlistUrlService.resolveUrl(uri, baseUri) : 
                            uri;
                        currentInitSegment = { uri, resolvedUri };
                    }
                }

                // Handle URIs in quoted attributes (e.g., URI="example.m3u8")
                const uriMatches = text.matchAll(/URI="([^"]+)"/g);
                for (const match of uriMatches) {
                    const uri = match[1];
                    this.log(`Found quoted URI at line ${i + 1}: ${uri}`);
                    const startPos = line.text.indexOf(uri);
                    const range = new vscode.Range(
                        new vscode.Position(i, startPos),
                        new vscode.Position(i, startPos + uri.length)
                    );
                    
                    const link = new vscode.DocumentLink(range);
                    let resolvedUrl = uri;
                    if (baseUri && !this.playlistUrlService.isValidUrl(uri)) {
                        resolvedUrl = this.playlistUrlService.resolveUrl(uri, baseUri);
                        this.log(`  Resolved relative URI to: ${resolvedUrl}`);
                    }
                    
                    link.tooltip = isMultiVariant ? 
                        `Click to open: ${resolvedUrl}` : 
                        `${process.platform === 'darwin' ? '⌘' : 'Ctrl'}+Click to preview, right-click for more options: ${resolvedUrl}`;
                    
                    // For multivariant playlists, use _handleUriClick which will open the playlist
                    // For regular playlists, use _previewSegment for the preview functionality
                    const command = isMultiVariant ? 'm3u8._handleUriClick' : 'm3u8._previewSegment';
                    const args = isMultiVariant ? 
                        JSON.stringify([resolvedUrl, true]) : 
                        JSON.stringify([resolvedUrl, false, currentInitSegment?.resolvedUri]);
                    
                    this.log(`  Using command: ${command} with isFromMultivariant=${isMultiVariant}`);
                    link.target = vscode.Uri.parse(`command:${command}?${encodeURIComponent(args)}`);
                    
                    links.push(link);
                }

                // Also handle URIs in non-quoted attributes (e.g., URI=example.m3u8)
                const unquotedUriMatches = text.matchAll(/URI=([^,\s"]+)/g);
                for (const match of unquotedUriMatches) {
                    const uri = match[1];
                    this.log(`Found unquoted URI at line ${i + 1}: ${uri}`);
                    const startPos = line.text.indexOf(uri);
                    const range = new vscode.Range(
                        new vscode.Position(i, startPos),
                        new vscode.Position(i, startPos + uri.length)
                    );
                    
                    const link = new vscode.DocumentLink(range);
                    let resolvedUrl = uri;
                    if (baseUri && !this.playlistUrlService.isValidUrl(uri)) {
                        resolvedUrl = this.playlistUrlService.resolveUrl(uri, baseUri);
                        this.log(`  Resolved relative URI to: ${resolvedUrl}`);
                    }
                    
                    link.tooltip = isMultiVariant ? 
                        `Click to open: ${resolvedUrl}` : 
                        `${process.platform === 'darwin' ? '⌘' : 'Ctrl'}+Click to preview, right-click for more options: ${resolvedUrl}`;
                    
                    // For multivariant playlists, use _handleUriClick which will open the playlist
                    // For regular playlists, use _previewSegment for the preview functionality
                    const command = isMultiVariant ? 'm3u8._handleUriClick' : 'm3u8._previewSegment';
                    const args = isMultiVariant ? 
                        JSON.stringify([resolvedUrl, true]) : 
                        JSON.stringify([resolvedUrl, false, currentInitSegment?.resolvedUri]);
                    
                    this.log(`  Using command: ${command} with isFromMultivariant=${isMultiVariant}`);
                    link.target = vscode.Uri.parse(`command:${command}?${encodeURIComponent(args)}`);
                    
                    links.push(link);
                }
            } else if (text) {
                // Handle standalone URI lines
                this.log(`Found standalone URI at line ${i + 1}: ${text}`);
                const range = new vscode.Range(
                    new vscode.Position(i, line.firstNonWhitespaceCharacterIndex),
                    new vscode.Position(i, line.text.length)
                );

                const link = new vscode.DocumentLink(range);
                
                let resolvedUrl = text;
                if (baseUri && !this.playlistUrlService.isValidUrl(text)) {
                    resolvedUrl = this.playlistUrlService.resolveUrl(text, baseUri);
                    this.log(`  Resolved relative URI to: ${resolvedUrl}`);
                }

                link.tooltip = isMultiVariant ? 
                    `Click to open: ${resolvedUrl}` : 
                    `${process.platform === 'darwin' ? '⌘' : 'Ctrl'}+Click to preview, right-click for more options: ${resolvedUrl}`;

                // For multivariant playlists, use _handleUriClick which will open the playlist
                // For regular playlists, use _previewSegment for the preview functionality
                const command = isMultiVariant ? 'm3u8._handleUriClick' : 'm3u8._previewSegment';
                const args = isMultiVariant ? 
                    JSON.stringify([resolvedUrl, true]) : 
                    JSON.stringify([resolvedUrl, false, currentInitSegment?.resolvedUri]);
                
                this.log(`  Using command: ${command} with isFromMultivariant=${isMultiVariant}`);
                link.target = vscode.Uri.parse(`command:${command}?${encodeURIComponent(args)}`);
                
                links.push(link);
            }
        }

        this.log(`Found ${links.length} links in document`);
        return links;
    }
} 