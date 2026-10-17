// Message body rendering.
//
// Mattermost exposes its own formatter and its React renderer to plugins as window.PostUtils.
// Using it gives us 1:1 parity with the server rendered messages (markdown, mentions, custom
// emoji, channel links, latex, ...). A small fallback renderer keeps the UI usable if that
// surface ever changes.

import React from 'react';
import {replaceShortcodes} from '../mm/emoji';
import {copyToClipboard, escapeHtml} from '../mm/utils';
import {TgContext} from './context';

interface PostUtilsShape {
    formatText?: (text: string, options?: any, emojiMap?: any) => string;
    messageHtmlToComponent?: (html: string, options?: any) => React.ReactNode;
}

function postUtils(): PostUtilsShape | null {
    const utils = (window as any).PostUtils;
    if (utils && typeof utils.formatText === 'function' && typeof utils.messageHtmlToComponent === 'function') {
        return utils;
    }
    return null;
}

export interface MessageBodyProps {
    message: string;
    postId?: string;
    editedAt?: number;
    mentionKeys?: Array<{key: string; caseSensitive?: boolean}>;
    className?: string;
}

class BodyBoundary extends React.Component<{fallback: React.ReactNode; children: React.ReactNode}, {failed: boolean}> {
    constructor(props: {fallback: React.ReactNode; children: React.ReactNode}) {
        super(props);
        this.state = {failed: false};
    }

    static getDerivedStateFromError() {
        return {failed: true};
    }

    componentDidCatch(error: Error) {
        // eslint-disable-next-line no-console
        console.warn('[telegram-web-ui] falling back to the built-in message renderer', error);
    }

    render() {
        if (this.state.failed) {
            return this.props.fallback;
        }
        return this.props.children;
    }
}

/**
 * Inline code copies itself on click (Telegram-style). The click is delegated from the body span
 * because the host formatter owns the rendered tree — we cannot attach handlers to its nodes.
 * Fenced blocks and in-progress text selections are left alone.
 */
function handleBodyClick(event: React.MouseEvent<HTMLSpanElement>, toast?: (message: string, kind?: 'info' | 'error' | 'success') => void) {
    const target = event.target as HTMLElement;
    const code = target.closest('code');
    if (!code || !event.currentTarget.contains(code)) {
        return;
    }
    if (code.closest('pre') || code.classList.contains('tgw-code-block')) {
        return;
    }
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
        return;
    }
    const text = code.textContent || '';
    if (!text) {
        return;
    }
    copyToClipboard(text).then(() => {
        code.classList.add('tgw-code-copied');
        window.setTimeout(() => code.classList.remove('tgw-code-copied'), 900);
        if (toast) {
            toast('Code copied', 'success');
        }
    }).catch(() => {
        if (toast) {
            toast('Could not copy code', 'error');
        }
    });
}

export function MessageBody({message, postId, editedAt, mentionKeys, className}: MessageBodyProps) {
    const tg = React.useContext(TgContext);
    const onClick = (event: React.MouseEvent<HTMLSpanElement>) => handleBodyClick(event, tg?.actions.toast);
    const fallback = <span className={className} dir="auto" onClick={onClick}>{renderFallback(message, mentionKeys)}</span>;

    if (!message) {
        return fallback;
    }

    const utils = postUtils();
    if (!utils) {
        return fallback;
    }

    let rendered: React.ReactNode = null;
    try {
        const html = utils.formatText!(
            message,
            {
                markdown: true,
                mentionHighlight: true,
                atMentions: true,
                emoticons: true,
                mentionKeys,
                singleline: false,
                unsafeLinks: false,
                editedAt,
                postId,
            },
            undefined,
        );
        rendered = utils.messageHtmlToComponent!(html, {
            mentions: true,
            mentionHighlight: true,
            emoji: true,
            images: true,
            latex: true,
            postId,
            editedAt,
        });
    } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('[telegram-web-ui] post formatting failed, using the fallback renderer', error);
        return fallback;
    }

    return (
        <BodyBoundary fallback={fallback}>
            <span className={`tgw-message-body ${className || ''}`} dir="auto" onClick={onClick}>{rendered}</span>
        </BodyBoundary>
    );
}

