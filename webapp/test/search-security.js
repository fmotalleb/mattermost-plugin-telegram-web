const {dom, React, ReactDOM, container, store, posts, tick, ok, report} = require('./harness');
const {setStore} = require('../src/mm/store');
const {initSettings, updateSettings} = require('../src/mm/settings');
const {TelegramUI} = require('../src/ui/TelegramUI');
setStore(store); initSettings(); updateSettings({mode:'on'});
const originalFetch = global.fetch;
let mode = 'pages';
const pages = [];
let historyReads = 0;
let aborted = false;
const response = (data, status = 200) => ({ok:status < 400,status,text:async () => JSON.stringify(data)});
global.fetch = (url, options = {}) => {
    if (url.includes('/api/v1/channel-search')) {
        const body = JSON.parse(options.body); pages.push(body.before);
        if (mode === 'limited') return Promise.resolve(response({message:'Please retry shortly'}, 429));
        if (mode === 'fallback') return Promise.resolve(response({}, 404));
        if (mode === 'pending') return new Promise((resolve, reject) => {
            options.signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(new Error('Aborted'), {name:'AbortError'})); });
        });
        const data = !body.before ? {order:[],posts:{},next_before:'cursor-one'}
            : body.before === 'cursor-one' ? {order:['p1'],posts:{p1:posts.p1},next_before:'cursor-two'}
                : {order:['p3'],posts:{p3:posts.p3},next_before:''};
        return Promise.resolve(response(data));
    }
    if (/\/channels\/[^/]+\/posts/.test(url)) historyReads++;
    return originalFetch(url, options);
};
const root = ReactDOM.createRoot(container);
const wait = async (fn) => { for (let i = 0; i < 120 && !fn(); i++) await tick(25); return fn(); };
const click = (node) => node?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles:true}));
const input = () => document.querySelector('[placeholder="Search in this chat"]');
const type = (text) => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input(), text);
    input().dispatchEvent(new dom.window.Event('input', {bubbles:true}));
};
(async () => {
    root.render(React.createElement(TelegramUI));
    const row = () => [...document.querySelectorAll('.tgw-sidebar .tgw-chat-row')].find((node) => node.textContent.includes('Alice'));
    await wait(row); click(row());
    await wait(() => document.querySelector('.tgw-chat-header [title="Search in chat"]'));
    click(document.querySelector('.tgw-chat-header [title="Search in chat"]'));
    await wait(input);
    if (!input()) throw new Error('search input did not open');
    type('match');
    await wait(() => document.querySelector('.tgw-inchat-search-count')?.textContent === '2 found');
    ok(pages.join(',') === ',cursor-one,cursor-two' && document.querySelectorAll('.tgw-inchat-search-results [role="option"]').length === 2, 'search follows continuation pages even when a page has no matches');
    await tick(100); const before = historyReads;
    mode = 'limited'; type('limited');
    await wait(() => document.querySelector('[role="alert"]')?.textContent.includes('Please retry shortly'));
    ok(historyReads === before && document.querySelector('.tgw-inchat-search-count')?.textContent === 'Search unavailable', 'rate limits are visible and never trigger an exhaustive history fallback');
    mode = 'pending'; type('pending');
    await wait(() => pages.length === 5);
    click(document.querySelector('[title="Close search"]'));
    await tick(60);
    ok(aborted && pages.length === 5, 'closing search aborts the active fetch and prevents more pages');
    mode = 'fallback';
    click(document.querySelector('.tgw-chat-header [title="Search in chat"]'));
    await wait(input); type('Deploy');
    await wait(() => !document.querySelector('.tgw-inchat-search-count')?.textContent.includes('Searching'));
    await wait(() => historyReads > before);
    ok(historyReads > before && !document.querySelector('.tgw-inchat-search-results [role="alert"]'), 'an absent plugin endpoint retains the public history fallback');
    root.unmount(); global.fetch = originalFetch; report('SEARCH SECURITY TEST');
})().catch((error) => { console.error(error); root.unmount(); global.fetch = originalFetch; process.exitCode = 1; });
