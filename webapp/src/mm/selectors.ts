// Derived, memoized views over the Mattermost store: chat list entries, tabs (folders), contacts,
// unread counters, presence, typing indicators and custom emoji.

import {getCachedPreview} from './posts';
import {getState} from './store';
import type {MMChannel, MMChannelCategory, MMChannelMember, MMCustomEmoji, MMState, MMTeam, MMUser} from './types';
import {channelMemberIds, colorForKey, displayName, initialsFor, isSameDay} from './utils';

const FAVORITE_CATEGORY = 'favorite_channel';
const PREFERENCE_CATEGORY_DISPLAY = 'display_settings';
const PREFERENCE_NAME_MILITARY = 'use_military_time';

function config(state: MMState): Record<string, any> {
    return state.entities?.general?.config || {};
}

export function getSiteURL(state: MMState): string {
    const value = config(state).SiteURL || '';
    if (value && value !== '/') {
        return value.replace(/\/+$/, '');
    }
    return typeof window !== 'undefined' ? window.location.origin : '';
}

export function getMyId(state: MMState): string {
    return state.entities?.users?.currentUserId || '';
}

export function getUsers(state: MMState): Record<string, MMUser> {
    return state.entities?.users?.profiles || {};
}

export function getUser(state: MMState, userId?: string | null): MMUser | undefined {
    if (!userId) {
        return undefined;
    }
    return getUsers(state)[userId];
}

export function getMe(state: MMState): MMUser | undefined {
    return getUser(state, getMyId(state));
}

export function getStatus(state: MMState, userId?: string | null): string {
    if (!userId) {
        return 'offline';
    }
    const {statuses, statusesByUserId} = state.entities?.users || ({} as any);
    return (statuses && statuses[userId]) || (statusesByUserId && statusesByUserId[userId]) || 'offline';
}

export function getLastActivity(state: MMState, userId?: string | null): number {
    return 0;
}

export function getChannels(state: MMState): Record<string, MMChannel> {
    return state.entities?.channels?.channels || {};
}

export function getChannel(state: MMState, channelId?: string | null): MMChannel | undefined {
    if (!channelId) {
        return undefined;
    }
    return getChannels(state)[channelId];
}

export function getMyMember(state: MMState, channelId?: string | null): MMChannelMember | undefined {
    if (!channelId) {
        return undefined;
    }
    return state.entities?.channels?.myMembers?.[channelId];
}

export function getTeams(state: MMState): Record<string, MMTeam> {
    return state.entities?.teams?.teams || {};
}

export function getTeam(state: MMState, teamId?: string | null): MMTeam | undefined {
    return teamId ? getTeams(state)[teamId] : undefined;
}

export function getCurrentTeamId(state: MMState): string {
    return state.entities?.teams?.currentTeamId || '';
}

export function getFavoriteChannelIds(state: MMState): Record<string, boolean> {
    const preferences = state.entities?.preferences?.myPreferences || {};
    const favorites: Record<string, boolean> = {};
    Object.keys(preferences).forEach((key) => {
        const preference = preferences[key];
        if (preference?.category === FAVORITE_CATEGORY && preference.value === 'true') {
            favorites[preference.name] = true;
        }
    });
    return favorites;
}

export function isFavoriteChannel(state: MMState, channelId: string): boolean {
    const preferences = state.entities?.preferences?.myPreferences || {};
    const preference = preferences[`${FAVORITE_CATEGORY}--${channelId}`];
    return !!preference && preference.value === 'true';
}

export interface TimeFormatInfo {
    military: boolean;
    locale: string;
}

export function getTimeFormat(state: MMState): TimeFormatInfo {
    const preferences = state.entities?.preferences?.myPreferences || {};
    const preference = preferences[`${PREFERENCE_CATEGORY_DISPLAY}--${PREFERENCE_NAME_MILITARY}`];
    const locale = config(state).AvailableLocales === undefined ? 'en' : (config(state).DefaultLocale || 'en');
    return {military: preference?.value === 'true', locale};
}

