/*
 * Smoke test for the Telegram Web UI plugin.
 *
 * Runs the real plugin UI (the same modules that get bundled for Mattermost) inside jsdom against
 * a simulated Mattermost Redux store and REST API. It catches runtime errors in the render path,
 * in the selectors and in the click handlers without needing a Mattermost server.
 *
 *   npm run test:smoke
 *
 * The jsdom environment, the fake store and the fetch stub live in test/harness.js.
 */

const {
    dom, React, ReactDOM: ReactDOMClient, container, calls,
    store, state, posts, ids, tick, ok, fail, report,
} = require('./harness');

// --------------------------------------------------------------------------- mount
const {setStore} = require('../src/mm/store');
const {initSettings, updateSettings, getSettings} = require('../src/mm/settings');
const {receivePost} = require('../src/mm/posts');
const {addOptimistic} = require('../src/mm/posts');
const {TelegramUI} = require('../src/ui/TelegramUI');

setStore(store);
initSettings();
updateSettings({mode: 'on', theme: 'light'});

const root = ReactDOMClient.createRoot(container);
root.render(React.createElement(TelegramUI));

(async () => {
    await tick(80);

    const body = document.body.innerHTML;
    console.log('\n== render ==');
    ok(body.includes('tgw-root'), 'root overlay rendered');
    ok(body.includes('Alice Anderson'), 'DM chat row shows the peer name');
    ok(body.includes('Town Square'), 'public channel listed');
    ok(body.includes('Work stuff'), 'custom Mattermost category exposed as a folder');
    ok(body.includes('Mia Meyer'), 'user panel shows the current user');

    // Wait for the channel posts request of the initial chat.
    await tick(80);
    console.log('\n== messages ==');
    ok(document.body.innerHTML.includes('How are you'), 'loaded messages rendered');
    ok(document.body.innerHTML.includes('Deploy'), 'second message rendered');
    ok(document.body.innerHTML.includes('https://example.com/run'), 'links rendered');
    ok(document.querySelector('.tgw-messages').innerHTML.includes('😄') || document.body.innerHTML.includes(':smile:'), 'emoji shortcode rendered');
    ok(calls.some((call) => call.includes('/channels/channel-dm/posts')), 'messages were fetched through the REST API');
    ok(calls.some((call) => call.includes('/channels/channel-dm/view')), 'channel marked as read');
    ok(!!document.querySelector('.tgw-reaction'), 'reactions rendered');

    console.log('\n== interactions ==');
    const townRow = Array.from(document.querySelectorAll('.tgw-chat-row')).find((row) => row.textContent.includes('Town Square'));
    ok(!!townRow, 'town square row found');
    if (townRow) {
        townRow.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await tick(60);
        ok(document.querySelector('.tgw-chat-header-title')?.textContent === 'Town Square', 'clicking a chat opens it');
        ok(calls.some((call) => call.includes('/channels/channel-town/posts')), 'posts of the opened chat requested');
    }

    const textarea = document.querySelector('.tgw-composer textarea');
    ok(!!textarea, 'composer available');
    if (textarea) {
        const valueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set;
        valueSetter.call(textarea, 'hello from the smoke test');
        textarea.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
        await tick(30);
        const sendButton = document.querySelector('.tgw-send-button');
        sendButton.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
        await tick(60);
        ok(calls.some((call) => call === 'POST /posts'), 'composer sent a post through the API');
        ok(document.body.innerHTML.includes('hello from the smoke test'), 'optimistic message rendered');
    }

    console.log('\n== websocket ==');
    receivePost({...posts.p1, id: 'p-ws', create_at: Date.now(), channel_id: ids.TOWN, user_id: ids.OTHER, message: 'incoming over websocket', metadata: {}});
    await tick(60);
    ok(document.body.innerHTML.includes('incoming over websocket'), 'websocket post appears in the open chat');

    console.log('\n== search ==');
    const searchInput = document.querySelector('.tgw-search input');
    if (searchInput) {
        const valueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
        valueSetter.call(searchInput, 'Alice');
        searchInput.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
        await tick(60);
        ok(document.body.innerHTML.includes('Contacts'), 'global search renders contact results');
    } else {
        fail('search input missing');
    }

    console.log('\n== settings ==');
    ok(getSettings().mode === 'on', 'plugin settings loaded (server default applied)');

    updateSettings({accent: 'violet', compactMode: true, theme: 'dark'});
    await tick(60);
    const rootEl = document.querySelector('.tgw-root');
    ok(!!rootEl && rootEl.classList.contains('tgw-accent-violet'), 'accent setting is applied to the root element');
    ok(!!rootEl && rootEl.classList.contains('tgw-compact'), 'compact mode is applied to the root element');
    ok(!!rootEl && rootEl.classList.contains('tgw-theme-dark'), 'theme setting is applied to the root element');

    console.log('\n== api calls observed ==');
    calls.slice(0, 12).forEach((call) => console.log(`  ${call}`));

    await tick(30);
    root.unmount();
    report('SMOKE TEST');
    process.exit(process.exitCode || 0);
})().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
});
