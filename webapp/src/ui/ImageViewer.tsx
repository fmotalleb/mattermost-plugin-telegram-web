import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {api} from '../mm/api';
import {useChannelPosts} from '../mm/posts';
import type {MMFileInfo, MMPost} from '../mm/types';
import {fileKindOf, toPlainPreview} from '../mm/utils';
import {useTg} from './context';
import {filesOfPost} from './MessageList';
import {ImageEditor} from './ImageEditor';
import {overlayRoot} from './portal';
import {IconBack, IconClose, IconDownload, IconForward} from './primitives';

type View = {scale: number; x: number; y: number};
type Point = {x: number; y: number};

interface ImageCanvasProps {
    src: string;
    name: string;
    editing: boolean;
    onEdit?: (source: HTMLImageElement) => void;
    onReady?: (source: HTMLImageElement) => void;
}

function ImageCanvas({src, name, editing, onEdit, onReady}: ImageCanvasProps) {
    const viewport = useRef<HTMLDivElement>(null);
    const source = useRef<HTMLImageElement>(null);
    const pointers = useRef(new Map<number, Point>());
    const backdropPress = useRef<Point | null>(null);
    const [size, setSize] = useState({width: 0, height: 0});
    const [image, setImage] = useState({width: 0, height: 0});
    const [view, setView] = useState<View>({scale: 1, x: 0, y: 0});
    const [dragging, setDragging] = useState(false);
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const ready = image.width > 0 && image.height > 0;
    const fit = ready && size.width && size.height ? Math.min(size.width / image.width, size.height / image.height, 1) : 1;
    const minimum = Math.min(fit, 0.1);
    const constrain = (next: View): View => {
        const x = Math.max(0, (image.width * next.scale - size.width) / 2);
        const y = Math.max(0, (image.height * next.scale - size.height) / 2);
        return {...next, x: Math.max(-x, Math.min(x, next.x)), y: Math.max(-y, Math.min(y, next.y))};
    };
    const zoom = (scale: number, anchor: Point = {x: 0, y: 0}, destination = anchor) => {
        setView((current) => {
            const next = Math.max(minimum, Math.min(8, scale));
            return constrain({scale: next, x: destination.x - (anchor.x - current.x) * next / current.scale, y: destination.y - (anchor.y - current.y) * next / current.scale});
        });
    };
    const reset = () => setView({scale: fit, x: 0, y: 0});
    const live = useRef({view, zoom, reset, editing}); live.current = {view, zoom, reset, editing};
    React.useLayoutEffect(() => {
        const measure = () => {
            const rect = viewport.current?.getBoundingClientRect();
            if (rect?.width && rect.height) setSize({width: rect.width, height: rect.height});
        };
        measure();
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
        if (viewport.current) observer?.observe(viewport.current);
        window.addEventListener('resize', measure);
        return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
    }, []);
    React.useLayoutEffect(() => { reset(); pointers.current.clear(); setDragging(false); }, [fit, size.width, size.height]);
    useEffect(() => {
        if (!onEdit) return;
        const element = viewport.current;
        const wheel = (event: WheelEvent) => {
            event.preventDefault(); event.stopPropagation();
            const rect = element.getBoundingClientRect();
            const anchor = {x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2};
            live.current.zoom(live.current.view.scale * Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.002), anchor);
        };
        const keydown = (event: KeyboardEvent) => {
            if (live.current.editing || event.ctrlKey || event.metaKey || event.altKey) return;
            if (event.key === '+' || event.key === '=') { event.preventDefault(); live.current.zoom(live.current.view.scale * 1.25); }
            if (event.key === '-') { event.preventDefault(); live.current.zoom(live.current.view.scale / 1.25); }
            if (event.key === '0') { event.preventDefault(); live.current.reset(); }
        };
        element?.addEventListener('wheel', wheel, {passive: false});
        document.addEventListener('keydown', keydown);
        return () => { element?.removeEventListener('wheel', wheel); document.removeEventListener('keydown', keydown); };
    }, [onEdit]);
    const endPointer = (event: React.PointerEvent<HTMLDivElement>) => {
        pointers.current.delete(event.pointerId);
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        setDragging(pointers.current.size > 0);
    };
    return <div className="tgw-image-viewer-body" style={editing ? {display: 'none'} : undefined}>
        {onEdit && <div className="tgw-image-viewer-tools" role="toolbar" aria-label="Image zoom controls">
            <button type="button" aria-label="Zoom out" disabled={!ready || view.scale <= minimum} onClick={() => zoom(view.scale / 1.25)}>−</button>
            <output aria-live="polite">{ready ? `${Math.round(view.scale * 100)}%` : '…'}</output>
            <button type="button" aria-label="Zoom in" disabled={!ready || view.scale >= 8} onClick={() => zoom(view.scale * 1.25)}>+</button>
            <button type="button" disabled={!ready} onClick={reset}>Fit</button>
            <button type="button" disabled={!ready} onClick={() => { setView(constrain({scale: 1, x: 0, y: 0})); }}>100%</button>
            <span className="tgw-image-viewer-hint">Scroll to zoom · Drag to pan</span>
            <button type="button" className="tgw-image-viewer-edit" disabled={!ready} onClick={() => onEdit(source.current)}>Edit</button>
        </div>}
        <div className={`tgw-image-viewer-viewport${dragging ? ' tgw-image-viewer-dragging' : ''}`} ref={viewport} tabIndex={onEdit ? 0 : undefined} aria-label={onEdit ? 'Image canvas; scroll to zoom, drag to pan' : undefined}
            onClick={(event) => {
                // Pointer capture can produce a canvas click after a pan or pinch.
                if (ready && event.detail > 0 && event.target === event.currentTarget && !backdropPress.current) event.stopPropagation();
            }}
            onDoubleClick={() => { const scale = Math.abs(view.scale - fit) < 0.001 ? Math.max(1, fit * 2) : fit; setView(constrain({scale, x: 0, y: 0})); }}
            onPointerDown={(event) => {
                if (event.button !== 0 || !ready) return;
                event.preventDefault();
                const point = {x: event.clientX, y: event.clientY};
                backdropPress.current = pointers.current.size === 0 && event.target === event.currentTarget ? point : null;
                pointers.current.set(event.pointerId, point);
                event.currentTarget.setPointerCapture?.(event.pointerId);
                setDragging(true);
            }} onPointerMove={(event) => {
                const old = pointers.current.get(event.pointerId);
                if (!old) return;
                const before = Array.from(pointers.current.values());
                const point = {x: event.clientX, y: event.clientY};
                const press = backdropPress.current;
                if (press && Math.hypot(point.x - press.x, point.y - press.y) > 5) backdropPress.current = null;
                pointers.current.set(event.pointerId, point);
                if (pointers.current.size === 1) {
                    setView((current) => constrain({...current, x: current.x + point.x - old.x, y: current.y + point.y - old.y}));
                } else if (pointers.current.size === 2) {
                    const after = Array.from(pointers.current.values());
                    const distance = (pair: Point[]) => Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y);
                    const rect = event.currentTarget.getBoundingClientRect();
                    const middle = (pair: Point[]) => ({x: (pair[0].x + pair[1].x) / 2 - rect.left - rect.width / 2, y: (pair[0].y + pair[1].y) / 2 - rect.top - rect.height / 2});
                    if (distance(before) > 0) zoom(view.scale * distance(after) / distance(before), middle(before), middle(after));
                }
            }} onPointerUp={endPointer} onPointerCancel={endPointer} onLostPointerCapture={endPointer}>
            {!ready && !failed && <span className="tgw-image-viewer-status" role="status">Loading image…</span>}
            {failed && <div className="tgw-image-viewer-status" role="alert">Could not load image. <button type="button" onClick={() => { setFailed(false); setAttempt((value) => value + 1); }}>Retry</button></div>}
            <div className="tgw-image-viewer-stage" style={{width: image.width, height: image.height, opacity: ready ? 1 : 0, transform: `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px)) scale(${view.scale})`}}>
                <img key={attempt} ref={source} src={src} alt={name || 'Image attachment'} draggable={false} onLoad={(event) => {
                    const loaded = event.currentTarget;
                    setFailed(false); setImage({width: loaded.naturalWidth, height: loaded.naturalHeight});
                    if (loaded.naturalWidth && loaded.naturalHeight) onReady?.(loaded);
                }} onError={() => { setFailed(true); setImage({width: 0, height: 0}); }}/>
            </div>
        </div>
    </div>;
}

