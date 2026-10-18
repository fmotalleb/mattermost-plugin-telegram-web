// View tracking while the stock Mattermost UI is in use.
//
// The Telegram overlay's message list reports views precisely (IntersectionObserver per row),
// but users who keep the stock UI never scroll our list — so their reads never reached the
// server component. Whenever the stock UI is active, store activity for the open channel is
// therefore re-checked: its recent posts count as "seen", the same assumption Mattermost
// itself makes when it clears the unread badge — including when the *server* component ported
// the seen state back to the sender (the double checkmark).
//
// The check deliberately does NOT fire only on channel switches: a message arriving in the
// channel the reader already has open never changes currentChannelId, and that read is exactly
// what the sender's seen status waits for (the usual way the failure showed up: a peer on
// Mattermost's own UI kept the chat open, the bridge went silent, and the checkmark never
// moved). Store events arrive in bursts (typing, presence, websocket posts), so they are
// throttled to one fetch per second; views.ts dedupes what actually gets reported.

import {api} from './api';
import {isEnabled} from './settings';
import {getState, subscribe} from './store';
import {markPostsSeen} from './views';

// How many of the newest posts of the opened channel count as seen.
const RECENT_POSTS = 20;
// At most one refresh per second — the trailing timer also batches event bursts and always
// re-reads the channel that is current at fire time.
const CHECK_INTERVAL = 1000;

let started = false;

export function startStockUIViewTracking(): void {
    if (started) {
        return;
    }
    started = true;

    let timer: ReturnType<typeof setTimeout> | null = null;

    const check = () => {
        if (isEnabled()) {
            // Inside the overlay the message list tracks views itself.
            return;
        }
        if (timer) {
            return;
        }
        timer = setTimeout(() => {
            timer = null;
            if (isEnabled()) {
                return;
            }
            const channelId = getState().entities?.channels?.currentChannelId || '';
            if (!channelId) {
                return;
            }
            api.getPosts(channelId, 0, RECENT_POSTS).
                then((page) => {
                    // Ignore a channel switch or a UI flip that happened while the fetch was in flight.
                    if (isEnabled() || getState().entities?.channels?.currentChannelId !== channelId) {
                        return;
                    }
                    const ids = (page.order || []).filter((id) => page.posts[id] && !page.posts[id].delete_at);
                    markPostsSeen(ids);
                }).
                catch(() => undefined);
        }, CHECK_INTERVAL);
    };

    subscribe(check);
    check();
}
