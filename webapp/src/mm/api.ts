// Thin REST client for the Mattermost v4 API.
//
// The plugin deliberately does not depend on mattermost-redux/Client4 (which is not exposed as a
// webpack external for plugins) so that it keeps working across server versions. Authentication
// uses the same mechanism the web app itself uses:
//   * the httpOnly session cookie (same-origin fetch sends it automatically)
//   * the non-httpOnly MMCSRF cookie echoed back through the X-CSRF-Token header on writes

import type {MMChannel, MMChannelCategory, MMCustomEmoji, MMFileInfo, MMPost, MMReaction, MMPreference, MMUser} from './types';
import {getState} from './store';

declare const window: any;

function getBasename(): string {
    if (typeof window !== 'undefined' && typeof window.basename === 'string') {
        return window.basename;
    }
    return '';
}

function getCSRFFromCookie(): string {
    if (typeof document === 'undefined' || !document.cookie) {
        return '';
    }
    const cookies = document.cookie.split(';');
    for (const raw of cookies) {
        const cookie = raw.trim();
        if (cookie.startsWith('MMCSRF=')) {
            return decodeURIComponent(cookie.substring('MMCSRF='.length));
        }
    }
    return '';
}

export class APIError extends Error {
    status: number;
    // eslint-disable-next-line no-useless-constructor
    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

interface RequestOptions {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: any;
    /** when true the body is sent as-is (FormData) */
    raw?: boolean;
    query?: Record<string, any>;
}

function buildQuery(query?: Record<string, any>): string {
    if (!query) {
        return '';
    }
    const parts: string[] = [];
    Object.keys(query).forEach((key) => {
        const value = query[key];
        if (value === undefined || value === null) {
            return;
        }
        if (Array.isArray(value)) {
            value.forEach((v) => parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`));
        } else {
            parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
        }
    });
    return parts.length ? `?${parts.join('&')}` : '';
}

export class MattermostAPI {
    private token = '';
    private basePath = '/api/v4';

    constructor() {
        if (typeof window !== 'undefined') {
            this.basePath = `${getBasename()}/api/v4`;
        }
    }

    setToken(token: string) {
        this.token = token || '';
    }

    getURL(path: string): string {
        return `${this.basePath}${path}`;
    }

    async request<T = any>(path: string, options: RequestOptions = {}): Promise<T> {
        return this.fetchJSON<T>(this.getURL(path), options);
    }

    // Calls the server component of this plugin (/plugins/<id>/...), which hosts the view
    // tracking API. Fails with 404/501 when that component is not installed — callers treat
    // that as "feature unavailable", not as an error.
    async pluginRequest<T = any>(path: string, options: RequestOptions = {}): Promise<T> {
        return this.fetchJSON<T>(`${getBasename()}/plugins/com.telegramweb.ui${path}`, options);
    }

    private async fetchJSON<T = any>(url: string, options: RequestOptions = {}): Promise<T> {
        const method = options.method || 'GET';
        const headers: Record<string, string> = {
            'X-Requested-With': 'XMLHttpRequest',
            Accept: 'application/json',
        };

        if (this.token) {
            headers.Authorization = `Bearer ${this.token}`;
        }

        let body: any;
        if (options.body !== undefined) {
            if (options.raw) {
                body = options.body;
            } else {
                headers['Content-Type'] = 'application/json';
                body = JSON.stringify(options.body);
            }
        }

        if (method !== 'GET') {
            const csrf = getCSRFFromCookie();
            if (csrf) {
                headers['X-CSRF-Token'] = csrf;
            }
        }

        const response = await fetch(`${url}${buildQuery(options.query)}`, {
            method,
            headers,
            body,
            credentials: 'same-origin',
        });

        const text = await response.text();
        let data: any = null;
        if (text) {
            try {
                data = JSON.parse(text);
            } catch (err) {
                data = text;
            }
        }

        if (!response.ok) {
            const message = (data && (data.message || data.detailed_error)) || response.statusText || 'Request failed';
            throw new APIError(message, response.status);
        }

        return data as T;
    }

    // ---------------------------------------------------------------- files (binary, keeps cookies)

    fileURL(fileId: string, thumbnail = false): string {
        return this.getURL(`/files/${fileId}${thumbnail ? '/thumbnail' : ''}`);
    }

    previewURL(fileId: string): string {
        return this.getURL(`/files/${fileId}/preview`);
    }

    avatarURL(userId: string, lastPictureUpdate = 0): string {
        const suffix = lastPictureUpdate ? `?_=${lastPictureUpdate}` : '';
        return this.getURL(`/users/${userId}/image${suffix}`);
    }

    customEmojiImageURL(emojiId: string): string {
        return this.getURL(`/emoji/${emojiId}/image`);
    }

    // ---------------------------------------------------------------- users

    getMe(): Promise<MMUser> {
        return this.request<MMUser>('/users/me');
    }

    getUsersByIds(ids: string[]): Promise<MMUser[]> {
        return this.request<MMUser[]>('/users/ids', {method: 'POST', body: ids});
    }

    getUsersInTeam(teamId: string, page = 0, perPage = 60): Promise<MMUser[]> {
        return this.request<MMUser[]>(`/users${buildQuery({in_team: teamId, page, per_page: perPage})}`);
    }

    autocompleteUsers(term: string, teamId: string, channelId?: string, limit = 30): Promise<{users: MMUser[]; out_of_channel?: MMUser[]}> {
        return this.request(`/users/autocomplete${buildQuery({name: term, in_team: teamId, in_channel: channelId, limit})}`);
    }

    searchUsers(term: string, teamId?: string): Promise<MMUser[]> {
        return this.request<MMUser[]>(`/users/search${buildQuery({term, team_id: teamId})}`, {method: 'POST', body: {term, team_id: teamId}});
    }

    updateUserStatus(userId: string, status: string): Promise<any> {
        return this.request(`/users/${userId}/status`, {method: 'PUT', body: {user_id: userId, status}});
    }

    updateUserCustomStatus(userId: string, status: {emoji: string; text: string; duration?: string; expires_at?: string}): Promise<any> {
        return this.request(`/users/${userId}/status/custom`, {method: 'PUT', body: status});
    }

    unsetUserCustomStatus(userId: string): Promise<any> {
        return this.request(`/users/${userId}/status/custom`, {method: 'DELETE'});
    }

    sendTyping(userId: string, channelId: string, parentId?: string): Promise<any> {
        return this.request(`/users/${userId}/typing`, {method: 'POST', body: {channel_id: channelId, parent_id: parentId}});
    }

    // ---------------------------------------------------------------- channels

    getChannel(channelId: string): Promise<MMChannel> {
        return this.request<MMChannel>(`/channels/${channelId}`);
    }

    getChannelByName(teamId: string, name: string): Promise<MMChannel> {
        return this.request<MMChannel>(`/teams/${teamId}/channels/name/${encodeURIComponent(name)}`);
    }

    createDirectChannel(userIds: string[]): Promise<MMChannel> {
        return this.request<MMChannel>('/channels/direct', {method: 'POST', body: userIds});
    }

    createGroupChannel(userIds: string[]): Promise<MMChannel> {
        return this.request<MMChannel>('/channels/group', {method: 'POST', body: userIds});
    }

    createChannel(teamId: string, channel: Partial<MMChannel>): Promise<MMChannel> {
        return this.request<MMChannel>('/channels', {method: 'POST', body: {...channel, team_id: teamId}});
    }

    updateChannel(channelId: string, patch: Partial<MMChannel>): Promise<MMChannel> {
        return this.request<MMChannel>(`/channels/${channelId}`, {method: 'PUT', body: {id: channelId, ...patch}});
    }

    deleteChannel(channelId: string): Promise<any> {
        return this.request(`/channels/${channelId}`, {method: 'DELETE'});
    }

    leaveChannel(channelId: string): Promise<any> {
        return this.request(`/channels/${channelId}/members/me`, {method: 'DELETE'});
    }

    addChannelMember(channelId: string, userId: string): Promise<any> {
        return this.request(`/channels/${channelId}/members`, {method: 'POST', body: {user_id: userId}});
    }

    removeChannelMember(channelId: string, userId: string): Promise<any> {
        return this.request(`/channels/${channelId}/members/${userId}`, {method: 'DELETE'});
    }

    getChannelMembers(channelId: string, page = 0, perPage = 60): Promise<any[]> {
        return this.request(`/channels/${channelId}/members${buildQuery({page, per_page: perPage})}`);
    }

    getChannelStats(channelId: string): Promise<{member_count: number; guest_count?: number; pinnedpost_count?: number}> {
        return this.request(`/channels/${channelId}/stats`);
    }

    updateChannelNotifyProps(channelId: string, userId: string, props: Record<string, string>): Promise<any> {
        return this.request(`/channels/${channelId}/members/${userId}/notify_props`, {method: 'PUT', body: props});
    }

    /**
     * View a channel as the current user (clears its unread badge).
     * The route is POST /channels/members/{user_id}/view - the channel id travels in the body,
     * exactly like Client4.ViewChannel does. There is no /channels/{channel_id}/view and no
     * /channels/{channel_id}/members/{user_id}/view; those miss the router and come back as
     * api.context.404.app_error.
     */
    viewChannel(channelId: string, prevChannelId?: string): Promise<any> {
        const userId = getState().entities?.users?.currentUserId || '';
        if (!channelId || !userId) {
            return Promise.resolve(null);
        }
        return this.request(`/channels/members/${userId}/view`, {
            method: 'POST',
            body: {channel_id: channelId, prev_channel_id: prevChannelId},
        });
    }

    /**
     * Mark a channel as unread starting from the given post (POST /users/{user_id}/posts/{post_id}/set_unread).
     * Returns the resulting ChannelUnread state (msg_count, mention_count, last_viewed_at, ...).
     */
    markPostAsUnread(userId: string, postId: string): Promise<{
        channel_id: string;
        msg_count: number;
        msg_count_root: number;
        mention_count: number;
        mention_count_root: number;
        urgent_mention_count: number;
        last_viewed_at: number;
    }> {
        return this.request(`/users/${userId}/posts/${postId}/set_unread`, {
            method: 'POST',
            body: {collapsed_threads_supported: true},
        });
    }

    searchChannels(teamId: string, term: string): Promise<MMChannel[]> {
        return this.request<MMChannel[]>('/channels/search', {method: 'POST', body: {term, team_id: teamId}});
    }

    // ---------------------------------------------------------------- posts

    getPosts(channelId: string, page = 0, perPage = 60): Promise<{order: string[]; posts: Record<string, MMPost>; next_post_id?: string; prev_post_id?: string}> {
        return this.request(`/channels/${channelId}/posts${buildQuery({page, per_page: perPage})}`);
    }

    getPostsBefore(channelId: string, postId: string, perPage = 60): Promise<{order: string[]; posts: Record<string, MMPost>}> {
        return this.request(`/channels/${channelId}/posts${buildQuery({before: postId, per_page: perPage})}`);
    }

    getPostsAfter(channelId: string, postId: string, perPage = 60): Promise<{order: string[]; posts: Record<string, MMPost>}> {
        return this.request(`/channels/${channelId}/posts${buildQuery({after: postId, per_page: perPage})}`);
    }

    createPost(post: {channel_id: string; message: string; root_id?: string; file_ids?: string[]; pending_post_id?: string; props?: Record<string, any>}): Promise<MMPost> {
        return this.request<MMPost>('/posts', {method: 'POST', body: post});
    }

    patchPost(postId: string, patch: {message?: string; props?: Record<string, any>}): Promise<MMPost> {
        return this.request<MMPost>(`/posts/${postId}/patch`, {method: 'PUT', body: {id: postId, ...patch}});
    }

    deletePost(postId: string): Promise<any> {
        return this.request(`/posts/${postId}`, {method: 'DELETE'});
    }

    getPostThread(postId: string): Promise<{order: string[]; posts: Record<string, MMPost>}> {
        return this.request(`/posts/${postId}/thread`);
    }

    getPost(postId: string): Promise<MMPost> {
        return this.request(`/posts/${postId}`);
    }

    pinPost(postId: string): Promise<any> {
        return this.request(`/posts/${postId}/pin`, {method: 'POST'});
    }

    unpinPost(postId: string): Promise<any> {
        return this.request(`/posts/${postId}/unpin`, {method: 'POST'});
    }

    searchPosts(teamId: string, terms: string, opts: {isOrSearch?: boolean; page?: number; perPage?: number} = {}): Promise<{order: string[]; posts: Record<string, MMPost>; matches?: Record<string, string[]>}> {
        return this.request('/posts/search', {
            method: 'POST',
            body: {
                terms,
                is_or_search: opts.isOrSearch ?? false,
                page: opts.page ?? 0,
                per_page: opts.perPage ?? 30,
                team_id: teamId,
            },
        });
    }

    // ---------------------------------------------------------------- reactions

    addReaction(userId: string, postId: string, emojiName: string): Promise<MMReaction> {
        return this.request<MMReaction>('/reactions', {method: 'POST', body: {user_id: userId, post_id: postId, emoji_name: emojiName, create_at: 0}});
    }

    removeReaction(userId: string, postId: string, emojiName: string): Promise<any> {
        return this.request(`/users/${userId}/posts/${postId}/reactions/${encodeURIComponent(emojiName)}`, {method: 'DELETE'});
    }

    // ---------------------------------------------------------------- files

    async uploadFile(channelId: string, file: File, clientId: string): Promise<{file_infos: MMFileInfo[]}> {
        const form = new FormData();
        form.append('channel_id', channelId);
        form.append('client_ids', clientId);
        form.append('files', file, file.name);
        return this.request<{file_infos: MMFileInfo[]}>('/files', {method: 'POST', body: form, raw: true});
    }

    // ---------------------------------------------------------------- preferences / session

    // Mattermost's sidebar-category endpoints. The stock app persists manual chat order and
    // sorting through PUT /users/{user_id}/teams/{team_id}/channels/categories — the API
    // documented as "can be used to reorder the channels in these categories".
    updateChannelCategories(userId: string, teamId: string, categories: MMChannelCategory[]): Promise<MMChannelCategory[]> {
        return this.request(`/users/${userId}/teams/${teamId}/channels/categories`, {method: 'PUT', body: categories});
    }

    savePreferences(preferences: MMPreference[]): Promise<any> {
        return this.request('/users/me/preferences', {method: 'PUT', body: preferences});
    }

    deletePreferences(preferences: MMPreference[]): Promise<any> {
        return this.request('/users/me/preferences/delete', {method: 'POST', body: preferences});
    }

    // ---------------------------------------------------------------- emoji

    getCustomEmojis(page = 0, perPage = 200): Promise<MMCustomEmoji[]> {
        return this.request<MMCustomEmoji[]>(`/emoji${buildQuery({page, per_page: perPage})}`);
    }

    searchCustomEmojis(term: string): Promise<MMCustomEmoji[]> {
        return this.request<MMCustomEmoji[]>('/emoji/search', {method: 'POST', body: {term, prefix_only: false}});
    }

    // ---------------------------------------------------------------- misc

    getClientConfig(): Promise<any> {
        return this.request('/config/client');
    }

    getConfig(): Promise<any> {
        return this.request('/config');
    }

    getTeamsForUser(userId: string): Promise<any[]> {
        return this.request(`/users/${userId}/teams`);
    }

    getTeamMembersForUser(userId: string): Promise<any[]> {
        return this.request(`/users/${userId}/teams/members`);
    }

    // ---------------------------------------------------------------- view tracking (server component)

    /** Records that the current user has seen the given posts (POST /plugins/.../api/v1/views). */
    recordPostViews(postIds: string[]): Promise<{recorded: number}> {
        return this.pluginRequest('/api/v1/views', {method: 'POST', body: {post_ids: postIds}});
    }

    /** View counts for the given posts plus whether the current user has seen each one. */
    getPostViewStats(postIds: string[]): Promise<{counts: Record<string, number>; seen: Record<string, boolean>}> {
        return this.pluginRequest('/api/v1/views', {query: {post_ids: postIds.join(',')}});
    }
}

export const api = new MattermostAPI();
