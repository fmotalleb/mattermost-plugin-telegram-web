// Jalali (Solar Hijri / Persian) calendar — conversion and names, for date display only.
//
// Port of the standard jalaali algorithm (the leap-year break table used by jalaali-js, itself
// derived from Borkowski's work): Gregorian → Jalali date parts. Conversion travels G → J only —
// dates are never *entered* in Jalali here, they are only rendered that way.
//
// Everything works on *local* date parts: the formatters hand over the local year/month/day of a
// timestamp, so a message shows the calendar day the user is looking at, never a UTC-shifted one.

export interface JalaliParts {
    jy: number;
    jm: number;
    jd: number;
}

// Truncating division, exactly like jalaali-js (`~~(a / b)`). NOT Math.floor: g2d/d2g pass
// negative intermediates (gm - 8, 8 - gm) where floor and truncation differ by one.
function div(a: number, b: number): number {
    return Math.trunc(a / b);
}

function mod(a: number, b: number): number {
    return a - Math.trunc(a / b) * b;
}

// Ending years of the leap-cycle spans the conversion walks to find Farvardin 1st.
const BREAKS = [-61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178];

/**
 * Calendar facts of the Jalali year `jy`: its Gregorian year (Jalali year + 621), the day of
 * March on which Farvardin 1st falls, and whether the year is leap (leap days land in Esfand).
 */
function jalCal(jy: number): {gy: number; march: number; leap: number} {
    const bl = BREAKS.length;
    const gy = jy + 621;
    let leapJ = -14;
    let jp = BREAKS[0];
    let jm = 0;
    let jump = 0;
    let leap = -1;
    let march = 0;
    let n = 0;

    if (jy < jp || jy >= BREAKS[bl - 1]) {
        throw new Error(`invalid Jalaali year ${jy}`);
    }

    // Find the limiting years for the Jalaali year jy.
    for (let i = 1; i < bl; i += 1) {
        jm = BREAKS[i];
        jump = jm - jp;
        if (jy < jm) {
            break;
        }
        leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4);
        jp = jm;
    }
    n = jy - jp;

    // Leap years in the Persian calendar since AD 621 up to jy.
    leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
    if (mod(jump, 33) === 4 && jump - n === 4) {
        leapJ += 1;
    }

    // And the same in the Gregorian calendar (until gy).
    const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;

    // Gregorian date of Farvardin the 1st, as a day of March.
    march = 20 + leapJ - leapG;

    // How many years have passed since the last leap year of the span.
    if (jump - n < 6) {
        n = n - jump + div(jump + 4, 33) * 33;
    }
    leap = mod(mod(n + 1, 33) - 1, 4);
    if (leap === -1) {
        leap = 4;
    }
    return {gy, march, leap};
}

/** Gregorian date → Julian day number. */
function g2d(gy: number, gm: number, gd: number): number {
    let d = div((gy + div(gm - 8, 6) + 100100) * 1461, 4)
        + div(153 * mod(gm + 9, 12) + 2, 5)
        + gd - 34840408;
    d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
    return d;
}

/** Julian day number → Gregorian date. */
function d2g(jdn: number): {gy: number; gm: number; gd: number} {
    let j = 4 * jdn + 139361631;
    j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
    const i = div(mod(j, 1461), 4) * 5 + 308;
    const gd = div(mod(i, 153), 5) + 1;
    const gm = mod(div(i, 153), 12) + 1;
    const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
    return {gy, gm, gd};
}

/** Julian day number → Jalali date. */
function d2j(jdn: number): JalaliParts {
    const gy = d2g(jdn).gy;
    let jy = gy - 621;
    const r = jalCal(jy);
    const jdn1f = g2d(gy, 3, r.march);
    let k = jdn - jdn1f;
    let jm: number;
    let jd: number;

    if (k >= 0) {
        if (k <= 185) {
            // The first six months (31 days each).
            jm = 1 + div(k, 31);
            jd = mod(k, 31) + 1;
            return {jy, jm, jd};
        }
        k -= 186;
    } else {
        // Before Farvardin: the previous Jalaali year.
        jy -= 1;
        k += 179;
        if (r.leap === 1) {
            k += 1;
        }
    }
    jm = 7 + div(k, 30);
    jd = mod(k, 30) + 1;
    return {jy, jm, jd};
}

/** Gregorian (year, month, day) → Jalali date parts. */
export function toJalali(gy: number, gm: number, gd: number): JalaliParts {
    return d2j(g2d(gy, gm, gd));
}

/** The Jalali date parts of a timestamp, in the local timezone. */
export function jalaliPartsOf(timestamp: number): JalaliParts {
    const date = new Date(timestamp);
    return toJalali(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

export const JALALI_MONTHS_LONG = [
    'Farvardin', 'Ordibehesht', 'Khordad', 'Tir', 'Mordad', 'Shahrivar',
    'Mehr', 'Aban', 'Azar', 'Dey', 'Bahman', 'Esfand',
];

export const JALALI_MONTHS_SHORT = [
    'Far', 'Ord', 'Kho', 'Tir', 'Mor', 'Sha',
    'Meh', 'Aba', 'Aza', 'Dey', 'Bah', 'Esf',
];
