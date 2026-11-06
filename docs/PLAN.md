# s-maker: plan aplikacji

> Aplikacja webowa do tworzenia utworów w [Strudel](https://strudel.cc): import MIDI → kod Strudel, wspólne komponowanie z agentem LLM, dzielenie się utworami, czat i wall dla małej grupy (5–8 osób).
> Repo: https://github.com/data2048/s-maker (publiczne, licencja AGPL-3.0, tak jak Strudel).

---

## 1. Wymagania (uzgodnione)

### Ogólne

- Jeden kontener Docker na VPS, aplikacja na porcie **44566**, HTTPS na istniejącym reverse proxy.
- Interfejs po **angielsku**; z agentem można pisać w dowolnym języku.
- Responsywny układ od początku; pełne dopracowanie pod telefon w późniejszym etapie.
- Bezpieczeństwo według **OWASP Top 10** w każdym PR (sekcja 4).
- `deploy.sh` rozwijany razem z aplikacją: pobranie repo, backup, build, podmiana kontenera, healthcheck i rollback.

### Użytkownicy

- Logowanie loginem i hasłem, **bez publicznej rejestracji**: admin generuje jednorazowe linki zaproszeń.
- Role: `admin` i `user`. Admin zarządza zaproszeniami, kontami, limitami kosztów i modelami.

### Muzyka

- Odtwarzacz i edytor Strudel w aplikacji, z ręczną edycją kodu.
- Utwór składa się ze **ścieżek** (nazwa, instrument, kod) z mute/solo.
- **Historia wersji** każdego utworu: cofanie, porównanie, warianty (rozgałęzienia).
- **Import MIDI** w dwóch trybach:
  - **Faithful**: nuta w nutę, z kwantyzacją.
  - **Essence**: skrócone wzorce, pętle, wykryte sekcje.
- Mapowanie General MIDI → soundfonty Strudel (`gm_*`), kanał 10 → sample perkusyjne.
- Automatyczne rozpoznanie typu MIDI (heurystyki + opcjonalnie agent) z ręczną korektą.

### Agent

- Dwa sposoby pracy: **czat przy utworze** i **polecenia per ścieżka**.
- Praca na materiale źródłowym (zaimportowane MIDI) albo **komponowanie od zera** z parametrów.
- **Karta utworu (Music Brief)** z 14 elementami: melodia, rytm, metrum, tempo, harmonia, tonacja, dynamika, artykulacja, barwa, faktura, forma, styl, akcentacja, ornamentyka. Agogika jest pominięta, bo Strudel jej nie wspiera; zostaje tylko zmiana tempa między sekcjami.
- Agent domyślnie **nie tłumaczy**. Na prośbę generuje plik `.md` z kodem i objaśnieniem, ze szczegółowością podaną w prośbie. Plik jest zapisany przy utworze i widoczny dla grupy.
- Kontrola kosztów: **najpierw chińskie modele** (DeepSeek, Qwen, Kimi, GLM, MiniMax); OpenAI/Claude dopiero, gdy te nie dadzą rady.
- Licznik kosztów i limit tygodniowy per użytkownik oraz globalny.

### Społeczność

- Utwory **domyślnie widoczne dla grupy**, z opcją „prywatny”. Fork cudzego utworu.
- **Czat**: kanał ogólny i wiadomości prywatne (DM), przypięty utwór do odsłuchu w wiadomości, panel czatu można przypiąć i schować.
- **Wall**: lista postów z komentarzami, opcjonalnie z załączonym utworem.

### Później

- Eksport WAV/MP3 i MIDI, dopracowanie mobile (iOS audio unlock, dotykowy edytor).
- Lokalny mirror sampli i soundfontów (niezależność od GitHuba).

---

## 2. Architektura

```
┌──────────────────────── kontener s-maker (:44566) ─────────────────────────┐
│  Fastify (Node, TypeScript)                                                │
│   ├─ REST API  /api/*        (zod walidacja, sesje w cookie)               │
│   ├─ WebSocket /ws           (czat, powiadomienia)                         │
│   ├─ Agent service ──────────► OpenRouter (modele z konfiguracji)          │
│   ├─ MIDI parser + analiza + konwerter (pakiet shared)                     │
│   ├─ statyczny frontend (React + Vite)                                     │
│   └─ /sandbox/  strona odtwarzacza Strudel                                 │
│  SQLite (better-sqlite3 + Drizzle) ── wolumen /data (baza, uploady MIDI)   │
└────────────────────────────────────────────────────────────────────────────┘

Przeglądarka:
  Aplikacja (React)  ◄── postMessage ──►  <iframe sandbox="allow-scripts">
  (sesja, API)                             Strudel REPL: eval kodu + audio
                                           (origin „null”: brak dostępu do
                                            cookies, API i danych aplikacji)
```

### Stack

| Warstwa   | Wybór                                                                    | Dlaczego                                                |
| --------- | ------------------------------------------------------------------------ | ------------------------------------------------------- |
| Język     | TypeScript wszędzie                                                      | Strudel i biblioteki MIDI to JS; typy łapią błędy       |
| Backend   | Fastify + `@fastify/websocket`, `@fastify/helmet`, `@fastify/rate-limit` | lekki, szybki, dojrzałe pluginy bezpieczeństwa          |
| Baza      | SQLite + Drizzle ORM + migracje                                          | jeden plik, zero osobnego serwera, wystarcza dla 8 osób |
| Walidacja | zod (wspólne schematy front/back)                                        | jedno źródło prawdy dla danych wejściowych              |
| Frontend  | React + Vite + React Router + TanStack Query                             | najlepiej znany modelom i w dokumentacji                |
| Edytor    | CodeMirror (`@strudel/codemirror`)                                       | natywne podświetlanie Strudela                          |
| Audio     | `@strudel/web` / `@strudel/repl` + soundfonty GM                         | oficjalne pakiety                                       |
| MIDI      | własny parser i zapis SMF (`packages/shared/src/midi`)                   | pełna kontrola limitów dla niezaufanych plików          |
| Testy     | Vitest, Playwright (e2e w późniejszych PR)                               |                                                         |
| Hasła     | argon2id                                                                 | rekomendacja OWASP                                      |
| Markdown  | `marked` + DOMPurify                                                     | bezpieczne renderowanie wall, czatu i objaśnień         |

### Struktura repo (monorepo, npm workspaces)

```
s-maker/
├─ apps/
│  ├─ server/        # Fastify, API, WS, agent, db
│  └─ web/           # React SPA + strona /sandbox
├─ packages/
│  └─ shared/        # typy, schematy zod, MIDI→Strudel, walidator AST, mapy GM
├─ kb/               # baza wiedzy agenta (ściąga Strudel, mapa 14 elementów)
├─ scripts/          # build-strudel-kb.ts (Firecrawl), eval-models.ts
├─ docs/             # PLAN.md, SECURITY.md, threat-model.md
├─ Dockerfile
├─ deploy.sh
└─ .env.example
```

### Kluczowe decyzje projektowe

**1. Kod Strudel = kod JavaScript, więc wykonuje się wyłącznie w piaskownicy.**
Udostępniony utwór kolegi lub kod od agenta to dowolny JS, a podatny na to jest m.in. prompt injection przez nazwy ścieżek w MIDI. Dlatego:

- Odtwarzacz działa w `<iframe sandbox="allow-scripts">` **bez** `allow-same-origin`. Kod nie widzi cookies, nie może wołać API jako zalogowany użytkownik ani czytać strony aplikacji.
- Komunikacja aplikacja ↔ odtwarzacz odbywa się przez `postMessage` z wąskim protokołem (`load`, `play`, `stop`, `error`, `validated`).
- **Walidator AST** (w `shared`): parsuje kod (acorn) i odrzuca niedozwolone konstrukcje (`fetch`, `window`, `document`, `import`, `eval`, `Function`, `constructor`, `__proto__`…). Dla kodu agenta to twarda reguła, dla kodu użytkownika ostrzeżenie. Mamy dwie warstwy obrony.
- Serwer **nigdy** nie wykonuje kodu Strudel, więc nie ma ryzyka RCE.
- Pierwszy krok PR 2 to spike: sprawdzenie, czy Strudel (audio, soundfonty, localStorage) działa w nieprzezroczystym originie. Wniosek trafia do `docs/`.

**2. Model utworu**

```
Song { id, ownerId, title, visibility: group|private, forkedFromId, brief: MusicBrief, currentVersionId }
SongVersion { id, songId, number, parentVersionId, author: user|agent, message, code }
```

(Zmienione w PR 3.) Wersja utworu to **jeden kod Strudel**, tak jak na strudel.cc. Ścieżki to etykietowane wzorce najwyższego poziomu (`bass: ...`), a ich lista w mikserze jest wyprowadzana z kodu parserem (`packages/shared/src/strudel/tracks.ts`):

- mute to wbudowany w Strudel prefiks `_bass:`, a solo to prefiks `Sbass:`;
- instrument to `.s("gm_...")`, a automat perkusyjny to `.bank("...")`;
- zmiany z miksera to małe edycje tekstu kodu.

Dzięki temu edytor, mikser i odtwarzacz zawsze pokazują to samo, działa podświetlanie nut, a kod można skopiować 1:1 do strudel.cc.

**3. Music Brief**: obiekt JSON z 14 elementami, globalnie i opcjonalnie per sekcja. Wypełniany:

- formularzem lub rozmową, przy komponowaniu od zera;
- automatycznie z analizy MIDI.

Agent czyta go przy każdym wywołaniu i zwraca proponowane zmiany.

**4. Agent**

- Klient OpenRouter (API zgodne z OpenAI), modele z konfiguracji. **Bez hardkodowania ID**, bo ID weryfikujemy na liście `/api/v1/models` w momencie implementacji:
  - `MODEL_FAST`: tani chiński, do drobnych zmian ścieżek i klasyfikacji MIDI;
  - `MODEL_STRONG`: najmocniejszy chiński, do komponowania i dużych przeróbek;
  - `MODEL_FALLBACK`: model innego dostawcy, gdy pierwszy zawiedzie; później może OpenAI lub Claude.
- Odpowiedź agenta to **strukturalny JSON** (`trackChanges[]`, `briefChanges`, `summary`), a nie wolny tekst.
- Pętla walidacji:
  1. walidator AST;
  2. próbne wykonanie w piaskownicy u klienta (zapytanie o pierwsze N cykli);
  3. przy błędzie automatyczna poprawka (max 2 próby);
  4. podgląd zmian (diff) → akceptuj/odrzuć → nowa wersja.
- Wiedza: `kb/strudel-cheatsheet.md` (zbudowane raz skryptem Firecrawl z dokumentacji strudel.cc i ręcznie przejrzane) oraz `kb/music-elements.md` (mapa 14 elementów → środki Strudel, wraz z ograniczeniami). Stały kontekst jest na początku promptu, żeby działał prompt caching.
- Wewnętrzna checklista 14 elementów w promptcie systemowym: co zmieniam, a co musi zostać spójne z kartą utworu.
- Dane z MIDI (nazwy ścieżek, teksty) trafiają do promptu jako **dane w osobnej sekcji**, przycięte i oczyszczone. To obrona przed prompt injection.
- `scripts/eval-models.ts` to zestaw kilkunastu zadań testowych. Uruchamiamy go dla kandydatów i porównujemy jakość, koszt i % kodu przechodzącego walidację. Na tej podstawie decydujemy, kiedy przejść na droższy model.

**5. Kontrola kosztów**

- Każde wywołanie trafia do logu: użytkownik, model, tokeny i koszt, który OpenRouter zwraca w `usage`.
- Limit tygodniowy per użytkownik i globalny (konfigurowalny przez admina). Po przekroczeniu agent odmawia z jasnym komunikatem.
- Panel admina z wydatkami; każdy użytkownik widzi swój licznik.

**6. Konwersja MIDI → Strudel** (pakiet `shared`, testowany jednostkowo)

- **Analiza:**
  - mapa tempa i metrum;
  - tonacja (algorytm Krumhansla-Schmucklera);
  - statystyki velocity, czyli dynamika i akcenty;
  - stosunek długości nut do odstępów, czyli artykulacja;
  - polifonia i gęstość, czyli faktura;
  - powtarzające się takty i sekcje, czyli forma;
  - instrumenty GM, czyli barwa.
- **Klasyfikacja typu:**
  - kategorie: band pop/rock, solo piano, orkiestra/klasyka, elektronika/loop, jazz, chiptune/game, inne;
  - heurystyki: liczba ścieżek, perkusja, programy GM, gęstość, stabilność tempa;
  - doprecyzowanie przez agenta (opcjonalne, tani model) i ręczna korekta.
- **Faithful:**
  - 1 cykl = 1 takt;
  - siatka kwantyzacji do wyboru (1/16, 1/32, wykrywanie trioli);
  - akordy jako `[c3,e3,g3]`, długości przez `@`, pauzy `~`;
  - sekwencje taktów przez `<...>` lub `cat`;
  - velocity jako wyrównany wzorzec `.velocity(...)`.
- **Essence:** wykryte powtarzalne takty i sekcje kompresowane do pętli i `arrange(...)`, uproszczone do dominujących wzorców.
- Fixtures testowe: **generowane programowo** pliki MIDI (bez praw autorskich), golden tests kodu oraz testy „round-trip”: odpytanie wygenerowanego wzorca w Node i porównanie nut z oryginałem. Tylko w testach, na naszym własnym kodzie.

### Model danych (SQLite)

- `users`, `invites`, `sessions`, `audit_log`
- `songs`, `song_versions`, `midi_uploads`, `song_explanations`
- `agent_threads`, `agent_messages`, `agent_calls` (log kosztów), `cost_limits`
- `chat_channels` (`general` | `dm`), `chat_members`, `chat_messages` (z opcjonalnym `songId`)
- `wall_posts`, `wall_comments`

---

## 3. Podział na PR-y

Każdy PR: osobny branch → testy i CI na zielono → **testujesz na VPS** (`./deploy.sh <branch>`) → merge do `main`.

### Kamień milowy 1: działa i gra

#### PR 0: Fundament

- Monorepo (npm workspaces), TypeScript strict, ESLint + Prettier.
- Fastify z `/health`; React + Vite serwowany przez serwer.
- SQLite + Drizzle + system migracji (uruchamiane przy starcie).
- Dockerfile multi-stage: obraz `node:*-slim`, **użytkownik bez roota**, tylko `/data` zapisywalne.
- `deploy.sh` v1, `.env.example`, `LICENSE` (AGPL-3.0), `README.md`, `SECURITY.md`.
- GitHub Actions: lint, typecheck, test, build, `npm audit`; Dependabot.
- Bazowe nagłówki bezpieczeństwa (helmet) i brak stack trace’ów w produkcji.
- **Test:** `./deploy.sh` na VPS → `https://<domena>/health` zwraca `ok`, strona startowa się ładuje.

#### PR 1: Logowanie i zaproszenia

- Pierwsze uruchomienie: konto admina z `ADMIN_USERNAME`, a jednorazowy link ustawienia hasła pojawia się w logach kontenera.
- Zaproszenia: jednorazowe, wygasające (np. 72 h), tokeny przechowywane jako hash.
- Login i logout; sesje w bazie, cookie `HttpOnly` + `Secure` + `SameSite=Lax`, rotacja ID sesji po zalogowaniu.
- Ochrona CSRF (sprawdzanie `Origin` + token dla zmian stanu).
- Rate limiting i opóźnianie po nieudanych logowaniach; audit log logowań.
- Profil: zmiana hasła, nazwa wyświetlana. Admin: lista użytkowników, dezaktywacja, zaproszenia.
- Testy kontroli dostępu (anonim / user / admin) dla każdego endpointu.
- **Test:** zakładasz konto admina, zapraszasz kolegę, oboje się logujecie; nieudane logowania są blokowane.

#### PR 2: Odtwarzacz Strudel w piaskownicy

- Spike i decyzja: Strudel w `iframe sandbox` (wynik w `docs/`).
- Strona `/sandbox` z Strudel REPL i protokołem `postMessage`.
- Walidator AST w `shared`, z testami prób ucieczki z piaskownicy.
- CSP: zezwolenie na hosty sampli i soundfontów, poza tym restrykcyjnie.
- Ekran „Playground”: edytor, play/stop, wyświetlanie błędów.
- **Test:** wklejasz przykład z workshopu Strudel i gra; kod `fetch('/api/me')` jest zablokowany lub nie ma dostępu do sesji.

### Kamień milowy 2: MIDI i utwory

#### PR 3: Utwory, ścieżki, wersje

- CRUD utworów; edytor ścieżek (osobny edytor per ścieżka, widok pełnego kodu).
- Mute/solo, zmiana instrumentu (lista GM).
- Historia wersji: lista, podgląd, diff, przywrócenie, nowy wariant.
- Widoczność `group` / `private` z egzekwowaniem na serwerze.
- **Test:** tworzysz utwór z 3 ścieżkami, zapisujesz, zmieniasz, wracasz do starszej wersji.

#### PR 4: Import MIDI, część 1 (faithful)

- Upload `.mid`: limit 2 MB, sprawdzenie nagłówka `MThd`, limity ścieżek i nut. Plik trafia do bazy (BLOB), więc żadna ścieżka na dysku nie powstaje z danych użytkownika, a uploady są w zwykłym backupie wolumenu. Każdy widzi tylko swoje pliki (50 ostatnich).
- Parsowanie i analiza: tempo, metrum, tonacja, instrumenty, zakres, liczba nut.
- Widok ścieżek z MIDI: wybór, które importować.
- Pełna mapa GM 128 programów → `gm_*`, mapa perkusji GM → sample.
- Konwersja w trybie faithful z wyborem siatki kwantyzacji.
- Fixtures i testy round-trip.
- (Zrobione w PR 4.) Kod: 1 cykl = 1 takt, `setcpm(bpm/ćwierćnut_w_takcie)`, jedna pozycja `<...>` na takt, powtórzone takty jako `!n`, nakładające się nuty rozdzielone na głosy (`,` albo `stack(...)` gdy głosy mają własną dynamikę), perkusja jako `s("bd sd hh")` na `.bank("RolandTR909")`. Podgląd na żywo w odtwarzaczu przed utworzeniem utworu. Testy round-trip uruchamiają wygenerowany kod w samym Strudelu (Node) i porównują nuty z plikiem.
- **Test:** wrzucasz własne MIDI, widzisz ścieżki z instrumentami i słyszysz je w Strudel.

#### PR 5: Import MIDI, część 2 (essence, klasyfikacja, brief)

- Wykrywanie powtórzeń i sekcji; tryb essence.
- Klasyfikacja typu MIDI z ręczną korektą.
- Automatycznie wypełniona karta utworu (Music Brief) i widok/edycja karty.
- (Zrobione w PR 5.) Essence: bloki 1–32 taktów grupowane podobieństwem (Jaccard ≥ 0,7), dla sekcji najczęstsza wersja każdego taktu, maks. 3 głosy, `const sekcja = ...` i `arrange([takty, sekcja], ...)`. Klasyfikacja to same heurystyki; doprecyzowanie przez agenta można dodać później. Karta to 14 pól tekstowych, zapisana przy utworze.
- **Test:** ten sam plik w obu trybach; porównujesz długość i czytelność kodu oraz kartę utworu.

### Kamień milowy 3: agent

#### PR 6: Fundament agenta i polecenia per ścieżka

- Klient OpenRouter, modele z konfiguracji (domyślnie chińskie), retry i timeouty.
- `scripts/build-strudel-kb.ts` (Firecrawl) → `kb/` po ręcznym przeglądzie; `kb/music-elements.md`.
- Prompt systemowy: rola, 14 elementów, checklista, format odpowiedzi JSON, zasady bezpieczeństwa.
- Polecenie per ścieżka („zmień tę ścieżkę: …”) → walidacja → diff → akceptuj/odrzuć.
- Log kosztów, limity per użytkownik i globalne, licznik w UI, panel admina.
- `scripts/eval-models.ts` i pierwsze porównanie chińskich modeli.
- Wynik porównania (2026-11-06, 12 zadań, kod uruchamiany w prawdziwym playerze; wszystkie modele 12/12):

  | Model                           | Za 1. razem | Koszt 12 zadań | Średni czas | Rola     |
  | ------------------------------- | ----------- | -------------- | ----------- | -------- |
  | `deepseek/deepseek-v4.1-flash`  | 12          | $0,03          | 9 s         | szybki   |
  | `deepseek/deepseek-v4-pro-0813` | 12          | $0,20          | 22 s        | mocny    |
  | `z-ai/glm-5.3`                  | 11          | $0,07          | 17 s        | zapasowy |
  | `qwen/qwen3.8-flash`            | 11          | $0,03          | 65 s        | za wolny |

  Test sprawdza, czy kod działa, a nie czy brzmi dobrze: wybór trzeba jeszcze potwierdzić uchem. Modele zmienia się w panelu admina.

- **Test:** na zaimportowanym utworze piszesz „zrób bas bardziej synkopowany”, dostajesz diff, akceptujesz i słyszysz zmianę; koszt widoczny w liczniku.

#### PR 7: Czat z agentem i komponowanie od zera

- Wątek czatu przy utworze (historia, streaming odpowiedzi).
- Kreator nowego utworu: formularz 14 elementów i/lub rozmowa → Music Brief → pierwsza wersja.
- Praca na sekcjach (zwrotka, refren…) i budowa formy przez `arrange`.
- Decyzje: każda osoba ma własną rozmowę o utworze; zmiana z czatu to ta sama propozycja co z polecenia (sprawdzenie w playerze, diff, akceptacja, nowa wersja); utwór z kreatora powstaje jako prywatny, a jego pierwsza wersja czeka na akceptację.
- **Test:** tworzysz utwór od zera z opisu, iterujesz w czacie, każda zmiana to nowa wersja.

#### PR 8: Objaśnienie `.md`

- Polecenie „explain” z poziomem szczegółowości → plik `.md` z kodem i objaśnieniem.
- Zapis przy wersji utworu, bezpieczny render, pobranie pliku, widoczne dla grupy (zgodnie z widocznością utworu).
- **Test:** prosisz o objaśnienie „krótko” i „szczegółowo”, oba widoczne przy utworze.

### Kamień milowy 4: społeczność

#### PR 9: Udostępnianie

- Galeria utworów grupy (filtry: autor, data, typ), strona utworu z odtwarzaczem.
- Fork cudzego utworu (z zachowaniem informacji o źródle).
- **Test:** kolega otwiera twój utwór, gra go i robi fork; prywatnego utworu nie widzi.

#### PR 10: Czat

- WebSocket z autoryzacją sesją i sprawdzaniem `Origin`.
- Kanał ogólny i DM; nieprzeczytane wiadomości; historia z paginacją.
- Przypięty utwór w wiadomości z odtwarzaniem; wysyłka respektuje widoczność utworu.
- Panel czatu: przypnij/schowaj, zapamiętany stan.
- Rate limiting wiadomości i bezpieczny render treści.
- **Test:** rozmawiasz z kolegą na kanale i w DM, wysyłasz utwór i on go odtwarza z wiadomości.

#### PR 11: Wall

- Lista postów z komentarzami, markdown (sanityzowany), opcjonalnie załączony utwór.
- Edycja i usuwanie własnych postów; admin moderuje.
- **Test:** post z utworem, komentarze od kolegi.

### Kamień milowy 5: dopracowanie

#### PR 12: Eksport i mobile

- Nagrywanie wyjścia audio do WAV (i ewentualnie MP3), eksport utworu do MIDI.
- Dopracowanie układu na telefon, odblokowanie audio na iOS, lżejsze ładowanie soundfontów.
- Opcjonalnie: lokalny mirror sampli i soundfontów w kontenerze.

Duże PR-y (4, 6, 7) mogą zostać podzielone na mniejsze w trakcie pracy.

---

## 4. Bezpieczeństwo (OWASP Top 10) — checklista dla każdego PR

| Kategoria                         | Środki w s-maker                                                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A01 Broken Access Control**     | sprawdzanie właściciela i widoczności na serwerze dla każdego zasobu; deny-by-default; testy dostępu per endpoint                                                                                |
| **A02 Cryptographic Failures**    | argon2id; tokeny zaproszeń i sesji losowe (CSPRNG), w bazie jako hash; sekrety tylko w `.env` na VPS; cookie `Secure`                                                                            |
| **A03 Injection**                 | zapytania przez Drizzle (parametryzowane); zod na każdym wejściu; DOMPurify przy renderze markdown; kod Strudel tylko w piaskownicy + walidator AST; obrona przed prompt injection z danych MIDI |
| **A04 Insecure Design**           | `docs/threat-model.md`; limity kosztów; jednorazowe, wygasające zaproszenia                                                                                                                      |
| **A05 Security Misconfiguration** | helmet + restrykcyjne CSP; brak stack trace’ów w produkcji; kontener bez roota, read-only poza `/data`; `trustProxy` tylko dla proxy                                                             |
| **A06 Vulnerable Components**     | lockfile + `npm ci`; `npm audit` w CI; Dependabot                                                                                                                                                |
| **A07 Auth Failures**             | rate limiting i opóźnianie logowań; rotacja sesji; wygasanie sesji; minimalna długość hasła i sprawdzanie popularnych haseł                                                                      |
| **A08 Integrity Failures**        | build z lockfile; CI przed merge; obrazy tagowane hashem commita                                                                                                                                 |
| **A09 Logging & Monitoring**      | audit log (logowania, akcje admina, wywołania agenta), bez haseł i tokenów w logach                                                                                                              |
| **A10 SSRF**                      | serwer nie pobiera URL-i od użytkowników; Firecrawl tylko w skrypcie budującym bazę wiedzy                                                                                                       |

Dodatkowo:

- upload MIDI: limit rozmiaru i liczby nut, sprawdzenie formatu, plik w bazie (bez ścieżek z danych użytkownika), rate limit 20/min;
- WebSocket: autoryzacja sesją, sprawdzanie `Origin`, limit wiadomości.

---

## 5. `deploy.sh` (rozwijany w każdym PR)

Wersja v1 w PR 0. Użycie: `./deploy.sh [branch]` (domyślnie `main`).

1. Klonuje repo, jeśli go nie ma; inaczej `git fetch` + checkout wskazanego brancha.
2. Sprawdza `.env` (wymagane zmienne). Jeśli czegoś brakuje, przerywa z listą braków.
3. Robi backup bazy SQLite z datą i zostawia N ostatnich kopii.
4. Buduje obraz `s-maker:<commit>`.
5. Zatrzymuje stary kontener i uruchamia nowy:
   - port `44566`, bindowany do adresu z `.env` (domyślnie `127.0.0.1`, jeśli proxy działa na tym samym hoście);
   - wolumen `/data`;
   - `--restart unless-stopped`.
6. Czeka na `/health`. Jeśli kontener nie wstanie, wraca do poprzedniego obrazu.
7. Usuwa stare obrazy, zostawiając 3 ostatnie.

Każdy PR dopisuje do skryptu i `.env.example` to, czego potrzebuje (nowe zmienne, migracje, katalogi).

---

## 6. Ryzyka i otwarte kwestie

| Ryzyko                                                                            | Plan                                                                            |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Strudel może nie działać w pełni w sandboxie z originem `null` (np. localStorage) | spike na początku PR 2; plan B: osobna subdomena dla odtwarzacza                |
| Jakość chińskich modeli przy kodzie Strudel                                       | baza wiedzy + walidacja z autopoprawką + eval-models; fallback na OpenAI/Claude |
| Długie i gęste MIDI dają ogromny kod w trybie faithful                            | limit taktów lub ścieżek z ostrzeżeniem; tryb essence jako zalecany             |
| Sample i soundfonty ładowane z GitHuba                                            | działa od razu; lokalny mirror w PR 12                                          |
| Budżet OpenRouter (obecnie 2 $/tydzień)                                           | nowy klucz ~10–15 $/tydzień + limity w aplikacji                                |

---

## 7. Do przygotowania po twojej stronie

- [ ] Nowy klucz OpenRouter z limitem ~10–15 $/tydzień.
- [ ] Klucz Firecrawl (potrzebny w PR 6).
- [ ] Na VPS: Docker, git, katalog na aplikację; informacja, czy reverse proxy działa na tym samym hoście (wtedy bind `127.0.0.1:44566`).
- [ ] Domena/subdomena skierowana na proxy → `:44566`.