export function ImageViewer() {
    const {ui, actions, channel} = useTg();
    const target = ui.imageViewer;
    const {posts} = useChannelPosts(channel?.id);
    const images = useMemo(() => {
        const list: Array<{post: MMPost; file: MMFileInfo}> = [];
        const seen = new Set<string>();
        const push = (post?: MMPost | null) => {
            if (!post) return;
            filesOfPost(post).forEach((file) => {
                if (fileKindOf(file.mime_type || file.name) !== 'image' || seen.has(file.id)) return;
                seen.add(file.id); list.push({post, file});
            });
        };
        posts.forEach(push); push(target?.post);
        return list;
    }, [posts, target]);
    const [index, setIndex] = useState(0);
    const lastTarget = useRef('');
    const targetKey = target ? `${target.post.id}:${target.fileId || ''}` : '';
    if (targetKey !== lastTarget.current) {
        lastTarget.current = targetKey;
        const found = images.findIndex((entry) => entry.post.id === target?.post.id && (!target?.fileId || entry.file.id === target.fileId));
        setIndex(found >= 0 ? found : 0);
    }
    const close = useCallback(() => actions.setUI({imageViewer: null}), [actions]);
    const move = useCallback((step: number) => setIndex((current) => images.length ? (current + step + images.length) % images.length : 0), [images.length]);
    if (!target || !images.length) return null;
    const position = Math.min(index, images.length - 1);
    const {post, file} = images[position];
    return <ImagePreview key={targetKey} src={api.fileURL(file.id)} name={file.name} onClose={close}
        gallery={{caption: toPlainPreview(post.message, 1000), position, count: images.length, move}}/>;
}