export function getCustomEmoji(state: MMState): Record<string, MMCustomEmoji> {
    return state.entities?.emojis?.customEmoji || {};
}

export function getTypingUserIds(state: MMState, channelId: string, rootId = ''): string[] {
    const typing = state.entities?.typing || {};
    const bucket = typing[`${channelId}${rootId}`] || {};
    const now = Date.now();
    return Object.keys(bucket).filter((userId) => {
        const stamp = bucket[userId];
        return userId !== getMyId(state) && now - stamp < 30_000;
    });
}

// ------------------------------------------------------------------------------- chat summaries

export interface ChatSummary {
    id: string;
    channel: MMChannel;
    type: MMChannel['type'];
    title: string;
    subtitle: string;
    avatarUrl?: string;
    avatarUserId?: string;
    initials: string;
    color: string;
    isFavorite: boolean;
    folded: boolean;
    unread: number;
    mentions: number;
    muted: boolean;
    manuallyUnread: boolean;
    lastPostAt: number;
    lastViewedAt: number;
    status?: string;
    memberCount: number;
    teamId: string;
    teamName: string;
    peerIds: string[];
}

class Memo<T> {
    private keys: any[] | null = null;

    private value: T | undefined;

    get(keys: any[], compute: () => T): T {
        if (this.keys && this.keys.length === keys.length && this.keys.every((key, index) => key === keys[index]) && this.value !== undefined) {
            return this.value;
        }
        this.keys = keys;
        this.value = compute();
        return this.value;
    }
}

const chatMemo = new Memo<ChatSummary>();
const chatListMemo = new Memo<ChatSummary[]>();
const contactsMemo = new Memo<MMUser[]>();
const tabsMemo = new Memo<ChatTab[]>();
const tabChatsMemo = new Memo<ChatSummary[]>();
const categoryChatsMemo = new Memo<ChatSummary[]>();
const searchChatsMemo = new Memo<ChatSummary[]>();
const tabUnreadMemo = new Memo<Record<string, number>>();

export function getMemberCount(state: MMState, channelId: string): number {
    const stats = state.entities?.channels?.stats?.[channelId];
    if (stats?.member_count) {
        return stats.member_count;
    }
    const memberCount = state.entities?.channels?.channelsMemberCount?.[channelId];
    if (memberCount) {
        return memberCount;
    }
    const members = state.entities?.channels?.membersInChannel?.[channelId];
    if (members) {
        return Object.keys(members).length;
    }
    return 0;
}

export function isMutedForMe(state: MMState, channelId: string, userId?: string): boolean {
    const member = state.entities?.channels?.membersInChannel?.[channelId]?.[userId || getMyId(state)];
    if (member?.notify_props) {
        const {desktop, push, mark_unread} = member.notify_props;
        if (desktop === 'none' || (desktop === 'mention' && push === 'none' && mark_unread === 'all')) {
            return true;
        }
    }
    // DM/GM channels can be muted through the "sidebarchannel" preferences as well.
    const preferences = state.entities?.preferences?.myPreferences || {};
    const preference = preferences[`${FAVORITE_CATEGORY}--${channelId}`];
    return false || (preference?.value === 'muted');
}

