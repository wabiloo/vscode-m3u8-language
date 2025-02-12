import * as path from 'path';
import * as vscode from 'vscode';
import { ColorScheme, HLSTagInfo } from '../types';
import { extractTag, formatDateTime, formatDuration, getConfiguration, parseDateTime } from '../utils';

export class DecorationManager {
    private decorationTypes: Map<string, vscode.TextEditorDecorationType> = new Map();
    private baseDecorationType!: vscode.TextEditorDecorationType;
    private streamInfDecorationType!: vscode.TextEditorDecorationType;
    private audioMediaDecorationType!: vscode.TextEditorDecorationType;
    private subtitleMediaDecorationType!: vscode.TextEditorDecorationType;
    private iFrameStreamInfDecorationType!: vscode.TextEditorDecorationType;
    private tagIconDecorationTypes: Map<string, vscode.TextEditorDecorationType> = new Map();
    private linkDecorationType!: vscode.TextEditorDecorationType;

    constructor(private context: vscode.ExtensionContext, private tagDefinitions: Record<string, HLSTagInfo>) {
        this.initializeDecorationTypes();
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

        // Create icon decoration types
        const streamIconPath = path.join(this.context.extensionPath, 'images', 'stream.svg');
        const audioIconPath = path.join(this.context.extensionPath, 'images', 'audio.svg');
        const subtitleIconPath = path.join(this.context.extensionPath, 'images', 'subtitle.svg');
        const iframeIconPath = path.join(this.context.extensionPath, 'images', 'iframe.svg');

        this.streamInfDecorationType = vscode.window.createTextEditorDecorationType({
            gutterIconPath: vscode.Uri.file(streamIconPath)
        });

        this.audioMediaDecorationType = vscode.window.createTextEditorDecorationType({
            gutterIconPath: vscode.Uri.file(audioIconPath)
        });

        this.subtitleMediaDecorationType = vscode.window.createTextEditorDecorationType({
            gutterIconPath: vscode.Uri.file(subtitleIconPath)
        });

        this.iFrameStreamInfDecorationType = vscode.window.createTextEditorDecorationType({
            gutterIconPath: vscode.Uri.file(iframeIconPath)
        });

        // Create tag icon decoration types
        Object.entries(this.tagDefinitions).forEach(([tag, info]) => {
            if (info.icon) {
                const iconPath = path.join(this.context.extensionPath, 'images', `${info.icon}.svg`);
                this.tagIconDecorationTypes.set(tag, vscode.window.createTextEditorDecorationType({
                    gutterIconPath: vscode.Uri.file(iconPath)
                }));
            }
        });

        this.updateDecorationTypes();
    }

    private createDecorationTypeFromScheme(scheme: ColorScheme): vscode.TextEditorDecorationType {
        return vscode.window.createTextEditorDecorationType({
            backgroundColor: scheme.backgroundColor,
            borderStyle: 'solid',
            borderWidth: '0 0 0 2px',
            borderColor: scheme.borderColor,
            isWholeLine: true
        });
    }

    private updateDecorationTypes() {
        // Dispose existing decoration types
        this.decorationTypes.forEach(type => type.dispose());
        this.decorationTypes.clear();

        const config = getConfiguration();

        // Create decoration types for tag colors
        config.tagColors.forEach((scheme, tag) => {
            this.decorationTypes.set(tag, this.createDecorationTypeFromScheme(scheme));
        });

        // Create decoration types for default colors
        this.decorationTypes.set('odd', this.createDecorationTypeFromScheme(config.defaultColors.odd));
        this.decorationTypes.set('even', this.createDecorationTypeFromScheme(config.defaultColors.even));
    }

