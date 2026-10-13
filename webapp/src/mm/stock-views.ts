// View tracking while the stock Mattermost UI is in use.
//
// The Telegram overlay's message list reports views precisely (IntersectionObserver per row),
// but users who keep the stock UI never scroll our list — so their reads never reached the
// server component. Opening a channel in the stock UI now counts as "the recent posts were
// seen", the same assumption Mattermost itself makes when it clears the unread badge.

import {api} from './api';
import {isEnabled} from './settings';
import {getState, subscribe} from './store';
import {markPostsSeen} from './views';

// How many of the newest posts of the opened channel count as seen.
const RECENT_POSTS = 20;

let started = false;

export function startStockUIViewTracking(): void {
    if (started) {
        return;
    }
    started = true;

    let lastChannelId = '';
    let wasEnabled = true;

    const check = () => {
        if (isEnabled()) {
            // Inside the overlay the message list tracks views itself; re-arm so that coming
            // back to the stock UI re-marks whatever channel is open then.
            wasEnabled = true;
            return;
        }
        if (wasEnabled) {
            wasEnabled = false;
            lastChannelId = '';
        }
        const channelId = getState().entities?.channels?.currentChannelId || '';
        if (!channelId || channelId === lastChannelId) {
            return;
        }
        lastChannelId = channelId;
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
    };

    subscribe(check);
    check();
}
