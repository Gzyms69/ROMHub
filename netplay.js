/**
 * ROMHub Netplay - Dual-Mode WebRTC Multiplayer Engine
 * 
 * Supported Modes:
 * 1. Mode A: ⚡ Local WebGL (ROM & Input Sync) [Default / Recommended]
 *    - Host streams ROM chunks (32KB) over WebRTC DataChannel to Guest in 1-2s.
 *    - Guest executes local WebAssembly N64 emulator (LoadEmulator).
 *    - Both instances exchange 5-byte controller input packets at 60 FPS.
 *    - 0ms video lag, crystal-clear native WebGL, zero video codec issues.
 * 
 * 2. Mode B: 📺 Remote Video Stream (Cloud Co-Op)
 *    - Host captures active WebGL canvas (canvas.captureStream(60)).
 *    - Guest receives WebRTC MediaStream video/audio and sends inputs.
 */

class NetplayManager {
    constructor() {
        this.peer = null;
        this.roomId = null;
        this.isHost = false;
        this.isClient = false;
        this.playerSlot = 1; // 1 = P2, 2 = P3, 3 = P4
        this.netplayMode = 'ROM_SYNC'; // 'ROM_SYNC' or 'VIDEO_STREAM'
        this.connections = {}; // peerId -> { conn, call, slot, ping, status }
        this.hostConnection = null;
        this.hostCall = null;
        this.mediaStream = null;
        this.remoteStream = null;
        this.gameStarted = false;

        // ROM Transfer State (Client)
        this.romReceiveTotalChunks = 0;
        this.romReceiveSize = 0;
        this.romReceiveChunks = [];
        this.romReceiveCount = 0;
        this.romLoadedLocally = false;

        // Player Slots State
        this.slots = [
            { slot: 0, label: 'Player 1 (Host)', status: 'READY', peerId: 'local', ping: 0 },
            { slot: 1, label: 'Player 2', status: 'WAITING', peerId: null, ping: 0 },
            { slot: 2, label: 'Player 3', status: 'OPEN', peerId: null, ping: 0 },
            { slot: 3, label: 'Player 4', status: 'OPEN', peerId: null, ping: 0 }
        ];

        this.eventLogs = [];
        this.remotePlayers = {
            0: { buttons: new Array(16).fill(false), axes: [0, 0], lastUpdate: 0 },
            1: { buttons: new Array(16).fill(false), axes: [0, 0], lastUpdate: 0 },
            2: { buttons: new Array(16).fill(false), axes: [0, 0], lastUpdate: 0 },
            3: { buttons: new Array(16).fill(false), axes: [0, 0], lastUpdate: 0 }
        };

        this.inputLoopId = null;
        this.pingIntervalId = null;
        this.telemetryIntervalId = null;
        this.rtt = 0;
        this.onLobbyUpdate = null;
        this.onClientProgress = null;
        this.onTelemetryUpdate = null;
        this.onRomTransferProgress = null;
        this.onRomReadyToLaunch = null;

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
        if (this.eventLogs.length > 80) this.eventLogs.shift();
        console.log(`[Netplay] ${msg}`);
        this.notifyLobby();
    }

