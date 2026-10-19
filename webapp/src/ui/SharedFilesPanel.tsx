// Right-hand "Shared files" menu: every file exchanged in the open chat, newest first,
// behind a file-name filter bar. Toggled from the chat header and collapsible from its own
// header, so it starts minimized like Mattermost's channel-info gutters.
// Clicking a file lands back on the message that shared it instead of opening the raw file.
//
// The list comes from Mattermost's own team file search (POST /teams/{team_id}/files/search
// with the "channel:<id>" term modifier) — the endpoint the stock app browses a channel's
// files with — so it covers the chat's entire history without walking messages or leaning on
// the message search. Typing in the filter box joins the needle into the same server-side
// term, and files hung off messages the web app has already loaded are merged in on top, so a
// file that was just sent shows up while the panel is open.

import React, {useEffect, useRef, useState} from 'react';
import {api} from '../mm/api';
import {getBlock, receivePost, useChannelPosts} from '../mm/posts';
import {getCurrentTeamId} from '../mm/selectors';
import {useSelector} from '../mm/store';
import type {MMFileInfo} from '../mm/types';
import {displayName, fileKindOf, formatBytes, formatMessageStamp} from '../mm/utils';
import {useTg} from './context';
import {filesOfPost} from './MessageList';
import {IconClose, IconSearch} from './primitives';

/** loading: request on its way · done: the listing is complete · failed: nothing could load. */
type LoadState = 'loading' | 'done' | 'failed';

/**
 * The row's glyph: images get the server's thumbnail as a small rounded preview — pictures
 * should read as pictures, not as file names — while every other kind gets the same
 * extension-labelled icon the chat's attachments use (Mattermost's file list labels its
 * document icons the same way). An image whose preview never generated falls back to that
 * icon instead of a broken-image box.
 */
function RowIcon({file}: {file: MMFileInfo}) {
    const kind = fileKindOf(file.mime_type || file.name);
    const [broken, setBroken] = useState(false);
    if (kind === 'image' && !broken) {
        return (
            <span className="tgw-file-thumb">
                <img src={api.fileURL(file.id, true)} alt="" loading="lazy" draggable={false} onError={() => setBroken(true)}/>
            </span>
        );
    }
    return (
        <span className={`tgw-file-icon tgw-file-${kind}`}>
            {file.extension ? file.extension.slice(0, 4).toUpperCase() : 'FILE'}
        </span>
    );
}

/** Debounced term-search states; the listing stays usable while a search is on its way. */
type SearchState = 'idle' | 'pending' | 'done' | 'failed';

/** Upper bound on listing pages (20 × 100 = 2000 files) so a file-heavy chat cannot stall the panel. */
const LIST_MAX_PAGES = 20;
const LIST_PAGE_SIZE = 100;
const SEARCH_DEBOUNCE_MS = 350;

