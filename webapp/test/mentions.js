const {dom, React, ReactDOM, container, store, state, tick, ok, report, ids, users, payloads} = require('./harness');
const {setStore} = require('../src/mm/store');
const {initSettings, updateSettings} = require('../src/mm/settings');
const {getComposerDraft} = require('../src/mm/drafts');
const {TelegramUI} = require('../src/ui/TelegramUI');

const originalFetch = global.fetch;
const requests = [];
const json = (data, status = 200) => ({ok: status < 400, status, text: async () => JSON.stringify(data)});
const alice = users[ids.OTHER];
const nina = users[ids.THIRD];
let failSearch = true;
let releaseOldSearch;

global.fetch = async (url, options) => {
    const parsed = new URL(url, 'https://mattermost.example.com');
    if (parsed.pathname !== '/api/v4/users/autocomplete') return originalFetch(url, options);

    const query = parsed.searchParams.get('name');
    requests.push({query, channel: parsed.searchParams.get('in_channel'), team: parsed.searchParams.get('in_team')});
    if (query === 'slow') return new Promise((resolve) => { releaseOldSearch = () => resolve(json({users: [alice]})); });
    if (query === 'ni' && failSearch) {
        failSearch = false;
        return json({message: 'Search failed'}, 500);
    }
    if (query === 'ni') return json({users: [nina]});
    if (query === 'missing') return json({users: []});
    return json({
        users: [alice, nina, nina, {...nina, id: 'inactive', username: 'inactive', delete_at: 1}],
        out_of_channel: [{...nina, id: 'outsider', username: 'outsider'}],
    });
};

const waitFor = async (predicate) => {
    for (let attempt = 0; attempt < 100; attempt++) {
        const value = predicate();
        if (value) return value;
        await tick(25);
    }
    throw new Error(`Timed out waiting for ${predicate}`);
};
const click = (node) => node.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
const key = (area, value, modifiers = {}) => area.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: value, bubbles: true, cancelable: true, ...modifiers,
}));
const type = (area, text, caret = text.length) => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(area, text);
    area.setSelectionRange(caret, caret);
    area.dispatchEvent(new dom.window.Event('input', {bubbles: true}));
};
const picker = () => document.querySelector('.tgw-mention-picker');
const options = () => Array.from(picker()?.querySelectorAll('[role="option"]') || []);
const row = (name) => Array.from(document.querySelectorAll('.tgw-chat-row-title')).find((title) => title.textContent.includes(name));

setStore(store);
initSettings();
updateSettings({mode: 'on'});
const root = ReactDOM.createRoot(container);
root.render(React.createElement(TelegramUI));

(async () => {
    await waitFor(() => document.querySelector('.tgw-chat-header-title'));
    click(await waitFor(() => row('Town Square')));
    await waitFor(() => document.querySelector('.tgw-chat-header-title')?.textContent.includes('Town Square'));
    const area = await waitFor(() => document.querySelector('.tgw-composer textarea'));
    area.focus();

    type(area, 'Hello @');
    await waitFor(() => options().length === 2);
    const cachedMembers = state.entities.users.profilesInChannel[ids.TOWN];
    ok(!cachedMembers?.has(nina.id) && options()[1].textContent.includes('@nina'), 'members missing from Redux still appear');
    ok(requests.some(({query, channel, team}) => query === '' && channel === ids.TOWN && team === ids.TEAM),
        'a bare @ searches the current channel');
    ok(options().every((option) => !/inactive|outsider/.test(option.textContent)), 'duplicates, inactive users and out-of-channel users are excluded');
    key(area, 'ArrowDown');
    await waitFor(() => options()[1]?.getAttribute('aria-selected') === 'true');
    ok(area.getAttribute('aria-activedescendant') === options()[1].id, 'keyboard highlight is exposed to assistive technology');
    key(area, 'Tab');
    await waitFor(() => area.value === 'Hello @nina ' && !picker());
    ok(getComposerDraft(ids.TOWN)?.message === 'Hello @nina ', 'keyboard selection inserts the username into the draft');

    type(area, 'Hi @alley, again', 6);
    await waitFor(() => options().length === 2);
    click(options()[0].querySelector('img') || options()[0]);
    await waitFor(() => area.value === 'Hi @alice, again' && !picker());
    await waitFor(() => area.selectionStart === 'Hi @alice'.length);
    ok(document.activeElement === area && !document.querySelector('[aria-label="User profile"]'),
        'clicking a result replaces the whole token, preserves punctuation, and returns focus');

    for (const literal of ['mail alice@example', 'Use `@alice', '~~~\n@alice']) {
        type(area, literal);
        await tick(30);
        ok(!picker(), `literal text leaves the picker closed (${literal.replace('\n', ' ')})`);
    }

    type(area, 'Hello @ni');
    click(await waitFor(() => picker()?.querySelector('.tgw-mention-retry')));
    await waitFor(() => options()[0]?.textContent.includes('@nina'));
    ok(requests.filter(({query}) => query === 'ni').length === 2, 'retry sends the failed query again');
    key(area, 'Escape');
    await waitFor(() => !picker());
    ok(area.value === 'Hello @ni', 'Escape closes suggestions and preserves the draft');

    type(area, '@slow');
    await waitFor(() => releaseOldSearch);
    type(area, '@ni');
    await waitFor(() => options()[0]?.textContent.includes('@nina'));
    releaseOldSearch();
    await tick(40);
    ok(options().length === 1 && options()[0].textContent.includes('@nina'), 'a late response for an older query is ignored');

    type(area, 'Hello @missing');
    await waitFor(() => picker()?.textContent.includes('No matching'));
    key(area, 'Enter');
    await waitFor(() => payloads.some(({path, body}) => path === '/posts' && body.message === 'Hello @missing'));
    ok(!picker(), 'an unmatched mention allows normal submission');

    type(area, '@slow');
    await waitFor(() => requests.filter(({query}) => query === 'slow').length === 2);
    click(row('Alice Anderson'));
    await waitFor(() => document.querySelector('.tgw-chat-header-title')?.textContent.includes('Alice Anderson'));
    releaseOldSearch();
    await tick(50);
    ok(!picker(), 'changing channels closes suggestions and ignores the previous channel response');

    root.unmount();
    report('COMPOSER MENTIONS TEST');
})().catch((error) => {
    console.error(error);
    root.unmount();
    process.exitCode = 1;
});
