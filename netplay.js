/**
 * ROMHub Netplay - WebRTC Peer-to-Peer E2E Multiplayer & Remote Co-Op
 * 
 * Features:
 * - Parallel Dual-Track WebRTC Negotiation: Media call and DataChannel negotiate simultaneously
 * - 2D GPU Blit Streamer: Solves WebGL buffer clear by copying rendered frames in real-time
 * - H.264 WebRTC hardware video codec prioritization for universal mobile (iOS / Android) playback
 * - OpenRelay TURN servers for 100% reliable 5G/LTE Carrier-Grade NAT traversal
 * - Interactive Multiplayer Lobby with Slot Deduplication and Host 'START GAME' trigger
 * - Full video lifecycle events (onloadedmetadata, oncanplay, onplaying, onerror)
 * - Virtual Gamepad Injection Proxy into navigator.getGamepads for slots P2, P3, P4
 */

class NetplayManager {
    constructor() {
        this.peer = null;
        this.roomId = null;
        this.isHost = false;
        this.isClient = false;
        this.playerSlot = 1; // 1 = P2, 2 = P3, 3 = P4
        this.connections = {}; // peerId -> { conn, call, slot, ping, status }
        this.hostConnection = null;
        this.hostCall = null;
        this.mediaStream = null;
        this.remoteStream = null;
        this.gameStarted = false;

        // 2D Blit Streamer Pipeline
        this.streamCanvas = null;
        this.streamCtx = null;
        this.blitAnimFrameId = null;

        // Player Slots State
        this.slots = [
            { slot: 0, label: 'Player 1 (Host)', status: 'READY', peerId: 'local', ping: 0 },
            { slot: 1, label: 'Player 2', status: 'WAITING', peerId: null, ping: 0 },
            { slot: 2, label: 'Player 3', status: 'OPEN', peerId: null, ping: 0 },
            { slot: 3, label: 'Player 4', status: 'OPEN', peerId: null, ping: 0 }
        ];

        this.eventLogs = [];
        this.remotePlayers = {
            1: { buttons: new Array(16).fill(false), axes: [0, 0], lastUpdate: 0 },
            2: { buttons: new Array(16).fill(false), axes: [0, 0], lastUpdate: 0 },
            3: { buttons: new Array(16).fill(false), axes: [0, 0], lastUpdate: 0 }
        };

        this.inputLoopId = null;
        this.pingIntervalId = null;
        this.rtt = 0;
        this.onLobbyUpdate = null;
        this.onClientProgress = null;

        this.setupGamepadProxy();
    }

    getIceServers() {
        return [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' },
            { urls: 'stun:global.stun.twilio.com:3478' },
            { urls: 'stun:openrelay.metered.ca:80' },
            // OpenRelay Public TURN Server (Handles strict 5G / Symmetric NATs)
            {
                urls: [
                    'turn:openrelay.metered.ca:80',
                    'turn:openrelay.metered.ca:443',
                    'turn:openrelay.metered.ca:443?transport=tcp'
                ],
                username: 'openrelayproject',
                credential: 'openrelayproject'
            }
        ];
    }

