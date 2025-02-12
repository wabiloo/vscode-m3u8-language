
export interface ColorScheme {
    backgroundColor: string;
    borderColor: string;
}

export interface DefaultColors {
    odd: ColorScheme;
    even: ColorScheme;
}

export interface HLSTagInfo {
    section: string;
    url: string;
    summary: string;
    context: 'header' | 'segment' | 'multivariant' | 'footer';
    icon?: string;
}

export interface RemotePlaylistInfo {
    uri: string;
    autoRefreshEnabled: boolean;
    refreshInterval: NodeJS.Timeout | undefined;
}

export interface RemoteDocumentContent {
    content: string;
    uri: string;
}

export interface Configuration {
    colorBanding: boolean;
    segmentNumbering: boolean;
    showRunningDuration: boolean;
    showProgramDateTime: boolean;
    folding: boolean;
    gutterIcons: boolean;
    tagColors: Map<string, ColorScheme>;
    defaultColors: DefaultColors;
} 