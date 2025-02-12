import * as vscode from 'vscode';
import { HLSTagInfo } from '../types';
import { extractTag } from '../utils';

export class M3U8FoldingRangeProvider implements vscode.FoldingRangeProvider {
    constructor(private tagDefinitions: Record<string, HLSTagInfo>) {}

    private isSegmentTag(tag: string): boolean {
        const tagInfo = this.tagDefinitions[tag];
        return tagInfo ? tagInfo.context === 'segment' : true;
    }

    private isHeaderOrMultivariantTag(tag: string): boolean {
        const tagInfo = this.tagDefinitions[tag];
        return tagInfo ? (tagInfo.context === 'header' || tagInfo.context === 'multivariant') : false;
    }

    provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] {
        const ranges: vscode.FoldingRange[] = [];
        let startLine: number | undefined;
        let inHeader = true;

        for (let i = 0; i < document.lineCount; i++) {
            const line = document.lineAt(i);
            const text = line.text.trim();

            // Skip empty lines and comments
            if (text === '' || text.startsWith('# ')) {
                continue;
            }

            if (text.startsWith('#')) {
                const tag = extractTag(text);
                if (tag) {
                    if (this.isHeaderOrMultivariantTag(tag)) {
                        // Reset any open segment range
                        if (startLine !== undefined) {
                            if (i > startLine + 1) { // Only create range if we have at least 2 lines
                                ranges.push(new vscode.FoldingRange(startLine, i - 1));
                            }
                            startLine = undefined;
                        }
                        continue; // Skip header/multivariant tags for folding
                    }

                    if (this.isSegmentTag(tag)) {
                        inHeader = false;
                        if (startLine === undefined) {
                            startLine = i;
                        }
                    }
                }
            } else if (!text.startsWith('#')) {
                // Found a URI line
                inHeader = false;
                if (startLine !== undefined) {
                    // Create a folding range from first line to this line
                    if (i > startLine) { // Only create range if we have at least 2 lines
                        ranges.push(new vscode.FoldingRange(startLine, i));
                    }
                    startLine = undefined;
                }
            }
        }

        return ranges;
    }
} 