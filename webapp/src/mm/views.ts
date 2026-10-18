// Post view tracking, backed by the plugin's server component (table tg_webui_user_view_tracking).
//
// The web app reports the posts the user can actually see (IntersectionObserver on the message
// rows) and renders the resulting counts Telegram-style next to the message time. When the
// server component is not installed the endpoints 404/501 — the feature switches itself off
// silently and the UI simply shows no counts.

import {useSyncExternalStore} from 'react';
import {APIError, api} from './api';

export interface ViewStats {
    count: number;
    seen: boolean;
}

const stats = new Map<string, ViewStats>();
const listeners = new Set<() => void>();

/** Posts already reported as seen in this session (never reported twice). */
const reported = new Set<string>();
const pendingReport = new Set<string>();
const pendingFetch = new Set<string>();
let reportTimer: ReturnType<typeof setTimeout> | null = null;
let fetchTimer: ReturnType<typeof setTimeout> | null = null;

/** Flipped when the plugin endpoints are missing so we stop calling them. */
let viewsDisabled = false;

function notify() {
    listeners.forEach((listener) => listener());
}

export function subscribeViews(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function getViewStats(postId: string): ViewStats | undefined {
    return stats.get(postId);
}

/** React hook: the view stats of one post, updating live. */
export function usePostViews(postId: string): ViewStats | undefined {
    return useSyncExternalStore(subscribeViews, () => stats.get(postId));
}

/** Fetch counts for posts that do not have stats yet (batched + debounced). */
export function ensureViewStats(postIds: string[]): void {
    if (viewsDisabled) {
        return;
    }
    let queued = false;
    postIds.forEach((id) => {
        if (id && !stats.has(id) && !pendingFetch.has(id)) {
            pendingFetch.add(id);
            queued = true;
        }
    });
    if (queued) {
        scheduleFetch();
    }
}

/**
 * Re-fetch stats even for posts that already have some (batched + debounced). A receipt only
 * moves when the *other* side opens the message, so the chat polls through this while the peer
 * is online — without it the double check would wait for a reload or a remounted row.
 */
export function refreshViewStats(postIds: string[]): void {
    if (viewsDisabled) {
        return;
    }
    let queued = false;
    postIds.forEach((id) => {
        if (id && !pendingFetch.has(id)) {
            pendingFetch.add(id);
            queued = true;
        }
    });
    if (queued) {
        scheduleFetch();
    }
}

function scheduleFetch(): void {
    if (fetchTimer) {
        clearTimeout(fetchTimer);
    }
    fetchTimer = setTimeout(() => {
        fetchTimer = null;
        const ids = Array.from(pendingFetch);
        pendingFetch.clear();
        if (ids.length === 0) {
            return;
        }
        api.getPostViewStats(ids).
            then((result) => mergeStats(result.counts || {}, result.seen || {})).
            catch((error) => {
                if (error instanceof APIError && (error.status === 404 || error.status === 501)) {
                    viewsDisabled = true;
                }
            });
    }, 150);
}

/** Record that the given post is currently visible to the user (batched + debounced). */
export function markPostVisible(postId: string): void {
    markPostsSeen([postId]);
}

/** Record posts as seen without an on-screen check (e.g. opening the channel in the stock UI). */
export function markPostsSeen(postIds: string[]): void {
    if (viewsDisabled) {
        return;
    }
    let queued = false;
    postIds.forEach((id) => {
        if (id && !reported.has(id) && !pendingReport.has(id)) {
            pendingReport.add(id);
            queued = true;
        }
    });
    if (!queued || reportTimer) {
        return;
    }
    reportTimer = setTimeout(flushReport, 800);
}

function flushReport(): void {
    reportTimer = null;
    const ids = Array.from(pendingReport);
    pendingReport.clear();
    if (ids.length === 0) {
        return;
    }
    api.recordPostViews(ids).
        then(() => {
            ids.forEach((id) => reported.add(id));
            bumpOwnViews(ids);
        }).
        catch((error) => {
            if (error instanceof APIError && (error.status === 404 || error.status === 501)) {
                viewsDisabled = true;
            }
        });
}

function bumpOwnViews(postIds: string[]): void {
    let changed = false;
    postIds.forEach((id) => {
        const current = stats.get(id);
        if (current?.seen) {
            return;
        }
        stats.set(id, {count: Math.max(1, (current?.count || 0) + 1), seen: true});
        changed = true;
    });
    if (changed) {
        notify();
    }
}

function mergeStats(counts: Record<string, number>, seen: Record<string, boolean>): void {
    const ids = new Set([...Object.keys(counts), ...Object.keys(seen)]);
    let changed = false;
    ids.forEach((id) => {
        const current = stats.get(id);
        const count = counts[id] !== undefined ? counts[id] : (current?.count || 1);
        const isSeen = !!seen[id] || !!current?.seen;
        if (!current || current.count !== count || current.seen !== isSeen) {
            stats.set(id, {count, seen: isSeen});
            changed = true;
        }
    });
    if (changed) {
        notify();
    }
}
