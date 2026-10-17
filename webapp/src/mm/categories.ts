// Drag-to-reorder of the sidebar chats, through the same channel-category API the stock
// Mattermost sidebar uses: PUT /users/{user_id}/teams/{team_id}/channels/categories.

import {api} from './api';
import {getCurrentTeamId, getMyId, getCategory} from './selectors';
import {getState, getStore} from './store';
import type {MMChannelCategory} from './types';

/**
 * Persists `orderedChannelIds` as the category's channel order and switches the
 * category to manual sorting — exactly what a drag in Mattermost's own sidebar does. Channels
 * that are not part of the drag (hidden ones) keep their relative order at the end.
 */
export async function reorderCategoryChannels(categoryId: string, orderedChannelIds: string[]): Promise<void> {
    const state = getState();
    const category = getCategory(state, categoryId);
    if (!category) {
        throw new Error('unknown category');
    }
    const userId = getMyId(state);
    const teamId = getCurrentTeamId(state);
    if (!userId || !teamId) {
        throw new Error('no current user/team');
    }
    const placed = new Set(orderedChannelIds);
    const channel_ids = [...orderedChannelIds, ...(category.channel_ids || []).filter((id) => !placed.has(id))];
    const merged: MMChannelCategory = {...category, channel_ids, sorting: 'manual'};
    const updated = await api.updateChannelCategories(userId, teamId, [merged]);
    // Update the host store copy so the new order renders immediately (RECEIVED_CATEGORIES is
    // the stock action for this); a dispatch failure is not fatal, the order is saved already.
    try {
        const server = (updated && updated[0]) || undefined;
        const next: MMChannelCategory = {...merged, ...(server || {}), channel_ids, sorting: 'manual'};
        getStore()?.dispatch({type: 'RECEIVED_CATEGORIES', data: [next]});
    } catch {
        // The next category sync picks the order up.
    }
}