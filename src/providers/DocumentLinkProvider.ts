import * as vscode from 'vscode';
import { RemotePlaylistInfo } from '../types';
import { isValidUrl, resolveUri } from '../utils';

export class M3U8DocumentLinkProvider implements vscode.DocumentLinkProvider {
    constructor(
        private remotePlaylistMap: Map<string, RemotePlaylistInfo>,
        private log: (message: string) => void
    ) {}

    provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
        this.log(`Providing document links for ${document.uri.toString()}`);
        const links: vscode.DocumentLink[] = [];
        const baseUri = this.remotePlaylistMap.get(document.uri.toString())?.uri;

        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            const text = line.text.trim();
            
            // Skip empty lines and tags
            if (!text || text.startsWith('#')) {
                continue;
            }

            this.log(`Found potential link: ${text}`);
            const range = new vscode.Range(
                new vscode.Position(i, line.firstNonWhitespaceCharacterIndex),
                new vscode.Position(i, line.text.length)
            );

            const link = new vscode.DocumentLink(range);
            
            // Resolve the URL and set the tooltip
            let resolvedUrl = text;
            if (baseUri && !isValidUrl(text)) {
                resolvedUrl = resolveUri(baseUri, text);
            }
            link.tooltip = `Click to open: ${resolvedUrl}`;

            // Create the command URI with the resolved URL
            const args = JSON.stringify([resolvedUrl]);
            link.target = vscode.Uri.parse(`command:m3u8._handleUriClick?${encodeURIComponent(args)}`);
            
            links.push(link);
        }

        this.log(`Found ${links.length} links in document`);
        return links;
    }
} 