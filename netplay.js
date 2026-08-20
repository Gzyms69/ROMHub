/**
 * ROMHub Netplay - WebRTC Peer-to-Peer E2E Multiplayer & Remote Co-Op
 * 
 * Features:
 * - Ultra-low latency canvas video (60 FPS) and Web Audio streaming via WebRTC MediaStream
 * - Host-Initiated Calling architecture for reliable mobile & desktop media negotiation
 * - Safe Mobile Video Autoplay (Muted start + Tap-to-Unmute prompt)
 * - Binary input streaming over RTCDataChannel (ordered: false, maxRetransmits: 0)
 * - Virtual Gamepad Injection Proxy into navigator.getGamepads for slots P2, P3, P4
 * - Full E2E encryption (DTLS-SRTP / SCTP)
 * - Multi-STUN server configuration for 5G/LTE NAT traversal
 * - Deep diagnostic telemetry hooks for appLogger
 */

class NetplayManager {
    constructor() {
        this.peer = null;
        this.roomId = null;
        this.isHost = false;
        this.isClient = false;
        this.playerSlot = 1; // 1 = P2, 2 = P3, 3 = P4
        this.connections = {}; // peerId -> { conn, call, slot, ping }
        this.hostConnection = null;
        this.hostCall = null;
        this.mediaStream = null;
        this.remoteStream = null;
        this.remotePlayers = {
            1: { buttons: new Array(16).fill(false), axes: [0, 0], lastUpdate: 0 },
            2: { buttons: new Array(16).fill(false), axes: [0, 0], lastUpdate: 0 },
            3: { buttons: new Array(16).fill(false), axes: [0, 0], lastUpdate: 0 }
        };
        this.inputLoopId = null;
        this.pingIntervalId = null;
        this.rtt = 0;
        this.iceConnectionState = 'new';
        this.onStatusChange = null;

        this.setupGamepadProxy();
    }

    getIceServers() {
        return [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' },
            { urls: 'stun:global.stun.twilio.com:3478' }
        ];
    }

