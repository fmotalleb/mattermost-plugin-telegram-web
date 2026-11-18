const {dom, React, ReactDOM, container, store, state, tick, ok, report, ids, payloads, notifyStoreChange} = require('./harness');
const {setStore} = require('../src/mm/store');
const {initSettings, updateSettings, getSettings, DEFAULT_SETTINGS} = require('../src/mm/settings');
const {getUnreadChats, getAllChats, getTabUnreadCounts, getTabs, isUnreadChat} = require('../src/mm/selectors');
const {TelegramUI} = require('../src/ui/TelegramUI');
setStore(store);
initSettings();
updateSettings({mode: 'on'});
const root = ReactDOM.createRoot(container);
root.render(React.createElement(TelegramUI));
const wait = async (fn) => { for (let n = 0; n < 100 && !fn(); n++) await tick(25); return fn(); };
const click = (node) => node?.dispatchEvent(new dom.window.MouseEvent('click', {bubbles: true}));
const folder = (label) => Array.from(document.querySelectorAll('.tgw-folder')).find((node) => node.textContent.startsWith(label));
const count = () => folder('Unread')?.querySelector('.tgw-folder-badge')?.textContent;
const rows = () => Array.from(document.querySelectorAll('.tgw-sidebar-body .tgw-chat-row'));
const checkbox = () => Array.from(document.querySelectorAll('.tgw-field-check')).find((label) => label.textContent.includes('Include muted chats in unread messages'))?.querySelector('input');
(async () => {
    await wait(() => folder('Unread'));
    ok(DEFAULT_SETTINGS.includeMutedInUnread === false && getSettings().includeMutedInUnread === false, 'muted unread inclusion is disabled for default and existing settings');
    ok(!getUnreadChats(state).some((chat) => chat.id === ids.TOWN), 'default unread scope excludes muted channels even with mentions');
    ok(getAllChats(state).some((chat) => chat.id === ids.TOWN), 'muted chats remain in All');
    const headings = () => Array.from(document.querySelectorAll('.tgw-section-heading'));
    ok(headings().some((heading) => heading.textContent.includes('All messages') && heading.nextElementSibling?.textContent.includes('Town Square')), 'All keeps the muted chat outside the unread section');
    ok(headings().every((heading) => heading.querySelector('button')?.textContent === 'Mark all as read'), 'sections offer mark all as read when their chats include unread messages, including muted chats');
    const tabs = getTabs(state);
    const initialCounts = getTabUnreadCounts(state, tabs);
    ok(initialCounts.__unread === 2 && initialCounts.__all === 13, 'default unread badge excludes muted counts while All keeps its total');
    const mutedChat = getAllChats(state).find((chat) => chat.id === ids.TOWN);
    ok(!isUnreadChat({...mutedChat, type: 'D', unread: 0, mentions: 0, manuallyUnread: true}), 'default exclusion also covers muted manually-unread DMs');
    click(folder('Unread'));
    await wait(() => rows().length === 1);
    ok(rows().length === 1 && !rows().some((row) => row.textContent.includes('Town Square')), 'Unread tab hides muted chats by default');
    click(document.querySelector('.tgw-user-button'));
    await wait(() => document.querySelector('.tgw-menu'));
    click(Array.from(document.querySelectorAll('.tgw-menu-item')).find((button) => button.textContent.trim() === 'Settings'));
    await wait(() => checkbox());
    ok(checkbox() && !checkbox().checked, 'Chats settings exposes an unchecked muted-chats option');
    click(checkbox());
    await wait(() => count() === '13' && rows().some((row) => row.textContent.includes('Town Square')));
    ok(getSettings().includeMutedInUnread && count() === '13' && rows().length === 2, 'enabling the setting updates unread rows and badge immediately');
    ok(getTabUnreadCounts(state, tabs).__unread === 13, 'badge memoization invalidates on setting changes with unchanged store and tabs');
    ok(isUnreadChat({...mutedChat, type: 'G', unread: 0, mentions: 0, manuallyUnread: true}), 'enabling also includes muted manually-unread group chats');
    await wait(() => payloads.some((request) => request.path === '/users/me/preferences' && request.body?.some((preference) => preference.name === 'settings' && JSON.parse(preference.value).includeMutedInUnread === true)));
    ok(payloads.some((request) => request.path === '/users/me/preferences' && request.body?.some((preference) => preference.name === 'settings' && JSON.parse(preference.value).includeMutedInUnread === true)), 'setting persists as a Mattermost user preference');
    ok(JSON.parse(dom.window.localStorage.getItem('tgw.settings.com.telegramweb.ui')).includeMutedInUnread === true, 'setting is mirrored locally');
    click(checkbox());
    await wait(() => count() === '2' && rows().length === 1);
    ok(!getSettings().includeMutedInUnread && count() === '2' && rows().length === 1, 'disabling again immediately excludes muted chats and their unread counts');
    click(document.querySelector('[role="dialog"] [title="Close"]'));
    click(folder('All'));
    await wait(() => rows().length === 2);
    ok(rows().some((row) => row.textContent.includes('Town Square')), 'disabling never removes muted chats from All');
    // Public/private channel traffic without mentions follows the same inclusion switch as
    // muted chats, while personal conversations still qualify on any unread message.
    const originalMembers = state.entities.channels.myMembers;
    const unmutedTown = {...originalMembers[ids.TOWN], notify_props: {}, mention_count: 0};
    state.entities.channels.myMembers = {...originalMembers, [ids.TOWN]: unmutedTown};
    notifyStoreChange();
    click(folder('Unread'));
    await wait(() => rows().length === 1);
    ok(rows().length === 1 && count() === '2', 'unmuted channels without mentions are excluded from unread rows and counts by default');
    const unmutedChat = getAllChats(state).find((chat) => chat.id === ids.TOWN);
    ok(!unmutedChat.muted, 'unmentioned channel inclusion does not alter its actual mute state');
    ok(!isUnreadChat({...unmutedChat, type: 'P'}) && !isUnreadChat({...unmutedChat, type: 'O'}), 'public and private channels without mentions follow muted unread filtering');
    ok(isUnreadChat({...unmutedChat, type: 'D'}) && isUnreadChat({...unmutedChat, type: 'G'}), 'unmuted direct and group messages remain unread without mentions');
    state.entities.channels.myMembers = {...originalMembers, [ids.TOWN]: {...unmutedTown, mention_count: 1}};
    notifyStoreChange();
    await wait(() => rows().length === 2 && count() === '13');
    ok(rows().length === 2 && count() === '13', 'a mention makes an unmuted channel qualify immediately');
    state.entities.channels.myMembers = {...originalMembers, [ids.TOWN]: unmutedTown};
    notifyStoreChange();
    updateSettings({includeMutedInUnread: true});
    await wait(() => rows().length === 2 && count() === '13');
    ok(rows().length === 2 && count() === '13', 'enabling muted inclusion also includes non-tagging unmuted channels');
    updateSettings({includeMutedInUnread: false});
    click(folder('All'));
    await wait(() => document.querySelectorAll('.tgw-section-heading').length === 2);
    ok(headings().some((heading) => heading.textContent.includes('All messages') && heading.nextElementSibling?.textContent.includes('Town Square')), 'unmentioned channels remain in All outside its unread section');
    console.log('== favorite pinning setting ==');
    ok(DEFAULT_SETTINGS.pinFavoritesInAll === false && getSettings().pinFavoritesInAll === false, 'favorite pinning is disabled for default and existing settings');
    state.entities.channels.myMembers = Object.fromEntries(Object.entries(originalMembers).map(([id, member]) => [id, {
        ...member, msg_count: state.entities.channels.channels[id].total_msg_count, mention_count: 0,
    }]));
    const originalPreferences = state.entities.preferences.myPreferences;
    state.entities.preferences.myPreferences = {...originalPreferences,
        [`favorite_channel--${ids.TOWN}`]: {category: 'favorite_channel', name: ids.TOWN, user_id: ids.ME, value: 'true'},
    };
    notifyStoreChange();
    const titles = () => rows().map((row) => row.querySelector('.tgw-chat-row-title')?.textContent.trim());
    await wait(() => !headings().some((heading) => heading.textContent.includes('Unread messages')));
    ok(!headings().some((heading) => heading.querySelector('button')), 'mark all as read is hidden when every chat in the section is read');
    ok(titles()[0]?.includes('Alice') && titles()[1] === 'Town Square', 'disabled pinning keeps newer conversations before older favorites');
    click(document.querySelector('.tgw-user-button'));
    await wait(() => document.querySelector('.tgw-menu'));
    click(Array.from(document.querySelectorAll('.tgw-menu-item')).find((button) => button.textContent.trim() === 'Settings'));
    const pinCheckbox = () => Array.from(document.querySelectorAll('.tgw-field-check')).find((label) => label.textContent.includes('Pin favorites to the top of All messages'))?.querySelector('input');
    await wait(() => pinCheckbox());
    ok(pinCheckbox() && !pinCheckbox().checked, 'Chats settings exposes favorite pinning unchecked');
    click(pinCheckbox());
    await wait(() => titles()[0] === 'Town Square');
    ok(getSettings().pinFavoritesInAll && titles()[0] === 'Town Square' && titles()[1]?.includes('Alice'), 'enabling pinning moves an older favorite to the top of All messages immediately');
    await wait(() => payloads.some((request) => request.path === '/users/me/preferences' && request.body?.some((preference) => preference.name === 'settings' && JSON.parse(preference.value).pinFavoritesInAll === true)));
    ok(payloads.some((request) => request.path === '/users/me/preferences' && request.body?.some((preference) => preference.name === 'settings' && JSON.parse(preference.value).pinFavoritesInAll === true)), 'favorite pinning persists as a Mattermost user preference');
    ok(JSON.parse(dom.window.localStorage.getItem('tgw.settings.com.telegramweb.ui')).pinFavoritesInAll === true, 'favorite pinning is mirrored locally');
    state.entities.preferences.myPreferences = originalPreferences;
    notifyStoreChange();
    await wait(() => titles()[0]?.includes('Alice'));
    ok(titles()[0]?.includes('Alice'), 'removing a favorite immediately restores chronological order while pinning is enabled');
    state.entities.preferences.myPreferences = {...originalPreferences,
        [`favorite_channel--${ids.TOWN}`]: {category: 'favorite_channel', name: ids.TOWN, user_id: ids.ME, value: 'true'},
    };
    notifyStoreChange();
    await wait(() => titles()[0] === 'Town Square');
    click(pinCheckbox());
    await wait(() => titles()[0]?.includes('Alice'));
    ok(!getSettings().pinFavoritesInAll && titles()[0]?.includes('Alice'), 'disabling pinning restores chronological order immediately');

    click(document.querySelector('[role="dialog"] [title="Close"]'));
    const channels = state.entities.channels.channels;
    const readChannel = 'channel-read';
    state.entities.channels.channels = {...channels, [readChannel]: {
        ...channels[ids.TOWN], id: readChannel, name: 'read-channel', display_name: 'Read channel', last_post_at: 0, total_msg_count: 0,
    }};
    state.entities.channels.myMembers = {...state.entities.channels.myMembers, [ids.DM]: originalMembers[ids.DM], [readChannel]: {
        ...originalMembers[ids.TOWN], channel_id: readChannel, msg_count: 0, mention_count: 0, notify_props: {},
    }};
    notifyStoreChange();
    updateSettings({pinFavoritesInAll: true});

    const sectionNames = () => headings().map((heading) => heading.querySelector('.tgw-section-title').textContent).join(',');
    await wait(() => sectionNames() === 'Favorites,Unread messages,All messages');
    ok(sectionNames() === 'Favorites,Unread messages,All messages' && titles()[0] === 'Town Square' &&
        titles()[1]?.includes('Alice') && titles()[2] === 'Read channel',
        'the All list orders read favorites, unread chats and remaining chats');
    ok(!headings()[0]?.querySelector('button') && !!headings()[1]?.querySelector('button') && !headings()[2]?.querySelector('button'),
        'only sections with unread chats offer Mark all as read');

    const originalCategories = state.entities.channelCategories.byId;
    state.entities.channelCategories.byId = {...originalCategories, 'cat-fav': {
        ...originalCategories['cat-fav'], channel_ids: [ids.TOWN, ids.DM], sorting: 'manual',
    }};
    state.entities.preferences.myPreferences = {...state.entities.preferences.myPreferences,
        [`favorite_channel--${ids.DM}`]: {category: 'favorite_channel', name: ids.DM, user_id: ids.ME, value: 'true'},
    };
    notifyStoreChange();
    await wait(() => rows()[0]?.draggable && rows()[1]?.draggable);
    ok(titles()[0] === 'Town Square' && titles()[1]?.includes('Alice') && !rows()[2].draggable,
        'pinned favorites follow the Favorites category and only favorite rows can be dragged');
    rows()[0].dispatchEvent(new dom.window.Event('dragstart', {bubbles: true, cancelable: true}));
    await tick(40);
    rows()[1].dispatchEvent(new dom.window.Event('drop', {bubbles: true, cancelable: true}));
    await wait(() => titles()[0]?.includes('Alice'));
    const reordered = payloads.filter((request) => /\/channels\/categories$/.test(request.path)).pop()?.body?.[0];
    ok(reordered?.id === 'cat-fav' && reordered.channel_ids.join(',') === `${ids.DM},${ids.TOWN}` && titles()[1] === 'Town Square',
        'dragging pinned favorites persists and displays the shared category order');
    click(folder('Favorites'));
    await wait(() => titles()[0]?.includes('Alice'));
    ok(titles()[1] === 'Town Square', 'Favorites tab uses the same reordered list');
    click(folder('All'));
    state.entities.channelCategories.byId = originalCategories;
    state.entities.preferences.myPreferences = {...originalPreferences,
        [`favorite_channel--${ids.TOWN}`]: {category: 'favorite_channel', name: ids.TOWN, user_id: ids.ME, value: 'true'},
    };
    notifyStoreChange();
    await wait(() => titles()[0] === 'Town Square');

    state.entities.channels.myMembers = {...state.entities.channels.myMembers, [ids.TOWN]: {...unmutedTown, mention_count: 1}};
    notifyStoreChange();
    await wait(() => rows()[0]?.querySelector('.tgw-badge'));
    ok(rows().length === 3 && titles()[0] === 'Town Square' && !!rows()[0]?.querySelector('.tgw-badge'),
        'an unread favorite stays in Favorites once and keeps its unread badge');
    ok(!!headings()[0]?.querySelector('button'), 'Favorites offers Mark all as read when a pinned chat is unread');
    click(folder('Unread'));
    await wait(() => sectionNames() === 'Unread');
    ok(sectionNames() === 'Unread' && titles().includes('Town Square') && count() === '13',
        'the unread favorite still appears in the Unread tab and counts toward its badge');

    click(folder('All'));
    updateSettings({pinFavoritesInAll: false});
    await wait(() => sectionNames() === 'Unread messages,All messages');
    ok(sectionNames() === 'Unread messages,All messages' && titles()[0]?.includes('Alice') && titles()[1] === 'Town Square',
        'disabling pinning restores the two groups and puts the favorite back among unread chats');

    state.entities.channels.channels = channels;
    state.entities.preferences.myPreferences = originalPreferences;
    state.entities.channels.myMembers = originalMembers;
    root.unmount();
    report('UNREAD SETTINGS TEST');
})().catch((error) => { console.error(error); root.unmount(); process.exitCode = 1; });
