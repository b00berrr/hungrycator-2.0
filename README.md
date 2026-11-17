# Hungrycator 🐾

Aplikacja do wspólnego planowania posiłków we dwoje. Działa w Safari na iPhonie i po dodaniu do ekranu początkowego zachowuje się jak zwykła apka, z powiadomieniami.

## Co jest w środku

| Plik | Do czego służy |
|---|---|
| `index.html` | strona startowa aplikacji |
| `style.css` | wygląd (kolory, przyciski, kotki) |
| `app.js` | cała logika i wszystkie ekrany |
| `ui.js` | ikonki, rysunki kotków, daty |
| `db.js` | połączenie z Supabase |
| `config.js` | **tu wpisujesz adres i klucz swojego projektu Supabase** |
| `sw.js` | odbiera powiadomienia w tle |
| `manifest.webmanifest`, `icons/` | nazwa i ikonka na ekranie początkowym |
| `supabase/schema.sql` | tabele bazy danych (wklejasz w SQL Editor) |
| `supabase/functions/send-push/index.ts` | funkcja wysyłająca powiadomienia |

## Ekrany

- `#/` – Dziś: propozycje na każdy posiłek, akceptuj / odrzuć / inna
- `#/nowa` – nowa propozycja
- `#/propozycja/ID` – szczegóły: składniki, lista zakupów, rozmowa
- `#/baza` – baza dań na kiedyś
- `#/losuj` – kotek losuje danie
- `#/plan` – plan tygodnia
- `#/zakupy` – wspólna lista zakupów
- `#/ja` – profil, powiadomienia, wylogowanie

Instrukcja uruchomienia jest w osobnym dokumencie od Claude'a.
