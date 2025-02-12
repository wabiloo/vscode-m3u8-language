import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { URL } from 'url';
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
    icon?: string;
}

let decorationTypes: Map<string, vscode.TextEditorDecorationType> = new Map();
let baseDecorationType: vscode.TextEditorDecorationType;
let foldingProviderDisposable: vscode.Disposable | undefined;
let streamInfDecorationType: vscode.TextEditorDecorationType;
let mediaDecorationType: vscode.TextEditorDecorationType;
let iFrameStreamInfDecorationType: vscode.TextEditorDecorationType;
let audioMediaDecorationType: vscode.TextEditorDecorationType;
let subtitleMediaDecorationType: vscode.TextEditorDecorationType;
let tagIconDecorationTypes: Map<string, vscode.TextEditorDecorationType> = new Map();
let cueInDecorationType: vscode.TextEditorDecorationType;
let cueOutDecorationType: vscode.TextEditorDecorationType;
let cueDecorationType: vscode.TextEditorDecorationType;

// Add new interfaces for remote playlist handling
interface RemotePlaylistInfo {
    uri: string;
    autoRefreshEnabled: boolean;
    refreshInterval: NodeJS.Timeout | undefined;
}

const remotePlaylistMap = new Map<string, RemotePlaylistInfo>();

// Add this near the top with other interfaces
interface RemoteDocumentContent {
    content: string;
    uri: string;
}

const remoteDocumentContentMap = new Map<string, RemoteDocumentContent>();

// Create decoration type for clickable links
const linkDecorationType = vscode.window.createTextEditorDecorationType({
    textDecoration: 'underline',
    cursor: 'pointer',
    color: '#3794ff',  // VS Code's standard link color
    after: {
        contentText: ' 🔗',
        color: '#3794ff',
        margin: '0 0 0 4px'
    }
});

// Add this near the top where other interfaces are defined
let globalContext: vscode.ExtensionContext;

// Add this near the top with other global variables
let outputChannel: vscode.OutputChannel;

function log(message: string) {
    console.log(message);
    outputChannel?.appendLine(message);
}

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
        colorBanding: config.get<boolean>('colorBanding', true),
        segmentNumbering: config.get<boolean>('segmentNumbering', true),
        showRunningDuration: config.get<boolean>('showRunningDuration', true),
        showProgramDateTime: config.get<boolean>('showProgramDateTime', true),
        folding: config.get<boolean>('folding', true),
        gutterIcons: config.get<boolean>('gutterIcons', true),
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

async function fetchRemotePlaylist(uri: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const url = new URL(uri);
        const protocol = url.protocol === 'https:' ? https : http;
        
        const request = protocol.get(uri, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to fetch playlist: ${response.statusCode}`));
                return;
            }

            let data = '';
            response.on('data', (chunk) => data += chunk);
            response.on('end', () => resolve(data));
        });

        request.on('error', (error) => reject(error));
        request.end();
    });
}

async function openRemotePlaylist() {
    const lastUsedUrl = globalContext.globalState.get<string>('lastUsedM3u8Url');
    
    const uri = await vscode.window.showInputBox({
        prompt: 'Enter the URL of the M3U8 playlist',
        placeHolder: lastUsedUrl || 'https://example.com/playlist.m3u8',
        value: lastUsedUrl || ''
    });

    if (!uri) return;

    try {
        const content = await fetchRemotePlaylist(uri);
        
        // Create a virtual document URI with the remote URL as the filename
        const documentUri = vscode.Uri.parse(`m3u8-remote:/${encodeURIComponent(uri)}`);
        
        // Store the content before creating the document
        remoteDocumentContentMap.set(documentUri.toString(), {
            content,
            uri
        });
        
        const doc = await vscode.workspace.openTextDocument(documentUri);
        await vscode.window.showTextDocument(doc);
        
        // Store remote playlist info
        remotePlaylistMap.set(doc.uri.toString(), {
            uri,
            autoRefreshEnabled: false,
            refreshInterval: undefined
        });

        // Save the URL for next time
        await globalContext.globalState.update('lastUsedM3u8Url', uri);
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to fetch playlist: ${error.message}`);
    }
}

