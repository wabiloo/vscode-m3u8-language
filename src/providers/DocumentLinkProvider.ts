import * as vscode from 'vscode';
import { RemotePlaylistInfo } from '../types';

export class M3U8DocumentLinkProvider implements vscode.DocumentLinkProvider {
    constructor(
        private remotePlaylistMap: Map<string, RemotePlaylistInfo>,
        private log: (message: string) => void
    ) {}

    private isMultiVariantPlaylist(content: string): boolean {
        return content.includes('#EXT-X-STREAM-INF:') || content.includes('#EXT-X-MEDIA:');
    }

    provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
        this.log(`Providing document links for ${document.uri.toString()}`);
        const links: vscode.DocumentLink[] = [];
        const baseUri = this.remotePlaylistMap.get(document.uri.toString())?.uri;
        const isMultiVariant = this.isMultiVariantPlaylist(document.getText());

        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            const text = line.text.trim();
            
            if (text.startsWith('#')) {
                // Handle URIs in any tag attributes
                const uriMatches = text.matchAll(/URI="([^"]+)"/g);
                for (const match of uriMatches) {
                    const uri = match[1];
                    const startPos = line.text.indexOf(uri);
                    const range = new vscode.Range(
                        new vscode.Position(i, startPos),
                        new vscode.Position(i, startPos + uri.length)
                    );
                    
                    const link = new vscode.DocumentLink(range);
                    let resolvedUrl = uri;
                    if (baseUri && !this.isValidUrl(uri)) {
                        resolvedUrl = new URL(uri, baseUri).toString();
                    }
                    
                    link.tooltip = isMultiVariant ? 
                        `Click to open: ${resolvedUrl}` : 
                        `Click to download: ${resolvedUrl}`;
                    
                    const args = JSON.stringify([resolvedUrl]);
                    link.target = vscode.Uri.parse(`command:m3u8._handleUriClick?${encodeURIComponent(args)}`);
                    links.push(link);
                }

                // Also handle URIs in non-quoted attributes (e.g., URI=example.m3u8)
                const unquotedUriMatches = text.matchAll(/URI=([^,\s"]+)/g);
                for (const match of unquotedUriMatches) {
                    const uri = match[1];
                    const startPos = line.text.indexOf(uri);
                    const range = new vscode.Range(
                        new vscode.Position(i, startPos),
                        new vscode.Position(i, startPos + uri.length)
                    );
                    
                    const link = new vscode.DocumentLink(range);
                    let resolvedUrl = uri;
                    if (baseUri && !this.isValidUrl(uri)) {
                        resolvedUrl = new URL(uri, baseUri).toString();
                    }
                    
                    link.tooltip = isMultiVariant ? 
                        `Click to open: ${resolvedUrl}` : 
                        `Click to download: ${resolvedUrl}`;
                    
                    const args = JSON.stringify([resolvedUrl]);
                    link.target = vscode.Uri.parse(`command:m3u8._handleUriClick?${encodeURIComponent(args)}`);
                    links.push(link);
                }
            } else if (text) {
                // Handle standalone URI lines
                const range = new vscode.Range(
                    new vscode.Position(i, line.firstNonWhitespaceCharacterIndex),
                    new vscode.Position(i, line.text.length)
                );

                const link = new vscode.DocumentLink(range);
                
                let resolvedUrl = text;
                if (baseUri && !this.isValidUrl(text)) {
                    resolvedUrl = new URL(text, baseUri).toString();
                }

                link.tooltip = isMultiVariant ? 
                    `Click to open: ${resolvedUrl}` : 
                    `Click to download: ${resolvedUrl}`;

                const args = JSON.stringify([resolvedUrl]);
                link.target = vscode.Uri.parse(`command:m3u8._handleUriClick?${encodeURIComponent(args)}`);
                
                links.push(link);
            }
        }

        this.log(`Found ${links.length} links in document`);
        return links;
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