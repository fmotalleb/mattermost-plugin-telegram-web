const {dom, React, ReactDOM, container, store, state, ids, tick, ok, report} = require('./harness');
const {setStore} = require('../src/mm/store');
const {TgContext} = require('../src/ui/context');
const {SystemMessage} = require('../src/ui/SystemMessage');
const {MessageBody} = require('../src/ui/render');
const {Modals} = require('../src/ui/Modals');
const {api} = require('../src/mm/api');
setStore(store);
const root = ReactDOM.createRoot(container);
const wait = async (fn) => { for (let i = 0; i < 80 && !fn(); i++) await tick(25); return fn(); };
const click = (node) => node?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
let opened;
let activeUI;
const directChats = [];
const directChatButton = () => Array.from(document.querySelectorAll('[aria-label="User profile"] button')).find((button) => button.textContent === 'Open direct chat');
function Surface({post}) {
    const [ui, setUI] = React.useState({modal: null, quickChatId: post.quickChatId});
    activeUI = ui;
    const patchUI = (patch) => setUI((current) => ({...current, ...patch}));
    const actions = {setUI: patchUI, openModal: (modal, payload) => { opened = payload; patchUI({modal, modalPayload: payload}); }, closeModal: () => patchUI({modal: null}), openUserChat: (userId) => { directChats.push(userId); }};
    return React.createElement(TgContext.Provider, {value: {ui, actions}},
        React.createElement('div', {className: 'tgw-system-post'}, post.body
            ? React.createElement(MessageBody, {message: post.message}) : React.createElement(SystemMessage, {post})), React.createElement(Modals));
}
const render = async (post) => { root.render(React.createElement(Surface, {post, key: post.id})); await tick(60); };
(async () => {
    const message = 'alice added to the channel by me.';
    await render({id: 'add', type: 'system_add_to_channel', user_id: ids.ME, message,
        props: {addedUsername: 'alice', addedUserId: ids.OTHER, username: 'me', userId: ids.ME}});
    await wait(() => document.querySelectorAll('.tgw-system-user-link').length === 2);
    ok(document.querySelector('.tgw-system-post').textContent === 'Alice Anderson (alley) added to the channel by Mia Meyer.', 'invite message uses display names and keeps the surrounding wording and punctuation');
    const links = document.querySelectorAll('.tgw-system-user-link');
    ok(links.length === 2 && links[0].textContent === 'Alice Anderson (alley)' && links[1].textContent === 'Mia Meyer', 'both display names are profile buttons');
    click(links[0]);
    await wait(() => document.querySelector('[aria-label="User profile"]')?.textContent.includes('Alice Anderson'));
    ok(opened.userId === ids.OTHER && document.querySelector('[aria-label="User profile"]')?.textContent.includes('@alice'), 'added user opens their profile');
    ok(directChats.length === 0, 'opening a profile does not open a direct chat automatically');
    click(directChatButton());
    await wait(() => !document.querySelector('[role="dialog"]'));
    ok(directChats[0] === ids.OTHER && !document.querySelector('[role="dialog"]'), 'profile button opens the added user’s DM and closes the modal');
    click(document.querySelectorAll('.tgw-system-user-link')[1]);
    await wait(() => document.querySelector('[aria-label="User profile"]')?.textContent.includes('Mia Meyer'));
    ok(opened.userId === ids.ME && document.querySelector('[aria-label="User profile"]')?.textContent.includes('Mia Meyer'), 'inviter opens their own profile');
    click(directChatButton());
    await wait(() => !document.querySelector('[role="dialog"]'));
    ok(directChats[1] === ids.ME, 'inviter profile targets the inviter’s own user ID');
    const uncached = {id: 'uncached-user', username: 'new.person', first_name: 'New', last_name: 'Person'};
    let fetched;
    api.getUsersByIds = async (userIds) => { fetched = userIds; return [uncached]; };
    await render({id: 'uncached', type: 'system_add_to_channel', user_id: ids.ME,
        message: '@new.person added to the channel by me.', props: {addedUsername: 'new.person', addedUserId: uncached.id, username: 'me'}});
    ok(document.querySelector('.tgw-system-user-link')?.textContent === 'New Person', 'invite displays the uncached participant’s name before opening the profile');
    click(document.querySelector('.tgw-system-user-link'));
    await wait(() => document.querySelector('[role="dialog"]')?.textContent.includes('New Person'));
    ok(fetched?.[0] === uncached.id && document.querySelector('[role="dialog"]')?.textContent.includes('@new.person'), 'uncached participants load by the metadata user ID');
    click(directChatButton());
    await wait(() => !document.querySelector('[role="dialog"]'));
    ok(directChats[2] === uncached.id, 'uncached profile button uses the resolved user ID');
    api.getUserByUsername = async (username) => { fetched = username; return uncached; };
    await render({id: 'username-only', type: 'system_add_to_channel', user_id: ids.ME,
        message: 'new.person added to the channel by me.', props: {addedUsername: 'new.person', username: 'me'}});
    ok(fetched === 'new.person' && document.querySelector('.tgw-system-user-link')?.textContent === 'New Person', 'older messages without participant IDs resolve the display name by username');
    click(document.querySelector('.tgw-system-user-link'));
    await wait(() => document.querySelector('[role="dialog"]')?.textContent.includes('New Person'));
    ok(opened.userId === uncached.id, 'the legacy invite’s display name opens the resolved profile');
    click(directChatButton());
    await wait(() => !document.querySelector('[role="dialog"]'));
    ok(directChats[3] === uncached.id, 'username-only profile button opens the resolved user’s DM');
    await render({id: 'boundaries', type: 'system_add_to_channel', message: 'theme me member me.other', props: {username: 'me', userId: ids.ME}});
    ok(document.querySelectorAll('.tgw-system-user-link').length === 1, 'participant matching does not link substrings or other usernames');
    await render({id: 'join', type: 'system_join_channel', message: 'alice joined the channel.', props: {username: 'alice'}});
    ok(document.querySelector('.tgw-system-post').textContent === 'Alice Anderson (alley) joined the channel.', 'join messages use the cached display name');
    click(document.querySelector('.tgw-system-user-link'));
    await wait(() => document.querySelector('[role="dialog"]')?.textContent.includes('Alice Anderson'));
    ok(opened.userId === ids.OTHER, 'join messages also open profiles using cached username resolution');
    click(directChatButton());
    await wait(() => !document.querySelector('[role="dialog"]'));
    ok(directChats[4] === ids.OTHER, 'joined-user profile opens that user’s direct chat');
    await render({id: 'quick-join', type: 'system_join_channel', message: 'alice joined the channel.', props: {username: 'alice'}, quickChatId: 'preview-channel'});
    click(document.querySelector('.tgw-system-user-link'));
    await wait(() => directChatButton());
    ok(activeUI.quickChatId === 'preview-channel', 'opening the profile preserves an existing quick chat');
    click(directChatButton());
    await wait(() => !document.querySelector('[role="dialog"]'));
    ok(!activeUI.quickChatId && directChats[5] === ids.OTHER, 'opening a DM dismisses the quick preview so the destination chat is visible');
    const departed = {id: 'departed-user', username: 'dornicaseif', first_name: 'Morteza', last_name: 'Seif'};
    api.getUsersByIds = async (userIds) => userIds.includes(departed.id) ? [departed] : [];
    await render({id: 'left', type: 'system_leave_channel', user_id: departed.id,
        message: '@dornicaseif left the channel.', props: {username: departed.username}});
    ok(document.querySelector('.tgw-system-post').textContent === 'Morteza Seif left the channel.', 'leave messages resolve the display name using the post author ID');
    click(document.querySelector('.tgw-system-user-link'));
    await wait(() => document.querySelector('[role="dialog"]')?.textContent.includes('Morteza Seif'));
    ok(opened.userId === departed.id, 'the display name on a leave message opens the departed user’s profile');
    click(directChatButton());
    await wait(() => !document.querySelector('[role="dialog"]'));
    await render({id: 'removed', type: 'system_remove_from_channel', user_id: ids.ME,
        message: 'departed-user was removed from the channel.', props: {removedUserId: departed.id}});
    ok(document.querySelector('.tgw-system-post').textContent === 'Morteza Seif was removed from the channel.', 'a removal message identifies the removed user when its text contains a raw ID');
    api.getUsersByIds = async () => { throw new Error('Profile unavailable'); };
    await render({id: 'unavailable', type: 'system_leave_channel', user_id: 'unavailable-user',
        message: '@former.member left the channel.', props: {username: 'former.member'}});
    ok(document.querySelector('.tgw-system-post').textContent === '@former.member left the channel.', 'the original handle is readable if the profile is unavailable');
    for (const host of [false, true]) {
        let hostClicks = 0;
        if (host) window.PostUtils = {
            formatText: (value) => value,
            messageHtmlToComponent: () => React.createElement('span', null,
                React.createElement('span', {className: 'mention', 'data-mention': 'alice', onClick: () => hostClicks++}, '@alice'),
                React.createElement('span', {className: 'mention', 'data-mention': 'channel'}, '@channel'),
                React.createElement('code', null, React.createElement('span', {className: 'mention', 'data-mention': 'me'}, '@me'))),
        };
        else delete window.PostUtils;
        await render({id: `mention-${host}`, body: true, message: 'Hello @alice. @channel `@me` bob@example.com'});
        const mention = document.querySelector('[data-mention="alice"]');
        ok(mention?.getAttribute('role') === 'button' && mention.tabIndex === 0, `${host ? 'host' : 'fallback'} user mention is keyboard accessible`);
        click(mention);
        await wait(() => document.querySelector('[aria-label="User profile"]')?.textContent.includes('Alice Anderson'));
        ok(opened.username === 'alice' && document.querySelector('[aria-label="User profile"]')?.textContent.includes('@alice'), 'mention opens the same profile modal as invited users');
        click(directChatButton());
        await wait(() => !document.querySelector('[role="dialog"]'));
        ok(directChats[directChats.length - 1] === ids.OTHER, 'mentioned user profile opens the correct direct chat');
        for (const key of ['Enter', ' ']) {
            mention.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key, bubbles: true, cancelable: true}));
            await wait(() => document.querySelector('[aria-label="User profile"]'));
            ok(!!document.querySelector('[aria-label="User profile"]'), `mention opens with ${key === ' ' ? 'Space' : key}`);
            click(directChatButton());
            await wait(() => !document.querySelector('[role="dialog"]'));
        }
        click(document.querySelector('[data-mention="channel"]'));
        click(document.querySelector('code'));
        await tick(30);
        ok(!document.querySelector('[role="dialog"]') && !document.querySelector('code [role="button"]'), 'broadcast mentions and code do not open profiles');
        ok(!document.querySelector('[data-mention="example.com"]'), 'email addresses do not become profile links');
        ok(hostClicks === 0, 'mention click stays in the plugin profile overlay');
    }
    for (const host of [false, true]) {
        if (host) window.PostUtils = {
            formatText: (value) => value,
            messageHtmlToComponent: () => React.createElement('span', null,
                'Ping @all, @ALL! @allen bob@all.example ',
                React.createElement('code', null, '@all'),
                React.createElement('a', {href:'https://example.com/@all'}, '@all'),
                React.createElement('span', {className:'mention', 'data-mention':'all'}, '@all')),
        };
        else delete window.PostUtils;
        await render({id:`all-mention-${host}`,body:true,message:'Ping @all, @ALL! @allen bob@all.example `@all` [@all](https://example.com/@all)'});
        const pills = document.querySelectorAll('.tgw-mention-all');
        ok(pills.length === (host ? 3 : 2), `${host ? 'host' : 'fallback'} renderer styles standalone @all mentions as pills`);
        ok(!document.querySelector('code .tgw-mention-all, a .tgw-mention-all, [data-mention="allen"].tgw-mention-all'), '@all styling leaves code, links and longer usernames untouched');
        ok(!Array.from(pills).some((node)=>node.getAttribute('role')==='button'), '@all pills do not become user-profile buttons');
    }
    delete window.PostUtils;
    root.unmount();
    report('SYSTEM PROFILE TEST');
})().catch((error) => { console.error(error); root.unmount(); process.exitCode = 1; });
