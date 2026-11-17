// =====================================================================
//  app.js: cała logika Hungrycatora
//
//  Jak to działa w skrócie:
//  - Adres po znaku # mówi, który ekran pokazać (np. #/baza, #/plan).
//  - Każdy ekran to funkcja `screen…`, która pobiera dane z Supabase
//    i zwraca kawałek HTML-a.
//  - Kliknięcia obsługują `actions` (przyciski z data-action="…"),
//    a formularze obsługują `forms` (formularze z data-form="…").
//  - Gdy druga osoba coś zmieni, Supabase Realtime daje znać
//    i ekran sam się odświeża.
// =====================================================================
import { sb, CONFIG_OK } from './db.js';
import { VAPID_PUBLIC_KEY } from './config.js';
import {
  MEALS, MEAL_ORDER, CATS, esc, today, addDays, mondayOf, longDate, mediumDate, shortDay,
  relativeDay, weekRange, timeOf, isoDate, mealForNow, icon, dice, paw, cat, avatar, mealTile, mealPill,
} from './ui.js';

const app = document.getElementById('app');

const state = {
  session: null,       // zalogowana sesja
  me: null,            // mój profil
  partner: null,       // profil drugiej osoby
  people: {},          // wszystkie profile: id → profil
  loginMode: 'login',  // 'login' albo 'register'
  loginError: '',
  dishes: [],          // baza dań (do podpowiedzi przy nowej propozycji)
  random: null,        // ostatnio wylosowane danie: { pool, id, ids }
  wobble: false,       // animacja kotka przy losowaniu
  ideaFormOpen: false, // czy formularz „Nowy pomysł” jest otwarty
  channel: null,       // połączenie Realtime
  registering: false,  // trwa zakładanie konta
};

const QUICK_REPLIES = ['Mniam!', 'Pasuje', 'Może jutro?'];
const MEAL_ACC = { sniadanie: 'śniadanie', obiad: 'obiad', kolacja: 'kolację', przekaska: 'przekąskę' };
const ACTIVE = ['czeka', 'zaakceptowana'];

// =====================================================================
//  Pomocniki
// =====================================================================

// Wykonaj zapytanie do bazy; przy błędzie rzuć wyjątek
async function run(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

function person(id) {
  return state.people[id] || { name: 'Ktoś', cat: 'szara' };
}

function isMine(row) {
  return row.author === state.me.id;
}

// Polska odmiana: 1 propozycja, 2 propozycje, 5 propozycji
function plural(n, one, few, many) {
  if (n === 1) return one;
  const d = n % 10;
  const h = n % 100;
  return d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
}

function timeLabel(timestamp) {
  const day = isoDate(new Date(timestamp));
  return day === today() ? timeOf(timestamp) : `${relativeDay(day)}, ${timeOf(timestamp)}`;
}

let toastTimer = null;
function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
}

function showError(err) {
  console.error(err);
  toast(`Ups: ${err?.message || err}`);
}

// Komunikaty logowania po polsku
function polishAuthError(error) {
  const m = error?.message || '';
  if (/invalid login credentials/i.test(m)) return 'Nieprawidłowy e-mail lub hasło.';
  if (/already (been )?registered|already exists/i.test(m)) return 'Konto z tym adresem już istnieje. Zaloguj się.';
  if (/signups? not allowed|signup.*disabled/i.test(m)) return 'Zakładanie nowych kont jest wyłączone.';
  if (/password should be at least/i.test(m)) return 'Hasło musi mieć co najmniej 6 znaków.';
  if (/email not confirmed/i.test(m)) return 'Najpierw potwierdź adres e-mail (sprawdź skrzynkę).';
  if (/rate limit|too many/i.test(m)) return 'Za dużo prób. Spróbuj za chwilę.';
  if (/invalid.*email|email.*invalid/i.test(m)) return 'Ten adres e-mail wygląda na niepoprawny.';
  return m || 'Coś poszło nie tak.';
}

// =====================================================================
//  Powiadomienia (Web Push)
// =====================================================================
function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

// 'needs-install' | 'unsupported' | 'denied' | 'granted' | 'default'
function pushStatus() {
  if (isIOS() && !isInstalled()) return 'needs-install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

function base64ToBytes(base64) {
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function saveSubscription(subscription) {
  const json = subscription.toJSON();
  await run(sb.from('push_subscriptions').upsert(
    { user_id: state.me.id, endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth },
    { onConflict: 'endpoint' },
  ));
}

async function currentSubscription() {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg && 'pushManager' in reg ? reg.pushManager.getSubscription() : null;
}

// Po zalogowaniu po cichu upewnij się, że baza zna adres tego telefonu
async function syncPush() {
  try {
    if (pushStatus() !== 'granted') return;
    const sub = await currentSubscription();
    if (sub) await saveSubscription(sub);
  } catch (e) {
    console.warn('Nie udało się zsynchronizować powiadomień', e);
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('Service worker:', e));
  // Stuknięcie w powiadomienie, gdy apka jest już otwarta
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'open' && event.data.hash) location.hash = event.data.hash;
  });
}

// =====================================================================
//  Logowanie i profile
// =====================================================================
async function loadPeople() {
  const uid = state.session.user.id;
  const rows = await run(sb.from('profiles').select('*').order('created_at'));
  state.people = Object.fromEntries(rows.map((r) => [r.id, r]));
  state.me = state.people[uid] || null;
  state.partner = rows.find((r) => r.id !== uid) || null;
}

function startRealtime() {
  if (state.channel) return;
  state.channel = sb
    .channel('hungrycator')
    .on('postgres_changes', { event: '*', schema: 'public' }, (payload) => {
      if (payload.table === 'profiles') loadPeople().then(scheduleRefresh).catch(console.warn);
      else scheduleRefresh();
    })
    .subscribe();
}

function stopRealtime() {
  if (state.channel) sb.removeChannel(state.channel);
  state.channel = null;
}

async function afterLogin() {
  state.loginMode = 'login';
  state.loginError = '';
  await loadPeople();
  if (state.me) {
    startRealtime();
    syncPush();
  }
}

// =====================================================================
//  Rysowanie ekranu
// =====================================================================
let renderToken = 0;
let lastKey = '';
let refreshTimer = null;
let refreshPending = false;

function parseRoute() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  return {
    key: raw,
    parts: path.split('/').filter(Boolean),
    params: Object.fromEntries(new URLSearchParams(query)),
  };
}

async function screenFor({ parts, params }) {
  switch (parts[0]) {
    case 'dzien': return screenDay(/^\d{4}-\d{2}-\d{2}$/.test(parts[1] || '') ? parts[1] : today());
    case 'nowa': return screenNew(params);
    case 'propozycja': return screenProposal(Number(parts[1]));
    case 'baza': return screenBase(params);
    case 'losuj': return screenRandom(params);
    case 'plan': return screenPlan(params);
    case 'zakupy': return screenShopping();
    case 'ja': return screenSettings();
    default: return screenDay(today());
  }
}

async function render() {
  const token = ++renderToken;
  const route = parseRoute();
  let html;
  let key = route.key;
  if (!CONFIG_OK) {
    html = screenNoConfig();
  } else if (!state.session) {
    html = screenLogin();
    key = 'login';
  } else if (!state.me) {
    html = screenProfileSetup();
    key = 'profile';
  } else {
    try {
      html = await screenFor(route);
    } catch (err) {
      console.error(err);
      html = screenError(err);
    }
  }
  if (token !== renderToken) return; // w międzyczasie zaczęło się nowsze rysowanie
  paint(html, key);
}

// Podmień zawartość ekranu, zachowując wpisany tekst i pozycję przewijania
function paint(html, key) {
  const same = key === lastKey;
  const kept = {};
  const checked = {};
  let focusId = null;
  if (same) {
    app.querySelectorAll('[data-keep]').forEach((el) => { if (el.id && el.value) kept[el.id] = el.value; });
    app.querySelectorAll('input[type="radio"]:checked').forEach((el) => { checked[el.name] = el.value; });
    const active = document.activeElement;
    if (active && app.contains(active) && active.id) focusId = active.id;
  }
  const y = window.scrollY;
  app.innerHTML = html;
  for (const [name, value] of Object.entries(checked)) {
    const el = app.querySelector(`input[type="radio"][name="${name}"][value="${value}"]`);
    if (el) el.checked = true;
  }
  for (const [id, value] of Object.entries(kept)) {
    const el = document.getElementById(id);
    if (el) {
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true });
  window.scrollTo(0, same ? y : 0);
  lastKey = key;
}

