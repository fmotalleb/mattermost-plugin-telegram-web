// Websocket -> post cache bridge.
//
// Mattermost puts the post / reaction into the websocket `data` map as a JSON *string*
// (server side: post.ToJson() / reaction.ToJson()); the host web app JSON.parses it before use.
// Handing the raw string to the cache makes receivePost()/receiveReaction() silently no-op -
// a string has no channel_id/post_id - which is why new messages and reaction changes only
// appeared after a reload. Already-parsed objects (proxies, replays) are passed straight through.

import {receivePost, receiveReaction} from './posts';
import type {MMPost, MMReaction} from './types';

export function parsePayload<T>(value: unknown): T | undefined {
    if (typeof value === 'string') {
        try {
            return JSON.parse(value) as T;
        } catch (error) {
            // eslint-disable-next-line no-console
            console.warn('[telegram-web-ui] dropping malformed websocket payload', error);
            return undefined;
        }
    }
    if (value && typeof value === 'object') {
        return value as T;
    }
    return undefined;
}

const POST_EVENTS = new Set(['posted', 'post_edited', 'post_deleted']);
const REACTION_EVENTS: Record<string, boolean> = {
    reaction_added: true,
    reaction_removed: false,
};

/** Applies a Mattermost websocket message to the local post cache. */
export function handleSocketEvent(event: string, message: any): void {
    const data = message?.data;
    if (POST_EVENTS.has(event)) {
        const post = parsePayload<MMPost>(data?.post);
        if (!post) {
            return;
        }
        receivePost(event === 'post_deleted' ? {...post, delete_at: post.delete_at || Date.now()} : post);
        return;
    }
    const added = REACTION_EVENTS[event];
    if (added !== undefined) {
        const reaction = parsePayload<MMReaction>(data?.reaction);
        if (reaction) {
            receiveReaction(reaction, added);
        }
    }
}