    /**
     * Virtual Gamepad Proxy Injection into navigator.getGamepads
     */
    setupGamepadProxy() {
        const origGetGamepads = navigator.getGamepads ? navigator.getGamepads.bind(navigator) : null;
        if (!origGetGamepads) return;

        const self = this;
        navigator.getGamepads = function () {
            const raw = origGetGamepads() || [];
            const result = [];

            if (self.isHost) {
                // Slot 0: Local Player 1
                result[0] = raw[0] || null;

                // Slots 1..3: Remote Players from DataChannel
                for (let slot = 1; slot <= 3; slot++) {
                    if (self.hasConnectedPlayer(slot)) {
                        const rp = self.remotePlayers[slot];
                        result[slot] = {
                            id: `ROMHub Netplay Remote (Player ${slot + 1})`,
                            index: slot,
                            connected: true,
                            timestamp: performance.now(),
                            mapping: 'standard',
                            axes: [rp.axes[0], rp.axes[1], 0, 0],
                            buttons: rp.buttons.map(pressed => ({
                                pressed: !!pressed,
                                touched: !!pressed,
                                value: pressed ? 1.0 : 0.0
                            }))
                        };
                    } else {
                        result[slot] = raw[slot] || null;
                    }
                }
            } else if (self.isClient && self.netplayMode === 'ROM_SYNC') {
                // Client in ROM_SYNC mode:
                // Slot 0: Remote Host (Player 1)
                const p1 = self.remotePlayers[0];
                result[0] = {
                    id: 'ROMHub Netplay Host (Player 1)',
                    index: 0,
                    connected: true,
                    timestamp: performance.now(),
                    mapping: 'standard',
                    axes: [p1.axes[0], p1.axes[1], 0, 0],
                    buttons: p1.buttons.map(pressed => ({
                        pressed: !!pressed,
                        touched: !!pressed,
                        value: pressed ? 1.0 : 0.0
                    }))
                };

                // Slot 1..3: Local player assigned slot
                for (let s = 1; s <= 3; s++) {
                    if (s === self.playerSlot) {
                        result[s] = raw[0] || raw[1] || null;
                    } else {
                        const rp = self.remotePlayers[s];
                        result[s] = {
                            id: `ROMHub Netplay Player ${s + 1}`,
                            index: s,
                            connected: true,
                            timestamp: performance.now(),
                            mapping: 'standard',
                            axes: [rp.axes[0], rp.axes[1], 0, 0],
                            buttons: rp.buttons.map(pressed => ({
                                pressed: !!pressed,
                                touched: !!pressed,
                                value: pressed ? 1.0 : 0.0
                            }))
                        };
                    }
                }
            } else {
                return raw;
            }

            return result;
        };
    }