/** Plain-JSX renderer used when the host formatter is unavailable. */
export function renderFallback(message: string, mentionKeys?: Array<{key: string; caseSensitive?: boolean}>): React.ReactNode {
    if (!message) {
        return null;
    }

    const blocks = message.split(/```/);
    const nodes: React.ReactNode[] = [];

    blocks.forEach((block, blockIndex) => {
        if (blockIndex % 2 === 1) {
            // fenced code block
            const lines = block.replace(/^[a-zA-Z0-9+-]*\n?/, '');
            nodes.push(
                <code key={`code-${blockIndex}`} className="tgw-code-block">{lines.replace(/\n$/, '')}</code>,
            );
            return;
        }
        nodes.push(...renderInline(block, blockIndex, mentionKeys));
    });

    return nodes;
}

function renderInline(text: string, keyPrefix: number, mentionKeys?: Array<{key: string; caseSensitive?: boolean}>): React.ReactNode[] {
    const nodes: React.ReactNode[] = [];
    // Order matters: inline code first so its content is not formatted any further.
    const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(~~[^~]+~~)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))|(https?:\/\/[^\s<>()]+)|(@[a-zA-Z0-9._-]+)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let index = 0;

    const mentionNames = (mentionKeys || [])
        .map((entry) => entry.key.replace(/^@/, '').toLowerCase())
        .filter(Boolean);

    while ((match = pattern.exec(text)) !== null) {
        if (match.index > lastIndex) {
            nodes.push(...renderTextWithLinks(text.slice(lastIndex, match.index), `${keyPrefix}-t${index++}`));
        }
        const [full, code, bold, underline, strike, italic, link, url, mention] = match;
        const key = `${keyPrefix}-${index++}`;
        if (code) {
            nodes.push(<code key={key} className="tgw-inline-code">{code.slice(1, -1)}</code>);
        } else if (bold) {
            nodes.push(<strong key={key}>{bold.slice(2, -2)}</strong>);
        } else if (underline) {
            nodes.push(<u key={key}>{underline.slice(2, -2)}</u>);
        } else if (strike) {
            nodes.push(<del key={key}>{strike.slice(2, -2)}</del>);
        } else if (italic) {
            nodes.push(<em key={key}>{italic.slice(1, -1)}</em>);
        } else if (link) {
            const parts = /\[([^\]]+)\]\(([^)]+)\)/.exec(link)!;
            nodes.push(
                <a key={key} href={parts[2]} target="_blank" rel="noopener noreferrer">{parts[1]}</a>,
            );
        } else if (url) {
            nodes.push(
                <a key={key} href={url} target="_blank" rel="noopener noreferrer">{url}</a>,
            );
        } else if (mention) {
            const name = mention.slice(1).toLowerCase();
            const isSelf = mentionNames.includes(name);
            nodes.push(<span key={key} className={`tgw-mention ${isSelf ? 'tgw-mention-self' : ''}`}>{mention}</span>);
        }
        lastIndex = match.index + full.length;
    }

    if (lastIndex < text.length) {
        nodes.push(...renderTextWithLinks(text.slice(lastIndex), `${keyPrefix}-tail`));
    }

    return nodes;
}

function renderTextWithLinks(text: string, keyPrefix: string): React.ReactNode[] {
    const withEmoji = replaceShortcodes(text);
    const lines = withEmoji.split('\n');
    const nodes: React.ReactNode[] = [];
    lines.forEach((line, lineIndex) => {
        if (lineIndex > 0) {
            nodes.push(<br key={`${keyPrefix}-br-${lineIndex}`}/>);
        }
        const quote = /^&gt;\s?/.test(line) || /^>\s?/.test(line);
        const content = line.replace(/^(&gt;|>)\s?/, '');
        nodes.push(
            <span key={`${keyPrefix}-line-${lineIndex}`} className={quote ? 'tgw-quote' : undefined}>
                {content}
            </span>,
        );
    });
    return nodes;
}

/** Used by the "message hit" list: strips markdown but keeps the search term visible. */
export function highlightTerm(text: string, term: string): React.ReactNode {
    if (!term) {
        return text;
    }
    const index = text.toLowerCase().indexOf(term.toLowerCase());
    if (index === -1) {
        return text;
    }
    return (
        <>
            {text.slice(0, index)}
            <mark>{text.slice(index, index + term.length)}</mark>
            {text.slice(index + term.length)}
        </>
    );
}

export function htmlToText(html: string): string {
    return escapeHtml(html).replace(/<[^>]+>/g, '');
}
