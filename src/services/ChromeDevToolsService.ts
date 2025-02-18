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
    }>();
    readonly onDidUpdateResponses = this._onDidUpdateResponses.event;
    private responseCache = new Map<string, { 
        url: string; 
        body: string;
        timestamp: number;
        size: number;
    }>();
    private responseCounter = 0;
    private client: CDP.Client | undefined;

    constructor(private log: (message: string) => void) {}

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
            const realTabs = tabs.filter(tab => 
                !tab.url.startsWith('chrome:') && 
                !tab.url.startsWith('devtools:') &&
                !tab.url.startsWith('chrome-extension:') &&
                !tab.url.startsWith('blob:') &&
                tab.webSocketDebuggerUrl // Only tabs that can be debugged
            );

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
        if (this.client) {
            this.client.close();
            this.client = undefined;
        }
        this.responseCache.clear();
        this.responseCounter = 0;
    }

    async connect(): Promise<void> {
        this.log('Attempting to connect to Chrome...');
        
        // Clean up existing connection and cache
        this.cleanup();

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
            this.log(`Selected tab: ${tab.title} (${tab.url})`);

            this.log('Establishing CDP connection...');
            this.client = await CDP({ target: tab.webSocketDebuggerUrl });
            this.log('CDP connection established');

            this.log('Enabling Network domain...');
            await this.client.Network.enable();
            this.log('Network domain enabled');

            // Notify webview about the selected tab
            this._onDidUpdateResponses.fire({
                id: 'tab-info',
                url: tab.url,
                timestamp: Date.now(),
                size: 0,
                title: tab.title
            });

            this.log('Setting up Network.responseReceived handler...');
            this.client.Network.responseReceived(async (params: CDPResponseReceivedParams) => {
                const contentType = params.response.headers['content-type'] || '';
                const contentEncoding = params.response.headers['content-encoding'] || '';
                this.log(`Received response: ${params.response.url} (content-type: ${contentType}, encoding: ${contentEncoding})`);
                
                if (contentType.includes('application/vnd.apple.mpegurl') || 
                    contentType.includes('application/x-mpegurl') ||
                    params.response.url.endsWith('.m3u8')) {
                    try {
                        this.log(`Found M3U8 response: ${params.response.url}`);
                        const response = await this.client!.Network.getResponseBody({ requestId: params.requestId });
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

                        const id = `response-${this.responseCounter++}`;
                        this.responseCache.set(id, { 
                            url: params.response.url, 
                            body,
                            timestamp,
                            size
                        });
                        this._onDidUpdateResponses.fire({ 
                            id, 
                            url: params.response.url,
                            timestamp,
                            size
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

    async refreshPage(): Promise<void> {
        if (!this.client) {
            throw new Error('Not connected to Chrome');
        }
        try {
            this.log('Refreshing page...');
            await this.client.Page.enable();
            await this.client.Page.reload();
            this.log('Page refreshed');
        } catch (error) {
            const errMsg = `Error refreshing page: ${error}`;
            this.log(errMsg);
            throw error;
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
        if (this.client) {
            this.client.close();
        }
        this.responseCache.clear();
    }
} 