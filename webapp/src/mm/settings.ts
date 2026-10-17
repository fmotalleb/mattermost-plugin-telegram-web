// Plugin settings.
//
// Three layers, in increasing priority:
//   1. server side defaults from plugin.json settings_schema (read from the client config)
//   2. the user's own settings, persisted as a Mattermost user preference (survives browsers)
//   3. a localStorage mirror so the UI paints instantly on reload

import {api} from './api';
import {getState, readLocal, writeLocal} from './store';

export const PLUGIN_ID = 'com.telegramweb.ui';
const LOCAL_KEY = `tgw.settings.${PLUGIN_ID}`;
const PREFERENCE_CATEGORY = PLUGIN_ID;
const PREFERENCE_NAME = 'settings';

export type ThemeName = 'light' | 'dark' | 'tinted' | 'ice' | 'midnight';
export type AccentName = 'blue' | 'violet' | 'green' | 'orange' | 'red';

export const THEME_LABELS: Record<ThemeName, string> = {
    light: 'Light',
    dark: 'Dark',
    tinted: 'Tinted',
    ice: 'Ice',
    midnight: 'Midnight',
};

export interface PluginSettings {
    mode: 'on' | 'off';
    theme: ThemeName;
    accent: AccentName;
    showPreviews: boolean;
    compactMode: boolean;
    animations: boolean;
    folderTabs: boolean;
    /** Translucent, blurred chrome (Settings > Appearance). On by default. */
    glassyMode: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
    mode: 'off',
    theme: 'light',
    accent: 'blue',
    showPreviews: true,
    compactMode: false,
    animations: true,
    folderTabs: true,
    glassyMode: true,
};

const listeners = new Set<() => void>();
let settings: PluginSettings = {...DEFAULT_SETTINGS};
let saveTimer: any = null;

export function getSettings(): PluginSettings {
    return settings;
}

export function subscribeSettings(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function emit() {
    listeners.forEach((listener) => {
        try {
            listener();
        } catch (err) {
            // eslint-disable-next-line no-console
            console.error('[telegram-web-ui] settings listener failed', err);
        }
    });
}

function parse(json: string | null | undefined): Partial<PluginSettings> {
    if (!json) {
        return {};
    }
    try {
        const parsed = JSON.parse(json);
        return typeof parsed === 'object' && parsed ? parsed : {};
    } catch (err) {
        return {};
    }
}

/** Server side defaults configured by the admin in plugin.json / the system console. */
function serverDefaults(): Partial<PluginSettings> {
    try {
        const config = getState().entities?.general?.config || {};
        const pluginConfig = config.PluginSettings?.Plugins?.[PLUGIN_ID] || {};
        const defaults: Partial<PluginSettings> = {};
        if (pluginConfig.DefaultMode !== undefined) {
            defaults.mode = pluginConfig.DefaultMode === true || pluginConfig.DefaultMode === 'true' ? 'on' : 'off';
        }
        if (pluginConfig.DefaultTheme !== undefined && THEME_LABELS[pluginConfig.DefaultTheme as ThemeName]) {
            defaults.theme = pluginConfig.DefaultTheme as ThemeName;
        }
        if (pluginConfig.DefaultAccent) {
            defaults.accent = pluginConfig.DefaultAccent as AccentName;
        }
        return defaults;
    } catch (err) {
        return {};
    }
}

export function initSettings() {
    settings = {...DEFAULT_SETTINGS, ...serverDefaults(), ...parse(readLocal(LOCAL_KEY, null as any))};
    emit();

    // Pick up the server side copy of the user's settings once the session is ready.
    api.request<Array<{category: string; name: string; value: string}>>('/users/me/preferences')
        .then((preferences) => {
            const preference = (preferences || []).find((entry) => entry.category === PREFERENCE_CATEGORY && entry.name === PREFERENCE_NAME);
            if (!preference) {
                // First run: keep whatever we have and persist it for the next browser.
                persistRemote(settings);
                return;
            }
            const merged = {...DEFAULT_SETTINGS, ...serverDefaults(), ...parse(preference.value)};
            settings = merged;
            writeLocal(LOCAL_KEY, JSON.stringify(merged));
            emit();
        })
        .catch(() => {
            // Not signed in through the REST API or offline: the localStorage copy is enough.
        });
}

export function updateSettings(patch: Partial<PluginSettings>) {
    settings = {...settings, ...patch};
    writeLocal(LOCAL_KEY, JSON.stringify(settings));
    emit();
    if (saveTimer) {
        clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => persistRemote(settings), 400);
}

function persistRemote(value: PluginSettings) {
    const userId = getState().entities?.users?.currentUserId;
    if (!userId) {
        return;
    }
    api.savePreferences([
        {
            category: PREFERENCE_CATEGORY,
            name: PREFERENCE_NAME,
            user_id: userId,
            value: JSON.stringify(value),
        },
    ]).catch(() => {
        // Preferences are a nicety; localStorage already holds the value.
    });
}

export function isEnabled(): boolean {
    return settings.mode === 'on';
}

export function setEnabled(enabled: boolean) {
    updateSettings({mode: enabled ? 'on' : 'off'});
}

// Bubble colors are themed in styles.css — outgoing bubbles are a lighter tint of the incoming
// one in every theme (Telegram-style). This map only feeds the accent picker.
export const ACCENTS: Record<AccentName, {label: string; color: string}> = {
    blue: {label: 'Blue', color: '#3390ec'},
    violet: {label: 'Violet', color: '#8774e1'},
    green: {label: 'Green', color: '#4dbb5d'},
    orange: {label: 'Orange', color: '#f5a623'},
    red: {label: 'Red', color: '#e5544b'},
};
