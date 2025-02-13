import { URL } from 'url';
import * as vscode from 'vscode';
import { ColorScheme, Configuration, DefaultColors } from '../types';

export function parseTagColor(tagColor: string): { tag: string, scheme: ColorScheme } | undefined {
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

export function getConfiguration(): Configuration {
    const config = vscode.workspace.getConfiguration('m3u8.features');
    const tagColors = new Map<string, ColorScheme>();
    
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

export function isValidUrl(str: string): boolean {
    try {
        new URL(str);
        return true;
    } catch {
        return false;
    }
}

export function resolveUri(baseUri: string, relativeUri: string): string {
    try {
        return new URL(relativeUri, baseUri).toString();
    } catch {
        return relativeUri;
    }
}

export function formatDuration(durationInSeconds: number): string {
    const hours = Math.floor(durationInSeconds / 3600);
    const minutes = Math.floor((durationInSeconds % 3600) / 60);
    const seconds = Math.floor(durationInSeconds % 60);
    const milliseconds = Math.floor((durationInSeconds % 1) * 1000);

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`;
}

export function parseDateTime(dateTimeStr: string): Date | null {
    try {
        return new Date(dateTimeStr);
    } catch {
        return null;
    }
}

export function formatDateTime(date: Date): string {
    return date.toISOString().replace('T', ' ').replace('Z', '');
}

export function extractTag(line: string): string | null {
    const match = line.match(/^#((?:EXT-)?(?:X-)?[A-Z0-9-]+)(?::|$)/);
    return match ? match[1] : null;
} 