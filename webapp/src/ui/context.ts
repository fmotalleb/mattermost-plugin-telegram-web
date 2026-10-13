// React context shared by the Telegram Web UI components.

import {createContext, useContext} from 'react';
import type {PluginSettings} from '../mm/settings';
import type {ChatTab} from '../mm/selectors';
import type {MMChannel, MMPost, MMUser} from '../mm/types';
import type {TimeFormat} from '../mm/utils';

export type ModalKind = null | 'settings' | 'newGroup' | 'newChannel' | 'newContact' | 'channelInfo' | 'addMembers' | 'userPicker';

export interface ConfirmDialog {
    title: string;
    body?: string;
    confirmLabel?: string;
    danger?: boolean;
    onConfirm: () => void;
}

export interface ContextTarget {
    post?: MMPost;
    chat?: string;
    user?: MMUser;
    channel?: MMChannel;
    x: number;
    y: number;
}

export interface TgUIState {
    selectedChannelId: string;
    activeTabId: string;
    search: string;
    infoOpen: boolean;
    menuOpen: boolean;
    settingsAnchor: {x: number; y: number} | null;
    modal: ModalKind;
    modalPayload?: any;
    confirm: ConfirmDialog | null;
    replyTo: MMPost | null;
    editing: MMPost | null;
    contextMenu: ContextTarget | null;
    imageViewer: {post: MMPost; fileId?: string} | null;
    highlightedPostId: string | null;
    threadRootId: string | null;
    mobilePane: 'list' | 'chat';
}

export interface TgActions {
    setUI: (patch: Partial<TgUIState>) => void;
    openChat: (channelId: string, opts?: {keepSearch?: boolean; postId?: string}) => void;
    backToList: () => void;
    openModal: (modal: ModalKind, payload?: any) => void;
    closeModal: () => void;
    askConfirm: (dialog: ConfirmDialog) => void;
    toast: (message: string, kind?: 'info' | 'error' | 'success') => void;
    startReply: (post: MMPost | null) => void;
    startEditing: (post: MMPost | null) => void;
    openContextMenu: (target: ContextTarget | null) => void;
    openReactionPicker: (post: MMPost, x: number, y: number) => void;
    setTab: (tabId: string) => void;
    refreshChats: () => void;
    disableUI: () => void;
}

export interface TgContextValue {
    settings: PluginSettings;
    ui: TgUIState;
    actions: TgActions;
    tabs: ChatTab[];
    me?: MMUser;
    timeFormat: TimeFormat;
    channel?: MMChannel;
    isMobile: boolean;
}

export const TgContext = createContext<TgContextValue | null>(null);

export function useTg(): TgContextValue {
    const value = useContext(TgContext);
    if (!value) {
        throw new Error('TgContext is not available outside of the Telegram Web UI');
    }
    return value;
}