    hasConnectedPlayer(slot) {
        return Object.values(this.connections).some(c => c.slot === slot && (c.status === 'READY' || c.status === 'CONNECTED'));
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
     * Initializes Host mode
     */
    async startHost(customRoomId = null) {
        this.isHost = true;
        this.isClient = false;
        this.gameStarted = false;
        this.roomId = customRoomId || this.generateRoomId();
        this.slots = [
            { slot: 0, label: 'Player 1 (Host / You)', status: 'READY', peerId: 'local', ping: 0 },
            { slot: 1, label: 'Player 2', status: 'WAITING', peerId: null, ping: 0 },
            { slot: 2, label: 'Player 3', status: 'OPEN', peerId: null, ping: 0 },
            { slot: 3, label: 'Player 4', status: 'OPEN', peerId: null, ping: 0 }
        ];

        // Prepare video stream from active DOM canvas if in VIDEO_STREAM mode
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
            this.logEvent(`Host MediaStream ready from active canvas: ${tracks.length} tracks.`);
        }

        return new Promise((resolve, reject) => {
            this.peer = new Peer(this.roomId, {
                debug: 3,
                config: {
                    iceServers: this.getIceServers(),
                    iceCandidatePoolSize: 10
                }
            });

            this.peer.on('open', (id) => {
                this.roomId = id;
                this.logEvent(`Host Lobby listening on Room ID: ${id}`);
                this.setupHostListeners();
                this.startPingLoop();
                this.startHostInputBroadcastLoop();
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
        // 1. Incoming Media Call
        this.peer.on('call', (incomingCall) => {
            this.logEvent(`Incoming Media Call from: ${incomingCall.peer}!`);
            if (this.mediaStream) {
                incomingCall.answer(this.mediaStream);
            }

            const record = this.getOrCreatePeerRecord(incomingCall.peer);
            record.call = incomingCall;

            incomingCall.on('close', () => {
                this.logEvent(`Media call closed with ${incomingCall.peer}`);
            });
            incomingCall.on('error', (err) => {
                this.logEvent(`Media call error with ${incomingCall.peer}: ${err.message}`);
            });
        });

        // 2. Incoming Data Connection
        this.peer.on('connection', (conn) => {
            const record = this.getOrCreatePeerRecord(conn.peer);
            record.conn = conn;
            const assignedSlot = record.slot;

            this.logEvent(`Incoming connection from: ${conn.peer} -> Slot P${assignedSlot + 1}`);
            this.updateSlotState(assignedSlot, 'CONNECTING', conn.peer);

            const markOpen = () => {
                this.logEvent(`DataChannel ACTIVE with P${assignedSlot + 1} (${conn.peer})!`);
                record.status = 'READY';
                this.updateSlotState(assignedSlot, 'READY', conn.peer);

                // Send Welcome with chosen mode
                try {
                    conn.send({
                        type: 'WELCOME',
                        slot: assignedSlot,
                        roomId: this.roomId,
                        mode: this.netplayMode,
                        romName: window.lastLoadedRomName || 'custom.v64',
                        gameStarted: this.gameStarted
                    });
                } catch (e) { }

                // In ROM_SYNC mode, stream ROM to connecting guest
                if (this.netplayMode === 'ROM_SYNC') {
                    this.sendRomToPeer(conn);
                }
            };

            if (conn.open) {
                markOpen();
            } else {
                conn.on('open', markOpen);
            }

            conn.on('data', (data) => {
                if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
                    this.handleBinaryInput(data, assignedSlot);
                } else if (typeof data === 'object') {
                    if (data.type === 'PONG') {
                        const now = performance.now();
                        record.ping = Math.round(now - data.timestamp);
                        this.updateSlotPing(assignedSlot, record.ping);
                    } else if (data.type === 'STREAM_CONFIRMED') {
                        this.logEvent(`Player ${assignedSlot + 1} confirmed stream playback! (🟢 READY)`);
                        record.status = 'READY';
                        this.updateSlotState(assignedSlot, 'READY', conn.peer);
                    } else if (data.type === 'CLIENT_ROM_LOADED') {
                        this.logEvent(`Player ${assignedSlot + 1} successfully loaded ROM locally! (🟢 60 FPS Native WebGL)`);
                        record.status = 'READY';
                        this.updateSlotState(assignedSlot, 'READY', conn.peer);
                    } else if (data.type === 'INPUT') {
                        this.handleBinaryInput(data.packet, assignedSlot);
                    }
                }
            });

            conn.on('close', () => {
                this.logEvent(`Player ${assignedSlot + 1} disconnected.`);
                delete this.connections[conn.peer];
                this.updateSlotState(assignedSlot, 'WAITING', null);
            });

            conn.on('error', (err) => {
                this.logEvent(`DataChannel error with ${conn.peer}: ${err}`);
            });
        });
    }

    /**
     * Streams loaded ROM file over DataChannel in 32KB chunks
     */
    async sendRomToPeer(conn) {
        let romData = window.lastLoadedRomData;
        if (!romData && typeof FS !== 'undefined') {
            try {
                romData = FS.readFile('custom.v64');
            } catch (e) { }
        }

        if (!romData || romData.byteLength === 0) {
            this.logEvent(`⚠️ Warning: No ROM loaded yet. Upload a ROM on Host first!`);
            conn.send({ type: 'ROM_NOT_LOADED' });
            return;
        }

        const CHUNK_SIZE = 32 * 1024; // 32KB
        const totalChunks = Math.ceil(romData.byteLength / CHUNK_SIZE);
        const mb = (romData.byteLength / (1024 * 1024)).toFixed(1);
        this.logEvent(`⚡ Streaming ROM (${mb} MB, ${totalChunks} chunks) to Guest...`);

        conn.send({
            type: 'ROM_START',
            name: window.lastLoadedRomName || 'custom.v64',
            totalChunks: totalChunks,
            size: romData.byteLength
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
            } catch (e) {
                console.error('Error sending ROM chunk:', e);
            }

            // Pacing delay every 8 chunks to prevent buffer overflow
            if (i % 8 === 0) {
                await new Promise(r => setTimeout(r, 10));
            }
        }

        conn.send({ type: 'ROM_DONE' });
        this.logEvent(`✅ ROM transfer complete! Sent ${mb} MB to Guest.`);
    }

    getOrCreatePeerRecord(peerId) {
        if (this.connections[peerId]) {
            return this.connections[peerId];
        }

        const assignedSlot = this.getNextAvailableSlot();
        const record = {
            conn: null,
            call: null,
            slot: assignedSlot,
            ping: 0,
            status: 'CONNECTING'
        };
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
                isReadyToPlay: this.slots.some(s => s.slot > 0 && (s.status === 'READY' || s.status === 'CONNECTING'))
            });
        }
    }