function isTyping() {
  const a = document.activeElement;
  return !!a && app.contains(a) && (a.tagName === 'TEXTAREA'
    || (a.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes(a.type)));
}

// Odśwież po zmianie w bazie, ale nie w trakcie pisania
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (isTyping()) {
      refreshPending = true;
      return;
    }
    render();
  }, 250);
}

// =====================================================================
//  Wspólne kawałki ekranów
// =====================================================================
function tabbar(active) {
  const tab = (key, label, ic, href) => {
    const on = active === key;
    return `<a class="tab" href="${href}" ${on ? 'aria-current="page"' : ''}><span class="pillbg">${icon(ic, 22, on ? 2.3 : 2)}</span><span>${label}</span></a>`;
  };
  return `<nav class="tabbar" aria-label="Zakładki"><div class="inner">
    ${tab('dzis', 'Dziś', 'plate', '#/')}
    ${tab('plan', 'Plan', 'calendar', '#/plan')}
    <a class="tab-add" href="#/nowa" aria-label="Nowa propozycja">${icon('plus', 28, 2.6)}</a>
    ${tab('baza', 'Baza dań', 'book', '#/baza')}
    ${tab('zakupy', 'Zakupy', 'basket', '#/zakupy')}
  </div></nav>`;
}

function backButton(href) {
  return `<a class="round" href="${href}" data-action="back" aria-label="Wróć">${icon('left', 22, 2.4)}</a>`;
}

function profileFields(name = '', kind = 'ruda') {
  const options = Object.entries(CATS).map(([k, c]) => `
    <label class="cat-option"><input type="radio" name="cat" value="${k}" ${k === kind ? 'checked' : ''}>
      <span class="box">${cat(40, k)}${c.label}</span></label>`).join('');
  return `
    <label class="label" for="f-name">Twoje imię</label>
    <input class="field" id="f-name" name="name" maxlength="40" required autocomplete="given-name" value="${esc(name)}" data-keep>
    <fieldset class="stack" style="border:0;margin:0;padding:0">
      <legend class="label" style="margin-bottom:8px">Twój kotek</legend>
      <div class="cat-grid">${options}</div>
    </fieldset>`;
}

function screenNoConfig() {
  return `<section class="screen no-tabs login">
    <div class="brand">${cat(96)}<h1>Prawie gotowe!</h1>
      <p class="kicker">Uzupełnij plik <b>config.js</b> adresem i kluczem z Supabase, a potem odśwież stronę.</p></div>
  </section>`;
}

function screenError(err) {
  return `<section class="screen">
    <div class="dashed stack" style="align-items:center;text-align:center;gap:12px;margin-top:20vh">
      ${cat(72, 'szara')}
      <h2 style="font-size:22px">Coś poszło nie tak</h2>
      <p class="muted">${esc(err?.message || err)}</p>
      <button class="btn primary" data-action="retry">Spróbuj ponownie</button>
    </div>
  </section>${tabbar('')}`;
}

// =====================================================================
//  Ekran: logowanie / rejestracja
// =====================================================================
function screenLogin() {
  const reg = state.loginMode === 'register';
  return `<section class="screen no-tabs login">
    <div class="brand">${cat(96)}<h1>Hungrycator</h1>
      <p class="kicker">Co dziś jemy? Kotek pomoże zdecydować.</p></div>
    <div class="row" style="justify-content:center;gap:8px">
      <button class="chip" type="button" data-action="login-mode" data-mode="login" aria-pressed="${!reg}">Logowanie</button>
      <button class="chip" type="button" data-action="login-mode" data-mode="register" aria-pressed="${reg}">Nowe konto</button>
    </div>
    <form class="stack" data-form="${reg ? 'register' : 'login'}">
      ${reg ? profileFields() : ''}
      <label class="label" for="f-email">E-mail</label>
      <input class="field" id="f-email" name="email" type="email" autocomplete="email" required data-keep>
      <label class="label" for="f-pass">Hasło ${reg ? '<span style="text-transform:none;letter-spacing:0">(min. 6 znaków)</span>' : ''}</label>
      <input class="field" id="f-pass" name="password" type="password" minlength="6" required
        autocomplete="${reg ? 'new-password' : 'current-password'}">
      ${state.loginError ? `<p class="error" role="alert">${esc(state.loginError)}</p>` : ''}
      <button class="btn primary big full" type="submit" style="margin-top:8px">${reg ? 'Załóż konto' : 'Zaloguj się'}</button>
    </form>
  </section>`;
}

function screenProfileSetup() {
  return `<section class="screen no-tabs login">
    <div class="brand">${cat(80)}<h1>Prawie gotowe!</h1>
      <p class="kicker">Jak masz na imię i który kotek jest Twój?</p></div>
    <form class="stack" data-form="profile">
      ${profileFields()}
      <button class="btn primary big full" type="submit" style="margin-top:8px">Zapisz</button>
    </form>
    <button class="btn ghost" type="button" data-action="logout">Wyloguj</button>
  </section>`;
}

// =====================================================================
//  Ekran: Dziś (albo dowolny dzień)
// =====================================================================
async function screenDay(day) {
  const t = today();
  const proposals = await run(sb.from('proposals').select('*').eq('day', day).in('status', ACTIVE).order('created_at'));
  const ids = proposals.map((p) => p.id);
  const messages = ids.length ? await run(sb.from('messages').select('id, proposal_id').in('proposal_id', ids)) : [];
  const chatCount = {};
  messages.forEach((m) => { chatCount[m.proposal_id] = (chatCount[m.proposal_id] || 0) + 1; });

  const decided = MEAL_ORDER.filter((m) => proposals.some((p) => p.meal_type === m && p.status === 'zaakceptowana')).length;
  const paws = MEAL_ORDER.map((_, i) => paw(18, i < decided ? '#FF7A3D' : '#E3D5C7')).join('');
  const title = day === t ? 'Co dziś jemy?' : day === addDays(t, 1) ? 'Co jutro jemy?' : 'Co jemy?';
  const meals = MEAL_ORDER.map((m) => mealSection(m, day, proposals.filter((p) => p.meal_type === m), chatCount)).join('');

  return `<section class="screen">
    <header class="page-head" style="align-items:center">
      <div class="grow">
        <p class="kicker">Cześć, ${esc(state.me.name)} · ${longDate(day)}</p>
        <h1>${title}</h1>
      </div>
      <a class="avatars" href="#/ja" aria-label="Profil i ustawienia">${avatar(state.me, 42)}${state.partner ? avatar(state.partner, 42) : ''}</a>
    </header>
    <div class="row wrap" style="justify-content:space-between">
      <div class="row" style="gap:8px">
        <span class="row" style="gap:3px">${paws}</span>
        <span style="font-size:14px;font-weight:700">${decided} z 4 ustalone</span>
      </div>
      <div class="row" style="gap:6px">
        ${day !== t ? '<a class="chip" href="#/" style="min-height:44px">Dziś</a>' : ''}
        <a class="round" href="#/dzien/${addDays(day, -1)}" aria-label="Poprzedni dzień">${icon('left', 20, 2.4)}</a>
        <a class="round" href="#/dzien/${addDays(day, 1)}" aria-label="Następny dzień">${icon('right', 20, 2.4)}</a>
      </div>
    </div>
    ${day === t ? pushHint() : ''}
    ${meals}
  </section>${tabbar(day === t ? 'dzis' : 'plan')}`;
}

function mealSection(meal, day, list, chatCount) {
  const accepted = list.find((p) => p.status === 'zaakceptowana');
  const pending = list.filter((p) => p.status === 'czeka');
  let html = '';
  if (accepted) html += acceptedCard(accepted, chatCount[accepted.id] || 0);
  if (pending.length > 1 && !accepted) {
    html += `<p class="small-label" style="margin:6px 0 -4px">${MEALS[meal].label}: ${pending.length} ${plural(pending.length, 'propozycja', 'propozycje', 'propozycji')}, wybierzcie jedną</p>`;
  }
  pending.forEach((p) => { html += pendingCard(p, chatCount[p.id] || 0, !!accepted); });
  if (!accepted && !pending.length) html += emptyMealCard(meal, day);
  return html;
}

function acceptedCard(p, chats) {
  return `<a class="card card-link" href="#/propozycja/${p.id}">
    ${mealTile(p.meal_type)}
    <div class="grow">
      <span class="small-label">${MEALS[p.meal_type].label}</span>
      <div class="dish-name">${esc(p.dish_name)}</div>
      <span class="muted" style="font-size:13px;font-weight:700">od: ${esc(person(p.author).name)}${chats ? ` · ${chats} ${plural(chats, 'wiadomość', 'wiadomości', 'wiadomości')}` : ''}</span>
    </div>
    <span class="pill ok">${icon('check', 14, 3)}Ustalone</span>
  </a>`;
}

