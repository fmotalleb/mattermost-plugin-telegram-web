// Chat list rows (the left column of Telegram Web).

import React, {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {api} from '../mm/api';
import {reorderCategoryChannels} from '../mm/categories';
import {getBlock, getCachedPreview, isPreviewLoading, prefetchPreview, subscribe as subscribePosts} from '../mm/posts';
import {getMyId, getStatus} from '../mm/selectors';
import type {ChatSummary} from '../mm/selectors';
import {useSelector} from '../mm/store';
import type {MMPost, MMUser} from '../mm/types';
import {attachmentSummary, displayName, formatChatTime, toPlainPreview, truncate} from '../mm/utils';
import {useTg} from './context';
import {EmojiText} from './EmojiText';
import {Avatar, Badge, IconMute, IconStar} from './primitives';

function usePreview(channelId: string): {post: MMPost | null; loading: boolean} {
    const [post, setPost] = useState<MMPost | null>(() => getCachedPreview(channelId));
    const [loading, setLoading] = useState(() => isPreviewLoading(channelId));
    useEffect(() => {
        setPost(getCachedPreview(channelId));
        setLoading(isPreviewLoading(channelId));
        return subscribePosts(() => {
            const next = getCachedPreview(channelId);
            setPost((current) => (current && next && current.id === next.id && current.update_at === next.update_at ? current : next));
            setLoading(isPreviewLoading(channelId));
        });
    }, [channelId]);
    return {post, loading};
}

function previewText(post: MMPost | null, isOwn: boolean, showAuthor: boolean, author: string): string {
    if (!post) {
        return '';
    }
    const body = toPlainPreview(post.message) || attachmentSummary(post.metadata?.files);
    if (!body) {
        return '';
    }
    if (isOwn) {
        return `You: ${body}`;
    }
    if (showAuthor && author) {
        return `${author.split(' ')[0]}: ${body}`;
    }
    return body;
}

export interface ChatRowProps {
    summary: ChatSummary;
    selected: boolean;
    onSelect: (channelId: string) => void;
    onContextMenu?: (event: React.MouseEvent, summary: ChatSummary) => void;
    showTeamName?: boolean;
    /** Drag-to-reorder (category tabs): the row becomes a draggable drop target. */
    draggable?: boolean;
    dragState?: 'source' | 'over' | null;
    onDragStart?: () => void;
    onDragOver?: (event: React.DragEvent) => void;
    onDrop?: (event: React.DragEvent) => void;
    onDragEnd?: () => void;
    peerUser?: MMUser;
    peerUnavailable?: boolean;
}

export function ChatRow({summary, selected, onSelect, onContextMenu, showTeamName, draggable, dragState, onDragStart, onDragOver, onDrop, onDragEnd, peerUser: resolvedPeer, peerUnavailable}: ChatRowProps) {
    const {timeFormat, settings} = useTg();
    const myId = useSelector(getMyId);
    const {post: preview, loading: previewLoading} = usePreview(summary.id);
    const lastPost = preview || undefined;
    const author = useSelector((state) => (lastPost && lastPost.user_id !== myId ? state.entities?.users?.profiles?.[lastPost.user_id] : undefined));
    const profiles = useSelector((state) => state.entities?.users?.profiles);
    const peerUser = summary.type === 'D' ? (profiles?.[summary.peerIds[0]] || resolvedPeer) : undefined;
    const peerInactive = !!peerUser && peerUser.delete_at !== undefined && peerUser.delete_at > 0;
    const title = peerInactive ? displayName(peerUser) : peerUnavailable ? 'Unavailable account' : (summary.type === 'D' && peerUser ? displayName(peerUser) : summary.title);
    const status = useSelector((state) => (summary.type === 'D' ? getStatus(state, summary.peerIds[0]) : undefined));

    const text = previewText(lastPost, lastPost?.user_id === myId, summary.type === 'G' || summary.type === 'P' || summary.type === 'O', author ? displayName(author) : '');
    const time = formatChatTime(lastPost?.create_at || summary.lastPostAt, timeFormat);
    const unread = summary.unread > 0 || summary.mentions > 0 || summary.manuallyUnread;
    const [peekOpen, setPeekOpen] = useState(false);
    const [peekLoading, setPeekLoading] = useState(false);
    const [peekPosts, setPeekPosts] = useState<MMPost[]>([]);
    const [peekPosition, setPeekPosition] = useState({left: 0, top: 0});
    const peekDelay = useRef<ReturnType<typeof setTimeout> | null>(null);
    const peekCloseDelay = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => () => {
        if (peekDelay.current) clearTimeout(peekDelay.current);
        if (peekCloseDelay.current) clearTimeout(peekCloseDelay.current);
    }, []);

    useEffect(() => {
        if (!peekOpen || !unread) return undefined;
        let cancelled = false;
        setPeekLoading(true);
        const cachedBlock = getBlock(summary.id);
        const applyPosts = (posts: MMPost[]) => {
            const allPosts = posts
                .filter((post) => !post.delete_at && !post.root_id)
                .sort((left, right) => left.create_at - right.create_at);
            const unreadPosts = allPosts.filter((post) => post.create_at > summary.lastViewedAt);
            const messages = unreadPosts.length ? unreadPosts : allPosts;
            setPeekPosts(messages.length ? messages.slice(-5) : (preview ? [preview] : []));
        };
        if (cachedBlock?.order.length) {
            applyPosts(cachedBlock.order.map((id) => cachedBlock.posts[id]).filter(Boolean));
            setPeekLoading(false);
            return () => { cancelled = true; };
        }
        api.getPosts(summary.id, 0, 12).then((result) => {
            if (cancelled) return;
            const posts = result.order?.map((id) => result.posts[id]).filter(Boolean) || Object.values(result.posts || {});
            applyPosts(posts);
        }).catch(() => {
            if (!cancelled) setPeekPosts([]);
        }).finally(() => {
            if (!cancelled) setPeekLoading(false);
        });
        return () => { cancelled = true; };
    }, [peekOpen, unread, summary.id, summary.lastViewedAt, summary.lastPostAt, preview]);

    const openPeek = (event: React.MouseEvent<HTMLButtonElement>) => {
        if (!unread) return;
        if (peekDelay.current) clearTimeout(peekDelay.current);
        const rect = event.currentTarget.getBoundingClientRect();
        peekDelay.current = setTimeout(() => {
            setPeekPosition({left: Math.max(12, Math.min(rect.right + 10, window.innerWidth - 330)), top: Math.max(12, Math.min(rect.top, window.innerHeight - 250))});
            setPeekOpen(true);
        }, 350);
    };
    const closePeekSoon = () => {
        if (peekDelay.current) clearTimeout(peekDelay.current);
        peekCloseDelay.current = setTimeout(() => setPeekOpen(false), 160);
    };
    const keepPeekOpen = () => {
        if (peekCloseDelay.current) clearTimeout(peekCloseDelay.current);
    };

    return (
        <button
            type="button"
            draggable={draggable}
            className={`tgw-chat-row ${selected ? 'tgw-chat-row-active' : ''} ${unread ? 'tgw-chat-row-unread' : ''} ${peerInactive || peerUnavailable ? 'tgw-chat-row-inactive-peer' : ''} ${dragState === 'source' ? 'tgw-chat-row-dragging' : ''} ${dragState === 'over' ? 'tgw-chat-row-dragover' : ''}`}
            onMouseEnter={openPeek}
            onMouseLeave={closePeekSoon}
            onClick={() => onSelect(summary.id)}
            onContextMenu={(event) => onContextMenu?.(event, summary)}
            onDragStart={() => onDragStart?.()}
            onDragOver={(event) => onDragOver?.(event)}
            onDrop={(event) => onDrop?.(event)}
            onDragEnd={() => onDragEnd?.()}
        >
            <Avatar
                userId={summary.avatarUserId || peerUser?.id || summary.peerIds[0]}
                name={title}
                colorKey={summary.type === 'D' ? summary.peerIds[0] : summary.id}
                imageUrl={summary.avatarUrl}
                size={54}
                status={status}
                showStatus={summary.type === 'D'}
                savedMessages={summary.title === 'Saved Messages'}
            />
            <span className="tgw-chat-row-body">
                <span className="tgw-chat-row-top">
                    <span className="tgw-chat-row-title">
                        {summary.muted && <IconMute size={16} className="tgw-chat-row-mute"/>}
                        {title}
                        {peerInactive && <span className="tgw-chat-row-account-state">Deactivated</span>}
                        {peerUnavailable && !peerUser && <span className="tgw-chat-row-account-state">Unavailable</span>}
                    </span>
                    <span className="tgw-chat-row-meta">
                        {summary.isFavorite && <IconStar size={14} className="tgw-chat-row-star"/>}
                        <span className="tgw-chat-row-time">{time}</span>
                    </span>
                </span>
                <span className="tgw-chat-row-bottom">
                    <span className="tgw-chat-row-preview">
                        {summary.lastPostAt || text ? (
                            settings.showPreviews ? (
                                <span className={lastPost?._pending ? 'tgw-preview-pending' : ''}>{text ? <EmojiText text={text}/> : (previewLoading ? 'Loading…' : placeholderFor(summary))}</span>
                            ) : (
                                placeholderFor(summary) || '\u00a0'
                            )
                        ) : (
                            <span className="tgw-preview-empty">No messages yet</span>
                        )}
                    </span>
                    {(summary.unread > 0 || summary.mentions > 0 || summary.manuallyUnread) && (
                        settings.quietUnreadCounts && summary.type !== 'D' && !summary.mentions
                            ? <span className="tgw-badge tgw-badge-dot" aria-label="Unread messages"/>
                            : <Badge count={settings.quietUnreadCounts && summary.type !== 'D' ? summary.mentions : summary.unread} mentions={summary.mentions} muted={summary.muted}/>
                    )}
                </span>
                {showTeamName && summary.teamName && summary.type === 'O' && (
                    <span className="tgw-chat-row-team">{summary.teamName}</span>
                )}
            </span>
            {peekOpen && unread && createPortal(
                <div className="tgw-unread-peek" role="tooltip" aria-label={`Unread messages in ${summary.title}`} style={{left: `${peekPosition.left}px`, top: `${peekPosition.top}px`}} onMouseEnter={keepPeekOpen} onMouseLeave={closePeekSoon}>
                    <div className="tgw-unread-peek-title">Unread messages</div>
                    {peekLoading && <div className="tgw-unread-peek-empty">Loading messages…</div>}
                    {!peekLoading && peekPosts.length === 0 && <div className="tgw-unread-peek-empty">No message preview available</div>}
                    {!peekLoading && peekPosts.map((post) => {
                        const sender = profiles?.[post.user_id];
                        const body = toPlainPreview(post.message || '') || attachmentSummary(post.metadata?.files) || 'Message';
                        return <div className="tgw-unread-peek-message" key={post.id}><span className="tgw-unread-peek-sender">{post.user_id === myId ? 'You' : (sender ? displayName(sender).split(' ')[0] : 'Someone')}</span><span className="tgw-unread-peek-text" dir="auto"><EmojiText text={truncate(body, 100)}/></span></div>;
                    })}
                </div>,
                document.querySelector('.tgw-root') || document.body,
            )}
        </button>
    );
}

