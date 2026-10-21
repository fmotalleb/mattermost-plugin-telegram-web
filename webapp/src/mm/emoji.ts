// Emoji data for the picker + a small shortcode replacer used by the fallback message renderer.
//
// Mattermost itself renders `:shortcode:` and unicode emoji inside formatted message HTML
// (through PostUtils + the store), so this table is only needed for the picker and for the
// fallback renderer used when window.PostUtils is unavailable.
//
// The authoritative source is EMOJI_SHORTCODES (emoji-data.ts), Mattermost's own emoji.json:
// every system shortcode it accepts resolves through it. The picker below shows a curated subset;
// EXTRA_EMOJI fills the few names Mattermost's json does not list but which other clients accept.

import {EMOJI_SHORTCODES} from './emoji-data';

export interface EmojiEntry {
    name: string;
    char: string;
}

export interface EmojiCategory {
    id: string;
    label: string;
    icon: string;
    emojis: EmojiEntry[];
}

/**
 * Acceptable-typed shortcodes Mattermost's emoji.json does not list (aliases used by the old
 * Slack/EmojiOne naming and a few duplicates the picker keeps). Every one of them must have a
 * real character here: it is both what the picker row shows and what `:name:` expands to.
 */
const EXTRA_EMOJI: Record<string, string> = {
    // face aliases
    grinning_face_with_smiling_eyes: '😄',
    kissing_heart_face: '😘',
    kissing_face: '😗',
    raised_eyebrow: '🤨',
    rolling_eyes: '🙄',
    smiling_face_with_halo: '😇',
    spy: '🕵️',
    claus: '🎅',
    bride_prince_with_veil: '👰',
    left_facing_fist: '🤛',
    right_facing_fist: '🤜',
    heart_with_arrow: '💘',
    // nature + food
    sheaf_of_rice: '🌾',
    sun: '☀️',
    baguette: '🥖',
    salad: '🥗',
    birthday_cake: '🎂',
    tumbler: '🥃',
    // activity
    rugby_martial_arts: '🏉',
    billiards: '🎱',
    frisbee: '🥏',
    medal_sports1st: '🥇',
    medal_sports2nd: '🥈',
    medal_sports3rd: '🥉',
    racing: '🏎️',
    chess: '♟️',
    pawn: '♟️',
    bishop: '♝',
    knight: '♞',
    rook: '♜',
    dice: '🎲',
    // places + objects
    bicycle: '🚲',
    castle: '🏰',
    movie_projector: '🎞️',
    trolley: '🛒',
    couch: '🛋️',
    // misc aliases Mattermost's json leaves out
    poo: '💩',
    palette: '🎨',
    // symbols + flags
    plus: '➕',
    redo: '🔁',
    speech_left: '🗨️',
    speech_right: '🗯️',
    bang: '❗',
    hands: '🙌',
    crossing_flags: '🎌',
    flag_white: '🏳️',
    flag_black: '🏴',
    flag_rainbow: '🏳️‍🌈',
};

/** Builds picker rows from a space separated name list, resolved against the emoji tables. */
function list(names: string): EmojiEntry[] {
    return names
        .split(' ')
        .filter(Boolean)
        .map((name) => ({name, char: EMOJI_SHORTCODES[name] || EXTRA_EMOJI[name] || ''}))
        .filter((entry) => !!entry.char);
}

