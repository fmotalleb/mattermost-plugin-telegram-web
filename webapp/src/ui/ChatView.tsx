// The chat screen: header, message list, composer and the thread side panel.

import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {api} from '../mm/api';
import {addOptimistic, getBlock, getReactions, loadChannel, markFailed, receivePost, receiveReaction, useChannelPosts} from '../mm/posts';
import {getChatSummary, getTypingUserIds} from '../mm/selectors';
import {useSelector} from '../mm/store';
import type {MMChannel, MMFileInfo, MMPost, MMReaction} from '../mm/types';
import {copyToClipboard, displayName, memberCountLabel, statusLabel} from '../mm/utils';
import {Composer} from './Composer';
import {useTg} from './context';
import {MessageList} from './MessageList';
import {Menu, menuPositionFromElement} from './menu';
import type {MenuEntry} from './menu';
import {Avatar, IconBack, IconClose, IconLink, IconMore, IconSearch, IconStar, IconUsers, IconCheck} from './primitives';

function minimalSummary(channel: MMChannel) {
    const title = channel.display_name || channel.name || 'Conversation';
    return {
        id: channel.id,
        channel,
        type: channel.type,
        title,
        subtitle: '',
        avatarUserId: undefined,
        initials: title.slice(0, 2).toUpperCase(),
        color: '',
        isFavorite: false,
        folded: false,
        unread: 0,
        mentions: 0,
        muted: false,
        manuallyUnread: false,
        lastPostAt: channel.last_post_at || 0,
        lastViewedAt: 0,
        status: undefined,
        memberCount: 0,
        teamId: channel.team_id,
        teamName: '',
        peerIds: [],
    };
}

