// Per-channel post cache.
//
// The Mattermost web app only keeps the posts of the channel it currently has open in Redux, so
// the plugin maintains its own small cache for every chat the user opens. Updates arrive through
// the plugin websocket hook (see registerWebSocketEventHandler in index.tsx) and through the
// optimistic send path of the composer.

import {useEffect, useState} from 'react';
import {api} from './api';
import {getState} from './store';
import type {MMPost, MMReaction} from './types';

const PAGE_SIZE = 50;

export interface ChannelPostBlock {
    channelId: string;
    order: string[];
    posts: Record<string, MMPost>;
    reactions: Record<string, Record<string, MMReaction>>;
    hasMoreOlder: boolean;
    loading: boolean;
    loadingOlder: boolean;
    loadedAt: number;
    error?: string;
}

const blocks = new Map<string, ChannelPostBlock>();
const referencedPosts = new Map<string, MMPost>();
const previews = new Map<string, {post: MMPost | null; at: number; lastPostAt: number}>();
const loadingPreviews = new Set<string>();
const listeners = new Set<() => void>();

function emit() {
    listeners.forEach((listener) => {
        try {
            listener();
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[telegram-web-ui] post listener failed', err);
        }
    });
}

export function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function ensureBlock(channelId: string): ChannelPostBlock {
    let block = blocks.get(channelId);
    if (!block) {
        block = {
            channelId,
            order: [],
            posts: {},
            reactions: {},
            hasMoreOlder: true,
            loading: false,
            loadingOlder: false,
            loadedAt: 0,
        };
        blocks.set(channelId, block);
    }
    return block;
}

export function getBlock(channelId?: string | null): ChannelPostBlock | undefined {
    if (!channelId) {
        return undefined;
    }
    return blocks.get(channelId);
}

export function getPost(postId?: string | null): MMPost | undefined {
    if (!postId) {
        return undefined;
    }
    for (const block of blocks.values()) {
        if (block.posts[postId]) {
            return block.posts[postId];
        }
    }
    const cached = referencedPosts.get(postId);
    if (cached) {
        return cached;
    }
    const reduxPost = getState().entities?.posts?.posts?.[postId];
    return reduxPost || undefined;
}

export function getReactions(block: ChannelPostBlock | undefined, postId: string): MMReaction[] {
    const local = block?.reactions?.[postId];
    if (local) {
        // Once a local map exists it is the merged view: it was seeded from Redux/metadata and is
        // then kept in step with the websocket. It must win even when empty - otherwise deleting
        // the last reaction would fall back to the stale Redux/metadata copy and re-appear.
        return Object.values(local);
    }
    const redux = getState().entities?.posts?.reactions?.[postId];
    if (redux) {
        return Object.values(redux);
    }
    const post = getPost(postId);
    if (post?.metadata?.reactions) {
        return post.metadata.reactions;
    }
    return [];
}

function sortOrder(block: ChannelPostBlock) {
    block.order.sort((a, b) => {
        const postA = block.posts[a];
        const postB = block.posts[b];
        if (!postA || !postB) {
            return 0;
        }
        return postA.create_at - postB.create_at;
    });
}

function ingest(block: ChannelPostBlock, post: MMPost) {
    if (!post || post.delete_at > 0) {
        return;
    }
    block.posts[post.id] = post;
    if (!block.order.includes(post.id)) {
        block.order.push(post.id);
        block.order.sort((a, b) => (block.posts[a]?.create_at || 0) - (block.posts[b]?.create_at || 0));
    }
}

export async function loadChannel(channelId: string, opts: {force?: boolean; silent?: boolean} = {}): Promise<ChannelPostBlock> {
    const block = ensureBlock(channelId);
    if (block.loading || (!opts.force && block.loadedAt && Date.now() - block.loadedAt < 30_000)) {
        return block;
    }
    block.loading = true;
    if (!opts.silent) {
        emit();
    }
    try {
        const result = await api.getPosts(channelId, 0, PAGE_SIZE);
        const fresh: ChannelPostBlock = {
            channelId,
            order: [],
            posts: {},
            reactions: {...(block.reactions || {})},
            hasMoreOlder: Object.keys(result.posts || {}).length >= PAGE_SIZE,
            loading: false,
            loadingOlder: false,
            loadedAt: Date.now(),
        };
        Object.keys(result.posts || {}).forEach((id) => {
            const post = result.posts[id];
            if (post && post.delete_at === 0) {
                fresh.posts[id] = post;
                fresh.order.push(id);
                if (post.metadata?.reactions) {
                    const map: Record<string, MMReaction> = {};
                    post.metadata.reactions.forEach((reaction) => {
                        map[`${reaction.user_id}-${reaction.emoji_name}`] = reaction;
                    });
                    fresh.reactions[id] = map;
                }
            }
        });
        // Keep optimistic (not yet acknowledged) posts that are newer than the fetched page.
        block.order.forEach((id) => {
            const existing = block.posts[id];
            if (existing?._pending && !fresh.posts[id]) {
                fresh.posts[id] = existing;
                fresh.order.push(id);
            }
        });
        sortOrder(fresh);
        blocks.set(channelId, fresh);
    } catch (err: any) {
        block.loading = false;
        block.error = err?.message || 'Unable to load messages';
    }
    emit();
    return blocks.get(channelId)!;
}

