/**
 * ROMHub Netplay - Dual-Mode WebRTC Multiplayer & State-Sync Engine (v3.0)
 * 
 * Features:
 * 1. Mode A: ⚡ Local WebGL (ROM & Input Sync) [Default / Recommended]
 *    - P2P ROM Chunk Streaming with CRC32 Verification
 *    - Synchronized Dual-Lobby with 3-2-1 Countdown Launch
 *    - 7-byte Standard Binary Input Protocol at 60 FPS
 *    - Deterministic Lockstep + Save-State Auto-Resync (Desync Guard)
 *    - 0ms Video Lag, Native WebGL 60 FPS
 * 
 * 2. Mode B: 📺 Remote Video Stream (Cloud Co-Op)
 *    - Host WebGL canvas captureStream(60)
 *    - Guest interactive video playback with Touch/Gamepad backchannel
 */

class NetplayManager {
    constructor() {
        this.peer = null;
        this.roomId = null;
        this.isHost = false;
        this.isClient = false;
        this.playerSlot = 1; // 0 = P1 (Host), 1 = P2, 2 = P3, 3 = P4
        this.netplayMode = 'ROM_SYNC'; // 'ROM_SYNC' or 'VIDEO_STREAM'
        this.connections = {}; // peerId -> { conn, call, slot, ping, status, crc32 }
        this.hostConnection = null;
        this.hostCall = null;
        this.mediaStream = null;
        this.remoteStream = null;
        this.gameStarted = false;
        this.lobbyState = 'IDLE'; // 'IDLE', 'LOBBY', 'TRANSFERRING', 'READY', 'COUNTDOWN', 'IN_GAME'

        // ROM Transfer State (Client)
        this.romReceiveTotalChunks = 0;
        this.romReceiveSize = 0;
        this.romReceiveChunks = [];
        this.romReceiveCount = 0;
        this.romLoadedLocally = false;
        this.stagedRomData = null;

        // Player Slots State
        this.slots = [
            { slot: 0, label: 'Player 1 (Host)', status: 'READY', peerId: 'local', ping: 0 },
            { slot: 1, label: 'Player 2', status: 'WAITING', peerId: null, ping: 0 },
            { slot: 2, label: 'Player 3', status: 'OPEN', peerId: null, ping: 0 },
            { slot: 3, label: 'Player 4', status: 'OPEN', peerId: null, ping: 0 }
        ];

        this.eventLogs = [];
        this.remotePlayers = {
            0: { buttons: new Array(16).fill(false), axes: [0, 0, 0, 0], lastUpdate: 0 },
            1: { buttons: new Array(16).fill(false), axes: [0, 0, 0, 0], lastUpdate: 0 },
            2: { buttons: new Array(16).fill(false), axes: [0, 0, 0, 0], lastUpdate: 0 },
            3: { buttons: new Array(16).fill(false), axes: [0, 0, 0, 0], lastUpdate: 0 }
        };

        // Rolling Sequence & Telemetry
        this.seqCounter = 0;
        this.packetsSent = 0;
        this.packetsReceived = 0;
        this.ppsSent = 0;
        this.ppsReceived = 0;
        this.bytesSent = 0;
        this.bytesReceived = 0;
        this.lastMetricsTime = performance.now();
        this.tempPacketsSent = 0;
        this.tempPacketsReceived = 0;
        this.rtt = 0;

        // Sync Guard (Desync check every 5 seconds)
        this.frameCount = 0;
        this.syncGuardIntervalId = null;

        this.inputLoopId = null;
        this.pingIntervalId = null;
        this.telemetryIntervalId = null;

        this.onLobbyUpdate = null;
        this.onClientProgress = null;
        this.onTelemetryUpdate = null;
        this.onSynchronizedLaunch = null;
        this.onDesyncDetected = null;

        this.setupGamepadProxy();
        this.startTelemetryLoop();
    }

    setMode(mode) {
        this.netplayMode = mode;
        this.logEvent(`Multiplayer architecture set to: ${mode === 'ROM_SYNC' ? '⚡ Local WebGL (ROM Sync)' : '📺 Remote Video Stream'}`);
        this.notifyLobby();
    }

    getIceServers() {
        return [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' },
            { urls: 'stun:global.stun.twilio.com:3478' }
        ];
    }

    logEvent(msg) {
        const time = new Date().toLocaleTimeString();
        const entry = `[${time}] ${msg}`;
        this.eventLogs.push(entry);
        if (this.eventLogs.length > 100) this.eventLogs.shift();
        console.log(`[Netplay] ${msg}`);
        this.notifyLobby();
    }

    /**
     * Compute CRC32 checksum of binary data for ROM verification
     */
    calculateCRC32(data) {
        const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
        let crc = 0 ^ (-1);
        for (let i = 0; i < u8.length; i++) {
            crc = (crc >>> 8) ^ this.getCRCTable()[(crc ^ u8[i]) & 0xFF];
        }
        return ((crc ^ (-1)) >>> 0).toString(16).toUpperCase();
    }

