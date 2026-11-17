import React, {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {overlayRoot} from './portal';

let nextDiagram = 0;
let engine: Promise<typeof import('mermaid')['default']>;
function loadMermaid() {
    if (!engine) {
        engine = import(/* webpackChunkName: "mermaid-engine" */ 'mermaid').then(({default: mermaid}) => {
            mermaid.initialize({
                startOnLoad: false, securityLevel: 'strict', theme: 'default',
                suppressErrorRendering: true, maxTextSize: 50000, maxEdges: 500,
                // Do not let message directives weaken the renderer's security settings.
                secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges',
                    'suppressErrorRendering', 'dompurifyConfig'],
            });
            return mermaid;
        }).catch((error) => { engine = undefined; throw error; });
    }
    return engine;
}

function DiagramSvg({source, onReady}: {source: string; onReady?: () => void}) {
    const [result, setResult] = useState({source: '', svg: '', error: false});
    const root = useRef<HTMLSpanElement>(null);
    const [attempt, setAttempt] = useState(0);
    const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');
    useEffect(() => {
        if (visible || !root.current) return undefined;
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
        }, {rootMargin: '160px'});
        observer.observe(root.current);
        return () => observer.disconnect();
    }, [visible]);
    useEffect(() => {
        if (!visible) return undefined;
        let cancelled = false;
        loadMermaid().then((mermaid) => mermaid.render(`tgw-mermaid-${++nextDiagram}`, source))
            .then(({svg}) => { if (!cancelled) { setResult({source, svg, error: false}); onReady?.(); } })
            .catch(() => { if (!cancelled) setResult({source, svg: '', error: true}); });
        return () => { cancelled = true; };
    }, [source, visible, attempt]);
    // Mermaid sanitizes its SVG in strict mode. Never bind diagram-provided click handlers.
    return <span ref={root} className="tgw-mermaid-content">
        {result.source !== source ? <span role="status">Rendering diagram…</span>
            : result.error ? <span className="tgw-mermaid-error"><span role="status">Could not render Mermaid diagram.</span><button type="button" className="tgw-link-button" onClick={() => setAttempt((value) => value + 1)}>Retry</button><code className="tgw-code-block">{source}</code></span>
                : <span className="tgw-mermaid-svg" dangerouslySetInnerHTML={{__html: result.svg}}/>}
    </span>;
}

function DiagramModal({source, onClose}: {source: string; onClose: () => void}) {
    const dialog = useRef<HTMLDivElement>(null);
    const viewport = useRef<HTMLDivElement>(null);
    const drag = useRef<{id: number; x: number; y: number; left: number; top: number}>(undefined);
    const [zoom, setZoom] = useState(1);
    const changeZoom = (factor: number) => setZoom((value) => Math.max(0.25, Math.min(5, Math.round(value * factor * 100) / 100)));
    const reset = () => { setZoom(1); viewport.current?.scrollTo?.(0, 0); };
    useEffect(() => {
        const previous = document.activeElement as HTMLElement;
        const controls = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>('button, [tabindex="0"]') || []);
        controls()[0]?.focus();
        const keydown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); onClose(); }
            if (event.key === 'Tab') {
                event.preventDefault(); event.stopImmediatePropagation();
                const items = controls();
                const index = items.indexOf(document.activeElement as HTMLElement);
                items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
            }
        };
        const focus = (event: FocusEvent) => { if (!dialog.current?.contains(event.target as Node)) controls()[0]?.focus(); };
        const wheel = (event: WheelEvent) => { event.preventDefault(); changeZoom(event.deltaY < 0 ? 1.2 : 1 / 1.2); };
        const view = viewport.current;
        view?.addEventListener('wheel', wheel, {passive: false});
        document.addEventListener('keydown', keydown, true);
        document.addEventListener('focusin', focus);
        return () => {
            view?.removeEventListener('wheel', wheel);
            document.removeEventListener('keydown', keydown, true);
            document.removeEventListener('focusin', focus);
            if (previous?.isConnected) previous.focus({preventScroll: true});
        };
    }, []);
    return createPortal(<div className="tgw-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
        onClick={(event) => event.stopPropagation()} onContextMenu={(event) => event.stopPropagation()}>
        <div className="tgw-modal tgw-mermaid-modal" role="dialog" aria-modal="true" aria-label="Mermaid diagram" ref={dialog}>
            <header className="tgw-modal-header"><span>Mermaid diagram</span><button type="button" className="tgw-button" onClick={onClose}>Close</button></header>
            <div className="tgw-mermaid-toolbar">
                <button type="button" className="tgw-button" aria-label="Zoom out" disabled={zoom <= 0.25} onClick={() => changeZoom(1 / 1.2)}>−</button>
                <output aria-live="polite">{Math.round(zoom * 100)}%</output>
                <button type="button" className="tgw-button" aria-label="Zoom in" disabled={zoom >= 5} onClick={() => changeZoom(1.2)}>+</button>
                <button type="button" className="tgw-button" onClick={reset}>Reset view</button>
                <span>Scroll to zoom · Drag to pan</span>
            </div>
            <div className="tgw-mermaid-viewport" ref={viewport} tabIndex={0} aria-label="Diagram canvas; use arrow keys to pan"
                onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    const view = event.currentTarget;
                    drag.current = {id: event.pointerId, x: event.clientX, y: event.clientY, left: view.scrollLeft, top: view.scrollTop};
                    view.setPointerCapture(event.pointerId);
                }} onPointerMove={(event) => {
                    const start = drag.current;
                    if (!start || start.id !== event.pointerId) return;
                    event.currentTarget.scrollLeft = start.left + start.x - event.clientX;
                    event.currentTarget.scrollTop = start.top + start.y - event.clientY;
                }} onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }}>
                <div className="tgw-mermaid-stage" style={{width: `${zoom * 100}%`, minHeight: `${zoom * 100}%`}}>
                    <DiagramSvg source={source}/>
                </div>
            </div>
        </div>
    </div>, overlayRoot());
}

export function MermaidDiagram({source}: {source: string}) {
    const [open, setOpen] = useState(false);
    const [ready, setReady] = useState(false);
    useEffect(() => { setOpen(false); setReady(false); }, [source]);
    return <span className="tgw-mermaid" onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
        <DiagramSvg source={source} onReady={() => setReady(true)}/>
        <button type="button" className="tgw-button tgw-mermaid-open" disabled={!ready} onClick={() => setOpen(true)}>Open diagram</button>
        {open && <DiagramModal source={source} onClose={() => setOpen(false)}/>}
    </span>;
}
