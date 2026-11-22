// Message composer: markdown-lite toolbar, attachments, emoji, reply/edit modes, typing events.

import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {api} from '../mm/api';
import {getBlock} from '../mm/posts';
import {attachmentSummary, directionOf, displayName, fileKindOf, formatBytes, formatDuration, throttle, toPlainPreview} from '../mm/utils';
import {EmojiText} from './EmojiText';
import type {MMChannel, MMFileInfo, MMPost, MMPostPriority} from '../mm/types';
import {useTg} from './context';
import {EmojiPicker} from './EmojiPicker';
import {SendOptions} from './SendOptions';
import {useCommandAutocomplete} from './Commands';
import {useMentionAutocomplete} from './MentionAutocomplete';
import {IconAttach, IconBold, IconClose, IconCode, IconEdit, IconEmoji, IconEye, IconItalic, IconLink, IconMic, IconPause, IconPlay, IconQuote, IconSend, IconStop, IconStrike, IconTrash} from './primitives';
import {MessageBody} from './render';
import {useSelector} from '../mm/store';
import {clearComposerDraft, clearComposerDraftText, getComposerDraft, saveComposerDraft, selectComposerDraft} from '../mm/drafts';
import {useVoiceRecorder} from './voice';
import {deferred} from './deferred';

const PendingImageEditor = deferred(() => import(/* webpackChunkName: "imageviewer" */ './ImageViewer').then((module) => module.ImagePreview), 'image editor');

/** Grows (and shrinks) the textarea to its content, clamped to one line..320px. */
function autoGrow(element: HTMLTextAreaElement | null) {
    if (!element) {
        return;
    }
    // Collapsing the live textarea to measure it temporarily enlarges the message viewport.
    // The browser clamps its scrollTop during that layout, making history jump on each input.
    // Measure an out-of-flow copy at the same width instead, then resize the real box once.
    const measure = element.cloneNode(false) as HTMLTextAreaElement;
    measure.value = element.value;
    measure.tabIndex = -1;
    measure.setAttribute('aria-hidden', 'true');
    Object.assign(measure.style, {position: 'fixed', left: '-10000px', top: '0', visibility: 'hidden',
        pointerEvents: 'none', height: 'auto', minHeight: '0', maxHeight: 'none',
        width: `${element.getBoundingClientRect().width}px`});
    element.parentElement?.appendChild(measure);
    const height = `${Math.min(Math.max(measure.scrollHeight, 24), 320)}px`;
    measure.remove();
    if (element.style.height !== height) element.style.height = height;
}

export interface ComposerProps {
    quick?: boolean;
    channel: MMChannel;
    replyTo: MMPost | null;
    editing: MMPost | null;
    rootId?: string;
    onCancelReply: () => void;
    onCancelEdit: () => void;
    onSend: (payload: {message: string; fileIds: string[]; priority?: MMPostPriority; rootId?: string; files?: MMFileInfo[]; voice?: {fileId: string; durationMs: number; levels: number[]}}) => Promise<any>;
    onSent: () => void;
    placeholder?: string;
}

interface PendingFile {
    clientId: string;
    file: File;
    info?: MMFileInfo;
    error?: string;
    staged?: boolean;
    /** Set on files that came out of the voice recorder, for the tray chip preview. */
    voice?: {durationMs: number; levels: number[]};
}

const isImage = (file: File) => fileKindOf(file.type || file.name) === 'image';
const uploadBlocked = (entry: PendingFile) => !entry.staged && !entry.info;

async function uploadAttachment(channelId: string, entry: PendingFile) {
    const result = await api.uploadFile(channelId, entry.file, entry.clientId);
    const info = result?.file_infos?.[0];
    if (!info?.id) throw new Error('Upload failed');
    return info;
}