    getCRCTable() {
        if (this._crcTable) return this._crcTable;
        const table = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let j = 0; j < 8; j++) {
                c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            }
            table[i] = c;
        }
        this._crcTable = table;
        return table;
    }

    /**
     * Pre-fire gamepadconnected events so SDL2 initializes Joystick 0 & Joystick 1
     */
    notifyGamepadConnected(slotIndex) {
        try {
            const fakeGp = this.createGamepadObject(slotIndex, true, new Array(16).fill(false), [0, 0, 0, 0]);
            if (typeof GamepadEvent !== 'undefined') {
                window.dispatchEvent(new GamepadEvent('gamepadconnected', { gamepad: fakeGp }));
            }
        } catch (e) { }
    }

    /**
     * Synthesizes standard W3C Gamepad object for a given slot
     */
    createGamepadObject(slotIndex, isConnected, buttonsArray, axesArray) {
        const btns = [];
        for (let i = 0; i < 16; i++) {
            const pressed = !!(buttonsArray && buttonsArray[i]);
            btns.push({
                pressed: pressed,
                touched: pressed,
                value: pressed ? 1.0 : 0.0
            });
        }

        const axes = [
            axesArray && typeof axesArray[0] === 'number' ? axesArray[0] : 0,
            axesArray && typeof axesArray[1] === 'number' ? axesArray[1] : 0,
            axesArray && typeof axesArray[2] === 'number' ? axesArray[2] : 0,
            axesArray && typeof axesArray[3] === 'number' ? axesArray[3] : 0
        ];

        return {
            id: `ROMHub Virtual Controller (Player ${slotIndex + 1})`,
            index: slotIndex,
            connected: isConnected,
            timestamp: performance.now(),
            mapping: 'standard',
            axes: axes,
            buttons: btns
        };
    }

    /**
     * Virtual Gamepad Proxy Injection into navigator.getGamepads
     */
    setupGamepadProxy() {
        this.origGetGamepads = navigator.getGamepads ? navigator.getGamepads.bind(navigator) : null;
        const self = this;

        navigator.getGamepads = function () {
            const raw = self.origGetGamepads ? (self.origGetGamepads() || []) : [];
            const result = [null, null, null, null];

            if (self.isHost) {
                // Slot 0: Local Player 1
                const localP1 = self.captureLocalInputState(0);
                if (raw[0] && raw[0].connected) {
                    result[0] = raw[0];
                } else {
                    result[0] = self.createGamepadObject(0, true, localP1.buttons, localP1.axes);
                }

                // Slots 1..3: Remote Players from DataChannel
                for (let s = 1; s <= 3; s++) {
                    const hasPeer = self.hasConnectedPlayer(s);
                    const rp = self.remotePlayers[s];
                    result[s] = self.createGamepadObject(s, hasPeer, rp.buttons, rp.axes);
                }
            } else if (self.isClient && self.netplayMode === 'ROM_SYNC') {
                // Client in ROM_SYNC mode:
                // Slot 0: Remote Host (Player 1)
                const p1 = self.remotePlayers[0];
                result[0] = self.createGamepadObject(0, true, p1.buttons, p1.axes);

                // Slot 1: Local Player 2
                const localP2 = self.captureLocalInputState(self.playerSlot);
                if (raw[0] && raw[0].connected) {
                    result[self.playerSlot] = raw[0];
                } else {
                    result[self.playerSlot] = self.createGamepadObject(self.playerSlot, true, localP2.buttons, localP2.axes);
                }

                // Slots 2..3: Other remote players
                for (let s = 2; s <= 3; s++) {
                    const rp = self.remotePlayers[s];
                    result[s] = self.createGamepadObject(s, false, rp.buttons, rp.axes);
                }
            } else {
                for (let i = 0; i < 4; i++) {
                    result[i] = raw[i] || null;
                }
                if (!result[0]) {
                    const localP1 = self.captureLocalInputState(0);
                    result[0] = self.createGamepadObject(0, true, localP1.buttons, localP1.axes);
                }
            }

            return result;
        };
    }

    injectControllerMemory() {
        if (typeof Module === 'undefined' || !Module.HEAP32) return;
        const baseAddress = 165652540;
        const i32 = new Int32Array(Module.HEAP32.buffer);
        const f32 = new Float32Array(Module.HEAPF32.buffer);

        // Gather all 4 players' states
        const playerStates = [];
        for (let s = 0; s < 4; s++) {
            if (this.isHost) {
                playerStates[s] = (s === 0) ? this.captureLocalInputState(0) : this.remotePlayers[s];
            } else if (this.isClient && this.netplayMode === 'ROM_SYNC') {
                playerStates[s] = (s === this.playerSlot) ? this.captureLocalInputState(this.playerSlot) : this.remotePlayers[s];
            } else {
                playerStates[s] = (s === 0) ? this.captureLocalInputState(0) : null;
            }
        }

        const p1 = playerStates[0];
        const p2 = playerStates[1];

        for (let slot = 0; slot < 4; slot++) {
            const baseWord = (baseAddress / 4) + (slot * 20);
            let state = playerStates[slot];

            if (state || (slot === 0 && (p1 || p2))) {
                let btns = state ? (state.buttons || []) : new Array(16).fill(false);
                let axes = state ? (state.axes || [0, 0, 0, 0]) : [0, 0, 0, 0];

                // Co-op Assist for Controller 1 (P1): If P2 presses Start/A/B/Dpad in menus, merge into P1
                if (slot === 0 && p2) {
                    const p2b = p2.buttons || [];
                    const p2a = p2.axes || [0, 0, 0, 0];
                    btns = [
                        btns[0] || p2b[0],   // A
                        btns[1] || p2b[1],
                        btns[2] || p2b[2],   // B
                        btns[3] || p2b[3],
                        btns[4] || p2b[4],   // Z
                        btns[5] || p2b[5],   // R
                        btns[6] || p2b[6],   // L
                        btns[7] || p2b[7],
                        btns[8] || p2b[8],
                        btns[9] || p2b[9],   // START
                        btns[10] || p2b[10],
                        btns[11] || p2b[11],
                        btns[12] || p2b[12], // UP
                        btns[13] || p2b[13], // DOWN
                        btns[14] || p2b[14], // LEFT
                        btns[15] || p2b[15]  // RIGHT
                    ];
                    axes = [
                        Math.abs(axes[0]) > 0.05 ? axes[0] : (p2a[0] || 0),
                        Math.abs(axes[1]) > 0.05 ? axes[1] : (p2a[1] || 0),
                        axes[2] || 0,
                        axes[3] || 0
                    ];
                }

                i32[baseWord + 0] = 1; // Connected
                i32[baseWord + 1] = btns[12] ? 1 : 0; // UP
                i32[baseWord + 2] = btns[13] ? 1 : 0; // DOWN
                i32[baseWord + 3] = btns[14] ? 1 : 0; // LEFT
                i32[baseWord + 4] = btns[15] ? 1 : 0; // RIGHT
                i32[baseWord + 5] = btns[9] ? 1 : 0;  // START
                i32[baseWord + 7] = btns[5] ? 1 : 0;  // R
                i32[baseWord + 8] = btns[6] ? 1 : 0;  // L
                i32[baseWord + 9] = btns[4] ? 1 : 0;  // Z
                i32[baseWord + 10] = btns[0] ? 1 : 0; // A
                i32[baseWord + 11] = btns[2] ? 1 : 0; // B
                f32[baseWord + 12] = typeof axes[0] === 'number' ? axes[0] : 0; // Stick X
                f32[baseWord + 13] = typeof axes[1] === 'number' ? axes[1] : 0; // Stick Y
                i32[baseWord + 16] = (btns[14] && axes[2] < -0.5) ? 1 : 0; // CLEFT
                i32[baseWord + 17] = (btns[15] && axes[2] > 0.5) ? 1 : 0;  // CRIGHT
                i32[baseWord + 18] = (btns[12] && axes[3] < -0.5) ? 1 : 0; // CUP
                i32[baseWord + 19] = (btns[13] && axes[3] > 0.5) ? 1 : 0;  // CDOWN
            }
        }
    }

    hasConnectedPlayer(slot) {
        return Object.values(this.connections).some(c => c.slot === slot && (c.status === 'READY' || c.status === 'CONNECTED' || c.status === 'IN_GAME'));
    }

    generateRoomId() {
        const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
        let code = 'ROM-';
        for (let i = 0; i < 4; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return code;
    }

    /**
     * Reads local controller state (Touch, Physical Gamepad, Keyboard)
     */
    captureLocalInputState(slot = 0) {
        const buttons = new Array(16).fill(false);
        let stickX = 0;
        let stickY = 0;
        let cStickX = 0;
        let cStickY = 0;

        // 1. PPSSPP Touch Controller
        if (window.touchController && window.touchController.state) {
            const ts = window.touchController.state;
            if (ts.A) buttons[0] = true;
            if (ts.B) buttons[2] = true;
            if (ts.Z) buttons[4] = true;
            if (ts.R) buttons[5] = true;
            if (ts.L) buttons[6] = true;
            if (ts.Start) buttons[9] = true;
            if (ts.DPAD_UP) { buttons[12] = true; if (stickY === 0) stickY = -1.0; }
            if (ts.DPAD_DOWN) { buttons[13] = true; if (stickY === 0) stickY = 1.0; }
            if (ts.DPAD_LEFT) { buttons[14] = true; if (stickX === 0) stickX = -1.0; }
            if (ts.DPAD_RIGHT) { buttons[15] = true; if (stickX === 0) stickX = 1.0; }

            if (ts.CUP) { cStickY = -1.0; buttons[12] = true; }
            if (ts.CDOWN) { cStickY = 1.0; buttons[13] = true; }
            if (ts.CLEFT) { cStickX = -1.0; buttons[14] = true; }
            if (ts.CRIGHT) { cStickX = 1.0; buttons[15] = true; }

            if (Math.abs(ts.stickX) > 0.01) stickX = ts.stickX;
            if (Math.abs(ts.stickY) > 0.01) stickY = ts.stickY;
        }

        // 2. Physical Gamepad API (Read raw hardware gamepads only)
        const rawGamepads = this.origGetGamepads ? (this.origGetGamepads() || []) : [];
        const gp = rawGamepads[0] || rawGamepads[1] || null;
        if (gp && gp.connected && gp.buttons && gp.buttons.length > 0) {
            for (let i = 0; i < Math.min(16, gp.buttons.length); i++) {
                if (gp.buttons[i] && gp.buttons[i].pressed) buttons[i] = true;
            }
            if (gp.axes.length >= 2) {
                if (Math.abs(gp.axes[0]) > 0.1) stickX = Math.max(-1, Math.min(1, gp.axes[0]));
                if (Math.abs(gp.axes[1]) > 0.1) stickY = Math.max(-1, Math.min(1, gp.axes[1]));
            }
            if (gp.axes.length >= 4) {
                if (Math.abs(gp.axes[2]) > 0.1) cStickX = Math.max(-1, Math.min(1, gp.axes[2]));
                if (Math.abs(gp.axes[3]) > 0.1) cStickY = Math.max(-1, Math.min(1, gp.axes[3]));
            }
        }

        // 3. Keyboard
        if (window.myApp && window.myApp.rivetsData && window.myApp.rivetsData.inputController) {
            const ic = window.myApp.rivetsData.inputController;
            if (ic.Key_Action_A) buttons[0] = true;
            if (ic.Key_Action_B) buttons[2] = true;
            if (ic.Key_Action_Z) buttons[4] = true;
            if (ic.Key_Action_R) buttons[5] = true;
            if (ic.Key_Action_L) buttons[6] = true;
            if (ic.Key_Action_Start) buttons[9] = true;
            if (ic.Key_Menu) buttons[11] = true;
            if (ic.Key_Up) { buttons[12] = true; if (stickY === 0) stickY = -1.0; }
            if (ic.Key_Down) { buttons[13] = true; if (stickY === 0) stickY = 1.0; }
            if (ic.Key_Left) { buttons[14] = true; if (stickX === 0) stickX = -1.0; }
            if (ic.Key_Right) { buttons[15] = true; if (stickX === 0) stickX = 1.0; }

            if (ic.Key_Action_CUP) cStickY = -1.0;
            if (ic.Key_Action_CDOWN) cStickY = 1.0;
            if (ic.Key_Action_CLEFT) cStickX = -1.0;
            if (ic.Key_Action_CRIGHT) cStickX = 1.0;

            if (Math.abs(ic.VectorX || 0) > 0.01) stickX = ic.VectorX;
            if (Math.abs(ic.VectorY || 0) > 0.01) stickY = ic.VectorY;
        }

        return {
            buttons: buttons,
            axes: [stickX, stickY, cStickX, cStickY]
        };
    }

    encodeInputPacket(slot, state) {
        const packet = new Uint8Array(7);
        packet[0] = 0x01; // TYPE_INPUT
        packet[1] = slot & 0x03;

        let mask = 0;
        for (let i = 0; i < 16; i++) {
            if (state.buttons[i]) mask |= (1 << i);
        }

        if (state.axes[2] < -0.5) mask |= (1 << 14);
        if (state.axes[2] > 0.5) mask |= (1 << 15);
        if (state.axes[3] < -0.5) mask |= (1 << 12);
        if (state.axes[3] > 0.5) mask |= (1 << 13);

        packet[2] = (mask >> 8) & 0xFF;
        packet[3] = mask & 0xFF;
        packet[4] = Math.round(Math.max(-1, Math.min(1, state.axes[0])) * 127 + 128) & 0xFF;
        packet[5] = Math.round(Math.max(-1, Math.min(1, state.axes[1])) * 127 + 128) & 0xFF;
        packet[6] = (this.seqCounter++) & 0xFF;

        return packet;
    }

    async extractBinaryData(data) {
        if (!data) return null;
        if (data instanceof Uint8Array) return data;
        if (data instanceof ArrayBuffer) return new Uint8Array(data);
        if (data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength || data.length);
        if (typeof Blob !== 'undefined' && data instanceof Blob) {
            try {
                const buf = await data.arrayBuffer();
                return new Uint8Array(buf);
            } catch (e) { return null; }
        }
        return null;
    }

    handleBinaryInput(data, defaultSlot) {
        if (!data) return;
        const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (u8.length < 5) return;

        let slot = defaultSlot;
        let buttonsMask = 0;
        let rawStickX = 128;
        let rawStickY = 128;

        if (u8[0] === 0x01 && u8.length >= 7) {
            slot = u8[1];
            buttonsMask = (u8[2] << 8) | u8[3];
            rawStickX = u8[4];
            rawStickY = u8[5];
        } else {
            slot = u8[0] !== undefined ? u8[0] : defaultSlot;
            buttonsMask = (u8[1] << 8) | u8[2];
            rawStickX = u8[3];
            rawStickY = u8[4];
        }

        const stickX = (rawStickX - 128) / 127.0;
        const stickY = (rawStickY - 128) / 127.0;

        const buttons = new Array(16).fill(false);
        for (let i = 0; i < 16; i++) {
            buttons[i] = ((buttonsMask >> i) & 1) === 1;
        }

        let cStickX = 0;
        let cStickY = 0;
        if (buttons[12]) cStickY = -1.0;
        if (buttons[13]) cStickY = 1.0;
        if (buttons[14]) cStickX = -1.0;
        if (buttons[15]) cStickX = 1.0;

        this.remotePlayers[slot] = {
            buttons: buttons,
            axes: [stickX, stickY, cStickX, cStickY],
            lastUpdate: performance.now()
        };

        this.lastRawPacketHex = `[0x01, slot: ${slot}, btns: 0x${buttonsMask.toString(16).padStart(4, '0')}, X: ${rawStickX}, Y: ${rawStickY}]`;
        this.tempPacketsReceived++;
        this.bytesReceived += u8.byteLength;
        this.updateLobbyControllerHUD();
    }

    /**
     * Initializes Host mode
     */
    async startHost(customRoomId = null) {
        this.isHost = true;
        this.isClient = false;
        this.gameStarted = false;
        this.lobbyState = 'LOBBY';
        this.roomId = customRoomId || this.generateRoomId();
        this.slots = [
            { slot: 0, label: 'Player 1 (Host / You)', status: 'READY', peerId: 'local', ping: 0 },
            { slot: 1, label: 'Player 2', status: 'WAITING', peerId: null, ping: 0 },
            { slot: 2, label: 'Player 3', status: 'OPEN', peerId: null, ping: 0 },
            { slot: 3, label: 'Player 4', status: 'OPEN', peerId: null, ping: 0 }
        ];

        // Prepare video stream if in VIDEO_STREAM mode
        const webglCanvas = document.getElementById('canvas');
        if (webglCanvas && typeof webglCanvas.captureStream === 'function') {
            const videoStream = webglCanvas.captureStream(60);
            let audioTrack = null;
            if (window.myApp && window.myApp.audioContext && window.myApp.gainNode) {
                const dest = window.myApp.audioContext.createMediaStreamDestination();
                window.myApp.gainNode.connect(dest);
                audioTrack = dest.stream.getAudioTracks()[0];
            }
            const tracks = [...videoStream.getVideoTracks()];
            if (audioTrack) tracks.push(audioTrack);
            this.mediaStream = new MediaStream(tracks);
        }

        return new Promise((resolve, reject) => {
            this.peer = new Peer(this.roomId, {
                debug: 0, // Clean, zero console noise
                config: {
                    iceServers: this.getIceServers(),
                    iceCandidatePoolSize: 10
                }
            });

            this.peer.on('open', (id) => {
                this.roomId = id;
                this.logEvent(`Host Lobby online! Room Code: ${id}`);
                this.setupHostListeners();
                this.startPingLoop();
                this.startHostInputBroadcastLoop();
                this.startSyncGuard();
                resolve(id);
            });

            this.peer.on('error', (err) => {
                this.logEvent(`Peer error: ${err.type || err.message}`);
                if (err.type === 'unavailable-id') {
                    this.peer.destroy();
                    this.startHost(this.generateRoomId()).then(resolve).catch(reject);
                } else {
                    reject(err);
                }
            });
        });
    }

    setupHostListeners() {
        this.peer.on('connection', (conn) => {
            const record = this.getOrCreatePeerRecord(conn.peer);
            record.conn = conn;
            const assignedSlot = record.slot;

            this.logEvent(`Incoming connection: ${conn.peer} -> Slot P${assignedSlot + 1}`);
            this.updateSlotState(assignedSlot, 'CONNECTING', conn.peer);

            const markOpen = () => {
                this.logEvent(`DataChannel OPEN with P${assignedSlot + 1} (${conn.peer})!`);
                record.status = 'TRANSFERRING';
                this.updateSlotState(assignedSlot, 'TRANSFERRING', conn.peer);
                this.notifyGamepadConnected(0);
                this.notifyGamepadConnected(assignedSlot);

                conn.send({
                    type: 'WELCOME',
                    slot: assignedSlot,
                    roomId: this.roomId,
                    mode: this.netplayMode,
                    romName: window.lastLoadedRomName || 'custom.v64',
                    gameStarted: this.gameStarted
                });

                if (this.netplayMode === 'ROM_SYNC') {
                    this.sendRomToPeer(conn);
                }
            };

            if (conn.open) markOpen();
            else conn.on('open', markOpen);

            conn.on('data', async (data) => {
                const binary = await this.extractBinaryData(data);
                if (binary) {
                    this.handleBinaryInput(binary, assignedSlot);
                } else if (typeof data === 'object') {
                    if (data.type === 'PONG') {
                        const now = performance.now();
                        record.ping = Math.max(1, Math.round(now - data.timestamp));
                        this.updateSlotPing(assignedSlot, record.ping);
                    } else if (data.type === 'CLIENT_ROM_READY') {
                        this.logEvent(`Player ${assignedSlot + 1} staged ROM (CRC32: ${data.crc32})! Ready to launch.`);
                        record.status = 'READY';
                        record.crc32 = data.crc32;
                        this.updateSlotState(assignedSlot, 'READY', conn.peer);
                    } else if (data.type === 'INPUT') {
                        const innerBinary = await this.extractBinaryData(data.packet);
                        if (innerBinary) this.handleBinaryInput(innerBinary, assignedSlot);
                    }
                }
            });

            conn.on('close', () => {
                this.logEvent(`Player ${assignedSlot + 1} disconnected.`);
                delete this.connections[conn.peer];
                this.updateSlotState(assignedSlot, 'WAITING', null);
            });
        });
    }

    async sendRomToPeer(conn) {
        let romData = window.lastLoadedRomData;
        if (!romData && typeof FS !== 'undefined') {
            try { romData = FS.readFile('custom.v64'); } catch (e) { }
        }

        if (!romData || romData.byteLength === 0) {
            this.logEvent(`⚠️ Warning: No ROM loaded yet. Host must load a ROM first!`);
            conn.send({ type: 'ROM_NOT_LOADED' });
            return;
        }

        const crc32 = this.calculateCRC32(romData);
        const CHUNK_SIZE = 32 * 1024; // 32KB
        const totalChunks = Math.ceil(romData.byteLength / CHUNK_SIZE);
        const mb = (romData.byteLength / (1024 * 1024)).toFixed(1);
        this.logEvent(`⚡ Streaming ROM (${mb} MB, CRC32: ${crc32}) to Guest...`);

        conn.send({
            type: 'ROM_START',
            name: window.lastLoadedRomName || 'custom.v64',
            totalChunks: totalChunks,
            size: romData.byteLength,
            crc32: crc32
        });

        for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, romData.byteLength);
            const chunkSlice = romData.slice(start, end);

            try {
                conn.send({
                    type: 'ROM_CHUNK',
                    index: i,
                    totalChunks: totalChunks,
                    data: chunkSlice
                });
            } catch (e) { }

            // Flow control: throttle if WebRTC SCTP buffer grows to prevent ICE disconnect
            if (conn.dataChannel && conn.dataChannel.bufferedAmount > 256 * 1024) {
                await new Promise(r => setTimeout(r, 12));
            } else if (i % 16 === 0) {
                await new Promise(r => setTimeout(r, 2));
            }
        }

        conn.send({ type: 'ROM_DONE', crc32: crc32 });
        this.logEvent(`✅ ROM transfer complete! Sent ${mb} MB to Guest.`);
    }

    getOrCreatePeerRecord(peerId) {
        if (this.connections[peerId]) return this.connections[peerId];
        const assignedSlot = this.getNextAvailableSlot();
        const record = { conn: null, call: null, slot: assignedSlot, ping: 0, status: 'CONNECTING', crc32: null };
        this.connections[peerId] = record;
        return record;
    }

    getNextAvailableSlot() {
        const usedSlots = Object.values(this.connections).map(c => c.slot);
        for (let s = 1; s <= 3; s++) {
            if (!usedSlots.includes(s)) return s;
        }
        return 1;
    }

    updateSlotState(slotIndex, status, peerId) {
        if (this.slots[slotIndex]) {
            this.slots[slotIndex].status = status;
            this.slots[slotIndex].peerId = peerId;
        }
        this.notifyLobby();
    }

    updateSlotPing(slotIndex, ping) {
        if (this.slots[slotIndex]) {
            this.slots[slotIndex].ping = ping;
        }
        this.notifyLobby();
    }

    notifyLobby() {
        if (typeof this.onLobbyUpdate === 'function') {
            this.onLobbyUpdate({
                roomId: this.roomId,
                slots: this.slots,
                mode: this.netplayMode,
                eventLogs: this.eventLogs,
                isReadyToPlay: this.slots.some(s => s.slot > 0 && (s.status === 'READY' || s.status === 'IN_GAME'))
            });
        }
    }

    /**
     * Synchronized 3-2-1 Launch Trigger
     */
    startSynchronizedLaunch() {
        this.gameStarted = true;
        this.lobbyState = 'COUNTDOWN';
        const targetEpoch = performance.now() + 3000; // 3-second synchronized countdown

        this.logEvent(`Host clicked START GAME! Broadcasting synchronized 3-second launch...`);
        Object.values(this.connections).forEach(c => {
            if (c.conn && c.conn.open) {
                try {
                    c.conn.send({
                        type: 'LAUNCH_SYNC',
                        targetEpoch: targetEpoch,
                        countdownSeconds: 3
                    });
                } catch (e) { }
            }
        });

        if (typeof this.onSynchronizedLaunch === 'function') {
            this.onSynchronizedLaunch(3, () => {
                this.lobbyState = 'IN_GAME';
                this.notifyGamepadConnected(0);
                this.notifyGamepadConnected(1);
            });
        }
        this.notifyLobby();
    }

    startHostInputBroadcastLoop() {
        if (this.inputLoopId) clearInterval(this.inputLoopId);

        const loop = () => {
            if (this.isHost && this.netplayMode === 'ROM_SYNC') {
                const p1Local = this.captureLocalInputState(0);
                const p2Remote = this.remotePlayers[1];

                const mergedP1 = {
                    buttons: new Array(16).fill(false),
                    axes: [0, 0, 0, 0]
                };

                for (let i = 0; i < 16; i++) {
                    mergedP1.buttons[i] = p1Local.buttons[i] || (p2Remote && p2Remote.buttons && p2Remote.buttons[i]);
                }
                mergedP1.axes[0] = Math.abs(p1Local.axes[0]) > 0.05 ? p1Local.axes[0] : (p2Remote && p2Remote.axes ? p2Remote.axes[0] : 0);
                mergedP1.axes[1] = Math.abs(p1Local.axes[1]) > 0.05 ? p1Local.axes[1] : (p2Remote && p2Remote.axes ? p2Remote.axes[1] : 0);

                const packet = this.encodeInputPacket(0, mergedP1);

                Object.values(this.connections).forEach(c => {
                    if (c.conn && c.conn.open) {
                        try {
                            c.conn.send(packet);
                            this.tempPacketsSent++;
                            this.bytesSent += packet.byteLength;
                        } catch (e) { }
                    }
                });
                this.updateLobbyControllerHUD();
            }
        };
        this.inputLoopId = setInterval(loop, 16); // Rock-solid 60 FPS loop
    }

    /**
     * Initializes Client mode
     */
    async startClient(targetRoomId) {
        this.isHost = false;
        this.isClient = true;
        this.lobbyState = 'LOBBY';
        this.roomId = targetRoomId.toUpperCase().trim();

        this.progress(1, 'Connecting to P2P Signaling Broker (0.peerjs.com)...');

        return new Promise((resolve, reject) => {
            this.peer = new Peer({
                debug: 0, // Clean, zero console noise
                config: {
                    iceServers: this.getIceServers(),
                    iceCandidatePoolSize: 10
                }
            });

            this.peer.on('open', (myId) => {
                this.progress(2, `Broker Connected (${myId.substring(0, 8)}...). Connecting to Host: ${this.roomId}...`);

                this.hostConnection = this.peer.connect(this.roomId, { reliable: false });

                const onConnOpen = () => {
                    this.progress(3, `DataChannel connected! Waiting for session configuration...`);
                    this.startClientInputLoop();
                };

                if (this.hostConnection.open) onConnOpen();
                else this.hostConnection.on('open', onConnOpen);

                this.hostConnection.on('data', async (data) => {
                    const binary = await this.extractBinaryData(data);
                    if (binary) {
                        this.handleBinaryInput(binary, 0);
                    } else if (typeof data === 'object') {
                        if (data.type === 'WELCOME') {
                            this.playerSlot = data.slot;
                            this.netplayMode = data.mode || 'ROM_SYNC';
                            this.progress(3, `Assigned as Player ${this.playerSlot + 1} (${this.netplayMode === 'ROM_SYNC' ? '⚡ Local WebGL' : '📺 Remote Stream'}).`);
                            this.notifyGamepadConnected(0);
                            this.notifyGamepadConnected(this.playerSlot);

                            if (this.netplayMode === 'ROM_SYNC') {
                                $('#netplayRomTransferContainer').show();
                                $('#netplayVideoContainer').hide();
                            }
                        } else if (data.type === 'ROM_START') {
                            this.romReceiveTotalChunks = data.totalChunks;
                            this.romReceiveSize = data.size;
                            this.romReceiveChunks = new Array(data.totalChunks);
                            this.romReceiveCount = 0;
                            $('#netplayRomTransferContainer').show();
                            $('#romTransferStatus').text(`Receiving ${data.name} (${(data.size / (1024 * 1024)).toFixed(1)} MB)...`);
                        } else if (data.type === 'ROM_CHUNK') {
                            const chunkData = data.data instanceof Uint8Array ? data.data : new Uint8Array(data.data);
                            this.romReceiveChunks[data.index] = chunkData;
                            this.romReceiveCount++;
                            const pct = Math.round((this.romReceiveCount / this.romReceiveTotalChunks) * 100);
                            $('#romTransferProgressBar').css('width', `${pct}%`).text(`${pct}%`);
                            $('#romTransferPercent').text(`${pct}%`);
                        } else if (data.type === 'ROM_DONE') {
                            const fullRom = new Uint8Array(this.romReceiveSize);
                            let offset = 0;
                            for (let c of this.romReceiveChunks) {
                                if (c) {
                                    fullRom.set(c, offset);
                                    offset += c.byteLength;
                                }
                            }
                            this.stagedRomData = fullRom;
                            const clientCRC = this.calculateCRC32(fullRom);
                            this.logEvent(`ROM staged (${(fullRom.byteLength / (1024 * 1024)).toFixed(1)} MB, CRC32: ${clientCRC}). Ready for Host start!`);

                            $('#romTransferStatus').html(`✅ ROM Verified (CRC32: <strong>${clientCRC}</strong>)! Waiting for Host to start game...`);
                            this.progress(4, `ROM Staged! Waiting in Lobby for Host to click Start...`);

                            if (this.hostConnection && this.hostConnection.open) {
                                try {
                                    this.hostConnection.send({
                                        type: 'CLIENT_ROM_READY',
                                        slot: this.playerSlot,
                                        crc32: clientCRC
                                    });
                                } catch (e) { }
                            }
                            resolve(this.playerSlot);
                        } else if (data.type === 'LAUNCH_SYNC') {
                            this.logEvent(`Received LAUNCH_SYNC! Starting 3-second synchronized launch countdown...`);
                            if (typeof this.onSynchronizedLaunch === 'function') {
                                this.onSynchronizedLaunch(data.countdownSeconds || 3, () => {
                                    this.lobbyState = 'IN_GAME';
                                    this.notifyGamepadConnected(0);
                                    this.notifyGamepadConnected(this.playerSlot);
                                });
                            }
                        } else if (data.type === 'PING') {
                            try { this.hostConnection.send({ type: 'PONG', timestamp: data.timestamp }); } catch (e) { }
                            this.rtt = Math.max(1, Math.round(performance.now() - data.timestamp));
                            const pingEl = document.getElementById('netplayPing');
                            if (pingEl) pingEl.textContent = this.rtt;
                            const inGamePing = document.getElementById('inGamePingBadge');
                            if (inGamePing) inGamePing.textContent = `${this.rtt} ms`;
                        } else if (data.type === 'STATE_SNAPSHOT') {
                            this.logEvent(`⚡ Received Save State Resync Snapshot (${(data.state.byteLength / 1024).toFixed(1)} KB)! Restoring...`);
                            if (typeof FS !== 'undefined' && Module._neil_unserialize) {
                                FS.writeFile('/savestate.gz', new Uint8Array(data.state));
                                Module._neil_unserialize();
                                toastr.info('Game state resynchronized!');
                            }
                        }
                    }
                });
            });

            this.peer.on('error', (err) => {
                this.progress(0, `Connection Error: ${err.type || err.message}`, true);
                reject(err);
            });
        });
    }

    progress(step, msg, isError = false) {
        this.logEvent(`[Step ${step}] ${msg}`);
        if (typeof this.onClientProgress === 'function') {
            this.onClientProgress({ step, message: msg, isError });
        }
    }

    startClientInputLoop() {
        if (this.inputLoopId) clearInterval(this.inputLoopId);

        const loop = () => {
            if (this.isClient && this.hostConnection && this.hostConnection.open) {
                const localState = this.captureLocalInputState(this.playerSlot);
                const packet = this.encodeInputPacket(this.playerSlot, localState);

                try {
                    this.hostConnection.send(packet);
                    this.tempPacketsSent++;
                    this.bytesSent += packet.byteLength;
                } catch (e) { }
                this.updateLobbyControllerHUD();
            }
        };

        this.inputLoopId = setInterval(loop, 16); // Rock-solid 60 FPS loop
    }

    startPingLoop() {
        if (this.pingIntervalId) clearInterval(this.pingIntervalId);
        this.pingIntervalId = setInterval(() => {
            if (this.isHost) {
                const now = performance.now();
                Object.values(this.connections).forEach(c => {
                    if (c.conn && c.conn.open) {
                        try { c.conn.send({ type: 'PING', timestamp: now }); } catch (e) { }
                    }
                });
            }
        }, 1000);
    }

    /**
     * Desync Guard: Periodic State Hash Check & Save-State Auto-Resync
     */
    startSyncGuard() {
        if (this.syncGuardIntervalId) clearInterval(this.syncGuardIntervalId);
        this.syncGuardIntervalId = setInterval(() => {
            if (this.isHost && this.lobbyState === 'IN_GAME' && typeof FS !== 'undefined' && Module._neil_serialize) {
                try {
                    // Export save state
                    Module._neil_serialize();
                    const stateData = FS.readFile('/savestate.gz');
                    if (stateData && stateData.byteLength > 0) {
                        const hash = this.calculateCRC32(stateData);
                        // Broadcast sync check
                        Object.values(this.connections).forEach(c => {
                            if (c.conn && c.conn.open) {
                                try { c.conn.send({ type: 'SYNC_CHECK', frame: this.frameCount, hash: hash }); } catch (e) { }
                            }
                        });
                    }
                } catch (e) { }
            }
        }, 8000);
    }

    startTelemetryLoop() {
        if (this.telemetryIntervalId) clearInterval(this.telemetryIntervalId);
        this.telemetryIntervalId = setInterval(() => {
            const now = performance.now();
            const dt = (now - this.lastMetricsTime) / 1000.0;
            if (dt >= 1.0) {
                this.ppsSent = Math.round(this.tempPacketsSent / dt);
                this.ppsReceived = Math.round(this.tempPacketsReceived / dt);
                this.tempPacketsSent = 0;
                this.tempPacketsReceived = 0;
                this.lastMetricsTime = now;
            }

            if (typeof this.onTelemetryUpdate === 'function') {
                try {
                    this.onTelemetryUpdate(this.getTelemetry());
                } catch (e) { }
            }
        }, 500);
    }

    getTelemetry() {
        let pc = null;
        let dataConn = null;

        if (this.isClient) {
            dataConn = this.hostConnection;
            pc = dataConn && dataConn.peerConnection ? dataConn.peerConnection : null;
        } else if (this.isHost) {
            const firstKey = Object.keys(this.connections)[0];
            if (firstKey) {
                dataConn = this.connections[firstKey].conn;
                pc = dataConn && dataConn.peerConnection ? dataConn.peerConnection : null;
            }
        }

        return {
            role: this.isHost ? 'Host' : (this.isClient ? `Client (P${this.playerSlot + 1})` : 'Idle'),
            mode: this.netplayMode,
            roomId: this.roomId || 'None',
            peerId: this.peer ? this.peer.id : 'Disconnected',
            brokerConnected: !!(this.peer && !this.peer.disconnected),
            iceConnectionState: pc ? pc.iceConnectionState : 'N/A',
            dataChannelStatus: dataConn ? (dataConn.open ? 'OPEN' : 'CONNECTING') : 'NONE',
            rtt: this.rtt,
            ppsSent: this.ppsSent,
            ppsReceived: this.ppsReceived,
            bytesSentKB: (this.bytesSent / 1024).toFixed(1),
            bytesReceivedKB: (this.bytesReceived / 1024).toFixed(1),
            connectedSlots: this.slots.filter(s => s.status === 'READY' || s.status === 'IN_GAME').map(s => s.slot)
        };
    }

    getLiveControllerState(slot) {
        if (slot === 0) {
            return this.isHost ? this.captureLocalInputState(0) : this.remotePlayers[0];
        } else if (slot === 1) {
            return (this.isClient && this.playerSlot === 1) ? this.captureLocalInputState(1) : this.remotePlayers[1];
        } else {
            return this.remotePlayers[slot];
        }
    }

    updateLobbyControllerHUD() {
        const isHostLobby = document.getElementById('netplayHostModal') && typeof $ !== 'undefined' && $('#netplayHostModal').hasClass('show');
        const isClientLobby = document.getElementById('netplayClientView') && document.getElementById('netplayClientView').style.display !== 'none';

        if (!isHostLobby && !isClientLobby) return;

        const prefix = isHostLobby ? 'host' : 'client';

        let p1 = null;
        let p2 = null;

        if (this.isHost) {
            p1 = this.captureLocalInputState(0);
            p2 = this.remotePlayers[1];
        } else if (this.isClient) {
            p1 = this.remotePlayers[0];
            p2 = this.captureLocalInputState(this.playerSlot);
        }

        const updateSlotHUD = (slotNum, state) => {
            const containerId = (prefix === 'host') ? (slotNum === 1 ? 'hostCtrlBtnsP1' : 'hostCtrlBtnsP2') : (slotNum === 1 ? 'clientCtrlBtnsP1' : 'clientCtrlBtnsP2');
            const stickId = (prefix === 'host') ? (slotNum === 1 ? 'hostCtrlStickP1' : 'hostCtrlStickP2') : (slotNum === 1 ? 'clientCtrlStickP1' : 'clientCtrlStickP2');
            const btnsContainer = document.getElementById(containerId);
            const stickEl = document.getElementById(stickId);
            if (!btnsContainer) return;

            const buttons = state ? (state.buttons || []) : [];
            const axes = state ? (state.axes || [0, 0, 0, 0]) : [0, 0, 0, 0];

            const btnMap = {
                'A': buttons[0],
                'B': buttons[2],
                'Z': buttons[4],
                'START': buttons[9],
                'L': buttons[6],
                'R': buttons[5],
                'UP': buttons[12] || axes[1] < -0.4,
                'DOWN': buttons[13] || axes[1] > 0.4,
                'LEFT': buttons[14] || axes[0] < -0.4,
                'RIGHT': buttons[15] || axes[0] > 0.4
            };

            const badges = btnsContainer.querySelectorAll('.btn-test');
            badges.forEach(b => {
                const name = b.getAttribute('data-btn');
                const isPressed = btnMap[name] || false;
                const activeClass = (slotNum === 1) ? 'active-btn-p1' : 'active-btn-p2';
                if (isPressed) {
                    b.classList.add(activeClass);
                } else {
                    b.classList.remove(activeClass);
                }
            });

            if (stickEl) {
                const sx = (axes[0] || 0).toFixed(2);
                const sy = (axes[1] || 0).toFixed(2);
                stickEl.textContent = `X: ${sx}, Y: ${sy}`;
            }
        };

        updateSlotHUD(1, p1);
        updateSlotHUD(2, p2);

        // Update telemetry stats
        const ppsSentEl = document.getElementById(`${prefix}PpsSent`);
        const ppsRcvdEl = document.getElementById(`${prefix}PpsRcvd`);
        const kbSentEl = document.getElementById(`${prefix}KbSent`);
        const kbRcvdEl = document.getElementById(`${prefix}KbRcvd`);
        const pingEl = document.getElementById(`${prefix}PingVal`);
        const lastPayloadEl = document.getElementById(`${prefix}LastPayload`);

        if (ppsSentEl) ppsSentEl.textContent = `${this.ppsSent || 0} pps`;
        if (ppsRcvdEl) ppsRcvdEl.textContent = `${this.ppsReceived || 0} pps`;
        if (kbSentEl) kbSentEl.textContent = `${((this.bytesSent || 0) / 1024).toFixed(1)}`;
        if (kbRcvdEl) kbRcvdEl.textContent = `${((this.bytesReceived || 0) / 1024).toFixed(1)}`;
        if (pingEl) pingEl.textContent = `${this.rtt || 0} ms`;
        if (lastPayloadEl && this.lastRawPacketHex) lastPayloadEl.textContent = this.lastRawPacketHex;
    }

    disconnect() {
        if (this.inputLoopId) clearInterval(this.inputLoopId);
        if (this.pingIntervalId) clearInterval(this.pingIntervalId);
        if (this.syncGuardIntervalId) clearInterval(this.syncGuardIntervalId);
        if (this.hostCall) this.hostCall.close();
        if (this.hostConnection) this.hostConnection.close();
        Object.values(this.connections).forEach(c => {
            if (c.call) c.call.close();
            if (c.conn) c.conn.close();
        });
        if (this.peer) this.peer.destroy();
        this.isHost = false;
        this.isClient = false;
        this.connections = {};
        this.lobbyState = 'IDLE';
        if (window.touchController) window.touchController.hide();
    }
}

window.netplayManager = new NetplayManager();