export function SharedFilesPanel() {
    const {actions, channel, timeFormat, isMobile} = useTg();
    const {posts} = useChannelPosts(channel?.id);
    const profiles = useSelector((state) => state.entities?.users?.profiles);
    const teamId = useSelector(getCurrentTeamId);
    const [term, setTerm] = useState('');
    const [listedFiles, setListedFiles] = useState<MMFileInfo[]>([]);
    const [loadState, setLoadState] = useState<LoadState>('loading');
    const [searchFiles, setSearchFiles] = useState<MMFileInfo[]>([]);
    const [searchState, setSearchState] = useState<SearchState>('idle');
    const loadSeq = useRef(0);
    const searchSeq = useRef(0);
    const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // The channel's file listing — the same team file search the stock app makes, just without
    // a name term — paged to the end (or the cap). A stale response never outranks a newer one:
    // switching chats mid-load leaves nothing behind.
    useEffect(() => {
        const seq = ++loadSeq.current;
        if (!channel || !teamId) {
            setListedFiles([]);
            setLoadState('done');
            return undefined;
        }
        setListedFiles([]);
        setLoadState('loading');
        const collected: MMFileInfo[] = [];
        const loadAll = async () => {
            for (let page = 0; page < LIST_MAX_PAGES; page++) {
                if (seq !== loadSeq.current) {
                    return;
                }
                const data = await api.searchChannelFiles(teamId, channel.id, {page, perPage: LIST_PAGE_SIZE});
                if (seq !== loadSeq.current) {
                    return;
                }
                const batch = (data && data.file_infos) || [];
                const known = new Set(collected.map((file) => file.id));
                const fresh = batch.filter((file) => !known.has(file.id)).length;
                collected.push(...batch);
                if (batch.length < LIST_PAGE_SIZE || !fresh) {
                    break; // short page — or a server that ignored the page and repeated itself
                }
            }
            if (seq === loadSeq.current) {
                setListedFiles(collected);
                setLoadState('done');
            }
        };
        loadAll().catch(() => {
            if (seq === loadSeq.current) {
                // Keep whatever landed before the failure: a partial list beats an empty one.
                setListedFiles(collected.slice());
                setLoadState(collected.length ? 'done' : 'failed');
            }
        });
        return () => {
            // Cancellation is the seq check inside loadAll; bump it so an in-flight page stops.
            loadSeq.current += 1;
        };
    }, [channel, teamId]);

    // Debounced server-side name search: the term joins the "channel:<id>" modifier and goes
    // to the same files/search endpoint the stock app hits while typing, so files beyond the
    // listing cap surface by name without paging messages. A stale response never lands.
    useEffect(() => {
        const needle = term.trim();
        const seq = ++searchSeq.current;
        if (searchTimer.current) {
            clearTimeout(searchTimer.current);
            searchTimer.current = null;
        }
        if (!needle || !channel || !teamId) {
            setSearchFiles([]);
            setSearchState('idle');
            return undefined;
        }
        setSearchState('pending');
        searchTimer.current = setTimeout(() => {
            const collected: MMFileInfo[] = [];
            const run = async () => {
                for (let page = 0; page < LIST_MAX_PAGES; page++) {
                    if (seq !== searchSeq.current) {
                        return;
                    }
                    const data = await api.searchChannelFiles(teamId, channel.id, {terms: needle, page, perPage: LIST_PAGE_SIZE});
                    if (seq !== searchSeq.current) {
                        return;
                    }
                    const batch = (data && data.file_infos) || [];
                    const known = new Set(collected.map((file) => file.id));
                    const fresh = batch.filter((file) => !known.has(file.id)).length;
                    collected.push(...batch);
                    if (batch.length < LIST_PAGE_SIZE || !fresh) {
                        break;
                    }
                }
                if (seq === searchSeq.current) {
                    setSearchFiles(collected);
                    setSearchState('done');
                }
            };
            run().catch(() => {
                if (seq === searchSeq.current) {
                    // A failed search leaves the client-side name filter over what is loaded.
                    setSearchFiles(collected.slice());
                    setSearchState(collected.length ? 'done' : 'failed');
                }
            });
        }, SEARCH_DEBOUNCE_MS);
        return () => {
            if (searchTimer.current) {
                clearTimeout(searchTimer.current);
                searchTimer.current = null;
            }
        };
    }, [term, teamId, channel]);

    // One row per file id, newest first: the listing, whatever the term search turned up, then
    // files of the messages the web app has already loaded that neither knew about (an
    // optimistic upload in flight, for example). Metadata copies can be thinner than the
    // server's — fill the gaps from the posting message so the row still sorts and reads right.
    const rows: MMFileInfo[] = [];
    const seen = new Set<string>();
    const push = (file: MMFileInfo) => {
        if (!file || !file.id || seen.has(file.id)) {
            return;
        }
        seen.add(file.id);
        rows.push(file);
    };
    listedFiles.forEach(push);
    searchFiles.forEach(push);
    posts.forEach((post) => {
        filesOfPost(post).forEach((file) => {
            push(file && {
                ...file,
                create_at: file.create_at || post.create_at,
                user_id: file.user_id || post.user_id,
                post_id: file.post_id || post.id,
                channel_id: file.channel_id || post.channel_id,
            });
        });
    });
    rows.sort((a, b) => (b.create_at || 0) - (a.create_at || 0));

    const needle = term.trim().toLowerCase();
    const visible = needle ? rows.filter((file) => (file.name || '').toLowerCase().includes(needle)) : rows;
    const capped = listedFiles.length >= LIST_MAX_PAGES * LIST_PAGE_SIZE;

    // Land on the message instead of opening the file in a new tab: the message list scrolls
    // to the post and flashes it. A message older than the loaded window is fetched first.
    // Phones overlay this panel on top of the chat, so drop it there first to actually reveal
    // the message; on desktop it stays open for browsing.
    const goToMessage = (file: MMFileInfo) => {
        if (!file.post_id) {
            return; // a file that never reached a post has no message to jump to
        }
        actions.setUI({
            highlightedPostId: file.post_id,
            searchOpen: false,
            ...(isMobile ? {filesOpen: false} : {}),
        });
        if (channel && !getBlock(channel.id)?.posts?.[file.post_id]) {
            api.getPost(file.post_id)
                .then((loaded) => {
                    if (loaded && loaded.id) {
                        receivePost(loaded);
                    }
                })
                .catch(() => undefined);
        }
    };

    return (
        <aside className="tgw-info-panel tgw-files-panel">
            <header className="tgw-info-header">
                <span className="tgw-info-title">{rows.length ? `Shared files · ${rows.length}` : 'Shared files'}</span>
                <button
                    type="button"
                    className="tgw-icon-button"
                    onClick={() => actions.setUI({filesOpen: false})}
                    title="Collapse"
                >
                    <IconClose size={20}/>
                </button>
            </header>

            <div className="tgw-files-search">
                <div className="tgw-search tgw-files-search-field">
                    <IconSearch size={18} className="tgw-search-icon"/>
                    <input
                        value={term}
                        onChange={(event) => setTerm(event.target.value)}
                        placeholder="Search file names"
                        spellCheck={false}
                    />
                    {term && (
                        <button type="button" className="tgw-search-clear" onClick={() => setTerm('')} title="Clear">
                            &times;
                        </button>
                    )}
                </div>
            </div>

            {loadState === 'done' && !needle && (
                <div className="tgw-files-scope">
                    {capped
                        ? `Showing the newest ${rows.length} files of this chat.`
                        : 'Every file ever shared in this chat is listed. Search filters by name.'}
                </div>
            )}

            <div className="tgw-files-body">
                {loadState === 'loading' && (
                    <div className="tgw-empty-list">
                        <div className="tgw-empty-body">Loading files…</div>
                    </div>
                )}
                {loadState === 'failed' && (
                    <div className="tgw-empty-list">
                        <div className="tgw-empty-body">Could not load the files of this chat.</div>
                    </div>
                )}
                {loadState === 'done' && !rows.length && (
                    <div className="tgw-empty-list">
                        <div className="tgw-empty-title">No files yet</div>
                        <div className="tgw-empty-body">Files shared in this chat will be listed here.</div>
                    </div>
                )}
                {loadState === 'done' && !!rows.length && !visible.length && (
                    <div className="tgw-empty-list">
                        <div className="tgw-empty-body">
                            {searchState === 'pending' ? 'Searching files…' : `No files match “${term.trim()}”.`}
                        </div>
                    </div>
                )}
                {visible.map((file) => {
                    const author = profiles?.[file.user_id];
                    return (
                        <button
                            type="button"
                            className="tgw-file-row"
                            key={file.id}
                            onClick={() => goToMessage(file)}
                            title={`Go to message with ${file.name}`}
                        >
                            <RowIcon file={file}/>
                            <span className="tgw-file-body">
                                <span className="tgw-file-name">{file.name}</span>
                                <span className="tgw-file-meta">
                                    {`${formatBytes(file.size || 0)} · ${formatMessageStamp(file.create_at, timeFormat)}${author ? ` · ${displayName(author).split(' ')[0]}` : ''}`}
                                </span>
                            </span>
                        </button>
                    );
                })}
            </div>
        </aside>
    );
}
