# Doświadczenie VR o dezinformacji

Statyczne doświadczenie WebXR dla Meta Quest 2. Nie ma kroku budowania ani
instalowania paczek. Folder można wrzucić na hosting z HTTPS.

## Uruchomienie lokalne

```bash
cd dezinformacja-vr
python3 -m http.server 5174
```

Potem otwórz:

```text
http://localhost:5174
```

Na goglach trzeba użyć hostingu HTTPS. WebXR nie wystartuje z pliku otwartego
bezpośrednio z dysku.

## Audio

Narracja jest przygotowana w konfiguracji w `src/experience.config.js`.
Na razie cue'y mają tylko czasy zastępcze. Gdy będą nagrania, wrzuć pliki do:

```text
assets/audio/
```

Nazwy:

```text
r1_01.mp3, r1_02.mp3, ...
r2_01.mp3, ...
r5_03.mp3
```

Obsługiwane są `mp3`, `m4a` i `wav`. Po dodaniu głosu wystarczy dopasować czasy
`duration`, pauzy `pauseAfter` i momenty `events` w jednym pliku:

```text
src/experience.config.js
```

## Test szybki

Do szybkiego testu bez czekania czterech minut:

```text
http://localhost:5174/?fast=1
```

Tryb szybki skraca timeline wizualny. W produkcji używaj adresu bez `?fast=1`.

## Struktura

```text
index.html
styles.css
src/app.js
src/experience.config.js
assets/img/
assets/audio/
vendor/three.module.js
```

## Quest 2

1. Wgraj caly folder na hosting HTTPS.
2. Otwórz adres w Meta Quest Browser.
3. Kliknij `WEJDZ W VR`.
4. Dalej obsługa idzie przez patrzenie na cel lub kolejne zdjęcia.

Po zakończeniu doświadczenie wraca do celu startowego i może ruszyć dla
następnej osoby bez wychodzenia z sesji VR.
