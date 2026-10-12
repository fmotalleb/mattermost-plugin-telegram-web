// Chat list rows (the left column of Telegram Web).

import React, {useEffect, useState} from 'react';
import {getCachedPreview, prefetchPreview, subscribe as subscribePosts} from '../mm/posts';
import {getMyId, getStatus} from '../mm/selectors';
import type {ChatSummary} from '../mm/selectors';
import {useSelector} from '../mm/store';
import type {MMPost} from '../mm/types';
import {displayName, formatChatTime, toPlainPreview, truncate} from '../mm/utils';
import {useTg} from './context';
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
    const body = toPlainPreview(post.message) || (post.metadata?.files?.length ? 'Attachment' : '');
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
}

export function ChatRow({summary, selected, onSelect, onContextMenu, showTeamName}: ChatRowProps) {
    const {timeFormat, settings} = useTg();
    const myId = useSelector(getMyId);
    const preview = usePreview(summary.id);
    const lastPost = preview || undefined;
    const author = useSelector((state) => (lastPost && lastPost.user_id !== myId ? state.entities?.users?.profiles?.[lastPost.user_id] : undefined));
    const status = useSelector((state) => (summary.type === 'D' ? getStatus(state, summary.peerIds[0]) : undefined));
    const online = status === 'online';

    const text = previewText(lastPost, lastPost?.user_id === myId, summary.type === 'G' || summary.type === 'P' || summary.type === 'O', author ? displayName(author) : '');
    const time = formatChatTime(lastPost?.create_at || summary.lastPostAt, timeFormat);
    const unread = summary.unread > 0 || summary.mentions > 0;

    return (
        <button
            type="button"
            className={`tgw-chat-row ${selected ? 'tgw-chat-row-active' : ''} ${unread ? 'tgw-chat-row-unread' : ''}`}
            onClick={() => onSelect(summary.id)}
            onContextMenu={(event) => onContextMenu?.(event, summary)}
        >
            <Avatar
                userId={summary.avatarUserId}
                name={summary.title}
                colorKey={summary.type === 'D' ? summary.peerIds[0] : summary.id}
                size={54}
                status={status}
                showStatus={summary.type === 'D'}
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
                                <span className={lastPost?._pending ? 'tgw-preview-pending' : ''}>{text || placeholderFor(summary)}</span>
                            ) : (
                                placeholderFor(summary) || '\u00a0'
                            )
                        ) : (
                            <span className="tgw-preview-empty">No messages yet</span>
                        )}
                    </span>
                    {(summary.unread > 0 || summary.mentions > 0 || summary.manuallyUnread) && (
                        <Badge count={summary.unread} mentions={summary.mentions} muted={summary.muted}/>
                    )}
                </span>
                {showTeamName && summary.teamName && summary.type === 'O' && (
                    <span className="tgw-chat-row-team">{summary.teamName}</span>
                )}
            </span>
            {online && <span className="tgw-chat-row-online-dot"/>}
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
    return summary.subtitle || 'Channel';
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
}

export function ChatList({chats, selectedChannelId, onSelect, onContextMenu, showTeamNames, emptyTitle, emptyBody, prefetchLimit = 12}: ChatListProps) {
    // Warm up the sidebar previews for the rows the user actually looks at.
    useEffect(() => {
        chats.slice(0, prefetchLimit).forEach((chat) => {
            if (chat.lastPostAt) {
                prefetchPreview(chat.id, chat.lastPostAt);
            }
        });
    }, [chats, prefetchLimit]);

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
            {chats.map((chat, index) => (
                <React.Fragment key={chat.id}>
                    {index > 0 && <div className="tgw-list-divider"/>}
                    <ChatRow
                        summary={chat}
                        selected={chat.id === selectedChannelId}
                        onSelect={onSelect}
                        onContextMenu={onContextMenu}
                        showTeamName={showTeamNames}
                    />
                </React.Fragment>
            ))}
        </div>
    );
}

export function previewOf(message: string, limit = 60): string {
    return truncate(toPlainPreview(message), limit);
}
