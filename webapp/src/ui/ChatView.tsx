// The chat screen: header, message list, composer and the thread side panel.

import React, {useCallback, useEffect, useState} from 'react';
import {api} from '../mm/api';
import {setChannelFavorite} from '../mm/favorites';
import {addOptimistic, getBlock, getReactions, loadChannel, markFailed, receivePost, receiveReaction, useChannelPosts} from '../mm/posts';
import {getChatSummary, getTypingUserIds} from '../mm/selectors';
import {useSelector} from '../mm/store';
import type {MMChannel, MMFileInfo, MMPost, MMReaction, MMUser} from '../mm/types';
import {channelMemberIds, copyToClipboard, displayName, initialsFor, memberCountLabel, statusLabel, toPlainPreview, truncate} from '../mm/utils';
import {Composer} from './Composer';
import {useTg} from './context';
import {MessageList} from './MessageList';
import {Menu, menuPositionFromElement} from './menu';
import type {MenuEntry} from './menu';
import {Avatar, IconBack, IconClose, IconFile, IconLink, IconMore, IconSearch, IconStar, IconUsers, IconCheck} from './primitives';

const IN_CHAT_SEARCH_PAGE_SIZE = 100;

function minimalSummary(channel: MMChannel, peerId?: string, peer?: MMUser) {
    const title = channel.type === 'D' ? (peer ? displayName(peer) : 'Direct message') : (channel.display_name || channel.name || 'Conversation');
    return {
        id: channel.id,
        channel,
        type: channel.type,
        title,
        subtitle: '',
        avatarUserId: channel.type === 'D' ? peerId : undefined,
        initials: initialsFor(title),
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
        peerIds: peerId ? [peerId] : [],
    };
}