export const EMOJI_CATEGORIES: EmojiCategory[] = [
    {
        id: 'people',
        label: 'Smileys & People',
        icon: '😀',
        emojis: [
            ...list(
                'grinning smile smiley grin grinning_face_with_smiling_eyes laughing satisfied sweat_smile joy rofl slightly_smiling_face wink blush yum sunglasses heart_eyes kissing_heart kissing_heart_face kissing_smiling_eyes kissing_closed_eyes relaxed stuck_out_tongue stuck_out_tongue_winking_eye stuck_out_tongue_closed_eyes zany_face thinking_face raised_eyebrow neutral_face expressionless no_mouth smirk unamused rolling_eyes grimacing lying_face relieved pensive sleepy drooling_face sleeping face_with_thermometer face_with_head_bandage nauseated_face sneezing_face hot_face cold_face woozy_face dizzy_face exploding_head cowboy_hat_face partying_face smiling_imp imp smiling_face_with_halo angel skull ghost alien robot_face hankey poo',
            ),
            ...list(
                'kissing_face baby boy girl man woman older_man older_woman person_with_blond_hair cop construction_worker_man guardsman detective spy santa claus woman_with_veil bride_prince_with_veil princess prince bathtub baby_chick',
            ),
            ...list(
                'wave raised_back_of_hand ok_hand v thumbsup thumbsdown fist punch left_facing_fist right_facing_fist raised_hand open_hands muscle pray handshake point_up point_down point_left point_right middle_finger writing_hand nail_care selfie clap eyes eye ear nose tongue lips',
            ),
            ...list(
                'heart orange_heart yellow_heart green_heart blue_heart purple_heart black_heart broken_heart two_hearts heartpulse sparkling_heart heart_with_arrow cupid gift_heart couple_with_heart',
            ),
        ],
    },
    {
        id: 'nature',
        label: 'Animals & Nature',
        icon: '🐶',
        emojis: [
            ...list(
                'dog cat mouse hamster rabbit fox_face bear panda_face koala tiger lion_face cow pig frog monkey see_no_evil hear_no_evil speak_no_evil monkey_face chicken penguin baby_chick hatching_chick hatched_chick bird baby_chick wolf boar horse unicorn_face bee bug butterfly snail beetle ant spider scorpion crab snake lizard turtle tropical_fish fish blowfish dolphin whale shark octopus shell',
            ),
            ...list(
                'bouquet cherry_blossom tulip four_leaf_clover rose sunflower hibiscus maple_leaf leaves fallen_leaf herb ear_of_rice seedling evergreen_tree deciduous_tree palm_tree cactus christmas_tree blossom sheaf_of_rice mushroom',
            ),
            ...list(
                'sun moon star star2 sparkles zap cloud snowman snowflake umbrella thermometer fire rainbow ocean droplet earth_americas globe_with_meridians milky_way cyclone foggy',
            ),
        ],
    },
    {
        id: 'food',
        label: 'Food & Drink',
        icon: '🍔',
        emojis: [
            ...list(
                'apple green_apple pear tangerine lemon cherries grapes strawberry melon watermelon peach banana pineapple kiwi_fruit tomato eggplant avocado broccoli cucumber carrot corn hot_pepper potato sweet_potato bread croissant baguette cheese_wedge egg fried_egg bacon pancakes waffle',
            ),
            ...list(
                'hamburger fries pizza hotdog sandwich taco burrito salad sushi bento rice curry ramen spaghetti meat_on_bone poultry_leg dumpling fortune_cookie popcorn honey_pot cookie birthday_cake cake cupcake chocolate_bar candy lollipop ice_cream',
            ),
            ...list(
                'coffee tea sake baby_bottle beer beers wine_glass cocktail tropical_drink champagne tumbler cup_with_straw bubble_tea milk_glass',
            ),
        ],
    },
    {
        id: 'activity',
        label: 'Activity',
        icon: '⚽',
        emojis: [
            ...list(
                'soccer basketball football baseball tennis volleyball rugby_martial_arts billiards 8ball golf frisbee dart bowling trophy medal_sports1st medal_sports2nd medal_sports3rd rosette 1st_place_medal 2nd_place_medal 3rd_place_medal boxing_glove motorcycle racing car racing_motorcycle',
            ),
            ...list(
                'dart video_game game_die chess pawn bishop knight rook dice musical_note notes headphones microphone guitar musical_keyboard trumpet violin drum art palette',
            ),
        ],
    },
    {
        id: 'places',
        label: 'Travel & Places',
        icon: '✈️',
        emojis: [
            ...list(
                'airplane small_airplane helicopter rocket car taxi bus trolleybus minibus ambulance fire_engine police_car bicycle motorcycle train metro tram station ship boat anchor fuelpump traffic_light construction rotating_light',
            ),
            ...list(
                'house house_with_garden office post_office hospital bank hotel convenience_store school church mosque synagogue castle statue_of_liberty tokyo_tower mount_fuji volcano desert beach_with_umbrella camping tent national_park',
            ),
        ],
    },
    {
        id: 'objects',
        label: 'Objects',
        icon: '💡',
        emojis: [
            ...list(
                'watch iphone calling computer desktop_computer keyboard printer computer_mouse trackball joystick compression floppy_disk cd dvd vhs camera video_camera movie_camera movie_projector film_projector telephone phone telephone_receiver pager fax tv radio satellite_antenna battery electric_plug bulb flashlight candle',
            ),
            ...list(
                'lock unlock key hammer wrench nut_and_bolt gear link paperclip pushpin scissors pen pencil memo books newspaper bookmark label money_with_wings moneybag credit_card gem scales envelope email incoming_envelope package mailbox postbox pencil2',
            ),
            ...list(
                'shopping trolley gift balloon tada confetti_ball bell no_bell mega loudspeaker speaker mag mag_right microscope telescope door bed couch toilet shower bathtub smoking skull bath soap',
            ),
        ],
    },
    {
        id: 'symbols',
        label: 'Symbols',
        icon: '❤️',
        emojis: [
            ...list(
                '100 heavy_check_mark white_check_mark ballot_box_with_check x heavy_multiplication_x plus one two three four five six seven eight nine zero hash asterisk question exclamation warning no_entry stop_sign recycle arrow_up arrow_down arrow_left arrow_right arrow_forward arrow_backward redo repeat',
            ),
            ...list(
                'information_source speech_balloon thought_balloon speech_left speech_right bang exclamation interrobang heavy_exclamation_mark ok_hand ok v hands raised_hands clap pray',
            ),
        ],
    },
    {
        id: 'flags',
        label: 'Flags',
        icon: '🏳️',
        emojis: [
            ...list(
                'checkered_flag triangular_flag_on_post crossing_flags flag_white pirate_flag flag_black flag_rainbow',
            ),
        ],
    },
];

