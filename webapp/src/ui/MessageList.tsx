// The chat screen message list: grouping, date separators, attachments, reactions and scrolling.

import React, {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {api} from '../mm/api';
import {emojiChar} from '../mm/emoji';
import {getBlock, getPost, getReactions, loadOlder} from '../mm/posts';
import {getCustomEmoji, getMemberCount, getMyId, getTimeFormat, getTypingUserIds} from '../mm/selectors';
import {getState, useSelector} from '../mm/store';
import type {MMChannel, MMFileInfo, MMPost, MMReaction} from '../mm/types';
import {
    colorForKey,
    displayName,
    fileKindOf,
    formatBytes,
    formatChatTime,
    formatDateSeparator,
    formatTime,
    isSameDay,
    toPlainPreview,
} from '../mm/utils';
import {useTg} from './context';
import type {ContextTarget} from './context';
import {MessageBody} from './render';
import {Avatar, IconArrowDown, IconCheck, IconCheckDouble, IconClock, IconDownload, IconEmoji, IconMore, IconReply, IconWarning} from './primitives';

const GROUP_WINDOW_MS = 5 * 60 * 1000;

export interface MessageListProps {
    channel: MMChannel;
    posts: MMPost[];
    loading: boolean;
    loadingOlder: boolean;
    hasMoreOlder: boolean;
    highlightedPostId?: string | null;
    onContextMenu: (event: React.MouseEvent, post: MMPost) => void;
    onReact: (post: MMPost, emojiName: string, coords?: {x: number; y: number}) => void;
    onToggleReaction: (post: MMPost, reaction: MMReaction) => void;
    onOpenThread: (post: MMPost) => void;
}

interface RowMeta {
    showAvatar: boolean;
    showAuthor: boolean;
    isOutgoing: boolean;
    startOfDay: boolean;
}

export function MessageList(props: MessageListProps) {
    const {channel, posts, loading, loadingOlder, hasMoreOlder, highlightedPostId, onContextMenu, onReact, onToggleReaction, onOpenThread} = props;
    const {ui, actions, timeFormat, settings, me} = useTg();
    const myId = me?.id || '';
    const listRef = useRef<HTMLDivElement>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    const [atBottom, setAtBottom] = useState(true);
    const [unseenBelow, setUnseenBelow] = useState(0);
    const previousHeight = useRef(0);
    const previousFirstId = useRef<string | null>(null);
    const lastChannelId = useRef<string>('');

    const typingIds = useSelector((state) => getTypingUserIds(state, channel.id));
    const profiles = useSelector((state) => state.entities?.users?.profiles);

    const rows = useMemo(() => groupPosts(posts, myId), [posts, myId]);

    const member = useSelector((state) => state.entities?.channels?.myMembers?.[channel.id]);
    const unreadDividerPostId = useMemo(() => {
        if (!member || !posts.length) {
            return null;
        }
        const firstUnread = posts.find((post) => post.create_at > (member.last_viewed_at || 0) && post.user_id !== myId);
        if (!firstUnread) {
            return null;
        }
        // Only show the divider for messages that are not "brand new" (older than 2 minutes).
        if (Date.now() - firstUnread.create_at < 120_000) {
            return null;
        }
        return firstUnread.id;
    }, [posts, member, myId]);

    // Scroll handling ---------------------------------------------------------------------------
    const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
        const element = listRef.current;
        if (!element) {
            return;
        }
        // `scrollTo` is missing in a few embedded webviews, so fall back to a plain scrollTop.
        if (typeof element.scrollTo === 'function') {
            element.scrollTo({top: element.scrollHeight, behavior});
        } else {
            element.scrollTop = element.scrollHeight;
        }
        setAtBottom(true);
        setUnseenBelow(0);
    }, []);

    useLayoutEffect(() => {
        const element = listRef.current;
        if (!element) {
            return;
        }
        const firstId = posts[0]?.id || null;
        const heightGrew = previousHeight.current && element.scrollHeight > previousHeight.current;

        if (lastChannelId.current !== channel.id) {
            lastChannelId.current = channel.id;
            scrollToBottom();
        } else if (previousFirstId.current && firstId !== previousFirstId.current && heightGrew) {
            // Older messages were prepended: keep the viewport anchored.
            const delta = element.scrollHeight - previousHeight.current;
            element.scrollTop += delta;
        } else if (atBottom) {
            scrollToBottom();
        } else if (posts.length) {
            setUnseenBelow((count) => count + 1);
        }

        previousHeight.current = element.scrollHeight;
        previousFirstId.current = firstId;
    }, [posts, channel.id, atBottom, scrollToBottom]);

    useEffect(() => {
        if (!highlightedPostId) {
            return;
        }
        const element = listRef.current?.querySelector(`[data-post-id="${highlightedPostId}"]`);
        if (element) {
            element.scrollIntoView({block: 'center'});
            (element as HTMLElement).classList.add('tgw-post-highlight');
            setTimeout(() => (element as HTMLElement).classList.remove('tgw-post-highlight'), 2400);
        }
    }, [highlightedPostId, posts.length]);

    const onScroll = () => {
        const element = listRef.current;
        if (!element) {
            return;
        }
        const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
        setAtBottom(distanceFromBottom < 80);
        if (distanceFromBottom < 80) {
            setUnseenBelow(0);
        }
        if (element.scrollTop < 240 && hasMoreOlder && !loadingOlder) {
            previousHeight.current = element.scrollHeight;
            loadOlder(channel.id);
        }
    };

    if (loading) {
        return (
            <div className="tgw-messages tgw-messages-loading">
                <div className="tgw-loading-pill">Loading messages…</div>
            </div>
        );
    }

    const isGroup = channel.type === 'G' || channel.type === 'O' || channel.type === 'P';

    return (
        <div className="tgw-messages-wrap">
            <div className="tgw-messages" ref={listRef} onScroll={onScroll}>
                {hasMoreOlder && (
                    <div className="tgw-load-older">
                        {loadingOlder ? 'Loading…' : <button type="button" className="tgw-link-button" onClick={() => loadOlder(channel.id)}>Load earlier messages</button>}
                    </div>
                )}
                {!posts.length && (
                    <div className="tgw-chat-intro">
                        <div className="tgw-chat-intro-avatar">
                            <Avatar name={channel.display_name || '#'} colorKey={channel.id} size={72}/>
                        </div>
                        <div className="tgw-chat-intro-title">{channel.display_name || channel.name}</div>
                        <div className="tgw-chat-intro-body">
                            {channel.purpose || (channel.type === 'D' ? 'This is the beginning of your conversation.' : 'No messages here yet. Say hello!')}
                        </div>
                    </div>
                )}
                {rows.map(({post, meta}) => (
                    <React.Fragment key={post.id}>
                        {meta.startOfDay && (
                            <div className="tgw-date-separator">
                                <span>{formatDateSeparator(post.create_at, timeFormat)}</span>
                            </div>
                        )}
                        {unreadDividerPostId === post.id && (
                            <div className="tgw-unread-divider"><span>Unread messages</span></div>
                        )}
                        <MessageRow
                            post={post}
                            meta={meta}
                            isGroup={isGroup}
                            channel={channel}
                            onContextMenu={onContextMenu}
                            onReact={onReact}
                            onToggleReaction={onToggleReaction}
                            onOpenThread={onOpenThread}
                            highlighted={highlightedPostId === post.id}
                        />
                    </React.Fragment>
                ))}
                {typingIds.length > 0 && (
                    <div className="tgw-typing">
                        {typingIds.slice(0, 3).map((id) => (profiles?.[id] ? displayName(profiles[id]) : 'Someone')).join(', ')}
                        {` ${typingIds.length === 1 ? 'is' : 'are'} typing…`}
                    </div>
                )}
                <div ref={bottomRef} className="tgw-bottom-anchor"/>
            </div>

            {!atBottom && (
                <button type="button" className="tgw-scroll-bottom" onClick={() => scrollToBottom('smooth')} title="Scroll to latest messages">
                    <IconArrowDown size={22}/>
                    {unseenBelow > 0 && <span className="tgw-scroll-bottom-count">{unseenBelow}</span>}
                </button>
            )}
        </div>
    );
}