export function getChatSummary(state: MMState, channelId: string): ChatSummary | undefined {
    const channel = getChannel(state, channelId);
    if (!channel || channel.delete_at > 0) {
        return undefined;
    }
    const myMember = getMyMember(state, channelId);
    const membersInChannel = state.entities?.channels?.membersInChannel?.[channelId];
    const peerIds = channelMemberIds(channel).filter((id) => id !== getMyId(state));
    const peerUser = channel.type === 'D' ? getUser(state, peerIds[0]) : undefined;
    const cachedPreview = getCachedPreview(channelId);
    // Mattermost v6.1+ moved the total message count out of the Channel object in Redux
    // (MM-37021: toClientChannel deletes total_msg_count); it lives in messageCounts now.
    const totalMsgCount = state.entities?.channels?.messageCounts?.[channelId]?.total ?? channel.total_msg_count ?? 0;

    return chatMemo.get(
        [channel, myMember, peerUser, getStatus(state, peerIds[0]), membersInChannel, cachedPreview?.id, cachedPreview?.create_at, totalMsgCount],
        () => {
            const unread = Math.max(0, totalMsgCount - (myMember?.msg_count || 0));
            const mentions = myMember?.mention_count || 0;
            const memberCount = channel.type === 'G' ? peerIds.length + 1 : (channel.type === 'D' ? 2 : getMemberCount(state, channelId));
            const team = getTeam(state, channel.team_id);

            let title: string;
            let subtitle = '';
            let avatarUrl: string | undefined;
            let avatarUserId: string | undefined;
            let status: string | undefined;

            if (channel.type === 'D') {
                title = peerUser ? displayName(peerUser) : (channel.display_name || 'Direct message');
                avatarUserId = peerUser?.id;
                status = getStatus(state, peerUser?.id);
                subtitle = '';
            } else if (channel.type === 'G') {
                const names = peerIds.map((id) => {
                    const user = getUser(state, id);
                    return user ? displayName(user) : id;
                });
                title = names.filter(Boolean).join(', ') || channel.display_name || 'Group message';
            } else {
                title = channel.display_name || channel.name;
                subtitle = `${memberCount} ${memberCount === 1 ? 'member' : 'members'}`;
            }

            return {
                id: channel.id,
                channel,
                type: channel.type,
                title,
                subtitle,
                avatarUrl,
                avatarUserId,
                initials: initialsFor(title),
                color: colorForKey(channel.type === 'D' ? (peerUser?.id || channel.id) : channel.id),
                isFavorite: isFavoriteChannel(state, channelId),
                folded: false,
                unread,
                mentions,
                muted: isMutedForMe(state, channelId),
                manuallyUnread: !!state.entities?.channels?.manuallyUnread?.[channelId],
                lastPostAt: channel.last_post_at || channel.create_at,
                lastViewedAt: myMember?.last_viewed_at || 0,
                status,
                memberCount,
                teamId: channel.team_id,
                teamName: team?.display_name || '',
                peerIds,
            };
        },
    );
}

function compareChats(a: ChatSummary, b: ChatSummary): number {
    return b.lastPostAt - a.lastPostAt;
}

function summarise(state: MMState, channelIds: string[]): ChatSummary[] {
    const result: ChatSummary[] = [];
    channelIds.forEach((channelId) => {
        const summary = getChatSummary(state, channelId);
        if (summary) {
            result.push(summary);
        }
    });
    return result;
}

/**
 * Every channel the user is a member of, across all teams (Mattermost DMs/GMs are team agnostic).
 * This powers the "All" folder, which mirrors Telegram's main chat list.
 */
export function getAllChats(state: MMState): ChatSummary[] {
    const channels = getChannels(state);
    const myMembers = state.entities?.channels?.myMembers || {};
    const membersInChannel = state.entities?.channels?.membersInChannel || {};
    const preferences = state.entities?.preferences?.myPreferences || {};

    return chatListMemo.get(
        [channels, myMembers, state.entities?.users, state.entities?.teams, membersInChannel, preferences, state.entities?.channels?.stats, state.entities?.channels?.manuallyUnread, state.entities?.channels?.messageCounts],
        () => {
            const ids: string[] = [];
            Object.keys(myMembers).forEach((channelId) => {
                const channel = channels[channelId];
                if (channel && channel.delete_at === 0) {
                    ids.push(channelId);
                }
            });
            return summarise(state, ids).sort(compareChats);
        },
    );
}

export function getChatsForIds(state: MMState, channelIds: string[]): ChatSummary[] {
    const result: ChatSummary[] = [];
    channelIds.forEach((id) => {
        const summary = getChatSummary(state, id);
        if (summary) {
            result.push(summary);
        }
    });
    return result;
}

// ------------------------------------------------------------------------------- folders / tabs

export interface ChatTab {
    id: string;
    label: string;
    kind: 'all' | 'unread' | 'category' | 'contacts';
    type?: MMChannelCategory['type'];
    sortOrder: number;
}

