import React, {useEffect, useRef, useState} from 'react';
import type {PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask} from 'pdfjs-dist';
import {api} from '../mm/api';
import {loadPDFJS, pdfAssetURL} from '../mm/pdf';
import type {MMFileInfo} from '../mm/types';
import {IconBack, IconForward} from './primitives';

export function PDFPreview({file}: {file: MMFileInfo}) {
    const [pdf, setPDF] = useState<PDFDocumentProxy | null>(null);
    const [error, setError] = useState('');
    const [attempt, setAttempt] = useState(0);
    const [pageNumber, setPageNumber] = useState(1);
    const [zoom, setZoom] = useState(1);
    const [width, setWidth] = useState(0);
    const [rendering, setRendering] = useState(false);
    const [password, setPassword] = useState('');
    const [passwordRequest, setPasswordRequest] = useState<{verify: (value: string) => void; incorrect: boolean} | null>(null);
    const viewport = useRef<HTMLDivElement>(null);
    const canvas = useRef<HTMLCanvasElement>(null);
    const renderTask = useRef<RenderTask | null>(null);

    useEffect(() => {
        const controller = new AbortController();
        let task: PDFDocumentLoadingTask | undefined;
        setPDF(null); setError(''); setPageNumber(1); setZoom(1); setPassword(''); setPasswordRequest(null);
        const load = async () => {
            if (file.size > 25 * 1024 * 1024) throw new Error('This file is too large to preview. Please download it instead.');
            const [pdfjs, blob] = await Promise.all([
                loadPDFJS(), api.getFilePreview(file.id, 25 * 1024 * 1024, controller.signal),
            ]);
            const data = new Uint8Array(await blob.arrayBuffer());
            if (controller.signal.aborted) return;
            task = pdfjs.getDocument({
                data,
                cMapUrl: pdfAssetURL('cmaps/'), cMapPacked: true,
                standardFontDataUrl: pdfAssetURL('standard_fonts/'),
                wasmUrl: pdfAssetURL('wasm/'),
            });
            task.onPassword = (verify, reason) => {
                if (!controller.signal.aborted) setPasswordRequest({verify, incorrect: reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD});
            };
            const document = await task.promise;
            if (!controller.signal.aborted) setPDF(document);
        };
        load().catch((err) => {
            if (!controller.signal.aborted) {
                setError(err.message || 'Could not open this PDF.');
                controller.abort();
                task?.destroy().catch(() => {});
            }
        });
        return () => {
            controller.abort();
            // Destroying the loading task releases its document, fonts, and worker, even if
            // closing while a page is rendering or while a password is being requested.
            task?.destroy().catch(() => {});
        };
    }, [file.id, file.size, attempt]);

    useEffect(() => {
        const element = viewport.current;
        if (!element) return;
        const measure = () => setWidth(Math.max(1, element.clientWidth - 32));
        measure();
        const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
        observer?.observe(element);
        window.addEventListener('resize', measure);
        return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
    }, [pdf]);

    useEffect(() => {
        if (!pdf || !width) return;
        let active = true;
        let task: RenderTask | undefined;
        setRendering(true);
        const render = async () => {
            const previous = renderTask.current;
            if (previous) { previous.cancel(); await previous.promise.catch(() => {}); }
            const page = await pdf.getPage(pageNumber);
            if (!active || !canvas.current) return;
            const natural = page.getViewport({scale: 1});
            const view = page.getViewport({scale: width / natural.width * zoom});
            // Limit high-DPI canvas allocation for very large or unusually tall pages.
            const ratio = Math.min(window.devicePixelRatio || 1, 2,
                Math.sqrt(16 * 1024 * 1024 / (view.width * view.height)),
                8192 / Math.max(view.width, view.height));
            const element = canvas.current;
            element.width = Math.max(1, Math.floor(view.width * ratio));
            element.height = Math.max(1, Math.floor(view.height * ratio));
            element.style.width = `${view.width}px`; element.style.height = `${view.height}px`;
            task = page.render({canvas: element, canvasContext: element.getContext('2d')!, viewport: view,
                transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0]});
            renderTask.current = task;
            await task.promise;
            if (active) setRendering(false);
        };
        render().catch((err) => {
            if (active && err.name !== 'RenderingCancelledException') { setError('Could not render this PDF page. Please retry.'); setRendering(false); }
        });
        return () => { active = false; task?.cancel(); };
    }, [pdf, width, pageNumber, zoom]);

    const move = (step: number) => {
        const next = Math.max(1, Math.min(pdf?.numPages || 1, pageNumber + step));
        if (next === pageNumber) return;
        setRendering(true);
        setPageNumber(next);
        viewport.current?.scrollTo?.(0, 0);
    };
    if (error) return <div role="alert">{error} <button type="button" className="tgw-button" onClick={() => setAttempt((value) => value + 1)}>Retry</button></div>;
    if (passwordRequest) return <form className="tgw-pdf-password" onSubmit={(event) => {
        event.preventDefault(); passwordRequest.verify(password); setPassword(''); setPasswordRequest(null);
    }}>
        <label>This PDF is password protected.
            <input autoFocus type="password" className="tgw-input" aria-label="PDF password" value={password} onChange={(event) => setPassword(event.target.value)}/>
        </label>
        {passwordRequest.incorrect && <span role="alert">Incorrect password. Try again.</span>}
        <button type="submit" className="tgw-button" disabled={!password}>Open PDF</button>
    </form>;
    if (!pdf) return <div role="status">Loading PDF viewer…</div>;
    return <div className="tgw-pdf-viewer" onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); move(event.key === 'ArrowLeft' ? -1 : 1); }
    }}>
        <div className="tgw-pdf-toolbar" role="toolbar" aria-label="PDF controls">
            <button type="button" className="tgw-button tgw-button-secondary" aria-label="Previous PDF page" disabled={pageNumber <= 1} onClick={() => move(-1)}><IconBack size={18}/></button>
            <span className="tgw-pdf-page-count" aria-live="polite">Page {pageNumber} of {pdf.numPages}</span>
            <button type="button" className="tgw-button tgw-button-secondary" aria-label="Next PDF page" disabled={pageNumber >= pdf.numPages} onClick={() => move(1)}><IconForward size={18}/></button>
            <span className="tgw-pdf-toolbar-spacer"/>
            <button type="button" className="tgw-button tgw-button-secondary" aria-label="Zoom PDF out" disabled={zoom <= .5} onClick={() => setZoom((value) => Math.max(.5, value - .25))}>−</button>
            <button type="button" className="tgw-button tgw-button-secondary" onClick={() => setZoom(1)} title="Fit PDF to width">{Math.round(zoom * 100)}%</button>
            <button type="button" className="tgw-button tgw-button-secondary" aria-label="Zoom PDF in" disabled={zoom >= 3} onClick={() => setZoom((value) => Math.min(3, value + .25))}>+</button>
        </div>
        <div className="tgw-pdf-viewport" ref={viewport} tabIndex={0} aria-label="PDF pages" aria-busy={rendering}>
            {rendering && <div className="tgw-pdf-rendering" role="status">Rendering page…</div>}
            <canvas ref={canvas} role="img" aria-label={`${file.name}, page ${pageNumber} of ${pdf.numPages}`}/>
        </div>
    </div>;
}
