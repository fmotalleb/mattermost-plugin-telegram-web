// Chat list rows (the left column of Telegram Web).

import React, {useEffect, useState} from 'react';
import {reorderCategoryChannels} from '../mm/categories';
import {getCachedPreview, prefetchPreview, subscribe as subscribePosts} from '../mm/posts';
import {getMyId, getStatus} from '../mm/selectors';
import type {ChatSummary} from '../mm/selectors';
import {useSelector} from '../mm/store';
import type {MMPost} from '../mm/types';
import {attachmentSummary, displayName, formatChatTime, toPlainPreview, truncate} from '../mm/utils';
import {useTg} from './context';
import {EmojiText} from './EmojiText';
import {Avatar, Badge, IconMute, IconStar} from './primitives';

function usePreview(channelId: string): MMPost | null {
    const [post, setPost] = useState<MMPost | null>(() => getCachedPreview(channelId));
    useEffect(() => {
        setPost(getCachedPreview(channelId));
        return subscribePosts(() => {
            const next = getCachedPreview(channelId);
            setPost((current) => (current && next && current.id === next.id && current.update_at === next.update_at ? current : next));
        });
    }, [channelId]);
    return post;
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
}

export function ChatRow({summary, selected, onSelect, onContextMenu, showTeamName, draggable, dragState, onDragStart, onDragOver, onDrop, onDragEnd}: ChatRowProps) {
    const {timeFormat, settings} = useTg();
    const myId = useSelector(getMyId);
    const preview = usePreview(summary.id);
    const lastPost = preview || undefined;
    const author = useSelector((state) => (lastPost && lastPost.user_id !== myId ? state.entities?.users?.profiles?.[lastPost.user_id] : undefined));
    const status = useSelector((state) => (summary.type === 'D' ? getStatus(state, summary.peerIds[0]) : undefined));

    const text = previewText(lastPost, lastPost?.user_id === myId, summary.type === 'G' || summary.type === 'P' || summary.type === 'O', author ? displayName(author) : '');
    const time = formatChatTime(lastPost?.create_at || summary.lastPostAt, timeFormat);
    const unread = summary.unread > 0 || summary.mentions > 0;

    return (
        <button
            type="button"
            draggable={draggable}
            className={`tgw-chat-row ${selected ? 'tgw-chat-row-active' : ''} ${unread ? 'tgw-chat-row-unread' : ''} ${dragState === 'source' ? 'tgw-chat-row-dragging' : ''} ${dragState === 'over' ? 'tgw-chat-row-dragover' : ''}`}
            onClick={() => onSelect(summary.id)}
            onContextMenu={(event) => onContextMenu?.(event, summary)}
            onDragStart={() => onDragStart?.()}
            onDragOver={(event) => onDragOver?.(event)}
            onDrop={(event) => onDrop?.(event)}
            onDragEnd={() => onDragEnd?.()}
        >
            <Avatar
                userId={summary.avatarUserId}
                name={summary.title}
                colorKey={summary.type === 'D' ? summary.peerIds[0] : summary.id}
                size={54}
                status={status}
                showStatus={summary.type === 'D'}
                savedMessages={summary.title === 'Saved Messages'}
            />
            <span className="tgw-chat-row-body">
                <span className="tgw-chat-row-top">
                    <span className="tgw-chat-row-title">
                        {summary.muted && <IconMute size={16} className="tgw-chat-row-mute"/>}
                        {summary.title}
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
                                <span className={lastPost?._pending ? 'tgw-preview-pending' : ''}>{text ? <EmojiText text={text}/> : placeholderFor(summary)}</span>
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
    /** Show favorite chats as the pinned section of the All tab. */
    groupFavorites?: boolean;
    sectionTitle?: string;
    onMarkSectionRead?: (chats: ChatSummary[]) => void;
    /** When set, rows can be dragged to reorder this Mattermost category (Mattermost-style). */
    reorderable?: {categoryId: string} | null;
}

export function ChatList({chats, selectedChannelId, onSelect, onContextMenu, showTeamNames, emptyTitle, emptyBody, prefetchLimit = 12, groupFavorites = false, sectionTitle, onMarkSectionRead, reorderable = null}: ChatListProps) {
    const {actions} = useTg();
    const [dragId, setDragId] = useState<string | null>(null);
    const [overId, setOverId] = useState<string | null>(null);
    const sectionKey = (chat: ChatSummary) => chat.isFavorite ? 'favorites' : chat.lastPostAt ? 'active' : 'other';
    const sectionLabel = (chat: ChatSummary) => chat.isFavorite ? 'Favorites' : chat.lastPostAt ? 'Chats' : 'Other chats';
    const sectionChats = (chat: ChatSummary) => chats.filter((item) => sectionKey(item) === sectionKey(chat));

    // Warm up the sidebar previews for the rows the user actually looks at.
    useEffect(() => {
        chats.slice(0, prefetchLimit).forEach((chat) => {
            if (chat.lastPostAt) {
                prefetchPreview(chat.id, chat.lastPostAt);
            }
        });
    }, [chats, prefetchLimit]);

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

    return (
        <div className="tgw-chat-list" role="list">
            {sectionTitle && <div className="tgw-section-heading"><span className="tgw-section-title">{sectionTitle}</span><button type="button" onClick={() => onMarkSectionRead?.(chats)}>Mark all as read</button></div>}
            {chats.map((chat, index) => (
                <React.Fragment key={chat.id}>
                    {groupFavorites && (index === 0 || sectionKey(chats[index - 1]) !== sectionKey(chat)) && <div className="tgw-section-heading"><span className="tgw-section-title">{sectionLabel(chat)}</span><button type="button" onClick={() => onMarkSectionRead?.(sectionChats(chat))}>Mark all as read</button></div>}
                    {index > 0 && (!groupFavorites || sectionKey(chats[index - 1]) === sectionKey(chat)) && <div className="tgw-list-divider"/>}
                    <ChatRow
                        summary={chat}
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
                </React.Fragment>
            ))}
        </div>
    );
}

export function previewOf(message: string, limit = 60): string {
    return truncate(toPlainPreview(message), limit);
}
