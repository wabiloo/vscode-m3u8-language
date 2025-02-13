import * as vscode from 'vscode';
import { HLSTagInfo } from '../types';
import { getConfiguration } from '../utils';

export class M3U8HoverProvider implements vscode.HoverProvider {
    constructor(private tagDefinitions: Record<string, HLSTagInfo>) {}

    provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | null {
        const line = document.lineAt(position.line);
        const text = line.text.trim();

        // Only process lines starting with #
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
            // This allows URI tooltips to still work since they're handled elsewhere
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