export async function loadOlder(channelId: string): Promise<void> {
    const block = ensureBlock(channelId);
    if (block.loadingOlder || !block.hasMoreOlder || !block.order.length) {
        return;
    }
    const oldest = block.posts[block.order[0]];
    if (!oldest) {
        return;
    }
    block.loadingOlder = true;
    emit();
    try {
        const result = await api.getPostsBefore(channelId, oldest.id, PAGE_SIZE);
        const received = Object.keys(result.posts || {});
        received.forEach((id) => {
            const post = result.posts[id];
            if (post && post.delete_at === 0) {
                ingest(block, post);
            }
        });
        if (received.length < PAGE_SIZE) {
            block.hasMoreOlder = false;
        }
    } catch (err) {
        block.hasMoreOlder = false;
    }
    block.loadingOlder = false;
    emit();
}

// ------------------------------------------------------------------ optimistic + websocket updates

export function addOptimistic(channelId: string, post: MMPost): MMPost {
    const block = ensureBlock(channelId);
    const withFlags: MMPost = {...post, _pending: true};
    block.posts[post.id] = withFlags;
    block.order.push(post.id);
    sortOrder(block);
    bumpReplyCount(block, post.root_id, 1);
    emit();
    return withFlags;
}

export function removePost(channelId: string, postId: string) {
    const block = blocks.get(channelId);
    if (!block) {
        return;
    }
    const removed = block.posts[postId];
    delete block.posts[postId];
    block.order = block.order.filter((id) => id !== postId);
    if (removed) {
        bumpReplyCount(block, removed.root_id, -1);
    }
    emit();
}

export function markFailed(channelId: string, postId: string) {
    const block = blocks.get(channelId);
    const post = block?.posts[postId];
    if (block && post) {
        post._pending = false;
        post._failed = true;
        emit();
    }
}

/**
 * Keeps the "N replies" counter on a root post live. The server only refreshes reply_count
 * when the channel is re-fetched, so without this the link only appeared after a reload.
 */
function bumpReplyCount(block: ChannelPostBlock, rootId: string | undefined, delta: number) {
    if (!rootId || !delta) {
        return;
    }
    const root = block.posts[rootId];
    if (root) {
        root.reply_count = Math.max(0, (root.reply_count || 0) + delta);
    }
}

/** Mirrors an incoming post into the sidebar preview, including for channels that were never opened. */
function updatePreview(post: MMPost): boolean {
    if (post.delete_at > 0) {
        return false;
    }
    const preview = previews.get(post.channel_id);
    if (preview && preview.lastPostAt > post.create_at) {
        return false;
    }
    previews.set(post.channel_id, {post, at: Date.now(), lastPostAt: post.create_at});
    return true;
}

export function receivePost(post: MMPost, opts: {prependHistory?: boolean} = {}) {
    if (!post) {
        return;
    }
    const block = blocks.get(post.channel_id);
    if (!block) {
        if (post.metadata?.reactions || post.root_id || post.is_pinned) {
            referencedPosts.set(post.id, post);
        }
        // The channel is not open: the chat list still has to show the new last message, or it
        // only catches up after a reload.
        if (updatePreview(post)) {
            emit();
        }
        return;
    }

    // Reconcile the optimistic copy of our own message with the server copy.
    let replacedPending = false;
    if (post.pending_post_id) {
        const optimisticId = `pending-${post.pending_post_id}`;
        if (block.posts[optimisticId]) {
            replacedPending = true;
            delete block.posts[optimisticId];
            block.order = block.order.filter((id) => id !== optimisticId);
        }
    }

    if (post.delete_at > 0) {
        const removed = block.posts[post.id];
        delete block.posts[post.id];
        block.order = block.order.filter((id) => id !== post.id);
        if (removed) {
            bumpReplyCount(block, removed.root_id, -1);
        }
        emit();
        return;
    }

    const isNew = !block.posts[post.id];
    block.posts[post.id] = {...post, _pending: false, _failed: false};
    if (isNew) {
        block.order.push(post.id);
        sortOrder(block);
        // The optimistic copy of our own reply already bumped the counter; only new posts count.
        if (!replacedPending) {
            bumpReplyCount(block, post.root_id, 1);
        }
    }
    if (post.metadata?.reactions) {
        const map: Record<string, MMReaction> = {};
        post.metadata.reactions.forEach((reaction) => {
            map[`${reaction.user_id}-${reaction.emoji_name}`] = reaction;
        });
        block.reactions[post.id] = map;
    }

    // Keep sidebar previews in sync.
    updatePreview(post);

    emit();
}

