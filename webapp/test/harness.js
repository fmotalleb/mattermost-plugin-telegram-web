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
// Node ≥21 ships its own read-only global `navigator`; a plain assignment is ignored, so replace
// the property itself or every `navigator.*` check in the plugin would miss the jsdom one.
Object.defineProperty(global, 'navigator', {value: dom.window.navigator, configurable: true, writable: true});
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
// The tests drive renders through tick()/waitFor() instead of act(), so the environment is
// explicitly *not* an act() environment: with React 19 that keeps every update from warning
// "not wrapped in act(...)".
global.IS_REACT_ACT_ENVIRONMENT = false;
window.basename = '';
// WebappUtils with a recording history so the plugin's route syncing is observable in tests.
// openUserSettings stands in for the host's "open my Account Settings" export (recent Mattermost
// exposes it); recording the dialogProps lets the tests assert the profile popup ask.
window.__historyPushes = [];
window.__userSettingsOpens = [];
window.WebappUtils = {
    browserHistory: {
        push: (path) => {
            window.__historyPushes.push(path);
        },
    },
    openUserSettings: (dialogProps) => {
        window.__userSettingsOpens.push(dialogProps);
    },
};

// --------------------------------------------------------------------------- media mocks
// jsdom has no media stack; the voice recorder (getUserMedia + MediaRecorder + AudioContext)
// runs against these fakes so the record → upload → send path is covered end to end.
global.Blob = dom.window.Blob;
global.File = dom.window.File;
dom.window.navigator.mediaDevices = {
    getUserMedia: async () => ({getTracks: () => [{stop() {}}], getAudioTracks: () => [{stop() {}}]}),
};
dom.window.MediaRecorder = class MediaRecorder {
    constructor(stream, options = {}) {
        this.stream = stream;
        this.mimeType = (options && options.mimeType) || 'audio/webm';
        this.state = 'inactive';
        this.ondataavailable = null;
        this.onstop = null;
        this.onerror = null;
    }

    start() {
        this.state = 'recording';
    }

    stop() {
        if (this.state === 'inactive') {
            return;
        }
        this.state = 'inactive';
        const data = new dom.window.Blob(['voice-bytes'], {type: this.mimeType});
        if (this.ondataavailable) {
            this.ondataavailable({data});
        }
        if (this.onstop) {
            this.onstop();
        }
    }
};
dom.window.MediaRecorder.isTypeSupported = () => true;
global.MediaRecorder = dom.window.MediaRecorder;
dom.window.AudioContext = class AudioContext {
    createMediaStreamSource() {
        return {connect() {}};
    }

    createAnalyser() {
        return {
            fftSize: 256,
            frequencyBinCount: 128,
            connect() {},
            getByteTimeDomainData(array) {
                for (let index = 0; index < array.length; index++) {
                    array[index] = 128 + Math.round(60 * Math.sin(index / 4));
                }
            },
        };
    }

    close() {
        return Promise.resolve();
    }
};
global.AudioContext = dom.window.AudioContext;

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
const THIRD = 'user-third';
const TEAM = 'team-1';
const DM = 'channel-dm';
const TOWN = 'channel-town';
const NEW_DM = 'channel-new-dm';

const users = {
    [ME]: {id: ME, username: 'me', first_name: 'Mia', last_name: 'Meyer', delete_at: 0},
    [OTHER]: {id: OTHER, username: 'alice', first_name: 'Alice', last_name: 'Anderson', nickname: 'alley', delete_at: 0, last_picture_update: 42},
    // Present in the REST member list of Town Square but not in the (sparse) Redux copy.
    [THIRD]: {id: THIRD, username: 'nina', first_name: 'Nina', last_name: 'Novak', delete_at: 0},
};

