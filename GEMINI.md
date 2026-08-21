# GEMINI.md -- Przewodnik dla agentow AI

> Ten plik to pojedyncze zrodlo prawdy (SSOT) i kontekst operacyjny dla kazdego agenta AI pracujacego nad projektem ROMHub.
> Przeczytaj go w calosci zanim zmodyfikujesz jakikolwiek plik.

---

## Czym jest ROMHub

ROMHub to klient-side platforma emulacji konsoli Nintendo 64 dzialajaca bezposrednio w przegladarce internetowej (desktop i mobile).
Projekt opiera sie na rdzeniu Mupen64Plus skompilowanym do WebAssembly (Emscripten), renderowaniu WebGL, przetwarzaniu dzwieku Web Audio API oraz silniku wieloosobowym WebRTC Peer-to-Peer (Netplay) z deterministycznym lockstepem wejsc.

**Kluczowe zalozenie architektoniczne:** Zero zaleznosci od serwerow backendowych w procesie emulacji. Cala emulacja, transfer ROM-ow i wymiana wejsc odbywaja sie lokalnie lub P2P pomiedzy przegladarkami graczy.

---

## Architektura Podsystemow

```
ROMHub Architecture
|-- Warstwa UI i Wejscia:
|   |-- index.html            Glowny punkt wejscia, viewport #gameStage, modale lobby
|   |-- css/style.css         Styling glassmorphic, responsywny viewport 4:3, animacje
|   |-- touch_controller.js   Wirtualny gamepad dotykowy w stylu PPSSPP (multi-touch, 360 analog, C-Buttons)
|   `-- input_controller.js   Mapowanie klawiatury, Gamepad API oraz remapping przyciskow
|
|-- Warstwa Sieciowa i Synchronizacji:
|   |-- netplay.js            Silnik WebRTC (PeerJS), proxy Gamepad API, streaming ROM z CRC32, Desync Guard
|   `-- logger.js             Przechwytywanie logow konsoli, filtrowanie pakietow binarnych, telemetria RTT/PPS
|
|-- Warstwa Mostka i Emulacji:
|   |-- script.js             Koordynator cyklu zycia, generowanie pliku config INI, zarzadzanie IndexedDB
|   |-- n64wasm.js            Mostek Emscripten JavaScript runtime (Module._*, ccall, cwrap)
|   `-- n64wasm.wasm          Skompilowany rdzen Mupen64Plus (C / C++)
|
`-- Narzedzia i Testy:
    `-- scripts/test_netplay_e2e.js  Automatyczny test E2E (Puppeteer: Host PC + Mobile Guest 4G)
