# 🎮 ROMHub

**ROMHub** is a high-performance, client-side Nintendo 64 web platform powered by WebAssembly (Mupen64Plus core) and a dual-mode WebRTC P2P multiplayer engine. It allows users to run retro titles directly inside modern desktop and mobile browsers at native 60 FPS with zero backend server dependencies for emulation.

---

## 🌟 Key Features

- ⚡ **Client-Side WebAssembly Core:** Compiled Mupen64Plus / ParaLLEl / Glide64 engine executing directly in the browser via WebAssembly and WebGL.
- 🌐 **Dual-Mode WebRTC Multiplayer (Netplay):**
  - **Mode A (⚡ Local WebGL ROM & Input Sync - Recommended):** Host streams ROM data in 32KB chunks directly to guests over P2P DataChannels in 1–2 seconds. Both peers execute local WebAssembly instances in sync via ultra-low-latency 7-byte binary input packets. 0ms video encoding lag, crystal-clear native resolution.
  - **Mode B (📺 Remote Video Stream):** Host captures active WebGL canvas (`canvas.captureStream(60)`) and streams video/audio directly to guests with interactive touch/gamepad input backchannel.
- 🕹️ **Glassmorphic Virtual Touch Gamepad:** Full N64 on-screen controller layout featuring floating 360° analog joystick, responsive D-Pad, Z trigger, A/B buttons, and dedicated C-Button cluster with multi-touch tracking and haptic feedback (`navigator.vibrate`).
- 🎮 **Hardware Gamepad & Keyboard Mapping:** Seamless integration with HTML5 Gamepad API (Xbox, PlayStation, 8BitDo, Switch Pro) and customizable keyboard keybindings.
- 💾 **Robust Persistence Layer:** Save states and battery saves (SRAM, EEPROM 4k/16k, FlashRAM) stored locally using browser `IndexedDB` with export/import capabilities.
- 🔬 **Real-Time Telemetry & Visual Diagnostics:** Built-in floating diagnostics console, live controller input verification inspector, connection metrics (RTT/Ping, PPS In/Out, throughput), and 1-click diagnostic reports.

---

## 🏗️ System Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                              BROWSER UI                                │
│   [ Glassmorphic Touch HUD ]  [ HTML5 Gamepad ]  [ Keyboard Remapper ] │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        ROMHUB NETPLAY ENGINE                           │
│   ├── Binary Packet Serializer (7-byte standard protocol)              │
│   ├── W3C Gamepad Proxy (4 virtual controller slots)                   │
│   ├── WebRTC DataChannel (P2P input sync & high-speed ROM transfer)    │
│   └── WebRTC MediaStream (Canvas video/audio capture for Mode B)       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   WEBASSEMBLY & EMSCRIPTEN BRIDGE                      │
│   ├── Emscripten Runtime Bridge (`ccall`, `cwrap`, `Module._*`)        │
│   ├── SDL2 Joystick & Event Pump (`navigator.getGamepads` routing)     │
│   └── Web Audio Resampling Ring Buffer (ScriptProcessor / Worklet)     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                 N64 CORE ENGINE (Compiled C / C++)                     │
│   ├── MIPS R4300i Dynamic Recompiler / Interpreter                     │
│   ├── Reality Co-Processor (RSP Vector DSP / RDP Rasterizer)           │
│   └── 4-Player Serial Interface (SI) Controller Management             │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 📡 Dual-Mode Multiplayer Architecture

### 1. Mode A: ⚡ Local WebGL (ROM & Input Sync)
- **Host Workflow:** Loads a local ROM file (`.z64`, `.v64`, `.n64`) and generates a 6-character room code (e.g. `ROM-E548`).
- **Connection Handshake:** When a guest connects via WebRTC DataChannel, the host streams the ROM binary in 32KB chunks with adaptive pacing.
- **Local Emulation:** Upon receiving the ROM, the guest reassembles the binary in memory and boots its own local WebAssembly emulator.
- **Lockstep 60 FPS Input Synchronization:**
  - Host captures local Player 1 inputs and broadcasts a 7-byte packet to all connected peers.
  - Guests capture their local inputs and transmit them to the Host.
  - Both instances inject remote inputs into their local `navigator.getGamepads()` virtual slots, ensuring both game worlds progress in exact lockstep.

### 2. Mode B: 📺 Remote Video Stream (Cloud Co-Op)
- Host captures its rendered WebGL canvas at 60 FPS with mixed Web Audio tracks and establishes a WebRTC MediaStream call.
- Guest receives the live low-latency video feed and transmits controller inputs over the DataChannel back to the Host.
- Ideal for ultra-low-spec guest devices or restricted bandwidth scenarios.

---

## 🕹️ 7-Byte Binary Input Protocol Specification

