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
 */

const fs = require('fs');
const http = require('http');
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
const calls = []; const payloads = [];
window.__calls = calls;
window.__payloads = payloads;
const viewTracking = new Map([
    ['p3', new Set([OTHER, THIRD])],
    ['p1', new Set([OTHER])],
    ['p2', new Set([OTHER])],
]);

// --- the harness' fetch stub, running in the page ----------------------------------------------
window.fetch = ${String(global.fetch)};

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
        registerChannelHeaderButtonAction: () => 'header-1',
        registerMainMenuAction: () => 'menu-1',
        registerWebSocketEventHandler: () => undefined,
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

    const server = http.createServer((request, response) => {
        if (request.url === '/' || request.url.startsWith('/?')) {
            response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
            response.end(page);
        } else {
            // Avatars and anything else the page asks for over the network: not available here.
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

        await cdp.waitFor('window.__BOOTED === true && document.querySelector(".tgw-root") ? true : false', 20000, 'overlay to render');
        await cdp.waitFor('!!document.querySelector(".tgw-composer textarea")', 20000, 'composer to mount');
        await cdp.waitFor('document.querySelectorAll(".tgw-chat-row").length > 0 && !!document.querySelector(".tgw-chat-header-title")', 20000, 'chat list + open chat');
        await sleep(500);

        const bootErrors = await cdp.eval('window.__pageErrors');
        ok(bootErrors.length === 0, `bundle booted without page errors${bootErrors.length ? ` (${bootErrors[0]})` : ''}`);

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
            ok(chatScroll.scrollTop + chatScroll.clientHeight >= chatScroll.scrollHeight - 2,
                `opening a chat starts at its latest messages (${JSON.stringify(chatScroll)})`);
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

        const pageErrors = [...bootErrors, ...await cdp.eval('window.__pageErrors'), ...cdp.pageErrors];
        ok(pageErrors.length === 0, `no page errors during the run${pageErrors.length ? ` (${pageErrors[0]})` : ''}`);
    } catch (error) {
        fail(`browser run failed: ${error.message}`);
        if (cdp) {
            try {
                // eslint-disable-next-line no-await-in-loop
                const diagnostics = await cdp.eval(`JSON.stringify({
                    pageErrors: window.__pageErrors,
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
