import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

interface ColorScheme {
    backgroundColor: string;
    borderColor: string;
}

interface DefaultColors {
    odd: ColorScheme;
    even: ColorScheme;
}

interface HLSTagInfo {
    section: string;
    url: string;
    summary: string;
    context: 'header' | 'segment' | 'multivariant' | 'footer';
}

let decorationTypes: Map<string, vscode.TextEditorDecorationType> = new Map();
let baseDecorationType: vscode.TextEditorDecorationType;
let foldingProviderDisposable: vscode.Disposable | undefined;

// Load HLS tag definitions from JSON file
function loadHLSTagDefinitions(context: vscode.ExtensionContext): Record<string, HLSTagInfo> {
    const jsonPath = path.join(context.extensionPath, 'hls-tags.json');
    const jsonContent = fs.readFileSync(jsonPath, 'utf8');
    return JSON.parse(jsonContent);
}

function parseTagColor(tagColor: string): { tag: string, scheme: ColorScheme } | undefined {
    const parts = tagColor.split(',');
    if (parts.length === 3) {
        return {
            tag: parts[0],
            scheme: {
                borderColor: parts[1],
                backgroundColor: parts[2]
            }
        };
    }
    return undefined;
}

function getConfiguration() {
    const config = vscode.workspace.getConfiguration('m3u8.features');
    const tagColors = new Map<string, ColorScheme>();
    
    // Parse tag colors from simple string format
    const tagColorStrings = config.get<string[]>('tagColors', []);
    tagColorStrings.forEach(tagColor => {
        const parsed = parseTagColor(tagColor);
        if (parsed) {
            tagColors.set(parsed.tag, parsed.scheme);
        }
    });

    return {
        colorBanding: config.get('colorBanding', true),
        segmentNumbering: config.get('segmentNumbering', true),
        folding: config.get('folding', true),
        tagColors,
        defaultColors: config.get<DefaultColors>('defaultColors', {
            odd: {
                backgroundColor: 'rgba(25, 35, 50, 0.35)',
                borderColor: 'rgba(50, 120, 220, 0.8)'
            },
            even: {
                backgroundColor: 'rgba(40, 55, 75, 0.25)',
                borderColor: 'rgba(100, 160, 255, 0.6)'
            }
        })
    };
}

function createDecorationTypeFromScheme(scheme: ColorScheme): vscode.TextEditorDecorationType {
    return vscode.window.createTextEditorDecorationType({
        backgroundColor: scheme.backgroundColor,
        borderStyle: 'solid',
        borderWidth: '0 0 0 2px',
        borderColor: scheme.borderColor,
        isWholeLine: true
    });
}

function updateDecorationTypes() {
    // Dispose existing decoration types
    decorationTypes.forEach(type => type.dispose());
    decorationTypes.clear();

    const config = getConfiguration();

    // Create decoration types for tag colors
    config.tagColors.forEach((scheme, tag) => {
        decorationTypes.set(tag, createDecorationTypeFromScheme(scheme));
    });

    // Create decoration types for default colors
    decorationTypes.set('odd', createDecorationTypeFromScheme(config.defaultColors.odd));
    decorationTypes.set('even', createDecorationTypeFromScheme(config.defaultColors.even));
}

function isSegmentTag(tag: string, tagDefinitions: Record<string, HLSTagInfo>): boolean {
    const tagInfo = tagDefinitions[tag];
    return tagInfo ? tagInfo.context === 'segment' : true; // Unknown tags are treated as segment tags if they appear before a URI
}

function isHeaderOrMultivariantTag(tag: string, tagDefinitions: Record<string, HLSTagInfo>): boolean {
    const tagInfo = tagDefinitions[tag];
    return tagInfo ? (tagInfo.context === 'header' || tagInfo.context === 'multivariant') : false;
}

function extractTag(line: string): string | null {
    const match = line.match(/^#((?:EXT-X-)?[A-Z-]+)(?::|$)/);
    return match ? match[1] : null;
}

function registerFoldingProvider(context: vscode.ExtensionContext) {
    // Load tag definitions
    const tagDefinitions = loadHLSTagDefinitions(context);

    // Dispose of existing provider if it exists
    if (foldingProviderDisposable) {
        foldingProviderDisposable.dispose();
        foldingProviderDisposable = undefined;
    }

    // Only register if folding is enabled
    if (getConfiguration().folding) {
        foldingProviderDisposable = vscode.languages.registerFoldingRangeProvider('m3u8', {
            provideFoldingRanges(document: vscode.TextDocument): vscode.FoldingRange[] {
                const ranges: vscode.FoldingRange[] = [];
                let startLine: number | undefined;
                let inHeader = true; // Track if we're still in the header section

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
                            if (isHeaderOrMultivariantTag(tag, tagDefinitions)) {
                                // Reset any open segment range
                                if (startLine !== undefined) {
                                    if (i > startLine + 1) { // Only create range if we have at least 2 lines
                                        ranges.push(new vscode.FoldingRange(startLine, i - 1));
                                    }
                                    startLine = undefined;
                                }
                                continue; // Skip header/multivariant tags for folding
                            }

                            if (isSegmentTag(tag, tagDefinitions)) {
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
        });
        context.subscriptions.push(foldingProviderDisposable);
    }
}

export function activate(context: vscode.ExtensionContext) {
    // Load tag definitions
    const HLS_TAG_SPEC_MAPPING = loadHLSTagDefinitions(context);

    // Create base decoration type for all lines
    baseDecorationType = vscode.window.createTextEditorDecorationType({
        before: {
            contentText: '',
            margin: '0 0 0 8px'
        }
    });

    // Initialize decoration types
    updateDecorationTypes();

    // Initial registration of folding provider
    registerFoldingProvider(context);

    // Listen for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('m3u8.features.folding')) {
                registerFoldingProvider(context);
            }
            if (e.affectsConfiguration('m3u8.features')) {
                updateDecorationTypes();
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    updateDecorations(editor, context);
                }
            }
        })
    );

    // Update decorations when the active editor changes
    vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
            updateDecorations(editor, context);
        }
    }, null, context.subscriptions);

    // Update decorations when the document changes
    vscode.workspace.onDidChangeTextDocument(event => {
        const editor = vscode.window.activeTextEditor;
        if (editor && event.document === editor.document) {
            updateDecorations(editor, context);
        }
    }, null, context.subscriptions);

    // Initial update for the active editor
    if (vscode.window.activeTextEditor) {
        updateDecorations(vscode.window.activeTextEditor, context);
    }

    // Register hover provider
    context.subscriptions.push(
        vscode.languages.registerHoverProvider('m3u8', {
            provideHover(document: vscode.TextDocument, position: vscode.Position) {
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
                const tagInfo = HLS_TAG_SPEC_MAPPING[fullTag];
                
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
        })
    );
}