async function refreshCurrentPlaylist() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const docUri = editor.document.uri.toString();
    const playlistInfo = remotePlaylistMap.get(docUri);
    if (!playlistInfo) {
        vscode.window.showWarningMessage('Current document is not a remote playlist');
        return;
    }

    try {
        const content = await fetchRemotePlaylist(playlistInfo.uri);
        const edit = new vscode.WorkspaceEdit();
        const range = new vscode.Range(
            editor.document.positionAt(0),
            editor.document.positionAt(editor.document.getText().length)
        );
        edit.replace(editor.document.uri, range, content);
        await vscode.workspace.applyEdit(edit);
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to refresh playlist: ${error.message}`);
    }
}

function toggleAutoRefresh() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const docUri = editor.document.uri.toString();
    const playlistInfo = remotePlaylistMap.get(docUri);
    if (!playlistInfo) {
        vscode.window.showWarningMessage('Current document is not a remote playlist');
        return;
    }

    if (playlistInfo.autoRefreshEnabled) {
        if (playlistInfo.refreshInterval) {
            clearInterval(playlistInfo.refreshInterval);
            playlistInfo.refreshInterval = undefined;
        }
        playlistInfo.autoRefreshEnabled = false;
        vscode.window.showInformationMessage('Auto-refresh disabled');
    } else {
        const interval = vscode.workspace.getConfiguration('m3u8.features').get<number>('autoRefreshInterval', 10) * 1000;
        playlistInfo.refreshInterval = setInterval(() => refreshCurrentPlaylist(), interval);
        playlistInfo.autoRefreshEnabled = true;
        vscode.window.showInformationMessage(`Auto-refresh enabled (${interval/1000}s interval)`);
    }
}

function isValidUrl(str: string): boolean {
    try {
        new URL(str);
        return true;
    } catch {
        return false;
    }
}

function resolveUri(baseUri: string, relativeUri: string): string {
    try {
        return new URL(relativeUri, baseUri).toString();
    } catch {
        return relativeUri;
    }
}

async function handleUriClick(uri: string) {
    log(`handleUriClick called with uri: ${uri}`);
    
    if (isValidUrl(uri)) {
        try {
            log(`Fetching remote playlist: ${uri}`);
            const content = await fetchRemotePlaylist(uri);
            
            // Create a virtual document URI with the remote URL as the filename
            const documentUri = vscode.Uri.parse(`m3u8-remote:/${encodeURIComponent(uri)}`);
            
            // Store the content before creating the document
            remoteDocumentContentMap.set(documentUri.toString(), {
                content,
                uri
            });
            
            const doc = await vscode.workspace.openTextDocument(documentUri);
            await vscode.window.showTextDocument(doc);
            
            remotePlaylistMap.set(doc.uri.toString(), {
                uri,
                autoRefreshEnabled: false,
                refreshInterval: undefined
            });
            
            log(`Successfully opened remote playlist: ${uri}`);
        } catch (error: any) {
            const errorMessage = `Failed to open playlist: ${error.message}`;
            log(errorMessage);
            vscode.window.showErrorMessage(errorMessage);
        }
    } else {
        // Handle local file
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            log('No workspace folder found for local file');
            return;
        }

        const localPath = path.join(workspaceFolder.uri.fsPath, uri);
        log(`Attempting to open local file: ${localPath}`);
        
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(localPath));
            await vscode.window.showTextDocument(doc);
            log(`Successfully opened local file: ${localPath}`);
        } catch (error: any) {
            const errorMessage = `Failed to open local file: ${error.message}`;
            log(errorMessage);
            vscode.window.showErrorMessage(errorMessage);
        }
    }
}

export function activate(context: vscode.ExtensionContext) {
    // Create output channel for logging
    outputChannel = vscode.window.createOutputChannel('M3U8');
    context.subscriptions.push(outputChannel);

    // Store context globally
    globalContext = context;

    log('M3U8 extension activating...');

    // Load tag definitions
    const HLS_TAG_SPEC_MAPPING = loadHLSTagDefinitions(context);

    console.log('M3U8 extension activating...');

    // Create base decoration type for all lines
    baseDecorationType = vscode.window.createTextEditorDecorationType({
        before: {
            contentText: '',
            margin: '0 0 0 8px'
        }
    });

    // Create decoration types for playlist pointers with absolute paths
    const streamIconPath = path.join(context.extensionPath, 'images', 'stream.svg');
    const audioIconPath = path.join(context.extensionPath, 'images', 'audio.svg');
    const subtitleIconPath = path.join(context.extensionPath, 'images', 'subtitle.svg');
    const iframeIconPath = path.join(context.extensionPath, 'images', 'iframe.svg');
    const cueInIconPath = path.join(context.extensionPath, 'images', 'cue-in.svg');
    const cueOutIconPath = path.join(context.extensionPath, 'images', 'cue-out.svg');
    const cueIconPath = path.join(context.extensionPath, 'images', 'cue.svg');

    console.log('Extension path:', context.extensionPath);
    console.log('Icon paths:', {
        stream: streamIconPath,
        audio: audioIconPath,
        subtitle: subtitleIconPath,
        iframe: iframeIconPath,
        cueIn: cueInIconPath,
        cueOut: cueOutIconPath,
        cue: cueIconPath
    });

    try {
        // Verify files exist
        const filesExist = {
            stream: fs.existsSync(streamIconPath),
            audio: fs.existsSync(audioIconPath),
            subtitle: fs.existsSync(subtitleIconPath),
            iframe: fs.existsSync(iframeIconPath),
            cueIn: fs.existsSync(cueInIconPath),
            cueOut: fs.existsSync(cueOutIconPath),
            cue: fs.existsSync(cueIconPath)
        };
        console.log('Icons exist:', filesExist);

        if (!Object.values(filesExist).every(exists => exists)) {
            console.error('Some icon files are missing!');
        }
    } catch (error) {
        console.error('Error checking icon files:', error);
    }

    // Create decoration types
    streamInfDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.file(streamIconPath)
    });

    audioMediaDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.file(audioIconPath)
    });

    subtitleMediaDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.file(subtitleIconPath)
    });

    iFrameStreamInfDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.file(iframeIconPath)
    });

    cueInDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.file(cueInIconPath)
    });

    cueOutDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.file(cueOutIconPath)
    });

    cueDecorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.file(cueIconPath)
    });

    // Load tag definitions and create decoration types for tags with icons
    const tagDefinitions = loadHLSTagDefinitions(context);
    Object.entries(tagDefinitions).forEach(([tag, info]) => {
        if (info.icon) {
            const iconPath = path.join(context.extensionPath, 'images', `${info.icon}.svg`);
            if (fs.existsSync(iconPath)) {
                tagIconDecorationTypes.set(tag, vscode.window.createTextEditorDecorationType({
                    gutterIconPath: vscode.Uri.file(iconPath)
                }));
            }
        }
    });

    // Initialize decoration types
    updateDecorationTypes();

    // Register a command to force update decorations
    let disposable = vscode.commands.registerCommand('m3u8.refreshDecorations', () => {
        console.log('Manually refreshing decorations...');
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            updateDecorations(editor, context);
        }
    });

    context.subscriptions.push(disposable);

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

    // Register disposables
    context.subscriptions.push(
        streamInfDecorationType,
        audioMediaDecorationType,
        subtitleMediaDecorationType,
        iFrameStreamInfDecorationType,
        cueInDecorationType,
        cueOutDecorationType,
        cueDecorationType,
        ...Array.from(tagIconDecorationTypes.values())
    );

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

    // Register new commands
    context.subscriptions.push(
        vscode.commands.registerCommand('m3u8.openRemotePlaylist', openRemotePlaylist),
        vscode.commands.registerCommand('m3u8.refreshPlaylist', refreshCurrentPlaylist),
        vscode.commands.registerCommand('m3u8.toggleAutoRefresh', toggleAutoRefresh)
    );

    // Register document link provider for m3u8 files
    context.subscriptions.push(
        vscode.languages.registerDocumentLinkProvider({ language: 'm3u8', scheme: '*' }, {
            provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
                log(`Providing document links for ${document.uri.toString()}`);
                const links: vscode.DocumentLink[] = [];
                const baseUri = remotePlaylistMap.get(document.uri.toString())?.uri;

                for (let i = 0; i < document.lineCount; i++) {
                    const line = document.lineAt(i);
                    const text = line.text.trim();
                    
                    // Skip empty lines and tags
                    if (!text || text.startsWith('#')) {
                        continue;
                    }

                    log(`Found potential link: ${text}`);
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

                log(`Found ${links.length} links in document`);
                return links;
            }
        })
    );

    // Register internal command for handling URI clicks
    context.subscriptions.push(
        vscode.commands.registerCommand('m3u8._handleUriClick', async (...args) => {
            if (!args || args.length === 0) {
                log('No arguments provided to _handleUriClick');
                return;
            }
            const uri = args[0];
            log(`Handling URI click with resolved URL: ${uri}`);
            await handleUriClick(uri);
        })
    );

    // Clean up on document close
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(document => {
            const playlistInfo = remotePlaylistMap.get(document.uri.toString());
            if (playlistInfo?.refreshInterval) {
                clearInterval(playlistInfo.refreshInterval);
            }
            remotePlaylistMap.delete(document.uri.toString());
        })
    );

    // Register custom URI handler for remote m3u8 files
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('m3u8-remote', {
            provideTextDocumentContent(uri: vscode.Uri): string {
                const docContent = remoteDocumentContentMap.get(uri.toString());
                if (!docContent) {
                    return '';
                }
                return docContent.content;
            }
        })
    );

    // Clean up content map when documents are closed
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument(document => {
            remoteDocumentContentMap.delete(document.uri.toString());
        })
    );

    // Add decoration update handlers
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            if (editor) {
                updateLinkDecorations(editor);
            }
        }),
        vscode.workspace.onDidChangeTextDocument(event => {
            const editor = vscode.window.activeTextEditor;
            if (editor && event.document === editor.document) {
                updateLinkDecorations(editor);
            }
        })
    );

    // Initial update for the active editor
    if (vscode.window.activeTextEditor) {
        updateLinkDecorations(vscode.window.activeTextEditor);
    }
}

function getIconForTag(text: string, tagDefinitions: Record<string, HLSTagInfo>): string | undefined {
    // First check for DATERANGE special cases
    if (text.startsWith('#EXT-X-DATERANGE:')) {
        if (text.includes('SCTE35-IN')) {
            return 'cue-in';
        }
        if (text.includes('SCTE35-OUT')) {
            return 'cue-out';
        }
        return 'cue';  // Default to 'cue' for all other DATERANGE tags
    }

    // Extract the full tag name up to the colon
    const match = text.match(/^#((?:EXT-)?(?:X-)?[A-Z0-9-]+)(?::|$)/);
    if (!match) {
        return undefined;
    }

    const tag = match[1];
    const tagInfo = tagDefinitions[tag];
    
    if (tagInfo?.icon) {
        return tagInfo.icon;
    }

    return undefined;
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
    const streamInfDecorations: vscode.DecorationOptions[] = [];
    const audioMediaDecorations: vscode.DecorationOptions[] = [];
    const subtitleMediaDecorations: vscode.DecorationOptions[] = [];
    const iFrameStreamInfDecorations: vscode.DecorationOptions[] = [];

    // Initialize decorations for each icon type
    const iconDecorations = new Map<string, vscode.DecorationOptions[]>();
    for (const [tag, info] of Object.entries(tagDefinitions)) {
        if (info.icon) {
            iconDecorations.set(info.icon, []);
        }
    }

    let isInSegment = false;
    let segmentCount = 0;
    let currentSegmentDecorations: vscode.DecorationOptions[] = [];
    let currentSegmentTags: Set<string> = new Set();

    // Track running duration and program date time
    let runningDuration = 0;
    let currentSegmentDuration = 0;
    let lastPDT: Date | null = null;  // Last PDT (explicit or calculated)
    let currentExplicitPDT: Date | null = null;  // Explicit PDT for current segment
    let lastSegmentDuration = 0;  // Duration of the last segment

    // Add base decoration for every line
    for (let i = 0; i < document.lineCount; i++) {
        const line = document.lineAt(i);
        baseDecorations.push({ range: line.range });
    }

    for (let i = 0; i < document.lineCount; i++) {
        const line = document.lineAt(i);
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
                // Extract duration from EXTINF tag
                const durationMatch = text.match(/#EXTINF:([0-9.]+)/);
                if (durationMatch) {
                    currentSegmentDuration = parseFloat(durationMatch[1]);
                }
            } else if (text.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
                // Extract program date time for current segment
                const pdtMatch = text.match(/#EXT-X-PROGRAM-DATE-TIME:(.+)/);
                if (pdtMatch) {
                    currentExplicitPDT = parseDateTime(pdtMatch[1]);
                }
            }

            // Handle JSON-defined icons and special cases
            const iconType = getIconForTag(text, tagDefinitions);
            if (iconType) {
                const decorations = iconDecorations.get(iconType);
                if (decorations) {
                    decorations.push({ range: line.range });
                }
            }

            // Handle segment tracking for background/border decorations
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
                // Determine PDT for this segment
                let segmentPDT: Date | null = null;
                if (currentExplicitPDT) {
                    // Use explicit PDT if available
                    segmentPDT = currentExplicitPDT;
                    lastPDT = currentExplicitPDT;
                } else if (lastPDT) {
                    // Calculate PDT based on last PDT and last segment duration
                    segmentPDT = new Date(lastPDT.getTime() + lastSegmentDuration * 1000);
                    lastPDT = segmentPDT;
                }

                // Create decoration for this line with segment number and timing information
                const range = line.range;
                const decoration = {
                    range,
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

                // Update running duration and store current duration for next segment's PDT calculation
                runningDuration += currentSegmentDuration;
                lastSegmentDuration = currentSegmentDuration;

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
                currentSegmentDuration = 0;
                currentExplicitPDT = null;  // Reset explicit PDT for next segment
            }
        }
    }

    // Apply decorations
    if (config.gutterIcons) {
        // Apply built-in icons
        editor.setDecorations(streamInfDecorationType, streamInfDecorations);
        editor.setDecorations(audioMediaDecorationType, audioMediaDecorations);
        editor.setDecorations(subtitleMediaDecorationType, subtitleMediaDecorations);
        editor.setDecorations(iFrameStreamInfDecorationType, iFrameStreamInfDecorations);

        // Apply JSON-defined icons
        for (const [tag, info] of Object.entries(tagDefinitions)) {
            if (info.icon) {
                const decorationType = tagIconDecorationTypes.get(tag);
                const decorations = iconDecorations.get(info.icon);
                if (decorationType && decorations) {
                    editor.setDecorations(decorationType, decorations);
                }
            }
        }
    } else {
        // Clear all icons
        editor.setDecorations(streamInfDecorationType, []);
        editor.setDecorations(audioMediaDecorationType, []);
        editor.setDecorations(subtitleMediaDecorationType, []);
        editor.setDecorations(iFrameStreamInfDecorationType, []);
        tagIconDecorationTypes.forEach(type => editor.setDecorations(type, []));
    }

    // Apply color banding
    editor.setDecorations(baseDecorationType, baseDecorations);
    decorationTypes.forEach((type, key) => {
        editor.setDecorations(type, config.colorBanding ? (decorationsMap.get(key) || []) : []);
    });
}

function updateLinkDecorations(editor: vscode.TextEditor) {
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

    editor.setDecorations(linkDecorationType, decorations);
}

export function deactivate() {
    decorationTypes.forEach(type => type.dispose());
    decorationTypes.clear();
    if (baseDecorationType) {
        baseDecorationType.dispose();
    }
    streamInfDecorationType?.dispose();
    audioMediaDecorationType?.dispose();
    subtitleMediaDecorationType?.dispose();
    iFrameStreamInfDecorationType?.dispose();
    cueInDecorationType?.dispose();
    cueOutDecorationType?.dispose();
    cueDecorationType?.dispose();
    tagIconDecorationTypes.forEach(type => type.dispose());
    tagIconDecorationTypes.clear();

    // Clean up all refresh intervals
    for (const [_, info] of remotePlaylistMap) {
        if (info.refreshInterval) {
            clearInterval(info.refreshInterval);
        }
    }
    remotePlaylistMap.clear();
}

function formatDuration(durationInSeconds: number): string {
    const hours = Math.floor(durationInSeconds / 3600);
    const minutes = Math.floor((durationInSeconds % 3600) / 60);
    const seconds = Math.floor(durationInSeconds % 60);
    const milliseconds = Math.floor((durationInSeconds % 1) * 1000);

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`;
}

function parseDateTime(dateTimeStr: string): Date | null {
    try {
        return new Date(dateTimeStr);
    } catch {
        return null;
    }
}

function formatDateTime(date: Date): string {
    return date.toISOString().replace('T', ' ').replace('Z', '');
} 