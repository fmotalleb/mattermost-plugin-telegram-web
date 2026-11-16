import {getStore} from './store';
import type {MMFileInfo, MMPost} from './types';

/** Reuse Mattermost's PDF.js viewer when the host publishes it for plugins. */
export function openHostPDFPreview(file: MMFileInfo, post: MMPost | undefined, onExited: () => void): boolean {
    const modals = (window as any).WebappUtils?.modals;
    const store = getStore();
    try {
        if (!store || typeof modals?.canOpenModalId !== 'function' ||
            typeof modals?.openModalById !== 'function' || !modals.canOpenModalId('file_preview_modal')) return false;
        const action = modals.openModalById('file_preview_modal', {
            fileInfos: [{...file, extension: 'pdf'}],
            post,
            startIndex: 0,
            onExited,
        });
        if (!action) return false;
        store.dispatch(action);
        return true;
    } catch (err) {
        // Older hosts can expose only part of the published modal API.
        return false;
    }
}

export function canEmbedNativePDF(): boolean {
    // Electron may advertise PDF support even when the desktop navigation policy blocks
    // Chromium's internal PDF subframe (Mattermost Desktop issue #3952).
    return !(window as any).desktopAPI && !/Electron|Mattermost/i.test(navigator.userAgent) && navigator.pdfViewerEnabled !== false;
}

/** Markup and source files are displayed literally, never executed. */
export function filePreviewKind(file: MMFileInfo): 'pdf' | 'text' | null {
    const mime = (file.mime_type || '').split(';')[0].trim().toLowerCase();
    const name = (file.name || '').toLowerCase();
    if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
    if (mime.startsWith('text/') || /^application\/(json|ld\+json|xml|javascript|x-yaml|yaml|toml)$/.test(mime) ||
        /\.(txt|text|log|md|markdown|csv|tsv|json|jsonl|xml|yaml|yml|toml|ini|conf|cfg|env|js|jsx|ts|tsx|css|html|htm|svg|sh|sql|go|py|rs|rb|java|c|cpp|h)$/i.test(name)) return 'text';
    return null;
}