export function ChatView() {
    const {ui, actions, timeFormat, me, isMobile, channel} = useTg();
    const channelId = ui.selectedChannelId;
    const storeSummary = useSelector((state) => (channelId ? getChatSummary(state, channelId) : undefined));
    const summary = storeSummary || (channel ? minimalSummary(channel) : undefined);
    const {posts, loading, loadingOlder, hasMoreOlder} = useChannelPosts(channelId);
    const typingIds = useSelector((state) => (channelId ? getTypingUserIds(state, channelId) : []));
    const profiles = useSelector((state) => state.entities?.users?.profiles);
    const teamName = useSelector((state) => (channel ? state.entities?.teams?.teams?.[channel.team_id]?.name : ''));
    const [inChatSearch, setInChatSearch] = useState('');
    const [searchOpen, setSearchOpen] = useState(false);
    const [menu, setMenu] = useState<{x: number; y: number; items: MenuEntry[]} | null>(null);
    const headerMoreRef = React.useRef<HTMLButtonElement>(null);

    useEffect(() => {
        setInChatSearch('');
        setSearchOpen(false);
    }, [channelId]);

    useEffect(() => {
        if (channelId) {
            loadChannel(channelId);
            api.viewChannel(channelId).catch(() => undefined);
        }
    }, [channelId]);

    const visiblePosts = useMemo(() => {
        if (!inChatSearch.trim()) {
            return posts;
        }
        const term = inChatSearch.trim().toLowerCase();
        return posts.filter((post) => (post.message || '').toLowerCase().includes(term));
    }, [posts, inChatSearch]);

    const handleSend = useCallback(async ({message, fileIds, rootId, files, voice}: {message: string; fileIds: string[]; rootId?: string; files?: MMFileInfo[]; voice?: {fileId: string; durationMs: number; levels: number[]}}) => {
        if (!channel) {
            return;
        }
        const pendingId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const optimistic: MMPost = {
            id: `pending-${pendingId}`,
            create_at: Date.now(),
            update_at: Date.now(),
            edit_at: 0,
            delete_at: 0,
            is_pinned: false,
            user_id: me?.id || '',
            channel_id: channel.id,
            root_id: rootId || '',
            original_id: '',
            message,
            type: '',
            props: voice ? {voice} : {},
            pending_post_id: pendingId,
            file_ids: fileIds,
            // Without this the optimistic bubble cannot render the attachments we just uploaded;
            // the server echo normally brings the same data back.
            metadata: files?.length ? {files} : undefined,
        };
        addOptimistic(channel.id, optimistic);
        try {
            const post = await api.createPost({
                channel_id: channel.id,
                message,
                root_id: rootId,
                file_ids: fileIds,
                pending_post_id: pendingId,
                props: voice ? {voice} : undefined,
            });
            if (post) {
                // Keep the attachment metadata and the voice waveform when the echo omits them.
                let merged = post;
                if (files?.length && !merged.metadata?.files?.length) {
                    merged = {...merged, metadata: {...merged.metadata, files}};
                }
                if (voice && merged.props?.voice?.fileId !== voice.fileId) {
                    merged = {...merged, props: {...merged.props, voice}};
                }
                receivePost(merged);
            }
            api.viewChannel(channel.id).catch(() => undefined);
        } catch (error: any) {
            markFailed(channel.id, optimistic.id);
            actions.toast(error?.message || 'Message not sent', 'error');
            throw error;
        }
    }, [channel, me, actions]);

    // Toggling is always about *my* participation in an emoji, never about the reaction object
    // the chip happened to hand us - that one may belong to whoever reacted first.
    const toggleEmoji = useCallback((post: MMPost, emojiName: string) => {
        const myId = me?.id;
        if (!myId || !emojiName) {
            return;
        }
        const mine = getReactions(getBlock(post.channel_id), post.id)
            .some((reaction) => reaction.user_id === myId && reaction.emoji_name === emojiName);
        const optimistic: MMReaction = {user_id: myId, post_id: post.id, emoji_name: emojiName, create_at: Date.now()};
        // Apply the change locally right away; the websocket echo overwrites it with the
        // authoritative record and the failure branch below puts it back if the API says no.
        receiveReaction(optimistic, !mine);
        const call = mine
            ? api.removeReaction(myId, post.id, emojiName)
            : api.addReaction(myId, post.id, emojiName);
        call.catch(() => {
            receiveReaction(optimistic, mine);
            actions.toast('Could not update the reaction', 'error');
        });
    }, [me, actions]);

    const toggleReaction = useCallback((post: MMPost, reaction: MMReaction) => {
        toggleEmoji(post, reaction.emoji_name);
    }, [toggleEmoji]);

    const addReaction = (post: MMPost, emojiName: string) => {
        toggleEmoji(post, emojiName);
    };

    const openHeaderMenu = () => {
        if (!summary || !channel) {
            return;
        }
        const position = menuPositionFromElement(headerMoreRef.current, 'right');
        const items: MenuEntry[] = [
            {key: 'info', label: channel.type === 'D' ? 'Contact info' : 'Channel info', icon: <IconUsers size={18}/>, onClick: () => actions.setUI({infoOpen: true})},
            {key: 'search', label: 'Search in chat', icon: <IconSearch size={18}/>, onClick: () => setSearchOpen(true)},
            {
                key: 'favorite',
                label: summary.isFavorite ? 'Remove from favorites' : 'Add to favorites',
                icon: <IconStar size={16}/>,
                onClick: () => {
                    const webapp = (window as any).WebappUtils;
                    if (webapp?.channels?.favoriteChannel) {
                        if (summary.isFavorite) {
                            webapp.channels.unfavoriteChannel(channel.id);
                        } else {
                            webapp.channels.favoriteChannel(channel.id);
                        }
                    }
                },
            },
            {
                key: 'mute',
                label: summary.muted ? 'Unmute' : 'Mute',
                onClick: () => {
                    api.updateChannelNotifyProps(channel.id, me?.id || '', {
                        desktop: summary.muted ? 'default' : 'none',
                        mark_unread: summary.muted ? 'all' : 'mention',
                    }).catch(() => actions.toast('Could not change notifications', 'error'));
                },
            },
            {
                key: 'read',
                label: 'Mark as read',
                icon: <IconCheck size={16}/>,
                onClick: () => api.viewChannel(channel.id).catch(() => undefined),
            },
            'separator',
            {
                key: 'permalink',
                label: 'Copy channel link',
                icon: <IconLink size={16}/>,
                onClick: () => {
                    const basename = (window as any).basename || '';
                    const path = channel.type === 'D' || channel.type === 'G' ? `messages/${channel.name}` : `channels/${channel.name}`;
                    const url = `${window.location.origin}${basename}/${teamName ? `${teamName}/` : ''}${path}`;
                    copyToClipboard(url).then(() => actions.toast('Channel link copied', 'success'));
                },
            },
            {
                key: 'leave',
                label: channel.type === 'D' ? 'Close conversation' : 'Leave channel',
                danger: true,
                onClick: () => {
                    actions.askConfirm({
                        title: channel.type === 'D' ? `Close conversation with ${summary.title}?` : `Leave ${summary.title}?`,
                        confirmLabel: channel.type === 'D' ? 'Close' : 'Leave',
                        danger: true,
                        onConfirm: () => api.leaveChannel(channel.id).catch(() => actions.toast('Could not leave the chat', 'error')),
                    });
                },
            },
        ];
        setMenu({...position, items});
    };

    if (!channel || !summary) {
        return (
            <section className="tgw-chat tgw-chat-empty">
                <div className="tgw-empty-chat">
                    <div className="tgw-empty-chat-title">Select a chat to start messaging</div>
                    <div className="tgw-empty-chat-body">Your Mattermost channels, direct messages, groups and custom folders are all here.</div>
                </div>
            </section>
        );
    }

    const typingLabel = typingIds.length && profiles
        ? `${typingIds.map((id) => (profiles[id] ? displayName(profiles[id]).split(' ')[0] : 'Someone')).join(', ')} typing…`
        : '';

    const subtitle = typingLabel || (channel.type === 'D'
        ? statusLabel(summary.status, 0, timeFormat)
        : memberCountLabel(channel.type === 'G' ? summary.peerIds.length || summary.memberCount : summary.memberCount));

    return (
        <section className="tgw-chat">
            <header className="tgw-chat-header">
                {isMobile && (
                    <button type="button" className="tgw-icon-button tgw-back-button" onClick={actions.backToList} title="Back">
                        <IconBack size={22}/>
                    </button>
                )}
                <button type="button" className="tgw-chat-header-main" onClick={() => actions.setUI({infoOpen: true})}>
                    <Avatar
                        userId={summary.avatarUserId}
                        name={summary.title}
                        colorKey={channel.type === 'D' ? summary.peerIds[0] : channel.id}
                        size={44}
                        status={summary.status}
                        showStatus={channel.type === 'D'}
                    />
                    <span className="tgw-chat-header-text">
                        <span className="tgw-chat-header-title">{summary.title}</span>
                        <span className={`tgw-chat-header-sub ${typingLabel ? 'tgw-typing-label' : ''}`}>{subtitle}</span>
                    </span>
                </button>
                <div className="tgw-chat-header-actions">
                    <button type="button" className="tgw-icon-button" title="Search in chat" onClick={() => setSearchOpen((value) => !value)}>
                        <IconSearch size={22}/>
                    </button>
                    <button type="button" className="tgw-icon-button" ref={headerMoreRef} title="More" onClick={openHeaderMenu}>
                        <IconMore size={22}/>
                    </button>
                </div>
            </header>

            {searchOpen && (
                <div className="tgw-inchat-search">
                    <IconSearch size={18}/>
                    <input
                        autoFocus
                        value={inChatSearch}
                        placeholder="Search in this chat"
                        onChange={(event) => setInChatSearch(event.target.value)}
                        spellCheck={false}
                    />
                    <span className="tgw-inchat-search-count">{inChatSearch ? `${visiblePosts.length} found` : ''}</span>
                    <button type="button" className="tgw-icon-button" onClick={() => {setSearchOpen(false); setInChatSearch('');}} title="Close search">
                        <IconClose size={18}/>
                    </button>
                </div>
            )}

            <div className="tgw-chat-body">
                <MessageList
                    channel={channel}
                    posts={visiblePosts}
                    loading={loading}
                    loadingOlder={loadingOlder}
                    hasMoreOlder={hasMoreOlder && !inChatSearch}
                    highlightedPostId={ui.highlightedPostId}
                    onContextMenu={(event, post) => {
                        event.preventDefault();
                        actions.openContextMenu({post, x: event.clientX, y: event.clientY});
                    }}
                    onReact={(post, emojiName, coords) => {
                        if (!emojiName) {
                            actions.openReactionPicker(post, coords?.x || window.innerWidth / 2, coords?.y || window.innerHeight / 2);
                            return;
                        }
                        addReaction(post, emojiName);
                    }}
                    onToggleReaction={toggleReaction}
                    onOpenThread={(post) => actions.setUI({threadRootId: post.root_id || post.id})}
                />
                <Composer
                    channel={channel}
                    replyTo={ui.replyTo}
                    editing={ui.editing}
                    onCancelReply={() => actions.startReply(null)}
                    onCancelEdit={() => actions.startEditing(null)}
                    onSend={handleSend}
                    onSent={() => undefined}
                />
            </div>

            {menu && <Menu x={menu.x} y={menu.y} items={menu.items} align="right" onClose={() => setMenu(null)}/>}

        </section>
    );
}
