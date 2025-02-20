import { exec, spawn } from 'child_process';
import CDP from 'chrome-remote-interface';
import * as http from 'http';
import { promisify } from 'util';
import * as vscode from 'vscode';
import * as zlib from 'zlib';

// Add promisified zlib functions
const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const inflateRaw = promisify(zlib.inflateRaw);

// Add type declarations for CDP parameters
interface CDPResponseReceivedParams {
    requestId: string;
    response: {
        url: string;
        headers: { [key: string]: string };
        mimeType: string;
        encodedDataLength: number;
        fromDiskCache?: boolean;
        fromCache?: boolean;
        status: number;
        statusText: string;
    };
}

interface ChromeTab {
    id: string;
    title: string;
    url: string;
    webSocketDebuggerUrl?: string;
}

export class ChromeDevToolsService {
    private _onDidUpdateResponses = new vscode.EventEmitter<{ 
        id: string; 
        url: string;
        timestamp: number;
        size: number;
        title?: string;
        body?: string;
        isValidM3U8?: boolean;
        isMultiVariant?: boolean;
        mediaSequence?: number;
        discontinuitySequence?: number;
        fromCache?: boolean;
        status?: number;
        statusText?: string;
        tabId?: string;
        tabColor?: string;
        tabLabel?: string;
    }>();
    readonly onDidUpdateResponses = this._onDidUpdateResponses.event;
    private responseCache = new Map<string, { 
        url: string; 
        body: string;
        timestamp: number;
        size: number;
        isValidM3U8: boolean;
        isMultiVariant: boolean;
        mediaSequence?: number;
        discontinuitySequence?: number;
        tabId?: string;
    }>();
    private responseCounter = 0;
    private isPaused: boolean = false;

    // Track multiple CDP sessions
    private sessions = new Map<string, {
        client: CDP.Client;
        tab: ChromeTab;
        color: string;
        label?: string;
    }>();

    // Available colors for tabs
    private readonly colors = [
        '#4CAF50', // Green
        '#2196F3', // Blue
        '#FFC107', // Amber
        '#E91E63', // Pink
        '#9C27B0', // Purple
        '#FF5722', // Deep Orange
        '#00BCD4', // Cyan
        '#795548', // Brown
    ];

    constructor(private log: (message: string) => void) {}

    private getNextColor(): string {
        const usedColors = new Set(Array.from(this.sessions.values()).map(s => s.color));
        return this.colors.find(c => !usedColors.has(c)) || this.colors[0];
    }

    togglePause(): boolean {
        this.isPaused = !this.isPaused;
        this.log(`Monitoring ${this.isPaused ? 'paused' : 'resumed'}`);
        // Notify UI of pause state change
        this._onDidUpdateResponses.fire({
            id: 'pause-state',
            url: '',
            timestamp: Date.now(),
            size: 0,
            title: this.isPaused ? 'paused' : 'resumed'
        });
        return this.isPaused;
    }

