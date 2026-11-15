// One queue/cache and refresh timer per user and channel, shared by the main composer,
// quick chat and queue modal. Pending requests cannot overwrite a newly scheduled message.
import {useEffect, useState} from 'react';
import {api} from './api';
import {subscribeScheduledPostCreated, subscribeScheduledPostRemoved} from './scheduled-events';
import {useSelector} from './store';
import type {MMScheduledPost} from './types';

interface QueueState {posts: MMScheduledPost[]; loading: boolean; loaded: boolean; error: string;}
interface Entry {
    state: QueueState;
    listeners: Set<() => void>;
    request?: Promise<void>;
    revision: number;
    reload: boolean;
    stop?: () => void;
}
const cache = new Map<string, Entry>();
const empty: QueueState = {posts: [], loading: false, loaded: false, error: ''};
const sorted = (posts: MMScheduledPost[]) => posts.slice().sort((a, b) => a.scheduled_at - b.scheduled_at || a.id.localeCompare(b.id));
function emit(entry: Entry) { entry.listeners.forEach((listener) => listener()); }

function load(entry: Entry, channelId: string, userId: string, force = false): Promise<void> {
    if (entry.request) { if (force) entry.reload = true; return entry.request; }
    const revision = entry.revision;
    entry.state = {...entry.state, loading: true, error: ''};
    emit(entry);
    entry.request = api.getScheduledPosts(channelId).then((posts) => {
        if (revision !== entry.revision) return;
        if (!Array.isArray(posts)) throw new Error('Could not load scheduled messages');
        entry.state = {posts: sorted(posts.filter((post) => post.id && post.channel_id === channelId && (!post.user_id || post.user_id === userId))), loading: false, loaded: true, error: ''};
    }).catch((error) => {
        if (revision === entry.revision) entry.state = {...entry.state, loading: false, error: error.message || 'Could not load scheduled messages'};
    }).finally(() => {
        entry.request = undefined;
        emit(entry);
        if (entry.reload && entry.listeners.size) { entry.reload = false; void load(entry, channelId, userId); }
    });
    return entry.request;
}

export function useScheduledPosts(channelId?: string) {
    const userId = useSelector((state) => state.entities?.users?.currentUserId || '');
    const key = userId && channelId ? `${userId}:${channelId}` : '';
    const [, render] = useState(0);
    useEffect(() => {
        if (!key) return;
        let entry = cache.get(key);
        if (!entry) { entry = {state: {...empty}, listeners: new Set(), revision: 0, reload: false}; cache.set(key, entry); }
        const current = entry;
        const listener = () => render((value) => value + 1);
        current.listeners.add(listener);
        // Start only one shared network refresh lifecycle for this queue.
        if (current.listeners.size === 1) {
            const refresh = () => { void load(current, channelId!, userId, true); };
            const timer = setInterval(refresh, 30000);
            window.addEventListener('focus', refresh);
            const unsubscribe = subscribeScheduledPostCreated((post) => {
                if (!post?.id || post.channel_id !== channelId || (post.user_id && post.user_id !== userId)) return;
                current.revision++;
                current.state = {...current.state, posts: sorted([...current.state.posts.filter((item) => item.id !== post.id), post]), error: ''};
                emit(current);
                void load(current, channelId!, userId, true);
            });
            const unsubscribeRemoved = subscribeScheduledPostRemoved((post) => {
                if (post.channel_id !== channelId || (post.user_id && post.user_id !== userId)) return;
                current.revision++;
                current.state = {...current.state, posts: current.state.posts.filter((item) => item.id !== post.id), error: ''};
                emit(current);
                void load(current, channelId!, userId, true);
            });
            current.stop = () => { clearInterval(timer); window.removeEventListener('focus', refresh); unsubscribe(); unsubscribeRemoved(); };
        }
        void load(current, channelId!, userId);
        return () => {
            current.listeners.delete(listener);
            if (!current.listeners.size) { current.stop?.(); cache.delete(key); }
        };
    }, [key]);
    const state = cache.get(key)?.state || empty;
    const refresh = () => {
        const entry = cache.get(key);
        return entry ? load(entry, channelId!, userId, true) : Promise.resolve();
    };
    return {...state, refresh};
}