function groupPosts(posts: MMPost[], myId: string): Array<{post: MMPost; meta: RowMeta}> {
    const rows: Array<{post: MMPost; meta: RowMeta}> = [];
    posts.forEach((post, index) => {
        const previous = posts[index - 1];
        const sameDay = previous ? isSameDay(previous.create_at, post.create_at) : false;
        const grouped = !!previous &&
            previous.user_id === post.user_id &&
            sameDay &&
            post.create_at - previous.create_at < GROUP_WINDOW_MS &&
            previous.type === '' &&
            post.type === '' &&
            !post.root_id;
        rows.push({
            post,
            meta: {
                showAvatar: !grouped,
                showAuthor: !grouped,
                isOutgoing: post.user_id === myId,
                startOfDay: !sameDay,
            },
        });
    });
    return rows;
}

interface MessageRowProps {
    post: MMPost;
    meta: RowMeta;
    isGroup: boolean;
    channel: MMChannel;
    highlighted?: boolean;
    onContextMenu: (event: React.MouseEvent, post: MMPost) => void;
    onReact: (post: MMPost, emojiName: string, coords?: {x: number; y: number}) => void;
    onToggleReaction: (post: MMPost, reaction: MMReaction) => void;
    onOpenThread: (post: MMPost) => void;
}

