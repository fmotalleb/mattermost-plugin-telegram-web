import type {MMScheduledPost} from './types';

const listeners = new Set<(post: MMScheduledPost) => void>();
export function subscribeScheduledPostCreated(listener: (post: MMScheduledPost) => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export function emitScheduledPostCreated(post: MMScheduledPost) {
    listeners.forEach((listener) => {
        try { listener(post); } catch (error) { console.warn('[telegram-web-ui] scheduled message listener failed', error); }
    });
}
