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
  relativeDay, weekRange, timeOf, isoDate, fromIso, mealForNow, icon, dice, paw, cat, avatar, mealTile, mealPill,
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
  focusAfterPaint: null, // pole do zaznaczenia po narysowaniu ekranu
  unseen: 0,           // ile nowych zdarzeń pod łapką
  activityPrevSeen: null, // do kiedy zdarzenia były widziane przed wejściem do łapki
  pushCheck: null,     // wynik „Sprawdź powiadomienia”
};

const QUICK_REPLIES = ['Mniam!', 'Pasuje', 'Może jutro?'];
const MEAL_ACC = { sniadanie: 'śniadanie', obiad: 'obiad', kolacja: 'kolację', przekaska: 'przekąskę' };
const ACTIVE = ['czeka', 'zaakceptowana'];

// Kategorie zdarzeń w centrum powiadomień (łapce) i w ustawieniach
const KINDS = {
  propozycje: { label: 'Nowe propozycje', desc: 'Ktoś proponuje posiłek', icon: 'bowl', tint: '#FFE2D1' },
  decyzje: { label: 'Akceptacje i odrzucenia', desc: 'Propozycja przyjęta, odrzucona albo wycofana', icon: 'check', tint: '#D7F3E5' },
  wiadomosci: { label: 'Wiadomości', desc: 'Nowa wiadomość w rozmowie o daniu', icon: 'chat', tint: '#E9E2FF' },
  skladniki: { label: 'Składniki', desc: 'Dodane albo usunięte składniki dania', icon: 'fridge', tint: '#FFF0BF' },
  zakupy_nowe: { label: 'Nowe produkty na liście', desc: 'Ktoś dopisuje coś do zakupów', icon: 'plus', tint: '#FFE2D1' },
  zakupy_zmiany: { label: 'Zmiany na liście zakupów', desc: 'Liczba sztuk, usunięte produkty', icon: 'swap', tint: '#FFDCE8' },
  zakupy_kupione: { label: 'Zrobione zakupy', desc: 'Ktoś odhacza produkty jako kupione', icon: 'basket', tint: '#D7F3E5' },
  baza: { label: 'Nowe pomysły w bazie', desc: 'Nowe danie zapisane na kiedyś', icon: 'book', tint: '#E9E2FF' },
};

// „na dzisiejszy obiad”, „na jutrzejszą kolację”, „na obiad w czwartek (20.11)”
const MEAL_GENDER = { sniadanie: 'n', obiad: 'm', kolacja: 'f', przekaska: 'f' };
const TODAY_ADJ = { m: 'dzisiejszy', f: 'dzisiejszą', n: 'dzisiejsze' };
const TOMORROW_ADJ = { m: 'jutrzejszy', f: 'jutrzejszą', n: 'jutrzejsze' };
const ON_DAY = ['w niedzielę', 'w poniedziałek', 'we wtorek', 'w środę', 'w czwartek', 'w piątek', 'w sobotę'];
function whenText(day, meal) {
  const gender = MEAL_GENDER[meal] || 'm';
  const acc = MEAL_ACC[meal] || 'obiad';
  const t = today();
  if (day === t) return `na ${TODAY_ADJ[gender]} ${acc}`;
  if (day === addDays(t, 1)) return `na ${TOMORROW_ADJ[gender]} ${acc}`;
  const d = fromIso(day);
  return `na ${acc} ${ON_DAY[d.getDay()]} (${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')})`;
}

function shorten(text, max) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

// „Mleko, Jajka i 3 więcej”
function listText(names) {
  return names.length > 6 ? `${names.slice(0, 5).join(', ')} i ${names.length - 5} więcej` : names.join(', ');
}

// =====================================================================
//  Pomocniki
// =====================================================================

