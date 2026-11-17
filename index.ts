// =====================================================================
//  send-push: wysyła powiadomienie na telefon drugiej osoby,
//  gdy w tabeli `proposals` pojawi się nowa propozycja.
//
//  Uruchamia ją Database Webhook (INSERT na tabeli proposals).
//  Potrzebne sekrety (Edge Functions → Secrets):
//    VAPID_PRIVATE_KEY  – klucz prywatny (JSON) z instrukcji
//    VAPID_CONTACT      – np. mailto:twoj@email.pl
//
//  Funkcja nie ufa treści z żądania: bierze z niego tylko numer
//  propozycji, a resztę czyta z bazy. Wysyła tylko dla świeżych
//  propozycji (do 5 minut), więc nie da się nią „spamować”.
// =====================================================================
import { createClient } from 'npm:@supabase/supabase-js@2';
import { buildPushHTTPRequest } from 'npm:@pushforge/builder@2';

type Gender = 'm' | 'f' | 'n';
const MEALS: Record<string, { label: string; acc: string; g: Gender }> = {
  sniadanie: { label: 'śniadanie', acc: 'śniadanie', g: 'n' },
  obiad: { label: 'obiad', acc: 'obiad', g: 'm' },
  kolacja: { label: 'kolacja', acc: 'kolację', g: 'f' },
  przekaska: { label: 'przekąska', acc: 'przekąskę', g: 'f' },
};
const TODAY_ADJ = { m: 'dzisiejszy', f: 'dzisiejszą', n: 'dzisiejsze' };
const TOMORROW_ADJ = { m: 'jutrzejszy', f: 'jutrzejszą', n: 'jutrzejsze' };
const ON_DAY = ['w niedzielę', 'w poniedziałek', 'we wtorek', 'w środę', 'w czwartek', 'w piątek', 'w sobotę'];

// Dzisiejsza data w Polsce jako RRRR-MM-DD
function todayInPoland(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw' }).format(new Date());
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// „na dzisiejszy obiad”, „na jutrzejszą kolację”, „na obiad w czwartek (20.11)”
function whenText(day: string, mealType: string): string {
  const meal = MEALS[mealType] ?? MEALS.obiad;
  const today = todayInPoland();
  if (day === today) return `na ${TODAY_ADJ[meal.g]} ${meal.acc}`;
  if (day === addDays(today, 1)) return `na ${TOMORROW_ADJ[meal.g]} ${meal.acc}`;
  const weekday = new Date(day + 'T12:00:00Z').getUTCDay();
  const [, month, dayOfMonth] = day.split('-');
  return `na ${meal.acc} ${ON_DAY[weekday]} (${dayOfMonth}.${month})`;
}

// Klucz administratora: nowy (SUPABASE_SECRET_KEYS) albo stary (SUPABASE_SERVICE_ROLE_KEY)
function adminKey(): string {
  const keys = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (keys) {
    try {
      const parsed = JSON.parse(keys);
      const value = parsed.default ?? Object.values(parsed)[0];
      if (value) return value as string;
    } catch (_) {
      // spróbuj starego klucza poniżej
    }
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
}

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', adminKey(), {
  auth: { persistSession: false },
});

Deno.serve(async (req) => {
  try {
    const payload = await req.json().catch(() => ({}));
    const id = payload?.record?.id;
    if (!id) return reply({ ok: false, reason: 'brak numeru propozycji' }, 400);

    const { data: proposal, error } = await supabase.from('proposals').select('*').eq('id', id).single();
    if (error || !proposal) return reply({ ok: false, reason: 'nie ma takiej propozycji' }, 404);

    const ageMs = Date.now() - new Date(proposal.created_at).getTime();
    if (ageMs > 5 * 60 * 1000) return reply({ ok: false, reason: 'propozycja jest za stara' });

    const { data: author } = await supabase.from('profiles').select('name').eq('id', proposal.author).single();
    const { data: subscriptions } = await supabase
      .from('push_subscriptions')
      .select('*')
      .neq('user_id', proposal.author);

    const meal = MEALS[proposal.meal_type] ?? MEALS.obiad;
    const message = {
      title: `Nowa propozycja: ${meal.label}`,
      body: `${author?.name ?? 'Ktoś'} proponuje ${whenText(proposal.day, proposal.meal_type)}: ${proposal.dish_name}`,
      url: `#/propozycja/${proposal.id}`,
      tag: `propozycja-${proposal.id}`,
    };

    const privateJWK = JSON.parse(Deno.env.get('VAPID_PRIVATE_KEY') ?? '{}');
    const adminContact = Deno.env.get('VAPID_CONTACT') ?? 'mailto:hungrycator@example.com';

    let sent = 0;
    for (const sub of subscriptions ?? []) {
      try {
        const request = await buildPushHTTPRequest({
          privateJWK,
          subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          message: { payload: message, adminContact, options: { ttl: 86400, urgency: 'high' } },
        });
        const res = await fetch(request.endpoint, { method: 'POST', headers: request.headers, body: request.body });
        if (res.status === 404 || res.status === 410) {
          // Telefon wypisał się z powiadomień: usuń nieaktualny adres
          await supabase.from('push_subscriptions').delete().eq('id', sub.id);
        } else if (res.ok) {
          sent++;
        } else {
          console.log('Błąd wysyłki', res.status, await res.text());
        }
      } catch (e) {
        console.log('Wyjątek przy wysyłce', e);
      }
    }
    return reply({ ok: true, sent });
  } catch (e) {
    console.log('Błąd funkcji', e);
    return reply({ ok: false, error: String(e) }, 500);
  }
});