const channels = {
    [DM]: {id: DM, type: 'D', name: [ME, OTHER].sort().join('__'), display_name: '', team_id: '', last_post_at: 1_700_000_500_000, create_at: 1_600_000_000_000, delete_at: 0, total_msg_count: 4},
    [TOWN]: {id: TOWN, type: 'O', name: 'town-square', display_name: 'Town Square', purpose: 'Everyone joins this channel', header: '', team_id: TEAM, last_post_at: 1_700_000_400_000, create_at: 1_600_000_000_000, delete_at: 0, total_msg_count: 12},
};
const newDirectChannel = {id: NEW_DM, type: 'D', name: [ME, THIRD].sort().join('__'), display_name: '', team_id: '', last_post_at: 0, create_at: Date.now(), delete_at: 0, total_msg_count: 0};

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
    p4: {
        id: 'p4', create_at: 1_700_000_700_000, update_at: 1_700_000_700_000, edit_at: 0, delete_at: 0, user_id: OTHER, channel_id: DM, message: '', type: '', root_id: '', is_pinned: false,
        props: {voice: {fileId: 'file-voice', durationMs: 7000, levels: [0.2, 0.55, 0.9, 0.4, 0.75, 1, 0.6, 0.3, 0.45, 0.8, 0.35, 0.65]}},
        metadata: {
            files: [
                {id: 'file-voice', name: 'voice-message-2023-11-15.webm', mime_type: 'video/webm', extension: 'webm', size: 18432, user_id: OTHER, create_at: 1_700_000_700_000, update_at: 1_700_000_700_000, delete_at: 0},
            ],
        },
    },
    // Older than the first page the chat loads (/channels/.../posts returns p4..p1 only), so it
    // exists solely through search: clicking the hit must fetch it to land the chat on it.
    'p-old': {
        id: 'p-old', create_at: 1_699_999_000_000, update_at: 1_699_999_000_000, edit_at: 0, delete_at: 0, user_id: OTHER, channel_id: DM,
        message: 'Earlier notes: the deploy pipeline was re-run overnight', type: '', props: {}, root_id: '', is_pinned: false,
        // The only file whose name appears in no message text: finding it proves the file panel
        // searches older messages by file name, not just via the text-matching search API.
        metadata: {
            files: [
                {id: 'file-annual', name: 'annual-report.pdf', mime_type: 'application/pdf', extension: 'pdf', size: 24576, user_id: OTHER, create_at: 1_699_999_000_000, update_at: 1_699_999_000_000, delete_at: 0},
            ],
        },
    },
};

// Posts that "arrived" while the stock UI already has the channel open: the stock-UI view
// bridge re-reads /channels/{id}/posts on store activity, so tests can prove a message landing
// in an unchanged channel is still reported as seen (no channel switch involved).
const stockExtraIds = [];
function pushStockPost(post) {
    posts[post.id] = post;
    stockExtraIds.unshift(post.id);
}