function pendingCard(p, chats, replacesAccepted) {
  const mine = isMine(p);
  const author = person(p.author);
  const actions = mine
    ? `<div class="btn-row"><button class="btn small" type="button" data-action="withdraw" data-id="${p.id}">${icon('trash', 18)}Wycofaj</button></div>`
    : `<div class="btn-row">
        <button class="btn primary" type="button" data-action="accept" data-id="${p.id}" style="flex:1.25">${icon('check', 18, 2.6)}Akceptuj</button>
        <button class="btn" type="button" data-action="reject" data-id="${p.id}">${icon('x', 18, 2.4)}Odrzuć</button>
        <a class="btn" href="#/nowa?dzien=${p.day}&posilek=${p.meal_type}">${icon('swap', 18, 2.2)}Inna</a>
      </div>`;
  return `<article class="sticker stack" style="gap:12px">
    <div class="row" style="justify-content:space-between">
      <div class="row">
        ${mealTile(p.meal_type, 40, 20)}
        <div>
          <div class="small-label">${MEALS[p.meal_type].label}${replacesAccepted ? ' · zamiana?' : ''}</div>
          <div style="font-size:14px;font-weight:700">od: ${esc(author.name)} · ${timeOf(p.created_at)}</div>
        </div>
      </div>
      <span class="pill wait">${mine ? 'Czeka na odpowiedź' : 'Czeka na Ciebie'}</span>
    </div>
    <h2 class="dish-big">${esc(p.dish_name)}</h2>
    ${p.comment ? `<div class="row" style="align-items:flex-start;gap:8px">${avatar(author, 30)}<p class="bubble-note">${esc(p.comment)}</p></div>` : ''}
    ${actions}
    <a class="row" href="#/propozycja/${p.id}" style="min-height:44px;font-weight:800;font-size:14px;text-decoration:none;color:var(--violet-text)">
      ${icon('chat', 18)}${chats ? `Rozmowa (${chats})` : 'Odpowiedz w rozmowie'}<span style="margin-left:auto;display:inline-flex">${icon('right', 18)}</span>
    </a>
  </article>`;
}

function emptyMealCard(meal, day) {
  return `<article class="dashed stack" style="gap:12px">
    <div class="row" style="gap:12px">${mealTile(meal)}
      <div><span class="small-label">${MEALS[meal].label}</span><div class="dish-name">Jeszcze nic nie ma</div></div>
    </div>
    <div class="btn-row">
      <a class="btn small" href="#/nowa?dzien=${day}&posilek=${meal}">${icon('plus', 18, 2.4)}Zaproponuj</a>
      <a class="btn small violet" href="#/losuj?pula=${meal}&dzien=${day}" style="flex:1.25">${dice(18)}Kotek wylosuje</a>
    </div>
  </article>`;
}

function pushHint() {
  let hidden = false;
  try { hidden = localStorage.getItem('hc-hint-hidden') === '1'; } catch (e) { /* tryb prywatny */ }
  const status = pushStatus();
  if (hidden || !['needs-install', 'default'].includes(status)) return '';
  const text = status === 'needs-install'
    ? 'Dodaj Hungrycatora do ekranu początkowego, żeby dostawać powiadomienia o propozycjach.'
    : 'Włącz powiadomienia, żeby wiedzieć, kiedy pojawi się nowa propozycja.';
  return `<div class="card hint">
    ${icon('bell', 22)}
    <div class="grow stack" style="gap:6px">
      <p style="font-size:14px;font-weight:700;line-height:1.35">${text}</p>
      <a href="#/ja" style="font-weight:800;font-size:14px">Pokaż jak</a>
    </div>
    <button class="icon-btn" type="button" data-action="hide-hint" aria-label="Ukryj podpowiedź">${icon('x', 18)}</button>
  </div>`;
}

// =====================================================================
//  Ekran: Nowa propozycja
// =====================================================================
async function screenNew(params) {
  const t = today();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params.dzien || '') ? params.dzien : t;
  const meal = MEALS[params.posilek] ? params.posilek : mealForNow();
  const dish = params.danie || '';
  state.dishes = await run(sb.from('dishes').select('id, name, meal_type').order('created_at', { ascending: false }));

  const mealOptions = MEAL_ORDER.map((m) => `
    <label class="meal-option" style="--sel:${MEALS[m].tint}">
      <input type="radio" name="meal" value="${m}" ${m === meal ? 'checked' : ''}>
      <span class="box">${mealTile(m, 38, 20)}${MEALS[m].label}</span>
    </label>`).join('');

  return `<section class="screen no-tabs">
    <header class="topbar">${backButton('#/')}<h1>Nowa propozycja</h1>${avatar(state.me, 40)}</header>
    <form class="stack" style="gap:18px" data-form="new">
      <div class="stack">
        <label class="label" for="f-day">Na kiedy?</label>
        <div class="row wrap" style="gap:8px">
          <button class="chip" type="button" data-action="set-day" data-day="${t}" aria-pressed="${day === t}">Dziś</button>
          <button class="chip" type="button" data-action="set-day" data-day="${addDays(t, 1)}" aria-pressed="${day === addDays(t, 1)}">Jutro</button>
          <input class="field" style="flex:1;min-width:150px;width:auto" type="date" id="f-day" name="day" value="${day}" required data-keep>
        </div>
      </div>
      <fieldset class="stack" style="border:0;margin:0;padding:0">
        <legend class="label" style="margin-bottom:8px">Jaki posiłek?</legend>
        <div class="meal-grid">${mealOptions}</div>
      </fieldset>
      <div class="stack">
        <label class="label" for="f-dish">Co proponujesz?</label>
        <input class="field strong" id="f-dish" name="dish" maxlength="80" required autocomplete="off"
          placeholder="np. Pierogi ruskie" value="${esc(dish)}" data-keep>
        <div id="suggestions">${suggestionsHtml(meal, dish)}</div>
      </div>
      <div class="stack">
        <label class="label" for="f-comment">Komentarz <span style="text-transform:none;letter-spacing:0">(opcjonalnie)</span></label>
        <textarea class="field" id="f-comment" name="comment" maxlength="500" rows="2" placeholder="np. Mam ochotę na coś ciepłego" data-keep></textarea>
      </div>
      <div class="card switch-row">
        <span class="row" style="font-weight:700;gap:10px">${icon('book', 20)}Zapisz też w bazie dań</span>
        <label class="switch"><input type="checkbox" name="save" checked aria-label="Zapisz też w bazie dań"><span></span></label>
      </div>
      <div class="stack" style="gap:4px;margin-top:4px">
        <button class="btn primary big full" type="submit">${icon('send', 20, 2.4)}Wyślij propozycję</button>
        <button class="btn ghost full" type="button" data-action="save-idea">Tylko zapisz na kiedyś</button>
      </div>
    </form>
  </section>`;
}

function suggestionsHtml(meal, typed) {
  const text = (typed || '').trim().toLowerCase();
  const list = state.dishes
    .filter((d) => d.meal_type === meal && d.name.toLowerCase() !== text && (!text || d.name.toLowerCase().includes(text)))
    .slice(0, 8);
  if (!list.length) return '';
  return `<div class="row" style="gap:6px;overflow:hidden">
    <span class="muted" style="font-size:13px;font-weight:700;flex-shrink:0">Z bazy:</span>
    <div class="chips" style="margin:0;padding:2px 0 4px">${list.map((d) => `<button class="chip dashed-chip" type="button" data-action="pick-dish" data-name="${esc(d.name)}">${esc(d.name)}</button>`).join('')}</div>
  </div>`;
}

function updateSuggestions() {
  const box = document.getElementById('suggestions');
  if (!box) return;
  const meal = app.querySelector('input[name="meal"]:checked')?.value || 'obiad';
  box.innerHTML = suggestionsHtml(meal, document.getElementById('f-dish')?.value);
}

