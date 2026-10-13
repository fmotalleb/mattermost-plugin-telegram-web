/*
 * Shared test harness: a jsdom environment plus a fake Mattermost Redux store and REST API that
 * the plugin webapp modules run against. Used by test/smoke.js (runs src/ directly) and by
 * test/bundle.js (runs the production bundle from webapp/dist).
 */
/*
 * Smoke test harness for the Telegram Web UI plugin.
 *
 * Runs the real plugin UI (the same modules that get bundled for Mattermost) inside jsdom against
 * a simulated Mattermost Redux store and REST API. It catches runtime errors in the render path,
 * in the selectors and in the click handlers without needing a Mattermost server.
 *
 *   npm run test:smoke
 */

const path = require('path');
const {JSDOM} = require('jsdom');

// --------------------------------------------------------------------------- jsdom environment
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'https://mattermost.example.com/',
    pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.HTMLElement = dom.window.HTMLElement;
global.Element = dom.window.Element;
global.Node = dom.window.Node;
global.Event = dom.window.Event;
global.MouseEvent = dom.window.MouseEvent;
global.KeyboardEvent = dom.window.KeyboardEvent;
global.CustomEvent = dom.window.CustomEvent;
global.getComputedStyle = dom.window.getComputedStyle;
global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
dom.window.requestAnimationFrame = global.requestAnimationFrame;
dom.window.cancelAnimationFrame = global.cancelAnimationFrame;
global.IS_REACT_ACT_ENVIRONMENT = true;
window.basename = '';

// --------------------------------------------------------------------------- babel register
require('@babel/register')({
    extensions: ['.js', '.jsx', '.ts', '.tsx'],
    only: [path.join(__dirname, '..', 'src')],
    presets: [
        ['@babel/preset-env', {targets: {node: 'current'}, modules: 'commonjs'}],
        ['@babel/preset-react', {runtime: 'classic'}],
        '@babel/preset-typescript',
    ],
    cache: false,
});

const React = require('react');
const ReactDOMClient = require('react-dom/client');

// --------------------------------------------------------------------------- fetch stub
const ME = 'user-me';
const OTHER = 'user-other';
const TEAM = 'team-1';
const DM = 'channel-dm';
const TOWN = 'channel-town';

const users = {
    [ME]: {id: ME, username: 'me', first_name: 'Mia', last_name: 'Meyer', delete_at: 0},
    [OTHER]: {id: OTHER, username: 'alice', first_name: 'Alice', last_name: 'Anderson', delete_at: 0, last_picture_update: 42},
};

const channels = {
    [DM]: {id: DM, type: 'D', name: [ME, OTHER].sort().join('__'), display_name: '', team_id: '', last_post_at: 1_700_000_500_000, create_at: 1_600_000_000_000, delete_at: 0, total_msg_count: 4},
    [TOWN]: {id: TOWN, type: 'O', name: 'town-square', display_name: 'Town Square', purpose: 'Everyone joins this channel', header: '', team_id: TEAM, last_post_at: 1_700_000_400_000, create_at: 1_600_000_000_000, delete_at: 0, total_msg_count: 12},
};

const posts = {
    p1: {
        id: 'p1', create_at: 1_700_000_100_000, update_at: 1_700_000_100_000, edit_at: 0, delete_at: 0, user_id: OTHER, channel_id: DM, message: 'Hey! How are you?', type: '', props: {}, root_id: '', is_pinned: false,
        metadata: {
            files: [
                {id: 'file-1', name: 'photo-one.png', mime_type: 'image/png', extension: 'png', size: 2048},
                {id: 'file-2', name: 'photo-two.jpg', mime_type: 'image/jpeg', extension: 'jpg', size: 3072},
            ],
        },
    },
    p2: {id: 'p2', create_at: 1_700_000_200_000, update_at: 1_700_000_200_000, edit_at: 0, delete_at: 0, user_id: ME, channel_id: DM, message: 'Doing great, thanks :smile:', type: '', props: {}, root_id: '', is_pinned: false, metadata: {}},
    p3: {id: 'p3', create_at: 1_700_000_500_000, update_at: 1_700_000_500_000, edit_at: 0, delete_at: 0, user_id: OTHER, channel_id: DM, message: '**Deploy** is done, see https://example.com/run', type: '', props: {}, root_id: '', is_pinned: false, metadata: {reactions: [{user_id: OTHER, post_id: 'p3', emoji_name: 'tada', create_at: 1_700_000_600_000}]}},
};

