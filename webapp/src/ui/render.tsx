import {safeLinkURL} from '../mm/urls';
// Message body rendering.
//
// Mattermost exposes its own formatter and its React renderer to plugins as window.PostUtils.
// Using it gives us 1:1 parity with the server rendered messages (markdown, mentions, custom
// emoji, channel links, latex, ...). A small fallback renderer keeps the UI usable if that
// surface ever changes.

import React from 'react';
import {emojiChar, replaceShortcodes, replaceUnsupportedMattermostShortcodes, splitEmoji} from '../mm/emoji';
import {copyToClipboard, escapeHtml} from '../mm/utils';
import {TgContext} from './context';
import {MermaidDiagram} from './MermaidDiagram';
import {Emoji} from './Emoji';

// Keep host and fallback rendering on the same suffix list, with a boundary preventing a
// shorter suffix (such as .ch or .co) from linking only the start of a longer domain.
const BARE_DOMAIN_SOURCE = String.raw`(?:www\.)?(?:[\w-]+\.)+(?:com|org|net|io|ai|app|dev|co|me|info|biz|edu|gov|xyz|tech|site|store|cloud|blog|chat|sh|gg|to|fm|ly|tv|gl|st|uk|de|jp|fr|cn|ca|au|nl|es|it|ch|se|no|fi|ru|br|kr|eu|us)(?![\w-]|\.[\w-])(?::\d{2,5})?(?:[/?#][^\s<>()]*)?`;

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
    mentionKeys?: Array<{key: string; caseSensitive?: boolean}>;
    className?: string;
    onTaskToggle?: (index: number, checked: boolean) => void;
}

function markdownTaskStates(message: string): boolean[] {
    const states: boolean[] = [];
    const taskLine = /^\s*[-*+]\s+\[([ xX])\]\s+/gm;
    let match: RegExpExecArray | null;
    while ((match = taskLine.exec(message))) {
        states.push(match[1].toLowerCase() === 'x');
    }
    return states;
}

