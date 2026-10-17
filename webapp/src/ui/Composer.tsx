// Message composer: markdown-lite toolbar, attachments, emoji, reply/edit modes, typing events.

import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {api} from '../mm/api';
import {getBlock} from '../mm/posts';
import {attachmentSummary, displayName, fileKindOf, formatBytes, formatDuration, throttle, toPlainPreview} from '../mm/utils';
import type {MMChannel, MMFileInfo, MMPost} from '../mm/types';
import {useTg} from './context';
import {EmojiPicker} from './EmojiPicker';
import {IconAttach, IconBold, IconClose, IconCode, IconEdit, IconEmoji, IconItalic, IconLink, IconMic, IconPause, IconPlay, IconQuote, IconSend, IconStop, IconStrike, IconTrash} from './primitives';
import {getState, useSelector} from '../mm/store';
import {useVoiceRecorder} from './voice';

/** Grows (and shrinks) the textarea to its content, clamped to one line..320px. */
function autoGrow(element: HTMLTextAreaElement | null, value?: number) {
    if (!element) {
        return;
    }
    const height = value === undefined ? element.scrollHeight : value;
    element.style.height = 'auto';
    element.style.height = `${Math.min(Math.max(height, 24), 320)}px`;
}

export interface ComposerProps {
    channel: MMChannel;
    replyTo: MMPost | null;
    editing: MMPost | null;
    rootId?: string;
    onCancelReply: () => void;
    onCancelEdit: () => void;
    onSend: (payload: {message: string; fileIds: string[]; rootId?: string; files?: MMFileInfo[]; voice?: {fileId: string; durationMs: number; levels: number[]}}) => Promise<any>;
    onSent: () => void;
    placeholder?: string;
}

interface PendingFile {
    clientId: string;
    file: File;
    info?: MMFileInfo;
    error?: string;
    /** Set on files that came out of the voice recorder, for the tray chip preview. */
    voice?: {durationMs: number; levels: number[]};
}

