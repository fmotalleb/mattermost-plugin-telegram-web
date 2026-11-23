import React, {useEffect, useState} from 'react';

// Cache successful modules across openings, but allow failed chunk requests to be retried.
// Using a small hook wrapper also works with the host's classic React runtime.
export function deferred(load: () => Promise<React.ComponentType<any>>, label: string,
    fallback?: (failed: boolean, retry: () => void, reload?: () => void) => React.ReactNode) {
    let loaded: React.ComponentType<any>;
    let pending: Promise<React.ComponentType<any>>;
    return function DeferredView(props: any) {
        const {deferredCancel, ...viewProps} = props;
        const cancel = deferredCancel || viewProps.onClose;
        const [Component, setComponent] = useState(() => loaded);
        const [failure, setFailure] = useState<'chunk' | 'other'>();
        const [attempt, setAttempt] = useState(0);
        useEffect(() => {
            let cancelled = false;
            setFailure(undefined);
            if (!pending) pending = load().then((component) => {
                loaded = component;
                return component;
            }).catch((error) => {
                pending = undefined;
                console.error(`[telegram-web-ui] could not load ${label}`, error);
                throw error;
            });
            pending.then((component) => { if (!cancelled) setComponent(() => component); })
                .catch((error) => { if (!cancelled) setFailure(error?.name === 'ChunkLoadError' ? 'chunk' : 'other'); });
            return () => { cancelled = true; };
        }, [attempt]);
        React.useLayoutEffect(() => {
            if (Component || !cancel) return undefined;
            const keydown = (event: KeyboardEvent) => {
                if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); cancel(); }
            };
            document.addEventListener('keydown', keydown, true);
            return () => document.removeEventListener('keydown', keydown, true);
        }, [Component, cancel]);
        if (Component) return <Component {...viewProps}/>;
        const failed = Boolean(failure);
        const retry = () => setAttempt((value) => value + 1);
        // The active page can still reference an old chunk after the plugin was updated.
        const reload = failure === 'chunk' ? () => window.location.reload() : undefined;
        if (fallback) return <>{fallback(failed, retry, reload)}</>;
        return <div className="tgw-lazy-status" role={failed ? 'alert' : 'status'}>
            {failed ? `Could not load ${label}.` : `Loading ${label}…`}
            {failed && <button type="button" onClick={retry}>Retry</button>}
            {reload && <button type="button" onClick={reload}>Reload Mattermost</button>}
            {cancel && <button type="button" onClick={cancel}>Cancel</button>}
        </div>;
    };
}
