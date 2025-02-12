import * as vscode from 'vscode';
import { HLSTagInfo } from '../types';

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
            const markdown = new vscode.MarkdownString();
            markdown.isTrusted = true;
            markdown.supportHtml = true;
            
            markdown.appendMarkdown(`**HLS Tag: #${fullTag}**\n\n`);
            markdown.appendMarkdown(`${tagInfo.summary}\n\n`);
            markdown.appendMarkdown(`[View specification section ${tagInfo.section}](${tagInfo.url})`);
            
            return new vscode.Hover(markdown);
        }

        return null;
    }
} 