    startGame() {
        this.gameStarted = true;
        this.logEvent(`Host clicked START GAME! Broadcasting to all players...`);
        Object.values(this.connections).forEach(c => {
            if (c.conn && c.conn.open) {
                try { c.conn.send({ type: 'START_GAME' }); } catch (e) { }
            }
        });
        this.notifyLobby();
    }

    handleBinaryInput(data, defaultSlot) {
        const u8 = new Uint8Array(data);
        if (u8.length < 5) return;

        const slot = u8[0] !== undefined ? u8[0] : defaultSlot;
        const buttonsHigh = u8[1];
        const buttonsLow = u8[2];
        const buttonsMask = (buttonsHigh << 8) | buttonsLow;
        const stickX = (u8[3] - 128) / 128.0;
        const stickY = (u8[4] - 128) / 128.0;

        const buttons = [];
        for (let i = 0; i < 16; i++) {
            buttons[i] = ((buttonsMask >> i) & 1) === 1;
        }

        this.remotePlayers[slot] = {
            buttons,
            axes: [stickX, stickY],
            lastUpdate: performance.now()
        };
    }

    /**
     * Host broadcasts Player 1 inputs to clients for ROM_SYNC mode
     */
    startHostInputBroadcastLoop() {
        const packet = new Uint8Array(5);
        const loop = () => {
            if (this.isHost && this.netplayMode === 'ROM_SYNC') {
                let buttonsMask = 0;
                let stickX = 0;
                let stickY = 0;

                const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
                const gp = gamepads[0] || null;
                if (gp) {
                    for (let i = 0; i < Math.min(16, gp.buttons.length); i++) {
                        if (gp.buttons[i] && gp.buttons[i].pressed) buttonsMask |= (1 << i);
                    }
                    if (gp.axes.length >= 2) {
                        stickX = Math.max(-1, Math.min(1, gp.axes[0]));
                        stickY = Math.max(-1, Math.min(1, gp.axes[1]));
                    }
                } else if (window.myApp && window.myApp.rivetsData && window.myApp.rivetsData.inputController) {
                    const ic = window.myApp.rivetsData.inputController;
                    if (ic.Key_Action_A) buttonsMask |= (1 << 0);
                    if (ic.Key_Action_B) buttonsMask |= (1 << 1);
                    if (ic.Key_Action_Z) buttonsMask |= (1 << 2);
                    if (ic.Key_Action_Start) buttonsMask |= (1 << 3);
                    if (ic.Key_Up) buttonsMask |= (1 << 4);
                    if (ic.Key_Down) buttonsMask |= (1 << 5);
                    if (ic.Key_Left) buttonsMask |= (1 << 6);
                    if (ic.Key_Right) buttonsMask |= (1 << 7);
                    if (ic.Key_Action_L) buttonsMask |= (1 << 8);
                    if (ic.Key_Action_R) buttonsMask |= (1 << 9);
                    if (ic.Key_Action_CUP) buttonsMask |= (1 << 10);
                    if (ic.Key_Action_CDOWN) buttonsMask |= (1 << 11);
                    if (ic.Key_Action_CLEFT) buttonsMask |= (1 << 12);
                    if (ic.Key_Action_CRIGHT) buttonsMask |= (1 << 13);
                    if (!stickX && !stickY) {
                        stickX = ic.VectorX || 0;
                        stickY = ic.VectorY || 0;
                    }
                }

                packet[0] = 0; // Slot 0 = Player 1
                packet[1] = (buttonsMask >> 8) & 0xFF;
                packet[2] = buttonsMask & 0xFF;
                packet[3] = Math.round(stickX * 127 + 128) & 0xFF;
                packet[4] = Math.round(stickY * 127 + 128) & 0xFF;

                Object.values(this.connections).forEach(c => {
                    if (c.conn && c.conn.open) {
                        try { c.conn.send(packet); } catch (e) { }
                    }
                });
            }
            this.inputLoopId = requestAnimationFrame(loop);
        };
        this.inputLoopId = requestAnimationFrame(loop);
    }