```

---

## Kluczowe Decyzje Techniczne i Pulapki (Gotchas)

### 1. Pulapka `mobileMode = 1` w Rdzeniu C (Krytyczne dla Netplay)
- **Problem:** Gdy w pliku konfiguracyjnym emulatora parametr `mobileMode` jest ustawiony na `1`, funkcja C w Mupen64Plus wylacza odpytywanie `SDL_Joystick` dla Gracza 1 i uzywa wewnetrznej funkcji `neil_send_mobile_controls`, ktora zasila wylacznie Gracza 1, uniemozliwiajac sterowanie Graczowi 2.
- **Regula:** W metodzie `WriteConfigFile()` w pliku `script.js` w trybie Netplay (`isHost` lub `isClient`) parametr `mobileMode` MUSI byc ZAWSZE ustawiony na `0`. Odblokowuje to pelny pooling `navigator.getGamepads()` przez mostek SDL2 dla wszystkich 4 slotow kontrolerow.

### 2. Izolacja Surowego Gamepad API od Wirtualnego Proxy
- **Problem:** Proxy `navigator.getGamepads` wstrzykuje wirtualne kontrolery dla slotow 0-3. Jesli funkcja `captureLocalInputState()` odpyta `navigator.getGamepads()`, nastepuje zapetlenie i nadpisanie wcisnietych przyciskow pustym stanem wirtualnym.
- **Regula:** Referencja do natywnej funkcji przegladarki jest zapisywana w `this.origGetGamepads`. Odczyt fizycznych padow sprzetowych odbywa sie wylacznie przez `this.origGetGamepads()`.

### 3. Stabilne Petle Przesylania Wejsc (60 Hz `setInterval`)
- **Problem:** Metoda `requestAnimationFrame` w przegladarkach jest automatycznie dlawiona lub wstrzymywana, gdy karta jest nieaktywna, w tle lub w testach headless.
- **Regula:** W `netplay.js` petle nadawania wejsc (`startHostInputBroadcastLoop` oraz `startClientInputLoop`) uzywaja stalego interwalu `setInterval(loop, 16)`, gwarantujac nieprzerwany strumien 60 pakietow na sekunde.

### 4. Weryfikacja Spojnosci ROM-u przez CRC32
- **Zasada:** Host przesyla ROM do Goscia w paczkach po 32KB. Po zakonczeniu transferu Gosc oblicza sume kontrolna CRC32 calego bufora i odsyla pakiet `CLIENT_ROM_READY`. Host porownuje sume ze swoim plikiem. Dopiero przy 100% zgodnosci odblokowywany jest przycisk startu.

### 5. Desync Guard i Auto-Resync Stanu Gry
- **Mechanizm:** Co 8 sekund Host dokonuje eksportu stanu pamieci przez `Module._neil_serialize()` do wirtualnego pliku `/savestate.gz` i emituje sume kontrolna stanu. W przypadku desynchronizacji stan jest natychmiast strumieniowany do Goscia, ktory aplikuje go funkcja `Module._neil_unserialize()`.

### 6. Bez Emoji w Kodzie i Dokumentacji
- Zgodnie z zasadami projektu, w dokumentacji technicznej, logach oraz komentarzach obowiazuje calkowity zakaz uzywania emotikonow.

---

## Specyfikacja Protokolu 7-Bajtowego

Pakiety wejscia przesylane sa przez WebRTC DataChannel (`ordered: false`):

```
Bajt 0: 0x01 (TYPE_INPUT)
Bajt 1: PlayerSlot (0=P1, 1=P2, 2=P3, 3=P4)
Bajt 2: Buttons High Byte (Bity 8..15)
Bajt 3: Buttons Low Byte  (Bity 0..7)
Bajt 4: Stick X           (0..255, 128 = Neutral)
Bajt 5: Stick Y           (0..255, 128 = Neutral)
Bajt 6: Sequence Counter  (0..255)
```

### Mapa Bitowa Przyciskow:
- Bit 0: `Action_A`
- Bit 2: `Action_B`
- Bit 4: `Action_Z`
- Bit 5: `Action_R`
- Bit 6: `Action_L`
- Bit 9: `Action_Start`
- Bit 11: `Action_Menu`
- Bit 12: `D-Pad Up / C-Up`
- Bit 13: `D-Pad Down / C-Down`
- Bit 14: `D-Pad Left / C-Left`
- Bit 15: `D-Pad Right / C-Right`

---

## Procedury Uruchamiania i Testowania

### 1. Walidacja Skladni JS
```bash
node --check netplay.js script.js input_controller.js touch_controller.js logger.js
```

### 2. Automatyczny Test Wielokliencki E2E (Puppeteer)
```bash
node scripts/test_netplay_e2e.js
```

Skrypt uruchamia serwer HTTP, odpala instancje Hosta (Desktop) oraz Goscia (Mobile Pixel 7), laczy je przez WebRTC, weryfikuje transfer ROM z CRC32, odlicza start i potwierdza dwukierunkowy przeplyw danych wejsciowych w czasie rzeczywistym.

---

## Zasady Pracy nad Projektem

1. **Zawsze uruchamiaj testy E2E po modyfikacji logiki wejscia lub WebRTC.**
2. **Nie wprowadzaj zmian w ukladzie canvasu bez weryfikacji responsywnosci `#gameStage` na urzadzeniach mobilnych.**
3. **Utrzymuj pliki `README.md` oraz `GEMINI.md` w pelnej synchronizacji z biezacym kodem.**
4. **Zadnych obejsc (workarounds) -- eliminuj przyczyny zrodlowe problemow.**
