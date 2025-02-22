import * as vscode from 'vscode';
import { PlaylistUrlService } from '../services/PlaylistUrlService';
import { HLSTagInfo } from '../types';
import { getConfiguration } from '../utils';

export class M3U8HoverProvider implements vscode.HoverProvider {
    constructor(
        private tagDefinitions: Record<string, HLSTagInfo>,
        private playlistUrlService: PlaylistUrlService,
        private remotePlaylistMap: Map<string, any>
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

    provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | null {
        const line = document.lineAt(position.line);
        const text = line.text.trim();
        const wordRange = document.getWordRangeAtPosition(position, /[^"\s,]+/);
        if (!wordRange) {
            return null;
        }

        const word = document.getText(wordRange);
        const baseUri = this.getBaseUri(document);
        const isMultiVariant = this.playlistUrlService.isMultiVariantPlaylist(document.getText());

        // Check if this is a URI (either in a tag attribute or standalone)
        const isInUriAttribute = text.includes(`URI="${word}"`) || text.includes(`URI=${word}`);
        const isStandaloneUri = !text.startsWith('#') && text === word;

        if (isInUriAttribute || isStandaloneUri) {
            let resolvedUrl = word;
            if (baseUri && !this.playlistUrlService.isValidUrl(word)) {
                resolvedUrl = this.playlistUrlService.resolveUrl(word, baseUri);
            }

            const markdown = new vscode.MarkdownString();
            markdown.isTrusted = true;
            markdown.appendCodeblock(resolvedUrl, 'plaintext');
            markdown.appendMarkdown('\n\n');
            
            if (isMultiVariant) {
                markdown.appendMarkdown(`Click to open`);
            } else {
                markdown.appendMarkdown(`Click to play, right-click for more options`);
            }

            return new vscode.Hover(markdown, wordRange);
        }

        // Only process tag lines starting with #
        if (!text.startsWith('#')) {
            return null;
        }

        // Extract the full tag up to the colon or end of line
        const tagMatch = text.match(/^#((?:EXT-X-)?[A-Z-]+)(?::|$)/);
        if (!tagMatch) {
            return null;
        }

        const fullTag = tagMatch[1];
        const tagInfo = this.tagDefinitions[fullTag];
        
        if (tagInfo) {
            const config = getConfiguration();
            const showDocs = config.showTagDocumentation;

            // If documentation is disabled and this is a standard tag (has documentation), return null
            if (!showDocs && tagInfo.documentation) {
                return null;
            }

            const markdown = new vscode.MarkdownString();
            markdown.isTrusted = true;
            markdown.supportHtml = true;
            
            markdown.appendMarkdown(`**HLS Tag: #${fullTag}**\n\n`);
            markdown.appendMarkdown(`${tagInfo.summary}\n\n`);
            if (showDocs && tagInfo.documentation) {
                markdown.appendMarkdown(`[See [${tagInfo.documentation.spec}], section ${tagInfo.documentation.section}](${tagInfo.documentation.url})`);
            }
            
            return new vscode.Hover(markdown);
        }

        return null;
    }
} 