interface ImagePreviewProps {
    src: string;
    name: string;
    onClose: () => void;
    gallery?: {caption: string; position: number; count: number; move: (step: number) => void};
    onApply?: (file: File) => void;
    onSend?: (file: File) => void;
}

export function ImagePreview({src, name, onClose, gallery, onApply, onSend}: ImagePreviewProps) {
    const dialog = useRef<HTMLDivElement>(null);
    const [editor, setEditor] = useState<HTMLImageElement | null>(null);
    const editorOnly = !!onApply;
    const wasEditing = useRef(false);
    const handlers = useRef({onClose, gallery, editing: !!editor, editorOnly});
    handlers.current = {onClose, gallery, editing: !!editor, editorOnly};
    React.useLayoutEffect(() => {
        const previous = document.activeElement as HTMLElement;
        const controls = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]') || [])
            .filter((item) => !handlers.current.editing || !item.closest('.tgw-image-viewer-body'));
        dialog.current?.querySelector<HTMLElement>('.tgw-image-viewer-close')?.focus();
        const keydown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopImmediatePropagation();
                if (handlers.current.editing && !handlers.current.editorOnly) setEditor(null);
                else handlers.current.onClose();
            }
            if (!handlers.current.editing && handlers.current.gallery && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
                event.preventDefault();
                event.stopImmediatePropagation();
                handlers.current.gallery.move(event.key === 'ArrowLeft' ? -1 : 1);
            }
            if (event.key === 'Tab') {
                event.preventDefault(); event.stopImmediatePropagation();
                const items = controls();
                const index = items.indexOf(document.activeElement as HTMLElement);
                const next = index < 0 ? (event.shiftKey ? items.length - 1 : 0) : index + (event.shiftKey ? -1 : 1);
                items[(next + items.length) % items.length]?.focus();
            }
        };
        const focus = (event: FocusEvent) => { if (!dialog.current?.contains(event.target as Node)) controls()[0]?.focus(); };
        document.addEventListener('keydown', keydown, true);
        document.addEventListener('focusin', focus);
        return () => {
            document.removeEventListener('keydown', keydown, true);
            document.removeEventListener('focusin', focus);
            if (previous?.isConnected) previous.focus({preventScroll: true});
        };
    }, []);
    React.useLayoutEffect(() => {
        if (editorOnly) return;
        if (editor) dialog.current?.querySelector<HTMLElement>('.tgw-image-editor-back')?.focus();
        else if (wasEditing.current) dialog.current?.querySelector<HTMLElement>('.tgw-image-viewer-edit')?.focus();
        wasEditing.current = !!editor;
    }, [editor, editorOnly]);
    return createPortal(<div className="tgw-image-viewer" ref={dialog} role="dialog" aria-modal="true" aria-label={editor || editorOnly ? 'Image editor' : 'Image viewer'} onClick={(event) => {
        event.stopPropagation();
        if (!editorOnly && !editor && !(event.target as Element).closest('.tgw-image-viewer-stage, button, a, .tgw-image-viewer-caption')) onClose();
    }}>
        <header className="tgw-image-viewer-header">
            <span className="tgw-image-viewer-name">{editor?.alt || name || 'Image attachment'}</span>
            {editor && !editorOnly && <button className="tgw-image-editor-back" type="button" title="Discard edits and return to preview" onClick={() => setEditor(null)}>Back to preview</button>}
            {!editor && gallery && <a href={src} download={name} target="_blank" rel="noopener noreferrer" aria-label="Download image" title="Download image"><IconDownload size={20}/></a>}
            <button type="button" className="tgw-image-viewer-close" onClick={onClose} title="Close" aria-label={editorOnly ? 'Close image editor' : 'Close image viewer'}><IconClose size={24}/></button>
        </header>
        <ImageCanvas key={src} src={src} name={name} editing={!!editor}
            onEdit={editorOnly ? undefined : setEditor} onReady={editorOnly ? setEditor : undefined}/>
        {editor && <ImageEditor source={editor} name={editor.alt} onApply={onApply} onSend={onSend}/>}
        {!editor && gallery?.count > 1 && <>
            <button type="button" className="tgw-image-viewer-nav tgw-image-viewer-prev" onClick={() => gallery.move(-1)} title="Previous attachment" aria-label="Previous image"><IconBack size={24}/></button>
            <button type="button" className="tgw-image-viewer-nav tgw-image-viewer-next" onClick={() => gallery.move(1)} title="Next attachment" aria-label="Next image"><IconForward size={24}/></button>
        </>}
        {!editor && gallery && <footer className="tgw-image-viewer-footer">
            {gallery.caption && <div className="tgw-image-viewer-caption">{gallery.caption}</div>}
            {gallery.count > 1 && <div className="tgw-image-viewer-count">{gallery.position + 1} / {gallery.count}</div>}
        </footer>}
    </div>, overlayRoot());
}