// Wykonaj zapytanie do bazy; przy błędzie rzuć wyjątek
async function run(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

// Jak run(), ale przy błędzie zwraca pustą listę (np. gdy tabela jeszcze nie istnieje)
async function safeRun(query) {
  try {
    const { data, error } = await query;
    if (error) {
      console.warn(error.message);
      return [];
    }
    return data || [];
  } catch (e) {
    console.warn(e);
    return [];
  }
}

// Ile nowych zdarzeń od drugiej osoby czeka pod łapką
async function refreshUnseen() {
  let query = sb.from('activity').select('id, kind').neq('actor', state.me.id).order('created_at', { ascending: false }).limit(50);
  if (state.me.activity_seen_at) query = query.gt('created_at', state.me.activity_seen_at);
  const rows = await safeRun(query);
  const prefs = state.me.notify_prefs || {};
  state.unseen = rows.filter((r) => prefs[r.kind] !== false).length;
}

// Ile wiadomości od drugiej osoby jeszcze nie przeczytałam (dla każdej propozycji)
function unreadCounts(messages, reads) {
  const lastRead = Object.fromEntries(reads.map((r) => [r.proposal_id, r.last_read_at]));
  const counts = {};
  for (const m of messages) {
    if (m.author === state.me.id) continue;
    const seen = lastRead[m.proposal_id];
    if (!seen || new Date(m.created_at) > new Date(seen)) counts[m.proposal_id] = (counts[m.proposal_id] || 0) + 1;
  }
  return counts;
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
    case 'powiadomienia': return screenActivity();
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
      await refreshUnseen();
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
  if (state.focusAfterPaint) {
    const el = document.getElementById(state.focusAfterPaint);
    state.focusAfterPaint = null;
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.focus({ preventScroll: true });
    }
  }
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
    const dot = key === 'dzis' && state.unseen ? '<i class="tab-dot" aria-hidden="true"></i>' : '';
    return `<a class="tab" href="${href}" ${on ? 'aria-current="page"' : ''}><span class="pillbg">${icon(ic, 22, on ? 2.3 : 2)}${dot}</span><span>${label}</span></a>`;
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
  const messages = ids.length ? await run(sb.from('messages').select('id, proposal_id, author, created_at').in('proposal_id', ids)) : [];
  const reads = ids.length ? await safeRun(sb.from('message_reads').select('proposal_id, last_read_at').eq('user_id', state.me.id).in('proposal_id', ids)) : [];
  const unread = unreadCounts(messages, reads);

  const decided = MEAL_ORDER.filter((m) => proposals.some((p) => p.meal_type === m && p.status === 'zaakceptowana'));
  const segments = MEAL_ORDER.map((m) => `<i style="background:${decided.includes(m) ? MEALS[m].dot : '#EFE3D6'}"></i>`).join('');
  const title = day === t ? 'Co dziś jemy?' : day === addDays(t, 1) ? 'Co jutro jemy?' : 'Co jemy?';
  const cards = MEAL_ORDER.map((m) => mealCard(m, day, proposals.filter((p) => p.meal_type === m), unread)).join('');

  return `<section class="screen">
    <header class="today-head">
      <div class="grow">
        <p class="kicker">Cześć, ${esc(state.me.name)}!</p>
        <h1>${title}</h1>
      </div>
      <div class="row" style="gap:10px;flex-shrink:0">
        ${bellButton()}
        <a class="avatars" href="#/ja" aria-label="Profil i ustawienia">${avatar(state.me, 42)}${state.partner ? avatar(state.partner, 42) : ''}</a>
      </div>
    </header>
    <div class="today-bar">
      <div class="day-switch">
        <a href="#/dzien/${addDays(day, -1)}" aria-label="Poprzedni dzień">${icon('left', 18, 2.4)}</a>
        <span class="day-label">${mediumDate(day)}</span>
        <a href="#/dzien/${addDays(day, 1)}" aria-label="Następny dzień">${icon('right', 18, 2.4)}</a>
      </div>
      <span class="mini-progress" aria-label="${decided.length} z 4 posiłków ustalone"><span class="segments" aria-hidden="true">${segments}</span>${decided.length}/4</span>
    </div>
    ${day !== t ? '<a class="back-today" href="#/">Wróć do dziś</a>' : ''}
    ${day === t ? pushHint() : ''}
    <div class="meals">${cards}</div>
  </section>${tabbar(day === t ? 'dzis' : 'plan')}`;
}

// Jedna karta na posiłek: pusta, ustalona albo z propozycjami do wyboru
function mealCard(meal, day, list, unread) {
  const m = MEALS[meal];
  const accepted = list.find((p) => p.status === 'zaakceptowana');
  const pending = list.filter((p) => p.status === 'czeka');

  if (!accepted && !pending.length) {
    return `<article class="meal-card empty">
      ${mealTile(meal, 44, 22)}
      <div class="grow"><span class="meal-label">${m.label}</span><span class="meal-empty">Nic jeszcze nie ma</span></div>
      <a class="mini-btn soft-violet" href="#/losuj?pula=${meal}&dzien=${day}" aria-label="Kotek wylosuje: ${m.label}">${dice(20)}</a>
      <a class="mini-btn orange" href="#/nowa?dzien=${day}&posilek=${meal}" aria-label="Zaproponuj: ${m.label}">${icon('plus', 22, 2.6)}</a>
    </article>`;
  }

  if (accepted && !pending.length) {
    return `<a class="meal-card" href="#/propozycja/${accepted.id}">
      ${mealTile(meal, 44, 22)}
      <div class="grow">
        <span class="meal-label">${m.label}</span>
        <span class="meal-dish">${esc(accepted.dish_name)}</span>
        <span class="meal-meta">${metaText(accepted, unread)}</span>
      </div>
      <span class="ok-dot" role="img" aria-label="Ustalone">${icon('check', 16, 3)}</span>
    </a>`;
  }

  // Są propozycje czekające na decyzję
  const forMe = pending.some((p) => !isMine(p));
  const options = [accepted, ...pending].filter(Boolean);
  const count = options.length;
  let status = '<span class="pill grey">Czeka na odpowiedź</span>';
  if (count > 1) status = `<span class="pill wait">${count} do wyboru</span>`;
  else if (forMe) status = '<span class="pill wait">Twój wybór</span>';
  return `<article class="meal-card stacked ${forMe ? 'attention' : ''}">
    <div class="meal-top">
      ${mealTile(meal, 34, 18)}
      <span class="meal-label grow">${m.label}</span>
      ${status}
    </div>
    ${options.map((p) => optionRow(p, unread)).join('')}
  </article>`;
}

function metaText(p, unread) {
  const n = unread[p.id] || 0;
  const who = isMine(p) ? 'Twoja propozycja' : `od: ${esc(person(p.author).name)}`;
  return `${who}${n ? ` · <span class="unread">${n} ${plural(n, 'nowa wiadomość', 'nowe wiadomości', 'nowych wiadomości')}</span>` : ''}`;
}

// Kocia łapka z czerwonym licznikiem: wejście do centrum powiadomień
function bellButton() {
  const n = state.unseen || 0;
  return `<a class="bell" href="#/powiadomienia" aria-label="Centrum powiadomień${n ? `, nowe: ${n}` : ''}">
    ${paw(24, '#FF7A3D')}${n ? `<span class="badge">${n > 9 ? '9+' : n}</span>` : ''}
  </a>`;
}