Input packets are transmitted over WebRTC DataChannel (`ordered: false`, binary serialization) at 60 FPS.

```
Byte 0: [ 0x01 (TYPE_INPUT) ]
Byte 1: [ Player Slot (0=P1, 1=P2, 2=P3, 3=P4) ]
Byte 2: [ Buttons High Byte (Bits 8..15) ]
Byte 3: [ Buttons Low Byte  (Bits 0..7)  ]
Byte 4: [ Analog Stick X    (0..255, 128 = Center) ]
Byte 5: [ Analog Stick Y    (0..255, 128 = Center) ]
Byte 6: [ Frame Sequence ID (0..255 Rolling Counter) ]
```

### Standard Button Bitmask Layout:
| Bit | Button Name | W3C Gamepad Index | Mupen64Plus Mapping |
|:---:|:------------|:-----------------:|:--------------------|
| 0 | Action A | Button 0 | `Joy_Mapping_Action_A` (0) |
| 1 | Alt Button B | Button 1 | Button 1 |
| 2 | Action B | Button 2 | `Joy_Mapping_Action_B` (2) |
| 3 | Button Y | Button 3 | Button 3 |
| 4 | Z Trigger | Button 4 | `Joy_Mapping_Action_Z` (4) |
| 5 | R Trigger | Button 5 | `Joy_Mapping_Action_R` (5) |
| 6 | L Trigger | Button 6 | `Joy_Mapping_Action_L` (6) |
| 7 | ZR / R2 | Button 7 | Button 7 |
| 8 | Select | Button 8 | Button 8 |
| 9 | Start | Button 9 | `Joy_Mapping_Action_Start` (9) |
| 10 | L-Stick Click | Button 10 | Button 10 |
| 11 | R-Stick / Menu | Button 11 | `Joy_Mapping_Menu` (11) |
| 12 | D-Pad Up / C-Up | Button 12 / Axis 3 (-) | `Joy_Mapping_Up` (12) |
| 13 | D-Pad Down / C-Down | Button 13 / Axis 3 (+) | `Joy_Mapping_Down` (13) |
| 14 | D-Pad Left / C-Left | Button 14 / Axis 2 (-) | `Joy_Mapping_Left` (14) |
| 15 | D-Pad Right / C-Right | Button 15 / Axis 2 (+) | `Joy_Mapping_Right` (15) |

---

## 🛠️ Project Structure

```
ROMHub/
├── index.html            # Main application UI, lobby modals & HUD
├── netplay.js            # WebRTC dual-mode multiplayer engine & Gamepad proxy
├── script.js             # Application coordinator, lifecycle & emulator bindings
├── input_controller.js   # Keyboard, Gamepad and Mobile input routing
├── touch_controller.js   # Glassmorphic multi-touch virtual gamepad
├── logger.js             # Diagnostic logger, telemetry collector & HUD
├── settings.js           # Configuration presets & constants
├── romlist.js            # ROM catalog metadata definitions
├── n64wasm.js            # Emscripten JavaScript runtime glue
├── n64wasm.wasm          # Compiled Mupen64Plus WebAssembly binary
├── assets.zip            # Core assets, fonts, and shaders
└── css/
    └── style.css         # Glassmorphism and responsive HUD styling
```

---

## 🚀 Getting Started

### Local Development Setup
ROMHub runs as a static web application and requires an HTTP/HTTPS server due to WebAssembly and WebRTC security policies.

1. **Serve using any static web server:**
   ```bash
   # Using Python 3:
   python3 -m http.server 8080

   # Or using Node.js (npx serve):
   npx serve . -p 8080
   ```

2. **Open in browser:**
   Navigate to `http://localhost:8080` in Chrome, Firefox, Safari, or Edge.

3. **Playing Multiplayer:**
   - **Host:** Click **Load ROM**, upload an N64 ROM file, then click **Play Online (Co-Op)**.
   - **Guest:** Open the invite URL or click **Join Online Game** and enter the 6-character room code.

---

## 🐞 Diagnostics & Debugging

- Click the floating **🐞 Logs & Diagnostics** button at any time (on desktop or mobile) to inspect:
  - Active Netplay Role and Room ID.
  - ICE connection state & DataChannel status.
  - Live Controller Input Inspector (verifying button presses and stick coordinates for both players in real-time).
  - Packet transmission rates (Packets Per Second) and RTT latency.
  - 1-click **Copy Report** button to export a full diagnostic report for issue tracking.

---

## ⚖️ Legal & Privacy Notice

- **Local Execution:** All ROM files, save files, and emulation computations are processed **100% locally** in your browser. No ROM data or game assets are stored on any remote servers.
- **Ownership Requirement:** Users must own legitimate physical copies of any games loaded into ROMHub.
- **P2P Privacy:** Netplay connections are established directly between players via encrypted WebRTC peer-to-peer data channels.
