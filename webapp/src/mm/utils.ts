// Formatting + naming helpers shared by the whole UI.

import type {MMChannel, MMFileInfo, MMUser} from './types';

export const DAY = 24 * 60 * 60 * 1000;

export function displayName(user?: MMUser | null): string {
    if (!user) {
        return '';
    }
    const nickname = (user.nickname || '').trim();
    if (nickname) {
        return nickname;
    }
    const full = `${user.first_name || ''} ${user.last_name || ''}`.trim();
    if (full) {
        return full;
    }
    return user.username || '';
}

export function fullNameWithUsername(user?: MMUser | null): string {
    if (!user) {
        return '';
    }
    const name = displayName(user);
    if (name && name.toLowerCase() !== (user.username || '').toLowerCase()) {
        return `${name} (@${user.username})`;
    }
    return `@${user.username || ''}`;
}

/** DM/GM channels keep their member ids in the channel name, separated by "__". */
export function channelMemberIds(channel?: MMChannel | null): string[] {
    if (!channel || (channel.type !== 'D' && channel.type !== 'G')) {
        return [];
    }
    return (channel.name || '').split('__').filter(Boolean);
}

export function initialsFor(name: string): string {
    const clean = (name || '?').trim();
    if (!clean) {
        return '?';
    }
    const words = clean.split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
        return (words[0][0] + words[1][0]).toUpperCase();
    }
    const single = words[0];
    // Emojis and CJK characters should not be cut in half.
    const chars = Array.from(single);
    if (chars.length === 1) {
        return chars[0].toUpperCase();
    }
    return chars.slice(0, 2).join('').toUpperCase();
}

// Telegram-like deterministic avatar colors.
export const AVATAR_COLORS = [
    '#e17076',
    '#7bc862',
    '#e5ca77',
    '#65aadd',
    '#a695e7',
    '#ee7aae',
    '#6ec9cb',
    '#faa774',
];

