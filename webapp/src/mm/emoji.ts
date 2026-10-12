// Emoji data for the picker + a small shortcode replacer used by the fallback message renderer.
//
// Mattermost itself renders `:shortcode:` and unicode emoji inside formatted message HTML
// (through PostEmoji + the store), so this table is only needed for the picker and for the
// fallback renderer used when window.PostUtils is unavailable.

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

function list(names: string, chars: string[]): EmojiEntry[] {
    const parts = names.split(' ');
    return parts.map((name, index) => ({name, char: chars[index] || ''})).filter((entry) => !!entry.char);
}

export const EMOJI_CATEGORIES: EmojiCategory[] = [
    {
        id: 'people',
        label: 'Smileys & People',
        icon: '😀',
        emojis: [
            ...list(
                'grinning smile smiley grin grinning_face_with_smiling_eyes laughing satisfied sweat_smile joy rofl slightly_smiling_face wink blush yum sunglasses heart_eyes kissing_heart kissing_heart_face kissing_smiling_eyes kissing_closed_eyes relaxed stuck_out_tongue stuck_out_tongue_winking_eye stuck_out_tongue_closed_eyes zany_face thinking_face raised_eyebrow neutral_face expressionless no_mouth smirk unamused rolling_eyes grimacing lying_face relieved pensive sleepy drooling_face sleeping face_with_thermometer face_with_head_bandage nauseated_face sneezing_face hot_face cold_face woozy_face dizzy_face exploding_head cowboy_hat_face partying_face smiling_imp imp smiling_face_with_halo angel skull ghost alien robot_face hankey poo',
                ['😀', '😄', '😃', '😁', '😆', '😅', '😂', '😊', '😇', '🤣', '🙂', '😉', '😊', '😎', '😍', '😘', '😗', '😙', '😚', '☺️', '😛', '😜', '😝', '🤪', '🤔', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '🤒', '🤕', '🤢', '🤧', '🥵', '🥶', '😵', '😵‍💫', '🤯', '🤠', '🥳', '😈', '👿', '😇', '👼', '💀', '👻', '👽', '🤖', '💩', '💩'],
            ),
            ...list(
                'kissing_face baby boy girl man woman older_man older_woman person_with_blond_hair cop construction_worker_man guardsman detective spy santa claus woman_with_veil bride_prince_with_veil princess prince bathtub baby_chick',
                ['😗', '👶', '👦', '👧', '👨', '👩', '👴', '👵', '👱', '👮', '👷', '💂', '🕵️', '🕵️', '🎅', '👰', '👰', '👸', '🤴', '🛁', '🐤'],
            ),
            ...list(
                'wave raised_back_of_hand ok_hand v thumbsup thumbsdown fist punch left_facing_fist right_facing_fist raised_hand open_hands muscle pray handshake point_up point_down point_left point_right middle_finger writing_hand nail_care selfie clap eyes eye ear nose tongue lips',
                ['👋', '🤚', '👌', '✌️', '👍', '👎', '✊', '👊', '🤛', '🤜', '✋', '👐', '💪', '🙏', '🤝', '☝️', '👇', '👈', '👉', '🖕', '✍️', '💅', '🤳', '👏', '👀', '👁️', '👂', '👃', '👅', '👄'],
            ),
            ...list(
                'heart orange_heart yellow_heart green_heart blue_heart purple_heart black_heart broken_heart two_hearts heartpulse sparkling_heart heart_with_arrow cupid gift_heart couple_with_heart',
                ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💔', '💕', '💗', '💖', '💘', '💝', '💑'],
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
                ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🙈', '🙉', '🙊', '🐒', '🐔', '🐧', '🐤', '🐣', '🐥', '🐦', '🐺', '🐗', '🐴', '🦄', '🐝', '🐛', '🦋', '🐌', '🐞', '🐜', '🕷️', '🦂', '🦀', '🐍', '🦎', '🐢', '🐠', '🐟', '🐡', '🐬', '🐳', '🦈', '🐙', '🐚'],
            ),
            ...list(
                'bouquet cherry_blossom tulip four_leaf_clover rose sunflower hibiscus maple_leaf leaves fallen_leaf herb ear_of_rice seedling evergreen_tree deciduous_tree palm_tree cactus christmas_tree blossom sheaf_of_rice mushroom',
                ['💐', '🌸', '🌷', '🍀', '🌹', '🌻', '🌺', '🍁', '🍃', '🍂', '🌿', '🌾', '🌱', '🌲', '🌳', '🌴', '🌵', '🎄', '🌼', '🌾', '🍄'],
            ),
            ...list(
                'sun moon star star2 sparkles zap cloud snowman snowflake umbrella thermometer fire rainbow ocean droplet earth_americas globe_with_meridians milky_way cyclone foggy',
                ['☀️', '🌙', '⭐', '🌟', '✨', '⚡', '☁️', '⛄', '❄️', '☔', '🌡️', '🔥', '🌈', '🌊', '💧', '🌎', '🌐', '🌌', '🌀', '🌫️'],
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
                ['🍎', '🍏', '🍐', '🍊', '🍋', '🍒', '🍇', '🍓', '🍈', '🍉', '🍑', '🍌', '🍍', '🥝', '🍅', '🍆', '🥑', '🥦', '🥒', '🥕', '🌽', '🌶️', '🥔', '🍠', '🍞', '🥐', '🥖', '🧀', '🥚', '🍳', '🥓', '🥞', '🧇'],
            ),
            ...list(
                'hamburger fries pizza hotdog sandwich taco burrito salad sushi bento rice curry ramen spaghetti meat_on_bone poultry_leg dumpling fortune_cookie popcorn honey_pot cookie birthday_cake cake cupcake chocolate_bar candy lollipop ice_cream',
                ['🍔', '🍟', '🍕', '🌭', '🥪', '🌮', '🌯', '🥗', '🍣', '🍱', '🍚', '🍛', '🍜', '🍝', '🍖', '🍗', '🥟', '🥠', '🍿', '🍯', '🍪', '🎂', '🍰', '🧁', '🍫', '🍬', '🍭', '🍦'],
            ),
            ...list(
                'coffee tea sake baby_bottle beer beers wine_glass cocktail tropical_drink champagne tumbler cup_with_straw bubble_tea milk_glass',
                ['☕', '🍵', '🍶', '🍼', '🍺', '🍻', '🍷', '🍸', '🍹', '🍾', '🥃', '🥤', '🧋', '🥛'],
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
                ['⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🏉', '🎱', '🎱', '⛳', '🥏', '🎯', '🎳', '🏆', '🥇', '🥈', '🥉', '🏵️', '🥇', '🥈', '🥉', '🥊', '🏍️', '🏎️'],
            ),
            ...list(
                'dart video_game game_die chess pawn bishop knight rook dice musical_note notes headphones microphone guitar musical_keyboard trumpet violin drum santa_music art palette',
                ['🎯', '🎮', '🎲', '♟️', '♟️', '♝', '♞', '♜', '🎲', '🎵', '🎶', '🎧', '🎤', '🎸', '🎹', '🎺', '🎻', '🥁', '🎨', '🎨'],
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
                ['✈️', '🛩️', '🚁', '🚀', '🚗', '🚕', '🚌', '🚎', '🚐', '🚑', '🚒', '🚓', '🚲', '🏍️', '🚆', '🚇', '🚊', '🚉', '🚢', '⛵', '⚓', '⛽', '🚦', '🚧', '🚨'],
            ),
            ...list(
                'house house_with_garden office post_office hospital bank hotel convenience_store school church mosque synagogue castle statue_of_liberty tokyo_tower mount_fuji volcano desert beach_with_umbrella camping tent national_park statue_of_liberty',
                ['🏠', '🏡', '🏢', '🏤', '🏥', '🏦', '🏨', '🏪', '🏫', '⛪', '🕌', '🕍', '🏰', '🗽', '🗼', '🗻', '🌋', '🏜️', '🏖️', '🏕️', '⛺', '🏞️', '🗽'],
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
                ['⌚', '📱', '📞', '💻', '🖥️', '⌨️', '🖨️', '🖱️', '🕹️', '🎮', '💾', '💿', '📀', '📼', '📷', '📹', '🎥', '📽️', '🎞️', '☎️', '☎️', '📞', '📟', '📠', '📺', '📻', '📡', '🔋', '🔌', '💡', '🔦', '🕯️'],
            ),
            ...list(
                'lock unlock key hammer wrench nut_and_bolt gear link paperclip pushpin scissors pen pencil memo books newspaper bookmark label money_with_wings moneybag credit_card gem scales envelope email incoming_envelope package mailbox postbox pencil2 paperclip',
                ['🔒', '🔓', '🔑', '🔨', '🔧', '🔩', '⚙️', '🔗', '📎', '📌', '✂️', '🖊️', '✏️', '📝', '📚', '📰', '🔖', '🏷️', '💸', '💰', '💳', '💎', '⚖️', '✉️', '📧', '📨', '📦', '📫', '📮', '✏️', '📎'],
            ),
            ...list(
                'shopping trolley gift balloon tada confetti_ball bell no_bell mega loudspeaker speaker mag mag_right microscope telescope door bed couch toilet shower bathtub smoking skull bath soap',
                ['🛒', '🎁', '🎈', '🎉', '🎊', '🔔', '🔕', '📣', '📢', '🔊', '🔍', '🔎', '🔬', '🔭', '🚪', '🛏️', '🛋️', '🚽', '🚿', '🛁', '🚬', '💀', '🛁', '🧼'],
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
                ['💯', '✔️', '✅', '☑️', '❌', '✖️', '➕', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '0️⃣', '#️⃣', '*️⃣', '❓', '❗', '⚠️', '⛔', '🛑', '♻️', '⬆️', '⬇️', '⬅️', '➡️', '⏩', '⏪', '🔁', '🔂'],
            ),
            ...list(
                'information_source speech_balloon thought_balloon speech_left speech_right bang exclamation interrobang heavy_exclamation_mark ok_hand ok v hands raised_hands clap pray',
                ['ℹ️', '💬', '💭', '🗨️', '🗯️', '❗', '❕', '⁉️', '❗', '🆗', '🆗', '✌️', '🙌', '🙌', '👏', '🙏'],
            ),
        ],
    },
    {
        id: 'flags',
        label: 'Flags',
        icon: '🏳️',
        emojis: [
            ...list(
                'checkered_flag triangular_flag_on_post crossing_flags flag_white pirate_flag flag_black flag_red flag_blue flag_green flag_yellow flag_orange flag_purple flag_rainbow',
                ['🏁', '🚩', '🎌', '🏳️', '🏴‍☠️', '🏴', '🏴', '🏳️‍🌈', '🏳️', '🏳️', '🏳️', '🏳️', '🏳️', '🏳️‍🌈'],
            ),
        ],
    },
];

const SHORTCODE_MAP: Record<string, string> = (() => {
    const map: Record<string, string> = {};
    EMOJI_CATEGORIES.forEach((category) => {
        category.emojis.forEach((emoji) => {
            if (!map[emoji.name]) {
                map[emoji.name] = emoji.char;
            }
        });
    });
    // Mattermost aliases
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

export function searchEmoji(term: string, limit = 60): EmojiEntry[] {
    const lower = term.trim().toLowerCase();
    if (!lower) {
        return [];
    }
    const results: EmojiEntry[] = [];
    for (const category of EMOJI_CATEGORIES) {
        for (const emoji of category.emojis) {
            if (emoji.name.includes(lower)) {
                results.push(emoji);
                if (results.length >= limit) {
                    return results;
                }
            }
        }
    }
    return results;
}
