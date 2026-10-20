// Icons, avatars and other small building blocks.

import React from 'react';
import {useSelector} from '../mm/store';
import {getSiteURL, getUser, getUsers} from '../mm/selectors';
import type {MMUser} from '../mm/types';
import {colorForKey, initialsFor} from '../mm/utils';

interface IconProps {
    size?: number;
    className?: string;
    filled?: boolean;
}

const make = (path: string, opts: {filled?: boolean; viewBox?: string; fillRule?: 'evenodd' | 'nonzero'} = {}) => {
    return function Icon({size = 24, className, filled}: IconProps) {
        const isFilled = filled === undefined ? opts.filled : filled;
        return (
            <svg
                className={className}
                width={size}
                height={size}
                viewBox={opts.viewBox || '0 0 24 24'}
                fill={isFilled ? 'currentColor' : 'none'}
                fillRule={opts.fillRule}
                stroke={isFilled ? 'none' : 'currentColor'}
                strokeWidth={isFilled ? 0 : 2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
            >
                <path d={path}/>
            </svg>
        );
    };
};

export const IconMenu = make('M3 6h18M3 12h18M3 18h18');
export const IconSearch = make('M10.5 3a7.5 7.5 0 1 0 4.55 13.45l4.25 4.25 1.4-1.4-4.25-4.25A7.5 7.5 0 0 0 10.5 3Zm0 2a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Z', {filled: true});
export const IconNewChat = make('M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2Zm-7 9h-2v2H9v-2H7V9h2V7h2v2h2Z', {filled: true});
export const IconSend = make('M2.5 21 23 12 2.5 3v7l13 2-13 2v7Z', {filled: true});
export const IconAttach = make('M16.5 6.5 8.6 14.4a2.5 2.5 0 1 0 3.5 3.5l8.6-8.6a4.5 4.5 0 1 0-6.4-6.4L5.5 11.7a6.5 6.5 0 1 0 9.2 9.2l7.3-7.3-1.4-1.4-7.3 7.3a4.5 4.5 0 0 1-6.4-6.4l8.9-8.9a2.5 2.5 0 0 1 3.5 3.5Z', {filled: true});
export const IconEmoji = make('M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-3.5 6a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm7 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM12 18c-2.3 0-4.3-1.3-5.3-3.2h10.6C16.3 16.7 14.3 18 12 18Z', {filled: true});
export const IconMore = make('M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z', {filled: true});
export const IconBack = make('M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20v-2Z', {filled: true});
export const IconForward = make('M4 11h12.2l-5.6-5.6L12 4l8 8-8 8-1.4-1.4 5.6-5.6H4v-2Z', {filled: true});
export const IconClose = make('M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3 1.4 1.4Z', {filled: true});
export const IconStar = make('M12 17.3 18.2 21l-1.6-7L22 9.2l-7.2-.6L12 2 9.2 8.6 2 9.2l5.4 4.8-1.6 7L12 17.3Z', {filled: true});
export const IconStarOutline = make('M12 4.5 13.6 9h4.7l-3.8 3.4 1.2 5-3.7-2.6-3.7 2.6 1.2-5L5.7 9h4.7L12 4.5Z');
export const IconMute = make('M21 4.8 19.2 3 15 7.2V6a3 3 0 0 0-6 0v6c0 .3 0 .6.1.8L3 12.9v2l4.2-.8 2.2 2.2c.3.5.9.9 1.6.9l1.4-1.4 6.6 6.6 1.8-1.8-9.8-9.8M18 12v-2.2l-4.5 4.5c.3.9 1.2 1.5 2.2 1.5 1.3 0 2.3-1 2.3-2.3V12Zm-3 6.5L6.5 10 5 11.5 12 18.5l3-3v3.8c0 1.5 1.2 2.7 2.7 2.7H20v-2h-2a1 1 0 0 1-1-1v-3.3l-2-2Z', {filled: true});
export const IconBell = make('M12 22a2.2 2.2 0 0 0 2.2-2.2h-4.4A2.2 2.2 0 0 0 12 22Zm7-5.5V11a7 7 0 0 0-5-6.7V3.5a2 2 0 1 0-4 0v.8A7 7 0 0 0 5 11v5.5L3 18.5v1h18v-1l-2-2Z', {filled: true});
export const IconCheck = make('M9.6 17.2 4.4 12l-1.4 1.4 6.6 6.6L21 8.6 19.6 7.2 9.6 17.2Z', {filled: true});
export const IconCheckDouble = make('M4 12.5 8.5 17 19.5 6M10 13 14 17 21 10');
export const IconClock = make('M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16Zm1-13h-2v6l4.3 2.6 1-1.7-3.3-2V7Z', {filled: true});
export const IconWarning = make('M12 2 1 21h22L12 2Zm1 15h-2v2h2v-2Zm0-7h-2v5h2v-5Z', {filled: true});
export const IconArrowDown = make('M12 21 5 14l1.4-1.4L11 17.2V3h2v14.2l4.6-4.6L19 14l-7 7Z', {filled: true});
export const IconInfo = make('M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 15h-2v-6h2v6Zm0-8h-2V7h2v2Z', {filled: true});
export const IconUsers = make('M16 11a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm-8 0a3 3 0 1 0-3-3 3 3 0 0 0 3 3Zm0 2c-2.7 0-6 1.3-6 3.5V19h8v-2.5c0-.9.5-1.9 1.4-2.7A12 12 0 0 0 8 13Zm8 0c-3 0-6 1.5-6 3.5V19h12v-2.5c0-2-3-3.5-6-3.5Z', {filled: true});
export const IconTrash = make('M9 3v1H4v2h16V4h-5V3H9ZM6 7v13a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6Zm3 2h2v10H9V9Zm4 0h2v10h-2V9Z', {filled: true});
export const IconEdit = make('M3 17.3V21h3.7L18.1 9.6l-3.7-3.7L3 17.3ZM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.7 3.7L20.7 7Z', {filled: true});
export const IconReply = make('M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11Z', {filled: true});

// Telegram's view tally: a solid eye with the iris knocked out (evenodd keeps the pupil).
export const IconEye = make('M12 5C7 5 2.7 8.1 1 12c1.7 3.9 6 7 11 7s9.3-3.1 11-7c-1.7-3.9-6-7-11-7Zm0 11.5A4.5 4.5 0 1 0 12 7.5a4.5 4.5 0 0 0 0 9Zm0-2a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z', {filled: true, fillRule: 'evenodd'});
export const IconPin = make('M16 3 8 11H6l-2 2 3 3-5 5 5-5 3 3 2-2v-2l8-8-4-4Z', {filled: true});
export const IconSettings = make('M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm9.4 5.5.1-1.5-.1-1.5-2.2-.5a7 7 0 0 0-.7-1.7l1.2-1.9-2.1-2.1-1.9 1.2a7 7 0 0 0-1.7-.7L15.5 3h-2.9l-.5 2.2a7 7 0 0 0-1.7.7L8.5 4.7 6.4 6.8l1.2 1.9a7 7 0 0 0-.7 1.7L4.7 11v3l2.2.5c.2.6.4 1.2.7 1.7l-1.2 1.9 2.1 2.1 1.9-1.2c.5.3 1.1.5 1.7.7l.5 2.3h2.9l.5-2.3c.6-.2 1.2-.4 1.7-.7l1.9 1.2 2.1-2.1-1.2-1.9c.3-.5.5-1.1.7-1.7l2.2-.5Z', {filled: true});
export const IconLink = make('M3.9 12a3 3 0 0 1 3-3h3V7h-3a5 5 0 0 0 0 10h3v-2h-3a3 3 0 0 1-3-3Zm4.1 1h8v-2H8v2Zm6-6h-3v2h3a3 3 0 0 1 0 6h-3v2h3a5 5 0 0 0 0-10Z', {filled: true});
export const IconDownload = make('M12 16 7 11l1.4-1.4L11 12.2V3h2v9.2l2.6-2.6L17 11l-5 5Zm-8 3v2h16v-2H4Z', {filled: true});
// Document with a folded corner — the shared-files menu toggle and its file rows.
export const IconFile = make('M6 2h8l4 4v16H6V2Zm7 1.5V7h4.5L13 3.5Z', {filled: true, fillRule: 'evenodd'});
export const IconPlay = make('M8 5v14l11-7L8 5Z', {filled: true});
export const IconPause = make('M7 5h4v14H7zM13 5h4v14h-4z', {filled: true});
export const IconStop = make('M8 5h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z', {filled: true});
export const IconMic = make('M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Zm7 9a7 7 0 0 1-6 6.93V21h3v2H8v-2h3v-3.07A7 7 0 0 1 5 11h2a5 5 0 0 0 10 0h2Z', {filled: true});
export const IconLogout = make('M10 17v-2H4V9h6V7l-8 5 8 5Zm3-14h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5v-2h5V5h-5V3Z', {filled: true});
export const IconPalette = make('M12 3a9 9 0 0 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8Zm-4.5 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z', {filled: true});
export const IconBold = ({size = 20}: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M6 4h7a4 4 0 0 1 0 8H6V4Zm0 8h8a4 4 0 0 1 0 8H6v-8Z"/>
    </svg>
);
export const IconItalic = ({size = 20}: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M10 4h8v2h-3l-3 12h3v2H7v-2h3l3-12h-3V4Z"/>
    </svg>
);
export const IconStrike = ({size = 20}: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M3 11h18v2H3v-2Zm5-4.5C8 5 9.9 4 12.3 4c2.2 0 4 .8 5.2 2.2l-1.6 1.4C15.1 6.7 13.9 6 12.4 6c-1.6 0-2.5.6-2.5 1.5 0 .8.7 1.3 2.3 1.8L3 9.2V11h18V9.1l-2.1-.1C16.5 8 15.4 7.2 14.6 6.6"/>
    </svg>
);
export const IconCode = ({size = 20}: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M9.4 16.6 4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4Zm5.2 0L19.2 12l-4.6-4.6L16 6l6 6-6 6-1.4-1.4Z"/>
    </svg>
);
export const IconQuote = ({size = 20}: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M7 17H3v-6a6 6 0 0 1 6-6v3a3 3 0 0 0-3 3h1v6Zm14 0h-4v-6a6 6 0 0 1 6-6v3a3 3 0 0 0-3 3h1v6Z"/>
    </svg>
);

export interface AvatarProps {
    userId?: string;
    profile?: MMUser;
    name: string;
    colorKey?: string;
    size?: number;
    online?: boolean;
    status?: string;
    showStatus?: boolean;
    className?: string;
}

function allowedToLoadAvatar(user?: MMUser): boolean {
    if (!user) {
        return false;
    }
    return user.delete_at === 0 || user.delete_at === undefined;
}

export function Avatar({userId, profile, name, colorKey, size = 54, status, showStatus, className}: AvatarProps) {
    const cachedUser = useSelector((state) => (userId ? getUser(state, userId) : undefined));
    const user = profile || cachedUser;
    const siteURL = useSelector(getSiteURL);
    const [failed, setFailed] = React.useState(false);
    const background = colorForKey(colorKey || userId || name);
    // Mattermost only serves a picture for users whose `last_picture_update` is set (see
    // mattermost-redux's imageURLForUser); without this check every avatar would request the image
    // endpoint and 404 for users that never uploaded one.
    const hasPicture = !!userId && allowedToLoadAvatar(user) && !!user?.last_picture_update && !failed;
    const url = hasPicture ? `${siteURL}/api/v4/users/${userId}/image${user?.last_picture_update ? `?_=${user.last_picture_update}` : ''}` : '';

    return (
        <span
            className={`tgw-avatar ${className || ''}`}
            style={{width: size, height: size, fontSize: Math.max(12, Math.round(size / 2.6)), background}}
        >
            {hasPicture && (
                <img
                    src={url}
                    alt=""
                    draggable={false}
                    onError={() => setFailed(true)}
                />
            )}
            {(!hasPicture || failed) && <span className="tgw-avatar-initials">{initialsFor(name)}</span>}
            {showStatus && <span className={`tgw-status-dot tgw-status-${status || 'offline'}`}/>}
        </span>
    );
}

export function Spinner({size = 28}: {size?: number}) {
    return <span className="tgw-spinner" style={{width: size, height: size}}/>;
}

export function IconButton({children, title, onClick, className, disabled}: {children: React.ReactNode; title?: string; onClick?: (event: React.MouseEvent) => void; className?: string; disabled?: boolean}) {
    return (
        <button
            type="button"
            title={title}
            aria-label={title}
            disabled={disabled}
            className={`tgw-icon-button ${className || ''}`}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

export function Badge({count, muted, mentions}: {count: number; muted?: boolean; mentions?: number}) {
    if (mentions && mentions > 0) {
        return <span className={`tgw-badge tgw-badge-mention ${muted ? 'tgw-badge-muted' : ''}`}>{mentions > 99 ? '99+' : mentions}</span>;
    }
    if (!count) {
        return <span className="tgw-badge tgw-badge-dot" data-muted={muted ? 'true' : 'false'}/>;
    }
    return <span className={`tgw-badge ${muted ? 'tgw-badge-muted' : ''}`}>{count > 99 ? '99+' : count}</span>;
}

export function usersByIds(users: Record<string, MMUser>, ids: string[]): MMUser[] {
    return ids.map((id) => users[id]).filter(Boolean);
}