export function Composer({channel, replyTo, editing, rootId, onCancelReply, onCancelEdit, onSend, onSent, placeholder}: ComposerProps) {
    const {ui, actions, me} = useTg();
    const [message, setMessage] = useState('');
    const [files, setFiles] = useState<PendingFile[]>([]);
    const [sending, setSending] = useState(false);
    const [showEmoji, setShowEmoji] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const voice = useVoiceRecorder((message) => actions.toast(message, 'error'));
    const recording = voice.status === 'recording';
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

    useEffect(() => {
        if (editing) {
            setMessage(editing.message || '');
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
    // left alone.
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
        const timers = [setTimeout(reclaim, 80), setTimeout(reclaim, 400)];
        return () => timers.forEach((timer) => clearTimeout(timer));
    }, [channel.id, ui.chatSeq]);

    // The textarea height is imperative (style.height), so every programmatic message change —
    // loading a long message for editing, inserting emoji/markdown — must re-measure, not just
    // the onChange path. Without this an edit of a large message stayed stuck at one line.
    useLayoutEffect(() => {
        autoGrow(textareaRef.current);
    }, [message]);

    // A take must land in the chat it was recorded in: switching away discards it.
    const channelRef = useRef(channel.id);
    useEffect(() => {
        if (channelRef.current !== channel.id) {
            channelRef.current = channel.id;
            if (voice.status === 'recording') {
                void voice.cancel();
            }
        }
    }, [channel.id, voice]);

    const reset = () => {
        setMessage('');
        setFiles([]);
        autoGrow(textareaRef.current, 0);
    };

    const insertMarkdown = (prefix: string, suffix = prefix, placeholderText = '') => {
        const element = textareaRef.current;
        if (!element) {
            return;
        }
        const start = element.selectionStart;
        const end = element.selectionEnd;
        const selection = message.slice(start, end) || placeholderText;
        const next = `${message.slice(0, start)}${prefix}${selection}${suffix}${message.slice(end)}`;
        setMessage(next);
        requestAnimationFrame(() => {
            element.focus();
            element.setSelectionRange(start + prefix.length, start + prefix.length + selection.length);
        });
    };

    const uploadFiles = async (incoming: FileList | File[] | null, voiceMeta?: {durationMs: number; levels: number[]}) => {
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
        }));
        setFiles((current) => [...current, ...additions]);
        for (const entry of additions) {
            try {
                const result = await api.uploadFile(channel.id, entry.file, entry.clientId);
                const info = result?.file_infos?.[0];
                setFiles((current) => current.map((item) => (item.clientId === entry.clientId ? {...item, info} : item)));
            } catch (error: any) {
                setFiles((current) => current.map((item) => (item.clientId === entry.clientId ? {...item, error: error?.message || 'Upload failed'} : item)));
            }
        }
    };

    const stopRecording = async () => {
        const take = await voice.finish();
        if (take) {
            await uploadFiles([take.file], {durationMs: take.durationMs, levels: take.levels});
        }
    };

    const send = async () => {
        const trimmed = message.trim();
        const ready = files.filter((entry) => entry.info);
        const readyFiles = ready.map((entry) => entry.info!.id);
        if (!trimmed && !readyFiles.length) {
            return;
        }
        if (sending) {
            return;
        }
        setSending(true);
        try {
            if (editing) {
                await api.patchPost(editing.id, {message: trimmed});
                onCancelEdit();
                reset();
            } else {
                const voiceEntry = ready.find((entry) => entry.voice);
                await onSend({
                    message: trimmed,
                    fileIds: readyFiles,
                    rootId: threadRootId,
                    files: ready.map((entry) => entry.info!),
                    voice: voiceEntry && voiceEntry.info
                        ? {fileId: voiceEntry.info.id, durationMs: voiceEntry.voice!.durationMs, levels: voiceEntry.voice!.levels}
                        : undefined,
                });
                reset();
                // The reply bar must disappear once the reply went out, otherwise every later
                // message would be threaded as well.
                if (replyTo) {
                    onCancelReply();
                }
                onSent();
            }
            setShowEmoji(false);
        } catch (error: any) {
            actions.toast(error?.message || 'Could not send the message', 'error');
        }
        setSending(false);
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
        if (event.key === 'ArrowUp' && !message && !files.length && !editing) {
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
        return placeholder || `Message ${channel.display_name || ''}`.trim();
    }, [editing, placeholder, channel.display_name]);

    return (
        <div className={`tgw-composer ${editing ? 'tgw-composer-editing' : ''}`}>
            {replyTo && !editing && (
                <div className="tgw-reply-bar">
                    <span className="tgw-reply-bar-body">
                        <span className="tgw-reply-bar-title">Reply to {replyAuthor ? displayName(replyAuthor) : 'message'}</span>
                        <span className="tgw-reply-bar-text">{toPlainPreview(replyTo.message, 100) || attachmentSummary(replyTo.metadata?.files) || 'Attachment'}</span>
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
                        <span className="tgw-reply-bar-text">{toPlainPreview(editing.message, 100)}</span>
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
                                {fileKindOf(entry.file.type || entry.file.name) === 'image' && !entry.error ? (
                                    <img src={URL.createObjectURL(entry.file)} alt={entry.file.name}/>
                                ) : (
                                    <span className="tgw-attachment-chip-icon">{entry.file.name.split('.').pop()?.toUpperCase().slice(0, 4) || 'FILE'}</span>
                                )}
                                <span className="tgw-attachment-chip-meta">
                                    <span className="tgw-attachment-chip-name">{entry.file.name}</span>
                                    <span className="tgw-attachment-chip-size">{entry.error || (entry.info ? formatBytes(entry.info.size) : 'Uploading…')}</span>
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
            </div>

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
                            uploadFiles(event.target.files);
                            event.target.value = '';
                        }}
                    />
                    {voice.supported && !editing && (
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
                        placeholder={placeholderText}
                        rows={1}
                        spellCheck={false}
                        onChange={(event) => {
                            setMessage(event.target.value);
                            autoGrow(event.target);
                            typingRef.current();
                        }}
                        onKeyDown={onKeyDown}
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
                            uploadFiles(pasted);
                        }}
                    />
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
                        onClick={send}
                        disabled={sending}
                        title={editing ? 'Save changes' : 'Send'}
                    >
                        {editing ? <IconEdit size={18}/> : <IconSend size={18}/>}
                    </button>
                </div>
            )}

            {showEmoji && (
                <EmojiPicker
                    onClose={() => setShowEmoji(false)}
                    onPick={(name) => {
                        const element = textareaRef.current;
                        const text = `:${name}: `;
                        if (element) {
                            const start = element.selectionStart ?? message.length;
                            const next = `${message.slice(0, start)}${text}${message.slice(element.selectionEnd ?? start)}`;
                            setMessage(next);
                            requestAnimationFrame(() => {
                                element.focus();
                                element.setSelectionRange(start + text.length, start + text.length);
                            });
                        } else {
                            setMessage((current) => `${current}${text}`);
                        }
                    }}
                />
            )}
        </div>
    );
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