function optionRow(p, unread) {
  const accepted = p.status === 'zaakceptowana';
  const canDecide = !accepted && !isMine(p);
  const actions = canDecide ? `<div class="choice">
      <button class="btn primary" type="button" data-action="accept" data-id="${p.id}">${icon('check', 18, 2.6)}Akceptuj</button>
      <button class="btn soft" type="button" data-action="reject" data-id="${p.id}">Odrzuć</button>
      <a class="btn soft" href="#/nowa?dzien=${p.day}&posilek=${p.meal_type}">Inna</a>
    </div>` : '';
  return `<div class="option">
    <a class="option-link" href="#/propozycja/${p.id}">
      <span class="grow">
        <span class="meal-dish">${esc(p.dish_name)}</span>
        <span class="meal-meta">${metaText(p, unread)}${accepted ? ' · ustalone' : ` · ${timeOf(p.created_at)}`}</span>
      </span>
      ${accepted ? `<span class="ok-dot" role="img" aria-label="Ustalone">${icon('check', 16, 3)}</span>` : `<span class="chev">${icon('right', 18)}</span>`}
    </a>
    ${p.comment ? `<p class="note">${esc(p.comment)}</p>` : ''}
    ${actions}
  </div>`;
}

function pushHint() {
  let hidden = false;
  try { hidden = localStorage.getItem('hc-hint-hidden') === '1'; } catch (e) { /* tryb prywatny */ }
  const status = pushStatus();
  if (hidden || !['needs-install', 'default'].includes(status)) return '';
  const text = status === 'needs-install'
    ? 'Dodaj apkę do ekranu początkowego, żeby dostawać powiadomienia.'
    : 'Włącz powiadomienia, żeby wiedzieć o zmianach.';
  return `<div class="hint-bar">
    ${icon('bell', 18)}
    <a class="grow" href="#/ja">${text}</a>
    <button class="icon-btn" type="button" data-action="hide-hint" aria-label="Ukryj podpowiedź">${icon('x', 16)}</button>
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
  state.dishes = await run(sb.from('dishes').select('id, name, meal_type, ingredients').order('created_at', { ascending: false }));

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
        <div id="saved-ingredients">${savedIngredientsHtml(dish)}</div>
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

// Podgląd składników zapisanych przy tym daniu w bazie
function savedIngredientsHtml(typed) {
  const clean = (typed || '').trim().toLowerCase();
  const dish = clean && state.dishes.find((d) => d.name.trim().toLowerCase() === clean);
  const list = dish?.ingredients || [];
  if (!list.length) return '';
  return `<p class="saved-ing">${icon('fridge', 16)}<span><b>Składniki z bazy wstawią się same:</b> ${esc(list.map((i) => i.name).join(', '))}</span></p>`;
}

function updateSuggestions() {
  const box = document.getElementById('suggestions');
  if (!box) return;
  const meal = app.querySelector('input[name="meal"]:checked')?.value || 'obiad';
  const typed = document.getElementById('f-dish')?.value;
  box.innerHTML = suggestionsHtml(meal, typed);
  const saved = document.getElementById('saved-ingredients');
  if (saved) saved.innerHTML = savedIngredientsHtml(typed);
}

function updateDayChips() {
  const value = document.getElementById('f-day')?.value;
  app.querySelectorAll('[data-action="set-day"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.day === value)));
}

// Dodaj danie do bazy, jeśli jeszcze go tam nie ma. Zwraca true, gdy dodano.
async function saveDishIfNew(name, meal, tags = []) {
  if (await findDish(name)) return false;
  await run(sb.from('dishes').insert({ name: name.trim(), meal_type: meal, tags }));
  return true;
}

// Znajdź danie w bazie po nazwie (bez względu na wielkość liter)
async function findDish(name) {
  const clean = name.trim().toLowerCase();
  const all = await run(sb.from('dishes').select('*'));
  return all.find((d) => d.name.trim().toLowerCase() === clean) || null;
}

// Zapamiętaj składniki przy daniu w bazie, żeby następnym razem wstawiły się same
async function rememberIngredients(proposalId) {
  const p = await run(sb.from('proposals').select('dish_name, meal_type').eq('id', proposalId).single());
  const list = await run(sb.from('ingredients').select('name, qty').eq('proposal_id', proposalId).order('id'));
  const saved = list.map((i) => ({ name: i.name, qty: i.qty || null }));
  const dish = await findDish(p.dish_name);
  if (dish) await run(sb.from('dishes').update({ ingredients: saved }).eq('id', dish.id));
  else await run(sb.from('dishes').insert({ name: p.dish_name.trim(), meal_type: p.meal_type, ingredients: saved }));
}

// Nazwa funkcji od powiadomień w Supabase (Edge Functions)
const PUSH_FUNCTION = 'swift-action';

// Zamień błąd wywołania funkcji na zrozumiały opis
async function describeFunctionError(error) {
  const status = error?.context?.status;
  let text = '';
  try {
    const body = await error.context.json();
    text = body?.problem || body?.reason || body?.error || body?.message || body?.msg || '';
  } catch (e) { /* brak treści */ }
  if (status === 404) return `Nie ma funkcji o nazwie ${PUSH_FUNCTION}. Sprawdź nazwę w Edge Functions.`;
  if (status === 401) return text || 'Wyłącz „Enforce JWT verification” w ustawieniach funkcji.';
  if (status >= 500) return `Funkcja ma błąd albo nie wystartowała${text ? ` (${text})` : ''}. Wklej kod jeszcze raz i kliknij Deploy.`;
  if (!status) return 'Brak połączenia z funkcją. Sprawdź internet i nazwę funkcji.';
  return `Kod ${status}${text ? `: ${text}` : ''}`;
}

// Zapisz zdarzenie w historii (łapka). Webhook na tabeli activity
// wyśle z niego powiadomienie na telefon drugiej osoby.
async function logActivity(kind, title, body, url = '#/', proposalId = null) {
  try {
    await run(sb.from('activity').insert({ kind, title: shorten(title, 120), body: shorten(body, 300), url, proposal_id: proposalId }));
  } catch (e) {
    console.warn('Nie zapisano zdarzenia', e);
  }
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

  // Odczytane wiadomości: zapisz, że widzę już wszystko, i sprawdź, co przeczytała druga osoba
  const reads = await safeRun(sb.from('message_reads').select('*').eq('proposal_id', id));
  const myRead = reads.find((r) => r.user_id === state.me.id);
  const partnerRead = reads.find((r) => r.user_id !== state.me.id);
  const lastFromOthers = [...messages].reverse().find((m) => m.author !== state.me.id);
  if (lastFromOthers && (!myRead || new Date(lastFromOthers.created_at) > new Date(myRead.last_read_at))) {
    const newest = messages[messages.length - 1].created_at;
    safeRun(sb.from('message_reads').upsert({ user_id: state.me.id, proposal_id: id, last_read_at: newest }, { onConflict: 'user_id,proposal_id' }));
  }
  const lastMine = [...messages].reverse().find((m) => m.author === state.me.id);
  const seenByPartner = !!(lastMine && partnerRead && new Date(partnerRead.last_read_at) >= new Date(lastMine.created_at));

  // Dymki rozmowy: komentarz z propozycji jest pierwszą wiadomością
  const thread = [];
  if (p.comment) thread.push({ author: p.author, body: p.comment, created_at: p.created_at });
  thread.push(...messages);
  const chat = thread.map((m) => {
    if (m.author === state.me.id) {
      const seen = m === lastMine && seenByPartner ? ` · <span class="seen">${icon('check', 12, 3)}Przeczytane</span>` : '';
      return `<div class="msg mine"><p>${esc(m.body)}</p><small>Ty · ${timeLabel(m.created_at)}${seen}</small></div>`;
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
    ${ACTIVE.includes(p.status) ? ingredientsSection(p, ingredients) : ''}
    <section class="section">
      <h2>Rozmowa</h2>
      ${thread.length ? `<div class="chat">${chat}</div>` : '<p class="muted">Napiszcie coś o tym daniu.</p>'}
      <div class="chips">${QUICK_REPLIES.map((q) => `<button class="chip" type="button" data-action="quick" data-id="${p.id}" data-dish="${esc(p.dish_name)}" data-text="${esc(q)}">${esc(q)}</button>`).join('')}</div>
      <form class="chat-form" data-form="message" data-id="${p.id}" data-dish="${esc(p.dish_name)}">
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
      <button class="icon-btn" type="button" data-action="del-ing" data-id="${i.id}" data-proposal="${p.id}" data-dish="${esc(p.dish_name)}" data-name="${esc(i.name)}" aria-label="Usuń składnik: ${esc(i.name)}">${icon('x', 18, 2.2)}</button>
    </li>`).join('');
  let shoppingButton = '';
  if (missing.length) {
    shoppingButton = `<button class="btn primary full" type="button" data-action="to-shopping" data-id="${p.id}" data-dish="${esc(p.dish_name)}">${icon('basket', 20, 2.2)}Dodaj ${missing.length} ${plural(missing.length, 'brakujący', 'brakujące', 'brakujących')} do zakupów</button>`;
  } else if (onList) {
    shoppingButton = `<a class="btn full" href="#/zakupy">${icon('basket', 20)}Zobacz listę zakupów</a>`;
  }
  return `<section class="section">
    <div class="row" style="justify-content:space-between;align-items:baseline">
      <h2>Składniki</h2>
      ${ingredients.length ? `<span class="muted" style="font-size:13px;font-weight:700">${haveCount} z ${ingredients.length} w lodówce</span>` : ''}
    </div>
    <p class="row muted" style="font-size:14px;gap:6px;align-items:flex-start">${icon('fridge', 16)}<span>Wpisz, czego potrzeba (kilka naraz po przecinku), i stuknij to, co już macie w lodówce.</span></p>
    ${ingredients.length ? `<ul class="checklist">${rows}</ul>` : ''}
    <form class="inline-form" data-form="ingredient" data-id="${p.id}" data-dish="${esc(p.dish_name)}">
      <label class="sr-only" for="f-ing">Składnik</label>
      <input class="field" id="f-ing" name="name" placeholder="np. twaróg, cebula" maxlength="300" required autocomplete="off" data-keep>
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
          ${d.added_by ? avatar(person(d.added_by), 20) : ''}<span>${MEALS[d.meal_type].label}${d.tags?.length ? ` · ${esc(d.tags.join(', '))}` : ''}${d.ingredients?.length ? ` · ${d.ingredients.length} ${plural(d.ingredients.length, 'składnik', 'składniki', 'składników')}` : ''}</span>
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
          <button class="check-btn" type="button" data-action="toggle-item" data-id="${i.id}" data-on="${i.checked}" aria-pressed="${i.checked}" data-proposal="${i.proposal_id || ''}" data-name="${esc(i.name)}">
            <span class="tick ${i.checked ? 'on' : ''}">${i.checked ? icon('check', 16, 3) : ''}</span>
            <span class="grow">
              <span class="item-name">${esc(i.name)}</span>
              <span class="item-sub">${[i.qty ? esc(i.qty) : '', i.added_by ? esc(person(i.added_by).name) : ''].filter(Boolean).join(' · ')}</span>
            </span>
          </button>
          ${stepper(i)}
          <button class="icon-btn" type="button" data-action="del-item" data-id="${i.id}" data-name="${esc(i.name)}" aria-label="Usuń: ${esc(i.name)}">${icon('x', 18, 2.2)}</button>
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
      <input class="field" id="f-item" name="name" placeholder="Dodaj produkt, np. mleko, jajka" maxlength="300" required autocomplete="off" data-keep>
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

// Małe przyciski − liczba + do zmiany liczby sztuk
function stepper(item) {
  const amount = item.amount || 1;
  return `<span class="stepper" role="group" data-name="${esc(item.name)}" aria-label="Liczba sztuk: ${esc(item.name)}">
    <button type="button" data-action="amount" data-id="${item.id}" data-delta="-1" aria-label="Mniej: ${esc(item.name)}" ${amount <= 1 ? 'disabled' : ''}>${icon('minus', 16, 2.6)}</button>
    <span class="amount" aria-live="polite">${amount}</span>
    <button type="button" data-action="amount" data-id="${item.id}" data-delta="1" aria-label="Więcej: ${esc(item.name)}">${icon('plus', 16, 2.6)}</button>
  </span>`;
}

// =====================================================================
//  Ekran: centrum powiadomień (kocia łapka)
// =====================================================================
async function screenActivity() {
  const rows = await safeRun(sb.from('activity').select('*').neq('actor', state.me.id).order('created_at', { ascending: false }).limit(80));
  const prefs = state.me.notify_prefs || {};
  const list = rows.filter((r) => KINDS[r.kind] && prefs[r.kind] !== false);

  // Co było nowe w chwili wejścia (podświetlamy to do końca tej wizyty)
  if (lastKey !== '/powiadomienia') state.activityPrevSeen = state.me.activity_seen_at || null;
  const prevSeen = state.activityPrevSeen ? new Date(state.activityPrevSeen) : null;

  // Oznacz wszystko jako zobaczone (czas z bazy, nie z telefonu)
  const newest = rows[0]?.created_at;
  if (newest && (!state.me.activity_seen_at || new Date(newest) > new Date(state.me.activity_seen_at))) {
    state.me.activity_seen_at = newest;
    state.unseen = 0;
    safeRun(sb.from('profiles').update({ activity_seen_at: newest }).eq('id', state.me.id));
  }

  // Grupy po dniach: Dziś, Wczoraj, wtorek 17 listopada…
  const groups = [];
  for (const r of list) {
    const day = isoDate(new Date(r.created_at));
    const label = day === today() ? 'Dziś' : day === addDays(today(), -1) ? 'Wczoraj' : longDate(day);
    if (!groups.length || groups[groups.length - 1].label !== label) groups.push({ label, items: [] });
    groups[groups.length - 1].items.push(r);
  }

  const html = groups.map((g) => `
    <section class="stack" style="gap:8px">
      <h2 class="small-label">${esc(g.label)}</h2>
      <ul class="act-list">${g.items.map((r) => {
        const k = KINDS[r.kind];
        const isNew = !prevSeen || new Date(r.created_at) > prevSeen;
        const url = String(r.url || '').startsWith('#/') ? r.url : '#/';
        return `<li><a class="act ${isNew ? 'new' : ''}" href="${esc(url)}">
          <span class="tile" style="width:40px;height:40px;background:${k.tint}">${icon(k.icon, 20)}</span>
          <span class="grow">
            <span class="act-title">${esc(r.title)}</span>
            <span class="act-body">${esc(r.body)}</span>
            <span class="act-time">${timeOf(r.created_at)}</span>
          </span>
          ${isNew ? '<i class="new-dot" role="img" aria-label="Nowe"></i>' : ''}
        </a></li>`;
      }).join('')}</ul>
    </section>`).join('');

  const empty = `<div class="dashed stack" style="align-items:center;text-align:center;gap:10px;margin-top:10px">
    ${cat(72, 'biala')}
    <p style="font-weight:800">Na razie cisza</p>
    <p class="muted" style="font-size:14px">Tu pojawi się wszystko, co zmieni druga osoba: propozycje, wiadomości, zakupy.</p>
  </div>`;

  return `<section class="screen">
    <header class="topbar">${backButton('#/')}<h1>Powiadomienia</h1><a class="round" href="#/ja" aria-label="Ustawienia powiadomień">${icon('bell', 20)}</a></header>
    ${list.length ? html : empty}
    <a class="btn ghost full" href="#/ja">Wybierz, o czym chcesz wiedzieć</a>
  </section>${tabbar('')}`;
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
    <p class="muted" style="font-size:14px">Niżej wybierzesz, o czym chcesz dostawać powiadomienia.</p>`;
  } else {
    push = `<p style="font-size:15px;line-height:1.45">Dostaniesz powiadomienie, gdy druga osoba coś zmieni, np. zaproponuje posiłek.</p>
      <button class="btn primary full" type="button" data-action="enable-push">${icon('bell', 20)}Włącz powiadomienia</button>`;
  }

  // Wynik „Sprawdź powiadomienia”
  const check = state.pushCheck ? `<ul class="check-list">${state.pushCheck.map(([label, ok, note]) => `
      <li class="${ok ? 'ok' : 'bad'}">
        <span class="mark">${icon(ok ? 'check' : 'x', 14, 3)}</span>
        <span class="grow">${esc(label)}${note ? `<small>${esc(note)}</small>` : ''}</span>
      </li>`).join('')}</ul>
    <p class="muted" style="font-size:13px;line-height:1.4">Próbne powiadomienie przychodzi, a zwykłe nie? Sprawdź w Supabase webhook (Integrations → Database Webhooks: tabela <b>activity</b>, zdarzenie Insert, funkcja ${PUSH_FUNCTION}).</p>` : '';
  push += `${status !== 'unsupported' ? `<button class="btn full" type="button" data-action="check-push">${icon('search', 18)}Sprawdź, czy działają</button>` : ''}${check}`;

  // Kategorie: co chcę dostawać
  const prefs = state.me.notify_prefs || {};
  const prefRows = Object.entries(KINDS).map(([key, k]) => `
    <li class="pref-row">
      <span class="tile" style="width:36px;height:36px;background:${k.tint}">${icon(k.icon, 18)}</span>
      <span class="grow"><span class="pref-label">${k.label}</span><span class="pref-desc">${k.desc}</span></span>
      <label class="switch"><input type="checkbox" data-pref="${key}" ${prefs[key] !== false ? 'checked' : ''} aria-label="${k.label}"><span></span></label>
    </li>`).join('');

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
    <section class="card stack" style="padding:16px" id="kategorie">
      <h2 style="font-size:20px">Co chcesz dostawać</h2>
      <p class="muted" style="font-size:14px;line-height:1.4">Wyłączone rzeczy nie przyjdą na telefon i nie pojawią się pod kocią łapką.</p>
      <ul class="pref-list">${prefRows}</ul>
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