function updateDecorations(editor: vscode.TextEditor, context: vscode.ExtensionContext) {
    const document = editor.document;
    if (document.languageId !== 'm3u8') {
        return;
    }

    // Load tag definitions
    const tagDefinitions = loadHLSTagDefinitions(context);

    const config = getConfiguration();
    const decorationsMap = new Map<string, vscode.DecorationOptions[]>();
    decorationTypes.forEach((_, key) => decorationsMap.set(key, []));

    const baseDecorations: vscode.DecorationOptions[] = [];
    let isInSegment = false;
    let segmentCount = 0;
    let currentSegmentDecorations: vscode.DecorationOptions[] = [];
    let currentSegmentTags: Set<string> = new Set();

    // Add base decoration for every line
    for (let i = 0; i < document.lineCount; i++) {
        const line = document.lineAt(i);
        baseDecorations.push({ range: line.range });
    }

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
                if (isHeaderOrMultivariantTag(tag, tagDefinitions)) {
                    // Reset any open segment if we encounter a header/multivariant tag
                    if (isInSegment) {
                        // Add decorations to appropriate collection if color banding is enabled
                        if (config.colorBanding) {
                            // Find first matching tag that has a color scheme
                            let matchingTag = Array.from(currentSegmentTags).find(tag => 
                                config.tagColors.has(tag)
                            );

                            if (matchingTag) {
                                decorationsMap.get(matchingTag)?.push(...currentSegmentDecorations);
                            } else {
                                // Use default alternating colors
                                const key = segmentCount % 2 === 1 ? 'odd' : 'even';
                                decorationsMap.get(key)?.push(...currentSegmentDecorations);
                            }
                        }
                        isInSegment = false;
                        currentSegmentDecorations = [];
                        currentSegmentTags.clear();
                    }
                    continue;
                }

                if (isSegmentTag(tag, tagDefinitions)) {
                    if (!isInSegment) {
                        isInSegment = true;
                        segmentCount++;
                        currentSegmentDecorations = [];
                        currentSegmentTags = new Set();
                    }
                    // Extract tag from line (everything after #EXT-X- until first : or end)
                    const match = text.match(/#(?:EXT-X-)?([A-Z-]+)(?::|$)/);
                    if (match) {
                        currentSegmentTags.add(match[1]);
                    }
                    // Create decoration for this line
                    const range = line.range;
                    const decoration = { range };
                    currentSegmentDecorations.push(decoration);
                }
            }
        } else if (!text.startsWith('#')) {
            // Found a URI line
            if (isInSegment) {
                // Create decoration for this line with segment number
                const range = line.range;
                const decoration = {
                    range,
                    renderOptions: config.segmentNumbering ? {
                        after: {
                            contentText: `#${segmentCount}`,
                            color: '#888',
                            margin: '0 3em',
                            backgroundColor: 'transparent',
                            fontStyle: 'italic',
                            fontSize: '90%'
                        }
                    } : undefined
                };
                currentSegmentDecorations.push(decoration);

                // Add decorations to appropriate collection if color banding is enabled
                if (config.colorBanding) {
                    // Find first matching tag that has a color scheme
                    let matchingTag = Array.from(currentSegmentTags).find(tag => 
                        config.tagColors.has(tag)
                    );

                    if (matchingTag) {
                        decorationsMap.get(matchingTag)?.push(...currentSegmentDecorations);
                    } else {
                        // Use default alternating colors
                        const key = segmentCount % 2 === 1 ? 'odd' : 'even';
                        decorationsMap.get(key)?.push(...currentSegmentDecorations);
                    }
                }

                isInSegment = false;
                currentSegmentDecorations = [];
                currentSegmentTags.clear();
            }
        }
    }

    editor.setDecorations(baseDecorationType, baseDecorations);
    decorationTypes.forEach((type, key) => {
        editor.setDecorations(type, config.colorBanding ? (decorationsMap.get(key) || []) : []);
    });
}

export function deactivate() {
    decorationTypes.forEach(type => type.dispose());
    decorationTypes.clear();
    if (baseDecorationType) {
        baseDecorationType.dispose();
    }
} 