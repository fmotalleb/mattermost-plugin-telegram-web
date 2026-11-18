/** URLs in post text and attachment props are untrusted, even on newer React hosts. */
export function safeLinkURL(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const text = value.trim();
    if (!text || /[\u0000-\u001f\u007f]/.test(text)) return undefined;
    try {
        const url = new URL(text, window.location.href);
        if (!['http:', 'https:', 'mailto:'].includes(url.protocol) || url.username || url.password) return undefined;
        return text;
    } catch { return undefined; }
}

export function safeImageURL(value: unknown): string | undefined {
    const text = safeLinkURL(value);
    if (!text) return undefined;
    const url = new URL(text, window.location.href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
}
