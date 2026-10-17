// The favorite star, through the same preferences API the stock web app uses.
//
// The UI previously called window.WebappUtils.channels.favoriteChannel — a host helper that
// plugins are not guaranteed to see. Where it was missing the click silently did nothing, which
// reads as "remove from favorite does not work, it does not call api".

import {api} from './api';
import {getState, getStore} from './store';
import type {MMPreference} from './types';

const FAVORITE_CATEGORY = 'favorite_channel';

export async function setChannelFavorite(channelId: string, favorite: boolean): Promise<void> {
    const userId = getState().entities?.users?.currentUserId || '';
    if (!userId) {
        throw new Error('no current user');
    }
    const preference: MMPreference = {
        category: FAVORITE_CATEGORY,
        name: channelId,
        user_id: userId,
        value: favorite ? 'true' : 'false',
    };
    await api.savePreferences([preference]);
    // Our selectors read the host redux store's preferences copy: update it in place so the
    // star flips without a reload. RECEIVED_PREFERENCES is the stock action for this; failing
    // to dispatch it is not fatal — the REST call already succeeded.
    try {
        getStore()?.dispatch({type: 'RECEIVED_PREFERENCES', data: [preference]});
    } catch {
        // The next store sync picks the preference up.
    }
}
