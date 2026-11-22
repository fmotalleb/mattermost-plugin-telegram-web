/*
 * Real-browser check: runs the production bundle (webapp/dist/main.js) in headless Chrome behind
 * a stand-in for the Mattermost web app, then drives real mouse/keyboard input through CDP.
 *
 * Why this exists next to test/smoke.js: jsdom does no layout (scrollHeight is always 0, so the
 * composer can never "grow") and it has no real focus semantics. The three behaviors checked here
 * — focus on chat open, edit-box growth for long messages, sidebar search reaching chat messages
 * — are exactly the ones that only a real browser can prove.
 *
 *   npm run test:browser        (needs google-chrome; override the binary with CHROME_PATH)
 *   TGW_IMAGE_VIEWER_ONLY=1 npm run test:browser   (focused image layout/zoom/pan checks)
 */

const fs = require('fs');
const http = require('http');
const pdfFixture = require('./pdf-fixture');
const os = require('os');
const path = require('path');
const {spawn, execSync} = require('child_process');

// The harness swaps globals like Event/Node for jsdom's copies, which Node's own WebSocket
// implementation rejects. Capture the natives first and restore them right after the require.
const NATIVE_NAMES = ['Event', 'MessageEvent', 'EventTarget'];
const natives = {};
NATIVE_NAMES.forEach((name) => {
    natives[name] = global[name];
});

// Fixtures, assertions and the fetch stub (whose source is inlined into the page below).
const {state, users, channels, posts, ids, ok, fail, report} = require('./harness');

NATIVE_NAMES.forEach((name) => {
    if (natives[name]) {
        global[name] = natives[name];
    }
});