function normalizeHostLists(node: React.ReactNode, states: boolean[], onToggle?: MessageBodyProps['onTaskToggle']): React.ReactNode {
    let index = 0;
    const visit = (child: React.ReactNode): React.ReactNode => {
        if (Array.isArray(child)) {
            return child.map(visit);
        }
        if (!React.isValidElement(child)) {
            return child;
        }
        const props: any = child.props || {};
        if (child.type === 'input' && props.type === 'checkbox' && index < states.length) {
            const taskIndex = index++;
            return React.cloneElement(child as React.ReactElement<any>, {
                checked: states[taskIndex],
                disabled: !onToggle,
                onChange: (event: React.ChangeEvent<HTMLInputElement>) => onToggle?.(taskIndex, event.currentTarget.checked),
                'aria-label': states[taskIndex] ? 'Mark task incomplete' : 'Mark task complete',
            });
        }
        if (props.children !== undefined) {
            if (child.type === 'ol' && props.start == null) {
                // Older Mattermost formatters store the starting number in a CSS counter.
                const counter = /^list (-?\d+)$/.exec(props.style?.counterReset || '');
                if (counter) {
                    return React.cloneElement(child as React.ReactElement<any>, {start: Number(counter[1]) + 1}, visit(props.children));
                }
            }
            return React.cloneElement(child as React.ReactElement<any>, undefined, visit(props.children));
        }
        return child;
    };
    return visit(node);
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

export function MessageBody({message, postId, mentionKeys, className, onTaskToggle}: MessageBodyProps) {
    // Match complete fences (including other languages) so examples containing a nested
    // ```mermaid fence inside a longer fence remain ordinary code.
    const fences = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n/gm;
    const parts: React.ReactNode[] = [];
    let last = 0;
    let taskOffset = 0;
    let match: RegExpExecArray;
    const text = (value: string, key: number) => {
        const offset = taskOffset;
        taskOffset += markdownTaskStates(value).length;
        return <FormattedBody key={key} message={value} postId={postId} mentionKeys={mentionKeys}
            onTaskToggle={onTaskToggle ? (index, checked) => onTaskToggle(index + offset, checked) : undefined}/>;
    };
    while ((match = fences.exec(message))) {
        const closingFence = new RegExp(`^ {0,3}${match[1][0]}{${match[1].length},}[ \\t]*\\r?$`, 'gm');
        closingFence.lastIndex = fences.lastIndex;
        const closing = closingFence.exec(message);
        if (!closing) break;
        const source = message.slice(fences.lastIndex, closing.index).replace(/\r?\n$/, '');
        fences.lastIndex = closingFence.lastIndex;
        if (match[2].trim().toLowerCase() !== 'mermaid') continue;
        parts.push(text(message.slice(last, match.index), last));
        parts.push(<MermaidDiagram key={`mermaid-${match.index}`} source={source}/>);
        last = fences.lastIndex;
    }
    if (!parts.length) return <FormattedBody {...{message, postId, mentionKeys, className, onTaskToggle}}/>;
    parts.push(text(message.slice(last), last));
    return <span className={className}>{parts}</span>;
}

// The host may leave @all as plain text. Normalize it in both rendering paths,
// while leaving code, URLs, email addresses and longer usernames untouched.
function styleAllMentions(node: React.ReactNode): React.ReactNode {
    if (typeof node === 'string') {
        const pattern = /(^|[^\p{L}\p{N}_@./-])(@all)(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}_-])/giu;
        const parts: React.ReactNode[] = [];
        let end = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(node))) {
            const start = match.index + match[1].length;
            parts.push(node.slice(end, start));
            parts.push(<span key={`all-${start}`} data-mention="all" className="tgw-mention tgw-mention-all">{match[2]}</span>);
            end = start + match[2].length;
        }
        if (!parts.length) return node;
        parts.push(node.slice(end));
        return parts;
    }
    if (Array.isArray(node)) return node.map(styleAllMentions);
    if (!React.isValidElement(node)) return node;
    const element = node as React.ReactElement<any>;
    if (['code', 'pre', 'a', 'button', 'script', 'style'].includes(element.type as string)) return element;
    const props = element.props || {};
    const mention = String(props['data-mention'] || '').replace(/^@/, '').toLowerCase();
    if (mention === 'all') {
        return React.cloneElement(element, {className: `${props.className || ''} tgw-mention tgw-mention-all`});
    }
    if (mention || props.children === undefined) return element;
    return React.cloneElement(element, undefined, styleAllMentions(props.children));
}

