const {dom, React, ReactDOM, container, store, state, ids, tick, ok, report} = require('./harness');
const {setStore} = require('../src/mm/store');
const {TgContext} = require('../src/ui/context');
const {SystemMessage} = require('../src/ui/SystemMessage');
const {Modals} = require('../src/ui/Modals');
const {api} = require('../src/mm/api');
setStore(store);
const root = ReactDOM.createRoot(container);
const wait = async (fn) => { for (let i = 0; i < 80 && !fn(); i++) await tick(25); return fn(); };
const click = (node) => node?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
let opened;
function Surface({post}) {
    const [ui, setUI] = React.useState({modal: null});
    const actions = {openModal: (modal, payload) => { opened = payload; setUI({modal, modalPayload: payload}); }, closeModal: () => setUI({modal: null}), openUserChat: () => { throw new Error('Profile clicks must not open DMs'); }};
    return React.createElement(TgContext.Provider, {value: {ui, actions}},
        React.createElement('div', {className: 'tgw-system-post'}, React.createElement(SystemMessage, {post})), React.createElement(Modals));
}
const render = async (post) => { root.render(React.createElement(Surface, {post, key: post.id})); await tick(60); };
(async () => {
    const message = 'alice added to the channel by me.';
    await render({id: 'add', type: 'system_add_to_channel', user_id: ids.ME, message,
        props: {addedUsername: 'alice', addedUserId: ids.OTHER, username: 'me', userId: ids.ME}});
    await wait(() => document.querySelectorAll('.tgw-system-user-link').length === 2);
    ok(document.querySelector('.tgw-system-post').textContent === message, 'invite message keeps the original wording and punctuation');
    const links = document.querySelectorAll('.tgw-system-user-link');
    ok(links.length === 2 && links[0].textContent === 'alice' && links[1].textContent === 'me', 'both the added user and inviter are profile buttons');
    click(links[0]);
    await wait(() => document.querySelector('[aria-label="User profile"]')?.textContent.includes('Alice Anderson'));
    ok(opened.userId === ids.OTHER && document.querySelector('[aria-label="User profile"]')?.textContent.includes('@alice'), 'added user opens their profile');
    click(document.querySelector('[title="Close"]'));
    await wait(() => !document.querySelector('[role="dialog"]'));
    click(document.querySelectorAll('.tgw-system-user-link')[1]);
    await wait(() => document.querySelector('[aria-label="User profile"]')?.textContent.includes('Mia Meyer'));
    ok(opened.userId === ids.ME && document.querySelector('[aria-label="User profile"]')?.textContent.includes('Mia Meyer'), 'inviter opens their own profile');
    click(document.querySelector('[title="Close"]'));
    const uncached = {id: 'uncached-user', username: 'new.person', first_name: 'New', last_name: 'Person'};
    let fetched;
    api.getUsersByIds = async (userIds) => { fetched = userIds; return [uncached]; };
    await render({id: 'uncached', type: 'system_add_to_channel', user_id: ids.ME,
        message: '@new.person added to the channel by me.', props: {addedUsername: 'new.person', addedUserId: uncached.id, username: 'me'}});
    click(document.querySelector('.tgw-system-user-link'));
    await wait(() => document.querySelector('[role="dialog"]')?.textContent.includes('New Person'));
    ok(fetched?.[0] === uncached.id && document.querySelector('[role="dialog"]')?.textContent.includes('@new.person'), 'uncached participants load by the metadata user ID');
    api.getUserByUsername = async (username) => { fetched = username; return uncached; };
    await render({id: 'username-only', type: 'system_add_to_channel', user_id: ids.ME,
        message: 'new.person added to the channel by me.', props: {addedUsername: 'new.person', username: 'me'}});
    click(document.querySelector('.tgw-system-user-link'));
    await wait(() => document.querySelector('[role="dialog"]')?.textContent.includes('New Person'));
    ok(fetched === 'new.person', 'older messages without participant IDs resolve by username');
    await render({id: 'boundaries', type: 'system_add_to_channel', message: 'theme me member me.other', props: {username: 'me', userId: ids.ME}});
    ok(document.querySelectorAll('.tgw-system-user-link').length === 1, 'participant matching does not link substrings or other usernames');
    await render({id: 'join', type: 'system_join_channel', message: 'alice joined the channel.', props: {username: 'alice'}});
    click(document.querySelector('.tgw-system-user-link'));
    await wait(() => document.querySelector('[role="dialog"]')?.textContent.includes('Alice Anderson'));
    ok(opened.userId === ids.OTHER, 'join messages also open profiles using cached username resolution');
    root.unmount();
    report('SYSTEM PROFILE TEST');
})().catch((error) => { console.error(error); root.unmount(); process.exitCode = 1; });
