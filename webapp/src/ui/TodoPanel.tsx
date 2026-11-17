import React, {useEffect, useRef, useState} from 'react';
import {api} from '../mm/api';
import {invalidateTodos, subscribeTodos} from '../mm/todos';
import type {MMTodo} from '../mm/types';
import {useTg} from './context';
import {IconClose} from './primitives';

export function TodoPanel() {
    const {channel, ui, actions, isMobile} = useTg();
    const channelId = channel?.id;
    const [tasks, setTasks] = useState<MMTodo[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [loadError, setLoadError] = useState('');
    const [text, setText] = useState('');
    const [term, setTerm] = useState('');
    const [busy, setBusy] = useState(false);
    const [reload, setReload] = useState(0);
    const sequence = useRef(0);
    const currentChannel = useRef(channelId); currentChannel.current = channelId;
    const linked = ui.todoLinkedPost?.channel_id === channelId ? ui.todoLinkedPost : null;
    const input = useRef<HTMLTextAreaElement>(null);

    useEffect(() => () => { currentChannel.current = undefined; }, []);
    useEffect(() => { if (linked) { setText((linked.message || '').trim().slice(0, 4000)); input.current?.focus(); } }, [linked?.id]);
    useEffect(() => subscribeTodos((changed) => {
        if (!changed || changed === channelId) setReload((n) => n + 1);
    }), [channelId]);
    useEffect(() => {
        const seq = ++sequence.current;
        if (!channelId) { setLoading(false); return undefined; }
        setLoading(true); setLoadError('');
        api.getTodos(channelId).then((items) => {
            if (seq === sequence.current) setTasks(items);
        }).catch(() => {
            if (seq === sequence.current) setLoadError('Could not load todos.');
        }).finally(() => { if (seq === sequence.current) setLoading(false); });
        return () => { sequence.current++; };
    }, [channelId, reload]);

    const save = async (run: () => ReturnType<typeof api.createTodo>, adding = false) => {
        if (busy || !channelId) return;
        const origin = channelId;
        setBusy(true); setError('');
        try {
            const result = await run();
            invalidateTodos(origin);
            if (result.notification_failed) actions.toast('Todo saved, but its chat notification could not be posted.', 'error');
            if (currentChannel.current === origin && adding) {
                setText(''); actions.setUI({todoLinkedPost: null});
            }
        } catch (err) {
            if (currentChannel.current === origin) setError(err.message || 'Could not save todo.');
            invalidateTodos(origin);
        } finally { if (currentChannel.current === origin) setBusy(false); }
    };
    const jump = async (task: MMTodo) => {
        try {
            const post = await api.getPost(task.post_id);
            if (!post || post.delete_at || post.channel_id !== task.channel_id) throw new Error();
            if (currentChannel.current !== task.channel_id) return;
            actions.openChat(task.channel_id, {postId: task.post_id});
            if (isMobile) actions.setUI({todosOpen: false});
        } catch (_) { actions.toast('The linked message is deleted or unavailable.', 'error'); }
    };
    const rows = tasks.filter((task) => (task.text || 'Linked todo').toLowerCase().includes(term.toLowerCase()));
    return <aside className="tgw-info-panel tgw-files-panel tgw-todos-panel" aria-label="Chat todos">
        <header className="tgw-info-header">
            <span className="tgw-info-title">TODO · {tasks.filter((task) => !task.done).length}</span>
            <button type="button" className="tgw-icon-button" title="Collapse todos" onClick={() => actions.setUI({todosOpen: false, todoLinkedPost: null})}><IconClose size={20}/></button>
        </header>
        <form className="tgw-todo-add" onSubmit={(event) => { event.preventDefault(); if (text.trim() || linked) save(() => api.createTodo(channelId, text, linked?.id), true); }}>
            {linked && <div className="tgw-todo-linked">Message attached <button type="button" disabled={busy} onClick={() => actions.setUI({todoLinkedPost: null})}>Remove link</button></div>}
            <textarea ref={input} aria-label="New todo" placeholder={linked ? 'Optional text · Linked todo' : 'New todo'} maxLength={4000} value={text} disabled={busy} onChange={(event) => setText(event.target.value)}/>
            <button type="submit" className="tgw-button" disabled={busy || !channelId || (!text.trim() && !linked)}>{busy ? 'Saving…' : 'Add'}</button>
        </form>
        <div className="tgw-files-search"><input className="tgw-todo-search" aria-label="Search todos" placeholder="Search todos" value={term} onChange={(event) => setTerm(event.target.value)}/></div>
        {(error || loadError) && <div className="tgw-todo-error" role="alert">{error || loadError} <button type="button" onClick={() => { setError(''); setReload((n) => n + 1); }}>Refresh</button></div>}
        <div className="tgw-files-body" aria-busy={loading}>
            {loading && !tasks.length && <div className="tgw-empty-list">Loading todos…</div>}
            {!loading && !rows.length && !error && !loadError && <div className="tgw-empty-list">{term ? 'No matching todos' : 'No todos yet'}</div>}
            {[false, true].map((done) => <React.Fragment key={String(done)}>
                {rows.some((task) => task.done === done) && <h3 className="tgw-todo-section">{done ? 'Completed' : 'Unfinished'}</h3>}
                {rows.filter((task) => task.done === done).sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)).map((task) => <div key={task.id} className={`tgw-todo-row ${task.done ? 'tgw-todo-done' : ''}`}>
                    <input type="checkbox" aria-label={`${task.done ? 'Reopen' : 'Complete'} ${task.text || 'Linked todo'}`} checked={task.done} disabled={busy} onChange={() => save(() => api.changeTodo(task, !task.done))}/>
                    <div className="tgw-todo-content"><span className="tgw-todo-text">{task.text || 'Linked todo'}</span>{task.post_id && <button type="button" className="tgw-todo-jump" onClick={() => jump(task)}>Go to message</button>}</div>
                    <button type="button" className="tgw-icon-button" title="Delete todo" disabled={busy} onClick={() => actions.askConfirm({title: 'Delete this todo for everyone?', body: task.text || 'Linked todo', confirmLabel: 'Delete', danger: true, onConfirm: () => save(() => api.changeTodo(task, null))})}><IconClose size={16}/></button>
                </div>)}
            </React.Fragment>)}
        </div>
    </aside>;
}