function FormattedBody({message, postId, mentionKeys, className, onTaskToggle}: MessageBodyProps) {
    const tg = React.useContext(TgContext);
    const bodyRef = React.useRef<HTMLSpanElement>(null);
    const mentionSelector = '.tgw-mention[data-mention], .mention[data-mention]';
    const usernameOf = (node: Element) => (node.getAttribute('data-mention') || '').replace(/^@/, '');
    const isUserMention = (node: Element) => {
        const username = usernameOf(node);
        return /^[a-zA-Z0-9._-]+$/.test(username) && !['all', 'channel', 'here'].includes(username.toLowerCase()) && !node.closest('code, pre');
    };
    React.useLayoutEffect(() => {
        // Direction belongs on the list itself: a directional list item alone moves its text,
        // but leaves the marker on the side chosen by the surrounding page.
        bodyRef.current?.querySelectorAll('ul, ol').forEach((list) => list.setAttribute('dir', 'auto'));
        bodyRef.current?.querySelectorAll(mentionSelector).forEach((node) => {
            if (usernameOf(node).toLowerCase() === 'all' && !node.closest('code, pre')) node.classList.add('tgw-mention-all');
            if (!isUserMention(node)) return;
            node.setAttribute('role', 'button');
            node.setAttribute('tabindex', '0');
            node.setAttribute('aria-label', `Open profile for ${usernameOf(node)}`);
        });
    });
    const openMention = (event: React.MouseEvent<HTMLSpanElement> | React.KeyboardEvent<HTMLSpanElement>) => {
        if (!tg || !(event.target instanceof Element)) return;
        const mention = event.target.closest(mentionSelector);
        if (!mention || !event.currentTarget.contains(mention) || !isUserMention(mention)) return;
        if (event.type === 'click' && window.getSelection()?.isCollapsed === false) return;
        event.preventDefault();
        event.stopPropagation();
        tg.actions.openModal('userProfile', {username: usernameOf(mention)});
    };
    const mentionHandlers = {
        ref: bodyRef,
        onClickCapture: openMention,
        onKeyDownCapture: (event: React.KeyboardEvent<HTMLSpanElement>) => {
            if (event.key === 'Enter' || event.key === ' ') openMention(event);
        },
    };
    const onClick = (event: React.MouseEvent<HTMLSpanElement>) => handleBodyClick(event, tg?.actions.toast);
    const fallback = <span {...mentionHandlers} className={className} onClick={onClick}>{renderFallback(message, mentionKeys)}</span>;

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
            replaceUnsupportedMattermostShortcodes(message),
            {
                markdown: true,
                mentionHighlight: true,
                atMentions: true,
                emoticons: true,
                mentionKeys,
                singleline: false,
                unsafeLinks: false,
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
        });
        // The host formatter hands back bare unicode emoji inside its text nodes: their own
        // fallback-font metrics stretch the row (or split a sequence over two lines). Same box
        // the fallback renderer uses, applied to the whole rendered tree; linkify first so the
        // bare-domain links it creates pass through the emoji walk untouched.
        rendered = styleAllMentions(wrapEmojiNodes(linkifyNodes(rendered)));
        rendered = isolateLatinRuns(rendered);
        rendered = normalizeHostLists(rendered, markdownTaskStates(message), onTaskToggle);
    } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('[telegram-web-ui] post formatting failed, using the fallback renderer', error);
        return fallback;
    }

    return (
        <BodyBoundary fallback={fallback}>
            <span {...mentionHandlers} className={`tgw-message-body ${className || ''}`} onClick={onClick}>{rendered}</span>
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
        const lines = block.split('\n');
        const listItem = /^ {0,3}([-*+]\s+|\d+[.)]\s+)(.*)$/;
        let plain: string[] = [];
        const flush = () => {
            if (plain.length) nodes.push(...renderInline(plain.join('\n'), blockIndex * 10000 + nodes.length, mentionKeys));
            plain = [];
        };
        for (let i = 0; i < lines.length;) {
            const match = listItem.exec(lines[i]);
            if (!match) { plain.push(lines[i++]); continue; }
            flush();
            const ordered = /^\d/.test(match[1]);
            const items: React.ReactNode[] = [];
            while (i < lines.length) {
                let next = i;
                while (next < lines.length && !lines[next].trim()) next++;
                const item = listItem.exec(lines[next] || '');
                if (!item || /^\d/.test(item[1]) !== ordered) break;
                items.push(<li key={next}>{renderInline(item[2], blockIndex * 10000 + next, mentionKeys)}</li>);
                i = next + 1;
            }
            const key = `list-${blockIndex}-${i}`;
            nodes.push(ordered ? <ol key={key} dir="auto" start={parseInt(match[1], 10)}>{items}</ol> : <ul key={key} dir="auto">{items}</ul>);
        }
        flush();
    });

    return nodes;
}

