// Portals must land inside .tgw-root: that element is where every --tgw-* theme variable is
// declared. Portalling straight to <body> makes each var() invalid at computed-value time, so
// backgrounds, borders and text fall back to fully transparent / initial values.

export function overlayRoot(): HTMLElement {
    if (typeof document !== 'undefined') {
        const root = document.querySelector('.tgw-root');
        if (root) {
            return root as HTMLElement;
        }
        return document.body;
    }
    // No DOM (SSR/tests without jsdom): the overlay never renders there, so the cast is safe.
    return undefined as unknown as HTMLElement;
}
