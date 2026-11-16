const {dom, React, ReactDOM, container, tick, ok, report, store} = require('./harness');
const {Blob: NativeBlob} = require('buffer');
global.Blob = NativeBlob;
const {setStore} = require('../src/mm/store');
const {api} = require('../src/mm/api');
const {canEmbedNativePDF, filePreviewKind} = require('../src/mm/file-preview');
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
];
const originalFetch = global.fetch;
let requests = [], failNext = false, revoked = [], blobTypes = [];
const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
URL.createObjectURL = (blob) => {blobTypes.push(blob.type); return 'blob:preview-pdf';};
URL.revokeObjectURL = (url) => revoked.push(url);
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
const wait = async (predicate) => {for (let i = 0; i < 80 && !predicate(); i++) await tick(20); return predicate();};
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
    ok(filePreviewKind({name: 'data', mime_type: 'application/json; charset=utf-8'}) === 'text', 'structured text MIME types support previews');
    ok(!filePreviewKind(files[3]), 'binary archives keep downloading');
    open('notes.txt');
    await wait(() => document.querySelector('.tgw-file-preview-text'));
    ok(dialog()?.getAttribute('aria-label') === 'notes.txt', 'attachment click opens a named modal');
    ok(document.querySelector('pre')?.textContent.includes('<script>') && !dialog()?.querySelector('script') && !window.executed,
        'text is readable and markup is never executed');
    ok(document.querySelector('pre')?.textContent.includes('فارسی'), 'UTF-8 text is preserved');
    ok(dialog()?.querySelector('a')?.href.endsWith('/files/preview-text?download=1'), 'modal preserves a download action');
    ok(requests[0]?.options.credentials === 'same-origin', 'previews use authenticated same-origin requests');
    const firstSignal = requests[0].options.signal;
    await close();
    ok(!dialog() && firstSignal.aborted, 'Escape closes the modal and aborts its request');
    failNext = true;
    open('report.pdf');
    await wait(() => document.querySelector('[role="alert"]'));
    ok(!!document.querySelector('[role="alert"]'), 'failed preview shows an error');
    click(Array.from(dialog().querySelectorAll('button')).find((node) => node.textContent === 'Retry'));
    await wait(() => document.querySelector('object'));
    ok(document.querySelector('object')?.getAttribute('data') === 'blob:preview-pdf' && blobTypes[0] === 'application/pdf',
        'retry embeds a typed PDF blob in the native browser viewer');
    dialog().parentElement.dispatchEvent(new dom.window.MouseEvent('mousedown', {bubbles: true}));
    await wait(() => !dialog());
    ok(revoked.includes('blob:preview-pdf'), 'closing the PDF viewer releases its blob URL');
    const before = requests.length;
    open('large.log');
    await wait(() => document.querySelector('[role="alert"]'));
    ok(dialog()?.textContent.includes('too large') && requests.length === before, 'large text files offer download without fetching content');
    await close();
    const originalAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
    Object.defineProperty(navigator, 'userAgent', {value: 'Mattermost/6.3 Electron/39.0', configurable: true});
    const beforeDesktop = requests.length;
    open('report.pdf');
    await wait(() => document.querySelector('[role="alert"]'));
    ok(!document.querySelector('object') && dialog()?.textContent.includes('compatible PDF viewer') && requests.length === beforeDesktop,
        'older desktop hosts explain the download fallback instead of embedding a broken native viewer');
    await close();
    let hostAction;
    const originalDispatch = store.dispatch;
    const originalModals = window.WebappUtils.modals;
    window.WebappUtils.modals = {
        canOpenModalId: (id) => id === 'file_preview_modal',
        openModalById: (modalId, dialogProps) => ({type: 'TEST_HOST_PREVIEW', modalId, dialogProps}),
    };
    store.dispatch = (action) => {hostAction = action; return action;};
    open('report.pdf');
    await wait(() => hostAction && !dialog());
    ok(hostAction?.modalId === 'file_preview_modal' && hostAction.dialogProps.fileInfos[0].id === 'preview-pdf' &&
        hostAction.dialogProps.fileInfos[0].extension === 'pdf' && hostAction.dialogProps.post.id === 'preview-post',
        'desktop opens the published Mattermost PDF viewer with the file and post context');
    ok(!dialog() && requests.length === beforeDesktop, 'host viewer replaces the plugin dialog and avoids an extra PDF fetch');
    hostAction.dialogProps.onExited();
    await tick(30);
    open('notes.txt');
    await wait(() => document.querySelector('.tgw-file-preview-text'));
    ok(!!document.querySelector('.tgw-file-preview-text'), 'closing the host viewer restores plugin state and desktop text previews still work');
    await close();
    window.WebappUtils.modals.openModalById = () => {throw new Error('unsupported host');};
    const beforeBrokenHost = requests.length;
    open('report.pdf');
    await wait(() => document.querySelector('[role="alert"]'));
    ok(dialog()?.textContent.includes('compatible PDF viewer') && requests.length === beforeBrokenHost,
        'a failing host modal API safely falls back without a blank desktop embed');
    await close();
    store.dispatch = originalDispatch;
    window.WebappUtils.modals = originalModals;
    if (originalAgent) Object.defineProperty(navigator, 'userAgent', originalAgent);
    else delete navigator.userAgent;
    window.desktopAPI = {};
    ok(!canEmbedNativePDF(), 'desktop bridge detection also handles a customized browser user agent');
    delete window.desktopAPI;
    global.fetch = async () => new Response(new Uint8Array(20));
    let oversized = false;
    try {await api.getFilePreview('preview-stream', 10, new AbortController().signal);} catch (err) {oversized = err.message.includes('too large');}
    ok(oversized, 'stream size limit also protects against missing or inaccurate file metadata');
    root.unmount();
    report('FILE PREVIEW TEST');
    process.exit(process.exitCode || 0);
})().catch((err) => {console.error(err); process.exit(1);}).finally(() => {
    global.fetch = originalFetch;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
});