function updateDayChips() {
  const value = document.getElementById('f-day')?.value;
  app.querySelectorAll('[data-action="set-day"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.day === value)));
}

// Dodaj danie do bazy, jeśli jeszcze go tam nie ma. Zwraca true, gdy dodano.
async function saveDishIfNew(name, meal, tags = []) {
  const existing = await run(sb.from('dishes').select('id, name'));
  const clean = name.trim().toLowerCase();
  if (existing.some((d) => d.name.trim().toLowerCase() === clean)) return false;
  await run(sb.from('dishes').insert({ name: name.trim(), meal_type: meal, tags }));
  return true;
}

// =====================================================================
//  Ekran: szczegóły propozycji (akceptacja, składniki, rozmowa)
// =====================================================================
async function screenProposal(id) {
  const p = Number.isFinite(id) ? await run(sb.from('proposals').select('*').eq('id', id).maybeSingle()) : null;
  if (!p) {
    return `<section class="screen"><header class="topbar">${backButton('#/')}<h1>Propozycja</h1><span style="width:44px"></span></header>
      <div class="dashed stack" style="align-items:center;text-align:center">${cat(64, 'szara')}<p class="muted">Tej propozycji już nie ma.</p></div>
    </section>${tabbar('')}`;
  }
  const [messages, ingredients] = await Promise.all([
    run(sb.from('messages').select('*').eq('proposal_id', id).order('created_at')),
    run(sb.from('ingredients').select('*').eq('proposal_id', id).order('id')),
  ]);
  const author = person(p.author);
  const mine = isMine(p);

  // Dymki rozmowy: komentarz z propozycji jest pierwszą wiadomością
  const thread = [];
  if (p.comment) thread.push({ author: p.author, body: p.comment, created_at: p.created_at });
  thread.push(...messages);
  const chat = thread.map((m) => {
    if (m.author === state.me.id) {
      return `<div class="msg mine"><p>${esc(m.body)}</p><small>Ty · ${timeLabel(m.created_at)}</small></div>`;
    }
    const who = person(m.author);
    return `<div class="msg theirs">${avatar(who, 30)}<div class="stack" style="gap:3px"><p>${esc(m.body)}</p><small>${esc(who.name)} · ${timeLabel(m.created_at)}</small></div></div>`;
  }).join('');

  return `<section class="screen">
    <header class="topbar">${backButton(`#/dzien/${p.day}`)}<h1>${MEALS[p.meal_type].label} · ${relativeDay(p.day)}</h1><span style="width:44px"></span></header>
    <article class="sticker stack" style="gap:10px">
      <div class="row" style="gap:8px">${mealPill(p.meal_type)}<span class="muted" style="font-size:13px;font-weight:700">${longDate(p.day)}</span></div>
      <h2 class="dish-big" style="font-size:30px">${esc(p.dish_name)}</h2>
      <div class="row" style="gap:8px;font-size:14px;font-weight:700">${avatar(author, 28)}Proponuje: ${esc(author.name)}, ${timeLabel(p.created_at)}</div>
      ${statusBox(p, mine)}
    </article>
    ${p.status === 'zaakceptowana' ? ingredientsSection(p, ingredients) : ''}
    <section class="section">
      <h2>Rozmowa</h2>
      ${thread.length ? `<div class="chat">${chat}</div>` : '<p class="muted">Napiszcie coś o tym daniu.</p>'}
      <div class="chips">${QUICK_REPLIES.map((q) => `<button class="chip" type="button" data-action="quick" data-id="${p.id}" data-text="${esc(q)}">${esc(q)}</button>`).join('')}</div>
      <form class="chat-form" data-form="message" data-id="${p.id}">
        <label class="sr-only" for="f-msg">Wiadomość</label>
        <input class="field" id="f-msg" name="body" placeholder="Napisz wiadomość…" maxlength="1000" autocomplete="off" required data-keep>
        <button class="send-btn" type="submit" aria-label="Wyślij wiadomość">${icon('send', 20, 2.2)}</button>
      </form>
    </section>
  </section>${tabbar('')}`;
}

function statusBox(p, mine) {
  const box = (cls, ic, text) => `<div class="row" style="gap:8px;padding:10px 12px;border-radius:14px;font-size:14px;font-weight:800;${cls}">${ic}${text}</div>`;
  if (p.status === 'czeka' && !mine) {
    return `<div class="btn-row" style="margin-top:4px">
      <button class="btn primary" type="button" data-action="accept" data-id="${p.id}" style="flex:1.25">${icon('check', 18, 2.6)}Akceptuj</button>
      <button class="btn" type="button" data-action="reject" data-id="${p.id}">${icon('x', 18, 2.4)}Odrzuć</button>
      <a class="btn" href="#/nowa?dzien=${p.day}&posilek=${p.meal_type}">${icon('swap', 18, 2.2)}Inna</a>
    </div>`;
  }
  if (p.status === 'czeka') {
    return `<div class="row" style="justify-content:space-between;margin-top:4px">
      <span class="pill wait">Czeka na odpowiedź</span>
      <button class="btn small" type="button" data-action="withdraw" data-id="${p.id}">${icon('trash', 18)}Wycofaj</button>
    </div>`;
  }
  if (p.status === 'zaakceptowana') {
    const who = p.decided_by === state.me.id ? 'przez Ciebie' : `przez: ${esc(person(p.decided_by).name)}`;
    return box('background:var(--green-bg);color:var(--green)', icon('check', 18, 3), `Zaakceptowane ${who}${p.decided_at ? ` · ${timeLabel(p.decided_at)}` : ''}`);
  }
  if (p.status === 'odrzucona') {
    return box('background:#F0E4D8;color:var(--muted)', icon('x', 18, 2.6), 'Odrzucone');
  }
  return box('background:#F0E4D8;color:var(--muted)', icon('swap', 18, 2.2), 'Wybraliście inną propozycję');
}

function ingredientsSection(p, ingredients) {
  const haveCount = ingredients.filter((i) => i.have).length;
  const missing = ingredients.filter((i) => !i.have && !i.added_to_list);
  const onList = ingredients.some((i) => i.added_to_list && !i.have);
  const rows = ingredients.map((i) => `
    <li class="${i.have ? 'done' : ''}">
      <button class="check-btn" type="button" data-action="toggle-ing" data-id="${i.id}" data-on="${i.have}" aria-pressed="${i.have}">
        <span class="tick ${i.have ? 'on' : ''}">${i.have ? icon('check', 16, 3) : ''}</span>
        <span class="grow"><span class="item-name">${esc(i.name)}</span>${i.qty ? ` <span class="item-qty">${esc(i.qty)}</span>` : ''}</span>
        ${i.have ? '<span class="item-who">w lodówce</span>' : i.added_to_list ? '<span class="pill grey">na liście</span>' : '<span class="pill soft">do kupienia</span>'}
      </button>
      <button class="icon-btn" type="button" data-action="del-ing" data-id="${i.id}" aria-label="Usuń składnik: ${esc(i.name)}">${icon('x', 18, 2.2)}</button>
    </li>`).join('');
  let shoppingButton = '';
  if (missing.length) {
    shoppingButton = `<button class="btn primary full" type="button" data-action="to-shopping" data-id="${p.id}">${icon('basket', 20, 2.2)}Dodaj ${missing.length} ${plural(missing.length, 'brakujący', 'brakujące', 'brakujących')} do zakupów</button>`;
  } else if (onList) {
    shoppingButton = `<a class="btn full" href="#/zakupy">${icon('basket', 20)}Zobacz listę zakupów</a>`;
  }
  return `<section class="section">
    <div class="row" style="justify-content:space-between;align-items:baseline">
      <h2>Składniki</h2>
      ${ingredients.length ? `<span class="muted" style="font-size:13px;font-weight:700">${haveCount} z ${ingredients.length} w lodówce</span>` : ''}
    </div>
    <p class="row muted" style="font-size:14px;gap:6px">${icon('fridge', 16)}Dodaj składniki i odhacz to, co już macie</p>
    ${ingredients.length ? `<ul class="checklist">${rows}</ul>` : ''}
    <form class="inline-form" data-form="ingredient" data-id="${p.id}">
      <label class="sr-only" for="f-ing">Składnik</label>
      <input class="field" id="f-ing" name="name" placeholder="Składnik, np. twaróg" maxlength="80" required autocomplete="off" data-keep>
      <label class="sr-only" for="f-ing-qty">Ilość</label>
      <input class="field qty" id="f-ing-qty" name="qty" placeholder="Ilość" maxlength="40" autocomplete="off" data-keep>
      <button class="add-btn" type="submit" aria-label="Dodaj składnik">${icon('plus', 24, 2.6)}</button>
    </form>
    ${shoppingButton}
  </section>`;
}

// =====================================================================
//  Ekran: Baza dań
// =====================================================================
async function screenBase(params) {
  const filter = MEALS[params.typ] ? params.typ : 'wszystko';
  const dishes = await run(sb.from('dishes').select('*').order('created_at', { ascending: false }));
  const list = filter === 'wszystko' ? dishes : dishes.filter((d) => d.meal_type === filter);
  const defaultMeal = filter === 'wszystko' ? 'obiad' : filter;

  const chips = ['wszystko', ...MEAL_ORDER].map((k) => {
    const on = k === filter;
    const href = k === 'wszystko' ? '#/baza' : `#/baza?typ=${k}`;
    return `<a class="chip ${on ? 'on' : ''}" href="${href}" ${on ? 'aria-current="true"' : ''}>${k === 'wszystko' ? 'Wszystkie' : MEALS[k].plural}</a>`;
  }).join('');

  const rows = list.map((d) => `
    <li class="card row" style="padding:10px 6px 10px 12px;gap:10px" data-name="${esc(d.name.toLowerCase())}">
      ${mealTile(d.meal_type)}
      <div class="grow">
        <div class="dish-name">${esc(d.name)}</div>
        <div class="row muted" style="gap:6px;font-size:13px;font-weight:700;margin-top:3px">
          ${d.added_by ? avatar(person(d.added_by), 20) : ''}<span>${MEALS[d.meal_type].label}${d.tags?.length ? ` · ${esc(d.tags.join(', '))}` : ''}</span>
        </div>
      </div>
      <button class="icon-btn" type="button" data-action="del-dish" data-id="${d.id}" data-name="${esc(d.name)}" aria-label="Usuń z bazy: ${esc(d.name)}">${icon('trash', 18)}</button>
      <a class="icon-btn filled" href="#/nowa?danie=${encodeURIComponent(d.name)}&posilek=${d.meal_type}" aria-label="Zaproponuj: ${esc(d.name)}">${icon('send', 20, 2.2)}</a>
    </li>`).join('');

  const empty = `<div class="dashed stack" style="align-items:center;text-align:center;gap:10px">
    ${cat(64, 'biala')}
    <p style="font-weight:700">${filter === 'wszystko' ? 'Baza jest jeszcze pusta.' : 'Nic tu jeszcze nie ma.'}</p>
    <p class="muted" style="font-size:14px">Wpadł Ci do głowy pomysł na danie? Zapisz go na kiedyś przyciskiem „Pomysł”.</p>
  </div>`;

  return `<section class="screen">
    <header class="page-head">
      <div class="grow"><p class="kicker">Wasze pomysły na kiedyś</p><h1>Baza dań</h1></div>
      <button class="btn small" type="button" data-action="toggle-idea" aria-expanded="${state.ideaFormOpen}" aria-controls="idea-form">${icon('plus', 18, 2.4)}Pomysł</button>
    </header>
    <form id="idea-form" class="sticker stack" data-form="idea" ${state.ideaFormOpen ? '' : 'hidden'}>
      <label class="label" for="f-idea">Nazwa dania</label>
      <input class="field strong" id="f-idea" name="name" maxlength="80" required autocomplete="off" placeholder="np. Shakshuka z fetą" data-keep>
      <label class="label" for="f-idea-meal">Na jaki posiłek?</label>
      <select class="field" id="f-idea-meal" name="meal">
        ${MEAL_ORDER.map((m) => `<option value="${m}" ${m === defaultMeal ? 'selected' : ''}>${MEALS[m].label}</option>`).join('')}
      </select>
      <label class="label" for="f-idea-tags">Tagi <span style="text-transform:none;letter-spacing:0">(po przecinku, np. szybkie, wege)</span></label>
      <input class="field" id="f-idea-tags" name="tags" maxlength="80" autocomplete="off" data-keep>
      <button class="btn primary full" type="submit" style="margin-top:6px">Zapisz pomysł</button>
    </form>
    <div class="search">${icon('search', 20)}
      <label class="sr-only" for="f-search">Szukaj dania</label>
      <input class="field" id="f-search" type="search" placeholder="Szukaj dania…" autocomplete="off" data-keep>
    </div>
    <section class="banner" aria-label="Losowanie dania">
      <h2>Nie wiecie, co zjeść?</h2>
      <p>Kotek wylosuje coś z waszej bazy.</p>
      <a class="btn small" href="#/losuj">${dice(18)}Losuj</a>
      <span class="peek" aria-hidden="true">${cat(124)}</span>
    </section>
    <nav class="chips" aria-label="Filtr posiłków">${chips}</nav>
    ${list.length ? `<ul class="stack" style="gap:10px" id="dish-list">${rows}</ul><p id="no-results" class="muted" hidden>Nic nie pasuje do wyszukiwania.</p>` : empty}
  </section>${tabbar('baza')}`;
}

