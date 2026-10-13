// Thread side panel: replies of a root post (Mattermost collapsed reply threads).
//
// Replies are read from the Mattermost store (kept up to date by the host app's own websocket
// handling); a REST call seeds the panel for threads the host never opened.

import React, {useEffect, useMemo, useState} from 'react';
import {api} from '../mm/api';
import {useSelector} from '../mm/store';
import type {MMChannel, MMPost} from '../mm/types';
import {displayName, formatTime, toPlainPreview} from '../mm/utils';
import {useTg} from './context';
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
    const [seeded, setSeeded] = useState<MMPost[]>([]);
    const [optimistic, setOptimistic] = useState<MMPost[]>([]);
    const [reply, setReply] = useState('');
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (replyIds && replyIds.length) {
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
    }, [rootId, replyIds]);

    const thread = useMemo(() => {
        const root = posts[rootId];
        const replies = (replyIds || []).map((id) => posts[id]).filter(Boolean) as MMPost[];
        const base = replies.length ? replies : seeded.filter((post) => post.root_id === rootId || post.id === rootId);
        const merged = [...(root ? [root] : base.filter((post) => post.id === rootId))]
            .concat(base.filter((post) => post.id !== rootId));
        // Drop optimistic copies that the server has already confirmed.
        const confirmedPendingIds = new Set(merged.map((post) => post.pending_post_id).filter(Boolean));
        const withoutConfirmed = optimistic.filter((post) => !post.pending_post_id || !confirmedPendingIds.has(post.pending_post_id));
        return merged.concat(withoutConfirmed).sort((a, b) => a.create_at - b.create_at);
    }, [posts, replyIds, seeded, optimistic, rootId]);

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
                    return (
                        <div key={post.id} className={`tgw-thread-post ${isRoot ? 'tgw-thread-root' : ''}`}>
                            <Avatar userId={post.user_id} name={author ? displayName(author) : ''} size={36}/>
                            <div className="tgw-thread-post-body">
                                <div className="tgw-thread-post-head">
                                    <span className="tgw-thread-author">{author ? displayName(author) : 'User'}</span>
                                    <span className="tgw-thread-time">{formatTime(post.create_at, timeFormat)}</span>
                                    {post._failed && <span className="tgw-thread-failed">failed</span>}
                                </div>
                                {post.message ? <MessageBody message={post.message} postId={post.id} editedAt={post.edit_at}/> : <span className="tgw-thread-empty">Attachment</span>}
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
