// Shared invalidations and batched counts keep sidebar rows independent of panel visibility.
import {useEffect, useState} from 'react';
import {api} from './api';

const listeners = new Set<(channelId?: string) => void>();
const countListeners = new Set<(channelId: string) => void>();
const counts = new Map<string, number>();
const watched = new Map<string, number>();
const pending = new Set<string>();
const generations = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | null = null;
let epoch = 0;

export function subscribeTodos(listener: (channelId?: string) => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
function emit(channelId?: string) { listeners.forEach((listener) => listener(channelId)); }

function requestCount(channelId: string) {
    generations.set(channelId, (generations.get(channelId) || 0) + 1);
    pending.add(channelId);
    if (timer) return;
    timer = setTimeout(async () => {
        timer = null;
        const ids = Array.from(pending); pending.clear();
        const session = epoch;
        for (let offset = 0; offset < ids.length; offset += 100) {
            const batch = ids.slice(offset, offset + 100);
            const versions = batch.map((id) => generations.get(id) || 0);
            try {
                const result = await api.getTodoCounts(batch);
                if (session !== epoch) return;
                batch.forEach((id, index) => {
                    if (versions[index] !== (generations.get(id) || 0)) return;
                    if (typeof result?.[id] === 'number') counts.set(id, result[id]);
                    else counts.delete(id);
                    countListeners.forEach((listener) => listener(id));
                });
            } catch (_) { /* Preserve existing counts; reconnect/focus will retry. */ }
        }
    }, 20);
}

export function invalidateTodos(channelId?: string) {
    const ids = channelId ? [channelId] : Array.from(watched.keys());
    ids.forEach((id) => {
        generations.set(id, (generations.get(id) || 0) + 1);
        if (watched.has(id)) requestCount(id);
    });
    emit(channelId);
}

export function useTodoCount(channelId?: string, entryKey?: number): number | undefined {
    const [fresh, setFresh] = useState<{key: string; value: number} | null>(null);
    const key = `${channelId}:${entryKey}`;
    useEffect(() => {
        if (!channelId) return undefined;
        watched.set(channelId, (watched.get(channelId) || 0) + 1);
        // Revalidate on each chat entry, even when a sidebar row has a cached count.
        requestCount(channelId);
        const listener = (changed: string) => {
            if (changed !== channelId) return;
            setFresh({key, value: counts.get(channelId)});
        };
        countListeners.add(listener);
        return () => {
            countListeners.delete(listener);
            const n = (watched.get(channelId) || 1) - 1;
            if (n) watched.set(channelId, n); else watched.delete(channelId);
        };
    }, [channelId, entryKey]);
    if (entryKey !== undefined) return fresh?.key === key ? fresh.value : undefined;
    return channelId ? counts.get(channelId) : undefined;
}

// Watch all accessible chats even while the TODO folder hides rows with no open tasks.
export function useTodoCounts(channelIds: string[]): Record<string, number> {
    const [, refresh] = useState(0);
    const key = JSON.stringify(channelIds.slice().sort());
    useEffect(() => {
        const ids: string[] = JSON.parse(key);
        const included = new Set(ids);
        const listener = (id: string) => {
            if (included.has(id)) refresh((value) => value + 1);
        };
        countListeners.add(listener);
        ids.forEach((id) => {
            watched.set(id, (watched.get(id) || 0) + 1);
            requestCount(id);
        });
        return () => {
            countListeners.delete(listener);
            ids.forEach((id) => {
                const n = (watched.get(id) || 1) - 1;
                if (n) watched.set(id, n); else watched.delete(id);
            });
        };
    }, [key]);
    return Object.fromEntries(channelIds.map((id) => [id, counts.get(id) || 0]));
}

export function clearTodos() {
    epoch++;
    if (timer) clearTimeout(timer);
    timer = null; pending.clear(); counts.clear(); generations.clear();
    countListeners.forEach((listener) => watched.forEach((_, id) => listener(id)));
    emit();
}
