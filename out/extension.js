"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
let decorationTypes = new Map();
let baseDecorationType;
let foldingProviderDisposable;
function parseTagColor(tagColor) {
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
    const tagColors = new Map();
    // Parse tag colors from simple string format
    const tagColorStrings = config.get('tagColors', []);
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
        defaultColors: config.get('defaultColors', {
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
function createDecorationTypeFromScheme(scheme) {
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
function registerFoldingProvider(context) {
    // Dispose of existing provider if it exists
    if (foldingProviderDisposable) {
        foldingProviderDisposable.dispose();
        foldingProviderDisposable = undefined;
    }
    // Only register if folding is enabled
    if (getConfiguration().folding) {
        foldingProviderDisposable = vscode.languages.registerFoldingRangeProvider('m3u8', {
            provideFoldingRanges(document) {
                const ranges = [];
                let startLine;
                for (let i = 0; i < document.lineCount; i++) {
                    const line = document.lineAt(i);
                    const text = line.text;
                    // Skip empty lines and comments
                    if (text.trim() === '' || text.startsWith('# ')) {
                        continue;
                    }
                    // Start of a segment
                    if (text.startsWith('#') && !text.startsWith('# ')) {
                        if (startLine === undefined) {
                            startLine = i;
                        }
                    }
                    // End of a segment (non-tag line)
                    else if (!text.startsWith('#')) {
                        if (startLine !== undefined) {
                            // Create a folding range from first line to last line
                            // The folding marker will be on the first line
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
function activate(context) {
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
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('m3u8.features.folding')) {
            registerFoldingProvider(context);
        }
        if (e.affectsConfiguration('m3u8.features')) {
            updateDecorationTypes();
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                updateDecorations(editor);
            }
        }
    }));
    // Update decorations when the active editor changes
    vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) {
            updateDecorations(editor);
        }
    }, null, context.subscriptions);
    // Update decorations when the document changes
    vscode.workspace.onDidChangeTextDocument(event => {
        const editor = vscode.window.activeTextEditor;
        if (editor && event.document === editor.document) {
            updateDecorations(editor);
        }
    }, null, context.subscriptions);
    // Initial update for the active editor
    if (vscode.window.activeTextEditor) {
        updateDecorations(vscode.window.activeTextEditor);
    }
}
function updateDecorations(editor) {
    const document = editor.document;
    if (document.languageId !== 'm3u8') {
        return;
    }
    const config = getConfiguration();
    const decorationsMap = new Map();
    decorationTypes.forEach((_, key) => decorationsMap.set(key, []));
    const baseDecorations = [];
    let isInSegment = false;
    let segmentCount = 0;
    let currentSegmentDecorations = [];
    let currentSegmentTags = new Set();
    // Add base decoration for every line
    for (let i = 0; i < document.lineCount; i++) {
        const line = document.lineAt(i);
        baseDecorations.push({ range: line.range });
    }
    for (let i = 0; i < document.lineCount; i++) {
        const line = document.lineAt(i);
        const text = line.text;
        // Skip empty lines and comments
        if (text.trim() === '' || text.startsWith('# ')) {
            continue;
        }
        // Start of a new segment
        if (text.startsWith('#') && !text.startsWith('# ')) {
            if (!isInSegment) {
                isInSegment = true;
                segmentCount++;
                currentSegmentDecorations = [];
                currentSegmentTags = new Set();
            }
            // Extract tag from line (everything after #EXT-X- until first : or end)
            const match = text.match(/#EXT-X-([A-Z-]+)(?::|$)/);
            if (match) {
                currentSegmentTags.add(match[1]);
            }
            // Create decoration for this line
            const range = line.range;
            const decoration = { range };
            currentSegmentDecorations.push(decoration);
        }
        // Non-tag line within a segment
        else if (!text.startsWith('#')) {
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
                    let matchingTag = Array.from(currentSegmentTags).find(tag => config.tagColors.has(tag));
                    if (matchingTag) {
                        decorationsMap.get(matchingTag)?.push(...currentSegmentDecorations);
                    }
                    else {
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
function deactivate() {
    decorationTypes.forEach(type => type.dispose());
    decorationTypes.clear();
    if (baseDecorationType) {
        baseDecorationType.dispose();
    }
}
//# sourceMappingURL=extension.js.map