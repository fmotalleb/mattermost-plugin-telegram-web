// Keep plugin-composer drafts in Mattermost's own storage slice. Mattermost's composer
// keys channel drafts as `draft_<channelId>` and thread drafts as `comment_draft_<rootId>`.

import {getState, getStore} from './store';
import type {MMFileInfo} from './types';

const CHANNEL_DRAFT_PREFIX = 'draft_';
const COMMENT_DRAFT_PREFIX = 'comment_draft_';

export interface ComposerDraft {
    message: string;
    fileInfos: MMFileInfo[];
    uploadsInProgress: string[];
    channelId: string;
    rootId: string;
    createAt: number;
    updateAt: number;
    metadata: Record<string, any>;
    show?: boolean;
}

export function draftKey(channelId: string, rootId = ''): string {
    return rootId ? `${COMMENT_DRAFT_PREFIX}${rootId}` : `${CHANNEL_DRAFT_PREFIX}${channelId}`;
}

export function getComposerDraft(channelId: string, rootId = ''): ComposerDraft | undefined {
    return getState().storage?.storage?.[draftKey(channelId, rootId)];
}

/** Dispatches the same Redux actions Mattermost uses to keep its local draft storage up to date. */
export function saveComposerDraft(channelId: string, message: string, rootId = '', show = false) {
    const key = draftKey(channelId, rootId);
    const current = getComposerDraft(channelId, rootId);
    const now = Date.now();
    const value: ComposerDraft = {
        message,
        fileInfos: current?.fileInfos || [],
        uploadsInProgress: current?.uploadsInProgress || [],
        channelId,
        rootId,
        createAt: current?.createAt || now,
        updateAt: now,
        metadata: current?.metadata || {},
        show: show || undefined,
    };
    const dispatch = getStore()?.dispatch;
    if (!dispatch) {
        return;
    }
    dispatch({
        type: 'SET_GLOBAL_ITEM',
        data: {name: key, value, timestamp: new Date()},
    });
    dispatch({
        type: 'SET_DRAFT_SOURCE',
        data: {key, isRemote: false},
    });
}

export function clearComposerDraft(channelId: string, rootId = '') {
    const key = draftKey(channelId, rootId);
    const dispatch = getStore()?.dispatch;
    if (!dispatch) {
        return;
    }
    // Match Mattermost's removeDraft action: an empty item clears the synced entry while
    // preserving the storage key used by its draft selectors and local-storage middleware.
    dispatch({
        type: 'SET_GLOBAL_ITEM',
        data: {
            name: key,
            value: {message: '', fileInfos: [], uploadsInProgress: [], metadata: {}},
            timestamp: new Date(),
        },
    });
    dispatch({
        type: 'SET_DRAFT_SOURCE',
        data: {key, isRemote: false},
    });
}
