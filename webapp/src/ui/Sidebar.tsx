// Left column: header (menu + search), folders, chat list and the user panel.

import React, {useEffect, useMemo, useRef, useState} from 'react';
import {api} from '../mm/api';
import {searchEmoji} from '../mm/emoji';
import {
    getChatSummary,
    getContacts,
    getCurrentTeamId,
    getDirectChannelForUser,
    getMyId,
    getTabChats,
    getTabUnreadCounts,
    getTeams,
    searchChats,
    searchContactCandidates,
} from '../mm/selectors';
import type {ChatSummary} from '../mm/selectors';
import type {ChatTab} from '../mm/selectors';
import {getStatus, getTeams as teamsSelector, getUser} from '../mm/selectors';
import {getState, useSelector} from '../mm/store';
import type {MMPost} from '../mm/types';
import type {MMServerDraft} from '../mm/types';
import {displayName, formatChatTime, statusLabel, toPlainPreview, truncate} from '../mm/utils';
import {EmojiText} from './EmojiText';
import {markChannelUnreadFromLastPost} from '../mm/unread';
import {setChannelFavorite} from '../mm/favorites';
import {clearComposerDraft, selectChannelDrafts} from '../mm/drafts';
import {updateSettings} from '../mm/settings';
import {ChatList} from './ChatList';
import {useTg} from './context';
import {Menu, menuPositionFromElement} from './menu';
import type {MenuEntry} from './menu';
import {Avatar, IconBell, IconMenu, IconMattermost, IconMute, IconNewChat, IconSearch, IconSettings, IconUser, IconUsers} from './primitives';

