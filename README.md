# ROMHub

ROMHub is a client-side Nintendo 64 emulation platform built on WebAssembly and WebRTC. It executes retro titles inside desktop and mobile browsers at 60 FPS without requiring native plugins, backend compute servers, or game installation.

---

## Technical Overview

ROMHub compiles the Mupen64Plus emulation core to WebAssembly via Emscripten, rendering frames directly to an HTML5 WebGL canvas and outputting PCM audio through the Web Audio API. 

Peer-to-peer multiplayer is implemented over WebRTC DataChannels using a deterministic lockstep input pipeline. When a multiplayer session starts, the host transmits ROM data to connected clients in 32KB chunks. Once verified via CRC32 checksums, both instances boot the title locally and exchange 7-byte binary controller frames at 60 Hz with sub-frame input latency.

```
+-----------------------------------------------------------------------+
|                              Browser UI                               |
|   [ PPSSPP Touch HUD ]   [ HTML5 Gamepad ]   [ Keyboard Remapper ]    |
+-----------------------------------+-----------------------------------+
                                    |
                                    v
+-----------------------------------------------------------------------+
|                         ROMHub Netplay Engine                         |
|   - 7-byte Binary Input Serializer / Deserializer                     |
|   - W3C Gamepad Proxy (Slots 0 to 3)                                  |
|   - WebRTC DataChannel (P2P Input Sync, CRC32 ROM Transfer)           |
|   - Periodic State Desync Guard (Module._neil_serialize)              |
+-----------------------------------+-----------------------------------+
                                    |
                                    v
+-----------------------------------------------------------------------+
|                    WebAssembly & Emscripten Bridge                    |
|   - Emscripten Runtime Bridge (ccall, cwrap, Module._*)               |
|   - SDL2 Joystick & Event Subsystem (navigator.getGamepads)           |
|   - Web Audio Ring Buffer Resampling                                  |
+-----------------------------------+-----------------------------------+
                                    |
                                    v
+-----------------------------------------------------------------------+
|                   Mupen64Plus Core Engine (C / C++)                   |
|   - MIPS R4300i Dynamic Recompiler / Interpreter                      |
|   - Reality Co-Processor (RSP Vector DSP / RDP Rasterizer)            |
|   - 4-Player Serial Interface (SI) Controller Management              |
+-----------------------------------------------------------------------+
```

---

## Key Subsystems

### 1. WebAssembly Emulation Core
- **MIPS R4300i CPU Simulation:** Compiles M64P core logic to WebAssembly, executing cycle-accurate instruction sets.
- **Reality Coprocessor (RSP / RDP):** Hardware rasterization translated into WebGL 1.0 / 2.0 shader draw calls.
- **Audio Dynamic Resampling:** Web Audio ring buffer synchronizes emulation time with host audio hardware clock, preventing underflows.
- **Save State Persistence:** IndexedDB stores cartridge battery RAM (SRAM, FlashRAM, EEPROM 4k/16k) and memory snapshots (`/savestate.gz`).

### 2. Dual-Mode WebRTC Multiplayer

#### Mode A: Local WebGL ROM & Input Sync (Default)
1. **Lobby & Chunk Transfer:** The host opens a room code (e.g. `ROM-TEST`). When a guest joins, the host transmits the ROM over WebRTC DataChannel in 32KB slices.
2. **CRC32 Verification:** The guest reassembles the binary in memory and verifies its CRC32 checksum against the host manifest.
3. **Synchronized Launch:** The host issues a `LAUNCH_SYNC` command. Both machines execute a synchronized 3-2-1 countdown and boot WebAssembly simultaneously.
4. **Deterministic Lockstep:** Every 16 ms, peers exchange 7-byte input states. The `NetplayManager` injects incoming packets into virtual slots in `navigator.getGamepads()`.
5. **Desync Guard:** The host periodically exports save states via `Module._neil_serialize()` and verifies state integrity. If desynchronization occurs, the state snapshot is sent to guests and restored with `Module._neil_unserialize()`.

#### Mode B: Remote Canvas Video Stream
The host captures the active WebGL canvas via `canvas.captureStream(60)` and streams video/audio over a WebRTC MediaStream call. The guest transmits input events back to the host via DataChannel.

### 3. PPSSPP-Grade Glassmorphic Virtual Gamepad
- **Dynamic Floating 360 Analog Stick:** Spawns anywhere within the left thumb area upon touch, providing variable analog deflection.
- **Ergonomic N64 Layout:** Dedicated Z-trigger button below the analog stick, action buttons A and B, four C-buttons (C-Up, C-Down, C-Left, C-Right), and upper shoulder buttons (L, R, Start).
- **Multi-Touch Engine:** Distinct touch identifier tracking allows simultaneous stick movement, trigger holds, and button taps.
- **Haptic Feedback:** Optional micro-vibrations via `navigator.vibrate`.

---

## 7-Byte Binary Input Protocol Specification

Input frames are transmitted over unordered WebRTC DataChannels at 60 Hz.

### Packet Byte Structure

```
+--------+------------+-------------------+------------------+---------------+---------------+-------------------+
| Byte 0 |   Byte 1   |      Byte 2       |      Byte 3      |    Byte 4     |    Byte 5     |      Byte 6       |
+--------+------------+-------------------+------------------+---------------+---------------+-------------------+
|  0x01  | PlayerSlot | Buttons High Byte | Buttons Low Byte | Analog StickX | Analog StickY | Sequence ID (0-255)|
+--------+------------+-------------------+------------------+---------------+---------------+-------------------+
```