const amountTimers = {}; // opóźniony zapis liczby sztuk, osobno dla każdej pozycji

// Rzecz z listy zakupów kupiona → przy składniku konkretnego dania zaznacz „mamy”.
// Dotyczy tylko tej jednej propozycji (np. dzisiejszego rosołu), nie bazy dań.
async function syncIngredient(proposalId, name, have) {
  if (!proposalId || !name) return;
  await run(sb.from('ingredients').update({ have }).eq('proposal_id', Number(proposalId)).eq('name', name));
}

// Natychmiast przełącz wygląd pozycji na liście (bez czekania na bazę)
function flipCheck(button) {
  const on = button.dataset.on !== 'true';
  button.dataset.on = String(on);
  button.setAttribute('aria-pressed', String(on));
  button.closest('li')?.classList.toggle('done', on);
  const tick = button.querySelector('.tick');
  if (tick) {
    tick.classList.toggle('on', on);
    tick.innerHTML = on ? icon('check', 16, 3) : '';
  }
  return on;
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
    logActivity('decyzje', 'Propozycja przyjęta', `${state.me.name} akceptuje ${p.dish_name} ${whenText(p.day, p.meal_type)}`, `#/propozycja/${id}`, id);
    toast('Ustalone! Dodajcie składniki.');
    location.hash = `#/propozycja/${id}`;
  },

  reject: async (el) => {
    const id = Number(el.dataset.id);
    const p = await run(sb.from('proposals').select('*').eq('id', id).single());
    await run(sb.from('proposals').update({
      status: 'odrzucona', decided_by: state.me.id, decided_at: new Date().toISOString(),
    }).eq('id', id));
    logActivity('decyzje', 'Propozycja odrzucona', `${state.me.name} odrzuca ${p.dish_name} ${whenText(p.day, p.meal_type)}`, `#/dzien/${p.day}`, id);
    toast('Odrzucone. Może kotek coś wylosuje?');
    render();
  },

  withdraw: async (el) => {
    if (!confirm('Wycofać tę propozycję?')) return;
    const id = Number(el.dataset.id);
    const p = await run(sb.from('proposals').select('*').eq('id', id).single());
    await logActivity('decyzje', 'Propozycja wycofana', `${state.me.name} wycofuje ${p.dish_name} (${whenText(p.day, p.meal_type)})`, `#/dzien/${p.day}`, id);
    await run(sb.from('proposals').delete().eq('id', id));
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
    if (added) logActivity('baza', 'Nowy pomysł w bazie', `${state.me.name} zapisuje na kiedyś: ${name}`, '#/baza');
    toast(added ? 'Zapisane w bazie dań' : 'To danie już jest w bazie');
    location.hash = '#/baza';
  },

  'toggle-ing': async (el) => {
    const on = flipCheck(el); // wykreśl od razu, zapisz w tle
    try {
      await run(sb.from('ingredients').update({ have: on }).eq('id', Number(el.dataset.id)));
    } catch (err) {
      flipCheck(el);
      throw err;
    }
    scheduleRefresh();
  },

  'del-ing': async (el) => {
    await run(sb.from('ingredients').delete().eq('id', Number(el.dataset.id)));
    await rememberIngredients(Number(el.dataset.proposal));
    logActivity('skladniki', `Składniki: ${el.dataset.dish}`, `${state.me.name} usuwa: ${el.dataset.name}`, `#/propozycja/${el.dataset.proposal}`, Number(el.dataset.proposal));
    render();
  },

  'to-shopping': async (el) => {
    const id = Number(el.dataset.id);
    const missing = await run(sb.from('ingredients').select('*').eq('proposal_id', id).eq('have', false).eq('added_to_list', false));
    if (!missing.length) return;
    const added = await run(sb.from('shopping_items').insert(missing.map((i) => ({ name: i.name, qty: i.qty, proposal_id: id }))).select());
    await run(sb.from('ingredients').update({ added_to_list: true }).in('id', missing.map((i) => i.id)));
    logActivity('zakupy_nowe', 'Lista zakupów', `${state.me.name} dodaje: ${listText(added.map((i) => i.name))} (do: ${el.dataset.dish})`, '#/zakupy', id);
    toast(`Na liście zakupów: +${missing.length}`);
    render();
  },

  quick: async (el) => {
    const id = Number(el.dataset.id);
    await run(sb.from('messages').insert({ proposal_id: id, body: el.dataset.text }));
    logActivity('wiadomosci', `Wiadomość: ${el.dataset.dish}`, `${state.me.name}: ${el.dataset.text}`, `#/propozycja/${id}`, id);
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
    const on = flipCheck(el);
    try {
      await run(sb.from('shopping_items').update({ checked: on }).eq('id', Number(el.dataset.id)));
    } catch (err) {
      flipCheck(el);
      throw err;
    }
    // Kupione = „mamy w lodówce” przy składniku tego dania (i odwrotnie po odznaczeniu)
    await syncIngredient(el.dataset.proposal, el.dataset.name, on);
    if (on) logActivity('zakupy_kupione', 'Zakupy', `${state.me.name} odhacza jako kupione: ${el.dataset.name}`, '#/zakupy');
    scheduleRefresh();
  },

  amount: (el) => {
    // Zmień liczbę od razu, a zapisz w bazie chwilę później (gdy przestaniesz klikać)
    const box = el.closest('.stepper');
    const label = box.querySelector('.amount');
    const next = Math.min(99, Math.max(1, Number(label.textContent) + Number(el.dataset.delta)));
    label.textContent = String(next);
    box.querySelector('[data-delta="-1"]').disabled = next <= 1;
    const id = Number(el.dataset.id);
    clearTimeout(amountTimers[id]);
    const name = box.dataset.name;
    amountTimers[id] = setTimeout(async () => {
      try {
        await run(sb.from('shopping_items').update({ amount: next }).eq('id', id));
        logActivity('zakupy_zmiany', 'Lista zakupów', `${state.me.name} zmienia liczbę: ${name} – ${next} szt.`, '#/zakupy');
      } catch (err) {
        showError(err);
      }
    }, 600);
  },

  'del-item': async (el) => {
    await run(sb.from('shopping_items').delete().eq('id', Number(el.dataset.id)));
    logActivity('zakupy_zmiany', 'Lista zakupów', `${state.me.name} usuwa z listy: ${el.dataset.name}`, '#/zakupy');
    render();
  },

  'clear-checked': async () => {
    if (!confirm('Usunąć z listy wszystko, co już kupione?')) return;
    // Zanim usuniesz kupione, oznacz je przy daniach jako „mamy”
    const bought = await run(sb.from('shopping_items').select('proposal_id, name').eq('checked', true));
    for (const item of bought) await syncIngredient(item.proposal_id, item.name, true);
    await run(sb.from('shopping_items').delete().eq('checked', true));
    if (bought.length) logActivity('zakupy_zmiany', 'Lista zakupów', `${state.me.name} usuwa kupione: ${listText(bought.map((i) => i.name))}`, '#/zakupy');
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

  'check-push': async () => {
    toast('Sprawdzam powiadomienia…');
    const lines = [];
    const installed = !isIOS() || isInstalled();
    lines.push(['Aplikacja otwarta z ikonki na ekranie początkowym', installed, installed ? '' : 'Otwórz Hungrycatora z ikonki, nie z Safari.']);
    const permission = 'Notification' in window ? Notification.permission : 'unsupported';
    const permNote = {
      denied: 'Zablokowane: Ustawienia iPhone’a → Powiadomienia → Hungrycator.',
      default: 'Stuknij „Włącz powiadomienia” powyżej.',
      unsupported: 'Ta przeglądarka nie obsługuje powiadomień.',
    }[permission] || '';
    lines.push(['Zgoda na powiadomienia', permission === 'granted', permNote]);
    let sub = null;
    try { sub = await currentSubscription(); } catch (e) { /* brak */ }
    lines.push(['Ten telefon ma adres do powiadomień', !!sub, sub ? '' : 'Stuknij „Włącz powiadomienia” powyżej.']);
    if (sub) {
      try {
        await saveSubscription(sub);
        lines.push(['Adres telefonu zapisany w bazie', true, '']);
      } catch (e) {
        lines.push(['Adres telefonu zapisany w bazie', false, e.message]);
      }
    }
    const { data, error } = await sb.functions.invoke(PUSH_FUNCTION, { body: { event: 'test' } });
    if (error) {
      lines.push([`Funkcja ${PUSH_FUNCTION} odpowiada`, false, await describeFunctionError(error)]);
    } else {
      lines.push([`Funkcja ${PUSH_FUNCTION} odpowiada`, true, '']);
      lines.push(['Klucz VAPID w sekretach', data.vapid === 'ok', data.vapid === 'ok' ? '' : data.vapid]);
      lines.push(['Telefony zapisane na Twoim koncie', data.subscriptions > 0, `zapisane: ${data.subscriptions}`]);
      const results = data.results || [];
      const sent = results.some((r) => r.status >= 200 && r.status < 300);
      const detail = results.map((r) => (r.status ? `kod ${r.status}: ${r.info}` : r.info)).join('; ');
      lines.push(['Próbne powiadomienie wysłane', sent, sent ? 'Powinno pojawić się za kilka sekund.' : detail || 'Nie było dokąd wysłać.']);
    }
    state.pushCheck = lines;
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
    const created = await run(sb.from('proposals').insert({ day, meal_type: meal, dish_name: dish, comment: comment || null }).select().single());
    if (f.get('save')) await saveDishIfNew(dish, meal);
    // Składniki zapamiętane przy tym daniu wstawiamy od razu
    const saved = (await findDish(dish))?.ingredients || [];
    if (saved.length) {
      await run(sb.from('ingredients').insert(saved.map((i) => ({ proposal_id: created.id, name: i.name, qty: i.qty || null }))));
      toast(`Wysłane! Składniki z bazy: ${saved.length}. Odhacz, co już macie.`);
    } else {
      toast('Wysłane! Dodaj od razu składniki.');
    }
    logActivity('propozycje', `Nowa propozycja: ${MEALS[meal].label.toLowerCase()}`,
      `${state.me.name} proponuje ${whenText(day, meal)}: ${dish}${comment ? ` – „${shorten(comment, 80)}”` : ''}`,
      `#/propozycja/${created.id}`, created.id);
    form.reset();
    state.focusAfterPaint = 'f-ing';
    location.hash = `#/propozycja/${created.id}`;
  },

  idea: async (form) => {
    const f = new FormData(form);
    const name = String(f.get('name')).trim();
    const tags = String(f.get('tags') || '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    const added = await saveDishIfNew(name, f.get('meal'), tags);
    if (added) logActivity('baza', 'Nowy pomysł w bazie', `${state.me.name} zapisuje na kiedyś: ${name}`, '#/baza');
    form.reset();
    state.ideaFormOpen = false;
    toast(added ? 'Pomysł zapisany!' : 'To danie już jest w bazie');
    render();
  },

  ingredient: async (form) => {
    const f = new FormData(form);
    // „twaróg, cebula, śmietana” → trzy osobne składniki
    const names = String(f.get('name')).split(/[,;\n]+/).map((n) => n.trim()).filter(Boolean)
      .map((n) => (n.charAt(0).toUpperCase() + n.slice(1)).slice(0, 80));
    if (!names.length) return;
    const qty = String(f.get('qty') || '').trim() || null;
    const proposalId = Number(form.dataset.id);
    await run(sb.from('ingredients').insert(names.map((name) => ({ proposal_id: proposalId, name, qty: names.length === 1 ? qty : null }))));
    form.reset();
    await rememberIngredients(proposalId);
    logActivity('skladniki', `Składniki: ${form.dataset.dish}`, `${state.me.name} dodaje: ${listText(names)}`, `#/propozycja/${proposalId}`, proposalId);
    await render();
    document.getElementById('f-ing')?.focus();
  },

  message: async (form) => {
    const f = new FormData(form);
    const body = String(f.get('body')).trim();
    if (!body) return;
    form.reset();
    const id = Number(form.dataset.id);
    await run(sb.from('messages').insert({ proposal_id: id, body }));
    logActivity('wiadomosci', `Wiadomość: ${form.dataset.dish}`, `${state.me.name}: ${body}`, `#/propozycja/${id}`, id);
    render();
  },

  item: async (form) => {
    const f = new FormData(form);
    // „mleko, jajka” → dwie pozycje, każda po 1 sztuce
    const names = String(f.get('name')).split(/[,;\n]+/).map((n) => n.trim()).filter(Boolean)
      .map((n) => (n.charAt(0).toUpperCase() + n.slice(1)).slice(0, 80));
    if (!names.length) return;
    const onList = await run(sb.from('shopping_items').select('id, name, amount').eq('checked', false));
    const fresh = [];
    for (const name of names) {
      const same = onList.find((i) => i.name.trim().toLowerCase() === name.toLowerCase());
      if (same) {
        // Już jest na liście: zamiast duplikatu zwiększ liczbę sztuk
        same.amount = Math.min(99, (same.amount || 1) + 1);
        await run(sb.from('shopping_items').update({ amount: same.amount }).eq('id', same.id));
        logActivity('zakupy_zmiany', 'Lista zakupów', `${state.me.name} zmienia liczbę: ${same.name} – ${same.amount} szt.`, '#/zakupy');
        toast(`${same.name}: już na liście, teraz ${same.amount} szt.`);
      } else {
        fresh.push({ name });
      }
    }
    if (fresh.length) {
      await run(sb.from('shopping_items').insert(fresh));
      logActivity('zakupy_nowe', 'Lista zakupów', `${state.me.name} dodaje: ${listText(fresh.map((i) => i.name))}`, '#/zakupy');
    }
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
  if (e.target.dataset.pref) savePref(e.target.dataset.pref, e.target.checked);
});

// Włącz/wyłącz kategorię powiadomień
async function savePref(key, on) {
  const prefs = { ...(state.me.notify_prefs || {}), [key]: on };
  state.me.notify_prefs = prefs;
  try {
    await run(sb.from('profiles').update({ notify_prefs: prefs }).eq('id', state.me.id));
    toast(`${KINDS[key].label}: ${on ? 'włączone' : 'wyłączone'}`);
  } catch (err) {
    showError(err);
  }
}

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