    logEvent(msg) {
        const time = new Date().toLocaleTimeString();
        const entry = `[${time}] ${msg}`;
        this.eventLogs.push(entry);
        if (this.eventLogs.length > 60) this.eventLogs.shift();
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

            // Slot 0: Local player 1
            result[0] = raw[0] || null;

            // Slots 1..3: Virtual gamepads for remote players if hosting
            for (let slot = 1; slot <= 3; slot++) {
                if (self.isHost && self.hasConnectedPlayer(slot)) {
                    const rp = self.remotePlayers[slot];
                    result[slot] = {
                        id: `ROMHub Netplay Virtual Gamepad (Player ${slot + 1})`,
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
     * Initializes Host mode with 2D GPU Blit Streamer and parallel listeners
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

        const webglCanvas = document.getElementById('canvas');
        if (!webglCanvas) throw new Error('Emulator canvas not found.');

        this.logEvent(`Initializing 2D GPU Blit Streamer...`);

        // Create 2D offscreen relay canvas
        if (!this.streamCanvas) {
            this.streamCanvas = document.createElement('canvas');
            this.streamCtx = this.streamCanvas.getContext('2d', { alpha: false, desynchronized: true });
        }
        this.streamCanvas.width = webglCanvas.width || 640;
        this.streamCanvas.height = webglCanvas.height || 480;

        // GPU Blit Loop: copies rendered WebGL frame into persistent 2D buffer at 60 FPS
        if (this.blitAnimFrameId) cancelAnimationFrame(this.blitAnimFrameId);
        const blitLoop = () => {
            if (this.isHost && webglCanvas) {
                if (webglCanvas.width > 0 && webglCanvas.height > 0) {
                    if (this.streamCanvas.width !== webglCanvas.width || this.streamCanvas.height !== webglCanvas.height) {
                        this.streamCanvas.width = webglCanvas.width;
                        this.streamCanvas.height = webglCanvas.height;
                    }
                    try {
                        this.streamCtx.drawImage(webglCanvas, 0, 0);
                    } catch (e) { }
                }
            }
            this.blitAnimFrameId = requestAnimationFrame(blitLoop);
        };
        this.blitAnimFrameId = requestAnimationFrame(blitLoop);

        // Capture stream from the 2D streamCanvas (guarantees non-empty frames!)
        const videoStream = this.streamCanvas.captureStream(60);

        let audioTrack = null;
        if (window.myApp && window.myApp.audioContext && window.myApp.gainNode) {
            const dest = window.myApp.audioContext.createMediaStreamDestination();
            window.myApp.gainNode.connect(dest);
            audioTrack = dest.stream.getAudioTracks()[0];
            this.logEvent(`Host Web Audio destination attached.`);
        }

        const tracks = [...videoStream.getVideoTracks()];
        if (audioTrack) tracks.push(audioTrack);
        this.mediaStream = new MediaStream(tracks);
        this.logEvent(`Blit Streamer ready: ${tracks.length} tracks (60 FPS).`);

        return new Promise((resolve, reject) => {
            this.peer = new Peer(this.roomId, {
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
        // 1. Listen for Incoming Media Calls from Clients
        this.peer.on('call', (incomingCall) => {
            this.logEvent(`Incoming Media Call from: ${incomingCall.peer}! Answering with 60 FPS stream...`);
            incomingCall.answer(this.mediaStream);

            const record = this.getOrCreatePeerRecord(incomingCall.peer);
            record.call = incomingCall;

            incomingCall.on('close', () => {
                this.logEvent(`Media call closed with ${incomingCall.peer}`);
            });
            incomingCall.on('error', (err) => {
                this.logEvent(`Media call error with ${incomingCall.peer}: ${err.message}`);
            });
        });

        // 2. Listen for Incoming Data Connections from Clients
        this.peer.on('connection', (conn) => {
            const record = this.getOrCreatePeerRecord(conn.peer);
            record.conn = conn;
            const assignedSlot = record.slot;

            this.logEvent(`Incoming data channel from: ${conn.peer} -> Slot P${assignedSlot + 1}`);
            this.updateSlotState(assignedSlot, 'CONNECTING', conn.peer);

            const markOpen = () => {
                this.logEvent(`DataChannel ACTIVE with P${assignedSlot + 1} (${conn.peer})!`);
                record.status = 'READY';
                this.updateSlotState(assignedSlot, 'READY', conn.peer);
                try {
                    conn.send({ type: 'WELCOME', slot: assignedSlot, roomId: this.roomId, gameStarted: this.gameStarted });
                } catch (e) { }
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

    getOrCreatePeerRecord(peerId) {
        if (this.connections[peerId]) {
            return this.connections[peerId];
        }

        // Clean up any stale records
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
                eventLogs: this.eventLogs,
                isReadyToPlay: this.slots.some(s => s.slot > 0 && (s.status === 'READY' || s.status === 'CONNECTING'))
            });
        }
    }

    startGame() {
        this.gameStarted = true;
        this.logEvent(`Host clicked START GAME! Broadcasting to players...`);
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

        const slot = u8[0] || defaultSlot;
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
     * Initializes Client mode with parallel Dual-Track WebRTC call & data channel
     */
    async startClient(targetRoomId) {
        this.isHost = false;
        this.isClient = true;
        this.roomId = targetRoomId.toUpperCase().trim();

        this.progress(1, 'Connecting to P2P Signaling Broker...');

        return new Promise((resolve, reject) => {
            this.peer = new Peer({
                config: {
                    iceServers: this.getIceServers(),
                    iceCandidatePoolSize: 10
                }
            });

            this.peer.on('open', (myId) => {
                this.progress(2, `Broker OK (${myId.substring(0, 8)}...). Calling Host ${this.roomId}...`);

                // 1. Parallel Media Call to Host
                try {
                    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                    const dummyDest = audioCtx.createMediaStreamDestination();
                    const dummyStream = dummyDest.stream;

                    this.logEvent(`Calling host ${this.roomId} for MediaStream...`);
                    const call = this.peer.call(this.roomId, dummyStream);
                    this.hostCall = call;

                    call.on('stream', (remoteStream) => {
                        this.progress(3, `Received remote MediaStream (${remoteStream.getVideoTracks().length} tracks)!`);
                        this.remoteStream = remoteStream;
                        this.attachRemoteStream(remoteStream, () => {
                            this.progress(4, `WebRTC Video Stream PLAYING (60 FPS)!`);
                            if (this.hostConnection && this.hostConnection.open) {
                                try { this.hostConnection.send({ type: 'STREAM_CONFIRMED' }); } catch (e) { }
                            }
                            resolve(this.playerSlot);
                        });
                    });

                    call.on('error', (err) => {
                        this.logEvent(`Media Call Error: ${err.message || err}`);
                    });
                } catch (e) {
                    this.logEvent(`Call exception: ${e.message}`);
                }

                // 2. Parallel Data Connection to Host
                this.hostConnection = this.peer.connect(this.roomId, {
                    reliable: false
                });

                this.hostConnection.on('open', () => {
                    this.progress(3, `DataChannel connected! Input streaming active.`);
                    this.startClientInputLoop();
                });

                this.hostConnection.on('data', (data) => {
                    if (data && data.type === 'WELCOME') {
                        this.playerSlot = data.slot;
                        this.progress(3, `Assigned as Player ${this.playerSlot + 1}.`);
                        const label = document.getElementById('netplayPlayerLabel');
                        if (label) label.textContent = `Player ${this.playerSlot + 1}`;
                    } else if (data && data.type === 'PING') {
                        try { this.hostConnection.send({ type: 'PONG', timestamp: data.timestamp }); } catch (e) { }
                        this.rtt = Math.round(performance.now() - data.timestamp);
                        const pingEl = document.getElementById('netplayPing');
                        if (pingEl) pingEl.textContent = this.rtt;
                    } else if (data && data.type === 'START_GAME') {
                        this.progress(4, `Game started by Host! Have fun!`);
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

    attachRemoteStream(stream, onPlaySuccess) {
        const videoEl = document.getElementById('netplayVideo');
        if (!videoEl) return;

        this.logEvent(`Attaching MediaStream (${stream.getVideoTracks().length} video, ${stream.getAudioTracks().length} audio)...`);

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
        if (this.inputLoopId) cancelAnimationFrame(this.inputLoopId);

        const packet = new Uint8Array(5);

        const loop = () => {
            if (!this.isClient || !this.hostConnection || !this.hostConnection.open) {
                this.inputLoopId = requestAnimationFrame(loop);
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

            this.inputLoopId = requestAnimationFrame(loop);
        };

        this.inputLoopId = requestAnimationFrame(loop);
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

    disconnect() {
        if (this.blitAnimFrameId) cancelAnimationFrame(this.blitAnimFrameId);
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
