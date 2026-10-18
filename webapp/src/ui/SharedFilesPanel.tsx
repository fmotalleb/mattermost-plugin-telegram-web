// Right-hand "Shared files" menu: every file exchanged in the open chat, newest first,
// behind a fuzzy-free file-name search bar. Toggled from the chat header and collapsible
// from its own header, so it starts minimized like Mattermost's channel-info gutters.

import React, {useState} from 'react';
import {api} from '../mm/api';
import {useChannelPosts} from '../mm/posts';
import {useSelector} from '../mm/store';
import type {MMFileInfo, MMPost} from '../mm/types';
import {displayName, formatBytes, formatMessageStamp} from '../mm/utils';
import {useTg} from './context';
import {filesOfPost} from './MessageList';
import {IconClose, IconFile, IconSearch} from './primitives';

export function SharedFilesPanel() {
    const {actions, channel, timeFormat} = useTg();
    const {posts} = useChannelPosts(channel?.id);
    const profiles = useSelector((state) => state.entities?.users?.profiles);
    const [term, setTerm] = useState('');

    // One row per file id, newest first. Files hang off the posting message's metadata,
    // so the list straightens itself when older pages arrive.
    const rows: Array<{file: MMFileInfo; post: MMPost}> = [];
    const seen = new Set<string>();
    posts.forEach((post) => {
        filesOfPost(post).forEach((file) => {
            if (!file || seen.has(file.id)) {
                return;
            }
            seen.add(file.id);
            rows.push({file, post});
        });
    });
    rows.sort((a, b) => (b.file.create_at || b.post.create_at) - (a.file.create_at || a.post.create_at));

    const needle = term.trim().toLowerCase();
    const visible = needle ? rows.filter((row) => row.file.name.toLowerCase().includes(needle)) : rows;

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

            <div className="tgw-files-body">
                {!rows.length && (
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
                        <a
                            className="tgw-file-row"
                            key={file.id}
                            href={api.fileURL(file.id)}
                            target="_blank"
                            rel="noreferrer"
                            title={`Download ${file.name}`}
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
                        </a>
                    );
                })}
            </div>
        </aside>
    );
}