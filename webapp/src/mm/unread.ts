// Mark-as-unread support.
//
// Mirrors mattermost-redux's setUnreadPost: optimistically flag the channel as manually
// unread, call POST /users/{user_id}/posts/{post_id}/set_unread, then apply the returned
// ChannelUnread to the host Redux store so badges and the Unread folder update instantly.

import {api} from './api';
import {getCachedPreview} from './posts';
import {getMyId} from './selectors';
import {getState, getStore} from './store';
import type {MMPost} from './types';

function dispatchStore(action: {type: string; data: Record<string, any>}) {
    const store = getStore();
    try {
        store?.dispatch(action);
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[telegram-web-ui] could not dispatch', action.type, err);
    }
}

export async function markPostUnread(post: MMPost): Promise<boolean> {
    const myId = getMyId(getState());
    if (!myId || !post?.id) {
        return false;
    }

    dispatchStore({type: 'ADD_MANUALLY_UNREAD', data: {channelId: post.channel_id}});

    try {
        const unread = await api.markPostAsUnread(myId, post.id);
        dispatchStore({
            type: 'POST_UNREAD_SUCCESS',
            data: {
                lastViewedAt: unread.last_viewed_at,
                channelId: unread.channel_id || post.channel_id,
                msgCount: unread.msg_count,
                msgCountRoot: unread.msg_count_root,
                mentionCount: unread.mention_count,
                mentionCountRoot: unread.mention_count_root,
                urgentMentionCount: unread.urgent_mention_count,
            },
        });
        return true;
    } catch (err) {
        dispatchStore({type: 'REMOVE_MANUALLY_UNREAD', data: {channelId: post.channel_id}});
        return false;
    }
}

/** Mark a whole channel as unread, starting from its most recent post. */
export async function markChannelUnreadFromLastPost(channelId: string): Promise<boolean> {
    let post = getCachedPreview(channelId);
    if (!post) {
        try {
            const data = await api.getPosts(channelId, 0, 1);
            const firstId = data.order?.[0];
            post = firstId ? data.posts[firstId] : null;
        } catch (err) {
            return false;
        }
    }
    if (!post) {
        return false;
    }
    return markPostUnread(post);
}
