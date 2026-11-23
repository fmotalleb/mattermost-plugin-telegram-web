import {api} from './api';
import type {MMFileInfo} from './types';

declare global {
    interface Window {
        desktopAPI?: object;
        desktop?: object;
        showSaveFilePicker?: (options: {suggestedName: string; startIn: 'downloads'}) => Promise<FileSystemFileHandle>;
    }
}

export function canSaveFileAs(): boolean {
    return Boolean(window.desktopAPI || window.desktop) && typeof window.showSaveFilePicker === 'function';
}

export async function saveFileAs(file: MMFileInfo, toast: (message: string, kind: 'success' | 'error') => void) {
    const controller = new AbortController();
    try {
        const handle = await window.showSaveFilePicker({suggestedName: file.name, startIn: 'downloads'}).catch((error) => {
            if (error.name === 'AbortError') return undefined;
            throw error;
        });
        if (!handle) return;

        const response = await api.getFileResponse(file.id, controller.signal, {download: true});
        if (!response.body) throw new Error('The attachment response has no file data');
        await response.body.pipeTo(await handle.createWritable());
        toast('File saved', 'success');
    } catch {
        toast('Could not save the file', 'error');
    } finally {
        controller.abort();
    }
}