function applySearch(value) {
  const list = document.getElementById('dish-list');
  if (!list) return;
  const text = value.trim().toLowerCase();
  let visible = 0;
  list.querySelectorAll('li').forEach((li) => {
    const show = !text || li.dataset.name.includes(text);
    li.hidden = !show;
    if (show) visible++;
  });
  const none = document.getElementById('no-results');
  if (none) none.hidden = visible > 0;
}

// =====================================================================
//  Ekran: Kotek losuje
// =====================================================================
const POOLS = [
  ['wszystko', 'Wszystko'], ['sniadanie', 'Śniadania'], ['obiad', 'Obiady'],
  ['kolacja', 'Kolacje'], ['przekaska', 'Przekąski'], ['szybkie', 'Szybkie'],
];

async function screenRandom(params) {
  const pool = POOLS.some(([k]) => k === params.pula) ? params.pula : 'wszystko';
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params.dzien || '') ? params.dzien : '';
  const [dishes, recent] = await Promise.all([
    run(sb.from('dishes').select('*')),
    run(sb.from('proposals').select('dish_name').eq('status', 'zaakceptowana').gte('day', addDays(today(), -7))),
  ]);
  const candidates = dishes.filter((d) => (pool === 'wszystko' ? true
    : pool === 'szybkie' ? (d.tags || []).some((t) => t.toLowerCase() === 'szybkie')
      : d.meal_type === pool));
  // Pomiń dania jedzone w ostatnim tygodniu (jeśli zostaje coś innego)
  const eaten = new Set(recent.map((r) => r.dish_name.trim().toLowerCase()));
  const fresh = candidates.filter((d) => !eaten.has(d.name.trim().toLowerCase()));
  const usable = fresh.length ? fresh : candidates;

  let pick = state.random?.pool === pool ? usable.find((d) => d.id === state.random.id) : null;
  if (!pick && usable.length) pick = usable[Math.floor(Math.random() * usable.length)];
  state.random = { pool, id: pick?.id, ids: usable.map((d) => d.id) };
  const wobble = state.wobble;
  state.wobble = false;

  const chips = POOLS.map(([k, label]) => {
    const href = `#/losuj?pula=${k}${day ? `&dzien=${day}` : ''}`;
    return `<a class="chip ${k === pool ? 'on' : ''}" href="${href}" ${k === pool ? 'aria-current="true"' : ''}>${label}</a>`;
  }).join('');

  const pawSvg = '<svg width="46" height="28" viewBox="0 0 46 28" aria-hidden="true"><ellipse cx="23" cy="15" rx="20" ry="11.5" fill="#FF8A4C" stroke="#2A1E3F" stroke-width="2.5"/><path d="M15.5 21v-5M23 22v-6M30.5 21v-5" stroke="#2A1E3F" stroke-width="2" stroke-linecap="round"/></svg>';

  let body;
  if (!pick) {
    body = `<div class="dashed stack" style="align-items:center;text-align:center;gap:10px;margin-top:20px">
      ${cat(80, 'szara')}
      <p style="font-weight:700">Kotek nie ma z czego losować.</p>
      <p class="muted" style="font-size:14px">Dodajcie kilka pomysłów do bazy dań${pool !== 'wszystko' ? ' albo wybierzcie inną grupę' : ''}.</p>
      <a class="btn primary" href="#/baza">${icon('book', 18)}Przejdź do bazy</a>
    </div>`;
  } else {
    const who = pick.added_by ? `Dodał(a): ${esc(person(pick.added_by).name)}` : '';
    const tags = pick.tags?.length ? esc(pick.tags.join(', ')) : '';
    const newHref = `#/nowa?danie=${encodeURIComponent(pick.name)}&posilek=${pick.meal_type}${day ? `&dzien=${day}` : ''}`;
    body = `<div class="stage">
      <span class="cat-head">${cat(170)}</span>
      <div class="sticker draw-card ${wobble ? 'wobble' : ''}">
        <span class="paw-l">${pawSvg}</span><span class="paw-r">${pawSvg}</span>
        ${mealPill(pick.meal_type)}
        <h2 aria-live="polite">${esc(pick.name)}</h2>
        <p class="muted" style="font-size:14px;font-weight:700">${[who, tags].filter(Boolean).join(' · ')}</p>
      </div>
      <p class="muted" style="margin-top:16px;font-size:14px;font-weight:700;text-align:center">
        Losuję spośród ${usable.length} ${plural(usable.length, 'dania', 'dań', 'dań')}${fresh.length && fresh.length < candidates.length ? ' (bez tych z ostatniego tygodnia)' : ''}
      </p>
    </div>
    <div class="stack" style="gap:12px;margin-top:8px">
      <button class="btn full big" type="button" data-action="roll" ${usable.length < 2 ? 'disabled' : ''}>${dice(20)}Losuj jeszcze raz</button>
      <a class="btn primary full big" href="${newHref}">${icon('send', 20, 2.4)}Zaproponuj na ${MEAL_ACC[pick.meal_type]}</a>
    </div>`;
  }

  return `<section class="screen no-tabs">
    <header class="topbar">${backButton('#/baza')}<h1>Kotek losuje</h1><span style="width:44px"></span></header>
    <div class="stack">
      <span class="label">Losuj spośród</span>
      <nav class="chips" aria-label="Z czego losować">${chips}</nav>
    </div>
    ${body}
  </section>`;
}