function placeholderFor(summary: ChatSummary): string {
    if (summary.type === 'D') {
        return summary.subtitle || 'Direct message';
    }
    if (summary.type === 'G') {
        return `${summary.memberCount} members`;
    }
    return summary.subtitle || 'Group';
}

export interface ChatListProps {
    chats: ChatSummary[];
    selectedChannelId: string;
    onSelect: (channelId: string) => void;
    onContextMenu?: (event: React.MouseEvent, summary: ChatSummary) => void;
    showTeamNames?: boolean;
    emptyTitle?: string;
    emptyBody?: string;
    prefetchLimit?: number;
    /** Split the All tab into unread and remaining chats. */
    groupAllChats?: boolean;
    sectionTitle?: string;
    onMarkSectionRead?: (chats: ChatSummary[]) => void;
    /** When set, rows can be dragged to reorder this Mattermost category (Mattermost-style). */
    reorderable?: {categoryId: string} | null;
}

export function ChatList({chats, selectedChannelId, onSelect, onContextMenu, showTeamNames, emptyTitle, emptyBody, prefetchLimit = Number.POSITIVE_INFINITY, groupAllChats = false, sectionTitle, onMarkSectionRead, reorderable = null}: ChatListProps) {
    const {actions} = useTg();
    const [dragId, setDragId] = useState<string | null>(null);
    const [overId, setOverId] = useState<string | null>(null);
    const profiles = useSelector((state) => state.entities?.users?.profiles || {});
    const [fetchedPeers, setFetchedPeers] = useState<Record<string, MMUser>>({});
    const [unavailablePeers, setUnavailablePeers] = useState<Record<string, boolean>>({});
    const requestedPeers = useRef(new Set<string>());
    const isUnread = (chat: ChatSummary) => chat.unread > 0 || chat.mentions > 0 || chat.manuallyUnread;
    const allSections = [
        {key: 'unread', label: 'Unread', chats: chats.filter(isUnread)},
        {key: 'chats', label: 'Chats', chats: chats.filter((chat) => !isUnread(chat))},
    ].filter((section) => section.chats.length > 0);

    // Warm up the sidebar previews for the rows the user actually looks at.
    useEffect(() => {
        chats.slice(0, prefetchLimit).forEach((chat) => {
            if (chat.lastPostAt) {
                prefetchPreview(chat.id, chat.lastPostAt);
            }
        });
    }, [chats, prefetchLimit]);

    // DM channels can remain in the sidebar after their peer is deactivated or omitted from the
    // host's current profile cache. Resolve those profiles in batches so old conversations keep
    // their proper name and avatar instead of all looking like an anonymous "Direct message".
    useEffect(() => {
        const missing = Array.from(new Set(chats
            .filter((chat) => chat.type === 'D')
            .map((chat) => chat.peerIds[0])
            .filter((id): id is string => !!id && !profiles[id] && !fetchedPeers[id] && !requestedPeers.current.has(id))));
        if (!missing.length) {
            return;
        }
        missing.forEach((id) => requestedPeers.current.add(id));
        let cancelled = false;
        Promise.all(Array.from({length: Math.ceil(missing.length / 100)}, (_, index) =>
            api.getUsersByIds(missing.slice(index * 100, (index + 1) * 100)),
        )).then((batches) => {
            if (cancelled) return;
            const users = batches.flat();
            const found = new Set(users.map((user) => user.id));
            setFetchedPeers((current) => ({...current, ...Object.fromEntries(users.map((user) => [user.id, user]))}));
            setUnavailablePeers((current) => ({...current, ...Object.fromEntries(missing.filter((id) => !found.has(id)).map((id) => [id, true]))}));
        }).catch(() => undefined);
        return () => { cancelled = true; };
    }, [chats, profiles, fetchedPeers]);

    // Mattermost-style placement: dropping on the upper half of a row inserts the dragged chat
    // before it, the lower half after it (in jsdom-sized rows this degrades to "after").
    const dropChat = (targetId: string, clientY?: number, rect?: DOMRect) => {
        const sourceId = dragId;
        setDragId(null);
        setOverId(null);
        if (!sourceId || sourceId === targetId || !reorderable) {
            return;
        }
        const before = typeof clientY === 'number' && !!rect && clientY < rect.top + rect.height / 2;
        const next = chats.map((chat) => chat.id).filter((id) => id !== sourceId);
        const targetIndex = next.indexOf(targetId);
        next.splice(before ? targetIndex : targetIndex + 1, 0, sourceId);
        reorderCategoryChannels(reorderable.categoryId, next)
            .then(() => actions.refreshChats())
            .catch(() => actions.toast('Could not reorder chats', 'error'));
    };

    if (!chats.length) {
        return (
            <div className="tgw-empty-list">
                <div className="tgw-empty-title">{emptyTitle || 'No chats yet'}</div>
                {emptyBody && <div className="tgw-empty-body">{emptyBody}</div>}
            </div>
        );
    }

    const renderChat = (chat: ChatSummary) => (
        <ChatRow
            summary={chat}
            peerUser={chat.peerIds[0] ? fetchedPeers[chat.peerIds[0]] : undefined}
            peerUnavailable={!!(chat.peerIds[0] && unavailablePeers[chat.peerIds[0]])}
            selected={chat.id === selectedChannelId}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
            showTeamName={showTeamNames}
            draggable={!!reorderable}
            dragState={dragId === chat.id ? 'source' : (dragId && overId === chat.id ? 'over' : null)}
            onDragStart={() => setDragId(chat.id)}
            onDragOver={(event) => {
                if (dragId && dragId !== chat.id) {
                    event.preventDefault();
                    setOverId(chat.id);
                }
            }}
            onDrop={(event) => {
                event.preventDefault();
                dropChat(chat.id, event.clientY, event.currentTarget.getBoundingClientRect());
            }}
            onDragEnd={() => {
                setDragId(null);
                setOverId(null);
            }}
        />
    );

    return (
        <div className="tgw-chat-list" role="list">
            {sectionTitle && <div className="tgw-section-heading"><span className="tgw-section-title">{sectionTitle}</span><button type="button" onClick={() => onMarkSectionRead?.(chats)}>Mark all as read</button></div>}
            {groupAllChats ? allSections.map((section) => (
                <React.Fragment key={section.key}>
                    <div className="tgw-section-heading"><span className="tgw-section-title">{section.label}</span><button type="button" onClick={() => onMarkSectionRead?.(section.chats)}>Mark all as read</button></div>
                    {section.chats.map((chat, index) => <React.Fragment key={`${section.key}:${chat.id}`}>{index > 0 && <div className="tgw-list-divider"/>}{renderChat(chat)}</React.Fragment>)}
                </React.Fragment>
            )) : chats.map((chat, index) => (
                <React.Fragment key={chat.id}>
                    {index > 0 && <div className="tgw-list-divider"/>}
                    {renderChat(chat)}
                </React.Fragment>
            ))}
        </div>
    );
}

export function previewOf(message: string, limit = 60): string {
    return truncate(toPlainPreview(message), limit);
}
