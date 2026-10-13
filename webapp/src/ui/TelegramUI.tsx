// Root component of the Telegram Web UI: context provider, overlay shell, global state and the
// toast / context menu / modal layers.

import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {api} from '../mm/api';
import {loadChannel} from '../mm/posts';
import {getAllChats, getChatSummary, getMyId, getSiteURL, getTabs, getTimeFormat} from '../mm/selectors';
import {getState, readLocal, useSelector, writeLocal} from '../mm/store';
import {getSettings, subscribeSettings} from '../mm/settings';
import {copyToClipboard, toPlainPreview} from '../mm/utils';
import {markPostUnread} from '../mm/unread';
import type {MMChannel, MMPost} from '../mm/types';
import {ChatView} from './ChatView';
import {ConfirmModal, ImageViewer, Modals} from './Modals';
import {EmojiPicker} from './EmojiPicker';
import {InfoPanel} from './InfoPanel';
import {Menu} from './menu';
import type {MenuEntry} from './menu';
import {Sidebar} from './Sidebar';
import {ThreadPanel} from './ThreadPanel';
import {TgContext} from './context';
import type {TgActions, TgUIState} from './context';

interface Toast {
    id: number;
    message: string;
    kind: 'info' | 'error' | 'success';
}

const INITIAL_UI: TgUIState = {
    selectedChannelId: '',
    activeTabId: '__all',
    search: '',
    infoOpen: false,
    menuOpen: false,
    settingsAnchor: null,
    modal: null,
    modalPayload: undefined,
    confirm: null,
    replyTo: null,
    editing: null,
    contextMenu: null,
    imageViewer: null,
    highlightedPostId: null,
    threadRootId: null,
    mobilePane: 'list',
};

function useSettingsState() {
    const [settings, setSettings] = useState(getSettings());
    useEffect(() => subscribeSettings(() => setSettings({...getSettings()})), []);
    return settings;
}

