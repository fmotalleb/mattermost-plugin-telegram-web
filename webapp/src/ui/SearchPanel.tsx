// Wide (all-messages) search results, rendered in the main pane like Mattermost's search view.
//
// The sidebar keeps its narrow inline results; pressing Enter there (or "See all messages")
// opens this panel, which lists every message hit for the current team with pagination,
// highlighted matches and a jump to the message on click.

import React, {useEffect, useState} from 'react';
import {api} from '../mm/api';
import {getChatSummary, getCurrentTeamId} from '../mm/selectors';
import {getState, useSelector} from '../mm/store';
import type {MMPost} from '../mm/types';
import {displayName, formatChatTime, toPlainPreview, truncate} from '../mm/utils';
import {useTg} from './context';
import {EmojiText} from './EmojiText';
import {Avatar, IconClose, IconSearch} from './primitives';

const PER_PAGE = 30;

export function SearchPanel() {
    const {ui, actions, timeFormat, me} = useTg();
    const term = ui.search.trim();
    const teamId = useSelector(getCurrentTeamId);
    const profiles = useSelector((state) => state.entities?.users?.profiles);
    const [hits, setHits] = useState<MMPost[]>([]);
    const [loading, setLoading] = useState(false);
    const [page, setPage] = useState(0);
    const [hasMore, setHasMore] = useState(false);
    const [extraChannels, setExtraChannels] = useState<Record<string, string>>({});
    const [extraUsers, setExtraUsers] = useState<Record<string, string>>({});

    useEffect(() => {
        setPage(0);
    }, [term]);

    useEffect(() => {
        if (!term || !teamId) {
            setHits([]);
            setHasMore(false);
            return undefined;
        }
        let cancelled = false;
        setLoading(true);
        const timer = setTimeout(() => {
            api.searchPosts(teamId, term, {page, perPage: PER_PAGE})
                .then((data) => {
                    if (cancelled || !data) {
                        return;
                    }
                    const posts: MMPost[] = (data.order || []).map((id) => data.posts[id]).filter(Boolean);
                    setHits((current) => (page === 0 ? posts : [...current, ...posts.filter((post) => !current.some((seen) => seen.id === post.id))]));
                    setHasMore(posts.length >= PER_PAGE);
                })
                .catch(() => {
                    if (!cancelled) {
                        setHits([]);
                        setHasMore(false);
                    }
                })
                .then(() => {
                    if (!cancelled) {
                        setLoading(false);
                    }
                });
        }, 250);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [term, teamId, page]);

    // Results can name channels and authors the sparse host store never loaded (search reaches
    // every channel the user is in, not just the ones the sidebar happened to fetch): fill the
    // gaps once per panel render cycle so rows never show an empty title.
    useEffect(() => {
        const state = getState();
        const missingChannels = [...new Set(hits.map((post) => post.channel_id))]
            .filter((id) => id && !state.entities?.channels?.channels?.[id] && !extraChannels[id]);
        if (missingChannels.length) {
            missingChannels.forEach((id) => {
                api.getChannel(id)
                    .then((channel) => setExtraChannels((current) => ({...current, [id]: channel.display_name || channel.name || 'Conversation'})))
                    .catch(() => setExtraChannels((current) => ({...current, [id]: 'Conversation'})));
            });
        }
        const missingAuthors = [...new Set(hits.map((post) => post.user_id))]
            .filter((id) => id && !profiles[id] && !extraUsers[id]);
        if (missingAuthors.length) {
            api.getUsersByIds(missingAuthors)
                .then((users) => setExtraUsers((current) => {
                    const next = {...current};
                    users.forEach((user) => {
                        next[user.id] = displayName(user);
                    });
                    return next;
                }))
                .catch(() => undefined);
        }
    }, [hits, profiles, extraChannels, extraUsers]);

    const channelTitle = (channelId: string) => {
        const summary = getChatSummary(getState(), channelId);
        return (summary && summary.title) || extraChannels[channelId] || 'Conversation';
    };

    const authorName = (userId: string) => {
        const user = profiles?.[userId];
        return (user && displayName(user)) || extraUsers[userId] || '';
    };

    const total = hits.length;

    return (
        <section className="tgw-chat tgw-search-panel">
            <header className="tgw-chat-header">
                <span className="tgw-chat-header-text">
                    <span className="tgw-chat-header-title">
                        <IconSearch size={18} className="tgw-search-panel-icon"/>
                        {' '}Messages matching “{truncate(term, 40)}”
                    </span>
                    <span className="tgw-chat-header-sub">
                        {loading ? 'Searching…' : `${total}${hasMore ? '+' : ''} ${total === 1 ? 'result' : 'results'}`}
                    </span>
                </span>
                <div className="tgw-chat-header-actions">
                    <button
                        type="button"
                        className="tgw-icon-button"
                        title="Close search results"
                        onClick={() => actions.setUI({searchOpen: false})}
                    >
                        <IconClose size={20}/>
                    </button>
                </div>
            </header>

            <div className="tgw-search-panel-body">
                {!loading && !hits.length && term && (
                    <div className="tgw-empty-list">
                        <div className="tgw-empty-title">No messages found</div>
                        <div className="tgw-empty-body">Try a different search term.</div>
                    </div>
                )}
                {hits.map((post) => (
                    <button
                        type="button"
                        key={post.id}
                        className="tgw-search-hit"
                        onClick={() => actions.openChat(post.channel_id, {postId: post.id})}
                    >
                        <Avatar userId={post.user_id} name={authorName(post.user_id)} size={40} status=""/>
                        <span className="tgw-search-hit-body">
                            <span className="tgw-search-hit-top">
                                <span className="tgw-search-hit-title">{channelTitle(post.channel_id)}</span>
                                {authorName(post.user_id) && <span className="tgw-search-hit-author">{authorName(post.user_id)}</span>}
                                <span className="tgw-search-hit-time">{formatChatTime(post.create_at, timeFormat)}</span>
                            </span>
                            <span className="tgw-search-hit-text">
                                {me?.id === post.user_id && <span className="tgw-search-hit-you">You: </span>}
                                <EmojiText text={truncate(toPlainPreview(post.message) || 'Attachment', 280)} term={term}/>
                            </span>
                        </span>
                    </button>
                ))}
                {loading && <div className="tgw-loading-pill">Searching…</div>}
                {!loading && hasMore && (
                    <button type="button" className="tgw-link-button tgw-search-more" onClick={() => setPage((current) => current + 1)}>
                        Load more results
                    </button>
                )}
            </div>
        </section>
    );
}