const calls = [];
// Request bodies, so tests can assert what was actually sent (e.g. root_id on a reply).
const payloads = [];
global.fetch = async (url, options = {}) => {
    const parsed = new URL(url, 'https://mattermost.example.com');
    const p = parsed.pathname.replace('/api/v4', '');
    calls.push(`${options.method || 'GET'} ${p}`);
    const json = (data, status = 200) => ({
        ok: status < 400,
        status,
        statusText: 'OK',
        text: async () => JSON.stringify(data),
    });
    const post = options.body ? JSON.parse(options.body) : null;
    payloads.push({method: options.method || 'GET', path: p, body: post});

    if (p === '/users/me') {
        return json(users[ME]);
    }
    if (p === '/users/me/preferences') {
        return json([]);
    }
    if (p === `/channels/${DM}/posts`) {
        return json({order: ['p3', 'p2', 'p1'], posts: {p1: posts.p1, p2: posts.p2, p3: posts.p3}});
    }
    if (p === `/channels/${TOWN}/posts`) {
        return json({order: [], posts: {}});
    }
    if (p.startsWith('/channels/') && p.endsWith('/view')) {
        return json({status: 'OK'});
    }
    if (p === '/users/me/typing') {
        return json({status: 'OK'});
    }
    if (p.startsWith('/posts/') && p.endsWith('/thread')) {
        const rootId = p.split('/')[2];
        const threadPosts = {};
        const order = [];
        Object.values(posts).forEach((post) => {
            if (post.id === rootId || post.root_id === rootId) {
                threadPosts[post.id] = post;
                order.push(post.id);
            }
        });
        return json({order, posts: threadPosts});
    }
    if (p.startsWith('/posts/') && !p.endsWith('/thread') && p.split('/').length === 3) {
        const post = posts[p.split('/')[2]];
        if (post) {
            return json(post);
        }
    }
    if (p === '/posts') {
        return json({...posts.p2, id: 'p-new', root_id: (post && post.root_id) || '', message: post.message, pending_post_id: post.pending_post_id});
    }
    if (p === '/reactions') {
        return json({user_id: post.user_id, post_id: post.post_id, emoji_name: post.emoji_name, create_at: Date.now()});
    }
    if (p.startsWith('/users/') && p.endsWith('/image')) {
        return {ok: false, status: 404, statusText: 'Not Found', text: async () => ''};
    }
    if (p === '/channels/direct') {
        return json(channels[DM]);
    }
    if (p.startsWith('/channels/')) {
        const id = p.split('/')[2];
        if (channels[id]) {
            return json(channels[id]);
        }
    }
    return json({status: 'OK'});
};

// --------------------------------------------------------------------------- fake redux store
const state = {
    entities: {
        general: {
            config: {
                SiteURL: 'https://mattermost.example.com',
                DefaultLocale: 'en',
                PluginSettings: {Plugins: {'com.telegramweb.ui': {DefaultMode: true, DefaultTheme: 'light', DefaultAccent: 'blue'}}},
            },
        },
        users: {
            currentUserId: ME,
            profiles: users,
            profilesInTeam: {[TEAM]: new Set([ME, OTHER])},
            profilesInChannel: {},
            statuses: {[ME]: 'online', [OTHER]: 'away'},
        },
        teams: {currentTeamId: TEAM, teams: {[TEAM]: {id: TEAM, name: 'demo', display_name: 'Demo Team'}}, myMembers: {[TEAM]: {}}},
        channels: {
            currentChannelId: DM,
            channels,
            channelsInTeam: {[TEAM]: new Set([TOWN])},
            myMembers: {
                [DM]: {channel_id: DM, user_id: ME, last_viewed_at: 1_700_000_150_000, msg_count: 2, mention_count: 0, notify_props: {}},
                [TOWN]: {channel_id: TOWN, user_id: ME, last_viewed_at: 1_700_000_000_000, msg_count: 1, mention_count: 1, notify_props: {desktop: 'none'}},
            },
            membersInChannel: {
                [DM]: {[ME]: {channel_id: DM, user_id: ME}, [OTHER]: {channel_id: DM, user_id: OTHER}},
                [TOWN]: {[ME]: {channel_id: TOWN, user_id: ME}, [OTHER]: {channel_id: TOWN, user_id: OTHER}},
            },
            stats: {[DM]: {member_count: 2}, [TOWN]: {member_count: 2}},
            manuallyUnread: {},
        },
        channelCategories: {
            byId: {
                'cat-fav': {id: 'cat-fav', user_id: ME, team_id: TEAM, type: 'favorites', display_name: 'Favorites', sorting: 'manual', channel_ids: [], muted: false, collapsed: false},
                'cat-ch': {id: 'cat-ch', user_id: ME, team_id: TEAM, type: 'channels', display_name: 'Channels', sorting: 'alpha', channel_ids: [TOWN], muted: false, collapsed: false},
                'cat-dm': {id: 'cat-dm', user_id: ME, team_id: TEAM, type: 'direct_messages', display_name: 'Direct Messages', sorting: 'recent', channel_ids: [DM], muted: false, collapsed: false},
                'cat-work': {id: 'cat-work', user_id: ME, team_id: TEAM, type: 'custom', display_name: 'Work stuff', sorting: 'manual', channel_ids: [TOWN], muted: false, collapsed: false},
            },
            orderByTeam: {[TEAM]: ['cat-fav', 'cat-ch', 'cat-dm', 'cat-work']},
        },
        posts: {posts: {}, postsInChannel: {}, postsInThread: {}, reactions: {}},
        preferences: {myPreferences: {'theme--': {category: 'theme', name: '', user_id: ME, value: '{}'}}},
        emojis: {customEmoji: {party_parrot: {id: 'emoji-1', name: 'party_parrot', creator_id: ME, create_at: 0, update_at: 0, delete_at: 0}}},
        typing: {},
        files: {files: {}},
    },
    views: {},
};

const listeners = new Set();
const store = {
    getState: () => state,
    dispatch: () => undefined,
    subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
};


// --------------------------------------------------------------------------- assertions + helpers
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
    // eslint-disable-next-line no-console
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
}

function ok(condition, message) {
    if (condition) {
        // eslint-disable-next-line no-console
        console.log(`  ok - ${message}`);
    } else {
        fail(message);
    }
}

function report(title) {
    // eslint-disable-next-line no-console
    console.log(process.exitCode ? `\n${title} FAILED` : `\n${title} PASSED`);
}

// A DOM node the caller can mount into.
const container = document.createElement('div');
document.body.appendChild(container);

module.exports = {
    dom,
    React,
    ReactDOM: require('react-dom/client'),
    ReactDOMLegacy: require('react-dom'),
    container,
    calls,
    payloads,
    users,
    channels,
    categories: state.entities.channelCategories.byId,
    posts,
    state,
    store,
    ids: {ME, OTHER, TEAM, DM, TOWN},
    notifyStoreChange: () => listeners.forEach((listener) => listener()),
    tick,
    ok,
    fail,
    report,
};