function MessageRow({post, meta, isGroup, channel, highlighted, onContextMenu, onReact, onToggleReaction, onOpenThread}: MessageRowProps) {
    const {timeFormat, actions, me} = useTg();
    const author = useSelector((state) => state.entities?.users?.profiles?.[post.user_id]);
    const customEmoji = useSelector(getCustomEmoji);
    const reactionBlock = useSelector(() => getBlock(channel.id));
    const reactions = useMemo(() => getReactions(reactionBlock, post.id), [reactionBlock, post.id]);
    const isSystem = !!post.type && post.type.startsWith('system_');
    const files = filesOfPost(post);
    const myId = me?.id || '';
    const mentionKeys = useMemo(() => buildMentionKeys(me), [me]);

    if (isSystem) {
        return (
            <div className="tgw-system-post" data-post-id={post.id}>
                <span>{toPlainPreview(post.message) || systemText(post)}</span>
            </div>
        );
    }

    const rootPost = post.root_id ? getPost(post.root_id) : undefined;

    return (
        <div
            className={`tgw-msg-row ${meta.isOutgoing ? 'tgw-msg-out' : 'tgw-msg-in'} ${highlighted ? 'tgw-post-highlight' : ''}`}
            data-post-id={post.id}
            onContextMenu={(event) => onContextMenu(event, post)}
        >
            <div className="tgw-msg-avatar">
                {meta.showAvatar && !meta.isOutgoing && (
                    <Avatar userId={post.user_id} name={author ? displayName(author) : ''} size={40} status="">
                    </Avatar>
                )}
            </div>
            <div className={`tgw-bubble ${meta.showAvatar ? '' : 'tgw-bubble-grouped'}`}>
                {meta.showAuthor && !meta.isOutgoing && isGroup && (
                    <div className="tgw-msg-author" style={{color: colorForKey(post.user_id)}}>{author ? displayName(author) : 'Unknown'}</div>
                )}
                {rootPost && (
                    <button
                        type="button"
                        className="tgw-msg-reply-preview"
                        onClick={() => onOpenThread(rootPost)}
                    >
                        <span className="tgw-msg-reply-author">{replyAuthorName(rootPost, myId)}</span>
                        <span className="tgw-msg-reply-text">{toPlainPreview(rootPost.message, 120) || 'Attachment'}</span>
                    </button>
                )}
                <MessageBody
                    message={post.message}
                    postId={post.id}
                    editedAt={post.edit_at}
                    mentionKeys={mentionKeys}
                    className="tgw-message-text"
                />
                {files.length > 0 && (
                    <div className="tgw-attachments">
                        {files.map((file) => (
                            <Attachment key={file.id} file={file} post={post} onOpenImage={() => actions.setUI({imageViewer: post})}/>
                        ))}
                    </div>
                )}
                <div className="tgw-msg-meta">
                    {post.edit_at > 0 && <span className="tgw-msg-edited" title={formatTime(post.edit_at, timeFormat)}>edited</span>}
                    {post.is_pinned && <span className="tgw-msg-edited">pinned</span>}
                    <span className="tgw-msg-time">{formatTime(post.create_at, timeFormat)}</span>
                    {meta.isOutgoing && (
                        <span className="tgw-msg-status">
                            {post._failed ? <IconWarning size={14}/> : post._pending ? <IconClock size={14}/> : reactions.length ? <IconCheckDouble size={16}/> : <IconCheck size={16}/>}
                        </span>
                    )}
                </div>
                {reactions.length > 0 && (
                    <div className="tgw-reactions">
                        {summariseReactions(reactions, customEmoji).map((group) => (
                            <button
                                type="button"
                                key={group.emoji_name}
                                className={`tgw-reaction ${group.mine ? 'tgw-reaction-mine' : ''}`}
                                title={group.users.join(', ')}
                                onClick={() => onToggleReaction(post, group.reaction)}
                            >
                                <ReactionEmoji name={group.emoji_name} customEmoji={customEmoji}/>
                                <span>{group.count}</span>
                            </button>
                        ))}
                    </div>
                )}
                {post.reply_count > 0 && (
                    <button type="button" className="tgw-thread-link" onClick={() => onOpenThread(post)}>
                        {post.reply_count} {post.reply_count === 1 ? 'reply' : 'replies'}
                    </button>
                )}
            </div>

            <div className="tgw-msg-toolbar">
                <button type="button" title="Add reaction" onClick={(event) => onReact(post, '', {x: event.clientX, y: event.clientY})}>
                    <IconEmoji size={18}/>
                </button>
                <button type="button" title="Reply" onClick={() => actions.startReply(post)}>
                    <IconReply size={16}/>
                </button>
                <button
                    type="button"
                    title="More"
                    onClick={(event) => onContextMenu(event, post)}
                >
                    <IconMore size={18}/>
                </button>
            </div>
        </div>
    );
}

