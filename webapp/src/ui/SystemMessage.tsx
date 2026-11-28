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

function SystemUserLink({person: {username, userId}, original}: {person: Participant; original: string}) {
    const {actions} = useTg();
    const cached = useSelector((state) => {
        const profiles = state.entities?.users?.profiles;
        return userId ? profiles?.[userId] : Object.values(profiles || {}).find((user) => user.username === username);
    });
    const [loaded, setLoaded] = useState<MMUser>();
    useEffect(() => {
        if (cached) return;
        let cancelled = false;
        api.getUserProfile({userId, username}).then((user) => {
            if (!cancelled) setLoaded(user);
        }).catch(() => undefined);
        return () => { cancelled = true; };
    }, [cached, userId, username]);

    const user = cached || loaded;
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
    const actorIsAuthor = added || participantIsAuthor.has(post.type);
    const actor = {username: props.username, userId: props.userId || (actorIsAuthor ? post.user_id : undefined)};
    const participants: Participant[] = [actor];
    if (added) {
        participants.unshift({username: props.addedUsername, userId: props.addedUserId});
    } else if (props.removedUsername || props.removedUserId) {
        participants[0] = {username: props.removedUsername || props.username, userId: props.removedUserId || props.userId};
    }
    const aliases = participants.flatMap((person) => [person.username, person.userId]
        .filter((value) => typeof value === 'string' && value.length)
        .map((value) => ({person, value})))
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
        const {person} = match;
        parts.push(text.slice(start, index));
        parts.push(<SystemUserLink key={`${index}:${person.userId}:${person.username}`} person={person} original={text.slice(index, end)}/>);
        start = end;
        index = end - 1;
    }
    parts.push(text.slice(start));
    return <span>{parts}</span>;
}