export function getCategoriesForTeam(state: MMState, teamId: string): MMChannelCategory[] {
    const {byId, orderByTeam} = state.entities?.channelCategories || ({} as any);
    if (!byId || !orderByTeam) {
        return [];
    }
    const order: string[] = orderByTeam[teamId] || [];
    return order.map((id) => byId[id]).filter(Boolean);
}

export function getCategory(state: MMState, categoryId: string): MMChannelCategory | undefined {
    return state.entities?.channelCategories?.byId?.[categoryId];
}

const CATEGORY_LABELS: Record<string, string> = {
    favorites: 'Favorites',
    channels: 'Groups',
    direct_messages: 'Chats',
    managed: 'Groups',
    custom: '',
};

export function getTabs(state: MMState): ChatTab[] {
    const teamId = getCurrentTeamId(state);
    const categories = state.entities?.channelCategories?.byId;
    const order = state.entities?.channelCategories?.orderByTeam;
    return tabsMemo.get([categories, order, teamId], () => {
        const tabs: ChatTab[] = [
            {id: '__all', label: 'All', kind: 'all', sortOrder: 0},
            {id: '__unread', label: 'Unread', kind: 'unread', sortOrder: 1},
        ];
        getCategoriesForTeam(state, teamId).forEach((category, index) => {
            const ids = category.channel_ids || [];
            const hasChannels = ids.some((id) => !!getChannel(state, id));
            if (!hasChannels && category.type !== 'custom') {
                return;
            }
            // The server calls the built-in category "Channels"; this UI works with groups, so
            // relabel it. Custom categories keep the user's own name.
            const isBuiltInChannels = category.type === 'channels' || category.type === 'managed';
            tabs.push({
                id: category.id,
                label: isBuiltInChannels ? 'Groups' : (category.display_name || CATEGORY_LABELS[category.type] || 'Folder'),
                kind: 'category',
                type: category.type,
                sortOrder: 10 + index,
            });
        });
        tabs.push({id: '__contacts', label: 'Contacts', kind: 'contacts', sortOrder: 10_000});
        return tabs;
    });
}

function computeCategoryChats(state: MMState, category: MMChannelCategory): ChatSummary[] {
    const ids = (category.channel_ids || []).filter((id) => !!getMyMember(state, id));
    const chats = getChatsForIds(state, ids);
    if (category.sorting === 'alpha') {
        return chats.sort((a, b) => a.title.localeCompare(b.title));
    }
    if (category.sorting === 'recent' || category.sorting === '' || !category.sorting) {
        return chats.sort(compareChats);
    }
    return chats;
}

export function getChatsForCategory(state: MMState, category: MMChannelCategory): ChatSummary[] {
    return categoryChatsMemo.get(
        [category, state.entities?.channels?.myMembers, state.entities?.channels?.channels, state.entities?.users, state.entities?.teams, state.entities?.preferences, state.entities?.channels?.manuallyUnread, state.entities?.channels?.messageCounts],
        () => computeCategoryChats(state, category),
    );
}

/** Chats of a folder/tab: All, Unread, a Mattermost channel category, or the contacts tab. */
export function getTabChats(state: MMState, tabId: string): ChatSummary[] {
    if (tabId === '__unread') {
        return getUnreadChats(state);
    }
    if (tabId === '__all' || tabId === '__contacts' || !tabId) {
        return tabId === '__contacts' ? [] : getAllChats(state);
    }
    const category = getCategory(state, tabId);
    if (!category) {
        return getAllChats(state);
    }
    return tabChatsMemo.get([category, state.entities?.channels?.myMembers, state.entities?.users], () => getChatsForCategory(state, category));
}

