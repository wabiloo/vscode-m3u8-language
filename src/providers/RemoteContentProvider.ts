import * as vscode from 'vscode';
import { RemoteDocumentContent } from '../types';

export class M3U8RemoteContentProvider implements vscode.TextDocumentContentProvider {
    constructor(private remoteDocumentContentMap: Map<string, RemoteDocumentContent>) {}

    provideTextDocumentContent(uri: vscode.Uri): string {
        const docContent = this.remoteDocumentContentMap.get(uri.toString());
        if (!docContent) {
            return '';
        }
        return docContent.content;
    }
} 