const bundlePath = path.join(__dirname, '..', 'dist', 'main.js');
if (!fs.existsSync(bundlePath)) {
    console.error('dist/main.js is missing - run `npm run build` before `npm run test:browser`.');
    process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Sets in the fixture state (profilesInChannel, channelsInTeam, ...) do not survive JSON, so they
// are tagged on the way out and rebuilt in the page.
const sub = (value) => JSON.stringify(value, (key, item) => (item instanceof Set ? {__set: [...item]} : item));

if (process.env.TGW_LAZY_ONLY) state.entities.general.config.PluginSettings.Plugins['com.telegramweb.ui'].DefaultMode = false;

// React 19 removed the UMD builds, so the page gets the production cjs files through a tiny
// CommonJS shim. window.React / window.ReactDOM mirror the globals the Mattermost plugin loader
// exposes to bundles; window.ReactDOMClient provides createRoot (which the main react-dom entry
// no longer re-exports in React 19) for mounting the registered root component.
const reactCJS = (() => {
    const base = path.join(__dirname, '..', 'node_modules');
    const sources = {
        'scheduler': fs.readFileSync(path.join(base, 'scheduler', 'cjs', 'scheduler.production.js'), 'utf8'),
        'react': fs.readFileSync(path.join(base, 'react', 'cjs', 'react.production.js'), 'utf8'),
        'react-dom': fs.readFileSync(path.join(base, 'react-dom', 'cjs', 'react-dom.production.js'), 'utf8'),
        'react-dom/client': fs.readFileSync(path.join(base, 'react-dom', 'cjs', 'react-dom-client.production.js'), 'utf8'),
    };
    return `<script>
(function () {
    const sources = ${JSON.stringify(sources)};
    const cache = {};
    function req(name) {
        if (!cache[name]) {
            const module = {exports: {}};
            cache[name] = module;
            new Function('module', 'exports', 'require', sources[name])(module, module.exports, req);
        }
        return cache[name].exports;
    }
    window.React = req('react');
    window.ReactDOM = req('react-dom');
    window.ReactDOMClient = req('react-dom/client');
})();
</script>`;
})();

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>plugin bundle in a real browser</title>
<style>html, body { margin: 0; height: 100%; }</style>
${process.env.TGW_IMAGE_VIEWER_ONLY ? `<style>
/* Earlier plugin styles may remain in Mattermost's document after a hot reload. */
.tgw-image-viewer { align-items: center; justify-content: center; gap: 12px; padding: 40px; }
.tgw-image-viewer-body { align-items: center; gap: 12px; max-height: 100%; overflow-y: auto; }
.tgw-image-viewer-close { position: fixed; top: 18px; right: 18px; }
</style>` : ''}
${reactCJS}
</head>
<body>
<!-- The host's own message box, focusable and behind the overlay, like in the real web app. -->
<textarea id="post_textbox" aria-label="Mattermost message box" style="position: fixed; left: 0; bottom: 0; width: 420px; height: 44px; z-index: 1;"></textarea>
<div id="root"></div>
<script>
window.__pageErrors = [];
window.addEventListener('error', (event) => window.__pageErrors.push(String(event.message)));
window.addEventListener('unhandledrejection', (event) => window.__pageErrors.push('rejection: ' + String(event.reason)));
</script>
<script>
// --- host stand-in: the globals Mattermost exposes to plugin bundles -------------------------
window.basename = '';
window.__pushes = [];
// Stand-in for what the real Mattermost app does when the plugin pushes the route for the chat
// being opened: its own channel view re-renders (its message box lives behind this overlay) and
// grabs the keyboard — once right away, once a beat later when its render lands. The composer
// must end up owning the keyboard anyway.
const hostChannelSwitched = () => {
    [0, 60].forEach((delay) => {
        setTimeout(() => {
            const box = document.getElementById('post_textbox');
            if (box) { box.focus(); }
        }, delay);
    });
};
window.WebappUtils = {browserHistory: {push: (target) => { window.__pushes.push(target); hostChannelSwitched(); }}};

// --- fixtures ---------------------------------------------------------------------------------
const dom = {window: window};
const ids = ${sub(ids)};
const ME = ids.ME; const OTHER = ids.OTHER; const TEAM = ids.TEAM;
const DM = ids.DM; const TOWN = ids.TOWN; const THIRD = 'user-third';
const users = ${sub(users)};
const channels = ${sub(channels)};
const posts = ${sub(posts)};
let scheduledMessages = [];
// Include a real diagram in the built-bundle browser run (local plugin assets only).
if (!${JSON.stringify(Boolean(process.env.TGW_LAZY_ONLY || process.env.TGW_IMAGE_VIEWER_ONLY))}) posts.p2.message += '\\n\\n\`\`\`mermaid\\nflowchart LR\\nA[Start] --> B[Review] --> C[Ship]\\n\`\`\`';
posts.p2.metadata.files = [
    {id:'browser-pdf',name:'local-preview.pdf',extension:'pdf',mime_type:'application/pdf',size:2000},
    {id:'browser-text',name:'local-notes.txt',extension:'txt',mime_type:'text/plain',size:100},
];
const stockExtraIds = [];
// Enough unread history to distinguish opening at the boundary from opening at the bottom.
for (let n = 0; n < 30; n++) {
    const id = 'unread-browser-' + n;
    posts[id] = {id,channel_id:DM,user_id:n>=15?ME:OTHER,message:'Unread history message ' + n,
        create_at:1700000800000+n*1000,update_at:1700000800000+n*1000,delete_at:0,type:'',props:{}};
    stockExtraIds.push(id);
}
const calls = []; const payloads = [];
window.__calls = calls;
window.__payloads = payloads;
const viewTracking = new Map([
    ['p3', new Set([OTHER, THIRD])],
    ['p1', new Set([OTHER])],
    ['p2', new Set([OTHER])],
]);

// --- the harness' fetch stub, running in the page ----------------------------------------------
const nativeFetch = window.fetch.bind(window);
window.fetch = ${String(global.fetch)};
const fixtureFetch = window.fetch;
window.fetch = (url, options) => /^\\/api\\/v4\\/files\\/browser-(pdf|text)$/.test(String(url))
    ? nativeFetch(url, options) : fixtureFetch(url, options);

// --- the fake redux store ------------------------------------------------------------------------
function revive(value) {
    if (Array.isArray(value)) {
        return value.map(revive);
    }
    if (value && typeof value === 'object') {
        if (value.__set) {
            return new Set(value.__set.map(revive));
        }
        const out = {};
        for (const key of Object.keys(value)) {
            out[key] = revive(value[key]);
        }
        return out;
    }
    return value;
}
const state = revive(${sub(state)});
state.entities.general.config.SiteURL = location.origin;
const listeners = new Set();
const store = {
    getState: () => state,
    dispatch: (action) => {
        listeners.forEach((listener) => { try { listener(); } catch (err) { window.__pageErrors.push(String(err)); } });
        return action;
    },
    subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
};
window.__store = store;

let registered = null;
window.registerPlugin = (pluginId, plugin) => {
    registered = {pluginId, plugin};
};
</script>
<script>
${fs.readFileSync(bundlePath, 'utf8')}
</script>
<script>
try {
    if (!registered) {
        throw new Error('the bundle never called window.registerPlugin');
    }
    const root = window.ReactDOMClient.createRoot(document.getElementById('root'));
    const registry = {
        registerRootComponent: (component) => {
            root.render(React.createElement(component));
            return 'root-1';
        },
        registerChannelHeaderButtonAction: (_icon, action) => {window.__toggleTelegram=action;return 'header-1';},
        registerMainMenuAction: () => 'menu-1',
        registerWebSocketEventHandler: (event,handler) => {window.__wsHandlers=window.__wsHandlers||{};window.__wsHandlers[event]=handler;},
        unregisterWebSocketEventHandler: () => undefined,
        unregisterComponent: () => undefined,
    };
    registered.plugin.initialize(registry, store);
    window.__BOOTED = true;
} catch (error) {
    window.__pageErrors.push('boot: ' + (error && error.stack ? error.stack : String(error)));
    window.__BOOTED = true;
}
</script>
</body>
</html>
`;

// --------------------------------------------------------------------------- chrome launcher
function chromeBinary() {
    const candidates = [process.env.CHROME_PATH, 'google-chrome', 'chromium', 'chromium-browser'].filter(Boolean);
    for (const candidate of candidates) {
        try {
            if (candidate.includes('/') || execSync(`command -v ${candidate}`, {stdio: ['ignore', 'pipe', 'ignore']}).toString().trim()) {
                return candidate;
            }
        } catch (error) {
            // next candidate
        }
    }
    return '';
}

function chromeMajor(binary) {
    try {
        const match = execSync(`"${binary}" --version`, {stdio: ['ignore', 'pipe', 'ignore']}).toString().match(/(\d+)\./);
        return match ? Number(match[1]) : 0;
    } catch (error) {
        return 0;
    }
}

function httpGet(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                body += chunk;
            });
            response.on('end', () => resolve(body));
        }).on('error', reject);
    });
}

// --------------------------------------------------------------------------- CDP driver
class CDP {
    constructor(webSocketUrl) {
        this.ws = new WebSocket(webSocketUrl);
        this.nextId = 1;
        this.pending = new Map();
        this.pageErrors = [];
    }

    async open() {
        await new Promise((resolve, reject) => {
            this.ws.addEventListener('open', resolve, {once: true});
            this.ws.addEventListener('error', reject, {once: true});
        });
        this.ws.addEventListener('message', (event) => {
            const message = JSON.parse(event.data);
            if (message.id && this.pending.has(message.id)) {
                const {resolve, reject} = this.pending.get(message.id);
                this.pending.delete(message.id);
                if (message.error) {
                    reject(new Error(`${message.error.message} (${message.method || ''})`));
                } else {
                    resolve(message.result);
                }
                return;
            }
            if (message.method === 'Runtime.exceptionThrown') {
                const detail = message.params.exceptionDetails || {};
                this.pageErrors.push((detail.exception && detail.exception.description) || detail.text || 'exception');
            }
        });
    }

    send(method, params = {}) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, {resolve, reject});
            this.ws.send(JSON.stringify({id, method, params}));
        });
    }

    /** Evaluate an expression and return its value (or throw on a page-side exception). */
    async eval(expression) {
        const result = await this.send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
        if (result.exceptionDetails) {
            const detail = result.exceptionDetails;
            throw new Error((detail.exception && detail.exception.description) || detail.text);
        }
        return result.result.value;
    }

    async waitFor(expression, timeout = 8000, label = expression) {
        const deadline = Date.now() + timeout;
        for (;;) {
            // eslint-disable-next-line no-await-in-loop
            let value = null;
            try {
                // eslint-disable-next-line no-await-in-loop
                value = await this.eval(expression);
            } catch (error) {
                value = null;
            }
            if (value) {
                return value;
            }
            if (Date.now() >= deadline) {
                throw new Error(`timed out waiting for: ${label}`);
            }
            // eslint-disable-next-line no-await-in-loop
            await sleep(60);
        }
    }

    async click(x, y) {
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
            // eslint-disable-next-line no-await-in-loop
            await this.send('Input.dispatchMouseEvent', {
                type,
                x,
                y,
                button: 'left',
                buttons: type === 'mousePressed' ? 1 : 0,
                clickCount: 1,
            });
        }
    }

    /** Click the element matching a selector at real-mouse coordinates. */
    async clickSelector(selector, occurrence = 0) {
        const point = await this.eval(`(() => {
            const nodes = document.querySelectorAll(${JSON.stringify(selector)});
            const node = nodes[${occurrence}];
            if (!node) { return null; }
            node.scrollIntoView({block: 'center', inline: 'nearest'});
            const rect = node.getBoundingClientRect();
            return {x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2)};
        })()`);
        if (!point) {
            throw new Error(`no element to click: ${selector}`);
        }
        await this.click(point.x, point.y);
    }

    /** Type like a user: text goes wherever focus currently is. */
    async type(text) {
        await this.send('Input.insertText', {text});
    }

    close() {
        try {
            this.ws.close();
        } catch (error) {
            // already gone
        }
    }
}

// --------------------------------------------------------------------------- the run
(async () => {
    const binary = chromeBinary();
    if (!binary) {
        fail('no Chrome/Chromium found (set CHROME_PATH)');
        report('BROWSER TEST');
        process.exit(process.exitCode || 0);
    }
    const major = chromeMajor(binary);
    const headlessFlag = major >= 120 ? '--headless=new' : '--headless';

    const webappRequests = [];
    let failUIChunk = Boolean(process.env.TGW_LAZY_ONLY);
    const pdfRequests = [];
    let failPDFModule = true;
    const server = http.createServer((request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        const pdfPrefix = '/plugins/com.telegramweb.ui/public/pdfjs/';
        const webappPrefix = '/plugins/com.telegramweb.ui/public/webapp/';
        if (pathname.startsWith(webappPrefix)) {
            webappRequests.push(pathname);
            if (failUIChunk && pathname.includes('/telegram-ui.')) { failUIChunk=false;response.writeHead(503);response.end('temporary chunk failure');return; }
            const base=path.resolve(__dirname,'..','..','public','webapp');
            const file=path.resolve(base,pathname.slice(webappPrefix.length));
            if(!file.startsWith(base+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){response.writeHead(404);response.end('not found');return;}
            const send = () => {
                response.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.woff2')?'font/woff2':file.endsWith('.webp')?'image/webp':'application/octet-stream'});
                response.end(fs.readFileSync(file));
            };
            if (process.env.TGW_LAZY_ONLY && pathname.includes('/emoji-picker.')) setTimeout(send,200); else send();
            return;
        }
        if ((process.env.TGW_IMAGE_VIEWER_ONLY || process.env.TGW_LAZY_ONLY) && /^\/api\/v4\/files\/file-[12](?:\/(?:thumbnail|preview))?$/.test(pathname)) {
            if (process.env.TGW_IMAGE_FIXTURE && pathname.includes('file-1')) {
                response.writeHead(200, {'Content-Type':'image/png'}); response.end(fs.readFileSync(process.env.TGW_IMAGE_FIXTURE)); return;
            }
            response.writeHead(200, {'Content-Type':'image/svg+xml'});
            response.end('<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1200"><defs><pattern id="grid" width="100" height="100" patternUnits="userSpaceOnUse"><path d="M100 0H0V100" fill="none" stroke="#92b5d9"/></pattern></defs><rect width="2000" height="1200" fill="#e8f2ff"/><rect width="2000" height="1200" fill="url(#grid)"/><text x="100" y="200" font-size="80" fill="#24466d">Full resolution image · Zoom and pan</text></svg>'); return;
        }
        if (pathname.startsWith(pdfPrefix)) {
            pdfRequests.push(pathname);
            if (failPDFModule && pathname.endsWith('/pdf.min.mjs')) {
                failPDFModule = false;
                response.writeHead(503); response.end('temporary asset failure'); return;
            }
            const base = path.resolve(__dirname, '..', '..', 'public', 'pdfjs');
            const file = path.resolve(base, pathname.slice(pdfPrefix.length));
            if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
                response.writeHead(404); response.end('not found'); return;
            }
            const type = /\.m?js$/.test(file) ? 'text/javascript' : file.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
            response.writeHead(200, {'Content-Type': type, 'Cache-Control': 'public, max-age=3600'});
            response.end(fs.readFileSync(file)); return;
        }
        if (pathname === '/api/v4/files/browser-pdf') {
            response.writeHead(200, {'Content-Type':'application/pdf', 'Content-Disposition':'attachment'});
            response.end(pdfFixture()); return;
        }
        if (pathname === '/api/v4/files/browser-text') {
            response.writeHead(200, {'Content-Type':'text/plain'}); response.end('A plain text attachment.'); return;
        }
        if (request.url === '/' || request.url.startsWith('/?')) {
            response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
            response.end(page);
        } else if (/^\/api\/v4\/users\/[^/]+\/image(?:\?|$)/.test(request.url)) {
            response.writeHead(200, {'Content-Type': 'image/svg+xml'});
            response.end('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#3390ec"/><circle cx="128" cy="92" r="48" fill="#fff"/><path d="M38 256v-32a90 90 0 0 1 180 0v32" fill="#fff"/></svg>');
        } else {
            // Content outside the explicit test fixtures is unavailable here.
            response.writeHead(404, {'Content-Type': 'text/plain'});
            response.end('not found');
        }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}/`;

    const port = 9300 + Math.floor(Math.random() * 400);
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgw-chrome-'));
    const chrome = spawn(binary, [
        headlessFlag,
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${userDataDir}`,
        `--remote-debugging-port=${port}`,
        '--window-size=1440,900',
        'about:blank',
    ], {stdio: ['ignore', 'ignore', 'pipe']});

    let chromeStderr = '';
    chrome.stderr.on('data', (chunk) => {
        chromeStderr += chunk.toString();
    });

    const cleanup = () => {
        try {
            chrome.kill('SIGTERM');
        } catch (error) {
            // already exited
        }
        try {
            fs.rmSync(userDataDir, {recursive: true, force: true});
        } catch (error) {
            // best effort
        }
        server.close();
    };

    let cdp = null;
    try {
        // Wait for the debugging endpoint.
        let target = null;
        const deadline = Date.now() + 15000;
        while (!target) {
            if (Date.now() >= deadline) {
                throw new Error(`Chrome never opened its debugging port: ${chromeStderr.slice(-500)}`);
            }
            if (chrome.exitCode !== null) {
                throw new Error(`Chrome exited early (${chrome.exitCode}): ${chromeStderr.slice(-500)}`);
            }
            try {
                // eslint-disable-next-line no-await-in-loop
                const list = JSON.parse(await httpGet(`http://127.0.0.1:${port}/json/list`));
                target = list.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
            } catch (error) {
                // not up yet
            }
            if (!target) {
                // eslint-disable-next-line no-await-in-loop
                await sleep(200);
            }
        }

        cdp = new CDP(target.webSocketDebuggerUrl);
        await cdp.open();
        await cdp.send('Runtime.enable');
        await cdp.send('Page.enable');
        await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
        await cdp.send('Page.navigate', {url: baseUrl});

        if (process.env.TGW_LAZY_ONLY) {
            await cdp.waitFor('window.__BOOTED===true',10000,'plugin boot');await sleep(150);
            ok(webappRequests.length===0&&await cdp.eval('!document.querySelector(".tgw-root")&&!document.querySelector("style[data-webpack]")'),'disabled plugin requests no UI, engine or font assets');
            await cdp.eval('window.__toggleTelegram()');
            await cdp.waitFor('document.querySelector("[role=alert]")?.textContent.includes("Could not load the Telegram view")',10000,'chunk failure feedback');
            await cdp.clickSelector('[role=alert] button');
            await cdp.waitFor('!!document.querySelector(".tgw-composer textarea")',20000,'retry loads UI');await sleep(300);
            ok(webappRequests.filter(url=>url.includes('/telegram-ui.')).length===2,'failed UI chunks can be retried in the browser');
            ok(!webappRequests.some(url=>/mermaid-engine|modals|imageviewer|emoji-picker/.test(url)),'normal chat does not download optional feature chunks');
            ok(webappRequests.some(url=>url.includes('/fonts/')),'fonts load from packaged local assets when the UI is enabled');
            await cdp.waitFor('!!document.querySelector(".tgw-attachment-image")');
            await cdp.eval(`(async () => {const node=document.querySelector('.tgw-attachment-image');node.scrollIntoView({block:'center'});await Promise.all(Array.from(node.querySelectorAll('img')).map(image=>image.decode().catch(()=>{})));await new Promise(requestAnimationFrame);})()`);
            await cdp.clickSelector('.tgw-attachment-image');
            await cdp.waitFor('!!document.querySelector(".tgw-image-viewer")');
            const imageLoads=webappRequests.filter(url=>url.includes('/imageviewer.')).length;
            ok(imageLoads===1,'image viewer code downloads on first image open');
            await cdp.clickSelector('.tgw-image-viewer-close');await cdp.clickSelector('.tgw-attachment-image');await cdp.waitFor('!!document.querySelector(".tgw-image-viewer")');
            ok(webappRequests.filter(url=>url.includes('/imageviewer.')).length===imageLoads,'reopening an image reuses its loaded module');
            await cdp.clickSelector('.tgw-image-viewer-close');
            await cdp.clickSelector('.tgw-composer [title="Emoji"]');
            await cdp.waitFor('!!document.querySelector(".tgw-lazy-status")');
            await cdp.clickSelector('.tgw-chat-header');await sleep(350);
            ok(await cdp.eval('!document.querySelector(".tgw-emoji-picker")'),'clicking away while picker code loads prevents a late popup');
            await cdp.clickSelector('.tgw-composer [title="Emoji"]');await cdp.waitFor('!!document.querySelector(".tgw-emoji-picker")');
            ok(webappRequests.some(url=>url.includes('/emoji-picker.')),'emoji picker code downloads only when opened');
            await cdp.eval(`window.__wsHandlers.post_edited({data:{post:{...posts.p2,message:'\`\`\`mermaid\\nflowchart LR\\nA-->B\\n\`\`\`',edit_at:Date.now()}}})`);
            await cdp.waitFor('!!document.querySelector(".tgw-mermaid")');
            await cdp.eval('document.querySelector(".tgw-mermaid").scrollIntoView({block:"center"})');
            await cdp.waitFor('!!document.querySelector(".tgw-mermaid svg")',30000,'lazy Mermaid render');
            ok(webappRequests.some(url=>url.includes('/mermaid-engine.')),'Mermaid engine downloads only for a diagram');
            ok((await cdp.eval('window.__pageErrors')).length===0,'lazy feature loads produce no browser errors');
            report('LAZY LOADING BROWSER TEST');return;
        }

        await cdp.waitFor('window.__BOOTED === true && document.querySelector(".tgw-root") ? true : false', 20000, 'overlay to render');
        await cdp.waitFor('!!document.querySelector(".tgw-composer textarea")', 20000, 'composer to mount');
        await cdp.waitFor('document.querySelectorAll(".tgw-chat-row").length > 0 && !!document.querySelector(".tgw-chat-header-title")', 20000, 'chat list + open chat');
        await sleep(500);

        const bootErrors = await cdp.eval('window.__pageErrors');
        ok(bootErrors.length === 0, `bundle booted without page errors${bootErrors.length ? ` (${bootErrors[0]})` : ''}`);

        if (process.env.TGW_APPLE_EMOJI_ONLY) {
            ok(!webappRequests.some(url => url.includes('/emoji/apple-')), 'Apple artwork is not downloaded while disabled on the server');
            await cdp.eval(`globalThis.__appleEmoji = true; window.__wsHandlers['custom_com.telegramweb.ui_ui_config_changed']({})`);
            await cdp.waitFor('document.querySelector(".tgw-root")?.classList.contains("tgw-use-apple-emoji")', 5000, 'server enabled Apple emoji');
            await cdp.waitFor('performance.getEntriesByType("resource").some(e => e.name.includes("/emoji/apple-"))', 10000, 'emoji sprite download');
            const sprite = await cdp.eval(`(() => {const e=document.querySelector('.tgw-root.tgw-use-apple-emoji .tgw-apple-emoji'); const s=getComputedStyle(e);return {image:s.backgroundImage,color:s.color,text:e.textContent};})()`);
            ok(sprite.image.includes('/emoji/apple-') && sprite.color === 'rgba(0, 0, 0, 0)' && !!sprite.text, 'server-enabled emoji paint the sprite while retaining Unicode text');
            await cdp.eval(`(() => {const area = document.querySelector('.tgw-composer textarea'); area.focus(); area.select();})()`);
            await cdp.type('hello world');
            await cdp.eval('document.querySelector(".tgw-composer textarea").setSelectionRange(6, 11)');
            await cdp.clickSelector('.tgw-composer button[title=Emoji]');
            await cdp.waitFor('!!document.querySelector(".tgw-emoji-grid .tgw-apple-emoji")', 10000, 'mapped picker emoji');
            ok(await cdp.eval('getComputedStyle(document.querySelector(".tgw-emoji-grid .tgw-apple-emoji")).backgroundImage.includes("/emoji/apple-")'), 'emoji picker uses the server-selected artwork');
            await cdp.clickSelector('.tgw-emoji-picker [data-category="people"] button[title=":thumbsup:"]');
            await cdp.waitFor('document.activeElement.matches(".tgw-composer textarea")', 5000, 'composer focus after choosing an emoji');
            await cdp.type('again');
            ok(await cdp.eval('document.activeElement.value === "hello 👍 again"'), 'picking an emoji replaces the selection and returns the caret to the composer');
            await cdp.eval(`globalThis.__appleEmoji = false; window.__wsHandlers['custom_com.telegramweb.ui_ui_config_changed']({})`);
            await cdp.waitFor('!document.querySelector(".tgw-root")?.classList.contains("tgw-use-apple-emoji")', 5000, 'server disabled Apple emoji');
            ok(true, 'server changes update an open session');
            report('APPLE EMOJI BROWSER TEST');
            return;
        }

        if (process.env.TGW_PREVIEW_ONLY) {
            await cdp.eval(`(() => {const area = document.querySelector('.tgw-composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, '- سرویس داخلی\\n- Gitlab'); area.dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('[aria-label="Preview message"]').click();})()`);
            await cdp.waitFor('!!document.querySelector(".tgw-composer-preview ul li")', 5000, 'rendered preview list');
            const rtl = await cdp.eval(`(() => {const list=document.querySelector('.tgw-composer-preview ul'), item=list.querySelector('li'); return {list:getComputedStyle(list).direction, marker:getComputedStyle(item, '::marker').direction, start:getComputedStyle(list).paddingRight, end:getComputedStyle(list).paddingLeft};})()`);
            ok(rtl.list === 'rtl' && rtl.marker === 'rtl' && parseFloat(rtl.start) > 0 && parseFloat(rtl.end) === 0, `Persian list markers use the right side (${JSON.stringify(rtl)})`);
            await cdp.eval(`(() => {const area=document.querySelector('.tgw-composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(area,'- English item\\n- second'); area.dispatchEvent(new Event('input',{bubbles:true}));})()`);
            await cdp.waitFor(`document.querySelector('.tgw-composer-preview li')?.textContent.includes('English item')`, 5000, 'updated preview');
            const ltr = await cdp.eval(`(() => {const list=document.querySelector('.tgw-composer-preview ul'), item=list.querySelector('li'); return {list:getComputedStyle(list).direction,marker:getComputedStyle(item,'::marker').direction,start:getComputedStyle(list).paddingLeft,end:getComputedStyle(list).paddingRight};})()`);
            ok(ltr.list === 'ltr' && ltr.marker === 'ltr' && parseFloat(ltr.start) > 0 && parseFloat(ltr.end) === 0, `English list markers use the left side (${JSON.stringify(ltr)})`);
            report('MESSAGE PREVIEW BROWSER TEST');
            return;
        }

        if (process.env.TGW_IMAGE_VIEWER_ONLY) {
            await cdp.waitFor('!!document.querySelector(".tgw-attachment-image")',10000,'image attachment');
            await cdp.eval(`(async () => {await document.fonts.ready;const node=document.querySelector('.tgw-attachment-image');node.scrollIntoView({block:'center'});await Promise.all(Array.from(node.querySelectorAll('img')).map(image=>image.decode().catch(()=>{})));node.click();})()`);
            await cdp.waitFor('document.querySelector(".tgw-image-viewer img")?.naturalWidth > 0',10000,'original image load');
            await sleep(100);
            const fit = await cdp.eval(`(() => {
                const dialog=document.querySelector('.tgw-image-viewer').getBoundingClientRect();
                const canvas=document.querySelector('.tgw-image-viewer-viewport').getBoundingClientRect();
                const image=document.querySelector('.tgw-image-viewer img').getBoundingClientRect();
                return {windowWidth:innerWidth,windowHeight:innerHeight,canvasWidth:canvas.width,canvasHeight:canvas.height,full:dialog.width===innerWidth&&dialog.height===innerHeight, fits:image.left>=canvas.left-1&&image.top>=canvas.top-1&&image.right<=canvas.right+1&&image.bottom<=canvas.bottom+1,large:image.width>innerWidth*.65||image.height>innerHeight*.65,width:image.width,height:image.height,zoom:document.querySelector('.tgw-image-viewer output').textContent};
            })()`);
            ok(fit.full&&fit.canvasWidth>fit.windowWidth*.65&&fit.canvasHeight>fit.windowHeight*.6&&fit.fits&&fit.large,`viewer has a visible fitted image despite legacy host styles (${JSON.stringify(fit)})`);
            await cdp.clickSelector('.tgw-image-viewer img');
            ok(await cdp.eval('!!document.querySelector(".tgw-image-viewer")'),'clicking the image keeps the viewer open');
            await cdp.clickSelector('.tgw-image-viewer-tools button[aria-label="Zoom in"]');await sleep(50);
            const zoomed=await cdp.eval('document.querySelector(".tgw-image-viewer img").getBoundingClientRect().width');
            ok(zoomed>fit.width,'zoom controls enlarge the actual image');
            await cdp.eval(`document.querySelector('.tgw-image-viewer-viewport').dispatchEvent(new WheelEvent('wheel',{deltaY:-100,clientX:700,clientY:400,bubbles:true,cancelable:true}))`);await sleep(50);
            ok(await cdp.eval('document.querySelector(".tgw-image-viewer img").getBoundingClientRect().width')>zoomed,'wheel zoom enlarges the rendered image');
            const center=await cdp.eval(`(() => {const r=document.querySelector('.tgw-image-viewer-viewport').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
            const before=await cdp.eval('document.querySelector(".tgw-image-viewer-stage").style.transform');
            await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,x:center.x,y:center.y});
            await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:center.x+80,y:center.y+40});
            await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:center.x+80,y:center.y+40});await sleep(60);
            ok(await cdp.eval('document.querySelector(".tgw-image-viewer-stage").style.transform')!==before,'real pointer dragging pans the zoomed image');
            await cdp.eval(`Array.from(document.querySelectorAll('.tgw-image-viewer-tools button')).find(b=>b.textContent==='Fit').click()`);await sleep(50);
            fs.writeFileSync('/tmp/tgw-image-viewer-desktop.png',Buffer.from((await cdp.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
            await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});await sleep(100);
            const mobile=await cdp.eval(`(() => {
                const d=document.querySelector('.tgw-image-viewer').getBoundingClientRect(),c=document.querySelector('.tgw-image-viewer-viewport').getBoundingClientRect(),i=document.querySelector('.tgw-image-viewer img').getBoundingClientRect();
                const controls=Array.from(document.querySelectorAll('.tgw-image-viewer-header button,.tgw-image-viewer-tools button')).map(b=>b.getBoundingClientRect());
                return d.width===innerWidth&&d.height===innerHeight&&i.left>=c.left-1&&i.right<=c.right+1&&i.top>=c.top-1&&i.bottom<=c.bottom+1&&controls.every(r=>r.left>=0&&r.right<=innerWidth);
            })()`);
            ok(mobile,'image and zoom controls fit the phone viewport');
            fs.writeFileSync('/tmp/tgw-image-viewer-mobile.png',Buffer.from((await cdp.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
            await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:2});
            const touchWidth=await cdp.eval('document.querySelector(".tgw-image-viewer img").getBoundingClientRect().width');
            await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{id:1,x:140,y:400},{id:2,x:250,y:400}]});
            await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{id:1,x:100,y:400},{id:2,x:290,y:400}]});
            await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await sleep(60);
            ok(await cdp.eval('document.querySelector(".tgw-image-viewer img").getBoundingClientRect().width')>touchWidth,'real touch pinch enlarges the image');
            await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:false});
            await cdp.clickSelector('.tgw-image-viewer-next');await cdp.waitFor('document.querySelector(".tgw-image-viewer img")?.src.includes("file-2")&&document.querySelector(".tgw-image-viewer img")?.naturalWidth>0',5000,'next image');
            ok(await cdp.eval('document.querySelector(".tgw-image-viewer-stage").style.transform.includes("0px")'),'navigation resets image pan');
            await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await sleep(50);
            ok(await cdp.eval('!document.querySelector(".tgw-image-viewer")'),'Escape dismisses the built viewer');
            await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
            await cdp.clickSelector('.tgw-attachment-image');
            await cdp.waitFor('document.querySelector(".tgw-image-viewer img")?.naturalWidth > 0',10000,'reopened image load');
            const backdrop = await cdp.waitFor(`(() => {
                const canvas = document.querySelector('.tgw-image-viewer-viewport');
                const bounds = canvas.getBoundingClientRect();
                const image = canvas.querySelector('img').getBoundingClientRect();
                const points = [
                    {x: bounds.left + bounds.width / 2, y: (bounds.top + image.top) / 2},
                    {x: (bounds.left + image.left) / 2, y: bounds.top + bounds.height / 3},
                ];
                return points.find(({x, y}) => document.elementFromPoint(x, y) === canvas);
            })()`, 5000, 'empty canvas space around the fitted image');
            await cdp.click(backdrop.x, backdrop.y);
            await cdp.waitFor('!document.querySelector(".tgw-image-viewer")',5000,'backdrop click closes the viewer');
            ok(await cdp.eval('document.activeElement === document.querySelector(".tgw-attachment-image")'),'backdrop dismissal restores focus to the attachment');

            await cdp.clickSelector('.tgw-attachment-image');
            await cdp.waitFor('!!document.querySelector(".tgw-image-viewer-next")');
            await cdp.clickSelector('.tgw-image-viewer-next');
            await cdp.waitFor('document.querySelector(".tgw-image-viewer img")?.src.includes("file-2") && !!document.querySelector(".tgw-image-viewer-edit:enabled")');
            await cdp.clickSelector('.tgw-image-viewer-edit');
            await cdp.waitFor('!!document.querySelector(".tgw-image-editor canvas")');
            const editorButton = (label) => cdp.eval(`Array.from(document.querySelectorAll('.tgw-image-editor button')).find(b => b.textContent === ${JSON.stringify(label)}).click()`);
            const dimensions = () => cdp.eval('document.querySelector(\'[aria-label="Image dimensions"]\').textContent');
            const pixel = (x, y) => cdp.eval(`(() => {
                const canvas = document.querySelector('.tgw-image-editor canvas');
                return Array.from(canvas.getContext('2d').getImageData(Math.floor(canvas.width * ${x}), Math.floor(canvas.height * ${y}), 1, 1).data);
            })()`);
            const drag = async (left, top, right, bottom) => {
                const rect = await cdp.eval('document.querySelector(".tgw-image-editor canvas").getBoundingClientRect().toJSON()');
                const start = {x: rect.x + left * rect.width, y: rect.y + top * rect.height};
                const end = {x: rect.x + right * rect.width, y: rect.y + bottom * rect.height};
                await cdp.send('Input.dispatchMouseEvent', {type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...start});
                await cdp.send('Input.dispatchMouseEvent', {type: 'mouseMoved', button: 'left', buttons: 1, ...end});
                await cdp.send('Input.dispatchMouseEvent', {type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...end});
            };
            const original = await pixel(.5, .5);
            await drag(.35, .5, .65, .5);
            const pen = await pixel(.5, .5);
            ok(pen[0] > 245 && pen[1] < 75, 'pen paints on the image');
            await editorButton('Undo');
            ok(String(await pixel(.5, .5)) === String(original), 'undo restores the original pixels');
            await editorButton('Redo');
            ok(String(await pixel(.5, .5)) === String(pen), 'redo restores the pen stroke');
            await editorButton('Marker');
            const beforeMarker = await pixel(.5, .6);
            await drag(.35, .6, .65, .6);
            const marker = await pixel(.5, .6);
            ok(marker[2] < beforeMarker[2] && marker[2] > 64, 'marker blends with the image');
            await editorButton('Rotate ↻');
            ok(await dimensions() === '1200 × 2000 px', 'rotation swaps the dimensions');
            await editorButton('Crop');
            await drag(.25, .25, .75, .75);
            await editorButton('Apply crop');
            ok(await dimensions() === '600 × 1000 px', 'crop uses the rotated image coordinates');
            await editorButton('Resize');
            await cdp.eval('document.querySelector(".tgw-image-editor input[type=number]").select()');
            await cdp.type('300');
            await editorButton('Apply size');
            ok(await dimensions() === '300 × 500 px', 'resize preserves the aspect ratio by default');

            await cdp.eval(`(() => {
                const click = HTMLAnchorElement.prototype.click;
                HTMLAnchorElement.prototype.click = function () {
                    if (!this.download.endsWith('-edited.png')) return click.call(this);
                    HTMLAnchorElement.prototype.click = click;
                    window.__imageDownload = {url: this.href, name: this.download};
                };
            })()`);
            await cdp.clickSelector('.tgw-image-editor-primary');
            await cdp.waitFor('!!window.__imageDownload', 5000, 'edited PNG download');
            const downloaded = await cdp.eval(`(async () => {
                const {url, name} = window.__imageDownload;
                const blob = await (await nativeFetch(url)).blob();
                const bitmap = await createImageBitmap(blob);
                const canvas = document.createElement('canvas');
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(bitmap, 0, 0);
                const pen = Array.from(ctx.getImageData(150, 250, 1, 1).data);
                return {width: bitmap.width, height: bitmap.height, type: blob.type, name, pen};
            })()`);
            ok(downloaded.width === 300 && downloaded.height === 500 && downloaded.type === 'image/png' &&
                downloaded.name.endsWith('-edited.png') && downloaded.pen[0] > 245 && downloaded.pen[1] < 75,
            `download contains the resized, annotated PNG (${JSON.stringify(downloaded)})`);

            await cdp.send('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 1, mobile: false});
            await sleep(100);
            ok(await cdp.eval(`(() => {
                const canvas = document.querySelector('.tgw-image-editor canvas').getBoundingClientRect();
                const controls = [...document.querySelectorAll('.tgw-image-editor button, .tgw-image-editor input')];
                return canvas.width > 150 && canvas.height > 300 && canvas.left >= 0 && canvas.right <= innerWidth &&
                    controls.every(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; });
            })()`), 'editing canvas and controls fit the phone viewport');
            fs.writeFileSync('/tmp/tgw-image-editor-mobile.png', Buffer.from((await cdp.send('Page.captureScreenshot', {format: 'png'})).data, 'base64'));
            await cdp.clickSelector('.tgw-image-editor-back');
            ok(await cdp.eval(`!document.querySelector('.tgw-image-editor') && document.querySelector('.tgw-image-viewer img').naturalWidth === 2000 &&
                document.activeElement.matches('.tgw-image-viewer-edit')`), 'returning to the preview restores the original image and focus');
            await cdp.clickSelector('.tgw-image-viewer-close');
            await cdp.eval(`Array.from(document.querySelectorAll('.tgw-chat-row')).find(row => row.textContent.includes('Alice')).click()`);
            await cdp.waitFor('!!document.querySelector(".tgw-shell-chat-open .tgw-composer")', 5000, 'conversation open in the phone layout');
            await cdp.eval(`(async () => {
                const canvas = document.createElement('canvas');
                canvas.width = 64; canvas.height = 48;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#163c5f';
                ctx.fillRect(0, 0, 64, 48);
                const blob = await new Promise(resolve => canvas.toBlob(resolve));
                window.__composerImageBlob = blob;
                const transfer = new DataTransfer();
                for (const name of ['first.png', 'second.png']) transfer.items.add(new File([blob], name, {type: 'image/png'}));
                const input = document.querySelector('.tgw-composer input[type=file]');
                input.files = transfer.files;
                input.dispatchEvent(new Event('change', {bubbles: true}));
                const nextFetch = window.fetch;
                window.__composerUploads = [];
                let rejectSecond = true;
                window.fetch = async (url, options) => {
                    if (String(url).endsWith('/api/v4/files') && options.method === 'POST') {
                        const file = options.body.get('files');
                        const bitmap = await createImageBitmap(file);
                        window.__composerUploads.push({name: file.name, width: bitmap.width, height: bitmap.height});
                        bitmap.close();
                        if (rejectSecond && file.name === 'second-edited.png') {
                            rejectSecond = false;
                            return new Response(JSON.stringify({message: 'Test upload failed'}), {status: 503});
                        }
                    }
                    return nextFetch(url, options);
                };
            })()`);
            await cdp.waitFor('document.querySelectorAll(".tgw-attachment-chip-preview img").length === 2', 5000, 'two pending image thumbnails');
            await cdp.clickSelector('.tgw-attachment-chip-preview');
            await cdp.waitFor('!!document.querySelector(".tgw-image-editor canvas")', 5000, 'composer thumbnail opens the editor');
            ok(await cdp.eval('!document.querySelector(".tgw-image-viewer-edit, .tgw-image-editor-back")'), 'pending images open directly in edit mode');
            await editorButton('Rotate ↻');
            await editorButton('Apply edits');
            await cdp.waitFor('!document.querySelector(".tgw-image-viewer") && !!document.querySelector(\'[aria-label="Edit first-edited.png"]\')');
            ok(await cdp.eval('!window.__composerUploads.length && !window.__calls.includes("POST /files")'), 'applying edits updates the tray without uploading either image');

            await cdp.clickSelector('.tgw-composer textarea');
            await cdp.type('Edited image attachments');
            await cdp.clickSelector('.tgw-attachment-chip-preview', 1);
            await cdp.waitFor('!!document.querySelector(".tgw-image-editor canvas")');
            await editorButton('Rotate ↻');
            await cdp.clickSelector('.tgw-image-editor-primary');
            await cdp.waitFor('document.querySelector(".tgw-toast")?.textContent.includes("Test upload failed")', 5000, 'failed upload notice');
            ok(await cdp.eval(`document.querySelector('.tgw-composer textarea').value === 'Edited image attachments' &&
                document.querySelectorAll('.tgw-attachment-chip-preview').length === 2 && !window.__calls.includes('POST /posts')`),
            'an upload failure restores the edited attachments and caption');
            await cdp.clickSelector('.tgw-send-button[title="Send"]');
            await cdp.waitFor('window.__calls.includes("POST /posts")', 5000, 'message sent with edited attachments');
            const sent = await cdp.eval(`({
                uploads: window.__composerUploads,
                post: window.__payloads.find(entry => entry.method === 'POST' && entry.path === '/posts').body,
            })`);
            ok(sent.uploads.map((file) => file.name).join(',') === 'first-edited.png,second-edited.png,second-edited.png' &&
                sent.uploads.every((file) => file.width === 48 && file.height === 64) &&
                sent.post.message === 'Edited image attachments' && sent.post.file_ids.length === 2,
            'Send edited uploads the edited PNGs and a retry reuses the successful upload');

            await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
            await cdp.eval(`(() => {
                const row = document.querySelector('.tgw-chat-row');
                row.dispatchEvent(new MouseEvent('mousedown', {button: 1, bubbles: true, cancelable: true}));
                row.dispatchEvent(new MouseEvent('auxclick', {button: 1, bubbles: true, cancelable: true}));
            })()`);
            await cdp.waitFor('!!document.querySelector(".tgw-quick-dialog .tgw-composer input[type=file]")');
            await cdp.eval(`(() => {
                const transfer = new DataTransfer();
                transfer.items.add(new File([window.__composerImageBlob], 'quick.png', {type: 'image/png'}));
                const input = document.querySelector('.tgw-quick-dialog .tgw-composer input[type=file]');
                input.files = transfer.files;
                input.dispatchEvent(new Event('change', {bubbles: true}));
            })()`);
            await cdp.waitFor('!!document.querySelector(".tgw-quick-dialog .tgw-attachment-chip-preview img")');
            await cdp.clickSelector('.tgw-quick-dialog .tgw-attachment-chip-preview');
            await cdp.waitFor('!!document.querySelector(".tgw-image-editor canvas") && document.activeElement.matches(".tgw-image-viewer-close")', 5000, 'quick chat image editor takes focus');
            await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
            await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
            await cdp.waitFor('!document.querySelector(".tgw-image-viewer")');
            ok(await cdp.eval('document.activeElement.matches(".tgw-quick-dialog .tgw-attachment-chip-preview")'), 'dismissing the composer editor preserves Quick Chat and restores focus');
            ok((await cdp.eval('window.__pageErrors')).length===0,'viewer produces no browser errors');
            report('IMAGE VIEWER BROWSER TEST');
            return;
        }

        console.log('\n== bundled emoji artwork ==');
        await cdp.send('DOM.enable');
        await cdp.send('CSS.enable');
        await cdp.eval(`(async () => {
            const probe = document.createElement('div');
            probe.id = 'tgw-emoji-font-probe';
            probe.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;font-size:20px';
            const samples = [
                ['inherited', '😀👍🏽👨‍👩‍👧‍👦🇮🇷1️⃣#️⃣*️⃣🏴\\u{e0067}\\u{e0062}\\u{e0065}\\u{e006e}\\u{e0067}\\u{e007f}', ''],
                ['reaction', '🎉', 'tgw-reaction-emoji'],
                ['wrapped', '⚙️©️™️', 'tgw-emoji'],
                ['text', '0123456789 # * English فارسی', ''],
            ];
            samples.forEach(([id, text, className]) => {
                const span = document.createElement('span');
                span.id = 'tgw-font-' + id;
                span.className = className;
                span.textContent = text;
                probe.appendChild(span);
            });
            document.querySelector('.tgw-root').appendChild(probe);
            await document.fonts.ready;
        })()`);
        const fontDocument = await cdp.send('DOM.getDocument');
        for (const sample of ['inherited', 'reaction', 'wrapped', 'text']) {
            const {nodeId} = await cdp.send('DOM.querySelector', {nodeId: fontDocument.root.nodeId, selector: `#tgw-font-${sample}`});
            const {fonts} = await cdp.send('CSS.getPlatformFontsForNode', {nodeId});
            const expected = sample === 'text' ? 'Vazirmatn' : 'Twemoji';
            ok(fonts.length > 0 && fonts.every((font) => font.isCustomFont && font.familyName.includes(expected)),
                `${sample} uses only bundled ${expected} glyphs (${fonts.map((font) => font.familyName).join(', ')})`);
            if (sample === 'inherited') {
                const glyphCount = fonts.reduce((count, font) => count + font.glyphCount, 0);
                ok(glyphCount === 8, `eight complete emoji sequences shape to eight glyphs (${glyphCount})`);
            }
        }
        await cdp.eval("document.querySelector('#tgw-emoji-font-probe').remove()");

        console.log('\n== fixed emoji cells ==');
        const emojiLayout = await cdp.eval(`(async () => {
            const probe = document.createElement('div');
            probe.id = 'tgw-emoji-layout-probe';
            probe.style.cssText = 'position:fixed;top:100px;left:450px;width:720px;padding:24px;z-index:10000;background:var(--tgw-bg);color:var(--tgw-text)';
            const hostStyle = document.createElement('style');
            hostStyle.textContent = 'h2 span { display: block; }';
            probe.appendChild(hostStyle);
            const rows = [];
            for (const size of [12, 15, 24, 36]) {
                const line = document.createElement('h2');
                line.style.cssText = 'font-size:' + size + 'px;line-height:1.4;margin:12px 0';
                line.appendChild(document.createTextNode('Root FS Used '));
                const cells = ['🟥', '👍', '😀', '👨‍👩‍👧‍👦', '🇮🇷', '👍🏽', '1️⃣'].map(text => {
                    const cell = document.createElement('span');
                    cell.className = 'tgw-emoji';
                    cell.textContent = text;
                    line.appendChild(cell);
                    return cell;
                });
                const plain = document.createElement('h2');
                plain.style.cssText = line.style.cssText;
                plain.textContent = 'Root FS Used';
                probe.append(line, plain);
                rows.push({line, plain, cells, size});
            }
            const reaction = document.createElement('button');
            reaction.className = 'tgw-reaction';
            reaction.innerHTML = '<span class="tgw-reaction-emoji">👍</span><span>1</span>';
            probe.appendChild(reaction);
            document.querySelector('.tgw-root').appendChild(probe);
            await document.fonts.ready;
            const result = rows.map(({line, plain, cells, size}) => {
                const bounds = cells.map(cell => cell.getBoundingClientRect());
                return {size, font: getComputedStyle(cells[0]).fontSize,
                    square: bounds.every(rect => Math.abs(rect.width-size)<0.1 && Math.abs(rect.height-size)<0.1),
                    aligned: bounds.every(rect => Math.abs(rect.top-bounds[0].top)<0.1),
                    consecutive: bounds.slice(1).every((rect, i) => Math.abs(rect.left-bounds[i].right)<0.1),
                    lineHeight: line.getBoundingClientRect().height, plainHeight: plain.getBoundingClientRect().height};
            });
            const icon = reaction.firstChild.getBoundingClientRect();
            const count = reaction.lastChild.getBoundingClientRect();
            return {rows: result, reaction: {width:icon.width, height:icon.height,
                font: parseFloat(getComputedStyle(reaction).fontSize),
                centerDelta: Math.abs((icon.top+icon.bottom-count.top-count.bottom)/2)}};
        })()`);
        for (const row of emojiLayout.rows) {
            ok(row.square && row.font === row.size + 'px', `emoji cells match the ${row.size}px surrounding font height and width`);
            ok(row.aligned && row.consecutive, `emoji keep a common baseline and fixed advance at ${row.size}px`);
            ok(Math.abs(row.lineHeight-row.plainHeight)<0.1, `emoji do not enlarge or wrap the ${row.size}px heading line`);
        }
        ok(Math.abs(emojiLayout.reaction.width-emojiLayout.reaction.font)<0.1 && emojiLayout.reaction.centerDelta<0.5,
            'reaction emoji match the count font height and stay vertically centered');
        if (process.env.TGW_EMOJI_SCREENSHOT) {
            for (const scale of [1, 2]) {
                await cdp.send('Emulation.setDeviceMetricsOverride', {width:1440,height:900,deviceScaleFactor:scale,mobile:false});
                const shot = await cdp.send('Page.captureScreenshot', {format:'png'});
                fs.writeFileSync(process.env.TGW_EMOJI_SCREENSHOT + '-' + scale + 'x.png', Buffer.from(shot.data, 'base64'));
            }
            await cdp.send('Emulation.setDeviceMetricsOverride', {width:1440,height:900,deviceScaleFactor:1,mobile:false});
        }
        await cdp.eval("document.querySelector('#tgw-emoji-layout-probe').remove()");


        console.log('\n== readable code digits ==');
        const codeSamples = await cdp.eval(`(async () => {
            const probe = document.createElement('div');
            probe.id = 'tgw-code-font-probe';
            probe.className = 'tgw-message-text';
            probe.style.cssText = 'position:fixed;left:0;top:0;opacity:0;pointer-events:none';
            const samples = [];
            for (const kind of ['inline', 'fenced']) {
                for (const fallback of [false, true]) {
                    const holder = document.createElement(kind === 'fenced' ? 'pre' : 'div');
                    if (kind === 'fenced') holder.className = 'tgw-code-block';
                    const code = document.createElement('code');
                    code.className = 'tgw-inline-code';
                    code.id = 'tgw-code-' + kind + '-' + fallback;
                    code.textContent = '00:04:34.192 43.00 pnpm@11.17.0 0123456789 # *';
                    holder.appendChild(code);
                    probe.appendChild(holder);
                    samples.push({code, kind, fallback});
                }
            }
            document.querySelector('.tgw-root').appendChild(probe);
            await document.fonts.ready;
            return samples.map(({code, kind, fallback}) => {
                if (fallback) {
                    // Emulate a platform without any of the named code fonts. Keep the
                    // actual stylesheet's fallback order so this reproduces the regression.
                    code.style.fontFamily = getComputedStyle(code).fontFamily.split(',').map((name, i) =>
                        /^(?:["']?)(ui-monospace|SFMono-Regular|Menlo|Consolas)(?:["']?)$/.test(name.trim())
                            ? '"TGW missing code font ' + i + '"' : name).join(',');
                }
                const style = getComputedStyle(code);
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                ctx.font = style.fontSize + ' ' + style.fontFamily;
                const widths = Array.from('0123456789#*').map(char => ctx.measureText(char));
                const advance = ctx.measureText('M').width;
                return {id:code.id, kind, fallback,
                    visible: widths.every(metric => metric.actualBoundingBoxRight-metric.actualBoundingBoxLeft>0),
                    monospace: widths.every(metric => Math.abs(metric.width-advance)<0.1)};
            });
        })()`);
        const codeDocument = await cdp.send('DOM.getDocument');
        for (const sample of codeSamples) {
            const {nodeId} = await cdp.send('DOM.querySelector', {nodeId:codeDocument.root.nodeId, selector:'#'+sample.id});
            const {fonts} = await cdp.send('CSS.getPlatformFontsForNode', {nodeId});
            const label = sample.kind + (sample.fallback ? ' with unavailable platform fonts' : '');
            ok(sample.visible && sample.monospace, label + ' code paints digits, # and * at monospace width');
            ok(fonts.length>0 && fonts.every(font => !font.familyName.includes('Twemoji')),
                label + ' code uses text fonts for timestamps and version numbers');
        }
        await cdp.eval("document.querySelector('#tgw-code-font-probe').remove()");

        const unreadOpening = await cdp.eval(`(() => {
            const list = document.querySelector('.tgw-messages');
            const unread = list.querySelector('[data-post-id="unread-browser-14"]');
            return {offset:unread.getBoundingClientRect().top-list.getBoundingClientRect().top,
                remaining:list.scrollHeight-list.scrollTop-list.clientHeight};
        })()`);
        ok(unreadOpening.offset >= 0 && unreadOpening.offset < 100 && unreadOpening.remaining > 200,
            `unread chat opens at the newest unread incoming message with newer own messages below (${JSON.stringify(unreadOpening)})`);

        console.log('\n== Mermaid viewer ==');
        await cdp.waitFor('!!document.querySelector(".tgw-mermaid")');
        await cdp.eval('document.querySelector(".tgw-mermaid").scrollIntoView({block:"center"})');
        await cdp.waitFor('!!document.querySelector(".tgw-mermaid svg") && !document.querySelector(".tgw-mermaid-open").disabled', 15000, 'real Mermaid rendering');
        ok(await cdp.eval('document.querySelector(".tgw-mermaid svg").textContent.includes("Review")'), 'production bundle renders Mermaid using local lazy chunks');
        await cdp.eval("document.querySelector('.tgw-mermaid-open').scrollIntoView({block:'center'})");
        await sleep(250);
        await cdp.clickSelector('.tgw-mermaid-open');
        await cdp.waitFor('!!document.querySelector(".tgw-mermaid-modal svg")', 8000, 'diagram modal SVG');
        const diagramWidth = await cdp.eval('document.querySelector(".tgw-mermaid-modal svg").getBoundingClientRect().width');
        for (let i = 0; i < 3; i++) await cdp.clickSelector('[aria-label="Zoom in"]');
        ok(await cdp.eval(`document.querySelector('.tgw-mermaid-modal svg').getBoundingClientRect().width > ${diagramWidth} * 1.5`), 'zoom increases the actual diagram size');
        const panPoint = await cdp.eval(`(() => { const v = document.querySelector('.tgw-mermaid-viewport'); const r = v.getBoundingClientRect(); return {x:r.left+200,y:r.top+140}; })()`);
        await cdp.send('Input.dispatchMouseEvent', {type:'mousePressed', x:panPoint.x, y:panPoint.y, button:'left', buttons:1, clickCount:1});
        await cdp.send('Input.dispatchMouseEvent', {type:'mouseMoved', x:panPoint.x-100, y:panPoint.y-60, buttons:1});
        await cdp.send('Input.dispatchMouseEvent', {type:'mouseReleased', x:panPoint.x-100, y:panPoint.y-60, button:'left', buttons:0, clickCount:1});
        ok(await cdp.eval('document.querySelector(".tgw-mermaid-viewport").scrollLeft > 50'), 'dragging pans an enlarged diagram');
        await cdp.send('Input.dispatchMouseEvent', {type:'mouseWheel', x:panPoint.x, y:panPoint.y, deltaX:0, deltaY:-120});
        await sleep(100);
        ok(await cdp.eval('parseInt(document.querySelector(".tgw-mermaid-toolbar output").textContent) > 173'), 'mouse wheel zooms the diagram');
        await cdp.eval(`Array.from(document.querySelectorAll('.tgw-mermaid-toolbar button')).find(b=>b.textContent==='Reset view').click()`);
        ok(await cdp.eval('document.querySelector(".tgw-mermaid-toolbar output").textContent === "100%" && document.querySelector(".tgw-mermaid-viewport").scrollLeft === 0'), 'reset restores zoom and pan');
        await cdp.send('Emulation.setDeviceMetricsOverride', {width:420,height:700,deviceScaleFactor:1,mobile:false});
        ok(await cdp.eval(`(() => { const r=document.querySelector('.tgw-mermaid-modal').getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth && r.height<=innerHeight; })()`), 'diagram modal fits a narrow screen');
        fs.writeFileSync('/tmp/tgw-mermaid-modal.png', Buffer.from((await cdp.send('Page.captureScreenshot', {format:'png'})).data, 'base64'));
        await cdp.send('Emulation.setDeviceMetricsOverride', {width:1440,height:900,deviceScaleFactor:1,mobile:false});
        await cdp.send('Input.dispatchKeyEvent', {type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27});
        await cdp.waitFor('!document.querySelector(".tgw-mermaid-modal")', 2000, 'diagram modal closes');
        ok(await cdp.eval('document.activeElement === document.querySelector(".tgw-mermaid-open")'), 'closing the diagram restores focus');

        console.log('\n== profile photo viewer ==');
        await cdp.waitFor('document.querySelector(".tgw-chat-header-main .tgw-avatar img")?.naturalWidth > 0', 5000, 'profile photo fixture');
        await cdp.clickSelector('.tgw-chat-header-main .tgw-avatar img');
        await cdp.waitFor('!!document.querySelector(".tgw-modal[aria-label^=User]")', 3000, 'profile photo viewer');
        ok(await cdp.eval('!document.querySelector(".tgw-info-panel") && document.activeElement === document.querySelector(".tgw-modal[aria-label^=User] button")'), 'photo click opens its viewer and focuses it without opening chat info');
        await cdp.send('Emulation.setDeviceMetricsOverride', {width: 420, height: 700, deviceScaleFactor: 1, mobile: false});
        await cdp.waitFor('document.querySelector(".tgw-modal[aria-label^=User] .tgw-avatar img")?.naturalWidth > 0', 3000, 'enlarged profile image');
        ok(await cdp.eval(`(() => {const r = document.querySelector('.tgw-modal[aria-label^=User] .tgw-avatar img').getBoundingClientRect(); return r.width > 100 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;})()`), 'enlarged profile photo fits the narrow viewport');
        fs.writeFileSync('/tmp/tgw-profile-photo.png', Buffer.from((await cdp.send('Page.captureScreenshot', {format: 'png'})).data, 'base64'));
        await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
        await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9});
        await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9});
        ok(await cdp.eval('document.querySelector(".tgw-modal[aria-label^=User]").contains(document.activeElement)'), 'profile viewer traps keyboard focus');
        await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
        await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
        await cdp.waitFor('!document.querySelector(".tgw-modal[aria-label^=User]")', 3000, 'photo viewer closes');
        ok(await cdp.eval('document.activeElement === document.querySelector(".tgw-chat-header-main .tgw-avatar img")'), 'closing the profile photo restores focus to its trigger');

        console.log('\n== command autocomplete ==');
        await cdp.eval('document.querySelector(".tgw-composer textarea").focus()');
        await cdp.send('Input.insertText', {text: '/he'});
        await cdp.waitFor('!!document.querySelector(".tgw-command-option")', 5000, 'command suggestions');
        const commandLayout = await cdp.eval(`(() => {
            const picker = document.querySelector('.tgw-command-picker');
            const option = picker.querySelector('button');
            const r = picker.getBoundingClientRect();
            const input = document.querySelector('.tgw-composer textarea').getBoundingClientRect();
            const b = option.getBoundingClientRect();
            return {above: r.bottom <= input.top, bounded: r.left >= 0 && r.right <= innerWidth,
                clickable: option.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)),
                background: getComputedStyle(picker).backgroundColor};
        })()`);
        ok(commandLayout.above && commandLayout.bounded && commandLayout.clickable, 'commands appear above composer and remain clickable within viewport');
        ok(commandLayout.background !== 'rgba(0, 0, 0, 0)', 'command picker has an opaque theme background');
        await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9});
        await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9});
        ok(await cdp.eval('document.activeElement === document.querySelector(".tgw-composer textarea") && document.activeElement.value === "/help "'), 'command completion preserves composer focus');
        await cdp.eval(`(() => {
            const input = document.querySelector('.tgw-composer textarea');
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '');
            input.dispatchEvent(new Event('input', {bubbles: true}));
        })()`);

        console.log('\n== delivery options layout ==');
        const deliveryLayout = await cdp.eval(`(() => {
            const link = document.querySelector('.tgw-composer-toolbar button[title="Link"]').getBoundingClientRect();
            const urgent = document.querySelector('.tgw-urgent-toggle').getBoundingClientRect();
            const schedule = document.querySelector('.tgw-schedule-toggle').getBoundingClientRect();
            const input = document.querySelector('.tgw-composer textarea').getBoundingClientRect();
            return urgent.left >= link.right && schedule.left >= urgent.right && schedule.bottom <= input.top;
        })()`);
        ok(deliveryLayout, 'urgent and schedule controls sit right of formatting and above input');
        await cdp.send('Emulation.setDeviceMetricsOverride', {width: 420, height: 700, deviceScaleFactor: 1, mobile: false});
        await cdp.eval('document.querySelector(".tgw-chat-row").click()');
        await sleep(100);
        await cdp.eval('document.querySelector(".tgw-schedule-toggle").click()');
        await cdp.waitFor('!!document.querySelector(".tgw-schedule-panel input")', 3000, 'schedule picker');
        await cdp.waitFor('document.activeElement === document.querySelector(".tgw-schedule-panel input")', 3000, 'date input focus');
        ok(await cdp.eval('document.activeElement === document.querySelector(".tgw-schedule-panel input")'), 'schedule picker focuses the date input');
        ok(await cdp.eval(`(() => {const r = document.querySelector('.tgw-schedule-panel').getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;})()`), 'schedule picker fits a narrow viewport');
        fs.writeFileSync('/tmp/tgw-schedule-options.png', Buffer.from((await cdp.send('Page.captureScreenshot', {format: 'png'})).data, 'base64'));
        await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
        await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
        await cdp.waitFor('!document.querySelector(".tgw-schedule-panel")', 3000, 'schedule picker closes');
        ok(await cdp.eval('document.activeElement === document.querySelector(".tgw-schedule-toggle")'), 'closing schedule picker returns focus to its control');
        await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});

        console.log('\n== bulk channel notification dialog ==');
        await cdp.eval(`(() => {
            const state = window.__store.getState();
            const id = state.entities.users.currentUserId;
            window.__notificationOriginalUser = state.entities.users.profiles[id];
            state.entities.users.profiles = {...state.entities.users.profiles, [id]: {...state.entities.users.profiles[id], roles: 'system_user system_admin'}};
            window.__store.dispatch({type: 'TEST_ROLE_UPDATE'});
            Array.from(document.querySelectorAll('.tgw-chat-row')).find(row => row.textContent.includes('Town Square')).click();
        })()`);
        await cdp.waitFor('document.querySelector(".tgw-chat-header-title").textContent === "Town Square"', 5000, 'channel to open');
        await cdp.eval(`document.querySelector('.tgw-chat-header [title="More"]').click()`);
        await cdp.waitFor('Array.from(document.querySelectorAll(".tgw-menu-item")).some(item => item.textContent.trim() === "Override notifications for everyone")', 3000, 'admin notification action');
        await cdp.eval('Array.from(document.querySelectorAll(".tgw-menu-item")).find(item => item.textContent.trim() === "Override notifications for everyone").click()');
        await cdp.waitFor(`!!document.querySelector('[role="dialog"][aria-label="Override channel notifications"]')`, 3000, 'notification dialog');
        ok(await cdp.eval('document.querySelectorAll(".tgw-modal select").length === 6'), 'bulk notification dialog exposes all six settings');
        await cdp.send('Emulation.setDeviceMetricsOverride', {width: 420, height: 700, deviceScaleFactor: 1, mobile: false});
        await sleep(100);
        const notificationLayout = await cdp.eval(`(() => {
            const modal = document.querySelector('.tgw-modal');
            const r = modal.getBoundingClientRect();
            return r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight &&
                Array.from(modal.querySelectorAll('select, footer button')).every(node => {const b = node.getBoundingClientRect(); return b.left >= r.left && b.right <= r.right;});
        })()`);
        ok(notificationLayout, 'notification settings and apply controls fit a narrow viewport');
        fs.writeFileSync('/tmp/tgw-channel-notifications.png', Buffer.from((await cdp.send('Page.captureScreenshot', {format: 'png'})).data, 'base64'));
        await cdp.eval(`document.querySelector('.tgw-modal [title="Close"]').click()`);
        await cdp.waitFor('!document.querySelector(".tgw-modal")', 3000, 'notification dialog closes');
        await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
        await cdp.eval(`(() => {
            const state = window.__store.getState();
            state.entities.users.profiles = {...state.entities.users.profiles, [state.entities.users.currentUserId]: window.__notificationOriginalUser};
            window.__store.dispatch({type: 'TEST_ROLE_UPDATE'});
            Array.from(document.querySelectorAll('.tgw-chat-row')).find(row => row.textContent.includes('Alice')).click();
        })()`);
        await cdp.waitFor('document.querySelector(".tgw-chat-header-title").textContent.includes("Alice")', 3000, 'direct chat restored');

        console.log('\n== scheduled queue indicator and list ==');
        await cdp.eval(`(() => {
            scheduledMessages = [
                {id:'queue-pending', user_id:ME, channel_id:DM, message:'Send the release update', scheduled_at:Date.now()+86400000, file_ids:['one','two'], priority:{priority:'urgent'}},
                {id:'queue-failed', user_id:ME, channel_id:DM, message:'Earlier announcement', scheduled_at:Date.now()-60000, error_code:'delivery_failed'},
                {id:'queue-other-chat', user_id:ME, channel_id:TOWN, message:'Other channel queue', scheduled_at:Date.now()+3600000},
                {id:'queue-other-user', user_id:OTHER, channel_id:DM, message:'Private queue', scheduled_at:Date.now()+3600000},
            ];
            window.dispatchEvent(new Event('focus'));
        })()`);
        await cdp.waitFor('document.querySelector(".tgw-schedule-count")?.textContent === "2"', 5000, 'scheduled count');
        const schedulePoint = await cdp.eval(`(() => {const r = document.querySelector('.tgw-schedule-toggle').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
        await cdp.send('Input.dispatchMouseEvent', {type:'mousePressed', button:'right', buttons:2, clickCount:1, ...schedulePoint});
        await cdp.send('Input.dispatchMouseEvent', {type:'mouseReleased', button:'right', buttons:0, clickCount:1, ...schedulePoint});
        await cdp.waitFor('document.querySelectorAll(".tgw-scheduled-message").length === 2', 3000, 'scheduled message list');
        ok(await cdp.eval(`(() => {const modal = document.querySelector('[aria-label="Scheduled messages"]'); return modal.contains(document.activeElement) && !modal.textContent.includes('Private queue') && !modal.textContent.includes('Other channel queue');})()`), 'right click opens and focuses this user’s current-chat queue');
        await cdp.send('Emulation.setDeviceMetricsOverride', {width:420,height:700,deviceScaleFactor:1,mobile:false});
        await sleep(100);
        ok(await cdp.eval(`(() => {const modal = document.querySelector('[aria-label="Scheduled messages"]'); const r = modal.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && modal.scrollWidth <= modal.clientWidth;})()`), 'scheduled queue modal fits a narrow viewport');
        ok(await cdp.eval('getComputedStyle(document.querySelector(".tgw-schedule-count")).display !== "none"'), 'scheduled indicator remains visible on compact toolbar');
        fs.writeFileSync('/tmp/tgw-scheduled-queue.png', Buffer.from((await cdp.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
        await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
        await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
        await cdp.waitFor(`!document.querySelector('[aria-label="Scheduled messages"]')`,3000,'scheduled queue closes');
        await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});

        console.log('\n== quick chat modal ==');
        await cdp.eval(`(() => {
            window.__quickPrevious = document.activeElement;
            window.__quickURL = location.href;
            window.__quickMain = document.querySelector('.tgw-shell .tgw-chat-header-title').textContent;
            const row = document.querySelector('.tgw-chat-row');
            row.dispatchEvent(new MouseEvent('mousedown', {button: 1, bubbles: true, cancelable: true}));
            row.dispatchEvent(new MouseEvent('auxclick', {button: 1, bubbles: true, cancelable: true}));
        })()`);
        await cdp.waitFor('!!document.querySelector(".tgw-quick-dialog textarea")', 8000, 'quick chat composer');
        const quickLayout = await cdp.eval(`(() => {
            const dialog = document.querySelector('.tgw-quick-dialog');
            const rect = dialog.getBoundingClientRect();
            return {centered: Math.abs(rect.x + rect.width / 2 - innerWidth / 2) < 2 && Math.abs(rect.y + rect.height / 2 - innerHeight / 2) < 2,
                bounded: rect.width <= 760 && rect.height <= innerHeight * .8 + 1,
                blur: getComputedStyle(document.querySelector('.tgw-quick-backdrop')).backdropFilter,
                focus: document.activeElement === dialog.querySelector('textarea'), inert: document.querySelector('.tgw-shell').inert,
                route: location.href === window.__quickURL && document.querySelector('.tgw-shell .tgw-chat-header-title').textContent === window.__quickMain};
        })()`);
        fs.writeFileSync('/tmp/tgw-quick-chat.png', Buffer.from((await cdp.send('Page.captureScreenshot', {format: 'png'})).data, 'base64'));
        ok(quickLayout.centered && quickLayout.bounded, 'quick chat is centered and bounded');
        ok(quickLayout.blur.includes('10px'), 'quick chat backdrop blurs by 10px');
        ok(await cdp.eval(`(() => {const button = document.querySelector('.tgw-quick-close'); const r = button.getBoundingClientRect(); return button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));})()`), 'close button is above the chat header');
        ok(quickLayout.focus && quickLayout.inert && quickLayout.route, 'quick chat focuses composer and preserves main chat');
        await cdp.clickSelector('.tgw-quick-dialog .tgw-chat-header-main .tgw-avatar img');
        await cdp.waitFor('!!document.querySelector(".tgw-modal[aria-label^=User]")', 3000, 'quick chat photo');
        ok(await cdp.eval('document.activeElement === document.querySelector(".tgw-modal[aria-label^=User] button")'), 'quick chat allows the photo viewer to take focus');
        await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
        await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
        await cdp.waitFor('!document.querySelector(".tgw-modal[aria-label^=User]")', 3000, 'quick chat photo closes');
        ok(await cdp.eval('!!document.querySelector(".tgw-quick-dialog") && document.querySelector(".tgw-quick-dialog").contains(document.activeElement)'), 'closing a photo preserves quick chat and restores its focus');

        const quickSchedulePoint = await cdp.eval(`(() => {const r = document.querySelector('.tgw-quick-dialog .tgw-schedule-toggle').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
        await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'right',buttons:2,clickCount:1,...quickSchedulePoint});
        await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'right',buttons:0,clickCount:1,...quickSchedulePoint});
        await cdp.waitFor('document.querySelectorAll(".tgw-scheduled-message").length === 2',3000,'quick chat queue modal');
        ok(await cdp.eval(`(() => {const modal = document.querySelector('[aria-label="Scheduled messages"]');const r = modal.getBoundingClientRect();return modal.contains(document.activeElement) && modal.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`), 'scheduled list opens above quick chat and takes focus');
        await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
        await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
        await cdp.waitFor(`!document.querySelector('[aria-label="Scheduled messages"]')`,3000,'quick chat queue closes');
        ok(await cdp.eval('!!document.querySelector(".tgw-quick-dialog") && document.querySelector(".tgw-quick-dialog").contains(document.activeElement)'), 'queue dismissal preserves quick chat and restores its focus');
        await cdp.eval(`(() => {
            const buttons = Array.from(document.querySelector('.tgw-quick-dialog').querySelectorAll('button:not(:disabled), textarea, input, a[href], [tabindex="0"]')).filter(x => x.getClientRects().length);
            buttons[buttons.length - 1].focus();
        })()`);
        await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9});
        await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9});
        ok(await cdp.eval('document.querySelector(".tgw-quick-dialog").contains(document.activeElement)'), 'Tab stays in quick chat');
        await cdp.send('Emulation.setDeviceMetricsOverride', {width: 420, height: 700, deviceScaleFactor: 1, mobile: false});
        await sleep(100);
        ok(await cdp.eval(`(() => {const r = document.querySelector('.tgw-quick-dialog').getBoundingClientRect(); return r.left >= 16 && r.right <= innerWidth - 16 && r.bottom <= innerHeight - 16;})()`), 'quick chat fits a narrow viewport');
        await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
        await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
        await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27});
        await cdp.waitFor('!document.querySelector(".tgw-quick-dialog")', 3000, 'quick chat closes');
        ok(await cdp.eval('!document.querySelector(".tgw-shell").inert'), 'closing quick chat releases background');

        console.log('\n== late chat layout ==');
        await cdp.waitFor('document.querySelectorAll(".tgw-messages .tgw-msg-row").length > 0', 8000, 'initial chat messages');
        const lateLayout = await cdp.eval(`(async () => {
            const list = document.querySelector('.tgw-messages');
            const lastRow = Array.from(list.querySelectorAll('.tgw-msg-row')).pop();
            list.style.height = '120px';
            list.style.flex = 'none';
            list.scrollTop = list.scrollHeight;
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const beforeHeight = list.scrollHeight;
            const clientHeight = list.clientHeight;
            lastRow.style.minHeight = (lastRow.getBoundingClientRect().height + 48) + 'px';
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const afterHeight = list.scrollHeight;
            const pinnedGap = list.scrollHeight - list.scrollTop - list.clientHeight;
            list.scrollTop = 0;
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            lastRow.style.minHeight = (lastRow.getBoundingClientRect().height + 48) + 'px';
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            const scrolledUpTop = list.scrollTop;
            lastRow.style.minHeight = '';
            list.style.height = '';
            list.style.flex = '';
            return {beforeHeight, afterHeight, clientHeight, pinnedGap, scrolledUpTop};
        })()`);
        ok(lateLayout.beforeHeight > lateLayout.clientHeight && lateLayout.afterHeight > lateLayout.beforeHeight && lateLayout.pinnedGap <= 2,
            `late message growth keeps an opened chat at the bottom (${JSON.stringify(lateLayout)})`);
        ok(lateLayout.scrolledUpTop === 0,
            `late message growth preserves a deliberately scrolled-up position (${JSON.stringify(lateLayout)})`);

        console.log('\n== image loading scroll compensation ==');
        for (const anchoring of ['none', 'auto']) {
            const imageScroll = await cdp.eval(`(async () => {
                const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const list = document.querySelector('.tgw-messages');
                const rows = Array.from(list.querySelectorAll('.tgw-msg-row'));
                const firstRow = rows[0];
                const lastRow = rows[rows.length - 1];
                list.style.height = '120px';
                list.style.flex = 'none';
                list.style.overflowAnchor = ${JSON.stringify(anchoring)};
                lastRow.style.paddingBottom = '1400px';
                const images = [firstRow, firstRow, lastRow].map((row) => {
                    const img = document.createElement('img');
                    img.style.cssText = 'display:block;width:240px;height:auto';
                    row.querySelector('.tgw-bubble').appendChild(img);
                    return img;
                });
                list.scrollTop += firstRow.getBoundingClientRect().bottom - list.getBoundingClientRect().top + 24;
                await settle();
                const beforeTop = list.scrollTop;
                const beforeHeight = list.scrollHeight;
                const beforeAnchor = lastRow.getBoundingClientRect().top;
                const src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180"></svg>');
                images[0].src = src;
                images[1].src = src;
                await Promise.all(images.slice(0, 2).map((img) => img.decode()));
                await settle();
                const growth = list.scrollHeight - beforeHeight;
                const scrollDelta = list.scrollTop - beforeTop;
                const anchorDelta = lastRow.getBoundingClientRect().top - beforeAnchor;
                const beforeBelow = list.scrollTop;
                const beforeBelowHeight = list.scrollHeight;
                images[2].src = src;
                await images[2].decode();
                await settle();
                const belowDelta = list.scrollTop - beforeBelow;
                const belowGrowth = list.scrollHeight - beforeBelowHeight;
                images.forEach((img) => img.remove());
                lastRow.style.paddingBottom = '';
                list.style.height = '';
                list.style.flex = '';
                list.style.overflowAnchor = '';
                await settle();
                return {growth, scrollDelta, anchorDelta, belowDelta, belowGrowth};
            })()`);
            ok(imageScroll.growth >= 300 && Math.abs(imageScroll.scrollDelta - imageScroll.growth) <= 2 && Math.abs(imageScroll.anchorDelta) <= 2,
                `loaded images above the viewport scroll by their added height (overflow-anchor: ${anchoring}, ${JSON.stringify(imageScroll)})`);
            ok(imageScroll.belowGrowth >= 100 && Math.abs(imageScroll.belowDelta) <= 2,
                `loaded images below the viewport preserve the reading position (overflow-anchor: ${anchoring}, ${JSON.stringify(imageScroll)})`);
        }

        console.log('\n== unread chat hover preview ==');
        const unreadPreviewPoint = await cdp.eval(`(() => {
            const row = Array.from(document.querySelectorAll('.tgw-chat-row-unread')).find((entry) => entry.textContent.includes('Alice'));
            if (!row) return null;
            const rect = row.getBoundingClientRect();
            return {x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2)};
        })()`);
        ok(!!unreadPreviewPoint, 'an unread chat is available for the hover preview');
        if (unreadPreviewPoint) {
            await cdp.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: unreadPreviewPoint.x, y: unreadPreviewPoint.y});
            await cdp.waitFor('!!document.querySelector(".tgw-unread-peek")', 5000, 'unread chat hover preview');
            await cdp.waitFor('!!document.querySelector(".tgw-unread-peek-message")', 5000, 'unread messages in hover preview');
            const peekText = await cdp.eval('document.querySelector(".tgw-unread-peek-message")?.textContent || ""');
            ok(!!peekText.trim(), `hover preview shows message text (${peekText.trim()})`);
        }

        // ---------------------------------------------------------------- 1. focus on chat open
        console.log('\\n== focus on chat open ==');
        const openTitle = await cdp.eval('document.querySelector(".tgw-chat-header-title").textContent');
        const otherRow = await cdp.eval(`(() => {
            const wanted = ${JSON.stringify('Alice')};
            const current = ${JSON.stringify(openTitle)};
            const rows = Array.from(document.querySelectorAll('.tgw-chat-row'));
            const row = rows.find((entry) => entry.textContent.includes(wanted) && !entry.textContent.includes(current))
                || rows.find((entry) => !entry.textContent.includes(current));
            if (!row) { return null; }
            row.scrollIntoView({block: 'center'});
            const rect = row.getBoundingClientRect();
            return {x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2)};
        })()`);
        ok(!!otherRow, 'another chat row is available to open');
        if (otherRow) {
            await cdp.click(otherRow.x, otherRow.y);
            await cdp.waitFor(`document.querySelector(".tgw-chat-header-title").textContent !== ${JSON.stringify(openTitle)}`, 8000, 'chat switch');
            // Long enough for both simulated host focus grabs (0ms, 60ms after the route push)
            // to have happened and our composer to have settled.
            await sleep(700);
            const chatScroll = await cdp.eval(`(() => {
                const list = document.querySelector('.tgw-messages');
                return {scrollTop: list.scrollTop, clientHeight: list.clientHeight, scrollHeight: list.scrollHeight};
            })()`);
            const unreadPosition = await cdp.eval(`(() => {
                const list = document.querySelector('.tgw-messages');
                const divider = list.querySelector('[data-post-id="unread-browser-14"]') || list.querySelector('.tgw-unread-divider');
                if (!divider) return null;
                return divider.getBoundingClientRect().top - list.getBoundingClientRect().top;
            })()`);
            ok(unreadPosition !== null ? unreadPosition >= -2 && unreadPosition < chatScroll.clientHeight
                : chatScroll.scrollTop + chatScroll.clientHeight >= chatScroll.scrollHeight - 2,
                `opening a chat shows its newest unread message or latest read messages (${JSON.stringify(chatScroll)})`);
            const focused = await cdp.eval(`(() => {
                const active = document.activeElement;
                const composer = document.querySelector('.tgw-composer textarea');
                return {
                    isComposer: !!composer && active === composer,
                    where: active ? (active.tagName + '#' + (active.id || '') + '.' + (active.className || '')) : 'none',
                };
            })()`);
            ok(focused.isComposer, `composer owns the keyboard after opening a chat, even when the host app steals it (focus on: ${focused.where})`);
        }

        console.log('\n== compact message and search inputs ==');
        const inputStyles = await cdp.eval(`(() => {
            const composer = document.querySelector('.tgw-composer textarea');
            const box = composer.closest('.tgw-composer-input');
            composer.blur();
            const neutralBorder = getComputedStyle(box).borderColor;
            composer.focus();
            const style = getComputedStyle(composer);
            const search = document.querySelector('.tgw-sidebar-header .tgw-search');
            const searchInput = search.querySelector('input');
            return {placeholder: composer.placeholder, outline: style.outlineStyle, shadow: style.boxShadow,
                border: getComputedStyle(box).borderColor,
                neutralBorder,
                searchHeight: search.getBoundingClientRect().height, inputHeight: searchInput.getBoundingClientRect().height};
        })()`);
        ok(inputStyles.placeholder === 'Write a message ...', 'the composer uses the requested placeholder');
        ok(inputStyles.outline === 'none' && inputStyles.shadow === 'none' && inputStyles.border === inputStyles.neutralBorder,
            `the focused message input keeps its neutral border without a blue ring (${JSON.stringify(inputStyles)})`);
        ok(inputStyles.searchHeight === 34 && inputStyles.inputHeight <= 34,
            `the search field stays compact (${JSON.stringify(inputStyles)})`);

        console.log('\n== shared files scrolling ==');
        await cdp.eval(`document.querySelector('.tgw-chat-header button[title="Shared files"]').click()`);
        await cdp.waitFor('!!document.querySelector(".tgw-files-panel .tgw-files-search")', 6000, 'the shared files panel');
        const filesLayout = await cdp.eval(`(() => {
            const panel = document.querySelector('.tgw-files-panel');
            const body = panel.querySelector('.tgw-files-body');
            const search = panel.querySelector('.tgw-files-search');
            return {panelOverflow: getComputedStyle(panel).overflowY, bodyOverflow: getComputedStyle(body).overflowY,
                searchTop: search.getBoundingClientRect().top, panelTop: panel.getBoundingClientRect().top};
        })()`);
        ok(filesLayout.panelOverflow === 'hidden' && filesLayout.bodyOverflow === 'auto' && filesLayout.searchTop >= filesLayout.panelTop,
            `file rows scroll below the fixed search bar (${JSON.stringify(filesLayout)})`);
        await cdp.eval(`document.querySelector('.tgw-files-panel button[title="Collapse"]').click()`);

        // ------------------------------------------------- 2. edit a long message grows the box
        console.log('\\n== editing a long message ==');
        const marker = 'zebrafish-observatory';
        const longMessage = `Drafting a ${marker} report for the release. `
            + 'The quick brown fox jumps over the lazy dog again and again while the box keeps its height under control. '
            + 'Second paragraph: deployments, rollbacks, feature flags, canaries, dashboards, on-call rotations and runbooks all need to be linked from this message so reviewers can find them without scrolling. '
            + 'Third paragraph: a review checklist covering screenshots, migration notes, telemetry additions, rollback steps and the customer communication draft. '
            + 'Fourth paragraph: thanks to everyone who tested the candidate builds on short notice and filed the crisp reproduction notes that made the remaining failures tractable.';
        await cdp.eval('document.querySelector(".tgw-composer textarea").focus()');
        await cdp.type(longMessage);
        const typedLength = await cdp.eval('document.querySelector(".tgw-composer textarea").value.length');
        ok(typedLength > 200, `typed a long message into the composer (${typedLength} chars)`);
        await cdp.eval(`(() => {
            const list = document.querySelector('.tgw-messages');
            list.style.height = '120px';
            list.style.flex = 'none';
            list.scrollTop = 0;
            list.dispatchEvent(new Event('scroll', {bubbles: true}));
        })()`);
        await sleep(100);
        await cdp.eval('document.querySelector(".tgw-send-button").click()');
        await cdp.waitFor(`Array.from(document.querySelectorAll(".tgw-msg-out")).some((row) => row.textContent.includes(${JSON.stringify(marker)}))`, 10000, 'the sent message to render');
        const sentScroll = await cdp.eval(`(() => {
            const list = document.querySelector('.tgw-messages');
            const result = {scrollTop: list.scrollTop, clientHeight: list.clientHeight, scrollHeight: list.scrollHeight};
            list.style.height = '';
            list.style.flex = '';
            return result;
        })()`);
        ok(sentScroll.scrollHeight > sentScroll.clientHeight && sentScroll.scrollTop + sentScroll.clientHeight >= sentScroll.scrollHeight - 2,
            `sending from above scrolls to the new message (${JSON.stringify(sentScroll)})`);
        console.log('\n== short chat bottom alignment ==');
        const shortChatLayout = await cdp.eval(`(() => {
            const list = document.querySelector('.tgw-messages');
            const rows = Array.from(list.querySelectorAll('.tgw-msg-row'));
            if (!rows.length) { return {available: false}; }
            const children = Array.from(list.children).map((element) => ({element, display: element.style.display}));
            const previousScrollTop = list.scrollTop;
            const lastRow = rows[rows.length - 1];
            children.forEach(({element}) => {
                if (element !== lastRow) { element.style.display = 'none'; }
            });
            list.scrollTop = 0;
            const gap = list.getBoundingClientRect().bottom - lastRow.getBoundingClientRect().bottom;
            children.forEach(({element, display}) => { element.style.display = display; });
            list.scrollTop = previousScrollTop;
            return {available: true, gap, clientHeight: list.clientHeight};
        })()`);
        ok(shortChatLayout.available && shortChatLayout.gap >= -1 && shortChatLayout.gap < 48,
            `a short message stack rests at the bottom (${JSON.stringify(shortChatLayout)})`);
        await cdp.eval(`(() => {
            const row = Array.from(document.querySelectorAll('.tgw-msg-out')).find((entry) => entry.textContent.includes(${JSON.stringify(marker)}));
            row.querySelector('button[title="More"]').click();
            return true;
        })()`);
        await cdp.waitFor('!!document.querySelector(".tgw-menu")', 6000, 'the message menu');
        const openedEdit = await cdp.eval(`(() => {
            const item = Array.from(document.querySelectorAll('.tgw-menu-item')).find((entry) => entry.textContent.includes('Edit message'));
            if (!item) { return false; }
            item.click();
            return true;
        })()`);
        ok(openedEdit, 'the message menu offers "Edit message"');
        await cdp.waitFor('!!document.querySelector(".tgw-edit-bar")', 6000, 'the edit bar');
        await sleep(150);
        const box = await cdp.eval(`(() => {
            const textarea = document.querySelector('.tgw-composer textarea');
            return {
                styleHeight: textarea.style.height,
                rectHeight: Math.round(textarea.getBoundingClientRect().height),
                textLength: textarea.value.length,
                scrollHeight: textarea.scrollHeight,
            };
        })()`);
        ok(parseInt(box.styleHeight, 10) >= 100,
            `the edit box grows to fit a long message (style height ${box.styleHeight}, box ${box.rectHeight}px, ${box.textLength} chars)`);
        ok(box.rectHeight >= 100, `the grown height is visible on screen (${box.rectHeight}px)`);
        await cdp.eval('document.querySelector(".tgw-composer textarea").select()');
        await cdp.send('Input.insertText', {text: 'short'});
        await sleep(150);
        const shrunk = await cdp.eval('Math.round(document.querySelector(".tgw-composer textarea").getBoundingClientRect().height)');
        ok(shrunk < box.rectHeight && shrunk < 60, `removing long input shrinks the composer again (${shrunk}px)`);
        await cdp.eval(`(() => {
            const textarea = document.querySelector('.tgw-composer textarea');
            textarea.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}));
            return true;
        })()`);
        await cdp.waitFor('!document.querySelector(".tgw-edit-bar")', 6000, 'edit mode to close');

        // ------------------------------------------- 3. sidebar search includes chat messages
        console.log('\\n== sidebar search reaches chat messages ==');
        await cdp.clickSelector('.tgw-search input');
        await cdp.type('de');
        const searchValue = await cdp.eval('document.querySelector(".tgw-search input").value');
        ok(searchValue.length > 0, `typed into the sidebar search box (${searchValue})`);
        // 350ms debounce + the search round trip — and this has to happen for *short* queries too,
        // not only from three characters on (the chats/contacts results answer at any length).
        await cdp.waitFor('window.__calls.some((call) => call === "POST /posts/search")', 6000, 'the message search request');
        const shortSections = await cdp.waitFor(`(() => {
            const titles = Array.from(document.querySelectorAll('.tgw-search-results .tgw-section-title')).map((node) => node.textContent.trim());
            return titles.length ? titles.join(' | ') : false;
        })()`, 6000, 'the sidebar search results for a 2-character query');
        ok(String(shortSections).split(' | ').includes('Messages'),
            `a 2-character query searches chat messages too (sections: ${shortSections})`);
        // Keep typing to the full word and verify the deeper result flow (hits + jump).
        await cdp.type('ploy');
        const sections = await cdp.waitFor(`(() => {
            const titles = Array.from(document.querySelectorAll('.tgw-search-results .tgw-section-title')).map((node) => node.textContent.trim());
            return titles.length ? titles.join(' | ') : false;
        })()`, 6000, 'the sidebar search results');
        const hasMessages = String(sections).split(' | ').includes('Messages');
        ok(hasMessages, `sidebar search searches chat messages too (sections: ${sections})`);
        ok(!!(await cdp.eval('!!document.querySelector(".tgw-message-hit")')), 'a message hit is rendered in the sidebar');

        // Clicking an *off-screen* hit must fetch it and land the chat on the message
        // (p-old is older than the first page the chat loads), not just open the chat.
        await cdp.waitFor(`Array.from(document.querySelectorAll('.tgw-message-hit')).some((row) => row.textContent.includes('pipeline'))`, 6000, 'the off-screen hit in the sidebar');
        const oldHitPoint = await cdp.eval(`(() => {
            const row = Array.from(document.querySelectorAll('.tgw-message-hit')).find((entry) => entry.textContent.includes('pipeline'));
            if (!row) { return null; }
            row.scrollIntoView({block: 'center'});
            const rect = row.getBoundingClientRect();
            return {x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2)};
        })()`);
        if (oldHitPoint) {
            await cdp.click(oldHitPoint.x, oldHitPoint.y);
        }
        ok(await cdp.waitFor('window.__calls.some((call) => call === "GET /posts/p-old")', 8000, 'the off-screen hit to be fetched on demand'),
            'the off-screen message search hit is fetched on demand');
        await cdp.waitFor('!document.querySelector(".tgw-message-hit")', 6000, 'the search results to close after picking a hit');
        const landed = await cdp.waitFor(`!!document.querySelector('[data-post-id="p-old"]') && document.querySelector('[data-post-id="p-old"]').classList.contains('tgw-post-highlight')`, 8000, 'the chat to land on the hit message');
        ok(!!landed, 'the chat lands on the hit message with the flash highlight');

        // ------------------------------------------- 4. Ctrl+A in the search box stays in the box
        console.log('\\n== Ctrl+A in a text field ==');
        await cdp.eval('document.querySelector(".tgw-search input").focus()');
        await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65});
        await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65});
        const selectAll = await cdp.eval(`(() => {
            const input = document.querySelector('.tgw-search input');
            const selection = window.getSelection();
            return {
                inside: input.selectionStart === 0 && input.selectionEnd === input.value.length,
                outsideText: String(selection),
                outsideCollapsed: selection.isCollapsed,
                userSelect: getComputedStyle(input).userSelect,
            };
        })()`);
        ok(selectAll.userSelect === 'text', `the field's computed user-select is text, whatever the chrome around it says (${selectAll.userSelect})`);
        ok(selectAll.inside, 'Ctrl+A selects all the text inside the focused input');
        ok(selectAll.outsideCollapsed || selectAll.outsideText === '',
            `no page text (usernames) is selected outside the input (selection: ${JSON.stringify(selectAll.outsideText)})`);

        console.log('\n== composer typing stability ==');
        await cdp.eval(`(() => {
            const area = document.querySelector('.tgw-composer textarea');
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(area, Array.from({length:10},(_,n)=>'Draft line '+n).join('\\n'));
            area.dispatchEvent(new Event('input',{bubbles:true}));
            area.focus({preventScroll:true});
            area.setSelectionRange(area.value.length,area.value.length);
        })()`);
        await cdp.waitFor('document.querySelector(".tgw-composer textarea").getBoundingClientRect().height > 180',3000,'multiline composer');
        await cdp.eval(`(() => {
            const list = document.querySelector('.tgw-messages');
            list.scrollTop = list.scrollHeight-list.clientHeight-120;
            list.dispatchEvent(new Event('scroll',{bubbles:true}));
        })()`);
        await sleep(100);
        await cdp.eval(`(() => {
            const list = document.querySelector('.tgw-messages');
            window.__typingAnchor = Array.from(list.querySelectorAll('[data-post-id]')).find(row=>row.getBoundingClientRect().top>=list.getBoundingClientRect().top);
            window.__typingFrames = [];
            window.__typingSampling = true;
            const sample = () => {
                window.__typingFrames.push({top:window.__typingAnchor.getBoundingClientRect().top,height:document.querySelector('.tgw-composer textarea').getBoundingClientRect().height,scrollTop:list.scrollTop});
                if (window.__typingSampling) requestAnimationFrame(sample);
            };
            sample();
        })()`);
        for (let n=0;n<12;n++) {
            await cdp.send('Input.insertText',{text:'x'});
            await sleep(25);
        }
        const typingStability = await cdp.eval(`(() => {
            window.__typingSampling = false;
            const frames = window.__typingFrames;
            return {travel:Math.max(...frames.map(f=>f.top))-Math.min(...frames.map(f=>f.top)),heightTravel:Math.max(...frames.map(f=>f.height))-Math.min(...frames.map(f=>f.height)),samples:frames.length};
        })()`);
        ok(typingStability.samples > 5 && typingStability.travel <= 2 && typingStability.heightTravel <= 2,
            `typing within a line keeps the composer and visible history steady (${JSON.stringify(typingStability)})`);
        await cdp.eval(`(() => {
            const area=document.querySelector('.tgw-composer textarea');
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(area,'');
            area.dispatchEvent(new Event('input',{bubbles:true}));
        })()`);

        console.log('\n== editing scheduled messages ==');
        await cdp.eval(`(() => {
            scheduledMessages = [{id:'browser-edit',user_id:ME,channel_id:DM,message:'Edit this scheduled text',scheduled_at:Date.now()+86400000}];
            window.dispatchEvent(new Event('focus'));
        })()`);
        await cdp.waitFor('document.querySelector(".tgw-schedule-count")?.textContent === "1"',5000,'edit queue seed');
        await cdp.eval(`document.querySelector('.tgw-schedule-toggle').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`);
        await cdp.waitFor('!!document.querySelector(".tgw-scheduled-actions")',3000,'scheduled edit actions');
        await cdp.clickSelector('.tgw-scheduled-actions button:first-child');
        await cdp.waitFor('!!document.querySelector(".tgw-schedule-panel") && !document.querySelector(".tgw-modal")',5000,'edit restored in composer');
        ok(await cdp.eval(`document.querySelector('.tgw-composer textarea').value === 'Edit this scheduled text' && !!document.querySelector('[aria-label="Scheduled send time"]').value && !document.querySelector('.tgw-schedule-count')`),'Edit removes the queued entry and restores composer text and schedule time');
        ok(await cdp.eval(`document.activeElement === document.querySelector('[aria-label="Scheduled send time"]')`),'schedule time is focused after editing a queued message');
        await cdp.clickSelector('.tgw-schedule-actions button:first-child');
        await cdp.eval(`(() => {
            scheduledMessages = [{id:'browser-remove',user_id:ME,channel_id:DM,message:'Cancel this scheduled text',scheduled_at:Date.now()+86400000}];
            window.dispatchEvent(new Event('focus'));
        })()`);
        await cdp.waitFor('document.querySelector(".tgw-schedule-count")?.textContent === "1"',5000,'remove queue seed');
        await cdp.eval(`document.querySelector('.tgw-schedule-toggle').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}))`);
        await cdp.waitFor('!!document.querySelector(".tgw-scheduled-actions")',3000,'scheduled remove action');
        await cdp.clickSelector('.tgw-scheduled-actions button:last-child');
        await cdp.waitFor('!document.querySelector(".tgw-schedule-count") && !document.querySelector(".tgw-scheduled-message")',5000,'scheduled removal');
        ok(await cdp.eval('document.querySelector(".tgw-modal").textContent.includes("No scheduled messages")'),'Remove refreshes the queue and clears its indicator');

        console.log('\n== lazy local PDF viewer ==');
        await cdp.eval(`document.querySelector('.tgw-modal [title="Close"]')?.click()`);
        await cdp.eval(`Array.from(document.querySelectorAll('.tgw-chat-row')).find(row=>row.textContent.includes('Alice')).click()`);
        await cdp.waitFor(`!!document.querySelector('[aria-label="Preview local-notes.txt"]')`,5000,'PDF fixture chat');
        ok(pdfRequests.length === 0, 'PDF.js assets are not requested at startup or during normal chat use');
        await cdp.eval(`document.querySelector('[aria-label="Preview local-notes.txt"]').click()`);
        await cdp.waitFor(`!!document.querySelector('.tgw-file-preview-text')`,5000,'text attachment');
        ok(pdfRequests.length === 0, 'text previews do not request the PDF engine');
        await cdp.eval(`(() => {
            document.querySelector('.tgw-modal [title="Close"]').click(); window.desktopAPI = {};
            window.__pdfWorkers = [];
            const NativeWorker = window.Worker;
            window.Worker = class extends NativeWorker {
                constructor(url, options) {
                    super(url, options);
                    this.record = {url:String(url), terminated:false}; window.__pdfWorkers.push(this.record);
                }
                terminate() {this.record.terminated = true; return super.terminate();}
            };
        })()`);
        await cdp.eval(`document.querySelector('[aria-label="Preview local-preview.pdf"]').click()`);
        await cdp.waitFor(`!!document.querySelector('.tgw-file-preview [role="alert"]')`,8000,'module loading error');
        ok(await cdp.eval(`document.querySelector('.tgw-file-preview').textContent.includes('Could not load the PDF viewer')`),'module failure shows a retry action');
        await cdp.eval(`Array.from(document.querySelectorAll('.tgw-file-preview button')).find(b=>b.textContent==='Retry').click()`);
        await cdp.waitFor(`document.querySelector('.tgw-pdf-viewport')?.getAttribute('aria-busy')==='false' && document.querySelector('.tgw-pdf-viewport canvas')?.width>0`,15000,'real PDF.js page render');
        const pixel = await cdp.eval(`Array.from(document.querySelector('.tgw-pdf-viewport canvas').getContext('2d').getImageData(10,10,1,1).data)`);
        ok(pixel[0]>150 && pixel[2]<80, 'the packaged engine and module worker render the first PDF page in desktop mode');
        ok(pdfRequests.some(url=>url.endsWith('/pdf.worker.min.mjs')) && !await cdp.eval(`!!document.querySelector('object, iframe')`), 'PDF viewer uses the local worker without a native PDF embed');
        await cdp.clickSelector('[aria-label="Next PDF page"]');
        await cdp.waitFor(`document.querySelector('.tgw-pdf-page-count').textContent==='Page 2 of 2' && document.querySelector('.tgw-pdf-viewport').getAttribute('aria-busy')==='false'`,8000,'second PDF page');
        const secondPixel = await cdp.eval(`Array.from(document.querySelector('.tgw-pdf-viewport canvas').getContext('2d').getImageData(10,10,1,1).data)`);
        ok(secondPixel[2]>150 && secondPixel[0]<80, 'page navigation renders a different PDF page');
        const width = await cdp.eval(`document.querySelector('.tgw-pdf-viewport canvas').width`);
        await cdp.clickSelector('[aria-label="Zoom PDF in"]');
        await cdp.waitFor(`document.querySelector('.tgw-pdf-viewport canvas').width>${width} && document.querySelector('.tgw-pdf-viewport').getAttribute('aria-busy')==='false'`,8000,'PDF zoom');
        ok(await cdp.eval(`document.querySelector('.tgw-pdf-viewport canvas').width>${width}`), 'zoom increases the rendered page resolution');
        await cdp.clickSelector('[title="Fit PDF to width"]');
        await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
        await cdp.waitFor(`document.querySelector('.tgw-pdf-viewport canvas').getBoundingClientRect().width<390 && document.querySelector('.tgw-pdf-viewport').getAttribute('aria-busy')==='false'`,8000,'responsive PDF width');
        ok(await cdp.eval(`(() => {const modal=document.querySelector('.tgw-modal');return modal.scrollWidth<=modal.clientWidth+1 && document.querySelector('.tgw-pdf-viewport canvas').width>0;})()`), 'PDF toolbar and fit-to-width page work on narrow screens');
        fs.writeFileSync('/tmp/tgw-local-pdf.png', Buffer.from((await cdp.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
        const activeWorker = `window.__pdfWorkers.some(worker=>worker.url.includes('pdf.worker.min.mjs') && !worker.terminated)`;
        ok(await cdp.eval(activeWorker), 'PDF parsing runs in a real background worker');
        await cdp.eval(`document.querySelector('.tgw-modal [title="Close"]').click()`);
        await cdp.waitFor(`!(${activeWorker})`,5000,'PDF worker cleanup');
        ok(!await cdp.eval(activeWorker), 'closing the PDF terminates its background worker');
        const modulesBefore = pdfRequests.filter(url=>url.endsWith('/pdf.min.mjs')).length;
        await cdp.eval(`document.querySelector('[aria-label="Preview local-preview.pdf"]').click()`);
        await cdp.waitFor(`document.querySelector('.tgw-pdf-viewport')?.getAttribute('aria-busy')==='false'`,10000,'reopened PDF');
        ok(pdfRequests.filter(url=>url.endsWith('/pdf.min.mjs')).length===modulesBefore, 'reopening reuses the loaded renderer module');
        await cdp.eval(`document.querySelector('.tgw-modal [title="Close"]').click(); delete window.desktopAPI;`);
        await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});

        console.log('\n== shared todo panel ==');
        await cdp.clickSelector('.tgw-chat-header [title="TODO"]');
        await cdp.waitFor('!!document.querySelector(".tgw-todos-panel")', 5000, 'todo panel');
        await cdp.eval(`(() => {
            const input = document.querySelector('[aria-label="New todo"]');
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Review shared deployment');
            input.dispatchEvent(new Event('input', {bubbles:true}));
        })()`);
        await cdp.waitFor('!document.querySelector(".tgw-todo-add button[type=submit]").disabled', 5000, 'todo form');
        await cdp.clickSelector('.tgw-todo-add button[type=submit]');
        await cdp.waitFor('document.querySelector(".tgw-todo-row")?.textContent.includes("Review shared deployment")', 5000, 'saved todo');
        const todoDesktop = await cdp.eval(`(() => {
            const panel = document.querySelector('.tgw-todos-panel').getBoundingClientRect();
            const body = document.querySelector('.tgw-todos-panel .tgw-files-body');
            const text = document.querySelector('.tgw-todo-text').getBoundingClientRect();
            return {width:panel.width, fits:panel.right<=innerWidth+1&&text.right<=panel.right, scrollable:getComputedStyle(body).overflowY, addBackground:getComputedStyle(document.querySelector('.tgw-todo-add button[type=submit]')).backgroundColor};
        })()`);
        ok(todoDesktop.width >= 300 && todoDesktop.fits && todoDesktop.scrollable === 'auto', 'todo panel uses the shared-file gutter and a scrolling task list');
        ok(todoDesktop.addBackground !== 'rgba(0, 0, 0, 0)', 'todo Add uses the existing primary button styling');
        await cdp.waitFor('!!document.querySelector(".tgw-todo-badge")',5000,'todo sidebar count');
        const borderContained = await cdp.eval(`Array.from(document.querySelectorAll('.tgw-todo-badge')).every((badge) => {
            const avatar = badge.parentElement.getBoundingClientRect();
            const border = badge.getBoundingClientRect();
            return border.left >= avatar.left && border.top >= avatar.top && border.right <= avatar.right && border.bottom <= avatar.bottom;
        })`);
        ok(borderContained, 'TODO borders stay inside their avatar bounds without protruding into the chat row');
        await cdp.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
        await sleep(150);
        const todoMobile = await cdp.eval(`(() => {
            const panel = document.querySelector('.tgw-todos-panel').getBoundingClientRect();
            const input = document.querySelector('[aria-label="New todo"]').getBoundingClientRect();
            return {fits:panel.left>=0&&panel.right<=innerWidth+1&&input.right<=panel.right,width:panel.width};
        })()`);
        ok(todoMobile.fits && todoMobile.width <= 390, 'todo controls fit inside the mobile overlay');
        fs.writeFileSync('/tmp/tgw-todos-mobile.png',Buffer.from((await cdp.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
        await cdp.clickSelector('[title="Collapse todos"]');
        await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});

        const pageErrors = [...bootErrors, ...await cdp.eval('window.__pageErrors'), ...cdp.pageErrors];
        ok(pageErrors.length === 0, `no page errors during the run${pageErrors.length ? ` (${pageErrors[0]})` : ''}`);
    } catch (error) {
        fail(`browser run failed: ${error.message}`);
        if (cdp) {
            try {
                // eslint-disable-next-line no-await-in-loop
                const diagnostics = await cdp.eval(`JSON.stringify({
                    pageErrors: window.__pageErrors,
                    mermaidModal: document.querySelector('.tgw-mermaid-modal')?.textContent,
                    mermaidButton: (()=>{const b=document.querySelector('.tgw-mermaid-open'); const r=b?.getBoundingClientRect(); return r ? {disabled:b.disabled,x:r.x,y:r.y,width:r.width,height:r.height,at:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,300)} : null;})(),
                    rows: document.querySelectorAll('.tgw-chat-row').length,
                    header: (document.querySelector('.tgw-chat-header-title') || {}).textContent || null,
                    composer: !!document.querySelector('.tgw-composer textarea'),
                    calls: (window.__calls || []).slice(0, 25),
                    sidebar: (document.querySelector('.tgw-sidebar-body') || {}).textContent || null,
                })`);
                console.log('diagnostics:', diagnostics);
            } catch (nested) {
                console.log('diagnostics unavailable:', nested.message);
            }
        }
    } finally {
        if (cdp) {
            cdp.close();
        }
        cleanup();
    }

    report('BROWSER TEST');
    process.exit(process.exitCode || 0);
})().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
});