    /**
     * Intercepts navigator.getGamepads so the C/WASM core automatically reads
     * remote players connected via WebRTC as native Gamepad devices in slots 1, 2, 3.
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
        return Object.values(this.connections).some(c => c.slot === slot && c.conn && c.conn.open);
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
     * Initializes Host mode: captures canvas + audio and listens for peers.
     */
    async startHost(customRoomId = null) {
        this.isHost = true;
        this.isClient = false;
        this.roomId = customRoomId || this.generateRoomId();

        const canvas = document.getElementById('canvas');
        if (!canvas) throw new Error('Emulator canvas not found.');

        console.log('[Netplay] Initializing Host canvas & audio capture...');
        // Capture WebGL canvas at 60 FPS
        const videoStream = canvas.captureStream(60);

        // Capture Web Audio from window.myApp
        let audioTrack = null;
        if (window.myApp && window.myApp.audioContext && window.myApp.gainNode) {
            const dest = window.myApp.audioContext.createMediaStreamDestination();
            window.myApp.gainNode.connect(dest);
            audioTrack = dest.stream.getAudioTracks()[0];
            console.log('[Netplay] Audio track attached to host stream.');
        } else {
            console.warn('[Netplay] No active AudioContext found on host.');
        }

        const tracks = [...videoStream.getVideoTracks()];
        if (audioTrack) tracks.push(audioTrack);
        this.mediaStream = new MediaStream(tracks);
        console.log(`[Netplay] Host MediaStream ready: ${tracks.length} tracks (Video: ${videoStream.getVideoTracks().length}, Audio: ${audioTrack ? 1 : 0}).`);

        return new Promise((resolve, reject) => {
            this.peer = new Peer(this.roomId, {
                config: { iceServers: this.getIceServers() }
            });

            this.peer.on('open', (id) => {
                console.log(`[Netplay] Host listening on Room ID: ${id}`);
                this.roomId = id;
                this.setupHostListeners();
                this.startPingLoop();
                resolve(id);
            });

            this.peer.on('error', (err) => {
                console.error('[Netplay] Host Peer error:', err);
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
        // Incoming data connections (Controller inputs & Pings)
        this.peer.on('connection', (conn) => {
            const assignedSlot = this.getNextAvailableSlot();
            console.log(`[Netplay] Peer connected: ${conn.peer} -> Assigned to Player ${assignedSlot + 1}`);

            const peerRecord = { conn, call: null, slot: assignedSlot, ping: 0 };
            this.connections[conn.peer] = peerRecord;

            conn.on('open', () => {
                console.log(`[Netplay] DataChannel open with peer: ${conn.peer}`);
                conn.send({ type: 'WELCOME', slot: assignedSlot, roomId: this.roomId });
                this.updateUI();

                // HOST-INITIATED CALLING: Host calls the client with the MediaStream!
                if (this.mediaStream) {
                    console.log(`[Netplay] Host initiating WebRTC Media Call to peer: ${conn.peer}...`);
                    try {
                        const call = this.peer.call(conn.peer, this.mediaStream);
                        peerRecord.call = call;

                        call.on('error', (err) => console.error('[Netplay] Host Call error:', err));
                        call.on('close', () => console.log('[Netplay] Host Call closed with peer:', conn.peer));
                    } catch (callErr) {
                        console.error('[Netplay] Failed to initiate call to peer:', callErr);
                    }
                }
            });

            conn.on('data', (data) => {
                if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
                    this.handleBinaryInput(data, assignedSlot);
                } else if (typeof data === 'object') {
                    if (data.type === 'PONG') {
                        const now = performance.now();
                        peerRecord.ping = Math.round(now - data.timestamp);
                        this.updateUI();
                    }
                }
            });

            conn.on('close', () => {
                console.log(`[Netplay] Peer disconnected: ${conn.peer}`);
                delete this.connections[conn.peer];
                this.updateUI();
            });

            conn.on('error', (err) => {
                console.error(`[Netplay] Peer connection error with ${conn.peer}:`, err);
            });
        });

        // Backup listener in case client initiates call
        this.peer.on('call', (call) => {
            console.log(`[Netplay] Incoming call from client: ${call.peer}, answering with MediaStream.`);
            call.answer(this.mediaStream);
            if (this.connections[call.peer]) {
                this.connections[call.peer].call = call;
            }
        });
    }

    getNextAvailableSlot() {
        const usedSlots = Object.values(this.connections).map(c => c.slot);
        for (let s = 1; s <= 3; s++) {
            if (!usedSlots.includes(s)) return s;
        }
        return 1; // Fallback to P2
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
     * Initializes Client mode: joins host room, receives video/audio, and streams controller inputs.
     */
    async startClient(targetRoomId) {
        this.isHost = false;
        this.isClient = true;
        this.roomId = targetRoomId.toUpperCase().trim();

        console.log(`[Netplay] Starting Client for room ${this.roomId}...`);

        return new Promise((resolve, reject) => {
            this.peer = new Peer({
                config: { iceServers: this.getIceServers() }
            });

            this.peer.on('open', (myId) => {
                console.log(`[Netplay] Client peer ready with ID: ${myId}. Connecting to host: ${this.roomId}...`);

                // 1. Establish Data Connection
                this.hostConnection = this.peer.connect(this.roomId, {
                    reliable: false,
                    serialization: 'json'
                });

                this.hostConnection.on('open', () => {
                    console.log(`[Netplay] RTCDataChannel connected to host!`);
                    this.startClientInputLoop();
                });

                this.hostConnection.on('data', (data) => {
                    if (data && data.type === 'WELCOME') {
                        this.playerSlot = data.slot;
                        console.log(`[Netplay] Welcome received from host! Assigned as Player ${this.playerSlot + 1}`);
                        this.updateUI();
                    } else if (data && data.type === 'PING') {
                        this.hostConnection.send({ type: 'PONG', timestamp: data.timestamp });
                        this.rtt = Math.round(performance.now() - data.timestamp);
                        this.updateUI();
                    }
                });

                this.hostConnection.on('error', (err) => {
                    console.error('[Netplay] Client DataChannel error:', err);
                    reject(err);
                });

                // 2. Listen for incoming Host-Initiated Call
                this.peer.on('call', (incomingCall) => {
                    console.log('[Netplay] Received incoming MediaStream call from host!');
                    this.hostCall = incomingCall;

                    // Answer call without sending client tracks
                    incomingCall.answer();

                    incomingCall.on('stream', (remoteStream) => {
                        console.log('[Netplay] Remote MediaStream arrived!', remoteStream);
                        this.remoteStream = remoteStream;
                        this.attachRemoteStream(remoteStream);
                        resolve(this.playerSlot);
                    });

                    incomingCall.on('error', (err) => {
                        console.error('[Netplay] Client Call error:', err);
                    });
                });
            });

            this.peer.on('error', (err) => {
                console.error('[Netplay] Client Peer error:', err);
                reject(err);
            });
        });
    }

    /**
     * Attaches received stream to video element with mobile Autoplay Policy compliance.
     */
    attachRemoteStream(stream) {
        console.log('[Netplay] Attaching stream to video element...');
        const videoEl = document.getElementById('netplayVideo');
        if (!videoEl) {
            console.error('[Netplay] #netplayVideo element not found in DOM!');
            return;
        }

        videoEl.srcObject = stream;
        videoEl.muted = true; // Crucial for mobile autoplay approval!
        videoEl.setAttribute('playsinline', '');
        videoEl.setAttribute('webkit-playsinline', '');
        videoEl.setAttribute('autoplay', '');

        const playPromise = videoEl.play();
        if (playPromise !== undefined) {
            playPromise.then(() => {
                console.log('[Netplay] Video playing successfully (60 FPS Muted start).');
                // Show Tap-to-Unmute banner if audio tracks exist
                const hasAudio = stream.getAudioTracks().length > 0;
                const audioBanner = document.getElementById('netplayAudioBanner');
                if (audioBanner && hasAudio) {
                    audioBanner.style.display = 'block';
                }
            }).catch((err) => {
                console.warn('[Netplay] Autoplay prevented, user interaction required:', err);
                const audioBanner = document.getElementById('netplayAudioBanner');
                if (audioBanner) {
                    audioBanner.innerHTML = '▶️ Tap here to start video & audio stream';
                    audioBanner.style.display = 'block';
                }
            });
        }

        // Initialize mobile touch controls overlay if on mobile
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
                console.log('[Netplay] Audio unmuted successfully.');
                const audioBanner = document.getElementById('netplayAudioBanner');
                if (audioBanner) audioBanner.style.display = 'none';
            }).catch(err => console.error('[Netplay] Error unmuting audio:', err));
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

            // 1. Check TouchController first
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

            // 2. Read Gamepad API if available
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
                // 3. Read Keyboard Fallback
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

            // Encode 5-byte binary packet
            packet[0] = this.playerSlot; // 1 = P2
            packet[1] = (buttonsMask >> 8) & 0xFF;
            packet[2] = buttonsMask & 0xFF;
            packet[3] = Math.round(stickX * 127 + 128) & 0xFF;
            packet[4] = Math.round(stickY * 127 + 128) & 0xFF;

            try {
                this.hostConnection.send(packet);
            } catch (sendErr) { }

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

    updateUI() {
        if (typeof this.onStatusChange === 'function') {
            this.onStatusChange({
                isHost: this.isHost,
                isClient: this.isClient,
                roomId: this.roomId,
                playerSlot: this.playerSlot,
                connections: Object.values(this.connections).map(c => ({
                    slot: c.slot,
                    peerId: c.conn.peer,
                    ping: c.ping
                })),
                rtt: this.rtt
            });
        }
    }

    getDataChannelStatus() {
        if (this.hostConnection) {
            return this.hostConnection.open ? 'OPEN' : 'CONNECTING/CLOSED';
        }
        const openCount = Object.values(this.connections).filter(c => c.conn && c.conn.open).length;
        return `${openCount} active connections`;
    }

    getVideoTrackStatus() {
        const stream = this.remoteStream || this.mediaStream;
        if (!stream) return 'No active stream';
        const tracks = stream.getVideoTracks();
        if (tracks.length === 0) return 'No video tracks';
        const vt = tracks[0];
        return `Track: ${vt.label || 'CanvasTrack'} (state: ${vt.readyState}, enabled: ${vt.enabled}, muted: ${vt.muted})`;
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
        this.updateUI();
    }
}

// Global instance
window.netplayManager = new NetplayManager();
