// =====================================================================
//  ui.js: ikonki, kotki, daty i drobne pomocniki do HTML-a
// =====================================================================

// --- Posiłki ---------------------------------------------------------
export const MEALS = {
  sniadanie: { label: 'Śniadanie', plural: 'Śniadania', icon: 'sun', tint: '#FFF0BF', dot: '#E0A800' },
  obiad: { label: 'Obiad', plural: 'Obiady', icon: 'bowl', tint: '#FFE2D1', dot: '#FF7A3D' },
  kolacja: { label: 'Kolacja', plural: 'Kolacje', icon: 'moon', tint: '#E9E2FF', dot: '#6F4EF0' },
  przekaska: { label: 'Przekąska', plural: 'Przekąski', icon: 'cookie', tint: '#FFDCE8', dot: '#FF6F91' },
};
export const MEAL_ORDER = ['sniadanie', 'obiad', 'kolacja', 'przekaska'];

// --- Bezpieczny tekst w HTML (żeby nikt nie wstrzyknął kodu) ---------
export function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// --- Daty --------------------------------------------------------------
const DAYS = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
const DAYS_SHORT = ['Nd', 'Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So'];
const MONTHS = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia',
  'września', 'października', 'listopada', 'grudnia'];
const MONTHS_SHORT = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];

// Data jako tekst RRRR-MM-DD (w czasie lokalnym telefonu)
export function isoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
export function fromIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}
export function today() {
  return isoDate(new Date());
}
export function addDays(iso, n) {
  const d = fromIso(iso);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}
