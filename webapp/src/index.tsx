// Plugin entry point.
//
// Registers the Telegram Web UI as a root component of the Mattermost web app, adds a channel
// header button + main menu entry to toggle it, and pipes the websocket events the UI needs into
// its own post cache.

import React from 'react';
import {PLUGIN_ID, getSettings, initSettings, setEnabled} from './mm/settings';
import {api} from './mm/api';
import {clearCache} from './mm/posts';
import {handleSocketEvent} from './mm/socket';
import {setStore} from './mm/store';
import {TelegramUI} from './ui/TelegramUI';
import './styles.css';

const ICON = React.createElement(
    'svg',
    {width: 18, height: 18, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true'},
    React.createElement('path', {
        d: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.9 6.2-1.7 8c-.1.6-.5.7-.9.4l-2.6-1.9-1.3 1.2c-.1.2-.3.3-.6.3l.2-2.9 5.3-4.8c.2-.2 0-.3-.3-.1l-6.5 4.1-2.8-.9c-.6-.2-.6-.6.1-.9l10.9-4.2c.5-.2 1 .1.8.7Z',
    }),
);

interface PluginRegistry {
    registerRootComponent: (component: React.ComponentType<any>) => string;
    registerChannelHeaderButtonAction: (icon: React.ReactNode, action: () => void, dropdownText: string, tooltipText?: string) => string;
    registerMainMenuAction: (text: string, action: () => void, mobileIcon?: React.ReactNode) => string;
    registerWebSocketEventHandler: (event: string, handler: (message: any) => void) => void;
    unregisterWebSocketEventHandler: (event: string) => void;
    unregisterComponent: (componentId: string) => void;
}

const TOGGLE_EVENT = 'tgw:disable';

// Events whose payload the local post cache consumes (see ./mm/socket for the JSON parsing).
const CACHE_EVENTS = ['posted', 'post_edited', 'post_deleted', 'reaction_added', 'reaction_removed'];

class TelegramWebPlugin {
    private registry?: PluginRegistry;

    private componentIds: string[] = [];

    private onDisable = () => {
        setEnabled(false);
    };

    initialize(registry: PluginRegistry, store: any) {
        this.registry = registry;
        setStore(store);
        initSettings();

        this.componentIds = [];

        // The UI itself. It renders as a full screen portal while it is enabled.
        this.componentIds.push(registry.registerRootComponent(TelegramUI));

        // Quick toggle from the channel header + main menu.
        registry.registerChannelHeaderButtonAction(ICON, () => this.toggle(), 'Telegram Web UI', 'Switch to the Telegram Web style UI');
        registry.registerMainMenuAction('Telegram Web UI', () => this.toggle(), ICON);

        // Mattermost websocket events -> plugin post cache.
        CACHE_EVENTS.forEach((event) => {
            registry.registerWebSocketEventHandler(event, (message: any) => handleSocketEvent(event, message));
        });
        // Keep unread state in sync when the channel is marked unread from another session
        // (or by this one via the set_unread API, which the server echoes back).
        registry.registerWebSocketEventHandler('post_unread', (message: any) => {
            store?.dispatch({
                type: 'POST_UNREAD_SUCCESS',
                data: {
                    lastViewedAt: message?.data?.last_viewed_at,
                    channelId: message?.broadcast?.channel_id,
                    msgCount: message?.data?.msg_count,
                    msgCountRoot: message?.data?.msg_count_root,
                    mentionCount: message?.data?.mention_count,
                    mentionCountRoot: message?.data?.mention_count_root,
                    urgentMentionCount: message?.data?.urgent_mention_count,
                },
            });
        });

        window.addEventListener(TOGGLE_EVENT, this.onDisable);

        // Warm up the session so the first REST call is authenticated through the session cookie
        // and the CSRF token is available for writes.
        api.getMe().catch(() => undefined);
    }

    toggle() {
        setEnabled(getSettings().mode !== 'on');
    }

    uninitialize() {
        window.removeEventListener(TOGGLE_EVENT, this.onDisable);
        try {
            CACHE_EVENTS.forEach((event) => this.registry?.unregisterWebSocketEventHandler(event));
            this.registry?.unregisterWebSocketEventHandler('post_unread');
        } catch (error) {
            // eslint-disable-next-line no-console
            console.warn('[telegram-web-ui] cleanup failed', error);
        }
        clearCache();
    }
}

declare global {
    interface Window {
        registerPlugin: (pluginId: string, plugin: TelegramWebPlugin) => void;
    }
}

window.registerPlugin(PLUGIN_ID, new TelegramWebPlugin());