function SearchResults({term, onContextMenu}: {term: string; onContextMenu: (event: React.MouseEvent, summary: ChatSummary) => void}) {
    const {actions, timeFormat} = useTg();
    const chats = useSelector((state) => searchChats(state, term));
    const contacts = useSelector((state) => searchContactCandidates(state, term, 12));
    const [messageHits, setMessageHits] = useState<{post: MMPost; channelId: string; title: string}[]>([]);
    // True from the first keystroke until the message search settles, so the panel reads
    // "Searching…" while the debounce and the request are still on the way, instead of the
    // premature "Nothing found".
    const [searching, setSearching] = useState(true);
    const teamId = useSelector(getCurrentTeamId);

    useEffect(() => {
        const trimmed = term.trim();
        // Mirror the chats/contacts results above: whatever the user typed is worth searching in
        // the messages too. The debounce keeps keystrokes from flooding the server, and a server
        // that rejects a too-short term just yields no message hits (the catch below).
        if (!trimmed || !teamId) {
            setMessageHits([]);
            setSearching(false);
            return undefined;
        }
        let cancelled = false;
        setSearching(true);
        const timer = setTimeout(() => {
            api.searchPosts(teamId, trimmed, {perPage: 20})
                .then((data) => {
                    if (cancelled) {
                        return;
                    }
                    const posts: MMPost[] = data ? (data.order || []).map((id) => data.posts[id]).filter(Boolean) : [];
                    setMessageHits(posts.map((post) => ({
                        post,
                        channelId: post.channel_id,
                        title: '',
                    })));
                    setSearching(false);
                })
                .catch(() => {
                    if (!cancelled) {
                        setMessageHits([]);
                        setSearching(false);
                    }
                });
        }, 350);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [term, teamId]);

    const chatTitle = (channelId: string) => {
        const summary = getChatSummary(getState(), channelId);
        return summary ? summary.title : '';
    };

    const hasAnything = chats.length || contacts.length || messageHits.length;

    return (
        <div className="tgw-search-results">
            {chats.length > 0 && (
                <>
                    <div className="tgw-section-title">Chats</div>
                    <ChatList
                        chats={chats}
                        selectedChannelId=""
                        onSelect={(id) => actions.openChat(id)}
                        onContextMenu={onContextMenu}
                        prefetchLimit={6}
                    />
                </>
            )}
            {contacts.length > 0 && (
                <>
                    <div className="tgw-section-title">Contacts</div>
                    <div className="tgw-chat-list">
                        {contacts.map((user) => (
                            <button
                                type="button"
                                key={user.id}
                                className="tgw-chat-row"
                                onClick={() => actions.openModal('newContact', {userId: user.id})}
                                onContextMenu={(event) => {
                                    event.preventDefault();
                                    const channel = getDirectChannelForUser(getState(), user.id);
                                    const summary = channel && getChatSummary(getState(), channel.id);
                                    if (summary) {
                                        onContextMenu(event, summary);
                                    }
                                }}
                            >
                                <Avatar userId={user.id} name={displayName(user)} size={54} status={getStatusOf(user.id)} showStatus/>
                                <span className="tgw-chat-row-body">
                                    <span className="tgw-chat-row-top">
                                        <span className="tgw-chat-row-title">{displayName(user)}</span>
                                    </span>
                                    <span className="tgw-chat-row-bottom">
                                        <span className="tgw-chat-row-preview">@{user.username}</span>
                                    </span>
                                </span>
                            </button>
                        ))}
                    </div>
                </>
            )}
            {messageHits.length > 0 && (
                <>
                    <div className="tgw-section-title">Messages</div>
                    <div className="tgw-chat-list">
                        {messageHits.map((hit) => (
                            <button
                                type="button"
                                key={hit.post.id}
                                className="tgw-chat-row tgw-message-hit"
                                onClick={() => actions.openChat(hit.channelId, {postId: hit.post.id})}
                                onContextMenu={(event) => {
                                    const summary = getChatSummary(getState(), hit.channelId);
                                    if (summary) {
                                        onContextMenu(event, summary);
                                    } else {
                                        event.preventDefault();
                                    }
                                }}
                            >
                                <span className="tgw-chat-row-body">
                                    <span className="tgw-chat-row-top">
                                        <span className="tgw-chat-row-title">{chatTitle(hit.channelId) || 'Conversation'}</span>
                                        <span className="tgw-chat-row-time">{formatChatTime(hit.post.create_at, timeFormat)}</span>
                                    </span>
                                    <span className="tgw-chat-row-bottom">
                                        <span className="tgw-chat-row-preview"><EmojiText text={truncate(toPlainPreview(hit.post.message), 90)}/></span>
                                    </span>
                                </span>
                            </button>
                        ))}
                        <button
                            type="button"
                            className="tgw-link-button tgw-search-see-all"
                            onClick={() => actions.setUI({searchOpen: true, mobilePane: 'chat'})}
                        >
                            See all message results
                        </button>
                    </div>
                </>
            )}
            {!hasAnything && (
                searching
                    ? <div className="tgw-empty-list"><div className="tgw-loading-pill">Searching…</div></div>
                    : <div className="tgw-empty-list"><div className="tgw-empty-title">Nothing found</div></div>
            )}
        </div>
    );
}

function getStatusOf(userId: string): string {
    // small helper to avoid re-rendering the whole list on status changes of unrelated users
    return 'offline';
}

export function Sidebar() {
    const {ui, actions, tabs, timeFormat, settings, me} = useTg();
    const chats = useSelector((state) => getTabChats(state, ui.activeTabId));
    const tabUnread = useSelector((state) => getTabUnreadCounts(state, tabs));
    // Drag-to-reorder state of the folder tabs (category tabs only).
    const [tabDrag, setTabDrag] = useState<string | null>(null);
    const [tabOver, setTabOver] = useState<string | null>(null);
    const contacts = useSelector(getContacts);
    const myId = useSelector(getMyId);
    const myStatus = useSelector((state) => getStatus(state, myId));
    const teams = useSelector(teamsSelector);
    const currentTeamId = useSelector(getCurrentTeamId);
    const draftStorage = useSelector((state) => state.storage?.storage);
    const [serverDrafts, setServerDrafts] = useState<MMServerDraft[]>([]);
    const localDrafts = useMemo(() => selectChannelDrafts({storage: {storage: draftStorage}} as any).map((draft) => ({
        channel_id: draft.channelId,
        root_id: draft.rootId || '',
        message: draft.message,
        create_at: draft.createAt,
        update_at: draft.updateAt,
        file_ids: (draft.fileInfos || []).map((file) => file.id),
    })), [draftStorage]);
    const draftEntries = useMemo(() => {
        const byKey = new Map<string, MMServerDraft>();
        serverDrafts.forEach((draft) => byKey.set(`${draft.channel_id}:${draft.root_id || ''}`, draft));
        localDrafts.forEach((draft) => byKey.set(`${draft.channel_id}:${draft.root_id || ''}`, {...byKey.get(`${draft.channel_id}:${draft.root_id || ''}`), ...draft}));
        return Array.from(byKey.values()).sort((a, b) => (b.update_at || b.create_at || 0) - (a.update_at || a.create_at || 0));
    }, [serverDrafts, localDrafts]);
    const [menu, setMenu] = useState<{x: number; y: number; items: MenuEntry[]; align?: 'left' | 'right'} | null>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const menuButtonRef = useRef<HTMLButtonElement>(null);
    const userButtonRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        let cancelled = false;
        if (!currentTeamId) {
            setServerDrafts([]);
            return undefined;
        }
        const timer = setTimeout(() => {
            api.getDrafts(currentTeamId).then((drafts) => {
                if (!cancelled) {
                    const ordered = Array.isArray(drafts) ? drafts.slice().sort((a, b) => (b.update_at || b.create_at || 0) - (a.update_at || a.create_at || 0)) : [];
                    setServerDrafts(ordered);
                }
            }).catch(() => {
                if (!cancelled) setServerDrafts([]);
            });
        }, 250);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [currentTeamId, draftStorage]);

    const folderTabs = useMemo(() => {
        const result = tabs.slice();
        if (draftEntries.length) {
            const favoriteIndex = result.findIndex((entry) => entry.kind === 'category' && entry.type === 'favorites');
            result.splice(favoriteIndex < 0 ? 2 : favoriteIndex + 1, 0, {
                id: '__drafts', label: 'Drafts', kind: 'drafts', sortOrder: 2,
            } as ChatTab);
        }
        return result;
    }, [tabs, draftEntries]);
    const tab = folderTabs.find((entry) => entry.id === ui.activeTabId) || folderTabs[0];
    const draftChats = useMemo(() => {
        const ids = Array.from(new Set(draftEntries.map((draft) => draft.channel_id).filter(Boolean)));
        return ids.map((id) => getChatSummary(getState(), id)).filter(Boolean) as ChatSummary[];
    }, [draftEntries, chats]);
    const visibleChats = tab?.kind === 'drafts' ? draftChats : chats;
    const isSearching = ui.search.trim().length > 0;

    useEffect(() => {
        if (ui.activeTabId === '__drafts' && !draftEntries.length) actions.setTab('__all');
    }, [ui.activeTabId, draftEntries, actions]);

    const markSectionRead = async (sectionChats: ChatSummary[]) => {
        const unread = sectionChats.filter((chat) => chat.unread > 0 || chat.mentions > 0 || chat.manuallyUnread);
        if (!unread.length) {
            return;
        }
        const results = await Promise.allSettled(unread.map((chat) => api.viewChannel(chat.id)));
        const failed = results.filter((result) => result.status === 'rejected').length;
        actions.toast(failed ? `Could not mark ${failed} chats as read` : 'Chats marked as read', failed ? 'error' : 'success');
    };

    const removeDraftEntries = async (entries: MMServerDraft[]) => {
        const serverKeys = new Set(serverDrafts.map((draft) => `${draft.channel_id}:${draft.root_id || ''}`));
        const results = await Promise.allSettled(entries.map((draft) => serverKeys.has(`${draft.channel_id}:${draft.root_id || ''}`)
            ? api.deleteDraft(draft.channel_id, draft.root_id || '')
            : Promise.resolve()));
        const removed = entries.filter((_, index) => results[index].status === 'fulfilled');
        removed.forEach((draft) => clearComposerDraft(draft.channel_id, draft.root_id || ''));
        const removedKeys = new Set(removed.map((draft) => `${draft.channel_id}:${draft.root_id || ''}`));
        setServerDrafts((current) => current.filter((draft) => !removedKeys.has(`${draft.channel_id}:${draft.root_id || ''}`)));
        const failed = results.length - removed.length;
        actions.toast(failed ? `Could not remove ${failed} drafts` : (entries.length === 1 ? 'Draft removed' : 'Drafts removed'), failed ? 'error' : 'success');
    };

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
                event.preventDefault();
                searchRef.current?.focus();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, []);

    const teamItems = useMemo(() => {
        const items: MenuEntry[] = [];
        Object.values(teams).forEach((team) => {
            if (team.delete_at) {
                return;
            }
            items.push({
                key: `team-${team.id}`,
                label: team.display_name,
                checked: team.id === currentTeamId,
                onClick: () => {
                    window.location.assign(`${(window as any).basename || ''}/${team.name}`);
                },
            });
        });
        return items;
    }, [teams, currentTeamId]);

    const openMainMenu = () => {
        const position = menuPositionFromElement(menuButtonRef.current);
        const items: MenuEntry[] = [
            {key: 'new-group', label: 'New Group', icon: <IconNewChat size={18}/>, onClick: () => actions.openModal('newGroup')},
            {key: 'new-channel', label: 'New Channel', icon: <IconUsersIcon/>, onClick: () => actions.openModal('newChannel')},
            {key: 'contacts', label: 'Contacts', icon: <IconUsers size={18}/>, onClick: () => actions.setTab('__contacts')},
            'separator',
        ];
        if (teamItems.length > 1) {
            items.push({key: 'teams', label: `Team: ${teams[currentTeamId]?.display_name || '-'}`, icon: <IconUsersIcon/>});
            teamItems.forEach((item) => {
                if (item !== 'separator') {
                    items.push({...item, key: `m-${item.key}`});
                }
            });
            items.push('separator');
        }
        items.push(
            {key: 'settings', label: 'Settings', icon: <IconSettings size={18}/>, onClick: () => actions.openModal('settings')},
            ...(me?.roles?.split(/\s+/).includes('system_admin') ? [{
                key: 'server-settings',
                label: 'Server settings',
                icon: <IconSettings size={18}/>,
                onClick: () => window.location.assign(`${(window as any).basename || ''}/admin_console`),
            }] : []),
            {key: 'disable', label: 'Switch to Mattermost UI', onClick: () => actions.disableUI()},
        );
        setMenu({...position, items});
    };

    // Opens Mattermost's own profile settings. Some hosts expose openUserSettings but do not open
    // the dialog from a plugin root, so fall back to the stock account menu's Profile action.
    const openHostProfileSettings = () => {
        const utils = (window as any).WebappUtils;
        if (typeof utils?.openUserSettings === 'function') {
            utils.openUserSettings({isContentProductSettings: false, activeTab: 'profile'});
            // The helper is a no-op in some current hosts. Give its React modal a turn to mount
            // before checking for the known native dialog, then use the stock menu if it did not.
            window.setTimeout(() => {
                if (!document.getElementById('accountSettingsModal')) {
                    openNativeProfileSettings();
                }
            }, 100);
            return;
        }
        openNativeProfileSettings();
    };

    const openNativeProfileSettings = () => {
        const accountButton = document.getElementById('userAccountMenuButton') as HTMLButtonElement | null;
        if (!accountButton) {
            actions.toast('Profile settings are not available in this Mattermost version', 'error');
            return;
        }
        accountButton.click();
        window.setTimeout(() => {
            const menu = document.getElementById('userAccountMenu') || document.querySelector('[role="menu"]');
            const profileItem = menu && Array.from(menu.querySelectorAll('[role="menuitem"], button'))
                .find((item) => item.textContent?.trim() === 'Profile') as HTMLElement | undefined;
            if (profileItem) {
                profileItem.click();
            } else {
                accountButton.click();
                actions.toast('Could not open profile settings', 'error');
            }
        }, 0);
    };

    const openUserMenu = () => {
        const position = menuPositionFromElement(userButtonRef.current);
        const statuses: Array<{key: string; label: string}> = [
            {key: 'online', label: 'Online'},
            {key: 'away', label: 'Away'},
            {key: 'dnd', label: 'Do not disturb'},
            {key: 'offline', label: 'Invisible'},
        ];
        setMenu({
            ...position,
            items: [
                ...statuses.map((status) => ({
                    key: `status-${status.key}`,
                    label: status.label,
                    checked: myStatus === status.key,
                    onClick: () => {
                        api.updateUserStatus(myId, status.key).catch(() => actions.toast('Could not update your status', 'error'));
                    },
                })),
                'separator' as const,
                {key: 'profile', label: 'Profile settings', icon: <IconUser size={18}/>, onClick: openHostProfileSettings},
                {key: 'settings', label: 'Settings', icon: <IconSettings size={18}/>, onClick: () => actions.openModal('settings')},
            ],
        });
    };

    const contextMenuForChat = (event: React.MouseEvent, summary: ChatSummary) => {
        event.preventDefault();
        const items: MenuEntry[] = [
            {key: 'open', label: 'Open chat', onClick: () => actions.openChat(summary.id)},
            ...(summary.unread > 0 || summary.manuallyUnread
                ? [{
                    key: 'read',
                    label: 'Mark as read',
                    onClick: () => {
                        api.viewChannel(summary.id).catch(() => undefined);
                    },
                } as MenuEntry]
                : [{
                    key: 'unread',
                    label: 'Mark as unread',
                    disabled: !summary.lastPostAt,
                    onClick: () => {
                        markChannelUnreadFromLastPost(summary.id)
                            .then((ok) => {
                                if (!ok) {
                                    actions.toast('Could not mark as unread', 'error');
                                }
                            })
                            .catch(() => actions.toast('Could not mark as unread', 'error'));
                    },
                } as MenuEntry]),
            {
                key: 'favorite',
                label: summary.isFavorite ? 'Remove from favorites' : 'Add to favorites',
                onClick: () => {
                    setChannelFavorite(summary.id, !summary.isFavorite).catch(() => {
                        actions.toast('Could not change favorites', 'error');
                    });
                },
            },
            ...(draftEntries.some((draft) => draft.channel_id === summary.id && !draft.root_id) ? [{
                key: 'delete-draft',
                label: 'Delete draft',
                onClick: () => {
                    const draft = draftEntries.find((entry) => entry.channel_id === summary.id && !entry.root_id);
                    if (draft) void removeDraftEntries([draft]);
                },
            } as MenuEntry] : []),
            {
                key: 'mute',
                label: summary.muted ? 'Unmute' : 'Mute',
                icon: summary.muted ? <IconBell size={18}/> : <IconMute size={18}/>,
                onClick: () => {
                    api.updateChannelNotifyProps(summary.id, myId, {
                        desktop: summary.muted ? 'default' : 'none',
                        mark_unread: summary.muted ? 'all' : 'mention',
                    }).catch(() => actions.toast('Could not change notifications', 'error'));
                },
            },
            'separator',
            {
                key: 'leave',
                label: summary.type === 'D' ? 'Close conversation' : 'Leave group',
                danger: true,
                onClick: () => {
                    actions.askConfirm({
                        title: summary.type === 'D' ? `Close conversation with ${summary.title}?` : `Leave ${summary.title}?`,
                        body: summary.type === 'D' ? 'The conversation will be removed from your chat list.' : 'You will need to be re-invited to join again.',
                        confirmLabel: summary.type === 'D' ? 'Close' : 'Leave',
                        danger: true,
                        onConfirm: () => {
                            api.leaveChannel(summary.id).catch(() => actions.toast('Could not leave the chat', 'error'));
                        },
                    });
                },
            },
        ];
        setMenu({x: event.clientX, y: event.clientY, items});
    };

    return (
        <aside className="tgw-sidebar">
            <header className="tgw-sidebar-header">
                <button type="button" className="tgw-icon-button tgw-menu-button" ref={menuButtonRef} onClick={openMainMenu} title="Menu">
                    <IconMenu size={24}/>
                </button>
                <div className="tgw-search">
                    <IconSearch size={20} className="tgw-search-icon"/>
                    <input
                        ref={searchRef}
                        value={ui.search}
                        onChange={(event) => actions.setUI({search: event.target.value})}
                        onKeyDown={(event) => {
                            // Enter promotes the narrow sidebar results to the wide all-messages
                            // panel in the main pane, like Mattermost's search.
                            if (event.key === 'Enter' && ui.search.trim()) {
                                event.preventDefault();
                                actions.setUI({searchOpen: true, mobilePane: 'chat'});
                            }
                        }}
                        placeholder="Search"
                        spellCheck={false}
                    />
                    {isSearching && (
                        <button type="button" className="tgw-search-clear" onClick={() => actions.setUI({search: ''})} title="Clear">
                            ×
                        </button>
                    )}
                </div>
                <button type="button" className="tgw-icon-button" onClick={actions.disableUI} title="Switch to Mattermost UI" aria-label="Switch to Mattermost UI">
                    <IconMattermost size={22}/>
                </button>
            </header>

            {!isSearching && settings.folderTabs && folderTabs.length > 1 && (
                <nav className="tgw-folders">
                    {folderTabs.map((entry) => {
                        const unread = tabUnread[entry.id] || 0;
                        const tabChats = settings.quietUnreadCounts ? getTabChats(getState(), entry.id) : [];
                        const priorityUnread = tabChats.reduce((sum, chat) => sum + (chat.type === 'D' ? chat.unread : chat.mentions), 0);
                        const otherUnread = tabChats.some((chat) => chat.type !== 'D' && (chat.unread > 0 || chat.manuallyUnread));
                        const isCategory = entry.kind === 'category';
                        return (
                            <button
                                type="button"
                                key={entry.id}
                                draggable={isCategory}
                                className={`tgw-folder${entry.id === ui.activeTabId ? ' tgw-folder-active' : ''}${tabDrag === entry.id ? ' tgw-folder-dragging' : ''}${tabOver === entry.id ? ' tgw-folder-dragover' : ''}`}
                                onClick={() => actions.setTab(entry.id)}
                                // Category tabs reorder by dragging. The order is stored like any
                                // other setting (user preference + localStorage mirror), while
                                // getTabs() keeps All/Unread pinned first and Contacts last.
                                onDragStart={(event) => {
                                    if (!isCategory) {
                                        return;
                                    }
                                    setTabDrag(entry.id);
                                    const transfer = (event as any).dataTransfer;
                                    if (transfer) {
                                        try {
                                            transfer.setData('text/plain', entry.id);
                                            transfer.effectAllowed = 'move';
                                        } catch {
                                            // Synthetic events (jsdom) carry no usable transfer.
                                        }
                                    }
                                }}
                                onDragOver={(event) => {
                                    if (!isCategory || !tabDrag || tabDrag === entry.id) {
                                        return;
                                    }
                                    event.preventDefault();
                                    setTabOver(entry.id);
                                }}
                                onDragLeave={() => setTabOver((current) => (current === entry.id ? null : current))}
                                onDrop={(event) => {
                                    event.preventDefault();
                                    const dragged = tabDrag;
                                    setTabDrag(null);
                                    setTabOver(null);
                                    if (!isCategory || !dragged || dragged === entry.id) {
                                        return;
                                    }
                                    const categoryIds = folderTabs.filter((tab) => tab.kind === 'category').map((tab) => tab.id);
                                    const without = categoryIds.filter((id) => id !== dragged);
                                    const at = without.indexOf(entry.id);
                                    without.splice(at === -1 ? without.length : at, 0, dragged);
                                    updateSettings({tabOrder: without});
                                }}
                                onDragEnd={() => {
                                    setTabDrag(null);
                                    setTabOver(null);
                                }}
                            >
                                {entry.label}
                                {settings.quietUnreadCounts ? (
                                    <>
                                        {priorityUnread > 0 && <span className="tgw-folder-badge">{priorityUnread > 99 ? '99+' : priorityUnread}</span>}
                                        {otherUnread && <span className="tgw-folder-dot" aria-label="Other unread messages"/>}
                                    </>
                                ) : unread > 0 && <span className="tgw-folder-badge">{unread > 99 ? '99+' : unread}</span>}
                            </button>
                        );
                    })}
                </nav>
            )}

            <div className="tgw-sidebar-body">
                {isSearching ? (
                    <SearchResults term={ui.search} onContextMenu={contextMenuForChat}/>
                ) : tab?.kind === 'contacts' ? (
                    <>
                        <div className="tgw-section-title">Contacts — {contacts.length}</div>
                        <div className="tgw-chat-list">
                            {contacts.map((user) => (
                                <button
                                    type="button"
                                    key={user.id}
                                    className="tgw-chat-row"
                                    onClick={() => actions.openModal('newContact', {userId: user.id})}
                                >
                                    <Avatar userId={user.id} name={displayName(user)} size={54}/>
                                    <span className="tgw-chat-row-body">
                                        <span className="tgw-chat-row-top">
                                            <span className="tgw-chat-row-title">{displayName(user)}</span>
                                        </span>
                                        <span className="tgw-chat-row-bottom">
                                            <span className="tgw-chat-row-preview">{user.position || `@${user.username}`}</span>
                                        </span>
                                    </span>
                                </button>
                            ))}
                        </div>
                    </>
                ) : (
                    <ChatList
                        chats={visibleChats}
                        sectionTitle={tab?.kind !== 'all' ? tab?.label : undefined}
                        onMarkSectionRead={markSectionRead}
                        sectionActionLabel={tab?.kind === 'drafts' ? 'Remove all drafts' : undefined}
                        onRemoveAllDrafts={tab?.kind === 'drafts' ? () => removeDraftEntries(draftEntries) : undefined}
                        selectedChannelId={ui.selectedChannelId}
                        onSelect={(id) => actions.openChat(id)}
                        onContextMenu={contextMenuForChat}
                        showTeamNames={tab?.kind === 'all'}
                        groupAllChats={tab?.kind === 'all'}
                        reorderable={tab?.kind === 'category' ? {categoryId: tab.id} : null}
                        emptyTitle={tab?.kind === 'unread' ? 'No unread chats' : 'No chats here yet'}
                        emptyBody={tab?.kind === 'unread' ? 'You are all caught up.' : 'Start a conversation to see it listed here.'}
                    />
                )}
            </div>

            <footer className="tgw-user-panel">
                <button type="button" className="tgw-user-button" ref={userButtonRef} onClick={openUserMenu}>
                    <Avatar userId={myId} name={me ? displayName(me) : ''} size={40} status={myStatus} showStatus/>
                    <span className="tgw-user-panel-info">
                        <span className="tgw-user-panel-name">{me ? displayName(me) : 'Me'}</span>
                        <span className="tgw-user-panel-status">{statusLabel(myStatus, 0, timeFormat)}</span>
                    </span>
                    <IconSettings size={20} className="tgw-user-panel-gear"/>
                </button>
            </footer>

            {menu && <Menu x={menu.x} y={menu.y} items={menu.items} align={menu.align} onClose={() => setMenu(null)}/>}
        </aside>
    );
}

function IconUsersIcon() {
    return <IconUsersSmall/>;
}

function IconUsersSmall() {
    return (
        <svg width={18} height={18} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M16 11a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm-8 0a3 3 0 1 0-3-3 3 3 0 0 0 3 3Zm0 2c-2.7 0-6 1.3-6 3.5V19h8v-2.5c0-.9.5-1.9 1.4-2.7A12 12 0 0 0 8 13Zm8 0c-3 0-6 1.5-6 3.5V19h12v-2.5c0-2-3-3.5-6-3.5Z"/>
        </svg>
    );
}