    /**
     * Initializes Client mode
     */
    async startClient(targetRoomId) {
        this.isHost = false;
        this.isClient = true;
        this.roomId = targetRoomId.toUpperCase().trim();

        this.progress(1, 'Connecting to P2P Signaling Broker (0.peerjs.com)...');

        return new Promise((resolve, reject) => {
            this.peer = new Peer({
                debug: 3,
                config: {
                    iceServers: this.getIceServers(),
                    iceCandidatePoolSize: 10
                }
            });

            this.peer.on('open', (myId) => {
                this.progress(2, `Broker Connected (${myId.substring(0, 8)}...). Connecting to Host: ${this.roomId}...`);

                // 1. Establish Fast DataChannel First (Single RTCPeerConnection for minimal 5G latency)
                this.hostConnection = this.peer.connect(this.roomId);

                const onConnOpen = () => {
                    this.progress(3, `DataChannel connected! Waiting for session configuration...`);
                    this.startClientInputLoop();
                };

                if (this.hostConnection.open) {
                    onConnOpen();
                } else {
                    this.hostConnection.on('open', onConnOpen);
                }

                this.hostConnection.on('data', (data) => {
                    if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
                        // Binary input from Host (Player 1) in ROM_SYNC mode
                        this.handleBinaryInput(data, 0);
                    } else if (typeof data === 'object') {
                        if (data.type === 'WELCOME') {
                            this.playerSlot = data.slot;
                            this.netplayMode = data.mode || 'ROM_SYNC';
                            this.progress(3, `Assigned as Player ${this.playerSlot + 1} (${this.netplayMode === 'ROM_SYNC' ? '⚡ Local WebGL Mode' : '📺 Remote Video Stream'}).`);
                            
                            const label = document.getElementById('netplayPlayerLabel');
                            if (label) label.textContent = `Player ${this.playerSlot + 1}`;

                            if (this.netplayMode === 'ROM_SYNC') {
                                $('#netplayRomTransferContainer').show();
                                $('#netplayVideoContainer').hide();
                            } else {
                                $('#netplayRomTransferContainer').hide();
                                $('#netplayVideoContainer').show();
                                // Initiate media call only for VIDEO_STREAM mode
                                this.initiateMediaCall(resolve);
                            }
                        } else if (data.type === 'ROM_START') {
                            this.romReceiveTotalChunks = data.totalChunks;
                            this.romReceiveSize = data.size;
                            this.romReceiveChunks = new Array(data.totalChunks);
                            this.romReceiveCount = 0;
                            $('#netplayRomTransferContainer').show();
                            $('#romTransferStatus').text(`Receiving ${data.name} (${(data.size / (1024*1024)).toFixed(1)} MB)...`);
                        } else if (data.type === 'ROM_CHUNK') {
                            const chunkData = data.data instanceof Uint8Array ? data.data : new Uint8Array(data.data);
                            this.romReceiveChunks[data.index] = chunkData;
                            this.romReceiveCount++;
                            const pct = Math.round((this.romReceiveCount / this.romReceiveTotalChunks) * 100);
                            $('#romTransferProgressBar').css('width', `${pct}%`).text(`${pct}%`);
                            $('#romTransferPercent').text(`${pct}%`);
                        } else if (data.type === 'ROM_DONE') {
                            $('#romTransferStatus').text(`✅ ROM received! Reassembling and launching WebAssembly engine...`);
                            const fullRom = new Uint8Array(this.romReceiveSize);
                            let offset = 0;
                            for (let c of this.romReceiveChunks) {
                                if (c) {
                                    fullRom.set(c, offset);
                                    offset += c.byteLength;
                                }
                            }

                            this.logEvent(`Reassembled complete ROM (${(fullRom.byteLength / (1024*1024)).toFixed(1)} MB). Launching emulator...`);
                            this.progress(4, `ROM Ready! Running Local WebGL 60 FPS Emulator!`);
                            
                            if (typeof this.onRomReadyToLaunch === 'function') {
                                this.onRomReadyToLaunch(fullRom);
                            }
                            if (this.hostConnection && this.hostConnection.open) {
                                try { this.hostConnection.send({ type: 'CLIENT_ROM_LOADED', slot: this.playerSlot }); } catch (e) { }
                            }
                            resolve(this.playerSlot);
                        } else if (data.type === 'PING') {
                            try { this.hostConnection.send({ type: 'PONG', timestamp: data.timestamp }); } catch (e) { }
                            this.rtt = Math.round(performance.now() - data.timestamp);
                            const pingEl = document.getElementById('netplayPing');
                            if (pingEl) pingEl.textContent = this.rtt;
                        } else if (data.type === 'START_GAME') {
                            this.progress(4, `Game started by Host! Have fun!`);
                        }
                    }
                });

                this.hostConnection.on('error', (err) => {
                    this.logEvent(`DataChannel Error: ${err.message || err}`);
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

    initiateMediaCall(onSuccess) {
        try {
            const dummyCanvas = document.createElement('canvas');
            dummyCanvas.width = 16;
            dummyCanvas.height = 16;
            const dummyCtx = dummyCanvas.getContext('2d');
            dummyCtx.fillStyle = '#000000';
            dummyCtx.fillRect(0, 0, 16, 16);
            const dummyVideoStream = dummyCanvas.captureStream(10);
            const dummyVideoTrack = dummyVideoStream.getVideoTracks()[0];

            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const dummyDest = audioCtx.createMediaStreamDestination();
            const dummyAudioTrack = dummyDest.stream.getAudioTracks()[0];

            const clientOfferStream = new MediaStream([dummyVideoTrack, dummyAudioTrack]);

            this.logEvent(`Calling host ${this.roomId} for VideoStream...`);
            const call = this.peer.call(this.roomId, clientOfferStream);
            this.hostCall = call;

            call.on('stream', (remoteStream) => {
                const vTracks = remoteStream.getVideoTracks().length;
                const aTracks = remoteStream.getAudioTracks().length;
                this.progress(3, `Received remote MediaStream (${vTracks} video, ${aTracks} audio)!`);
                this.remoteStream = remoteStream;
                this.attachRemoteStream(remoteStream, () => {
                    this.progress(4, `WebRTC Video Stream PLAYING (60 FPS)!`);
                    if (this.hostConnection && this.hostConnection.open) {
                        try { this.hostConnection.send({ type: 'STREAM_CONFIRMED' }); } catch (e) { }
                    }
                    if (typeof onSuccess === 'function') onSuccess(this.playerSlot);
                });
            });

            call.on('error', (err) => {
                this.logEvent(`Media Call Error: ${err.message || err}`);
            });
        } catch (e) {
            this.logEvent(`Media Call Exception: ${e.message}`);
        }
    }

    attachRemoteStream(stream, onPlaySuccess) {
        const videoEl = document.getElementById('netplayVideo');
        if (!videoEl) return;

        const vCount = stream.getVideoTracks().length;
        const aCount = stream.getAudioTracks().length;
        this.logEvent(`Attaching MediaStream (${vCount} video, ${aCount} audio)...`);

        videoEl.srcObject = stream;
        videoEl.muted = true;
        videoEl.playsInline = true;
        videoEl.setAttribute('playsinline', 'true');
        videoEl.setAttribute('webkit-playsinline', 'true');
        videoEl.setAttribute('autoplay', 'true');

        let confirmed = false;
        const confirmPlay = () => {
            if (!confirmed) {
                confirmed = true;
                this.logEvent(`Video playback active! (${videoEl.videoWidth}x${videoEl.videoHeight})`);
                const audioBanner = document.getElementById('netplayAudioBanner');
                if (audioBanner && stream.getAudioTracks().length > 0) {
                    audioBanner.style.display = 'block';
                }
                if (typeof onPlaySuccess === 'function') onPlaySuccess();
            }
        };

        videoEl.onloadedmetadata = () => {
            this.logEvent(`Video metadata loaded: ${videoEl.videoWidth}x${videoEl.videoHeight}`);
            videoEl.play().catch(e => this.logEvent(`Play on loadedmetadata: ${e.message}`));
        };

        videoEl.oncanplay = () => {
            videoEl.play().catch(e => { });
        };

        videoEl.onplaying = () => {
            confirmPlay();
        };

        videoEl.onerror = (e) => {
            this.logEvent(`Video element error: ${videoEl.error ? videoEl.error.message : e}`);
        };

        const playPromise = videoEl.play();
        if (playPromise !== undefined) {
            playPromise.then(() => {
                this.logEvent('Direct video.play() resolved.');
                confirmPlay();
            }).catch((err) => {
                this.logEvent(`Autoplay prompt required: ${err.message}`);
                const audioBanner = document.getElementById('netplayAudioBanner');
                if (audioBanner) {
                    audioBanner.innerHTML = '▶️ Tap here to start video & audio stream';
                    audioBanner.style.display = 'block';
                }
            });
        }

        // Show Touch Controller on mobile
        if (window.touchController) {
            window.touchController.init('netplayTouchContainer');
            window.touchController.show();
        }
    }

    unmuteAudio() {
        const videoEl = document.getElementById('netplayVideo');
        if (videoEl) {
            videoEl.muted = false;
            videoEl.play().then(() => {
                this.logEvent('Audio unmuted.');
                const audioBanner = document.getElementById('netplayAudioBanner');
                if (audioBanner) audioBanner.style.display = 'none';
            }).catch(e => this.logEvent(`Unmute error: ${e.message}`));
        }
    }

    startClientInputLoop() {
        const packet = new Uint8Array(5);

        const loop = () => {
            if (!this.isClient || !this.hostConnection || !this.hostConnection.open) {
                requestAnimationFrame(loop);
                return;
            }

            let buttonsMask = 0;
            let stickX = 0;
            let stickY = 0;

            // 1. Touch Controller
            if (window.touchController && window.touchController.enabled) {
                const ts = window.touchController.state;
                if (ts.A) buttonsMask |= (1 << 0);
                if (ts.B) buttonsMask |= (1 << 1);
                if (ts.Z) buttonsMask |= (1 << 2);
                if (ts.Start) buttonsMask |= (1 << 3);
                if (ts.DPAD_UP) buttonsMask |= (1 << 4);
                if (ts.DPAD_DOWN) buttonsMask |= (1 << 5);
                if (ts.DPAD_LEFT) buttonsMask |= (1 << 6);
                if (ts.DPAD_RIGHT) buttonsMask |= (1 << 7);
                if (ts.L) buttonsMask |= (1 << 8);
                if (ts.R) buttonsMask |= (1 << 9);
                if (ts.CUP) buttonsMask |= (1 << 10);
                if (ts.CDOWN) buttonsMask |= (1 << 11);
                if (ts.CLEFT) buttonsMask |= (1 << 12);
                if (ts.CRIGHT) buttonsMask |= (1 << 13);
                stickX = ts.stickX;
                stickY = ts.stickY;
            }

            // 2. Gamepad API
            const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
            const gp = gamepads[0] || gamepads[1] || null;
            if (gp) {
                for (let i = 0; i < Math.min(16, gp.buttons.length); i++) {
                    if (gp.buttons[i] && gp.buttons[i].pressed) {
                        buttonsMask |= (1 << i);
                    }
                }
                if (gp.axes.length >= 2) {
                    stickX = Math.max(-1, Math.min(1, gp.axes[0]));
                    stickY = Math.max(-1, Math.min(1, gp.axes[1]));
                }
            } else if (window.myApp && window.myApp.rivetsData && window.myApp.rivetsData.inputController) {
                // 3. Keyboard
                const ic = window.myApp.rivetsData.inputController;
                if (ic.Key_Action_A) buttonsMask |= (1 << 0);
                if (ic.Key_Action_B) buttonsMask |= (1 << 1);
                if (ic.Key_Action_Z) buttonsMask |= (1 << 2);
                if (ic.Key_Action_Start) buttonsMask |= (1 << 3);
                if (ic.Key_Up) buttonsMask |= (1 << 4);
                if (ic.Key_Down) buttonsMask |= (1 << 5);
                if (ic.Key_Left) buttonsMask |= (1 << 6);
                if (ic.Key_Right) buttonsMask |= (1 << 7);
                if (ic.Key_Action_L) buttonsMask |= (1 << 8);
                if (ic.Key_Action_R) buttonsMask |= (1 << 9);
                if (ic.Key_Action_CUP) buttonsMask |= (1 << 10);
                if (ic.Key_Action_CDOWN) buttonsMask |= (1 << 11);
                if (ic.Key_Action_CLEFT) buttonsMask |= (1 << 12);
                if (ic.Key_Action_CRIGHT) buttonsMask |= (1 << 13);
                if (!stickX && !stickY) {
                    stickX = ic.VectorX || 0;
                    stickY = ic.VectorY || 0;
                }
            }

            packet[0] = this.playerSlot;
            packet[1] = (buttonsMask >> 8) & 0xFF;
            packet[2] = buttonsMask & 0xFF;
            packet[3] = Math.round(stickX * 127 + 128) & 0xFF;
            packet[4] = Math.round(stickY * 127 + 128) & 0xFF;

            try {
                this.hostConnection.send(packet);
            } catch (e) { }

            requestAnimationFrame(loop);
        };

        requestAnimationFrame(loop);
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

    startTelemetryLoop() {
        if (this.telemetryIntervalId) clearInterval(this.telemetryIntervalId);
        this.telemetryIntervalId = setInterval(() => {
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
        let mediaConn = null;

        if (this.isClient) {
            dataConn = this.hostConnection;
            mediaConn = this.hostCall;
            pc = (mediaConn && mediaConn.peerConnection) || (dataConn && dataConn.peerConnection) || null;
        } else if (this.isHost) {
            const firstKey = Object.keys(this.connections)[0];
            if (firstKey) {
                dataConn = this.connections[firstKey].conn;
                mediaConn = this.connections[firstKey].call;
                pc = (mediaConn && mediaConn.peerConnection) || (dataConn && dataConn.peerConnection) || null;
            }
        }

        const videoEl = document.getElementById('netplayVideo');

        return {
            role: this.isHost ? 'Host' : (this.isClient ? 'Client' : 'Idle'),
            mode: this.netplayMode,
            roomId: this.roomId || 'None',
            peerId: this.peer ? this.peer.id : 'Disconnected',
            brokerConnected: !!(this.peer && !this.peer.disconnected),
            iceConnectionState: pc ? pc.iceConnectionState : 'N/A',
            iceGatheringState: pc ? pc.iceGatheringState : 'N/A',
            signalingState: pc ? pc.signalingState : 'N/A',
            dataChannelStatus: dataConn ? (dataConn.open ? 'OPEN' : 'CONNECTING') : 'NONE',
            mediaCallStatus: mediaConn ? (mediaConn.open ? 'ACTIVE' : 'NEGOTIATING') : 'NONE',
            rtt: this.rtt,
            videoElement: videoEl ? {
                readyState: videoEl.readyState,
                videoWidth: videoEl.videoWidth,
                videoHeight: videoEl.videoHeight,
                paused: videoEl.paused,
                muted: videoEl.muted
            } : null
        };
    }

    disconnect() {
        if (this.inputLoopId) cancelAnimationFrame(this.inputLoopId);
        if (this.pingIntervalId) clearInterval(this.pingIntervalId);
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
        if (window.touchController) window.touchController.hide();
    }
}

window.netplayManager = new NetplayManager();
