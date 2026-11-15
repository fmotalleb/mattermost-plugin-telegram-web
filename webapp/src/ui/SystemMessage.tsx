import React from 'react';
import {useSelector} from '../mm/store';
import type {MMPost} from '../mm/types';
import {toPlainPreview} from '../mm/utils';
import {useTg} from './context';

/** Keep the server's wording, linking only the participants identified by its metadata. */
export function SystemMessage({post}: {post: MMPost}) {
    const {actions} = useTg();
    const profiles = useSelector((state) => state.entities?.users?.profiles || {});
    const props = post.props || {};
    const participants = post.type === 'system_add_to_channel'
        ? [{username: props.addedUsername, userId: props.addedUserId}, {username: props.username, userId: props.userId || post.user_id}]
        : [{username: props.removedUsername || props.username, userId: props.removedUserId || props.userId}];
    const people = participants.filter((person) => typeof person.username === 'string' && person.username.length)
        .map((person) => ({...person, userId: person.userId || Object.values(profiles).find((user) => user.username === person.username)?.id}))
        .sort((a, b) => b.username.length - a.username.length);
    const fallback = post.type === 'system_add_to_channel' && props.addedUsername && props.username
        ? `${props.addedUsername} added to the channel by ${props.username}.`
        : props.removedUsername ? `${props.removedUsername} left` : props.username ? `${props.username} joined` : 'System message';
    const text = toPlainPreview(post.message) || fallback;
    const parts: React.ReactNode[] = [];
    let start = 0;
    for (let index = 0; index < text.length; index++) {
        if (index && /[\w.@-]/.test(text[index - 1])) continue;
        const person = people.find(({username}) => {
            const label = text[index] === '@' ? `@${username}` : username;
            if (!text.startsWith(label, index)) return false;
            const end = index + label.length;
            return !/[\w-]/.test(text[end] || '') && !(text[end] === '.' && /[\w-]/.test(text[end + 1] || ''));
        });
        if (!person) continue;
        const end = index + person.username.length + (text[index] === '@' ? 1 : 0);
        parts.push(text.slice(start, index));
        parts.push(<button type="button" className="tgw-system-user-link" key={index}
            aria-label={`Open profile for ${person.username}`}
            onClick={() => actions.openModal('userProfile', {userId: person.userId, username: person.username})}>{text.slice(index, end)}</button>);
        start = end;
        index = end - 1;
    }
    parts.push(text.slice(start));
    return <span>{parts}</span>;
}