export function Composer({quick = false, channel, replyTo, editing, rootId, onCancelReply, onCancelEdit, onSend, onSent, placeholder}: ComposerProps) {
    const {ui, actions, me} = useTg();
    const [message, setMessage] = useState(() => getComposerDraft(channel.id)?.message || '');
    const storedDraftMessage = useSelector((state) => selectComposerDraft(state, channel.id)?.message || '');
    const [files, setFiles] = useState<PendingFile[]>([]);
    // Keep async sends and editor callbacks in sync with the tray.
    const filesRef = useRef(files);
    filesRef.current = files;
    const [previewId, setPreviewId] = useState('');
    const [showEmoji, setShowEmoji] = useState(false);
    const [showPreview, setShowPreview] = useState(false);
    const [urgent, setUrgent] = useState(false);
    const [restoreSchedule, setRestoreSchedule] = useState<{id: string; scheduledAt: number; channelId: string} | null>(null);
    const [sending, setSending] = useState(false);
    const sendInFlight = useRef(false);
    useEffect(() => { setUrgent(false); setRestoreSchedule(null); setShowPreview(false); }, [channel.id]);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const composing = useRef(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const voice = useVoiceRecorder((message) => actions.toast(message, 'error'));
    const recording = voice.status === 'recording';
    const isCommand = !editing && /^\/[^\s/]+/.test(message.trim());
    // Replying threads the message onto the root of the post being answered (answering a reply
    // keeps it in the same thread). Without this every reply went out as a brand new root post
    // and the "Reply to ..." bar was purely cosmetic.
    const threadRootId = replyTo && !editing ? (replyTo.root_id || replyTo.id) : rootId;
    const threadRootRef = useRef(threadRootId);
    threadRootRef.current = threadRootId;
    const typingRef = useRef(throttle(() => {
        const userId = me?.id;
        if (userId) {
            api.sendTyping(userId, channel.id, threadRootRef.current).catch(() => undefined);
        }
    }, 3000));
    const messageRef = useRef(message);
    messageRef.current = message;
    const setComposerMessage = (next: string | ((current: string) => string), removeEmptyDraft = false) => {
        const value = typeof next === 'function' ? next(messageRef.current) : next;
        messageRef.current = value;
        setMessage(value);
        if (editing) return;
        if (removeEmptyDraft && !value) {
            void clearComposerDraftText(channel.id).catch(() => actions.toast('Could not remove the synced draft', 'error'));
        } else {
            saveComposerDraft(channel.id, value);
        }
    };

    const currentTeamId = useSelector((state) => state.entities?.teams?.currentTeamId);
    const commandTeamId = channel.team_id || currentTeamId || '';
    const insertAutocomplete = (value: string, caret = value.length) => {
        setComposerMessage(value);
        requestAnimationFrame(() => {
            textareaRef.current?.focus();
            textareaRef.current?.setSelectionRange(caret, caret);
        });
    };
    const commandAutocomplete = useCommandAutocomplete(message, commandTeamId, channel.id, !editing, insertAutocomplete);
    const mentions = useMentionAutocomplete(message, channel.id, channel.team_id, editing?.id, !recording, insertAutocomplete);
    const autocomplete = commandAutocomplete.controls ? commandAutocomplete : mentions;
    const updateMentionSelection = (area: HTMLTextAreaElement) => {
        if (!composing.current) mentions.updateSelection(area);
    };

    // Both chat surfaces observe the same Mattermost draft, including clears.
    useEffect(() => {
        if (!editing) {
            messageRef.current = storedDraftMessage;
            setMessage(storedDraftMessage);
        }
    }, [channel.id, storedDraftMessage, editing]);

    useEffect(() => {
        if (editing) {
            setComposerMessage(editing.message || '');
            textareaRef.current?.focus();
        }
    }, [editing]);

    useEffect(() => {
        if (replyTo) {
            textareaRef.current?.focus();
        }
    }, [replyTo]);

    // Focus the input whenever a chat is opened, re-opened or switched, like Telegram does.
    // openChat() also pushes the Mattermost route, so the host app re-renders right behind us and
    // can take the keyboard for its own message box — keystrokes would then go into a field hidden
    // under this overlay. For a short window after the open, reclaim focus whenever it ends up
    // *outside* .tgw-root; focus placed inside our own overlay (sidebar search, modals, menus) is
    // left alone. The host may take the keyboard at any point while its channel view renders, so
    // the windows are retried a few times (80ms / 400ms / 1200ms).
    useEffect(() => {
        const composer = textareaRef.current;
        if (!composer) {
            return undefined;
        }
        composer.focus();
        const reclaim = () => {
            const active = document.activeElement as HTMLElement | null;
            const overlay = document.querySelector('.tgw-root');
            const insideOverlay = !!active && !!overlay && (overlay === active || overlay.contains(active));
            if (active !== composer && !insideOverlay && document.contains(composer)) {
                composer.focus();
            }
        };
        const timers = [setTimeout(reclaim, 80), setTimeout(reclaim, 400), setTimeout(reclaim, 1200)];
        return () => timers.forEach((timer) => clearTimeout(timer));
    }, [channel.id, ui.chatSeq]);

    // The textarea height is imperative (style.height), so every programmatic message change —
    // loading a long message for editing, inserting emoji/markdown — must re-measure, not just
    // ordinary typing. Without this an edit of a large message stayed stuck at one line.
    useLayoutEffect(() => {
        autoGrow(textareaRef.current);
    }, [message]);

    // Pending attachments and voice takes belong to the conversation that created them.
    const channelRef = useRef(channel.id);
    useLayoutEffect(() => {
        if (channelRef.current !== channel.id) {
            channelRef.current = channel.id;
            setFiles([]);
            filesRef.current = [];
            setPreviewId('');
            if (voice.status === 'recording') {
                void voice.cancel();
            }
        }
    }, [channel.id, voice]);

    const reset = () => {
        setShowPreview(false);
        setPreviewId('');
        setComposerMessage('');
        setFiles([]);
        filesRef.current = [];
        if (!editing) {
            clearComposerDraft(channel.id);
        }
    };

    useEffect(() => {
        const draft = ui.scheduledDraft;
        if (!draft || draft.post.channel_id !== channel.id || draft.quick !== quick) return;
        setComposerMessage(draft.post.message || '');
        const restoredFiles = draft.files.map((info) => ({clientId: info.id, info, file: new File([], info.name, {type: info.mime_type}),
            voice: draft.post.props?.voice?.fileId === info.id ? draft.post.props.voice : undefined}));
        setFiles(restoredFiles);
        filesRef.current = restoredFiles;
        setUrgent(draft.post.priority?.priority === 'urgent');
        setRestoreSchedule({id: draft.post.id, scheduledAt: draft.post.scheduled_at, channelId: channel.id});
        actions.setUI({scheduledDraft: undefined});
    }, [ui.scheduledDraft, channel.id, quick]);

    const insertMarkdown = (prefix: string, suffix = prefix, placeholderText = '') => {
        const element = textareaRef.current;
        if (!element) {
            return;
        }
        const start = element.selectionStart;
        const end = element.selectionEnd;
        const selection = message.slice(start, end) || placeholderText;
        const next = `${message.slice(0, start)}${prefix}${selection}${suffix}${message.slice(end)}`;
        setComposerMessage(next);
        requestAnimationFrame(() => {
            element.focus();
            element.setSelectionRange(start + prefix.length, start + prefix.length + selection.length);
        });
    };

    const attachFiles = async (incoming: FileList | File[] | null, voiceMeta?: {durationMs: number; levels: number[]}) => {
        if (!incoming) {
            return;
        }
        const list = Array.from(incoming);
        if (!list.length) {
            return;
        }
        const additions: PendingFile[] = list.map((file) => ({
            clientId: `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            file,
            voice: voiceMeta,
            staged: !voiceMeta && isImage(file),
        }));
        setFiles((current) => [...current, ...additions]);
        for (const entry of additions) {
            if (entry.staged) continue;
            try {
                const info = await uploadAttachment(channel.id, entry);
                setFiles((current) => current.map((item) => (item.clientId === entry.clientId ? {...item, info} : item)));
            } catch (error: any) {
                setFiles((current) => current.map((item) => (item.clientId === entry.clientId ? {...item, error: error?.message || 'Upload failed'} : item)));
            }
        }
    };

    const stopRecording = async () => {
        const take = await voice.finish();
        if (take) {
            await attachFiles([take.file], {durationMs: take.durationMs, levels: take.levels});
        }
    };

    const send = async (scheduledAt?: number, attachments = files): Promise<boolean> => {
        if (sendInFlight.current) return false;
        const trimmed = message.trim();
        if (!trimmed && !attachments.length) return false;
        if (attachments.some(uploadBlocked)) {
            actions.toast('Wait for attachments to finish uploading or remove failed uploads', 'error');
            return false;
        }
        if (scheduledAt !== undefined && (!Number.isFinite(scheduledAt) || scheduledAt <= Date.now())) {
            actions.toast('Choose a time in the future', 'error');
            return false;
        }
        if (isCommand && scheduledAt !== undefined) {
            actions.toast('Commands cannot be scheduled', 'error');
            return false;
        }
        if (isCommand && attachments.length) {
            actions.toast('Send attachments separately from commands', 'error');
            return false;
        }
        // Snapshot the payload and free the input right away: the network round trip can take a
        // while, and anything typed into the box while it is in flight must survive — a late
        // reset used to wipe the next message the user had already started composing.
        const ready = [...attachments];
        const priority: MMPostPriority | undefined = urgent && !threadRootId && !isCommand && !editing
            ? {priority: 'urgent', requested_ack: false, persistent_notifications: false} : undefined;
        const wasEditing = editing;
        const destination = channel.id;
        sendInFlight.current = true;
        setSending(true);
        setUrgent(false);
        reset();
        setShowEmoji(false);
        // The reply bar must disappear once the reply went out, otherwise every later message
        // would be threaded as well. The root id is already baked into the payload above.
        if (replyTo && !wasEditing) {
            onCancelReply();
        }
        try {
            if (!wasEditing) {
                for (const [index, entry] of ready.entries()) {
                    if (entry.staged) ready[index] = {...entry, info: await uploadAttachment(destination, entry), staged: false};
                }
            }
            const readyFiles = ready.map((entry) => entry.info?.id).filter(Boolean);
            const voiceEntry = ready.find((entry) => entry.voice && entry.info);
            const voice = voiceEntry ? {fileId: voiceEntry.info.id, ...voiceEntry.voice} : undefined;
            if (wasEditing) {
                await api.patchPost(wasEditing.id, {message: trimmed});
                onCancelEdit();
            } else if (scheduledAt !== undefined) {
                await api.schedulePost({channel_id: destination, message: trimmed, root_id: threadRootId || '',
                    file_ids: readyFiles, props: voice ? {voice} : {},
                    priority, scheduled_at: scheduledAt});
                actions.toast(`Message scheduled for ${new Date(scheduledAt).toLocaleString()}`, 'success');
                onSent();
            } else if (isCommand) {
                await api.executeCommand(trimmed, channel.id, commandTeamId, threadRootId);
                onSent();
            } else {
                await onSend({message: trimmed, fileIds: readyFiles, priority, rootId: threadRootId, files: ready.map((entry) => entry.info), voice});
                onSent();
            }
            return true;
        } catch (error: any) {
            // Put the draft back, but only if nothing new was typed while the request was out.
            const element = textareaRef.current;
            if (!wasEditing && !getComposerDraft(channel.id)?.message) saveComposerDraft(channel.id, trimmed);
            if (channelRef.current === destination && element && !messageRef.current.trim() && !filesRef.current.length) {
                setComposerMessage(wasEditing ? (wasEditing.message || '') : trimmed);
                setFiles(ready);
                setUrgent(!!priority);
                if (replyTo && !wasEditing) actions.startReply(replyTo);
            }
            actions.toast(error?.message || (wasEditing ? 'Could not save the changes' : scheduledAt !== undefined ? 'Could not schedule the message' : 'Could not send the message'), 'error');
            return false;
        } finally {
            sendInFlight.current = false;
            setSending(false);
        }
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.nativeEvent.isComposing) return;
        if (commandAutocomplete.onKeyDown(event)) return;
        if (mentions.onKeyDown(event)) return;
        if (event.key === 'Escape') {
            if (editing) {
                onCancelEdit();
                reset();
            } else if (replyTo) {
                onCancelReply();
            }
            return;
        }
        // Up arrow in an empty, non-editing box opens the last message of mine for editing —
        // the same shortcut Mattermost has. Only the newest editable post counts: root or
        // reply, never a pending/failed optimistic bubble or a system post.
        if (!quick && event.key === 'ArrowUp' && !message && !files.length && !editing) {
            const caretAtStart = event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0;
            if (caretAtStart) {
                const block = getBlock(channel.id);
                const myId = me?.id;
                const lastOwn = block && myId
                    ? block.order
                        .map((id) => block.posts[id])
                        .filter((post) => post && post.user_id === myId && !post._pending && !post._failed && !post.type && !post.delete_at)
                        .pop()
                    : undefined;
                if (lastOwn) {
                    event.preventDefault();
                    actions.startEditing(lastOwn);
                }
            }
            return;
        }
        if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
            event.preventDefault();
            send();
        }
    };

    const replyAuthor = useSelector((state) => (replyTo ? state.entities?.users?.profiles?.[replyTo.user_id] : undefined));
    const editAuthor = useSelector((state) => (editing ? state.entities?.users?.profiles?.[editing.user_id] : undefined));

    const placeholderText = useMemo(() => {
        if (editing) {
            return 'Edit message';
        }
        return placeholder || 'Write a message ...';
    }, [editing, placeholder]);

    const useEditedImage = (entry: PendingFile, file: File, sendNow: boolean) => {
        if (channelRef.current !== channel.id || !filesRef.current.some((item) => item.clientId === entry.clientId)) return;
        const next = filesRef.current.map((item) => item.clientId === entry.clientId
            ? {...item, file, info: undefined, error: undefined, staged: true}
            : item);
        setFiles(next);
        setPreviewId('');
        if (sendNow) void send(undefined, next);
    };
    const attachmentsReady = !files.some(uploadBlocked);
    const canSendEdited = attachmentsReady && !editing && !recording && !sending && !isCommand;

    return (
        <div className={`tgw-composer ${editing ? 'tgw-composer-editing' : ''}`}>
            {replyTo && !editing && (
                <div className="tgw-reply-bar">
                    <span className="tgw-reply-bar-body">
                        <span className="tgw-reply-bar-title">Reply to {replyAuthor ? displayName(replyAuthor) : 'message'}</span>
                        <span className="tgw-reply-bar-text"><EmojiText text={toPlainPreview(replyTo.message, 100) || attachmentSummary(replyTo.metadata?.files) || 'Attachment'}/></span>
                    </span>
                    <button type="button" className="tgw-reply-bar-close" onClick={onCancelReply} title="Cancel reply">
                        <IconClose size={16}/>
                    </button>
                </div>
            )}
            {editing && (
                <div className="tgw-reply-bar tgw-edit-bar">
                    <span className="tgw-reply-bar-body">
                        <span className="tgw-reply-bar-title"><IconEdit size={14}/> Editing message</span>
                        <span className="tgw-reply-bar-text"><EmojiText text={toPlainPreview(editing.message, 100)}/></span>
                    </span>
                    <button
                        type="button"
                        className="tgw-reply-bar-close"
                        onClick={() => {
                            onCancelEdit();
                            reset();
                        }}
                        title="Cancel editing"
                    >
                        <IconClose size={16}/>
                    </button>
                </div>
            )}

            {files.length > 0 && (
                <div className="tgw-attachment-tray">
                    {files.map((entry) => (
                        entry.voice ? (
                            <VoiceChip
                                key={entry.clientId}
                                entry={entry}
                                onRemove={() => setFiles((current) => current.filter((item) => item.clientId !== entry.clientId))}
                            />
                        ) : (
                            <div key={entry.clientId} className={`tgw-attachment-chip ${entry.error ? 'tgw-attachment-chip-error' : ''}`}>
                                {isImage(entry.file) && !entry.error ? (
                                    <ImageChip entry={entry} open={previewId === entry.clientId} onOpen={() => setPreviewId(entry.clientId)}
                                        onClose={() => setPreviewId('')} onApply={(file) => useEditedImage(entry, file, false)}
                                        onSend={canSendEdited ? (file) => useEditedImage(entry, file, true) : undefined}/>
                                ) : (
                                    <span className="tgw-attachment-chip-icon">{entry.file.name.split('.').pop()?.toUpperCase().slice(0, 4) || 'FILE'}</span>
                                )}
                                <span className="tgw-attachment-chip-meta">
                                    <span className="tgw-attachment-chip-name">{entry.file.name}</span>
                                    <span className="tgw-attachment-chip-size">{entry.error || (entry.staged ? formatBytes(entry.file.size) : entry.info ? formatBytes(entry.info.size) : 'Uploading…')}</span>
                                </span>
                                <button
                                    type="button"
                                    onClick={() => setFiles((current) => current.filter((item) => item.clientId !== entry.clientId))}
                                    title="Remove"
                                >
                                    <IconClose size={14}/>
                                </button>
                            </div>
                        )
                    ))}
                </div>
            )}

            <div className="tgw-composer-toolbar">
                <button type="button" title="Bold" onClick={() => insertMarkdown('**', '**', 'bold')}><IconBold size={18}/></button>
                <button type="button" title="Italic" onClick={() => insertMarkdown('*', '*', 'italic')}><IconItalic size={18}/></button>
                <button type="button" title="Strikethrough" onClick={() => insertMarkdown('~~', '~~', 'strikethrough')}><IconStrike size={18}/></button>
                <button type="button" title="Code" onClick={() => insertMarkdown('`', '`', 'code')}><IconCode size={18}/></button>
                <button type="button" title="Code block" onClick={() => insertMarkdown('```\n', '\n```', 'code')}><IconQuote size={18}/></button>
                <button type="button" title="Link" onClick={() => insertMarkdown('[', '](https://)', 'link')}><IconLink size={18}/></button>
                <button type="button" title={showPreview ? 'Close message preview' : 'Preview message'} aria-label={showPreview ? 'Close message preview' : 'Preview message'} aria-pressed={showPreview} onClick={() => setShowPreview((value) => !value)}><IconEye size={18}/></button>
                <SendOptions key={channel.id} restoreSchedule={restoreSchedule?.channelId === channel.id ? restoreSchedule : null} urgent={urgent} onUrgent={setUrgent}
                    priorityDisabled={!!threadRootId || isCommand}
                    disabled={!!editing || recording} busy={sending}
                    canSend={!!(message.trim() || files.length) && attachmentsReady}
                    onSchedule={async (timestamp) => { const sent = await send(timestamp); if (sent) setRestoreSchedule(null); return sent; }}/>
            </div>

            {showPreview && !recording && <div className="tgw-composer-preview" role="region" aria-label="Message preview">
                <div className="tgw-composer-preview-heading">Message preview</div>
                {message.trim() ? <div className="tgw-msg-out"><div className="tgw-bubble"><MessageBody message={message} className="tgw-message-text"/></div></div> : <div className="tgw-composer-preview-empty">Write a message to preview its formatting.</div>}
            </div>}

            {recording ? (
                <div className="tgw-composer-input tgw-voice-recording" aria-label="Recording a voice message">
                    <span className="tgw-rec-timer">
                        <span className="tgw-rec-dot" aria-hidden="true"/>
                        {formatDuration(voice.durationMs)}
                    </span>
                    <div className="tgw-rec-wave" aria-hidden="true">
                        {(voice.levels.length ? voice.levels : [0.2]).slice(-48).map((level, index) => (
                            <span
                                key={index}
                                className="tgw-rec-bar"
                                style={{height: `${Math.max(8, Math.min(100, Math.round(level * 250)))}%`}}
                            />
                        ))}
                    </div>
                    <button
                        type="button"
                        className="tgw-composer-icon"
                        title="Discard recording"
                        onClick={() => {
                            void voice.cancel();
                        }}
                    >
                        <IconTrash size={18}/>
                    </button>
                    <button
                        type="button"
                        className="tgw-send-button tgw-send-button-active tgw-voice-stop"
                        title="Stop recording"
                        onClick={() => {
                            void stopRecording();
                        }}
                    >
                        <IconStop size={15}/>
                    </button>
                </div>
            ) : (
                <div className="tgw-composer-input">
                    <button type="button" className="tgw-composer-icon" title="Attach a file" onClick={() => fileInputRef.current?.click()}><IconAttach size={20}/></button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        style={{display: 'none'}}
                        onChange={(event) => {
                            attachFiles(event.target.files);
                            event.target.value = '';
                        }}
                    />
                    {!quick && voice.supported && !editing && (
                        <button
                            type="button"
                            className="tgw-composer-icon"
                            title="Record a voice message"
                            onClick={() => {
                                void voice.start();
                            }}
                        >
                            <IconMic size={20}/>
                        </button>
                    )}
                    <textarea
                        ref={textareaRef}
                        value={message}
                        dir={directionOf(message)}
                        placeholder={placeholderText}
                        rows={1}
                        spellCheck={false}
                        onChange={(event) => {
                            setComposerMessage(event.target.value, true);
                            updateMentionSelection(event.currentTarget);
                            typingRef.current();
                        }}
                        onSelect={(event) => updateMentionSelection(event.currentTarget)}
                        onClick={(event) => updateMentionSelection(event.currentTarget)}
                        onCompositionStart={() => {
                            composing.current = true;
                            mentions.dismiss();
                        }}
                        onCompositionEnd={(event) => {
                            composing.current = false;
                            updateMentionSelection(event.currentTarget);
                        }}
                        onBlur={(event) => mentions.onBlur(event.relatedTarget)}
                        onKeyDown={onKeyDown}
                        aria-autocomplete="list"
                        aria-expanded={autocomplete.controls ? true : undefined}
                        aria-controls={autocomplete.controls}
                        aria-activedescendant={autocomplete.active}
                        onPaste={(event) => {
                            // Screenshots and copied images arrive as files on the clipboard; a
                            // textarea would silently drop them, so hand them to the upload path.
                            const items = event.clipboardData?.items;
                            if (!items) {
                                return;
                            }
                            const pasted: File[] = [];
                            for (const item of Array.from(items)) {
                                if (item.kind === 'file') {
                                    const file = item.getAsFile();
                                    if (file && (file.size || file.type)) {
                                        pasted.push(file);
                                    }
                                }
                            }
                            if (!pasted.length) {
                                return;
                            }
                            event.preventDefault();
                            attachFiles(pasted);
                        }}
                    />
                    {commandAutocomplete.picker}
                    <button
                        type="button"
                        className="tgw-composer-icon"
                        title="Emoji"
                        onClick={() => setShowEmoji((value) => !value)}
                    >
                        <IconEmoji size={20}/>
                    </button>
                    <button
                        type="button"
                        className={`tgw-send-button ${message.trim() || files.length ? 'tgw-send-button-active' : ''}`}
                        onClick={() => send()}
                        disabled={sending}
                        title={editing ? 'Save changes' : 'Send'}
                    >
                        {editing ? <IconEdit size={18}/> : <IconSend size={18}/>}
                    </button>
                </div>
            )}

            {mentions.picker}
            {showEmoji && (
                <EmojiPicker
                    onClose={() => setShowEmoji(false)}
                    onPick={(name, char) => {
                        const element = textareaRef.current;
                        const text = (char || `:${name}:`) + ' ';
                        if (element) {
                            const {selectionStart, selectionEnd} = element;
                            const next = `${message.slice(0, selectionStart)}${text}${message.slice(selectionEnd)}`;
                            insertAutocomplete(next, selectionStart + text.length);
                        } else {
                            setComposerMessage((current) => `${current}${text}`);
                        }
                    }}
                />
            )}
        </div>
    );
}


interface ImageChipProps {
    entry: PendingFile;
    open: boolean;
    onOpen: () => void;
    onClose: () => void;
    onApply: (file: File) => void;
    onSend?: (file: File) => void;
}

function ImageChip({entry, open, onOpen, onClose, onApply, onSend}: ImageChipProps) {
    const {file, info} = entry;
    const [objectURL, setObjectURL] = useState<{file: File; url: string} | null>(null);
    const uploadedURL = info && !file.size ? api.fileURL(info.id) : '';
    useEffect(() => {
        if (uploadedURL || typeof URL.createObjectURL !== 'function') return;
        try {
            const url = URL.createObjectURL(file);
            setObjectURL({file, url});
            return () => URL.revokeObjectURL(url);
        } catch {
            // The local preview is unavailable when the host cannot create a blob URL.
        }
    }, [file, uploadedURL]);
    const src = uploadedURL || (objectURL?.file === file ? objectURL.url : '');
    return <>
        <button className="tgw-attachment-chip-preview" type="button" aria-label={`Edit ${file.name}`} title="Edit image" onClick={() => { if (src) onOpen(); }}>
            {src ? <img src={src} alt=""/> : <span className="tgw-attachment-chip-icon">IMG</span>}
            <span className="tgw-attachment-chip-preview-icon" aria-hidden="true"><IconEdit size={12}/></span>
        </button>
        {open && src && <div className="tgw-composer-image-preview">
            <PendingImageEditor src={src} name={file.name} onClose={onClose} onApply={onApply} onSend={onSend}/>
        </div>}
    </>;
}

/** Tray chip for a freshly recorded take: play it back before sending or throw it away. */
function VoiceChip({entry, onRemove}: {entry: PendingFile; onRemove: () => void}) {
    const audioRef = useRef<HTMLAudioElement>(null);
    const [playing, setPlaying] = useState(false);
    const [ready, setReady] = useState(!!entry.info);
    // jsdom (and very old browsers) have no usable object URLs; the chip then simply has no
    // playback. The try/catch also covers Node's URL.createObjectURL rejecting jsdom Blobs.
    const url = useMemo(() => {
        try {
            return (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') ? URL.createObjectURL(entry.file) : '';
        } catch {
            return '';
        }
    }, [entry.file]);
    useEffect(() => () => {
        if (url && typeof URL.revokeObjectURL === 'function') {
            URL.revokeObjectURL(url);
        }
    }, [url]);
    useEffect(() => {
        if (entry.info) {
            setReady(true);
        }
    }, [entry.info]);

    const toggle = () => {
        const element = audioRef.current;
        const next = !playing;
        setPlaying(next);
        if (!element) {
            return;
        }
        if (next) {
            const result = element.play();
            if (result && typeof result.catch === 'function') {
                result.catch(() => setPlaying(false));
            }
        } else {
            element.pause();
        }
    };

    return (
        <div className="tgw-attachment-chip tgw-attachment-chip-voice">
            <button type="button" className="tgw-chip-voice-play" title={playing ? 'Pause' : 'Play'} onClick={toggle}>
                {playing ? <IconPause size={16}/> : <IconPlay size={16}/>}
            </button>
            <span className="tgw-attachment-chip-meta">
                <span className="tgw-attachment-chip-name">Voice message</span>
                <span className="tgw-attachment-chip-size">
                    {entry.error || (ready ? formatDuration(entry.voice?.durationMs || 0) : 'Uploading…')}
                </span>
            </span>
            <audio ref={audioRef} src={url || undefined} preload="metadata" onEnded={() => setPlaying(false)}/>
            <button type="button" onClick={onRemove} title="Remove">
                <IconClose size={14}/>
            </button>
        </div>
    );
}