const calls = [];
// Request bodies, so tests can assert what was actually sent (e.g. root_id on a reply).
const payloads = [];
// One-shot gate for POST /posts: tests hold the response to type into the composer while the
// send is still in flight (the "input clears immediately" regression).
let postsGate = null;
function holdPosts() {
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    postsGate = gate;
    return () => {
        postsGate = null;
        release();
    };
}
// In-memory stand-in for the plugin server component's tg_webui_user_view_tracking table.
const viewTracking = new Map([
    ['p3', new Set([OTHER, THIRD])],
    ['p1', new Set([OTHER])],
    ['p2', new Set([OTHER])], // an outgoing post someone else already saw: two checkmarks
]);
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
    // Bodies are JSON strings except for multipart uploads, where body is a FormData object.
    const isForm = typeof dom.window.FormData !== 'undefined' && options.body instanceof dom.window.FormData;
    let post = null;
    if (!isForm && typeof options.body === 'string') {
        try {
            post = JSON.parse(options.body);
        } catch {
            post = null;
        }
    }
    payloads.push({method: options.method || 'GET', path: p, body: post});

    if (p === '/plugins/com.telegramweb.ui/api/v1/forward' && options.method === 'POST') {
        const source = posts[post.post_id];
        if (!source || !channels[post.channel_id]) {
            return json({message: 'post or destination not found'}, 404);
        }
        return json({...source, id: 'forwarded-test-post', channel_id: post.channel_id, user_id: ME,
            props: {tgw_forwarded_from: source.id, tgw_forwarded_name: users[source.user_id].username},
            file_ids: (source.metadata?.files || []).map((file) => `copy-${file.id}`)});
    }

    // View tracking (server component of the plugin): records who saw which post and reports
    // counts, mirroring server/plugin.go.
    if (p.startsWith('/plugins/com.telegramweb.ui/api/v1/views')) {
        if (options.method === 'POST') {
            const ids = (post && Array.isArray(post.post_ids) ? post.post_ids : []).slice(0, 100);
            ids.forEach((id) => {
                if (!viewTracking.has(id)) {
                    viewTracking.set(id, new Set());
                }
                viewTracking.get(id).add(ME);
            });
            return json({recorded: ids.length});
        }
        if (options.method === 'GET') {
            const ids = (parsed.searchParams.get('post_ids') || '').split(',').filter(Boolean).slice(0, 100);
            const counts = {};
            const seenByMe = {};
            ids.forEach((id) => {
                const viewers = viewTracking.get(id);
                if (viewers) {
                    counts[id] = viewers.size;
                    seenByMe[id] = viewers.has(ME);
                }
            });
            const includeViewers = parsed.searchParams.get('include_viewers') === 'true';
            const viewers = {};
            const viewed_at = {};
            if (includeViewers) {
                ids.forEach((id) => {
                    viewers[id] = Array.from(viewTracking.get(id) || []);
                    viewed_at[id] = Object.fromEntries(viewers[id].map((userId) => [userId, 1_700_000_000_000]));
                });
            }
            return json({counts, seen: seenByMe, viewers, viewed_at});
        }
        return json({message: 'method not allowed'}, 405);
    }

    if (p === '/files' && options.method === 'POST') {
        const form = options.body;
        const file = form && typeof form.get === 'function' ? form.get('files') : null;
        const name = (file && file.name) || 'upload.bin';
        const declared = (file && file.type) || 'application/octet-stream';
        // The Mattermost server sniffs the container, so our audio/webm voice takes come back
        // as video/webm — the UI must still recognise them as voice messages.
        const mime = declared === 'audio/webm' ? 'video/webm' : declared;
        return json({
            file_infos: [{
                id: `file-up-${calls.length}`,
                user_id: ME,
                channel_id: form && typeof form.get === 'function' ? form.get('channel_id') : '',
                post_id: '',
                create_at: Date.now(),
                update_at: Date.now(),
                delete_at: 0,
                name,
                extension: name.includes('.') ? name.split('.').pop() : '',
                mime_type: mime,
                size: (file && file.size) || 0,
                client_id: form && typeof form.get === 'function' ? form.get('client_ids') : '',
            }],
        });
    }

    if (p === '/users/me') {
        return json(users[ME]);
    }
    if (p === '/users/me/preferences') {
        return json([]);
    }
    // Sidebar-category reorder (PUT /users/{user_id}/teams/{team_id}/channels/categories): the
    // server echoes the updated categories back as an array.
    if (options.method === 'PUT' && /^\/users\/[^/]+\/teams\/[^/]+\/channels\/categories$/.test(p)) {
        return json(Array.isArray(post) ? post : [post]);
    }
    if (p === '/users/ids' && options.method === 'POST') {
        const ids = Array.isArray(post) ? post : [];
        return json(ids.map((id) => users[id]).filter(Boolean));
    }
    if (/^\/channels\/[^/]+\/members$/.test(p)) {
        const id = p.split('/')[2];
        if (id === TOWN) {
            // Deliberately wider than the sparse membersInChannel copy in the store: the info
            // panel must render the REST list, not whatever the host webapp happened to load.
            return json([
                {channel_id: TOWN, user_id: ME},
                {channel_id: TOWN, user_id: OTHER},
                {channel_id: TOWN, user_id: THIRD},
            ]);
        }
        if (id === DM) {
            return json([{channel_id: DM, user_id: ME}, {channel_id: DM, user_id: OTHER}]);
        }
        return json([]);
    }
    if (p === `/channels/${DM}/posts`) {
        // ?before= pages into history: older than the first page lives only behind it (the file
        // panel walks back this way while a search term is held).
        const before = parsed.searchParams.get('before');
        if (before) {
            if (['p1', 'p2', 'p3', 'p4'].includes(before)) {
                return json({order: ['p-old'], posts: {'p-old': posts['p-old']}});
            }
            return json({order: [], posts: {}});
        }
        const extras = {};
        stockExtraIds.forEach((id) => {
            extras[id] = posts[id];
        });
        return json({order: [...stockExtraIds, 'p4', 'p3', 'p2', 'p1'], posts: {p1: posts.p1, p2: posts.p2, p3: posts.p3, p4: posts.p4, ...extras}});
    }
    if (p === `/channels/${TOWN}/posts`) {
        return json({order: [], posts: {}});
    }
    // The team file search (POST /teams/{team_id}/files/search): what Mattermost's own file
    // browser calls, with the "channel:<id>" term modifier plus an optional name needle —
    // built from the message fixtures, sorted and paged like the server does, so a short page
    // tells the client the listing is complete.
    if (/^\/teams\/[^/]+\/files\/search$/.test(p) && options.method === 'POST') {
        const terms = String((post && post.terms) || '');
        const channelMatch = terms.match(/channel:(\S+)/);
        const channelId = channelMatch ? channelMatch[1] : '';
        const needle = terms.replace(/channel:\S+/g, '').trim().toLowerCase();
        const infos = [];
        Object.values(posts).forEach((entry) => {
            if (entry.channel_id !== channelId) {
                return;
            }
            ((entry.metadata && entry.metadata.files) || []).forEach((file) => {
                if (needle && !(file.name || '').toLowerCase().includes(needle)) {
                    return;
                }
                infos.push({
                    id: file.id,
                    user_id: file.user_id || entry.user_id,
                    channel_id: channelId,
                    post_id: entry.id,
                    create_at: file.create_at || entry.create_at,
                    update_at: file.update_at || entry.update_at,
                    delete_at: file.delete_at || 0,
                    name: file.name,
                    extension: file.extension || '',
                    size: file.size || 0,
                    mime_type: file.mime_type || 'application/octet-stream',
                });
            });
        });
        infos.sort((a, b) => a.create_at - b.create_at);
        const page = Number((post && post.page) || 0);
        const perPage = Number((post && post.per_page) || 100);
        const slice = infos.slice(page * perPage, (page + 1) * perPage);
        // The real server's envelope (model.FileList): an `order` id array plus `file_infos`
        // as a map keyed by id — not a plain array. Returning it in this exact shape keeps the
        // panel's normalizer under test.
        const byId = {};
        slice.forEach((file) => {
            byId[file.id] = file;
        });
        return json({
            order: slice.map((file) => file.id),
            file_infos: byId,
            next_file_info_id: (page + 1) * perPage < infos.length ? String(page + 1) : '',
            prev_file_info_id: '',
            first_inaccessible_file_time: 0,
        });
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
    // All-messages search (POST /posts/search): case-insensitive substring match over the
    // message fixtures, mirroring what the Elastic/SQL search returns for a simple term.
    if (p === '/posts/search' && options.method === 'POST') {
        const terms = String((post && post.terms) || '').toLowerCase();
        const order = [];
        const found = {};
        Object.values(posts).forEach((entry) => {
            if (terms && (entry.message || '').toLowerCase().includes(terms)) {
                order.push(entry.id);
                found[entry.id] = entry;
            }
        });
        return json({order, posts: found});
    }

    if (p.startsWith('/posts/') && !p.endsWith('/thread') && p.split('/').length === 3) {
        const post = posts[p.split('/')[2]];
        if (post) {
            return json(post);
        }
    }
    if (p === '/posts') {
        if (postsGate) {
            await postsGate;
        }
        return json({
            ...posts.p2,
            id: 'p-new',
            channel_id: (post && post.channel_id) || posts.p2.channel_id,
            root_id: (post && post.root_id) || '',
            message: post.message,
            file_ids: (post && post.file_ids) || [],
            pending_post_id: post.pending_post_id,
        });
    }
    if (p === '/reactions') {
        return json({user_id: post.user_id, post_id: post.post_id, emoji_name: post.emoji_name, create_at: Date.now()});
    }
    if (p.startsWith('/users/') && p.endsWith('/image')) {
        return {ok: false, status: 404, statusText: 'Not Found', text: async () => ''};
    }
    if (p === '/channels/direct') {
        return json(Array.isArray(post) && post.includes(THIRD) ? newDirectChannel : channels[DM]);
    }
    if (p.startsWith('/channels/')) {
        const id = p.split('/')[2];
        if (id === NEW_DM) {
            return json(newDirectChannel);
        }
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
                PluginSettings: {Plugins: {'com.telegramweb.ui': {DefaultMode: true, DefaultTheme: 'light', DefaultAccent: 'blue', DefaultJalali: true}}},
            },
        },
        users: {
            currentUserId: ME,
            profiles: users,
            profilesInTeam: {[TEAM]: new Set([ME, OTHER, THIRD])},
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
                // Sparse on purpose: the host webapp only loaded the current user. The info
                // panel must still list everyone from the REST endpoint.
                [TOWN]: {[ME]: {channel_id: TOWN, user_id: ME}},
            },
            stats: {[DM]: {member_count: 2}, [TOWN]: {member_count: 3}},
            manuallyUnread: {},
        },
        channelCategories: {
            byId: {
                'cat-fav': {id: 'cat-fav', user_id: ME, team_id: TEAM, type: 'favorites', display_name: 'Favorites', sorting: 'manual', channel_ids: [], muted: false, collapsed: false},
                'cat-ch': {id: 'cat-ch', user_id: ME, team_id: TEAM, type: 'channels', display_name: 'Channels', sorting: 'alpha', channel_ids: [TOWN], muted: false, collapsed: false},
                'cat-dm': {id: 'cat-dm', user_id: ME, team_id: TEAM, type: 'direct_messages', display_name: 'Direct Messages', sorting: 'recent', channel_ids: [DM], muted: false, collapsed: false},
                'cat-work': {id: 'cat-work', user_id: ME, team_id: TEAM, type: 'custom', display_name: 'Work stuff', sorting: 'manual', channel_ids: [TOWN, DM], muted: false, collapsed: false},
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
    dispatch: (action) => {
        if (action?.type === 'LEAVE_CHANNEL' && action.data?.id) {
            const {id} = action.data;
            const myMembers = {...state.entities.channels.myMembers};
            const channels = {...state.entities.channels.channels};
            delete myMembers[id];
            delete channels[id];
            state.entities.channels.myMembers = myMembers;
            state.entities.channels.channels = channels;
            listeners.forEach((listener) => listener());
        }
        return action;
    },
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
    ids: {ME, OTHER, THIRD, TEAM, DM, TOWN, NEW_DM},
    holdPosts,
    pushStockPost,
    viewTracking,
    notifyStoreChange: () => listeners.forEach((listener) => listener()),
    tick,
    ok,
    fail,
    report,
};
