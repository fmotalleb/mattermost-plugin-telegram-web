/*
 * Bundle test: runs the production bundle (webapp/dist/main.js) inside jsdom behind a stand-in for
 * the Mattermost web app plugin host.
 *
 * Where test/smoke.js exercises src/ directly, this test loads the artifact that actually ships in
 * the plugin tarball, so it verifies the things the source test cannot see:
 *   - webpack `externals` are wired to the exact globals Mattermost exposes (window.React,
 *     window.ReactDOM, ...) and the bundle does not try to load its own copy of React,
 *   - the entry point calls window.registerPlugin(PLUGIN_ID, plugin) with the id from plugin.json,
 *   - initialize(registry, store) works against a host-shaped registry and the real redux store,
 *   - the CSS is inlined in the bundle (style-loader writes a <style> tag at runtime),
 *   - the websocket handlers registered in initialize() feed the UI, and
 *   - the "tgw:disable" event hides the UI again.
 *
 *   npm run test:bundle      (run `npm run build` first)
 */

const fs = require('fs');
const path = require('path');

const bundlePath = path.join(__dirname, '..', 'dist', 'main.js');
if (!fs.existsSync(bundlePath)) {
    console.error('dist/main.js is missing - run `npm run build` before `npm run test:bundle`.');
    process.exit(1);
}

const {
    dom, React, ReactDOM, ReactDOMLegacy, container, calls,
    store, state, tick, ok, fail, report,
} = require('./harness');

// --------------------------------------------------------------------------- fake plugin host
// The globals Mattermost's plugin loader exposes to plugin bundles
// (see webapp/channels/src/plugins/export.ts upstream).
window.React = React;
window.ReactDOM = ReactDOMLegacy;
window.ReactJSXRuntime = require('react/jsx-runtime');

// webpack `externals` emit bare global references (`React`, `ReactDOM`). In a browser a bare
// reference resolves against `window`, but here the bundle is evaluated in Node's module scope,
// where `React` resolves against `global`, so the globals are mirrored too.
global.React = React;
global.ReactDOM = ReactDOMLegacy;
global.ReactJSXRuntime = window.ReactJSXRuntime;
// Simulate Mattermost serving hashed scripts from a non-root installation path.
global.self = window;
window.basename = '/nested';
state.entities.general.config.PluginSettings.Plugins['com.telegramweb.ui'].DefaultMode = false;
const originalFetch = global.fetch;
global.fetch = (url, options) => originalFetch(String(url).replace('/nested/', '/'), options);
const chunkRequests = [];
let failFirstChunk = true;
const originalAppend = document.head.appendChild.bind(document.head);
document.head.appendChild = (node) => {
    if (node.tagName !== 'SCRIPT' || !node.src) return originalAppend(node);
    const pathname = new URL(node.src).pathname;
    const prefix = '/nested/plugins/com.telegramweb.ui/';
    if (!pathname.startsWith(prefix)) throw new Error(`Unexpected chunk URL: ${node.src}`);
    const file = path.resolve(__dirname, '..', '..', pathname.slice(prefix.length));
    chunkRequests.push(pathname);
    queueMicrotask(() => {
        if (failFirstChunk) { failFirstChunk = false; node.onerror?.({type:'error',target:node}); return; }
        try { require(file); node.onload?.({type:'load',target:node}); }
        catch (error) { console.error(error); node.onerror?.({type:'error',target:node}); }
    });
    return node;
};
const waitFor = async (predicate) => { for(let n=0;n<200&&!predicate();n++) await tick(20); return predicate(); };


const pluginJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'plugin.json'), 'utf8'));

let registered = null;
window.registerPlugin = (id, plugin) => {
    registered = {id, plugin};
};

const registryCalls = {rootComponents: [], headerButtons: [], menuItems: [], wsHandlers: {}, unregistered: []};
const root = ReactDOM.createRoot(container);

