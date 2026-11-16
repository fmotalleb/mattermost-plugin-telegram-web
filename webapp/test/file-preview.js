const {dom, React, ReactDOM, container, tick, ok, report, store} = require('./harness');
const {Blob: NativeBlob} = require('buffer');
global.Blob = NativeBlob;
const {setStore} = require('../src/mm/store');
const {api} = require('../src/mm/api');
const {filePreviewKind} = require('../src/mm/file-preview');
const pdfModule = require('../src/mm/pdf');
const {TgContext} = require('../src/ui/context');
const {Attachment} = require('../src/ui/MessageList');
const {Modals} = require('../src/ui/Modals');
setStore(store);
const root = ReactDOM.createRoot(container);
const files = [
    {id: 'preview-text', name: 'notes.txt', mime_type: 'text/plain', size: 100},
    {id: 'preview-pdf', name: 'report.pdf', mime_type: 'application/octet-stream', size: 100},
    {id: 'preview-big', name: 'large.log', mime_type: 'text/plain', size: 3 * 1024 * 1024},
    {id: 'preview-zip', name: 'archive.zip', mime_type: 'application/zip', size: 100},
    {id: 'preview-big-pdf', name: 'large.pdf', mime_type: 'application/pdf', size: 26 * 1024 * 1024},
];
const originalFetch = global.fetch;
let requests = [], failNext = false, engineLoads = 0, destroyed = 0, cancelled = 0, parsed = [], rendered = [], badPDF = false;
let finishPending;
let passwordMode = false;
const passwords = [];
const originalLoader = pdfModule.loadPDFJS;
dom.window.HTMLCanvasElement.prototype.getContext = () => ({});
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', {configurable: true, get() {return this.classList.contains('tgw-pdf-viewport') ? 640 : 0;}});
pdfModule.loadPDFJS = async () => {
    engineLoads++;
    return {
        PasswordResponses: {INCORRECT_PASSWORD: 2},
        getDocument(options) {
            parsed.push(options);
            const document = {numPages: 3, getPage: async (page) => ({
                getViewport: ({scale}) => ({width: 600 * scale, height: 800 * scale}),
                render: ({viewport}) => {
                    rendered.push({page, width: viewport.width});
                    return {promise: Promise.resolve(), cancel() {cancelled++;}};
                },
            })};
            const task = {destroy: async () => {destroyed++;}};
            task.promise = passwordMode ? new Promise((resolve) => {
                const verify = (value) => {
                    passwords.push(value);
                    if (value === 'secret') resolve(document);
                    else queueMicrotask(() => task.onPassword(verify, 2));
                };
                queueMicrotask(() => task.onPassword(verify, 1));
            }) : badPDF ? Promise.reject(new Error('Invalid PDF structure.')) :
                finishPending === true ? new Promise((resolve) => {finishPending = () => resolve(document);}) : Promise.resolve(document);
            return task;
        },
    };
};
global.fetch = async (url, options) => {
    if (!String(url).includes('/files/preview-')) return originalFetch(url, options);
    requests.push({url, options});
    if (failNext) {failNext = false; return new Response('', {status: 403});}
    return new Response(String(url).endsWith('preview-pdf') ? '%PDF-1.4 test' : '<script>window.executed = true</script>\nHello فارسی');
};
function Fixture() {
    const [ui, setUI] = React.useState({modal: null});
    const actions = {
        openModal: (modal, modalPayload) => setUI({modal, modalPayload}),
        closeModal: () => setUI({modal: null}),
    };
    return React.createElement(TgContext.Provider, {value: {ui, actions}},
        files.map((file) => React.createElement(Attachment, {key: file.id, file, post: {id: 'preview-post'}, onOpenImage() {}})),
        React.createElement(Modals));
}
const wait = async (predicate) => {for (let i = 0; i < 100 && !predicate(); i++) await tick(20); return predicate();};
const click = (node) => node?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true, cancelable: true}));
const open = (name) => click(document.querySelector(`[aria-label="Preview ${name}"]`));
const dialog = () => document.querySelector('[role="dialog"]');
const close = async () => {
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    await wait(() => !dialog());
};
(async () => {
    root.render(React.createElement(Fixture));
    await wait(() => document.querySelector('.tgw-attachment-file'));
    ok(filePreviewKind({name: 'README.md', mime_type: 'application/octet-stream'}) === 'text', 'text extensions work with generic MIME types');
    ok(!filePreviewKind(files[3]), 'binary archives keep downloading');
    ok(engineLoads === 0, 'PDF.js is not loaded when mounting the UI');
    open('notes.txt');
    await wait(() => document.querySelector('.tgw-file-preview-text'));
    ok(dialog()?.getAttribute('aria-label') === 'notes.txt', 'attachment click opens a named modal');
    ok(document.querySelector('pre')?.textContent.includes('<script>') && !dialog()?.querySelector('script') && !window.executed,
        'text is readable and markup is never executed');
    ok(document.querySelector('pre')?.textContent.includes('فارسی'), 'UTF-8 text is preserved');
    ok(dialog()?.querySelector('a')?.href.endsWith('/files/preview-text?download=1'), 'modal preserves a download action');
    ok(requests[0]?.options.credentials === 'same-origin', 'previews use authenticated same-origin requests');
    ok(engineLoads === 0, 'opening a text file does not load the PDF engine');
    const firstSignal = requests[0].options.signal;
    await close();
    ok(!dialog() && firstSignal.aborted, 'Escape closes the modal and aborts its request');
    failNext = true;
    open('report.pdf');
    await wait(() => document.querySelector('[role="alert"]'));
    ok(!!document.querySelector('[role="alert"]'), 'failed PDF download shows an error');
    click(Array.from(dialog().querySelectorAll('button')).find((node) => node.textContent === 'Retry'));
    await wait(() => rendered.length > 0);
    ok(!!document.querySelector('canvas') && !document.querySelector('object,iframe'), 'retry renders PDF pages without the native desktop viewer');
    ok(parsed[0]?.data instanceof Uint8Array && parsed[0].cMapUrl.startsWith('/plugins/com.telegramweb.ui/public/pdfjs/') &&
        parsed[0].standardFontDataUrl.endsWith('/standard_fonts/') && parsed[0].wasmUrl.endsWith('/wasm/'), 'PDF data and all auxiliary assets use the local viewer');
    ok(document.querySelector('[aria-label="Previous PDF page"]')?.disabled && !document.querySelector('[aria-label="Next PDF page"]')?.disabled,
        'page controls reflect document boundaries');
    click(document.querySelector('[aria-label="Next PDF page"]'));
    await wait(() => rendered.some((entry) => entry.page === 2));
    ok(document.querySelector('.tgw-pdf-page-count')?.textContent === 'Page 2 of 3', 'Next renders the selected page');
    const fitWidth = rendered.at(-1).width;
    click(document.querySelector('[aria-label="Zoom PDF in"]'));
    await wait(() => rendered.at(-1).width > fitWidth);
    ok(rendered.at(-1).width > fitWidth, 'zoom renders a larger page');
    click(document.querySelector('[title="Fit PDF to width"]'));
    await wait(() => rendered.at(-1).width === fitWidth);
    ok(rendered.at(-1).width === fitWidth, 'fit resets the zoom');
    await close();
    ok(destroyed > 0 && cancelled > 0, 'closing destroys the PDF document/worker and cancels page rendering');
    badPDF = true;
    open('report.pdf');
    await wait(() => document.querySelector('[role="alert"]'));
    ok(dialog()?.textContent.includes('Invalid PDF structure.'), 'invalid PDFs show a recoverable error');
    badPDF = false;
    click(Array.from(dialog().querySelectorAll('button')).find((node) => node.textContent === 'Retry'));
    await wait(() => document.querySelector('canvas'));
    ok(!!document.querySelector('canvas'), 'retry recovers from a PDF parse failure');
    await close();
    passwordMode = true;
    open('report.pdf');
    await wait(() => document.querySelector('[aria-label="PDF password"]'));
    ok(!!document.querySelector('[aria-label="PDF password"]'), 'password-protected PDFs prompt inside the modal');
    for (const value of ['wrong', 'secret']) {
        const input = document.querySelector('[aria-label="PDF password"]');
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new dom.window.Event('input', {bubbles: true})); await tick(30);
        document.querySelector('.tgw-pdf-password').dispatchEvent(new dom.window.Event('submit', {bubbles: true, cancelable: true}));
        await wait(() => value === 'wrong' ? document.querySelector('[role="alert"]') : document.querySelector('canvas'));
        if (value === 'wrong') ok(dialog()?.textContent.includes('Incorrect password'), 'incorrect passwords allow another attempt');
    }
    ok(!!document.querySelector('canvas') && passwords.join(',') === 'wrong,secret', 'a correct password opens the PDF');
    await close(); passwordMode = false;
    const before = requests.length, beforeEngine = engineLoads;
    open('large.pdf'); await wait(() => document.querySelector('[role="alert"]'));
    ok(requests.length === before && engineLoads === beforeEngine && dialog()?.textContent.includes('too large'), 'oversized PDFs skip the engine and download');
    await close();
    open('large.log'); await wait(() => document.querySelector('[role="alert"]'));
    ok(requests.length === before && dialog()?.textContent.includes('too large'), 'oversized text files keep their download fallback');
    await close();
    finishPending = true;
    open('report.pdf'); await wait(() => typeof finishPending === 'function');
    const destroyBefore = destroyed;
    await close(); finishPending(); await tick(30);
    ok(!dialog() && !document.querySelector('canvas') && destroyed > destroyBefore, 'closing during PDF initialization releases the task and prevents late rendering');
    window.basename = '/mattermost';
    ok(pdfModule.pdfAssetURL('pdf.worker.min.mjs').startsWith('/mattermost/plugins/com.telegramweb.ui/public/pdfjs/'), 'PDF asset URLs respect a Mattermost subpath');
    window.basename = '';
    global.fetch = async () => new Response(new Uint8Array(20));
    let oversized = false;
    try {await api.getFilePreview('preview-stream', 10, new AbortController().signal);} catch (err) {oversized = err.message.includes('too large');}
    ok(oversized, 'stream size limit protects against inaccurate file metadata');
    root.unmount();
    report('FILE PREVIEW TEST');
    process.exit(process.exitCode || 0);
})().catch((err) => {console.error(err); process.exit(1);}).finally(() => {
    global.fetch = originalFetch;
    pdfModule.loadPDFJS = originalLoader;
});
