// Access to the live Mattermost Redux store.
//
// The web app hands its store to the plugin's initialize(registry, store) hook. Plugin components
// are rendered inside the host React tree, but to stay independent of react-redux context (and of
// the host's React major version) this plugin subscribes to the store directly with tiny hooks.

import {useEffect, useRef, useState} from 'react';
import type {MMState, StoreLike} from './types';

let store: StoreLike | null = null;
let scheduled = false;
const listeners = new Set<() => void>();

export function setStore(next: StoreLike) {
    store = next;
}

export function getStore(): StoreLike | null {
    return store;
}

export function getState(): MMState {
    if (!store) {
        return {entities: {}} as MMState;
    }
    return store.getState();
}

function flush() {
    scheduled = false;
    listeners.forEach((listener) => {
        try {
            listener();
        } catch (err) {
            // A broken listener must never take the host app down.
            // eslint-disable-next-line no-console
            console.error('[telegram-web-ui] store listener failed', err);
        }
    });
}

/**
 * Batches store notifications into one per animation frame (or ~50ms), which keeps large
 * websocket bursts (channel loads, bulk post sync) from re-rendering the whole UI repeatedly.
 */
function schedule() {
    if (scheduled) {
        return;
    }
    scheduled = true;
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(flush);
    } else {
        setTimeout(flush, 50);
    }
}

export function subscribe(listener: () => void): () => void {
    if (!store) {
        return () => undefined;
    }
    if (listeners.size === 0) {
        store.subscribe(schedule);
    }
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function shallowEqual(a: any, b: any): boolean {
    if (a === b) {
        return true;
    }
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
        return false;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
            return false;
        }
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) {
                return false;
            }
        }
        return true;
    }
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) {
        return false;
    }
    for (const key of keysA) {
        if (a[key] !== b[key]) {
            return false;
        }
    }
    return true;
}

const UNSET = {};

/**
 * Selects a slice of the Mattermost store and re-renders the component when it changes.
 * Comparison defaults to a shallow compare, which works well with the memoized selectors in
 * ./selectors.ts (they return cached, referentially stable objects while nothing changed).
 */
export function useSelector<T>(selector: (state: MMState) => T, isEqual: (a: T, b: T) => boolean = shallowEqual): T {
    const [, forceRender] = useState(0);
    const valueRef = useRef<any>(UNSET);
    const selectorRef = useRef(selector);
    selectorRef.current = selector;

    // Selectors frequently close over component props or local state (for example the currently
    // selected channel), so the value is recomputed on every render as well. The store
    // subscription below is only responsible for triggering renders when the store changed.
    const computed = selectorRef.current(getState());
    if (valueRef.current === UNSET || !isEqual(valueRef.current as T, computed)) {
        valueRef.current = computed;
    }

    useEffect(() => {
        const check = () => {
            const value = selectorRef.current(getState());
            if (!isEqual(valueRef.current as T, value)) {
                valueRef.current = value;
                forceRender((n) => n + 1);
            }
        };
        return subscribe(check);
    }, [isEqual]);

    return valueRef.current as T;
}

/** Re-renders the component on any store change (used by components that ask the REST cache). */
export function useStoreTick(): number {
    const [tick, setTick] = useState(0);
    useEffect(() => {
        const bump = () => setTick((n) => n + 1);
        return subscribe(bump);
    }, []);
    return tick;
}

/** Small helper for localStorage backed UI preferences that must survive reloads. */
export function readLocal(key: string, fallback: string): string {
    try {
        const value = window.localStorage.getItem(key);
        return value === null ? fallback : value;
    } catch (err) {
        return fallback;
    }
}

export function writeLocal(key: string, value: string) {
    try {
        window.localStorage.setItem(key, value);
    } catch (err) {
        // storage disabled (private mode) - the preference simply won't survive a reload
    }
}