    private async getChromeTabs(): Promise<ChromeTab[]> {
        return new Promise((resolve, reject) => {
            http.get('http://localhost:9222/json', (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const tabs = JSON.parse(data);
                        resolve(tabs);
                    } catch (err) {
                        reject(err);
                    }
                });
            }).on('error', reject);
        });
    }

    private async selectTab(): Promise<ChromeTab | undefined> {
        try {
            const tabs = await this.getChromeTabs();
            const realTabs = tabs.filter(tab => {
                // Must have a debugging URL
                if (!tab.webSocketDebuggerUrl) {
                    return false;
                }

                // Filter out various special Chrome pages and UI elements
                const excludePatterns = [
                    'chrome:', 
                    'devtools:', 
                    'chrome-extension:',
                    'blob:',
                    'about:blank',
                    'chrome-search:',
                    'edge:', 
                    'view-source:',
                    'data:', 
                    'file://'
                ];

                // Filter out common advertising, analytics, and widget domains
                const excludeDomains = [
                    'imasdk.googleapis.com',
                    'doubleclick.net',
                    'js.driftt.com',
                    'googletagmanager.com',
                    'google-analytics.com',
                    'facebook.com',
                    'fb.com',
                    'hotjar.com',
                    'intercom.io',
                    'crisp.chat',
                    'tawk.to',
                    'zendesk.com',
                    'livechatinc.com',
                    'ads.google.com',
                    'adservice.google.',
                    'analytics.',
                    'tracking.',
                    'pixel.',
                    'cdn.',
                    'widget.'
                ];

                // Check if URL starts with any excluded pattern
                if (excludePatterns.some(pattern => tab.url.startsWith(pattern))) {
                    return false;
                }

                // Check if URL contains any excluded domain
                try {
                    const url = new URL(tab.url);
                    if (excludeDomains.some(domain => url.hostname.includes(domain))) {
                        return false;
                    }
                } catch (e) {
                    // If URL parsing fails, skip this tab
                    return false;
                }

                // Filter out empty or invalid titles
                if (!tab.title || tab.title === 'about:blank') {
                    return false;
                }

                // Filter out common service worker and extension pages
                const excludeTitlePatterns = [
                    'Service Worker',
                    'Extension:',
                    'Extensions',
                    'Chrome Extensions',
                    'Developer Tools',
                    'Google Tag Manager',
                    'Google Analytics',
                    'Advertisement',
                    'Chat Widget',
                    'LiveChat',
                    'Tracking Pixel'
                ];

                if (excludeTitlePatterns.some(pattern => tab.title.includes(pattern))) {
                    return false;
                }

                return true;
            });

            if (realTabs.length === 0) {
                // No suitable tabs found, create a new one
                this.log('No suitable tabs found, creating a new one...');
                const { command, args } = this.getChromeCommand();
                spawn(command, [...args, 'about:blank'], {
                    detached: true,
                    stdio: 'ignore'
                }).unref();
                
                // Wait a bit and try again
                await new Promise(resolve => setTimeout(resolve, 1000));
                return this.selectTab();
            }

            if (realTabs.length === 1) {
                this.log(`Auto-selecting only available tab: ${realTabs[0].title} (${realTabs[0].url})`);
                return realTabs[0];
            }

            // Let user pick a tab
            const items = realTabs.map(tab => ({
                label: tab.title,
                detail: tab.url,
                tab
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a tab to monitor',
                matchOnDetail: true
            });

            return selected?.tab;
        } catch (error) {
            this.log(`Error selecting tab: ${error}`);
            return undefined;
        }
    }

    private getChromeCommand(): { command: string, args: string[] } {
        switch (process.platform) {
            case 'win32':
                return {
                    command: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                    args: ['--remote-debugging-port=9222']
                };
            case 'darwin':
                return {
                    command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                    args: ['--remote-debugging-port=9222']
                };
            default:
                return {
                    command: 'google-chrome',
                    args: ['--remote-debugging-port=9222']
                };
        }
    }

    private async isChromeDebuggingEnabled(): Promise<boolean> {
        this.log('Checking if Chrome debugging is enabled...');
        return new Promise((resolve) => {
            http.get('http://localhost:9222/json', (res) => {
                const isEnabled = res.statusCode === 200;
                this.log(`Chrome debugging check result: ${isEnabled ? 'enabled' : 'disabled'} (status: ${res.statusCode})`);
                resolve(isEnabled);
            }).on('error', (err) => {
                this.log(`Chrome debugging check error: ${err.message}`);
                resolve(false);
            });
        });
    }

    private async waitForChromeToBeReady(maxAttempts: number = 10, delayMs: number = 500): Promise<boolean> {
        this.log(`Waiting for Chrome to be ready (max ${maxAttempts} attempts, ${delayMs}ms delay)...`);
        for (let i = 0; i < maxAttempts; i++) {
            this.log(`Attempt ${i + 1}/${maxAttempts} to check if Chrome is ready...`);
            const isReady = await this.isChromeDebuggingEnabled();
            if (isReady) {
                this.log('Chrome is ready!');
                return true;
            }
            this.log(`Chrome not ready yet, waiting ${delayMs}ms before next attempt...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        this.log('Chrome failed to become ready within the timeout period');
        return false;
    }

    private async killExistingChrome(): Promise<void> {
        return new Promise((resolve) => {
            const cmd = process.platform === 'win32' ? 
                'taskkill /F /IM chrome.exe' : 
                'pkill -9 "Google Chrome"';
            
            this.log(`Attempting to kill existing Chrome instances with command: ${cmd}`);
            exec(cmd, (error, stdout, stderr) => {
                if (error) {
                    // On macOS, if no Chrome process exists, pkill returns an error
                    // This is not a real error for us, so just log it
                    this.log(`Note: Kill Chrome returned: ${error.message}`);
                }
                if (stdout) {
                    this.log(`Kill Chrome stdout: ${stdout}`);
                }
                if (stderr) {
                    this.log(`Kill Chrome stderr: ${stderr}`);
                }
                this.log('Waiting 1s for Chrome to fully terminate...');
                setTimeout(resolve, 1000);
            });
        });
    }

    async restartChromeWithDebugging(): Promise<void> {
        this.log('Attempting to restart Chrome with debugging...');
        const selection = await vscode.window.showInformationMessage(
            "Chrome debugging is not enabled. Restart Chrome with debugging?",
            "Restart Chrome", "Cancel"
        );
        if (selection === "Restart Chrome") {
            return new Promise(async (resolve, reject) => {
                try {
                    this.log('User confirmed Chrome restart');
                    await this.killExistingChrome();

                    const { command, args } = this.getChromeCommand();
                    this.log(`Starting Chrome with command: ${command} ${args.join(' ')}`);
                    
                    // Start Chrome as a detached process
                    const chromeProcess = spawn(command, args, {
                        detached: true,
                        stdio: 'ignore'
                    });

                    // Unref the process so it can run independently
                    chromeProcess.unref();

                    this.log('Chrome process started, waiting for debugging to be ready...');
                    const isReady = await this.waitForChromeToBeReady();
                    if (isReady) {
                        this.log('Chrome successfully started with debugging enabled');
                        vscode.window.showInformationMessage("Chrome restarted with debugging enabled.");
                        resolve();
                    } else {
                        const error = new Error("Chrome did not start with debugging enabled in time");
                        this.log(error.message);
                        vscode.window.showErrorMessage(error.message);
                        reject(error);
                    }
                } catch (error) {
                    const errMsg = `Error during Chrome restart: ${error}`;
                    this.log(errMsg);
                    vscode.window.showErrorMessage(errMsg);
                    reject(error);
                }
            });
        }
        this.log('User cancelled Chrome restart');
        throw new Error("User cancelled Chrome restart");
    }

    private cleanup() {
        // Remove this method as it's no longer needed
    }

    async connect(): Promise<void> {
        this.log('Attempting to connect to Chrome...');
        
        const debuggingEnabled = await this.isChromeDebuggingEnabled();
        if (!debuggingEnabled) {
            this.log('Chrome debugging not enabled, attempting restart...');
            await this.restartChromeWithDebugging();
        }

        try {
            this.log('Selecting tab to monitor...');
            const tab = await this.selectTab();
            if (!tab) {
                throw new Error('No tab selected');
            }

            // Check if we're already monitoring this tab
            if (this.sessions.has(tab.id)) {
                throw new Error('Already monitoring this tab');
            }

            this.log(`Selected tab: ${tab.title} (${tab.url})`);

            this.log('Establishing CDP connection...');
            const client = await CDP({ target: tab.webSocketDebuggerUrl });
            this.log('CDP connection established');

            this.log('Enabling Network domain...');
            await client.Network.enable();
            await client.Page.enable();  // Enable Page domain for refresh
            this.log('Network domain enabled');

            // Add the new session
            const color = this.getNextColor();
            const label = tab.title || this.getBasename(tab.url);
            this.sessions.set(tab.id, {
                client,
                tab,
                color,
                label
            });

            // Notify webview about the new tab
            this._onDidUpdateResponses.fire({
                id: 'tab-info',
                url: tab.url,
                timestamp: Date.now(),
                size: 0,
                title: tab.title,
                tabId: tab.id,
                tabColor: color,
                tabLabel: label
            });

            this.log('Setting up Network.responseReceived handler...');
            client.Network.responseReceived(async (params: CDPResponseReceivedParams) => {
                if (this.isPaused) {
                    return; // Skip processing if paused
                }
                const contentType = params.response.headers['content-type'] || '';
                const contentEncoding = params.response.headers['content-encoding'] || '';
                
                if (contentType.toLowerCase().includes('mpegurl') || 
                    (params.response.url && new URL(params.response.url).pathname.includes('.m3u8'))) {
                    try {
                        this.log(`Found M3U8 response: ${params.response.url}`);
                        const response = await client.Network.getResponseBody({ requestId: params.requestId });
                        let body = response.body;

                        // Get the response size (encoded length from CDP)
                        const size = params.response.encodedDataLength;
                        const timestamp = Date.now();

                        // If the response is base64 encoded (binary data)
                        if (response.base64Encoded) {
                            const buffer = Buffer.from(body, 'base64');
                            
                            // Handle different compression methods
                            try {
                                if (contentEncoding.includes('gzip')) {
                                    this.log('Decompressing gzip response...');
                                    body = (await gunzip(buffer)).toString();
                                } else if (contentEncoding.includes('deflate')) {
                                    this.log('Decompressing deflate response...');
                                    try {
                                        body = (await inflate(buffer)).toString();
                                    } catch {
                                        // Some servers send raw deflate data
                                        body = (await inflateRaw(buffer)).toString();
                                    }
                                } else {
                                    // Just convert binary to string if no compression
                                    body = buffer.toString();
                                }
                            } catch (decompressError) {
                                this.log(`Error decompressing response: ${decompressError}`);
                                // Fall back to raw buffer as string
                                body = buffer.toString();
                            }
                        }

                        // Check if the response is a valid M3U8 file
                        const isValidM3U8 = body.trimStart().startsWith('#EXTM3U');
                        // Check if it's a multi-variant playlist
                        const isMultiVariant = body.includes('#EXT-X-STREAM-INF:');
                        
                        // Extract media sequence if present
                        let mediaSequence: number | undefined;
                        const mediaSeqMatch = body.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
                        if (mediaSeqMatch) {
                            mediaSequence = parseInt(mediaSeqMatch[1], 10);
                        }

                        // Extract discontinuity sequence if present
                        let discontinuitySequence: number | undefined;
                        const discSeqMatch = body.match(/#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)/);
                        if (discSeqMatch) {
                            discontinuitySequence = parseInt(discSeqMatch[1], 10);
                        }

                        this.log(`Response validation for ${params.response.url}: isValidM3U8=${isValidM3U8}, isMultiVariant=${isMultiVariant}, mediaSequence=${mediaSequence}, discontinuitySequence=${discontinuitySequence}, first few chars: ${body.trimStart().substring(0, 20)}`);

                        const id = `response-${this.responseCounter++}`;
                        this.responseCache.set(id, { 
                            url: params.response.url, 
                            body,
                            timestamp,
                            size,
                            isValidM3U8,
                            isMultiVariant,
                            mediaSequence,
                            discontinuitySequence,
                            tabId: tab.id
                        });
                        this._onDidUpdateResponses.fire({ 
                            id, 
                            url: params.response.url,
                            timestamp,
                            size,
                            body,
                            isValidM3U8,
                            isMultiVariant,
                            mediaSequence,
                            discontinuitySequence,
                            fromCache: params.response.fromDiskCache || params.response.fromCache,
                            status: params.response.status,
                            statusText: params.response.statusText,
                            tabId: tab.id,
                            tabColor: color,
                            tabLabel: this.sessions.get(tab.id)?.label
                        });
                        this.log(`Cached M3U8 response with id ${id} (${size} bytes)`);
                    } catch (err) {
                        this.log(`Error retrieving response body: ${err}`);
                    }
                }
            });
            this.log('Network response handler setup complete');
        } catch (error) {
            const errMsg = `Error connecting to Chrome: ${error}`;
            this.log(errMsg);
            vscode.window.showErrorMessage(errMsg);
            throw error;
        }
    }

    private getBasename(url: string): string {
        try {
            const urlObj = new URL(url);
            const pathname = urlObj.pathname;
            return pathname.split('/').pop() || urlObj.hostname;
        } catch {
            return url.split('/').pop() || url;
        }
    }

    async refreshPage(tabId: string): Promise<void> {
        const session = this.sessions.get(tabId);
        if (!session) {
            throw new Error('Tab not found');
        }
        try {
            this.log(`Refreshing page for tab ${tabId}...`);
            await session.client.Page.enable();
            await session.client.Page.reload();
            this.log('Page refreshed');
        } catch (error) {
            const errMsg = `Error refreshing page: ${error}`;
            this.log(errMsg);
            throw error;
        }
    }

    async setTabLabel(tabId: string, label: string): Promise<void> {
        const session = this.sessions.get(tabId);
        if (!session) {
            throw new Error('Tab not found');
        }
        session.label = label;
        // Notify UI of label change
        this._onDidUpdateResponses.fire({
            id: 'tab-label-update',
            url: session.tab.url,
            timestamp: Date.now(),
            size: 0,
            tabId,
            tabColor: session.color,
            tabLabel: label
        });
    }

    async disconnectTab(tabId: string): Promise<void> {
        const session = this.sessions.get(tabId);
        if (!session) {
            throw new Error('Tab not found');
        }
        try {
            await session.client.close();
            this.sessions.delete(tabId);
            // Notify UI of tab removal
            this._onDidUpdateResponses.fire({
                id: 'tab-removed',
                url: session.tab.url,
                timestamp: Date.now(),
                size: 0,
                tabId
            });
        } catch (error) {
            this.log(`Error disconnecting tab ${tabId}: ${error}`);
            throw error;
        }
    }

    async disconnectAllTabs(): Promise<void> {
        // Get all tab IDs first to avoid modifying the map while iterating
        const tabIds = Array.from(this.sessions.keys());
        for (const tabId of tabIds) {
            try {
                await this.disconnectTab(tabId);
            } catch (error) {
                this.log(`Error disconnecting tab ${tabId}: ${error}`);
                // Continue with other tabs even if one fails
            }
        }
    }

    getResponse(id: string): { url: string; body: string; timestamp: number } | undefined {
        const cached = this.responseCache.get(id);
        if (!cached) { return undefined; }
        return {
            url: cached.url,
            body: cached.body,
            timestamp: cached.timestamp
        };
    }

    dispose() {
        this._onDidUpdateResponses.dispose();
        // Close all CDP sessions
        for (const [_, session] of this.sessions) {
            session.client.close();
        }
        this.sessions.clear();
        this.responseCache.clear();
    }
} 