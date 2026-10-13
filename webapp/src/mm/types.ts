// Minimal, deliberately loose typings for the parts of the Mattermost web app Redux store that
// this plugin reads. The store is owned by the web app (mattermost-redux); we only consume it, so
// everything is optional/defensive and mirrors the upstream types of Mattermost v11.

export interface MMUser {
    id: string;
    username: string;
    first_name?: string;
    last_name?: string;
    nickname?: string;
    position?: string;
    email?: string;
    bot?: boolean;
    delete_at?: number;
    is_bot?: boolean;
    last_picture_update?: number;
    props?: Record<string, any>;
    timezone?: any;
}

export interface MMChannel {
    id: string;
    create_at: number;
    update_at: number;
    delete_at: number;
    team_id: string;
    type: 'O' | 'P' | 'D' | 'G';
    display_name: string;
    name: string;
    header: string;
    purpose: string;
    last_post_at: number;
    last_root_post_at?: number;
    creator_id: string;
    total_msg_count?: number;
    total_msg_count_root?: number;
    teammate_id?: string;
    status?: string;
    group_constrained?: boolean;
    shared?: boolean;
    props?: Record<string, any>;
}

export interface MMChannelMember {
    channel_id: string;
    user_id: string;
    roles?: string;
    last_viewed_at: number;
    msg_count: number;
    msg_count_root?: number;
    mention_count: number;
    mention_count_root?: number;
    urgent_mention_count?: number;
    notify_props?: {
        desktop?: string;
        mark_unread?: string;
        push?: string;
        ignore_channel_mentions?: string;
    };
    last_update_at: number;
    scheme_user?: boolean;
    scheme_admin?: boolean;
}

export interface MMChannelCategory {
    id: string;
    user_id: string;
    team_id: string;
    type: 'favorites' | 'channels' | 'direct_messages' | 'custom' | 'managed';
    display_name: string;
    sorting: 'alpha' | 'manual' | 'recent' | '';
    channel_ids: string[];
    muted: boolean;
    collapsed: boolean;
}

export interface MMPost {
    id: string;
    create_at: number;
    update_at: number;
    edit_at: number;
    delete_at: number;
    is_pinned: boolean;
    user_id: string;
    channel_id: string;
    root_id: string;
    original_id?: string;
    message: string;
    type: string;
    props: Record<string, any>;
    pending_post_id?: string;
    reply_count?: number;
    file_ids?: string[];
    metadata?: {
        files?: MMFileInfo[];
        embeds?: Array<{type: string; url: string; data?: any}>;
        images?: Record<string, {width: number; height: number; format: string; frameCount: number}>;
        reactions?: MMReaction[];
    };
    translations?: any;
    /** local-only flags added by the plugin */
    _pending?: boolean;
    _failed?: boolean;
}

export interface MMReaction {
    user_id: string;
    post_id: string;
    emoji_name: string;
    create_at: number;
}

export interface MMFileInfo {
    id: string;
    user_id: string;
    channel_id?: string;
    post_id?: string;
    create_at: number;
    update_at: number;
    delete_at: number;
    name: string;
    extension: string;
    size: number;
    mime_type: string;
    width: number;
    height: number;
    has_preview_image: boolean;
    clientId?: string;
}

export interface MMCustomEmoji {
    id: string;
    name: string;
    creator_id: string;
    create_at: number;
    update_at: number;
    delete_at: number;
}

export interface MMTeam {
    id: string;
    display_name: string;
    name: string;
    delete_at?: number;
}

export interface MMPreference {
    category: string;
    name: string;
    user_id: string;
    value: string;
}

export interface MMState {
    entities: {
        general: {config?: Record<string, any>; license?: Record<string, any>; serverVersion?: string; deviceId?: string};
        users: {
            currentUserId: string;
            profiles: Record<string, MMUser>;
            profilesInChannel: Record<string, Set<string> | string[]>;
            profilesInTeam: Record<string, Set<string> | string[]>;
            statuses: Record<string, string>;
            statusesByUserId?: Record<string, string>;
        };
        teams: {
            currentTeamId: string;
            teams: Record<string, MMTeam>;
            myMembers: Record<string, any>;
        };
        channels: {
            currentChannelId: string;
            channels: Record<string, MMChannel>;
            channelsInTeam: Record<string, Set<string> | string[]>;
            myMembers: Record<string, MMChannelMember>;
            membersInChannel: Record<string, Record<string, MMChannelMember>>;
            stats: Record<string, {member_count: number; guest_count?: number}>;
            channelsMemberCount?: Record<string, number>;
            manuallyUnread?: Record<string, boolean>;
            /** Mattermost v6.1+ keeps the total message counts here, not on the Channel objects. */
            messageCounts?: Record<string, {total: number; root: number}>;
        };
        channelCategories: {
            byId: Record<string, MMChannelCategory>;
            orderByTeam: Record<string, string[]>;
            managedCategoryMappings?: Record<string, Record<string, string>>;
        };
        posts: {
            posts: Record<string, MMPost>;
            postsInChannel: Record<string, Array<{order: string[]; recent?: boolean; oldest?: boolean}>>;
            postsInThread?: Record<string, string[]>;
            reactions: Record<string, Record<string, MMReaction>>;
        };
        preferences: {myPreferences: Record<string, MMPreference>};
        emojis: {customEmoji: Record<string, MMCustomEmoji>; nonExistentEmoji?: Set<string>};
        typing: Record<string, Record<string, number>>;
        files: {files: Record<string, MMFileInfo>; fileIdsByPostId?: Record<string, string[]>};
    };
    views?: any;
    websocket?: {connected: boolean};
}

export interface StoreLike {
    getState(): MMState;
    subscribe(listener: () => void): () => void;
    dispatch: (action: any) => any;
}