export function ChatView() {
    const {ui, actions, timeFormat, me, isMobile, channel} = useTg();
    const channelId = ui.selectedChannelId;
    const storeSummary = useSelector((state) => (channelId ? getChatSummary(state, channelId) : undefined));
    const profiles = useSelector((state) => state.entities?.users?.profiles);
    const peerId = channel?.type === 'D' ? channelMemberIds(channel).find((id) => id !== me?.id) : undefined;
    const [fetchedPeer, setFetchedPeer] = useState<MMUser | undefined>();
    useEffect(() => {
        if (!peerId || profiles?.[peerId]) {
            return undefined;
        }
        let cancelled = false;
        api.getUsersByIds([peerId]).then((users) => {
            if (!cancelled) {
                setFetchedPeer(users?.[0]);
            }
        }).catch(() => undefined);
        return () => { cancelled = true; };
    }, [peerId, profiles]);
    const peer = peerId ? profiles?.[peerId] || (fetchedPeer?.id === peerId ? fetchedPeer : undefined) : undefined;
    const baseSummary = storeSummary || (channel ? minimalSummary(channel, peerId, peer) : undefined);
    const summary = baseSummary && channel?.type === 'D' && peerId ? {
        ...baseSummary,
        title: peer ? displayName(peer) : 'Direct message',
        avatarUserId: peerId,
        peerIds: [peerId],
    } : baseSummary;
    const {posts, loading, loadingOlder, hasMoreOlder} = useChannelPosts(channelId);
    const typingIds = useSelector((state) => (channelId ? getTypingUserIds(state, channelId) : []));
    const teamName = useSelector((state) => (channel ? state.entities?.teams?.teams?.[channel.team_id]?.name : ''));
    const [inChatSearch, setInChatSearch] = useState('');
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchHits, setSearchHits] = useState<MMPost[]>([]);
    const [searchLoading, setSearchLoading] = useState(false);
    const [selectedSearchId, setSelectedSearchId] = useState<string | null>(null);
    const [menu, setMenu] = useState<{x: number; y: number; items: MenuEntry[]} | null>(null);
    const headerMoreRef = React.useRef<HTMLButtonElement>(null);

    useEffect(() => {
        setInChatSearch('');
        setSearchOpen(false);
        setSearchHits([]);
        setSearchLoading(false);
        setSelectedSearchId(null);
    }, [channelId]);

    useEffect(() => {
        if (channelId) {
            loadChannel(channelId);
            api.viewChannel(channelId).catch(() => undefined);
        }
    }, [channelId]);

    // Mattermost's indexed post search can be capped. Prefer the plugin endpoint that walks the
    // complete retained history; installations without the server component fall back to walking
    // the channel's public `before` cursor directly.
    useEffect(() => {
        const term = inChatSearch.trim();
        if (!term || !channelId) {
            setSearchHits([]);
            setSearchLoading(false);
            setSelectedSearchId(null);
            return undefined;
        }
        let cancelled = false;
        setSearchLoading(true);
        setSearchHits([]);
        setSelectedSearchId(null);
        const timer = setTimeout(() => {
            const publish = (hits: MMPost[]) => {
                hits.sort((left, right) => right.create_at - left.create_at);
                setSearchHits(hits.slice());
                setSelectedSearchId((current) => current || hits[0]?.id || null);
            };
            const loadEntireHistory = async () => {
                const hits: MMPost[] = [];
                const seenPostIds = new Set<string>();
                let beforePostId = '';
                while (!cancelled) {
                    const data = beforePostId
                        ? await api.getPostsBefore(channelId, beforePostId, IN_CHAT_SEARCH_PAGE_SIZE)
                        : await api.getPosts(channelId, 0, IN_CHAT_SEARCH_PAGE_SIZE);
                    if (cancelled) {
                        return;
                    }
                    const ids = data.order || [];
                    if (!ids.length) {
                        break;
                    }
                    const pagePosts = ids.map((id) => data.posts[id]).filter(Boolean) as MMPost[];
                    const oldest = pagePosts.reduce<MMPost | undefined>((oldestPost, post) => {
                        if (!oldestPost || post.create_at < oldestPost.create_at) {
                            return post;
                        }
                        return oldestPost;
                    }, undefined);
                    // A repeated cursor page would otherwise loop forever if a legacy server
                    // ignores `before`. Keep the first response but stop once it adds nothing.
                    let foundNewPost = false;
                    pagePosts.forEach((post) => {
                        if (seenPostIds.has(post.id)) {
                            return;
                        }
                        foundNewPost = true;
                        seenPostIds.add(post.id);
                        if (!post.delete_at && (post.message || '').toLowerCase().includes(term.toLowerCase())) {
                            hits.push(post);
                        }
                    });
                    publish(hits);
                    if (!foundNewPost || !oldest || oldest.id === beforePostId) {
                        break;
                    }
                    beforePostId = oldest.id;
                }
            };
            const searchChannel = async () => {
                try {
                    const data = await api.searchChannelHistory(channelId, term);
                    if (cancelled) {
                        return;
                    }
                    if (!Array.isArray(data.order) || !data.posts) {
                        throw new Error('invalid channel search response');
                    }
                    publish((data.order || []).map((id) => data.posts[id]).filter((post): post is MMPost => Boolean(post)));
                } catch {
                    // A plugin server is optional. Its 404 (or an older plugin version) should
                    // still leave deep chat search working through Mattermost's public API.
                    try {
                        await loadEntireHistory();
                    } catch {
                        setSearchHits([]);
                        setSelectedSearchId(null);
                    }
                } finally {
                    if (!cancelled) {
                        setSearchLoading(false);
                    }
                }
            };
            searchChannel();
        }, 250);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [inChatSearch, channelId]);

    const selectedSearchIndex = searchHits.findIndex((post) => post.id === selectedSearchId);
    const selectSearchResult = useCallback((index: number) => {
        const post = searchHits[index];
        if (!post) {
            return;
        }
        // Search responses contain the complete post, so ingest it before jumping. This avoids
        // another round trip for old hits and lets MessageList scroll/highlight it immediately.
        receivePost(post);
        setSelectedSearchId(post.id);
        actions.setUI({highlightedPostId: post.id});
    }, [searchHits, actions]);

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
            // Rethrow so the composer can restore the draft; it also owns the toast.
            throw error;
        }
    }, [channel, me]);

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
            {key: 'info', label: channel.type === 'D' ? 'Contact info' : 'Group info', icon: <IconUsers size={18}/>, onClick: () => actions.setUI({infoOpen: true})},
            {key: 'search', label: 'Search in chat', icon: <IconSearch size={18}/>, onClick: () => setSearchOpen(true)},
            {key: 'files', label: ui.filesOpen ? 'Hide shared files' : 'Shared files', icon: <IconFile size={18}/>, onClick: () => actions.setUI({filesOpen: !ui.filesOpen})},
            {
                key: 'favorite',
                label: summary.isFavorite ? 'Remove from favorites' : 'Add to favorites',
                icon: <IconStar size={16}/>,
                onClick: () => {
                    setChannelFavorite(channel.id, !summary.isFavorite).catch(() => {
                        actions.toast('Could not change favorites', 'error');
                    });
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
                label: 'Copy group link',
                icon: <IconLink size={16}/>,
                onClick: () => {
                    const basename = (window as any).basename || '';
                    const path = channel.type === 'D' || channel.type === 'G' ? `messages/${channel.name}` : `channels/${channel.name}`;
                    const url = `${window.location.origin}${basename}/${teamName ? `${teamName}/` : ''}${path}`;
                    copyToClipboard(url).then(() => actions.toast('Group link copied', 'success'));
                },
            },
            {
                key: 'leave',
                label: channel.type === 'D' ? 'Close conversation' : 'Leave group',
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
                    <div className="tgw-empty-chat-body">Your Mattermost groups, direct messages and custom folders are all here.</div>
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
                        profile={peer}
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
                    <button
                        type="button"
                        className={`tgw-icon-button ${ui.filesOpen ? 'tgw-icon-button-active' : ''}`}
                        title="Shared files"
                        onClick={() => actions.setUI({filesOpen: !ui.filesOpen})}
                    >
                        <IconFile size={20}/>
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
                        onKeyDown={(event) => {
                            if (event.key === 'ArrowUp' && selectedSearchIndex > 0) {
                                event.preventDefault();
                                selectSearchResult(selectedSearchIndex - 1);
                            } else if ((event.key === 'ArrowDown' || event.key === 'Enter') && selectedSearchIndex < searchHits.length - 1) {
                                event.preventDefault();
                                selectSearchResult(Math.max(0, selectedSearchIndex + 1));
                            }
                        }}
                        spellCheck={false}
                    />
                    <span className="tgw-inchat-search-count">{inChatSearch ? (searchLoading ? 'Searching…' : `${searchHits.length} found`) : ''}</span>
                    {searchHits.length > 0 && (
                        <span className="tgw-inchat-search-nav">
                            <button type="button" className="tgw-icon-button" title="Previous result" disabled={selectedSearchIndex <= 0} onClick={() => selectSearchResult(selectedSearchIndex - 1)}>‹</button>
                            <span>{selectedSearchIndex + 1}/{searchHits.length}</span>
                            <button type="button" className="tgw-icon-button" title="Next result" disabled={selectedSearchIndex < 0 || selectedSearchIndex >= searchHits.length - 1} onClick={() => selectSearchResult(selectedSearchIndex + 1)}>›</button>
                        </span>
                    )}
                    <button type="button" className="tgw-icon-button" onClick={() => {setSearchOpen(false); setInChatSearch('');}} title="Close search">
                        <IconClose size={18}/>
                    </button>
                </div>
            )}

            {searchOpen && inChatSearch.trim() && (
                <div className="tgw-inchat-search-results" role="listbox" aria-label="Search results">
                    {!searchLoading && !searchHits.length && <div className="tgw-inchat-search-empty">No messages found</div>}
                    {searchHits.map((post, index) => (
                        <button
                            key={post.id}
                            type="button"
                            role="option"
                            aria-selected={post.id === selectedSearchId}
                            className={`tgw-inchat-search-hit ${post.id === selectedSearchId ? 'tgw-inchat-search-hit-active' : ''}`}
                            onClick={() => selectSearchResult(index)}
                        >
                            <span className="tgw-inchat-search-hit-top">{profiles?.[post.user_id] ? displayName(profiles[post.user_id]) : 'Message'}</span>
                            <span className="tgw-inchat-search-hit-text">{truncate(toPlainPreview(post.message || ''), 110)}</span>
                        </button>
                    ))}
                </div>
            )}

            <div className="tgw-chat-body">
                <MessageList
                    channel={channel}
                    posts={posts}
                    loading={loading}
                    loadingOlder={loadingOlder}
                    hasMoreOlder={hasMoreOlder}
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
