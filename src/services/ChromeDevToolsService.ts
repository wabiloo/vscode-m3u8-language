import { exec, spawn } from 'child_process';
import CDP from 'chrome-remote-interface';
import * as fs from 'fs';
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

    private async selectTab(recursionCount: number = 0): Promise<ChromeTab | undefined> {
        try {
            // Prevent infinite recursion
            if (recursionCount > 2) {
                this.log('Reached maximum recursion depth when selecting tab. Aborting.');
                vscode.window.showErrorMessage('Failed to find or create a suitable browser tab for monitoring.');
                return undefined;
            }

            const tabs = await this.getChromeTabs();
            this.log(`Found ${tabs.length} browser tabs, filtering to find suitable ones...`);
            
            // Log all tabs for debugging
            tabs.forEach((tab, index) => {
                this.log(`Tab ${index + 1}: "${tab.title}" - ${tab.url}`);
            });

            // First, check if we have any "New Tab" pages that we can reuse
            // These are better than creating new tabs as they're already open
            const newTabPages = tabs.filter(tab => {
                if (!tab.webSocketDebuggerUrl) {
                    return false;
                }
                
                // Look for common "New Tab" page patterns
                return (tab.title === 'New Tab' || tab.title === 'New page' || tab.title === 'Start Page') &&
                       (tab.url === 'chrome://newtab/' || tab.url === 'edge://newtab/' || 
                        tab.url === 'about:blank' || tab.url.includes('chrome://startpage'));
            });
            
            if (newTabPages.length > 0) {
                // We found a "New Tab" page we can reuse
                const newTabPage = newTabPages[0];
                this.log(`Found a "New Tab" page to reuse: ${newTabPage.title} (${newTabPage.url})`);
                
                // Navigate it to our test URL
                try {
                    // Create a CDP connection to this tab
                    const tempClient = await CDP({ target: newTabPage.webSocketDebuggerUrl });
                    
                    // Get the demo URL from configuration
                    const config = vscode.workspace.getConfiguration('m3u8.chrome');
                    const defaultPlayerUrl = config.get<string>('defaultPlayerUrl', 'https://hlsjs.video-dev.org/demo/');
                    
                    // Navigate to the demo URL
                    this.log(`Navigating "New Tab" page to player URL: ${defaultPlayerUrl}...`);
                    await tempClient.Page.enable();
                    await tempClient.Page.navigate({ url: defaultPlayerUrl });
                    
                    // Wait for navigation to complete
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    
                    // Close the temporary connection
                    await tempClient.close();
                    
                    // Wait a bit more for the page to fully load
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    
                    // Try again with the updated tab
                    return this.selectTab(recursionCount + 1);
                } catch (error) {
                    this.log(`Error reusing "New Tab" page: ${error}`);
                    // Continue with normal tab selection
                }
            }

            // Normal tab filtering
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
                    'chrome-search:',
                    'edge:', 
                    'view-source:',
                    'data:', 
                    'file://'
                ];

                // Special case: if this is a tab we just created or navigated to example.com
                // This prevents the infinite loop of creating new tabs
                const config = vscode.workspace.getConfiguration('m3u8.chrome');
                const defaultPlayerUrl = config.get<string>('defaultPlayerUrl', 'https://hlsjs.video-dev.org/demo/');
                const playerUrlNoProtocol = defaultPlayerUrl.replace(/^https?:\/\//, '');
                
                if (tab.url === defaultPlayerUrl || 
                    tab.url.replace(/^https?:\/\//, '') === playerUrlNoProtocol ||
                    (recursionCount > 0 && tab.url === 'about:blank')) {
                    this.log('Found our player page, accepting it.');
                    return true;
                }

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

            this.log(`Found ${realTabs.length} suitable tabs after filtering`);

            if (realTabs.length === 0) {
                // No suitable tabs found, create a new one with a real URL
                this.log('No suitable tabs found, creating a new one...');
                
                try {
                    // Try to create a tab using CDP's Target.createTarget
                    // This is more reliable than spawning a new browser process
                    this.log('Creating a new tab using CDP...');
                    
                    // Get the demo URL from configuration
                    const config = vscode.workspace.getConfiguration('m3u8.chrome');
                    const defaultPlayerUrl = config.get<string>('defaultPlayerUrl', 'https://hlsjs.video-dev.org/demo/');
                    
                    // First, get any existing CDP client
                    const existingTabs = tabs.filter(tab => tab.webSocketDebuggerUrl);
                    if (existingTabs.length > 0) {
                        const tempClient = await CDP({ target: existingTabs[0].webSocketDebuggerUrl });
                        
                        // Create a new target (tab)
                        await tempClient.Target.createTarget({ url: defaultPlayerUrl });
                        
                        // Close the temporary connection
                        await tempClient.close();
                        
                        // Wait for the tab to be created and loaded
                        this.log('Waiting for the new tab to load...');
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        
                        // Try again with the new tab
                        return this.selectTab(recursionCount + 1);
                    } else {
                        // Fallback to spawning a new browser process
                        this.log('No existing tabs with debugging URL, falling back to spawning a new browser process...');
                        this.log(`Falling back to launching browser with URL: ${defaultPlayerUrl}`);
                        
                        spawn(this.getChromeCommand().command, [...this.getChromeCommand().args, defaultPlayerUrl], {
                            detached: true,
                            stdio: 'ignore'
                        }).unref();
                        
                        // Wait a bit longer to ensure the tab is fully loaded
                        this.log('Waiting for the new tab to load...');
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        
                        // Try again with incremented recursion counter
                        return this.selectTab(recursionCount + 1);
                    }
                } catch (error) {
                    this.log(`Error creating new tab: ${error}`);
                    
                    // Fallback to spawning a new browser process
                    const { command, args } = this.getChromeCommand();
                    
                    const config = vscode.workspace.getConfiguration('m3u8.chrome');
                    const defaultPlayerUrl = config.get<string>('defaultPlayerUrl', 'https://hlsjs.video-dev.org/demo/');
                    
                    this.log(`Falling back to launching browser with URL: ${defaultPlayerUrl}`);
                    
                    spawn(command, [...args, defaultPlayerUrl], {
                        detached: true,
                        stdio: 'ignore'
                    }).unref();
                    
                    // Wait a bit longer to ensure the tab is fully loaded
                    this.log('Waiting for the new tab to load...');
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    
                    // Try again with incremented recursion counter
                    return this.selectTab(recursionCount + 1);
                }
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

            if (selected) {
                this.log(`User selected tab: ${selected.tab.title} (${selected.tab.url})`);
            } else {
                this.log('User cancelled tab selection');
            }

            return selected?.tab;
        } catch (error) {
            this.log(`Error selecting tab: ${error}`);
            return undefined;
        }
    }

    private getChromeCommand(): { command: string, args: string[] } {
        // Get the configuration
        const config = vscode.workspace.getConfiguration('m3u8.chrome');
        const executablePath = config.get<string>('executablePath', '');
        const profileDirectory = config.get<string>('profileDirectory', '');
        
        // Base arguments
        const baseArgs = ['--remote-debugging-port=9222'];
        
        // Add profile directory if specified
        if (profileDirectory) {
            baseArgs.push(`--profile-directory=${profileDirectory}`);
            this.log(`Using Chrome profile directory: ${profileDirectory}`);
        }
        
        // If user specified a custom path and it exists, use it
        if (executablePath && fs.existsSync(executablePath)) {
            this.log(`Using custom Chrome path: ${executablePath}`);
            return {
                command: executablePath,
                args: baseArgs
            };
        }
        
        // Otherwise use default paths based on platform
        this.log(`No custom Chrome path specified or path doesn't exist, using default paths for platform: ${process.platform}`);
        
        switch (process.platform) {
            case 'win32':
                // Check for Chromium in common locations
                const winPaths = [
                    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                    'C:\\Program Files\\Chromium\\Application\\chrome.exe',
                    'C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe',
                    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
                    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
                ];
                
                for (const path of winPaths) {
                    if (fs.existsSync(path)) {
                        this.log(`Found browser at: ${path}`);
                        return {
                            command: path,
                            args: baseArgs
                        };
                    }
                }
                
                this.log(`No browser found in common locations, defaulting to: C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe`);
                return {
                    command: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                    args: baseArgs
                };
                
            case 'darwin':
                // Check for Chromium in common locations
                const macPaths = [
                    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                    '/Applications/Chromium.app/Contents/MacOS/Chromium',
                    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
                ];
                
                for (const path of macPaths) {
                    if (fs.existsSync(path)) {
                        this.log(`Found browser at: ${path}`);
                        return {
                            command: path,
                            args: baseArgs
                        };
                    }
                }
                
                this.log(`No browser found in common locations, defaulting to: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome`);
                return {
                    command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                    args: baseArgs
                };
                
            default:
                // For Linux, try to find the browser using 'which'
                try {
                    const browsers = ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge'];
                    for (const browser of browsers) {
                        try {
                            const { stdout } = require('child_process').execSync(`which ${browser}`, { encoding: 'utf8' });
                            if (stdout && stdout.trim()) {
                                const browserPath = stdout.trim();
                                this.log(`Found browser at: ${browserPath}`);
                                return {
                                    command: browserPath,
                                    args: baseArgs
                                };
                            }
                        } catch (e) {
                            // Continue to next browser
                        }
                    }
                } catch (e) {
                    this.log(`Error finding browser on Linux: ${e}`);
                }
                
                this.log(`No browser found in PATH, defaulting to: google-chrome`);
                return {
                    command: 'google-chrome',
                    args: baseArgs
                };
        }
    }

    private async isChromeDebuggingEnabled(): Promise<boolean> {
        this.log('Checking if browser debugging is enabled...');
        return new Promise((resolve) => {
            http.get('http://localhost:9222/json', (res) => {
                const isEnabled = res.statusCode === 200;
                this.log(`Browser debugging check result: ${isEnabled ? 'enabled' : 'disabled'} (status: ${res.statusCode})`);
                resolve(isEnabled);
            }).on('error', (err) => {
                this.log(`Browser debugging check error: ${err.message}`);
                resolve(false);
            });
        });
    }

    private async waitForChromeToBeReady(maxAttempts: number = 10, delayMs: number = 500): Promise<boolean> {
        this.log(`Waiting for browser to be ready (max ${maxAttempts} attempts, ${delayMs}ms delay)...`);
        for (let i = 0; i < maxAttempts; i++) {
            this.log(`Attempt ${i + 1}/${maxAttempts} to check if browser is ready...`);
            const isReady = await this.isChromeDebuggingEnabled();
            if (isReady) {
                this.log('Browser is ready!');
                return true;
            }
            this.log(`Browser not ready yet, waiting ${delayMs}ms before next attempt...`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        this.log('Browser failed to become ready within the timeout period');
        return false;
    }

    private async validateChromePath(): Promise<boolean> {
        const config = vscode.workspace.getConfiguration('m3u8.chrome');
        const executablePath = config.get<string>('executablePath', '');
        
        if (!executablePath) {
            return true; // No custom path specified, so no validation needed
        }
        
        if (!fs.existsSync(executablePath)) {
            const message = `Browser executable not found at specified path: ${executablePath}`;
            this.log(message);
            vscode.window.showErrorMessage(message);
            return false;
        }
        
        return true;
    }

    private async killExistingChrome(): Promise<void> {
        return new Promise((resolve) => {
            let cmd = '';
            
            if (process.platform === 'win32') {
                cmd = 'taskkill /F /IM chrome.exe & taskkill /F /IM chromium.exe & taskkill /F /IM msedge.exe';
                this.log(`Attempting to kill existing browser instances with command: ${cmd}`);
            } else if (process.platform === 'darwin') {
                cmd = 'pkill -9 "Google Chrome" & pkill -9 "Chromium" & pkill -9 "Microsoft Edge"';
                this.log(`Attempting to kill existing browser instances with command: ${cmd}`);
            } else {
                // Linux
                cmd = 'pkill -9 chrome & pkill -9 chromium & pkill -9 chromium-browser & pkill -9 microsoft-edge';
                this.log(`Attempting to kill existing browser instances with command: ${cmd}`);
            }
            
            exec(cmd, (error, stdout, stderr) => {
                if (error) {
                    // On macOS, if no Chrome process exists, pkill returns an error
                    // This is not a real error for us, so just log it
                    this.log(`Note: Kill browser returned: ${error.message}`);
                }
                if (stdout) {
                    this.log(`Kill browser stdout: ${stdout}`);
                }
                if (stderr) {
                    this.log(`Kill browser stderr: ${stderr}`);
                }
                this.log('Waiting 1s for browser to fully terminate...');
                setTimeout(resolve, 1000);
            });
        });
    }

    async connect(): Promise<void> {
        this.log('Attempting to connect to browser...');
        
        // Validate Chrome path before proceeding
        const isValidPath = await this.validateChromePath();
        if (!isValidPath) {
            throw new Error("Invalid browser executable path specified in settings");
        }
        
        const debuggingEnabled = await this.isChromeDebuggingEnabled();
        if (!debuggingEnabled) {
            this.log('Browser debugging not enabled, checking if we need to restart...');
            
            // Get the configuration to check profile
            const config = vscode.workspace.getConfiguration('m3u8.chrome');
            const profileDirectory = config.get<string>('profileDirectory', '');
            
            // If a specific profile is configured, inform the user they need to start that profile with debugging
            if (profileDirectory) {
                const message = `No browser with debugging enabled found for profile "${profileDirectory}". Would you like to start one?`;
                const selection = await vscode.window.showInformationMessage(
                    message,
                    "Start Browser", "Cancel"
                );
                
                if (selection === "Start Browser") {
                    await this.startBrowserWithDebugging(false); // Start without killing existing browsers
                } else {
                    throw new Error(`No browser with debugging enabled found for profile "${profileDirectory}". Please start Chrome with the --remote-debugging-port=9222 flag and the --profile-directory="${profileDirectory}" flag.`);
                }
            } else {
                // No specific profile, ask if user wants to restart
                await this.restartChromeWithDebugging();
            }
        }

        try {
            this.log('Selecting tab to monitor...');
            const tab = await this.selectTab();
            if (!tab) {
                this.log('No tab was selected or could be created. Please open a browser tab with content and try again.');
                throw new Error('No tab selected or could be created');
            }

            // Check if we're already monitoring this tab
            if (this.sessions.has(tab.id)) {
                this.log(`Already monitoring tab: ${tab.title} (${tab.url})`);
                throw new Error(`Already monitoring tab: ${tab.title}`);
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
            const errMsg = `Error connecting to browser: ${error}`;
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

    // Add a new method to start browser without killing existing ones
    async startBrowserWithDebugging(killExisting: boolean = true): Promise<void> {
        this.log(`Attempting to start browser with debugging (killExisting=${killExisting})...`);
        
        // Validate Chrome path before proceeding
        const isValidPath = await this.validateChromePath();
        if (!isValidPath) {
            throw new Error("Invalid browser executable path specified in settings");
        }
        
        return new Promise(async (resolve, reject) => {
            try {
                if (killExisting) {
                    this.log('Killing existing browser instances...');
                    await this.killExistingChrome();
                } else {
                    this.log('Preserving existing browser instances...');
                }

                const { command, args } = this.getChromeCommand();
                this.log(`Starting browser with command: ${command} ${args.join(' ')}`);
                
                // Start browser as a detached process
                const browserProcess = spawn(command, args, {
                    detached: true,
                    stdio: 'ignore'
                });

                // Unref the process so it can run independently
                browserProcess.unref();

                this.log('Browser process started, waiting for debugging to be ready...');
                const isReady = await this.waitForChromeToBeReady();
                if (isReady) {
                    this.log('Browser successfully started with debugging enabled');
                    vscode.window.showInformationMessage("Browser started with debugging enabled.");
                    resolve();
                } else {
                    const error = new Error("Browser did not start with debugging enabled in time");
                    this.log(error.message);
                    vscode.window.showErrorMessage(error.message);
                    reject(error);
                }
            } catch (error) {
                const errMsg = `Error during browser start: ${error}`;
                this.log(errMsg);
                vscode.window.showErrorMessage(errMsg);
                reject(error);
            }
        });
    }

    async restartChromeWithDebugging(): Promise<void> {
        this.log('Attempting to restart browser with debugging...');
        
        // Validate Chrome path before proceeding
        const isValidPath = await this.validateChromePath();
        if (!isValidPath) {
            throw new Error("Invalid browser executable path specified in settings");
        }
        
        const selection = await vscode.window.showInformationMessage(
            "Browser debugging is not enabled. Restart browser with debugging?",
            "Restart Browser", "Start New Instance", "Cancel"
        );
        
        if (selection === "Restart Browser") {
            return this.startBrowserWithDebugging(true); // Kill existing and start new
        } else if (selection === "Start New Instance") {
            return this.startBrowserWithDebugging(false); // Start new without killing existing
        }
        
        this.log('User cancelled browser restart');
        throw new Error("User cancelled browser restart");
    }
} 