### Bitmask Mapping Table

| Bit Index | Controller Input | W3C Gamepad Standard Index | N64 Mapping Target |
|:---------:|:-----------------|:--------------------------:|:-------------------|
| 0 | Action A | Button 0 | Joy_Mapping_Action_A (0) |
| 1 | Alt B | Button 1 | Unused |
| 2 | Action B | Button 2 | Joy_Mapping_Action_B (2) |
| 3 | Button Y | Button 3 | Unused |
| 4 | Z Trigger | Button 4 | Joy_Mapping_Action_Z (4) |
| 5 | R Trigger | Button 5 | Joy_Mapping_Action_R (5) |
| 6 | L Trigger | Button 6 | Joy_Mapping_Action_L (6) |
| 7 | ZR / R2 | Button 7 | Unused |
| 8 | Select | Button 8 | Unused |
| 9 | Start | Button 9 | Joy_Mapping_Action_Start (9) |
| 10 | Stick Click | Button 10 | Unused |
| 11 | Menu | Button 11 | Joy_Mapping_Menu (11) |
| 12 | D-Pad Up / C-Up | Button 12 | Joy_Mapping_Up (12) |
| 13 | D-Pad Down / C-Down | Button 13 | Joy_Mapping_Down (13) |
| 14 | D-Pad Left / C-Left | Button 14 | Joy_Mapping_Left (14) |
| 15 | D-Pad Right / C-Right | Button 15 | Joy_Mapping_Right (15) |

- **Analog Stick Coordinates:** Encoded in Bytes 4 and 5 as unsigned integers `[0, 255]`, where `128` represents center neutral, `0` is full negative, and `255` is full positive.

---

## File Structure

```
ROMHub/
|-- css/
|   `-- style.css           # Glassmorphism styling, responsive canvas viewport, PPSSPP HUD
|
|-- js/
|   |-- FileSaver.min.js    # Client-side file saving utility
|   |-- nipplejs.min.js     # Legacy touch fallback library
|   `-- peerjs.min.js       # WebRTC signaling and DataChannel client
|
|-- scripts/
|   `-- test_netplay_e2e.js # Automated multi-client Puppeteer WebRTC E2E test harness
|
|-- index.html              # Main application entry point, viewport layout, modals
|-- netplay.js              # WebRTC engine, Gamepad proxy, CRC32 streaming, Desync Guard
|-- script.js               # Application lifecycle coordinator and Emscripten bindings
|-- touch_controller.js     # PPSSPP-style virtual multi-touch gamepad
|-- input_controller.js     # Keyboard, Gamepad API, and button remapping
|-- logger.js               # Diagnostic logger, binary packet filter, telemetry collector
|-- n64wasm.js              # Emscripten compiled JavaScript runtime
|-- n64wasm.wasm            # Compiled Mupen64Plus WebAssembly binary
|-- assets.zip              # Shaders, ROM catalog assets, and system configurations
|-- package.json            # Node.js dependencies for automated testing
|-- GEMINI.md               # AI agent operating guide and single source of truth
`-- README.md               # Project documentation
```

---

## Development Setup

ROMHub runs as a static web application and requires an HTTP/HTTPS server due to WebAssembly cross-origin isolation and WebRTC security constraints.

### 1. Run Local Development Server
Using Python:
```bash
python3 -m http.server 8080
```

Or using Node.js:
```bash
npx serve . -p 8080
```

Open `http://localhost:8080` in Chrome, Firefox, Safari, or Edge.

---

## Automated Multi-Client E2E Testing

The project includes an end-to-end test harness using Puppeteer to simulate real-world multiplayer sessions between desktop and mobile clients.

### Test Execution
```bash
node scripts/test_netplay_e2e.js
```

### Verified Test Sequence:
1. Spawns an internal HTTP server and launches two headless Chromium browser instances.
2. Configures Browser 1 as Desktop Host (1920x1080) and Browser 2 as Mobile Guest (Pixel 7 viewport with touch emulation).
3. Host stages a synthetic ROM and initializes a WebRTC room.
4. Guest connects via DataChannel, receives 32KB ROM slices, reassembles data, and verifies CRC32 checksums.
5. Host acknowledges Player 2 readiness and triggers a synchronized countdown.
6. Guest simulates touch stick deflection and button presses; Host verifies reception of 7-byte binary packets in slot P2.
7. Host simulates Player 1 controls; Guest verifies reception in slot P1.

---

## Diagnostics & Telemetry

Open the in-app debug terminal by clicking the diagnostics button in the floating HUD. The diagnostic suite provides:
- WebRTC broker status, ICE candidate states, and DataChannel status.
- Real-time round-trip latency (RTT) and frame transmission rate (PPS).
- Controller visualizer showing real-time button states and analog stick coordinates for both players.
- Diagnostic report generator exportable to clipboard for troubleshooting.

---

## License & Compliance

- **Client-Side Execution:** All emulation logic and ROM decoding execute strictly in browser memory on the user's hardware.
- **Cartridge Rights:** Users must provide their own legitimately acquired ROM backups.
- **P2P Encryption:** Netplay sessions communicate over DTLS-encrypted WebRTC channels directly between peers.
