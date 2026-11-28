import React, {useEffect, useState} from 'react';
import {api} from '../mm/api';
import {useSelector} from '../mm/store';
import type {MMPost, MMUser} from '../mm/types';
import {displayName, toPlainPreview} from '../mm/utils';
import {useTg} from './context';

interface Participant {
    username?: string;
    userId?: string;
}

const participantIsAuthor = new Set([
    'system_join_channel', 'system_guest_join_channel', 'system_leave_channel',
    'system_join_team', 'system_leave_team', 'system_remove_from_team',
]);

function useParticipantProfile({username, userId}: Participant): MMUser | undefined {
    const cached = useSelector((state) => {
        const profiles = state.entities?.users?.profiles;
        if (userId) return profiles?.[userId];
        return username ? Object.values(profiles || {}).find((user) => user.username === username) : undefined;
    });
    const key = userId ? `id:${userId}` : `username:${username}`;
    const [loaded, setLoaded] = useState<{key: string; user?: MMUser}>();
    useEffect(() => {
        if (cached || (!userId && !username)) return;
        let cancelled = false;
        api.getUserProfile({userId, username}).then((user) => {
            if (!cancelled) setLoaded({key, user});
        }).catch(() => undefined);
        return () => { cancelled = true; };
    }, [cached, key, userId, username]);
    return cached || (loaded?.key === key ? loaded.user : undefined);
}

function SystemUserLink({person: {username, userId}, user, original}: {person: Participant; user?: MMUser; original: string}) {
    const {actions} = useTg();
    const name = displayName(user);
    const originalIsId = original.replace(/^@/, '') === userId;
    const fallback = originalIsId ? (user?.username || username || 'User') : original;
    const label = name && name !== user?.username ? name : fallback;
    return <button type="button" className="tgw-system-user-link"
        aria-label={`Open profile for ${label}`}
        onClick={() => actions.openModal('userProfile', {userId: userId || user?.id, username})}>{label}</button>;
}

/** Keep the server's wording around participant names. */
export function SystemMessage({post}: {post: MMPost}) {
    const props = post.props || {};
    const added = props.addedUsername || props.addedUserId;
    const removed = !added && (props.removedUsername || props.removedUserId);
    const actorIsAuthor = added || participantIsAuthor.has(post.type);
    const actor = removed ? {} : {username: props.username, userId: props.userId || (actorIsAuthor ? post.user_id : undefined)};
    const affected = removed ? {username: props.removedUsername || props.username, userId: props.removedUserId || props.userId}
        : {username: props.addedUsername, userId: props.addedUserId};
    const actorProfile = useParticipantProfile(actor);
    const affectedProfile = useParticipantProfile(affected);
    const participants = [{person: affected, user: affectedProfile}, {person: actor, user: actorProfile}];
    // Older posts can carry the user ID while the username appears only in the message.
    const aliases = participants.flatMap(({person, user}) => [person.username || user?.username, person.userId]
        .filter((value) => typeof value === 'string' && value.length)
        .map((value) => ({person, user, value})))
        .sort((a, b) => b.value.length - a.value.length);
    const fallback = post.type === 'system_add_to_channel' && props.addedUsername && props.username
        ? `${props.addedUsername} added to the channel by ${props.username}.`
        : props.removedUsername ? `${props.removedUsername} left` : props.username ? `${props.username} joined` : 'System message';
    const text = toPlainPreview(post.message) || fallback;
    const parts: React.ReactNode[] = [];
    let start = 0;
    for (let index = 0; index < text.length; index++) {
        if (index && /[\w.@-]/.test(text[index - 1])) continue;
        const tokenStart = index + (text[index] === '@' ? 1 : 0);
        const match = aliases.find(({value}) => {
            if (!text.startsWith(value, tokenStart)) return false;
            const end = tokenStart + value.length;
            return !/[\w-]/.test(text[end] || '') && !(text[end] === '.' && /[\w-]/.test(text[end + 1] || ''));
        });
        if (!match) continue;
        const end = tokenStart + match.value.length;
        const {person, user} = match;
        parts.push(text.slice(start, index));
        parts.push(<SystemUserLink key={index} person={person} user={user} original={text.slice(index, end)}/>);
        start = end;
        index = end - 1;
    }
    parts.push(text.slice(start));
    return <span>{parts}</span>;
}