    private getIconForTag(text: string): string | undefined {
        // First check for DATERANGE special cases
        if (text.startsWith('#EXT-X-DATERANGE:')) {
            if (text.includes('SCTE35-IN')) return 'cue-in';
            if (text.includes('SCTE35-OUT')) return 'cue-out';
            return 'cue';
        }

        const match = text.match(/^#((?:EXT-)?(?:X-)?[A-Z0-9-]+)(?::|$)/);
        if (!match) return undefined;

        const tag = match[1];
        const tagInfo = this.tagDefinitions[tag];
        return tagInfo?.icon;
    }

    updateDecorations(editor: vscode.TextEditor) {
        if (editor.document.languageId !== 'm3u8') {
            return;
        }

        const config = getConfiguration();
        const decorationsMap = new Map<string, vscode.DecorationOptions[]>();
        this.decorationTypes.forEach((_, key) => decorationsMap.set(key, []));

        const baseDecorations: vscode.DecorationOptions[] = [];
        const streamInfDecorations: vscode.DecorationOptions[] = [];
        const audioMediaDecorations: vscode.DecorationOptions[] = [];
        const subtitleMediaDecorations: vscode.DecorationOptions[] = [];
        const iFrameStreamInfDecorations: vscode.DecorationOptions[] = [];
        const iconDecorations = new Map<string, vscode.DecorationOptions[]>();

        let isInSegment = false;
        let segmentCount = 0;
        let currentSegmentDecorations: vscode.DecorationOptions[] = [];
        let currentSegmentTags: Set<string> = new Set();

        // Track timing information
        let runningDuration = 0;
        let currentSegmentDuration = 0;
        let lastPDT: Date | null = null;
        let currentExplicitPDT: Date | null = null;
        let lastSegmentDuration = 0;

        // Initialize icon decorations
        Object.values(this.tagDefinitions).forEach(info => {
            if (info.icon) {
                iconDecorations.set(info.icon, []);
            }
        });

        // Add base decoration for every line
        for (let i = 0; i < editor.document.lineCount; i++) {
            const line = editor.document.lineAt(i);
            baseDecorations.push({ range: line.range });
        }

        // Process each line
        for (let i = 0; i < editor.document.lineCount; i++) {
            const line = editor.document.lineAt(i);
            const text = line.text.trim();

            if (text === '' || text.startsWith('# ')) {
                continue;
            }

            if (text.startsWith('#')) {
                // Handle multivariant playlist icons
                if (text.startsWith('#EXT-X-STREAM-INF:')) {
                    streamInfDecorations.push({ range: line.range });
                } else if (text.startsWith('#EXT-X-MEDIA:')) {
                    const typeMatch = text.match(/TYPE=([A-Z]+)/);
                    if (typeMatch) {
                        const mediaType = typeMatch[1];
                        if (mediaType === 'AUDIO') {
                            audioMediaDecorations.push({ range: line.range });
                        } else if (mediaType === 'SUBTITLES') {
                            subtitleMediaDecorations.push({ range: line.range });
                        }
                    }
                } else if (text.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
                    iFrameStreamInfDecorations.push({ range: line.range });
                } else if (text.startsWith('#EXTINF:')) {
                    const durationMatch = text.match(/#EXTINF:([0-9.]+)/);
                    if (durationMatch) {
                        currentSegmentDuration = parseFloat(durationMatch[1]);
                    }
                } else if (text.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
                    const pdtMatch = text.match(/#EXT-X-PROGRAM-DATE-TIME:(.+)/);
                    if (pdtMatch) {
                        currentExplicitPDT = parseDateTime(pdtMatch[1]);
                    }
                }

                // Handle JSON-defined icons
                const iconType = this.getIconForTag(text);
                if (iconType) {
                    const decorations = iconDecorations.get(iconType);
                    if (decorations) {
                        decorations.push({ range: line.range });
                    }
                }

                // Handle segment tracking
                const tag = extractTag(text);
                if (tag) {
                    if (this.isHeaderOrMultivariantTag(tag)) {
                        if (isInSegment) {
                            this.finalizeSegment(decorationsMap, currentSegmentDecorations, currentSegmentTags, segmentCount, config);
                            isInSegment = false;
                            currentSegmentDecorations = [];
                            currentSegmentTags.clear();
                        }
                    }

                    if (this.isSegmentTag(tag)) {
                        if (!isInSegment) {
                            isInSegment = true;
                            segmentCount++;
                            currentSegmentDecorations = [];
                            currentSegmentTags = new Set();
                        }
                        const match = text.match(/#(?:EXT-X-)?([A-Z-]+)(?::|$)/);
                        if (match) {
                            currentSegmentTags.add(match[1]);
                        }
                        currentSegmentDecorations.push({ range: line.range });
                    }
                }
            } else {
                // Handle URI line
                if (isInSegment) {
                    let segmentPDT: Date | null = null;
                    if (currentExplicitPDT) {
                        segmentPDT = currentExplicitPDT;
                        lastPDT = currentExplicitPDT;
                    } else if (lastPDT) {
                        segmentPDT = new Date(lastPDT.getTime() + lastSegmentDuration * 1000);
                        lastPDT = segmentPDT;
                    }

                    const decoration = {
                        range: line.range,
                        renderOptions: {
                            after: {
                                contentText: [
                                    config.segmentNumbering ? `#${segmentCount}` : '',
                                    config.showRunningDuration ? `Σ ${formatDuration(runningDuration)}` : '',
                                    (config.showProgramDateTime && segmentPDT) ? `⏲ ${formatDateTime(segmentPDT)}` : ''
                                ].filter(Boolean).join(' | '),
                                color: '#888',
                                margin: '0 3em',
                                backgroundColor: 'transparent',
                                fontStyle: 'italic',
                                fontSize: '90%'
                            }
                        }
                    };
                    currentSegmentDecorations.push(decoration);

                    runningDuration += currentSegmentDuration;
                    lastSegmentDuration = currentSegmentDuration;

                    this.finalizeSegment(decorationsMap, currentSegmentDecorations, currentSegmentTags, segmentCount, config);
                    isInSegment = false;
                    currentSegmentDecorations = [];
                    currentSegmentTags.clear();
                    currentSegmentDuration = 0;
                    currentExplicitPDT = null;
                }
            }
        }

        // Apply decorations
        if (config.gutterIcons) {
            editor.setDecorations(this.streamInfDecorationType, streamInfDecorations);
            editor.setDecorations(this.audioMediaDecorationType, audioMediaDecorations);
            editor.setDecorations(this.subtitleMediaDecorationType, subtitleMediaDecorations);
            editor.setDecorations(this.iFrameStreamInfDecorationType, iFrameStreamInfDecorations);

            for (const [tag, info] of Object.entries(this.tagDefinitions)) {
                if (info.icon) {
                    const decorationType = this.tagIconDecorationTypes.get(tag);
                    const decorations = iconDecorations.get(info.icon);
                    if (decorationType && decorations) {
                        editor.setDecorations(decorationType, decorations);
                    }
                }
            }
        } else {
            editor.setDecorations(this.streamInfDecorationType, []);
            editor.setDecorations(this.audioMediaDecorationType, []);
            editor.setDecorations(this.subtitleMediaDecorationType, []);
            editor.setDecorations(this.iFrameStreamInfDecorationType, []);
            this.tagIconDecorationTypes.forEach(type => editor.setDecorations(type, []));
        }

        editor.setDecorations(this.baseDecorationType, baseDecorations);
        this.decorationTypes.forEach((type, key) => {
            editor.setDecorations(type, config.colorBanding ? (decorationsMap.get(key) || []) : []);
        });
    }

    updateLinkDecorations(editor: vscode.TextEditor) {
        if (editor.document.languageId !== 'm3u8') {
            return;
        }

        const decorations: vscode.DecorationOptions[] = [];
        
        for (let i = 0; i < editor.document.lineCount; i++) {
            const line = editor.document.lineAt(i);
            const text = line.text.trim();
            
            if (!text || text.startsWith('#')) {
                continue;
            }

            const range = new vscode.Range(
                new vscode.Position(i, line.firstNonWhitespaceCharacterIndex),
                new vscode.Position(i, line.text.length)
            );

            decorations.push({ range });
        }

        editor.setDecorations(this.linkDecorationType, decorations);
    }

    private finalizeSegment(
        decorationsMap: Map<string, vscode.DecorationOptions[]>,
        currentSegmentDecorations: vscode.DecorationOptions[],
        currentSegmentTags: Set<string>,
        segmentCount: number,
        config: any
    ) {
        if (config.colorBanding) {
            let matchingTag = Array.from(currentSegmentTags).find(tag => 
                config.tagColors.has(tag)
            );

            if (matchingTag) {
                decorationsMap.get(matchingTag)?.push(...currentSegmentDecorations);
            } else {
                const key = segmentCount % 2 === 1 ? 'odd' : 'even';
                decorationsMap.get(key)?.push(...currentSegmentDecorations);
            }
        }
    }

    private isSegmentTag(tag: string): boolean {
        const tagInfo = this.tagDefinitions[tag];
        return tagInfo ? tagInfo.context === 'segment' : true;
    }

    private isHeaderOrMultivariantTag(tag: string): boolean {
        const tagInfo = this.tagDefinitions[tag];
        return tagInfo ? (tagInfo.context === 'header' || tagInfo.context === 'multivariant') : false;
    }

    dispose() {
        this.decorationTypes.forEach(type => type.dispose());
        this.decorationTypes.clear();
        this.baseDecorationType.dispose();
        this.streamInfDecorationType.dispose();
        this.audioMediaDecorationType.dispose();
        this.subtitleMediaDecorationType.dispose();
        this.iFrameStreamInfDecorationType.dispose();
        this.tagIconDecorationTypes.forEach(type => type.dispose());
        this.tagIconDecorationTypes.clear();
        this.linkDecorationType.dispose();
    }
} 