/**
 * `:shortcode:` → unicode. Mattermost's full table first, then the curated extras and the legacy
 * hand-written aliases, which only cover names emoji.json does not carry.
 */
const SHORTCODE_MAP: Record<string, string> = (() => {
    const map: Record<string, string> = {...EMOJI_SHORTCODES, ...EXTRA_EMOJI};
    // Mattermost aliases from the original hand-written table (all still valid characters).
    Object.assign(map, {
        slightly_smiling_face: '🙂',
        rolling_on_the_floor_laughing: '🤣',
        smiley: '😃',
        simple_smile: '🙂',
        '+1': '👍',
        '-1': '👎',
        thumbs_up: '👍',
        thumbs_down: '👎',
        heart_eyes: '😍',
        tada: '🎉',
        warning: '⚠️',
        heavy_check_mark: '✔️',
        red_heart: '❤️',
        coffee: '☕',
        rocket: '🚀',
        fire: '🔥',
    });
    return map;
})();

export function emojiChar(name: string): string | undefined {
    return SHORTCODE_MAP[name];
}

const SHORTCODE_PATTERN = /:([\w+-]+):/g;

/** Replaces known :shortcodes: with unicode characters (fallback renderer only). */
export function replaceShortcodes(text: string): string {
    if (!text || text.indexOf(':') === -1) {
        return text;
    }
    return text.replace(SHORTCODE_PATTERN, (match, name: string) => SHORTCODE_MAP[name] || match);
}

/**
 * Mattermost's formatter knows its bundled emoji.json names, but not every legacy alias our UI
 * accepts. Expand only aliases absent from that host table before passing text to PostUtils.
 */
export function replaceUnsupportedMattermostShortcodes(text: string): string {
    if (!text || text.indexOf(':') === -1) {
        return text;
    }
    return text.replace(SHORTCODE_PATTERN, (match, name: string) => {
        if (Object.prototype.hasOwnProperty.call(EMOJI_SHORTCODES, name)) {
            return match;
        }
        return SHORTCODE_MAP[name] || match;
    });
}

// One whole emoji as a line-breaking unit: base + optional variation selector/skin tone, ZWJ
// chains (👨‍👩‍👧‍👦) and flag pairs (🇷🇪). \p{RI} is not a Unicode property, hence the surrogate-pair
// range for regional indicators. Keycaps (1️⃣) are rare in chat and stay plain text.
const EMOJI_RUN = new RegExp(
    '(\\p{Extended_Pictographic}(?:\\uFE0F|\\uFE0E|\\p{Emoji_Modifier})?(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\uFE0E|\\p{Emoji_Modifier})?)*|[\\u{1F1E6}-\\u{1F1FF}]{2})',
    'u',
);

export interface EmojiPiece {
    emoji: boolean;
    text: string;
}

/**
 * Splits text into plain/emoji pieces (the capturing split makes odd indexes the emoji runs),
 * so message bodies can wrap every emoji — shortcodes already turned into unicode, or typed —
 * into one atomic, uniformly sized box that can never stretch a row or break across lines.
 */
export function splitEmoji(text: string): EmojiPiece[] {
    if (!text) {
        return [];
    }
    const pieces: EmojiPiece[] = [];
    text.split(EMOJI_RUN).forEach((chunk, index) => {
        if (chunk !== '') {
            pieces.push({emoji: index % 2 === 1, text: chunk});
        }
    });
    return pieces;
}

export function searchEmoji(term: string, limit = 60): EmojiEntry[] {
    const lower = term.trim().toLowerCase();
    if (!lower) {
        return [];
    }
    const results: EmojiEntry[] = [];
    const seen = new Set<string>();
    const add = (entry: EmojiEntry) => {
        if (!entry.char || seen.has(entry.name) || results.length >= limit) {
            return;
        }
        seen.add(entry.name);
        results.push(entry);
    };
    for (const category of EMOJI_CATEGORIES) {
        for (const emoji of category.emojis) {
            if (emoji.name.includes(lower)) {
                add(emoji);
                if (results.length >= limit) {
                    return results;
                }
            }
        }
    }
    // The curated categories are only a slice of Mattermost's set: keep searching the full table
    // so every system shortcode (`:space_invader:`, `:technologist:`, …) can be found and picked.
    // Skin-tone copies of a base emoji would flood the list, so they only show for "skin" queries.
    const wantsSkinTone = lower.includes('skin');
    for (const name of Object.keys(SHORTCODE_MAP)) {
        if (!name.includes(lower)) {
            continue;
        }
        if (!wantsSkinTone && name.endsWith('_skin_tone')) {
            continue;
        }
        add({name, char: SHORTCODE_MAP[name]});
        if (results.length >= limit) {
            return results;
        }
    }
    return results;
}
