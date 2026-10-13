// Thread side panel: replies of a root post (Mattermost collapsed reply threads).
//
// The thread is merged from three sources: the plugin's own post cache (what the chat view shows,
// and the only place our own just-sent replies exist before the host app syncs them), the host
// store, and a REST seed for threads neither side has loaded yet.

import React, {useEffect, useMemo, useState} from 'react';
import {api} from '../mm/api';
import {getBlock, receivePost, useChannelPosts} from '../mm/posts';
import {useSelector} from '../mm/store';
import type {MMChannel, MMPost} from '../mm/types';
import {displayName, formatTime, toPlainPreview} from '../mm/utils';
import {useTg} from './context';
import {Attachment, filesOfPost} from './MessageList';
import {MessageBody} from './render';
import {Avatar, IconClose, IconSend} from './primitives';

export interface ThreadPanelProps {
    rootId: string;
    channel: MMChannel;
    onClose: () => void;
}

export function ThreadPanel({rootId, channel, onClose}: ThreadPanelProps) {
    const {me, actions, timeFormat} = useTg();
    const posts = useSelector((state) => state.entities?.posts?.posts || {});
    const replyIds = useSelector((state) => state.entities?.posts?.postsInThread?.[rootId] as string[] | undefined);
    const profiles = useSelector((state) => state.entities?.users?.profiles);
    const {posts: cachePosts} = useChannelPosts(channel.id);
    const [seeded, setSeeded] = useState<MMPost[]>([]);
    const [optimistic, setOptimistic] = useState<MMPost[]>([]);
    const [reply, setReply] = useState('');
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        const cached = getBlock(channel.id);
        const known = (replyIds && replyIds.length > 0) ||
            (cached ? Object.values(cached.posts).some((post) => post.root_id === rootId) : false);
        if (known) {
            return;
        }
        setLoading(true);
        api.getPostThread(rootId)
            .then((result) => {
                const list: MMPost[] = (result?.order || []).map((id: string) => result.posts[id]).filter(Boolean);
                setSeeded(list.filter((post: MMPost) => post.delete_at === 0));
            })
            .catch(() => setSeeded([]))
            .then(() => setLoading(false));
    }, [rootId, replyIds, channel.id]);

    const thread = useMemo(() => {
        const byId = new Map<string, MMPost>();
        const add = (post?: MMPost | null) => {
            if (post && post.delete_at === 0 && (post.id === rootId || post.root_id === rootId)) {
                byId.set(post.id, post);
            }
        };
        cachePosts.forEach(add);
        add(posts[rootId]);
        (replyIds || []).forEach((id) => add(posts[id]));
        seeded.forEach(add);
        const merged = Array.from(byId.values());
        // Drop optimistic copies that the server has already confirmed.
        const confirmedPendingIds = new Set(merged.map((post) => post.pending_post_id).filter(Boolean));
        const withoutConfirmed = optimistic.filter((post) => !post.pending_post_id || !confirmedPendingIds.has(post.pending_post_id));
        return merged.concat(withoutConfirmed).sort((a, b) => a.create_at - b.create_at);
    }, [cachePosts, posts, replyIds, seeded, optimistic, rootId]);

    const send = async () => {
        const message = reply.trim();
        if (!message) {
            return;
        }
        setReply('');
        const pendingId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const draft: MMPost = {
            id: `pending-${pendingId}`,
            create_at: Date.now(),
            update_at: Date.now(),
            edit_at: 0,
            delete_at: 0,
            is_pinned: false,
            user_id: me?.id || '',
            channel_id: channel.id,
            root_id: rootId,
            original_id: '',
            message,
            type: '',
            props: {},
            pending_post_id: pendingId,
            _pending: true,
        };
        setOptimistic((current) => [...current, draft]);
        try {
            const post = await api.createPost({channel_id: channel.id, message, root_id: rootId, pending_post_id: pendingId});
            setOptimistic((current) => current.filter((item) => item.id !== draft.id));
            if (post && !replyIds) {
                setSeeded((current) => [...current, post]);
            }
        } catch (error: any) {
            setOptimistic((current) => current.map((item) => (item.id === draft.id ? {...item, _pending: false, _failed: true} : item)));
            actions.toast(error?.message || 'Reply not sent', 'error');
        }
    };

    // Close the thread and flash the message in the chat view. Posts that scrolled out of the
    // cached page are fetched first, otherwise the list has nothing to scroll to.
    const goToMessage = (post: MMPost) => {
        actions.setUI({threadRootId: null, highlightedPostId: post.id});
        if (!getBlock(channel.id)?.posts[post.id]) {
            api.getPost(post.id).then((loaded) => receivePost(loaded)).catch(() => undefined);
        }
    };

    return (
        <aside className="tgw-thread-panel">
            <header className="tgw-info-header">
                <span className="tgw-info-title">Thread</span>
                <button type="button" className="tgw-icon-button" onClick={onClose} title="Close">
                    <IconClose size={20}/>
                </button>
            </header>
            <div className="tgw-thread-body">
                {loading && <div className="tgw-loading-pill">Loading thread…</div>}
                {!loading && thread.length === 0 && <div className="tgw-empty-list"><div className="tgw-empty-title">No replies yet</div></div>}
                {thread.map((post, index) => {
                    const author = profiles?.[post.user_id];
                    const isRoot = index === 0;
                    const files = filesOfPost(post);
                    return (
                        <div key={post.id} className={`tgw-thread-post ${isRoot ? 'tgw-thread-root' : ''}`}>
                            <Avatar userId={post.user_id} name={author ? displayName(author) : ''} size={36}/>
                            <div className="tgw-thread-post-body">
                                <div className="tgw-thread-post-head">
                                    <span className="tgw-thread-author">{author ? displayName(author) : 'User'}</span>
                                    <span className="tgw-thread-time">{formatTime(post.create_at, timeFormat)}</span>
                                    {post._failed && <span className="tgw-thread-failed">failed</span>}
                                    <button type="button" className="tgw-thread-goto" onClick={() => goToMessage(post)}>Go to message</button>
                                </div>
                                {post.message ? <MessageBody message={post.message} postId={post.id} editedAt={post.edit_at}/> : <span className="tgw-thread-empty">Attachment</span>}
                                {files.length > 0 && (
                                    <div className="tgw-attachments">
                                        {files.map((file) => (
                                            <Attachment key={file.id} file={file} post={post} onOpenImage={() => actions.setUI({imageViewer: {post, fileId: file.id}})}/>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
            <div className="tgw-thread-composer">
                <div className="tgw-composer-input">
                    <textarea
                        value={reply}
                        rows={1}
                        placeholder="Reply to thread"
                        onChange={(event) => setReply(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter' && !event.shiftKey) {
                                event.preventDefault();
                                send();
                            }
                        }}
                    />
                    <button type="button" className="tgw-send-button tgw-send-button-active" onClick={send} title="Send reply">
                        <IconSend size={18}/>
                    </button>
                </div>
            </div>
        </aside>
    );
}