// =====================================================================
//  Ekran: Plan tygodnia
// =====================================================================
async function screenPlan(params) {
  const t = today();
  const monday = mondayOf(/^\d{4}-\d{2}-\d{2}$/.test(params.tydzien || '') ? params.tydzien : t);
  const sunday = addDays(monday, 6);
  const proposals = await run(sb.from('proposals').select('*').gte('day', monday).lte('day', sunday).in('status', ACTIVE).order('created_at'));
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const thisWeek = monday === mondayOf(t);

  const strip = days.map((d) => {
    const isToday = d === t;
    const dots = MEAL_ORDER.map((m) => {
      const done = proposals.some((p) => p.day === d && p.meal_type === m && p.status === 'zaakceptowana');
      const color = isToday ? (done ? '#2A1E3F' : '#FFFFFF') : (done ? MEALS[m].dot : '#E3D5C7');
      return `<i style="background:${color}"></i>`;
    }).join('');
    return `<a href="#/dzien/${d}" class="${isToday ? 'today' : ''}" aria-label="${longDate(d)}">
      <span class="wd">${shortDay(d)}</span><span class="num">${Number(d.slice(8))}</span><span class="dots">${dots}</span></a>`;
  }).join('');

  const cards = days.map((d) => {
    const list = proposals.filter((p) => p.day === d);
    const decided = MEAL_ORDER.filter((m) => list.some((p) => p.meal_type === m && p.status === 'zaakceptowana')).length;
    const slots = MEAL_ORDER.map((m) => planSlot(d, m, list.filter((p) => p.meal_type === m))).join('');
    const isToday = d === t;
    return `<section class="${isToday ? 'sticker' : 'card'} stack ${d < t ? 'past' : ''}" style="padding:14px;gap:10px">
      <div class="row" style="justify-content:space-between">
        <h2 class="row" style="font-size:19px;gap:8px"><a href="#/dzien/${d}" style="color:inherit;text-decoration:none">${mediumDate(d)}</a>${isToday ? '<span class="pill soft" style="font-family:var(--body)">Dziś</span>' : ''}</h2>
        <span class="muted" style="font-size:13px;font-weight:700">${decided} z 4 ustalone</span>
      </div>
      <div class="slots">${slots}</div>
    </section>`;
  }).join('');

  return `<section class="screen">
    <header class="page-head">
      <div class="grow"><p class="kicker">${weekRange(monday)}</p><h1>Plan tygodnia</h1></div>
      <div class="row" style="gap:6px">
        <a class="round" href="#/plan?tydzien=${addDays(monday, -7)}" aria-label="Poprzedni tydzień">${icon('left', 20, 2.4)}</a>
        <a class="round" href="#/plan?tydzien=${addDays(monday, 7)}" aria-label="Następny tydzień">${icon('right', 20, 2.4)}</a>
      </div>
    </header>
    ${thisWeek ? '' : '<a class="chip" href="#/plan" style="align-self:flex-start">Wróć do tego tygodnia</a>'}
    <nav class="week" aria-label="Dni tygodnia">${strip}</nav>
    ${cards}
  </section>${tabbar('plan')}`;
}

function planSlot(day, meal, list) {
  const m = MEALS[meal];
  const label = `<span class="small-label">${icon(m.icon, 14, 2.2)}${m.label}</span>`;
  const accepted = list.find((p) => p.status === 'zaakceptowana');
  const pending = list.filter((p) => p.status === 'czeka');
  if (accepted) {
    return `<a class="slot" href="#/propozycja/${accepted.id}" style="background:${m.tint}">${label}<strong>${esc(accepted.dish_name)}</strong>${pending.length ? '<em>+ nowa propozycja</em>' : ''}</a>`;
  }
  if (pending.length === 1) {
    const p = pending[0];
    return `<a class="slot" href="#/propozycja/${p.id}" style="background:${m.tint}">${label}<strong>${esc(p.dish_name)}</strong><em>${isMine(p) ? 'czeka na odpowiedź' : 'czeka na Ciebie'}</em></a>`;
  }
  if (pending.length > 1) {
    return `<a class="slot" href="#/dzien/${day}" style="background:${m.tint}">${label}<strong>${pending.length} ${plural(pending.length, 'propozycja', 'propozycje', 'propozycji')}</strong><em>wybierzcie jedną</em></a>`;
  }
  return `<a class="slot empty" href="#/nowa?dzien=${day}&posilek=${meal}">${label}<em>+ Dodaj</em></a>`;
}

// =====================================================================
//  Ekran: Lista zakupów
// =====================================================================
async function screenShopping() {
  const items = await run(sb.from('shopping_items').select('*').order('created_at'));
  const proposalIds = [...new Set(items.map((i) => i.proposal_id).filter(Boolean))];
  const proposals = proposalIds.length
    ? await run(sb.from('proposals').select('id, dish_name, day, meal_type').in('id', proposalIds))
    : [];
  const byId = Object.fromEntries(proposals.map((p) => [p.id, p]));

  // Grupy: po jednej na danie, na końcu „Inne”
  const groups = [];
  const groupOf = {};
  for (const item of items) {
    const key = item.proposal_id && byId[item.proposal_id] ? item.proposal_id : 'inne';
    if (!groupOf[key]) {
      const p = byId[key];
      groupOf[key] = {
        key,
        title: p ? p.dish_name : 'Inne',
        sub: p ? `${MEALS[p.meal_type].label.toLowerCase()} · ${relativeDay(p.day)}` : 'bez przepisu',
        items: [],
      };
      groups.push(groupOf[key]);
    }
    groupOf[key].items.push(item);
  }
  groups.sort((a, b) => (a.key === 'inne') - (b.key === 'inne'));

  const done = items.filter((i) => i.checked).length;
  const percent = items.length ? Math.round((done / items.length) * 100) : 0;

  const groupHtml = groups.map((g) => `
    <section class="stack" style="gap:6px">
      <div class="row" style="align-items:baseline;gap:8px"><h2 style="font-size:17px">${esc(g.title)}</h2><span class="muted" style="font-size:12px;font-weight:700">${esc(g.sub)}</span></div>
      <ul class="checklist">${g.items.map((i) => `
        <li class="${i.checked ? 'done' : ''}">
          <button class="check-btn" type="button" data-action="toggle-item" data-id="${i.id}" data-on="${i.checked}" aria-pressed="${i.checked}">
            <span class="tick ${i.checked ? 'on' : ''}">${i.checked ? icon('check', 16, 3) : ''}</span>
            <span class="grow"><span class="item-name">${esc(i.name)}</span>${i.qty ? ` <span class="item-qty">${esc(i.qty)}</span>` : ''}</span>
            ${i.added_by ? `<span class="item-who">${esc(person(i.added_by).name)}</span>` : ''}
          </button>
          <button class="icon-btn" type="button" data-action="del-item" data-id="${i.id}" aria-label="Usuń: ${esc(i.name)}">${icon('x', 18, 2.2)}</button>
        </li>`).join('')}
      </ul>
    </section>`).join('');

  return `<section class="screen">
    <header class="page-head">
      <div class="grow"><p class="kicker">Wspólna dla Was dwojga</p><h1>Lista zakupów</h1></div>
      ${items.length ? `<span class="pill ok" style="font-size:13px;padding:6px 12px">${done} z ${items.length} w koszyku</span>` : ''}
    </header>
    ${items.length ? `<div class="progress" aria-hidden="true"><span style="width:${percent}%"></span></div>` : ''}
    <form class="inline-form" data-form="item">
      <label class="sr-only" for="f-item">Produkt</label>
      <input class="field" id="f-item" name="name" placeholder="Dodaj produkt…" maxlength="80" required autocomplete="off" data-keep>
      <label class="sr-only" for="f-item-qty">Ilość</label>
      <input class="field qty" id="f-item-qty" name="qty" placeholder="Ilość" maxlength="40" autocomplete="off" data-keep>
      <button class="add-btn" type="submit" aria-label="Dodaj produkt">${icon('plus', 24, 2.6)}</button>
    </form>
    ${items.length ? groupHtml : `<div class="dashed stack" style="align-items:center;text-align:center;gap:10px">
      ${cat(64, 'czarna')}
      <p style="font-weight:700">Lista jest pusta.</p>
      <p class="muted" style="font-size:14px">Dopisz coś powyżej albo dodaj brakujące składniki z zaakceptowanego dania.</p>
    </div>`}
    ${done ? `<button class="btn ghost full" type="button" data-action="clear-checked">${icon('trash', 18)}Usuń kupione (${done})</button>` : ''}
  </section>${tabbar('zakupy')}`;
}