export function mondayOf(iso) {
  const d = fromIso(iso);
  const shift = (d.getDay() + 6) % 7; // poniedziałek = 0
  d.setDate(d.getDate() - shift);
  return isoDate(d);
}
// „wtorek, 17 listopada”
export function longDate(iso) {
  const d = fromIso(iso);
  return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
// „Wtorek, 17 lis”
export function mediumDate(iso) {
  const d = fromIso(iso);
  const day = DAYS[d.getDay()];
  return `${day[0].toUpperCase()}${day.slice(1)}, ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}
export function shortDay(iso) {
  return DAYS_SHORT[fromIso(iso).getDay()];
}
// „dziś”, „jutro”, „wczoraj” albo „śr 19.11”
export function relativeDay(iso) {
  const t = today();
  if (iso === t) return 'dziś';
  if (iso === addDays(t, 1)) return 'jutro';
  if (iso === addDays(t, -1)) return 'wczoraj';
  const d = fromIso(iso);
  return `${DAYS_SHORT[d.getDay()].toLowerCase()} ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}
// „16–22 listopada” albo „29 grudnia – 4 stycznia”
export function weekRange(mondayIso) {
  const a = fromIso(mondayIso);
  const b = fromIso(addDays(mondayIso, 6));
  if (a.getMonth() === b.getMonth()) return `${a.getDate()}–${b.getDate()} ${MONTHS[b.getMonth()]}`;
  return `${a.getDate()} ${MONTHS[a.getMonth()]} – ${b.getDate()} ${MONTHS[b.getMonth()]}`;
}
export function timeOf(timestamp) {
  const d = new Date(timestamp);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
// Jaki posiłek pasuje do aktualnej godziny
export function mealForNow() {
  const h = new Date().getHours();
  if (h < 11) return 'sniadanie';
  if (h < 16) return 'obiad';
  return 'kolacja';
}

// --- Ikonki (rysowane kreską) ------------------------------------------
const ICONS = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  bowl: '<path d="M3 11h18a9 9 0 0 1-18 0Z"/><path d="M8 7.5c0-1.5 1-2 1-3.5M12 7.5c0-1.5 1-2 1-3.5M16 7.5c0-1.5 1-2 1-3.5"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>',
  cookie: '<circle cx="12" cy="12" r="9"/><circle cx="9" cy="9" r="1.2" fill="currentColor" stroke="none"/><circle cx="14.5" cy="14.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="8.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="8.5" cy="15" r="1.2" fill="currentColor" stroke="none"/>',
  plate: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5Z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
  basket: '<path d="M3 9h18l-2 11H5Z"/><path d="M8 9l4-6 4 6"/><path d="M9 13v3M15 13v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  chat: '<path d="M4 5h16v11H9l-5 4Z"/>',
  send: '<path d="M4 12l16-8-6 16-3-7Z"/><path d="M11 13l9-9"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  swap: '<path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  left: '<path d="M15 6l-6 6 6 6"/>',
  fridge: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M6 10h12M9 5v2M9 13v3"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4Z"/><path d="M10 21h4"/>',
  share: '<path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 12v8h14v-8"/>',
  logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11"/>',
};

export function icon(name, size = 20, strokeWidth = 2) {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

export function dice(size = 20) {
  const dots = [[8.5, 8.5], [15.5, 8.5], [12, 12], [8.5, 15.5], [15.5, 15.5]]
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.4" fill="currentColor" stroke="none"/>`).join('');
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/>${dots}</svg>`;
}

export function paw(size = 18, color = 'currentColor') {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${color}" aria-hidden="true"><ellipse cx="12" cy="16" rx="5" ry="4.2"/><ellipse cx="5.8" cy="10.2" rx="2.1" ry="2.6"/><ellipse cx="9.6" cy="6.2" rx="2.1" ry="2.6"/><ellipse cx="14.4" cy="6.2" rx="2.1" ry="2.6"/><ellipse cx="18.2" cy="10.2" rx="2.1" ry="2.6"/></svg>`;
}

// --- Kotki -------------------------------------------------------------
export const CATS = {
  ruda: { label: 'Ruda', fur: '#FF8A4C', ear: '#FFC9B0', stripe: '#C9531F', eye: '#2A1E3F', bg: '#FFE2D1' },
  szara: { label: 'Szara', fur: '#9C97B5', ear: '#E6DDF5', stripe: '#5F5A7A', eye: '#2A1E3F', bg: '#E9E2FF' },
  czarna: { label: 'Czarna', fur: '#3A3350', ear: '#8E7BA8', stripe: '#241E33', eye: '#FFD166', bg: '#FFF0BF' },
  biala: { label: 'Biała', fur: '#FFFFFF', ear: '#FFC9D6', stripe: '#E3D5C7', eye: '#2A1E3F', bg: '#D7F3E5' },
};

export function cat(size = 40, kind = 'ruda', label = '') {
  const c = CATS[kind] || CATS.ruda;
  const a11y = label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"';
  return `<svg width="${size}" height="${size}" viewBox="0 0 64 64" ${a11y}>
<path d="M10 30 L12 7 L25 18 Q32 16 39 18 L52 7 L54 30 Q58 46 46 53 Q40 57 32 57 Q24 57 18 53 Q6 46 10 30 Z" fill="${c.fur}" stroke="#2A1E3F" stroke-width="2.5" stroke-linejoin="round"/>
<path d="M15 14 L17 24 L23 19 Z" fill="${c.ear}"/><path d="M49 14 L47 24 L41 19 Z" fill="${c.ear}"/>
<path d="M32 21 V27 M27 22 L28 27 M37 22 L36 27" stroke="${c.stripe}" stroke-width="2.5" stroke-linecap="round" fill="none"/>
<ellipse cx="23" cy="36" rx="3.2" ry="4.2" fill="${c.eye}"/><ellipse cx="41" cy="36" rx="3.2" ry="4.2" fill="${c.eye}"/>
<circle cx="24.2" cy="34.4" r="1.1" fill="#FFFFFF"/><circle cx="42.2" cy="34.4" r="1.1" fill="#FFFFFF"/>
<path d="M29.5 42 H34.5 L32 45 Z" fill="#FF6F91"/>
<path d="M32 45 Q30 48 27 47 M32 45 Q34 48 37 47" fill="none" stroke="${kind === 'czarna' ? '#E6DDF5' : '#2A1E3F'}" stroke-width="1.8" stroke-linecap="round"/>
<circle cx="17" cy="44" r="3" fill="#FF6F91" fill-opacity="0.35"/><circle cx="47" cy="44" r="3" fill="#FF6F91" fill-opacity="0.35"/>
<path d="M4 39 H14 M5 45 L14 43 M60 39 H50 M59 45 L50 43" stroke="#2A1E3F" stroke-width="1.6" stroke-linecap="round" fill="none"/>
</svg>`;
}

// Okrągły awatar osoby z jej kotkiem
export function avatar(person, size = 40) {
  const kind = person?.cat || 'ruda';
  const bg = (CATS[kind] || CATS.ruda).bg;
  const border = size <= 24 ? 1.5 : 2;
  return `<span class="avatar" style="width:${size}px;height:${size}px;background:${bg};border-width:${border}px">${cat(Math.round(size * 0.8), kind, person?.name || '')}</span>`;
}

// Kafelek z ikonką posiłku
export function mealTile(mealType, size = 44, iconSize = 22) {
  const m = MEALS[mealType] || MEALS.obiad;
  return `<span class="tile" style="width:${size}px;height:${size}px;background:${m.tint}">${icon(m.icon, iconSize)}</span>`;
}

export function mealPill(mealType) {
  const m = MEALS[mealType] || MEALS.obiad;
  return `<span class="pill" style="background:${m.tint}">${icon(m.icon, 15, 2.2)}${m.label}</span>`;
}