function useIsMobile(): boolean {
    const [isMobile, setIsMobile] = useState(() => window.innerWidth < 900);
    useEffect(() => {
        const onResize = () => setIsMobile(window.innerWidth < 900);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);
    return isMobile;
}

export function TelegramUI() {
    const settings = useSettingsState();
    const isMobile = useIsMobile();
    const [ui, setUIState] = useState<TgUIState>(() => ({...INITIAL_UI, selectedChannelId: readLocal('tgw.lastChannel', '')}));
    const [toasts, setToasts] = useState<Toast[]>([]);
    const [contextMenu, setContextMenu] = useState<{x: number; y: number; items: MenuEntry[]} | null>(null);
    const [reactionPicker, setReactionPicker] = useState<{post: MMPost; x: number; y: number} | null>(null);
    const toastId = useRef(0);

    const me = useSelector((state) => state.entities?.users?.profiles?.[state.entities?.users?.currentUserId]);
    const tabs = useSelector(getTabs);
    const timeFormat = useSelector(getTimeFormat);
    const mmCurrentChannelId = useSelector((state) => state.entities?.channels?.currentChannelId);
    const channel = useSelector((state) => (ui.selectedChannelId ? state.entities?.channels?.channels?.[ui.selectedChannelId] : undefined));
    const [fallbackChannel, setFallbackChannel] = useState<MMChannel | undefined>(undefined);

    // Channels that were just created are not in the store yet: fetch them once.
    useEffect(() => {
        if (!ui.selectedChannelId || channel || fallbackChannel?.id === ui.selectedChannelId) {
            return;
        }
        let cancelled = false;
        api.getChannel(ui.selectedChannelId)
            .then((fetched) => {
                if (!cancelled) {
                    setFallbackChannel(fetched);
                }
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [ui.selectedChannelId, channel, fallbackChannel]);

    const activeChannel = channel || (fallbackChannel?.id === ui.selectedChannelId ? fallbackChannel : undefined);

    const setUI = useCallback((patch: Partial<TgUIState>) => {
        setUIState((current) => ({...current, ...patch}));
    }, []);

    const toast = useCallback((message: string, kind: 'info' | 'error' | 'success' = 'info') => {
        toastId.current += 1;
        const id = toastId.current;
        setToasts((current) => [...current, {id, message, kind}]);
        setTimeout(() => setToasts((current) => current.filter((entry) => entry.id !== id)), 4000);
    }, []);

    const syncRoute = useCallback((target?: MMChannel) => {
        if (!getSettings().syncRoute || !target) {
            return;
        }
        try {
            const webapp = (window as any).WebappUtils;
            const history = webapp?.browserHistory;
            if (!history?.push) {
                return;
            }
            const state = getState();
            const team = state.entities?.teams?.teams?.[target.team_id];
            const basename = (window as any).basename || '';
            let path = '';
            if (target.type === 'D') {
                const peerId = (target.name || '').split('__').find((id) => id !== state.entities?.users?.currentUserId);
                const peer = peerId ? state.entities?.users?.profiles?.[peerId] : undefined;
                path = `/${team?.name}/messages/@${peer?.username || peerId}`;
            } else if (target.type === 'G') {
                path = `/${team?.name}/messages/${target.name}`;
            } else {
                path = `/${team?.name}/channels/${target.name}`;
            }
            if (path.includes('undefined')) {
                return;
            }
            history.push(`${basename}${path}`);
        } catch (error) {
            // eslint-disable-next-line no-console
            console.warn('[telegram-web-ui] could not sync the Mattermost route', error);
        }
    }, []);

    const openChat = useCallback((channelId: string, opts: {keepSearch?: boolean; postId?: string} = {}) => {
        const state = getState();
        const target = state.entities?.channels?.channels?.[channelId];
        setUIState((current) => ({
            ...current,
            selectedChannelId: channelId,
            search: opts.keepSearch ? current.search : '',
            mobilePane: 'chat',
            highlightedPostId: opts.postId || null,
            replyTo: null,
            editing: null,
            threadRootId: null,
        }));
        writeLocal('tgw.lastChannel', channelId);
        loadChannel(channelId).catch(() => undefined);
        api.viewChannel(channelId).catch(() => undefined);
        setFallbackChannel(undefined);
        syncRoute(target);
    }, [syncRoute]);

    const actions: TgActions = useMemo(() => ({
        setUI,
        openChat,
        backToList: () => setUI({mobilePane: 'list'}),
        openModal: (modal, payload) => setUI({modal, modalPayload: payload}),
        closeModal: () => setUI({modal: null, modalPayload: undefined}),
        askConfirm: (dialog) => setUI({confirm: dialog}),
        toast,
        startReply: (post) => setUI({replyTo: post, editing: null}),
        startEditing: (post) => setUI({editing: post, replyTo: null}),
        openContextMenu: (target) => {
            if (!target) {
                setContextMenu(null);
                return;
            }
            const menuItems = buildPostMenu(target.post, {
                reply: (post) => setUI({replyTo: post, editing: null}),
                edit: (post) => setUI({editing: post, replyTo: null}),
                del: (post) => setUI({
                    confirm: {
                        title: 'Delete this message?',
                        body: toPlainPreview(post.message, 120) || 'This message will be removed for everyone.',
                        confirmLabel: 'Delete',
                        danger: true,
                        onConfirm: () => {
                            api.deletePost(post.id)
                                .then(() => toast('Message deleted', 'success'))
                                .catch(() => toast('You are not allowed to delete this message', 'error'));
                        },
                    },
                }),
                react: (post) => setReactionPicker({post, x: target.x, y: target.y}),
                thread: (post) => setUI({threadRootId: post.root_id || post.id}),
                markUnread: (post) => {
                    markPostUnread(post)
                        .then((ok) => {
                            if (ok) {
                                toast('Marked as unread', 'success');
                            } else {
                                toast('Could not mark as unread', 'error');
                            }
                        })
                        .catch(() => toast('Could not mark as unread', 'error'));
                },
                toast,
                openChat,
            });
            setContextMenu({x: target.x, y: target.y, items: menuItems});
        },
        openReactionPicker: (post, x, y) => setReactionPicker({post, x, y}),
        setTab: (tabId) => setUI({activeTabId: tabId, search: ''}),
        refreshChats: () => setUI({}),
        disableUI: () => {
            // The plugin exposes this through index.tsx (which flips the setting).
            (window as any).dispatchEvent(new CustomEvent('tgw:disable'));
        },
    }), [openChat, setUI, toast]);

    // Keep the selected chat in sync with the Mattermost app (notification clicks, deep links).
    useEffect(() => {
        if (!mmCurrentChannelId) {
            return;
        }
        const state = getState();
        const isMember = !!state.entities?.channels?.myMembers?.[mmCurrentChannelId];
        if (!isMember) {
            return;
        }
        setUIState((current) => (current.selectedChannelId === mmCurrentChannelId ? current : {...current, selectedChannelId: mmCurrentChannelId}));
    }, [mmCurrentChannelId]);

    // Pick a sensible chat on first paint.
    useEffect(() => {
        if (!settings.mode || settings.mode !== 'on' || ui.selectedChannelId) {
            return;
        }
        const chats = getAllChats(getState());
        if (chats.length) {
            setUIState((current) => ({...current, selectedChannelId: chats[0].id}));
            writeLocal('tgw.lastChannel', chats[0].id);
        }
    }, [settings.mode, ui.selectedChannelId]);

    useEffect(() => {
        document.body.classList.toggle('tgw-root-active', settings.mode === 'on');
        return () => document.body.classList.remove('tgw-root-active');
    }, [settings.mode]);

    const value = useMemo(() => ({
        settings,
        ui,
        actions,
        tabs,
        me,
        timeFormat,
        channel: activeChannel,
        isMobile,
    }), [settings, ui, actions, tabs, me, timeFormat, activeChannel, isMobile]);

    if (settings.mode !== 'on') {
        return null;
    }

    return (
        <TgContext.Provider value={value}>
            {createPortal(
                <div className={`tgw-root tgw-theme-${settings.theme} tgw-accent-${settings.accent} ${settings.compactMode ? 'tgw-compact' : ''} ${settings.animations ? '' : 'tgw-no-animations'}`}>
                    <div className={`tgw-shell ${isMobile ? 'tgw-shell-mobile' : ''} ${isMobile && ui.mobilePane === 'chat' ? 'tgw-shell-chat-open' : ''}`}>
                        <Sidebar/>
                        <ChatView/>
                        {ui.threadRootId && activeChannel && (
                            <ThreadPanel
                                rootId={ui.threadRootId}
                                channel={activeChannel}
                                onClose={() => actions.setUI({threadRootId: null})}
                            />
                        )}
                        {ui.infoOpen && !ui.threadRootId && <InfoPanel/>}
                    </div>
                    <Modals/>
                    <ConfirmModal/>
                    <ImageViewer/>
                    {contextMenu && <Menu x={contextMenu.x} y={contextMenu.y} items={contextMenu.items} onClose={() => setContextMenu(null)}/>}
                    {reactionPicker && (
                        <div
                            className="tgw-floating-picker"
                            style={{
                                position: 'fixed',
                                left: Math.max(12, Math.min(reactionPicker.x - 200, window.innerWidth - 420)),
                                top: Math.max(60, Math.min(reactionPicker.y + 10, window.innerHeight - 430)),
                            }}
                        >
                            <EmojiPicker
                                onClose={() => setReactionPicker(null)}
                                onPick={(name) => {
                                    const myId = getState().entities?.users?.currentUserId;
                                    if (myId) {
                                        api.addReaction(myId, reactionPicker.post.id, name).catch(() => toast('Could not add the reaction', 'error'));
                                    }
                                    setReactionPicker(null);
                                }}
                            />
                        </div>
                    )}
                    <div className="tgw-toasts">
                        {toasts.map((entry) => (
                            <div key={entry.id} className={`tgw-toast tgw-toast-${entry.kind}`}>{entry.message}</div>
                        ))}
                    </div>
                </div>,
                document.body,
            )}
        </TgContext.Provider>
    );
}

interface BuildMenuHandlers {
    reply: (post: MMPost) => void;
    edit: (post: MMPost) => void;
    del: (post: MMPost) => void;
    react: (post: MMPost) => void;
    thread: (post: MMPost) => void;
    markUnread: (post: MMPost) => void;
    toast: (message: string, kind?: 'info' | 'error' | 'success') => void;
    openChat: (channelId: string, opts?: {postId?: string}) => void;
}

function buildPostMenu(post: MMPost | undefined, handlers: BuildMenuHandlers): MenuEntry[] {
    if (!post) {
        return [];
    }
    const state = getState();
    const myId = state.entities?.users?.currentUserId || '';
    const isOwn = post.user_id === myId;
    const items: MenuEntry[] = [
        {key: 'reply', label: 'Reply', onClick: () => handlers.reply(post)},
        {key: 'react', label: 'Add reaction', onClick: () => handlers.react(post)},
        {
            key: 'copy',
            label: 'Copy text',
            onClick: () => copyToClipboard(post.message || '').then(() => handlers.toast('Message copied', 'success')),
        },
        {key: 'unread', label: 'Mark as unread', onClick: () => handlers.markUnread(post)},
    ];
    if (post.reply_count > 0 || post.root_id) {
        items.push({key: 'thread', label: 'Open thread', onClick: () => handlers.thread(post)});
    }
    if (isOwn) {
        items.push(
            'separator',
            {key: 'edit', label: 'Edit message', onClick: () => handlers.edit(post)},
            {key: 'delete', label: 'Delete message', danger: true, onClick: () => handlers.del(post)},
        );
    } else {
        items.push('separator', {
            key: 'delete',
            label: 'Delete message',
            danger: true,
            onClick: () => handlers.del(post),
        });
    }
    return items;
}

export function useChannelMeta(channelId: string) {
    return useSelector((state) => (channelId ? getChatSummary(state, channelId) : undefined));
}

export function useMyUserId() {
    return useSelector(getMyId);
}

export function useSiteURL() {
    return useSelector(getSiteURL);
}