// =====================================================================
//  Ekran: profil i ustawienia
// =====================================================================
async function screenSettings() {
  const status = pushStatus();
  let subscribed = false;
  if (status === 'granted') {
    try { subscribed = !!(await currentSubscription()); } catch (e) { /* brak */ }
  }
  const appUrl = location.href.split('#')[0];

  let push;
  if (status === 'needs-install') {
    push = `<p style="font-size:15px;line-height:1.45">Na iPhonie powiadomienia działają tylko w aplikacji dodanej do ekranu początkowego:</p>
      <ol style="margin:0;padding-left:20px;line-height:1.6;font-size:15px">
        <li>Otwórz tę stronę w <b>Safari</b>.</li>
        <li>Stuknij <b>Udostępnij</b> ${icon('share', 16)} na dole ekranu.</li>
        <li>Wybierz <b>Do ekranu początkowego</b> i potwierdź.</li>
        <li>Otwórz Hungrycatora z nowej ikonki i wróć tutaj.</li>
      </ol>`;
  } else if (status === 'unsupported') {
    push = '<p class="muted">Ta przeglądarka nie obsługuje powiadomień.</p>';
  } else if (status === 'denied') {
    push = '<p style="font-size:15px;line-height:1.45">Powiadomienia są zablokowane. Na iPhonie włączysz je w <b>Ustawieniach → Powiadomienia → Hungrycator</b>.</p>';
  } else if (subscribed) {
    push = `<div class="row" style="justify-content:space-between">
      <span class="pill ok">${icon('check', 14, 3)}Powiadomienia włączone</span>
      <button class="btn small" type="button" data-action="disable-push">Wyłącz</button>
    </div>
    <p class="muted" style="font-size:14px">Dostaniesz powiadomienie, gdy druga osoba zaproponuje posiłek.</p>`;
  } else {
    push = `<p style="font-size:15px;line-height:1.45">Dostaniesz powiadomienie, gdy druga osoba zaproponuje posiłek.</p>
      <button class="btn primary full" type="button" data-action="enable-push">${icon('bell', 20)}Włącz powiadomienia</button>`;
  }

  const partner = state.partner
    ? `<div class="row">${avatar(state.partner, 44)}<div><div class="dish-name">${esc(state.partner.name)}</div><span class="muted" style="font-size:13px;font-weight:700">planuje z Tobą posiłki</span></div></div>`
    : `<p style="font-size:15px;line-height:1.45">Druga osoba nie ma jeszcze konta. Wyślij jej link do aplikacji:</p>
       <button class="btn full" type="button" data-action="share-link" data-url="${esc(appUrl)}">${icon('share', 20)}Wyślij link</button>`;

  return `<section class="screen">
    <header class="topbar">${backButton('#/')}<h1>Ty i ustawienia</h1><span style="width:44px"></span></header>
    <section class="sticker stack" style="gap:10px">
      <h2 class="row" style="font-size:20px">${icon('bell', 22)}Powiadomienia</h2>
      ${push}
    </section>
    <section class="card stack" style="padding:16px">
      <h2 style="font-size:20px">Druga osoba</h2>
      ${partner}
    </section>
    <form class="card stack" style="padding:16px" data-form="profile-update">
      <h2 style="font-size:20px">Twój profil</h2>
      ${profileFields(state.me.name, state.me.cat)}
      <button class="btn primary full" type="submit" style="margin-top:6px">Zapisz zmiany</button>
    </form>
    <button class="btn ghost full" type="button" data-action="logout">${icon('logout', 20)}Wyloguj się</button>
  </section>${tabbar('')}`;
}

// =====================================================================
//  Kliknięcia (data-action="…")
// =====================================================================
const actions = {
  retry: () => render(),

  'login-mode': (el) => {
    state.loginMode = el.dataset.mode;
    state.loginError = '';
    render();
  },

  logout: async () => {
    stopRealtime();
    await sb.auth.signOut();
    location.hash = '#/';
  },

  'hide-hint': () => {
    try { localStorage.setItem('hc-hint-hidden', '1'); } catch (e) { /* tryb prywatny */ }
    render();
  },

  accept: async (el) => {
    const id = Number(el.dataset.id);
    const p = await run(sb.from('proposals').select('*').eq('id', id).single());
    await run(sb.from('proposals').update({
      status: 'zaakceptowana', decided_by: state.me.id, decided_at: new Date().toISOString(),
    }).eq('id', id));
    // Pozostałe propozycje na ten sam posiłek przestają obowiązywać
    await run(sb.from('proposals').update({ status: 'zastapiona' })
      .eq('day', p.day).eq('meal_type', p.meal_type).in('status', ACTIVE).neq('id', id));
    toast('Ustalone! Dodajcie składniki.');
    location.hash = `#/propozycja/${id}`;
  },

  reject: async (el) => {
    await run(sb.from('proposals').update({
      status: 'odrzucona', decided_by: state.me.id, decided_at: new Date().toISOString(),
    }).eq('id', Number(el.dataset.id)));
    toast('Odrzucone. Może kotek coś wylosuje?');
    render();
  },

  withdraw: async (el) => {
    if (!confirm('Wycofać tę propozycję?')) return;
    await run(sb.from('proposals').delete().eq('id', Number(el.dataset.id)));
    toast('Propozycja wycofana');
    if (parseRoute().parts[0] === 'propozycja') location.hash = '#/';
    else render();
  },

  'set-day': (el) => {
    document.getElementById('f-day').value = el.dataset.day;
    updateDayChips();
  },

  'pick-dish': (el) => {
    const input = document.getElementById('f-dish');
    input.value = el.dataset.name;
    updateSuggestions();
  },

  'save-idea': async (el) => {
    const f = new FormData(el.closest('form'));
    const name = String(f.get('dish') || '').trim();
    if (!name) {
      toast('Wpisz najpierw nazwę dania');
      document.getElementById('f-dish').focus();
      return;
    }
    const added = await saveDishIfNew(name, f.get('meal'));
    toast(added ? 'Zapisane w bazie dań' : 'To danie już jest w bazie');
    location.hash = '#/baza';
  },

  'toggle-ing': async (el) => {
    await run(sb.from('ingredients').update({ have: el.dataset.on !== 'true' }).eq('id', Number(el.dataset.id)));
    render();
  },

  'del-ing': async (el) => {
    await run(sb.from('ingredients').delete().eq('id', Number(el.dataset.id)));
    render();
  },

  'to-shopping': async (el) => {
    const id = Number(el.dataset.id);
    const missing = await run(sb.from('ingredients').select('*').eq('proposal_id', id).eq('have', false).eq('added_to_list', false));
    if (!missing.length) return;
    await run(sb.from('shopping_items').insert(missing.map((i) => ({ name: i.name, qty: i.qty, proposal_id: id }))));
    await run(sb.from('ingredients').update({ added_to_list: true }).in('id', missing.map((i) => i.id)));
    toast(`Na liście zakupów: +${missing.length}`);
    render();
  },

  quick: async (el) => {
    await run(sb.from('messages').insert({ proposal_id: Number(el.dataset.id), body: el.dataset.text }));
    render();
  },

  'toggle-idea': (el) => {
    state.ideaFormOpen = !state.ideaFormOpen;
    const form = document.getElementById('idea-form');
    form.hidden = !state.ideaFormOpen;
    el.setAttribute('aria-expanded', String(state.ideaFormOpen));
    if (state.ideaFormOpen) document.getElementById('f-idea').focus();
  },

  'del-dish': async (el) => {
    if (!confirm(`Usunąć „${el.dataset.name}” z bazy dań?`)) return;
    await run(sb.from('dishes').delete().eq('id', Number(el.dataset.id)));
    render();
  },

  roll: () => {
    const ids = (state.random?.ids || []).filter((id) => id !== state.random.id);
    if (!ids.length) return;
    state.random.id = ids[Math.floor(Math.random() * ids.length)];
    state.wobble = true;
    render();
  },

  'toggle-item': async (el) => {
    await run(sb.from('shopping_items').update({ checked: el.dataset.on !== 'true' }).eq('id', Number(el.dataset.id)));
    render();
  },

  'del-item': async (el) => {
    await run(sb.from('shopping_items').delete().eq('id', Number(el.dataset.id)));
    render();
  },

  'clear-checked': async () => {
    if (!confirm('Usunąć z listy wszystko, co już kupione?')) return;
    await run(sb.from('shopping_items').delete().eq('checked', true));
    render();
  },

  'enable-push': async () => {
    // Prośba o zgodę musi paść od razu po stuknięciu (wymóg iPhone'a)
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      toast('Bez zgody nie wyślę powiadomień.');
      render();
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(VAPID_PUBLIC_KEY) });
    }
    await saveSubscription(sub);
    toast('Powiadomienia włączone!');
    render();
  },

  'disable-push': async () => {
    const sub = await currentSubscription();
    if (sub) {
      await run(sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint));
      await sub.unsubscribe();
    }
    toast('Powiadomienia wyłączone');
    render();
  },

  'share-link': async (el) => {
    const url = el.dataset.url;
    if (navigator.share) {
      try { await navigator.share({ title: 'Hungrycator', text: 'Planujmy razem posiłki!', url }); } catch (e) { /* anulowano */ }
    } else {
      await navigator.clipboard.writeText(url);
      toast('Link skopiowany');
    }
  },
};