function renderInline(text: string, keyPrefix: number, mentionKeys?: Array<{key: string; caseSensitive?: boolean}>): React.ReactNode[] {
    const nodes: React.ReactNode[] = [];
    // Order matters: inline code first so its content is not formatted any further.
    const pattern = new RegExp('(`[^`]+`)|' + String.raw`(\*\*[^*]+\*\*)|(__[^_]+__)|(~~[^~]+~~)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))|(https?:\/\/[^\s<>()]+)|(@[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)|(${BARE_DOMAIN_SOURCE})`, 'gi');
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
        const [full, code, bold, underline, strike, italic, link, url, mention, bare] = match;
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
                <a key={key} href={safeLinkURL(parts[2])} target="_blank" rel="noopener noreferrer">{parts[1]}</a>,
            );
        } else if (url) {
            nodes.push(
                <a key={key} href={url} target="_blank" rel="noopener noreferrer">{url}</a>,
            );
        } else if (mention) {
            if (match.index > 0 && /[\w@]/.test(text[match.index - 1])) {
                nodes.push(<React.Fragment key={key}>{mention}</React.Fragment>);
                lastIndex = match.index + full.length;
                continue;
            }
            const name = mention.slice(1).toLowerCase();
            const isSelf = mentionNames.includes(name);
            nodes.push(<span key={key} data-mention={mention.slice(1)} className={`tgw-mention ${isSelf ? 'tgw-mention-self' : ''}${name === 'all' ? ' tgw-mention-all' : ''}`}>{mention}</span>);
        } else if (bare) {
            // Typed without a scheme (google.com, openai.com): link it — unless it is the tail
            // of an address (bob@openai.com) or part of a larger word.
            if (match.index > 0 && /[\w@]/.test(text[match.index - 1])) {
                nodes.push(<React.Fragment key={key}>{full}</React.Fragment>);
            } else {
                nodes.push(<a key={key} href={`https://${full}`} target="_blank" rel="noopener noreferrer">{full}</a>);
            }
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
                {renderEmojiRuns(content, `${keyPrefix}-line-${lineIndex}`)}
            </span>,
        );
    });
    return nodes;
}

/** Plain and emoji pieces → text fragments plus one atomic `.tgw-emoji` box per emoji. */
function renderEmojiRuns(text: string, key: string): React.ReactNode[] {
    return splitEmoji(text).map((piece, index) => (
        piece.emoji
            ? <Emoji key={`${key}-e${index}`} char={piece.text}/>
            : <React.Fragment key={`${key}-t${index}`}>{piece.text}</React.Fragment>
    ));
}

/**
 * Walks the host formatter's rendered tree and wraps every emoji run in the same atomic box the
 * fallback renderer uses — formatText hands back bare unicode whose fallback-font metrics
 * stretch the row or split a sequence over two lines. Code/pre stay untouched so literal
 * characters keep their monospace flow. Standard host emoji images/components are normalized
 * to Unicode so the selected artwork supplies their appearance too; custom images stay intact.
 */
export function wrapEmojiNodes(node: React.ReactNode): React.ReactNode {
    if (node === null || node === undefined || typeof node === 'boolean') {
        return node;
    }
    if (typeof node === 'string' || typeof node === 'number') {
        const pieces = splitEmoji(String(node));
        if (!pieces.some((piece) => piece.emoji)) {
            return node;
        }
        return pieces.map((piece, index) => (
            piece.emoji
                ? <Emoji key={`e${index}`} char={piece.text}/>
                : <React.Fragment key={`t${index}`}>{piece.text}</React.Fragment>
        ));
    }
    if (Array.isArray(node)) {
        return node.map((child, index) => {
            const mapped = wrapEmojiNodes(child);
            if (React.isValidElement(mapped) && mapped.key === null) {
                return React.cloneElement(mapped, {key: `k${index}`});
            }
            return mapped;
        });
    }
    if (React.isValidElement(node)) {
        const element = node as React.ReactElement<any>;
        if (element.type === 'code' || element.type === 'pre') {
            return element;
        }
        const props = element.props || {};
        const className = typeof props.className === 'string' ? props.className : '';
        const markedEmoji = /(^|\s)(emoticon|emoji)(\s|$)/.test(className);
        const customImage = /\/emoji\//.test(String(props.src || '')) || props.emoji?.id || props.emojiId || props.isCustomEmoji;
        if (!customImage && (markedEmoji || props.emojiName || props['data-emoticon'])) {
            const label = props.alt || props['data-emoticon'] || props.emojiName || props.title;
            const name = typeof label === 'string' ? label.replace(/^:|:$/g, '') : '';
            const unicode = emojiChar(name) || (typeof label === 'string' && splitEmoji(label).every((piece) => piece.emoji) ? label : '');
            if (unicode) {
                return <Emoji key={element.key ?? undefined} char={unicode} title={props.title}/>;
            }
        }
        if (customImage || props.children === undefined) {
            return element;
        }
        return React.cloneElement(element, undefined, wrapEmojiNodes(props.children));
    }
    return node;
}

