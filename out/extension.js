"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
let decorationType1;
let decorationType2;
let decorationTypeDiscontinuity;
let baseDecorationType;
function getConfiguration() {
    const config = vscode.workspace.getConfiguration('m3u8.features');
    return {
        colorBanding: config.get('colorBanding', true),
        segmentNumbering: config.get('segmentNumbering', true),
        folding: config.get('folding', true)
    };
}
function activate(context) {
    // Create base decoration type for all lines
    baseDecorationType = vscode.window.createTextEditorDecorationType({
        before: {
            contentText: '',
            margin: '0 0 0 8px'
        }
    });
    // Create decoration types with high contrast colors
    decorationType1 = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(25, 35, 50, 0.35)',
        borderStyle: 'solid',
        borderWidth: '0 0 0 2px',
        borderColor: 'rgba(50, 120, 220, 0.8)',
        isWholeLine: true
    });
    decorationType2 = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(40, 55, 75, 0.25)',
        borderStyle: 'solid',
        borderWidth: '0 0 0 2px',
        borderColor: 'rgba(100, 160, 255, 0.6)',
        isWholeLine: true
    });
    decorationTypeDiscontinuity = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(80, 30, 50, 0.35)',
        borderStyle: 'solid',
        borderWidth: '0 0 0 2px',
        borderColor: 'rgba(255, 64, 150, 0.8)',
        isWholeLine: true
    });
    // Register the folding range provider only if folding is enabled
    if (getConfiguration().folding) {
        context.subscriptions.push(vscode.languages.registerFoldingRangeProvider('m3u8', {
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
        }));
    }
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
    const decorations1 = [];
    const decorations2 = [];
    const decorationsDiscontinuity = [];
    const baseDecorations = [];
    let isInSegment = false;
    let segmentCount = 0;
    let hasDiscontinuity = false;
    let currentSegmentDecorations = [];
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
                hasDiscontinuity = false;
                currentSegmentDecorations = [];
            }
            // Check for DISCONTINUITY tag
            if (text.includes('DISCONTINUITY')) {
                hasDiscontinuity = true;
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
                // Add all decorations for this segment to the appropriate array if color banding is enabled
                if (config.colorBanding) {
                    if (hasDiscontinuity) {
                        decorationsDiscontinuity.push(...currentSegmentDecorations);
                    }
                    else if (segmentCount % 2 === 1) {
                        decorations1.push(...currentSegmentDecorations);
                    }
                    else {
                        decorations2.push(...currentSegmentDecorations);
                    }
                }
                isInSegment = false;
                currentSegmentDecorations = [];
            }
        }
    }
    editor.setDecorations(baseDecorationType, baseDecorations);
    editor.setDecorations(decorationType1, config.colorBanding ? decorations1 : []);
    editor.setDecorations(decorationType2, config.colorBanding ? decorations2 : []);
    editor.setDecorations(decorationTypeDiscontinuity, config.colorBanding ? decorationsDiscontinuity : []);
}
function deactivate() {
    if (decorationType1) {
        decorationType1.dispose();
    }
    if (decorationType2) {
        decorationType2.dispose();
    }
    if (decorationTypeDiscontinuity) {
        decorationTypeDiscontinuity.dispose();
    }
    if (baseDecorationType) {
        baseDecorationType.dispose();
    }
}
//# sourceMappingURL=extension.js.map