// =====================================================================
//  Formularze (data-form="…")
// =====================================================================
async function registerAccount(f, name, kind) {
  const { data, error } = await sb.auth.signUp({ email: String(f.get('email')).trim(), password: f.get('password') });
  if (error) {
    state.loginError = polishAuthError(error);
    render();
    return;
  }
  if (!data.session) {
    state.loginMode = 'login';
    state.loginError = 'Sprawdź skrzynkę, potwierdź adres e-mail i zaloguj się.';
    render();
    return;
  }
  state.session = data.session;
  await run(sb.from('profiles').insert({ id: data.user.id, name, cat: kind }));
  await afterLogin();
  render();
}

const forms = {
  login: async (form) => {
    const f = new FormData(form);
    state.loginError = '';
    const { error } = await sb.auth.signInWithPassword({ email: String(f.get('email')).trim(), password: f.get('password') });
    if (error) {
      state.loginError = polishAuthError(error);
      render();
    }
    // Udane logowanie obsługuje onAuthStateChange
  },

  register: async (form) => {
    const f = new FormData(form);
    const name = String(f.get('name')).trim();
    const kind = f.get('cat') || 'ruda';
    state.loginError = '';
    state.registering = true;
    try {
      await registerAccount(f, name, kind);
    } finally {
      state.registering = false;
    }
  },

  profile: async (form) => {
    const f = new FormData(form);
    await run(sb.from('profiles').insert({ id: state.session.user.id, name: String(f.get('name')).trim(), cat: f.get('cat') || 'ruda' }));
    await afterLogin();
    render();
  },

  'profile-update': async (form) => {
    const f = new FormData(form);
    await run(sb.from('profiles').update({ name: String(f.get('name')).trim(), cat: f.get('cat') || 'ruda' }).eq('id', state.me.id));
    await loadPeople();
    toast('Zapisane');
    render();
  },

  new: async (form) => {
    const f = new FormData(form);
    const day = f.get('day');
    const meal = f.get('meal');
    const dish = String(f.get('dish') || '').trim();
    const comment = String(f.get('comment') || '').trim();
    if (!dish) return toast('Wpisz nazwę dania');
    await run(sb.from('proposals').insert({ day, meal_type: meal, dish_name: dish, comment: comment || null }));
    if (f.get('save')) await saveDishIfNew(dish, meal);
    toast(state.partner ? `Wysłane! ${state.partner.name} dostanie powiadomienie.` : 'Wysłane!');
    form.reset();
    location.hash = day === today() ? '#/' : `#/dzien/${day}`;
  },

  idea: async (form) => {
    const f = new FormData(form);
    const name = String(f.get('name')).trim();
    const tags = String(f.get('tags') || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    const added = await saveDishIfNew(name, f.get('meal'), tags);
    form.reset();
    state.ideaFormOpen = false;
    toast(added ? 'Pomysł zapisany!' : 'To danie już jest w bazie');
    render();
  },

  ingredient: async (form) => {
    const f = new FormData(form);
    const name = String(f.get('name')).trim();
    if (!name) return;
    await run(sb.from('ingredients').insert({ proposal_id: Number(form.dataset.id), name, qty: String(f.get('qty') || '').trim() || null }));
    form.reset();
    await render();
    document.getElementById('f-ing')?.focus();
  },

  message: async (form) => {
    const f = new FormData(form);
    const body = String(f.get('body')).trim();
    if (!body) return;
    form.reset();
    await run(sb.from('messages').insert({ proposal_id: Number(form.dataset.id), body }));
    render();
  },

  item: async (form) => {
    const f = new FormData(form);
    const name = String(f.get('name')).trim();
    if (!name) return;
    await run(sb.from('shopping_items').insert({ name, qty: String(f.get('qty') || '').trim() || null }));
    form.reset();
    await render();
    document.getElementById('f-item')?.focus();
  },
};

// =====================================================================
//  Nasłuchiwanie zdarzeń
// =====================================================================
app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || !app.contains(el)) return;
  const name = el.dataset.action;
  if (name === 'back') {
    if (navCount > 0) {
      e.preventDefault();
      history.back();
    }
    return;
  }
  const fn = actions[name];
  if (!fn) return;
  e.preventDefault();
  if (el.dataset.busy) return;
  el.dataset.busy = '1';
  try {
    await fn(el, e);
  } catch (err) {
    showError(err);
  } finally {
    delete el.dataset.busy;
  }
});

app.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const fn = forms[form.dataset.form];
  if (!fn) return;
  const button = form.querySelector('[type="submit"]');
  if (button) button.disabled = true;
  try {
    await fn(form);
  } catch (err) {
    showError(err);
  } finally {
    if (button) button.disabled = false;
  }
});

app.addEventListener('input', (e) => {
  if (e.target.id === 'f-dish') updateSuggestions();
  if (e.target.id === 'f-search') applySearch(e.target.value);
  if (e.target.id === 'f-day') updateDayChips();
});

app.addEventListener('change', (e) => {
  if (e.target.name === 'meal' && document.getElementById('suggestions')) updateSuggestions();
  if (e.target.id === 'f-day') updateDayChips();
});

app.addEventListener('focusout', () => {
  setTimeout(() => {
    if (refreshPending && !isTyping()) {
      refreshPending = false;
      render();
    }
  }, 150);
});

let navCount = 0; // ile razy przeszliśmy między ekranami (do przycisku „Wróć”)
window.addEventListener('hashchange', () => {
  navCount++;
  render();
});

// Po powrocie do aplikacji pobierz świeże dane
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.me) scheduleRefresh();
});

// =====================================================================
//  Start
// =====================================================================
async function init() {
  if (!CONFIG_OK) {
    render();
    return;
  }
  registerServiceWorker();
  try {
    const { data } = await sb.auth.getSession();
    state.session = data.session;
    if (state.session) await afterLogin();
  } catch (err) {
    console.error(err);
  }
  sb.auth.onAuthStateChange((event, session) => {
    const before = state.session?.user?.id;
    const after = session?.user?.id;
    state.session = session;
    if (before === after || state.registering) return;
    // Supabase radzi nie wołać bazy bezpośrednio w tym miejscu, więc robimy to chwilę później
    setTimeout(async () => {
      try {
        if (session) {
          await afterLogin();
        } else {
          stopRealtime();
          state.me = null;
          state.partner = null;
          state.people = {};
        }
      } catch (err) {
        showError(err);
      }
      render();
    }, 0);
  });
  render();
}

init();
