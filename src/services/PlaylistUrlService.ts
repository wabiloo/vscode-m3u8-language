import { URL } from 'url';

export interface PlaylistContext {
    baseUri: string;          // The base URI for resolving relative URLs
    content: string;          // The playlist content
    initSegmentUri?: string;  // Optional init segment URI (for segments)
}

export interface SegmentInfo {
    uri: string;              // The resolved segment URI
    initSegmentUri?: string;  // The resolved init segment URI if any
    baseUri: string;          // The original base URI (useful for resolving other URLs)
}

export class PlaylistUrlService {
    // Map to store base URLs for documents
    private documentBaseUrls = new Map<string, string>();

    constructor(private log: (message: string) => void) {}

    /**
     * Sets the base URL for a document
     */
    setDocumentBaseUrl(documentUri: string, baseUrl: string) {
        this.documentBaseUrls.set(documentUri, baseUrl);
    }

    /**
     * Gets the base URL for a document
     */
    getDocumentBaseUrl(documentUri: string): string | undefined {
        return this.documentBaseUrls.get(documentUri);
    }

    /**
     * Removes the base URL for a document
     */
    removeDocumentBaseUrl(documentUri: string) {
        this.documentBaseUrls.delete(documentUri);
    }

    /**
     * Checks if a string is a valid URL
     */
    isValidUrl(str: string): boolean {
        try {
            new URL(str);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Resolves a relative URL against a base URL
     */
    resolveUrl(relativeUrl: string, baseUrl: string): string {
        try {
            // If the URL is already absolute, return it
            if (this.isValidUrl(relativeUrl)) {
                return relativeUrl;
            }

            // Create base URL object
            const base = new URL(baseUrl);
            
            // If the relative URL starts with '/', resolve against the origin
            if (relativeUrl.startsWith('/')) {
                return new URL(relativeUrl, base.origin).toString();
            }
            
            // Otherwise resolve against the full base URL
            return new URL(relativeUrl, baseUrl).toString();
        } catch (error) {
            this.log(`Failed to resolve URL ${relativeUrl} against base ${baseUrl}: ${error}`);
            return relativeUrl;
        }
    }

    /**
     * Extracts init segment URI from playlist content if present
     */
    extractInitSegmentUri(content: string, baseUri: string): string | undefined {
        const match = content.match(/#EXT-X-MAP:URI="([^"]+)"/);
        if (match) {
            const initSegmentUri = match[1];
            return this.resolveUrl(initSegmentUri, baseUri);
        }
        return undefined;
    }

    /**
     * Creates a playlist context for a segment, including init segment if present
     */
    createSegmentContext(segmentUri: string, baseUri: string, initSegmentUri?: string): SegmentInfo {
        const resolvedUri = this.resolveUrl(segmentUri, baseUri);
        const resolvedInitUri = initSegmentUri ? this.resolveUrl(initSegmentUri, baseUri) : undefined;

        return {
            uri: resolvedUri,
            initSegmentUri: resolvedInitUri,
            baseUri
        };
    }

    /**
     * Creates a playlist context from a URL and content
     */
    createPlaylistContext(content: string, baseUri: string): PlaylistContext {
        const initSegmentUri = this.extractInitSegmentUri(content, baseUri);
        
        return {
            baseUri,
            content,
            initSegmentUri
        };
    }

    /**
     * Checks if a playlist is a multi-variant playlist
     */
    isMultiVariantPlaylist(content: string): boolean {
        return content.includes('#EXT-X-STREAM-INF:') || content.includes('#EXT-X-MEDIA:');
    }
} 