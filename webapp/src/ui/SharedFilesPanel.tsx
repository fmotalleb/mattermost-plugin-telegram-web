// Right-hand "Shared files" menu: every file exchanged in the open chat, newest first,
// behind a fuzzy-free file-name search bar. Toggled from the chat header and collapsible
// from its own header, so it starts minimized like Mattermost's channel-info gutters.
// Clicking a file lands back on the message that shared it instead of opening the raw file.
//
// The list is scoped to the messages loaded so far — a note under the search box says as
// much — and holding a term also queries Mattermost's full-history search API, so files in
// older, not-yet-fetched messages surface without paging the whole channel.

import React, {useEffect, useRef, useState} from 'react';
import {api} from '../mm/api';
import {getBlock, receivePost, useChannelPosts} from '../mm/posts';
import {getCurrentTeamId} from '../mm/selectors';
import {useSelector} from '../mm/store';
import type {MMFileInfo, MMPost} from '../mm/types';
import {displayName, formatDateSeparator, formatBytes, formatMessageStamp} from '../mm/utils';
import {useTg} from './context';
import {filesOfPost} from './MessageList';
import {IconClose, IconFile, IconSearch} from './primitives';

/** idle: no term · pending: request on its way · done/failed: terminal states for the hints. */
type SearchState = 'idle' | 'pending' | 'done' | 'failed';

export function SharedFilesPanel() {
    const {actions, channel, timeFormat, isMobile} = useTg();
    const {posts} = useChannelPosts(channel?.id);
    const profiles = useSelector((state) => state.entities?.users?.profiles);
    const teamId = useSelector(getCurrentTeamId);
    const [term, setTerm] = useState('');
    const [remotePosts, setRemotePosts] = useState<MMPost[]>([]);
    const [searchState, setSearchState] = useState<SearchState>('idle');
    const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const searchSeq = useRef(0);

    // Debounced full-history search: only while a term is held, only messages of this chat,
    // and a stale response never outranks a newer one.
    useEffect(() => {
        const needle = term.trim();
        const seq = ++searchSeq.current;
        if (searchTimer.current) {
            clearTimeout(searchTimer.current);
            searchTimer.current = null;
        }
        if (!needle) {
            setRemotePosts([]);
            setSearchState('idle');
            return undefined;
        }
        setSearchState('pending');
        searchTimer.current = setTimeout(() => {
            api.searchPosts(teamId, needle, {perPage: 40})
                .then((data) => {
                    if (seq !== searchSeq.current) {
                        return;
                    }
                    const found = data ? (data.order || []).map((id) => data.posts[id]).filter(Boolean) : [];
                    setRemotePosts(found.filter((post) => !channel || post.channel_id === channel.id));
                    setSearchState('done');
                })
                .catch(() => {
                    if (seq === searchSeq.current) {
                        setSearchState('failed');
                    }
                });
        }, 300);
        return () => {
            if (searchTimer.current) {
                clearTimeout(searchTimer.current);
                searchTimer.current = null;
            }
        };
    }, [term, teamId, channel]);

    // The scope line: the date of the oldest message fetched into this chat so far.
    const scopeAt = posts.reduce((min, post) => (!min || post.create_at < min ? post.create_at : min), 0);

    // One row per file id, newest first: fetched messages first (they carry the full context),
    // then whatever the full-history search turned up. Files hang off their posting message's
    // metadata, so the list straightens itself when older pages arrive.
    const rows: Array<{file: MMFileInfo; post: MMPost; remote: boolean}> = [];
    const seen = new Set<string>();
    const remoteIds = new Set(remotePosts.map((post) => post.id));
    const pushPost = (post: MMPost) => {
        filesOfPost(post).forEach((file) => {
            if (!file || seen.has(file.id)) {
                return;
            }
            seen.add(file.id);
            rows.push({file, post, remote: remoteIds.has(post.id)});
        });
    };
    posts.forEach(pushPost);
    remotePosts.forEach(pushPost);
    rows.sort((a, b) => (b.file.create_at || b.post.create_at) - (a.file.create_at || a.post.create_at));

    const needle = term.trim().toLowerCase();
    // Search hits came from matching message *text*, so their files qualify even when the file
    // name itself does not contain the term.
    const visible = needle
        ? rows.filter((row) => row.remote || row.file.name.toLowerCase().includes(needle))
        : rows;

    // Land on the message instead of opening the file in a new tab: the message list scrolls
    // to the post and flashes it. A message older than the loaded window is fetched first.
    // Phones overlay this panel on top of the chat, so drop it there first to actually reveal
    // the message; on desktop it stays open for browsing.
    const goToMessage = (post: MMPost) => {
        actions.setUI({
            highlightedPostId: post.id,
            searchOpen: false,
            ...(isMobile ? {filesOpen: false} : {}),
        });
        if (post.channel_id && !getBlock(post.channel_id)?.posts?.[post.id]) {
            api.getPost(post.id)
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

            {!needle && (
                <div className="tgw-files-scope">
                    {scopeAt
                        ? `Files shared since ${formatDateSeparator(scopeAt, timeFormat)}. Search to include older messages.`
                        : 'Showing fetched messages only. Search to include older messages.'}
                </div>
            )}

            <div className="tgw-files-body">
                {!rows.length && searchState === 'pending' && (
                    <div className="tgw-empty-list">
                        <div className="tgw-empty-body">Searching all messages…</div>
                    </div>
                )}
                {!rows.length && searchState === 'failed' && (
                    <div className="tgw-empty-list">
                        <div className="tgw-empty-body">Could not search older messages.</div>
                    </div>
                )}
                {!rows.length && searchState !== 'pending' && searchState !== 'failed' && (
                    <div className="tgw-empty-list">
                        <div className="tgw-empty-title">No files yet</div>
                        <div className="tgw-empty-body">Files shared in this chat will be listed here.</div>
                    </div>
                )}
                {!!rows.length && !visible.length && (
                    <div className="tgw-empty-list">
                        <div className="tgw-empty-body">No files match “{term.trim()}”.</div>
                    </div>
                )}
                {visible.map(({file, post}) => {
                    const author = profiles?.[post.user_id];
                    return (
                        <button
                            type="button"
                            className="tgw-file-row"
                            key={file.id}
                            onClick={() => goToMessage(post)}
                            title={`Go to message with ${file.name}`}
                        >
                            <span className="tgw-file-icon">
                                <IconFile size={20}/>
                            </span>
                            <span className="tgw-file-body">
                                <span className="tgw-file-name">{file.name}</span>
                                <span className="tgw-file-meta">
                                    {`${formatBytes(file.size || 0)} · ${formatMessageStamp(post.create_at, timeFormat)}${author ? ` · ${displayName(author).split(' ')[0]}` : ''}`}
                                </span>
                            </span>
                        </button>
                    );
                })}
            </div>
        </aside>
    );
}