function replyAuthorName(post: MMPost, myId: string): string {
    if (post.user_id === myId) {
        return 'You';
    }
    const state = getState();
    const user = state.entities?.users?.profiles?.[post.user_id];
    return user ? displayName(user) : 'User';
}

function systemText(post: MMPost): string {
    const props = post.props || {};
    if (props.username) {
        return `${props.username} joined`;
    }
    if (props.removedUsername) {
        return `${props.removedUsername} left`;
    }
    return 'System message';
}

function buildMentionKeys(me?: {username?: string; first_name?: string; last_name?: string; nickname?: string}) {
    if (!me) {
        return [];
    }
    const keys: Array<{key: string}> = [];
    if (me.username) {
        keys.push({key: `@${me.username}`});
    }
    [me.nickname, me.first_name, me.last_name].forEach((value) => {
        if (value && value.trim().length > 1) {
            keys.push({key: value.trim()});
        }
    });
    return keys;
}

function filesOfPost(post: MMPost): MMFileInfo[] {
    if (post.metadata?.files?.length) {
        return post.metadata.files;
    }
    const state = getState();
    const store = state.entities?.files?.files || {};
    return (post.file_ids || []).map((id) => store[id]).filter(Boolean) as MMFileInfo[];
}

function Attachment({file, post, onOpenImage}: {file: MMFileInfo; post: MMPost; onOpenImage: () => void}) {
    const kind = fileKindOf(file.mime_type || file.name);
    const url = api.fileURL(file.id);
    const thumbnail = api.fileURL(file.id, true);

    if (kind === 'image') {
        return (
            <button type="button" className="tgw-attachment-image" onClick={onOpenImage}>
                <img src={thumbnail} alt={file.name} loading="lazy" draggable={false}/>
            </button>
        );
    }
    if (kind === 'video') {
        return (
            <div className="tgw-attachment-video">
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <video src={url} controls preload="metadata"/>
            </div>
        );
    }
    if (kind === 'audio') {
        return (
            <div className="tgw-attachment-audio">
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <audio src={url} controls preload="none"/>
            </div>
        );
    }
    return (
        <a className="tgw-attachment-file" href={`${url}?download=1`} target="_blank" rel="noopener noreferrer">
            <span className={`tgw-file-icon tgw-file-${kind}`}>{file.extension ? file.extension.slice(0, 4).toUpperCase() : 'FILE'}</span>
            <span className="tgw-file-meta">
                <span className="tgw-file-name">{file.name}</span>
                <span className="tgw-file-size">{formatBytes(file.size)}</span>
            </span>
            <IconDownload size={18}/>
        </a>
    );
}

function ReactionEmoji({name, customEmoji}: {name: string; customEmoji: Record<string, {id: string}>}) {
    const custom = customEmoji?.[name];
    if (custom) {
        return <img className="tgw-reaction-emoji" src={api.customEmojiImageURL(custom.id)} alt={`:${name}:`}/>;
    }
    const char = emojiChar(name);
    return <span className="tgw-reaction-emoji">{char || `:${name}:`}</span>;
}

interface ReactionGroup {
    emoji_name: string;
    count: number;
    mine: boolean;
    users: string[];
    reaction: MMReaction;
}

function summariseReactions(reactions: MMReaction[], customEmoji: Record<string, any>): ReactionGroup[] {
    const state = getState();
    const myId = state.entities?.users?.currentUserId || '';
    const groups = new Map<string, ReactionGroup>();
    reactions.forEach((reaction) => {
        const existing = groups.get(reaction.emoji_name);
        const user = state.entities?.users?.profiles?.[reaction.user_id];
        const name = user ? displayName(user) : reaction.user_id;
        if (existing) {
            existing.count += 1;
            existing.mine = existing.mine || reaction.user_id === myId;
            existing.users.push(name);
        } else {
            groups.set(reaction.emoji_name, {
                emoji_name: reaction.emoji_name,
                count: 1,
                mine: reaction.user_id === myId,
                users: [name],
                reaction,
            });
        }
    });
    return Array.from(groups.values());
}