const registry = {
    registerRootComponent: (component) => {
        registryCalls.rootComponents.push(component);
        root.render(React.createElement(component));
        return 'root-1';
    },
    registerChannelHeaderButtonAction: (icon, action, dropdownText, tooltipText) => {
        registryCalls.headerButtons.push({icon, action, dropdownText, tooltipText});
        return 'header-1';
    },
    registerMainMenuAction: (text, action) => {
        registryCalls.menuItems.push({text, action});
        return 'menu-1';
    },
    registerWebSocketEventHandler: (event, handler) => {
        registryCalls.wsHandlers[event] = handler;
    },
    unregisterWebSocketEventHandler: (event) => {
        delete registryCalls.wsHandlers[event];
    },
    unregisterComponent: (id) => {
        registryCalls.unregistered.push(id);
    },
};

(async () => {
    // Load the built bundle exactly like the plugin loader does: as a script that self-registers.
    require(bundlePath);
    await tick(20);

    console.log('\n== plugin registration ==');
    ok(!!registered, 'the bundle called window.registerPlugin');
    if (!registered) {
        report('BUNDLE TEST');
        return;
    }
    ok(registered.id === pluginJson.id, `registered under the plugin.json id (${pluginJson.id})`);
    ok(typeof registered.plugin.initialize === 'function', 'the plugin instance exposes initialize()');
    ok(typeof registered.plugin.uninitialize === 'function', 'the plugin instance exposes uninitialize()');

    registered.plugin.initialize(registry, store);
    await tick(80);

    ok(chunkRequests.length === 0 && !document.querySelector('.tgw-root') && !document.querySelector('style'), 'disabled plugin loads no UI chunks, CSS or fonts');
    registryCalls.headerButtons[0].action();
    await waitFor(() => document.querySelector('[role="alert"]'));
    ok(document.body.textContent.includes('Could not load the Telegram view.'), 'a failed UI chunk offers recovery');
    Array.from(document.querySelectorAll('button')).find((button) => button.textContent === 'Retry')?.click();
    await waitFor(() => document.querySelector('.tgw-composer textarea'));
    ok(chunkRequests.every((url) => url.startsWith('/nested/plugins/com.telegramweb.ui/public/webapp/')), 'lazy chunks respect Mattermost subpaths and the plugin public route');
    ok(!chunkRequests.some((url) => /mermaid|imageviewer|modals|emoji-picker/.test(url)), 'optional feature chunks are not requested when opening a normal chat');

    console.log('\n== host integration ==');
    ok(registryCalls.rootComponents.length === 1, 'registered one root component');
    ok(registryCalls.headerButtons.length === 1, 'registered a channel header button');
    ok(registryCalls.menuItems.length === 1, 'registered a main menu entry');
    ok(Object.keys(registryCalls.wsHandlers).sort().join(',') === 'custom_com.telegramweb.ui_todos_changed,hello,post_deleted,post_edited,post_unread,posted,reaction_added,reaction_removed',
        'registered post, todo, and reconnect websocket events');

    const body = document.body.innerHTML;
    console.log('\n== rendered UI ==');
    ok(body.includes('tgw-root'), 'the Telegram-style overlay rendered');
    ok(body.includes('Alice Anderson'), 'DM contact from the Mattermost store is listed');
    ok(body.includes('Town Square'), 'group channel from the Mattermost store is listed');
    ok(body.includes('Work stuff'), 'a custom Mattermost category is shown as a folder');
    ok(!!document.querySelector('style') && document.head.innerHTML.includes('.tgw-root'), 'the CSS is bundled and injected');
    const cssText = Array.from(document.querySelectorAll('style')).map((tag) => tag.textContent).join('\n');
    ok(['.tgw-accent-violet', '.tgw-accent-green', '.tgw-compact'].every((sel) => cssText.includes(sel)),
        'every accent and compact mode have styling in the bundled CSS');
    ok(cssText.includes('.tgw-wallpaper-doodles') && cssText.includes('.tgw-wallpaper-checker'),
        'the chat wallpaper patterns are bundled in the CSS');
    ok(cssText.includes('--tgw-wallpaper-size: 440px') && cssText.includes('0 0, 27px 0, 0 0, 0 43px')
        && cssText.includes('repeating-linear-gradient(-45deg'),
        'the wallpapers are rebuilt to hide their tiling (big doodle tile, uneven grid, mixed stripe periods)');
    ok(cssText.includes('.tgw-chat:not(.tgw-search-panel) > .tgw-chat-header') && cssText.includes('backdrop-filter: blur('),
        'the chat header floats over the message list with a live backdrop blur');
    ok(cssText.includes('@font-face') && cssText.includes('Vazirmatn') && /public\/webapp\/fonts\/Vazirmatn-Variable\.[a-f0-9]+\.woff2/.test(cssText),
        'the text font uses a local cacheable asset');
    ok(/public\/webapp\/fonts\/Twemoji\.[a-f0-9]+\.woff2/.test(cssText) && !cssText.includes('data:font/woff2;base64'),
        'emoji artwork uses a local cacheable font without a CDN');
    ok(cssText.includes('.tgw-root textarea') && cssText.includes('user-select: text'),
        'text fields force user-select back on so Ctrl+A cannot select the page around them');
    ok(!cssText.includes('.tgw-root.tgw-glassy .tgw-chat {') && !cssText.includes('.tgw-theme-dark .tgw-chat,') && !cssText.includes('.tgw-theme-midnight .tgw-chat,'),
        'the chat pane stays opaque - only the theme colour and pattern sit behind messages');
    ok(cssText.includes('.tgw-spinner') && cssText.includes('tgw-spin'), 'the loading spinner is styled');
    ok(cssText.includes('body.tgw-root-active'), 'the host page is locked while the overlay is up');

    console.log('\n== websocket + REST against the built bundle ==');
    await tick(60);
    ok(calls.some((call) => call.includes('/channels/') && call.includes('/posts')), 'the bundle requested posts over REST');

    registryCalls.wsHandlers.posted({data: {post: {id: 'ws-1', create_at: Date.now(), update_at: Date.now(), edit_at: 0, delete_at: 0, user_id: state.entities.users.profiles['user-other'].id, channel_id: 'channel-dm', message: 'delivered over the websocket', type: '', props: {}, root_id: '', metadata: {}}}});
    await tick(60);
    ok(document.body.innerHTML.includes('delivered over the websocket'), 'a websocket post reaches the open chat');

    globalThis.__todoTasks = [{id:'bundle-todo',channel_id:'channel-dm',text:'Task from another user',done:false,revision:1,created_at:Date.now()}];
    registryCalls.wsHandlers['custom_com.telegramweb.ui_todos_changed']({data:{channel_id:'channel-dm'}});
    await tick(120);
    ok(document.querySelector('.tgw-todo-badge')?.getAttribute('aria-label') === '1 unfinished todos', 'channel-scoped todo events refresh sidebar counts in the production bundle');
    const beforeReconnect = calls.filter((call) => call.includes('/todos/counts')).length;
    registryCalls.wsHandlers.hello({});
    await tick(120);
    ok(calls.filter((call) => call.includes('/todos/counts')).length > beforeReconnect, 'reconnecting refreshes shared todo counts');

    console.log('\n== toggle ==');
    dom.window.dispatchEvent(new dom.window.Event('tgw:disable'));
    await tick(60);
    ok(!document.body.innerHTML.includes('tgw-root'), 'the "tgw:disable" event hides the UI');

    console.log('\n== teardown ==');
    registered.plugin.uninitialize();
    ok(Object.keys(registryCalls.wsHandlers).length === 0, 'uninitialize() unregisters the websocket handlers');

    root.unmount();
    report('BUNDLE TEST');
    process.exit(process.exitCode || 0);
})();