// Unread message total of every folder tab, so the whole tab row can be badged at once.
// Keyed on exactly the entities the chat lists themselves watch: a count must move whenever a
// row badge moves (opening a chat, mark-as-unread, websocket updates, category changes).
export function getTabUnreadCounts(state: MMState, tabs: ChatTab[]): Record<string, number> {
    return tabUnreadMemo.get(
        [
            tabs,
            state.entities?.channelCategories?.byId,
            getChannels(state),
            state.entities?.channels?.myMembers,
            state.entities?.users,
            state.entities?.teams,
            state.entities?.channels?.membersInChannel,
            state.entities?.preferences?.myPreferences,
            state.entities?.channels?.stats,
            state.entities?.channels?.manuallyUnread,
            state.entities?.channels?.messageCounts,
        ],
        () => {
            const counts: Record<string, number> = {};
            tabs.forEach((tab) => {
                counts[tab.id] = getTabChats(state, tab.id).reduce((sum, chat) => sum + (chat.unread || 0), 0);
            });
            return counts;
        },
    );
}

export function searchChats(state: MMState, term: string): ChatSummary[] {
    const all = getAllChats(state);
    const lower = (term || '').trim().toLowerCase();
    return searchChatsMemo.get([all, lower], () => {
        if (!lower) {
            return [];
        }
        return all.filter((chat) => chat.title.toLowerCase().includes(lower) || (chat.channel.name || '').includes(lower)).slice(0, 40);
    });
}

export function getUnreadChats(state: MMState): ChatSummary[] {
    return getAllChats(state).filter((chat) => chat.unread > 0 || chat.mentions > 0 || chat.manuallyUnread);
}

/** All channels of one team, used by the "add members"/"browse channels" pickers. */
export function getTeamChats(state: MMState, teamId: string, opts: {onlyMember?: boolean} = {}): ChatSummary[] {
    const {channelsInTeam} = state.entities?.channels || ({} as any);
    const set = channelsInTeam?.[teamId];
    const ids: string[] = set ? Array.from(set as Set<string>) : [];
    return getChatsForIds(state, ids).filter((chat) => (opts.onlyMember === false ? true : !!getMyMember(state, chat.id)));
}

// ------------------------------------------------------------------------------- contacts

export function getContacts(state: MMState): MMUser[] {
    const teamId = getCurrentTeamId(state);
    const profilesInTeam = state.entities?.users?.profilesInTeam?.[teamId];
    const profiles = getUsers(state);
    const myId = getMyId(state);
    return contactsMemo.get([profilesInTeam, profiles, teamId, state.entities?.users?.statuses], () => {
        const ids: string[] = profilesInTeam ? Array.from(profilesInTeam as Set<string>) : Object.keys(profiles);
        return ids
            .map((id) => profiles[id])
            .filter((user) => user && user.id !== myId && user.delete_at === 0)
            .sort((a, b) => displayName(a).localeCompare(displayName(b)));
    });
}

export function searchContactCandidates(state: MMState, term: string, limit = 40): MMUser[] {
    const myId = getMyId(state);
    const lower = term.trim().toLowerCase();
    const local = getContacts(state).filter((user) => {
        if (!lower) {
            return true;
        }
        return (
            (user.username || '').toLowerCase().includes(lower) ||
            displayName(user).toLowerCase().includes(lower) ||
            (user.nickname || '').toLowerCase().includes(lower)
        );
    });
    return local.filter((user) => user.id !== myId).slice(0, limit);
}

export function getPeersOfDirectChannel(state: MMState, channel: MMChannel): MMUser[] {
    return channelMemberIds(channel)
        .filter((id) => id !== getMyId(state))
        .map((id) => getUser(state, id))
        .filter(Boolean) as MMUser[];
}

export function getDirectChannelForUser(state: MMState, userId: string): MMChannel | undefined {
    const channels = getChannels(state);
    return Object.values(channels).find((channel) => channel.type === 'D' && channel.name === [getMyId(state), userId].sort().join('__'));
}

export function sameDay(a: number, b: number): boolean {
    return isSameDay(a, b);
}

export function getReactionsForPost(postId: string) {
    const state = getState();
    const redux = state.entities?.posts?.reactions?.[postId];
    if (redux) {
        return Object.values(redux);
    }
    return [];
}