/** Keep embedded Latin words and punctuation (for example, CI/CD) together in RTL messages. */
export function isolateLatinRuns(node: React.ReactNode): React.ReactNode {
    if (node === null || node === undefined || typeof node === 'boolean') {
        return node;
    }
    if (typeof node === 'string' || typeof node === 'number') {
        const text = String(node);
        const pattern = /\p{Script=Latin}[\p{Script=Latin}\p{N}._:/+-]*(?:\s+\p{Script=Latin}[\p{Script=Latin}\p{N}._:/+-]*)*/gu;
        const parts: React.ReactNode[] = [];
        let lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
            if (match.index > lastIndex) {
                parts.push(text.slice(lastIndex, match.index));
            }
            parts.push(<bdi key={`bidi-${match.index}`} dir="ltr" className="tgw-bidi-ltr">{match[0]}</bdi>);
            lastIndex = match.index + match[0].length;
        }
        if (!parts.length) {
            return node;
        }
        if (lastIndex < text.length) {
            parts.push(text.slice(lastIndex));
        }
        return parts;
    }
    if (Array.isArray(node)) {
        return node.map((child, index) => {
            const mapped = isolateLatinRuns(child);
            if (React.isValidElement(mapped) && mapped.key === null) {
                return React.cloneElement(mapped, {key: `bidi-child-${index}`});
            }
            return mapped;
        });
    }
    if (React.isValidElement(node)) {
        const element = node as React.ReactElement<any>;
        if (element.type === 'code' || element.type === 'pre' || element.type === 'bdi') {
            return element;
        }
        return React.cloneElement(element, undefined, isolateLatinRuns(element.props.children));
    }
    return node;
}

/**
 * Autolinks bare domains (google.com, openai.com, www.x.io/path) in the host formatter's text
 * nodes: both renderers only linked explicit http(s) URLs, so typed domains stayed plain. The
 * curated TLD list keeps words like version.js or file.name from turning into links.
 */
const AUTOLINK_PATTERN = new RegExp(String.raw`(?:https?:\/\/[^\s<>()]+)|(${BARE_DOMAIN_SOURCE})`, 'gi');

function linkifyText(text: string): React.ReactNode[] {
    const re = new RegExp(AUTOLINK_PATTERN.source, 'gi');
    const nodes: React.ReactNode[] = [];
    let last = 0;
    let index = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        const url = match[0];
        const isHttp = /^https?:\/\//i.test(url);
        if (!isHttp && match.index > 0 && /[\w@]/.test(text[match.index - 1])) {
            continue; // tail of an address (bob@openai.com) or part of a larger word
        }
        if (match.index > last) {
            nodes.push(text.slice(last, match.index));
        }
        nodes.push(
            <a key={`u${index++}`} href={isHttp ? url : `https://${url}`} target="_blank" rel="noopener noreferrer">{url}</a>,
        );
        last = match.index + url.length;
        if (url.length === 0) {
            re.lastIndex++;
        }
    }
    if (last < text.length) {
        nodes.push(text.slice(last));
    }
    return nodes;
}

/** Same recursive shape as wrapEmojiNodes, one concern earlier: text nodes become linked nodes. */
function linkifyNodes(node: React.ReactNode): React.ReactNode {
    if (node === null || node === undefined || typeof node === 'boolean') {
        return node;
    }
    if (typeof node === 'string' || typeof node === 'number') {
        const text = String(node);
        const re = new RegExp(AUTOLINK_PATTERN.source, 'gi');
        if (!re.test(text)) {
            return node;
        }
        return linkifyText(text);
    }
    if (Array.isArray(node)) {
        return node.map((child, index) => {
            const mapped = linkifyNodes(child);
            if (React.isValidElement(mapped) && mapped.key === null) {
                return React.cloneElement(mapped, {key: `k${index}`});
            }
            return mapped;
        });
    }
    if (React.isValidElement(node)) {
        const element = node as React.ReactElement<any>;
        if (element.type === 'code' || element.type === 'pre' || element.type === 'a') {
            return element;
        }
        const props = element.props || {};
        if (props.children === undefined) {
            return element;
        }
        return React.cloneElement(element, undefined, linkifyNodes(props.children));
    }
    return node;
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