export function receiveReaction(reaction: MMReaction, added: boolean) {
    if (!reaction) {
        return;
    }
    const block = blocks.get(getChannelIdForPost(reaction.post_id));
    if (!block) {
        return;
    }
    let map = block.reactions[reaction.post_id];
    if (!map) {
        // Seed from Redux / post metadata first: getReactions() prefers the local map once it
        // exists, so starting from an empty map would hide reactions the post already carries.
        map = {};
        getReactions(block, reaction.post_id).forEach((known) => {
            map[`${known.user_id}-${known.emoji_name}`] = known;
        });
        block.reactions[reaction.post_id] = map;
    }
    const key = `${reaction.user_id}-${reaction.emoji_name}`;
    if (added) {
        map[key] = reaction;
    } else {
        delete map[key];
    }
    emit();
}

function getChannelIdForPost(postId: string): string {
    for (const block of blocks.values()) {
        if (block.posts[postId]) {
            return block.channelId;
        }
    }
    return getState().entities?.posts?.posts?.[postId]?.channel_id || '';
}

// ------------------------------------------------------------------ previews for the chat list

export function getCachedPreview(channelId: string): MMPost | null {
    const cached = previews.get(channelId);
    if (cached) {
        return cached.post;
    }
    const block = blocks.get(channelId);
    if (block && block.order.length) {
        const last = block.posts[block.order[block.order.length - 1]];
        if (last) {
            return last;
        }
    }
    return null;
}

/**
 * Fetches the newest post of a channel for the sidebar preview when it is not cached yet.
 * Only one request per channel is in flight, and only if the channel actually has posts.
 */
export async function prefetchPreview(channelId: string, lastPostAt: number): Promise<void> {
    if (!lastPostAt || loadingPreviews.has(channelId)) {
        return;
    }
    const cached = previews.get(channelId);
    if (cached && cached.lastPostAt >= lastPostAt) {
        return;
    }
    loadingPreviews.add(channelId);
    try {
        const result = await api.getPosts(channelId, 0, 1);
        const id = (result.order || [])[0];
        const post = id ? result.posts[id] : null;
        previews.set(channelId, {post: post || null, at: Date.now(), lastPostAt});
        emit();
    } catch (err) {
        previews.set(channelId, {post: null, at: Date.now(), lastPostAt});
    }
    loadingPreviews.delete(channelId);
}

export function pendingCount(channelId: string): number {
    const block = blocks.get(channelId);
    if (!block) {
        return 0;
    }
    return block.order.filter((id) => block.posts[id]?._pending).length;
}

// ------------------------------------------------------------------ react hooks

export interface UsePostsResult {
    posts: MMPost[];
    block?: ChannelPostBlock;
    loading: boolean;
    loadingOlder: boolean;
    hasMoreOlder: boolean;
}

export function useChannelPosts(channelId?: string | null): UsePostsResult {
    const [, setTick] = useState(0);
    useEffect(() => {
        const listener = () => setTick((n) => n + 1);
        return subscribe(listener);
    }, []);

    const block = channelId ? blocks.get(channelId) : undefined;
    const posts: MMPost[] = [];
    if (block) {
        block.order.forEach((id) => {
            const post = block.posts[id];
            if (post) {
                posts.push(post);
            }
        });
    }

    return {
        posts,
        block,
        loading: !!block?.loading && posts.length === 0,
        loadingOlder: !!block?.loadingOlder,
        hasMoreOlder: block ? block.hasMoreOlder : true,
    };
}

/**
 * Re-renders the component on every local cache change (new posts, reactions, edits).
 * Components that read the cache through getBlock()/getReactions() need this: those helpers
 * mutate the block in place, so a plain selector never notices the change.
 */
export function usePostRevision(): number {
    const [revision, setRevision] = useState(0);
    useEffect(() => {
        return subscribe(() => setRevision((n) => n + 1));
    }, []);
    return revision;
}

export function clearCache() {
    blocks.clear();
    previews.clear();
    referencedPosts.clear();
    emit();
}
