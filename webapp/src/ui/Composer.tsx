// Message composer: markdown-lite toolbar, attachments, emoji, reply/edit modes, typing events.

import React, {useEffect, useMemo, useRef, useState} from 'react';
import {api} from '../mm/api';
import {displayName, fileKindOf, formatBytes, throttle, toPlainPreview} from '../mm/utils';
import type {MMChannel, MMFileInfo, MMPost} from '../mm/types';
import {useTg} from './context';
import {EmojiPicker} from './EmojiPicker';
import {IconAttach, IconBold, IconClose, IconCode, IconEdit, IconEmoji, IconItalic, IconLink, IconQuote, IconSend, IconStrike} from './primitives';
import {getState, useSelector} from '../mm/store';

export interface ComposerProps {
    channel: MMChannel;
    replyTo: MMPost | null;
    editing: MMPost | null;
    rootId?: string;
    onCancelReply: () => void;
    onCancelEdit: () => void;
    onSend: (payload: {message: string; fileIds: string[]; rootId?: string}) => Promise<any>;
    onSent: () => void;
    placeholder?: string;
}

interface PendingFile {
    clientId: string;
    file: File;
    info?: MMFileInfo;
    error?: string;
}

export function Composer({channel, replyTo, editing, rootId, onCancelReply, onCancelEdit, onSend, onSent, placeholder}: ComposerProps) {
    const {actions, me} = useTg();
    const [message, setMessage] = useState('');
    const [files, setFiles] = useState<PendingFile[]>([]);
    const [sending, setSending] = useState(false);
    const [showEmoji, setShowEmoji] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
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

    const reset = () => {
        setMessage('');
        setFiles([]);
        autoGrow(textareaRef.current, 0);
    };

    const autoGrow = (element: HTMLTextAreaElement | null, value?: number) => {
        if (!element) {
            return;
        }
        const height = value === undefined ? element.scrollHeight : value;
        element.style.height = 'auto';
        element.style.height = `${Math.min(Math.max(height, 24), 320)}px`;
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

    const uploadFiles = async (incoming: FileList | File[] | null) => {
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

    const send = async () => {
        const trimmed = message.trim();
        const readyFiles = files.filter((entry) => entry.info).map((entry) => entry.info!.id);
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
                await onSend({message: trimmed, fileIds: readyFiles, rootId: threadRootId});
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
                        <span className="tgw-reply-bar-text">{toPlainPreview(replyTo.message, 100) || 'Attachment'}</span>
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