export function colorForKey(key: string): string {
    let hash = 0;
    const value = key || '';
    for (let i = 0; i < value.length; i++) {
        hash = (hash * 31 + value.charCodeAt(i)) % 1000000007;
    }
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export interface TimeFormat {
    military: boolean;
    locale: string;
}

function pad(value: number): string {
    return value < 10 ? `0${value}` : String(value);
}

export function formatTime(timestamp: number, fmt: TimeFormat): string {
    const date = new Date(timestamp);
    const hours = date.getHours();
    if (fmt.military) {
        return `${pad(hours)}:${pad(date.getMinutes())}`;
    }
    const isPm = hours >= 12;
    const hour12 = hours % 12 === 0 ? 12 : hours % 12;
    return `${hour12}:${pad(date.getMinutes())} ${isPm ? 'PM' : 'AM'}`;
}

function startOfDay(date: Date): number {
    const copy = new Date(date.getTime());
    copy.setHours(0, 0, 0, 0);
    return copy.getTime();
}

/** Compact timestamp shown on the right of a chat list row / message. */
export function formatChatTime(timestamp: number, fmt: TimeFormat): string {
    if (!timestamp) {
        return '';
    }
    const now = new Date();
    const date = new Date(timestamp);
    const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / DAY);
    if (dayDiff <= 0) {
        return formatTime(timestamp, fmt);
    }
    if (dayDiff === 1) {
        return 'Yesterday';
    }
    if (dayDiff < 7) {
        return date.toLocaleDateString(fmt.locale, {weekday: 'short'});
    }
    return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${String(date.getFullYear()).slice(-2)}`;
}

export function formatDateSeparator(timestamp: number, fmt: TimeFormat): string {
    const now = new Date();
    const date = new Date(timestamp);
    const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / DAY);
    if (dayDiff <= 0) {
        return 'Today';
    }
    if (dayDiff === 1) {
        return 'Yesterday';
    }
    const sameYear = date.getFullYear() === now.getFullYear();
    return date.toLocaleDateString(fmt.locale, {month: 'long', day: 'numeric', year: sameYear ? undefined : 'numeric'});
}

export function formatLastSeen(timestamp: number, fmt: TimeFormat): string {
    if (!timestamp) {
        return 'last seen recently';
    }
    const now = new Date();
    const date = new Date(timestamp);
    const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / DAY);
    if (dayDiff <= 0) {
        return 'last seen today';
    }
    if (dayDiff === 1) {
        return 'last seen yesterday';
    }
    return `last seen ${formatDateSeparator(timestamp, fmt).toLowerCase()}`;
}

export function statusLabel(status?: string, lastActivity?: number, fmt?: TimeFormat): string {
    switch (status) {
    case 'online':
        return 'online';
    case 'away':
        return 'away';
    case 'dnd':
        return 'do not disturb';
    case 'ooo':
        return 'out of office';
    case 'offline':
    case undefined:
    case null:
        return fmt && lastActivity ? formatLastSeen(lastActivity + 5000, fmt) : 'offline';
    default:
        return status;
    }
}

export function formatBytes(bytes: number): string {
    if (!bytes) {
        return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** "7:05" / "0:07" style duration label for voice messages and recordings. */
export function formatDuration(ms: number): string {
    const total = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export type FileKind = 'image' | 'video' | 'audio' | 'pdf' | 'archive' | 'code' | 'file';

export function fileKindOf(nameOrMime = ''): FileKind {
    const value = nameOrMime.toLowerCase();
    const extension = value.includes('.') ? value.split('.').pop()!.split('?')[0] : '';
    // The mime type wins over the extension: a recording named voice.webm is audio, not video.
    if (/^image\//.test(value)) {
        return 'image';
    }
    if (/^audio\//.test(value)) {
        return 'audio';
    }
    if (/^video\//.test(value)) {
        return 'video';
    }
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic'].includes(extension)) {
        return 'image';
    }
    if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(extension)) {
        return 'video';
    }
    if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(extension)) {
        return 'audio';
    }
    if (extension === 'pdf' || value === 'application/pdf') {
        return 'pdf';
    }
    if (['zip', 'tar', 'gz', '7z', 'rar'].includes(extension)) {
        return 'archive';
    }
    if (['js', 'ts', 'tsx', 'jsx', 'json', 'go', 'py', 'java', 'rb', 'rs', 'c', 'cpp', 'h', 'css', 'html', 'yml', 'yaml', 'sh', 'sql'].includes(extension)) {
        return 'code';
    }
    return 'file';
}

/** Short stand-in text for a post that carries attachments but little or no message. */
export function attachmentSummary(files?: MMFileInfo[] | null): string {
    if (!files?.length) {
        return '';
    }
    const kinds = files.map((file) => fileKindOf(file.mime_type || file.name));
    if (kinds.includes('audio')) {
        return '🎤 Voice message';
    }
    if (kinds.includes('image') && files.length === 1) {
        return '📷 Photo';
    }
    if (kinds.includes('video')) {
        return '🎬 Video';
    }
    return 'Attachment';
}

export function escapeHtml(text: string): string {
    return (text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Turns message markdown into something acceptable for a oneline preview. */
export function toPlainPreview(message: string, limit = 260): string {
    let text = (message || '')
        .replace(/```[\s\S]*?```/g, ' [code] ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' [image] ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/(\*\*|__|~~|\*|_)/g, '')
        .replace(/^\s*&gt;\s?/gm, '')
        .replace(/^\s*>\s?/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (text.length > limit) {
        text = `${text.slice(0, limit)}…`;
    }
    return text;
}

export function truncate(text: string, limit: number): string {
    if (!text || text.length <= limit) {
        return text || '';
    }
    return `${text.slice(0, limit)}…`;
}

export function debounce<T extends (...args: any[]) => void>(fn: T, wait: number): T & {cancel: () => void} {
    let timer: any = null;
    const wrapped = ((...args: any[]) => {
        if (timer) {
            clearTimeout(timer);
        }
        timer = setTimeout(() => {
            timer = null;
            fn(...args);
        }, wait);
    }) as T & {cancel: () => void};
    wrapped.cancel = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    };
    return wrapped;
}

export function throttle<T extends (...args: any[]) => void>(fn: T, wait: number): T {
    let last = 0;
    let timer: any = null;
    return ((...args: any[]) => {
        const now = Date.now();
        const remaining = wait - (now - last);
        if (remaining <= 0) {
            last = now;
            fn(...args);
        } else if (!timer) {
            timer = setTimeout(() => {
                timer = null;
                last = Date.now();
                fn(...args);
            }, remaining);
        }
    }) as T;
}

export function isSameDay(a: number, b: number): boolean {
    return startOfDay(new Date(a)) === startOfDay(new Date(b));
}

export function pluralize(count: number, singular: string, plural?: string): string {
    return count === 1 ? singular : (plural || `${singular}s`);
}

export function memberCountLabel(count: number): string {
    if (!count) {
        return '';
    }
    const short = count >= 1000 ? `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}K` : String(count);
    return `${short} ${pluralize(count, 'member')}`;
}

export function copyToClipboard(text: string): Promise<void> {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve) => {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand('copy');
        } catch (err) {
            // ignore
        }
        document.body.removeChild(textarea);
        resolve();
    });
}
