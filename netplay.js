/**
 * ROMHub Netplay - WebRTC Peer-to-Peer E2E Multiplayer & Remote Co-Op
 * 
 * Features:
 * - Ultra-low latency canvas video (60 FPS) and Web Audio streaming via WebRTC MediaStream
 * - Binary input streaming over RTCDataChannel (ordered: false, maxRetransmits: 0)
 * - Virtual Gamepad Injection Proxy into navigator.getGamepads for slots P2, P3, P4
 * - Full E2E encryption (DTLS-SRTP / SCTP)
 * - Friendly 6-character room codes and 1-click invite links
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
        this.remotePlayers = {
            1: { buttons: new Array(16).fill(false), axes: [0, 0], lastUpdate: 0 },
            2: { buttons: new Array(16).fill(false), axes: [0, 0], lastUpdate: 0 },
            3: { buttons: new Array(16).fill(false), axes: [0, 0], lastUpdate: 0 }
        };
        this.inputLoopId = null;
        this.pingIntervalId = null;
        this.rtt = 0;
        this.onStatusChange = null;

        this.setupGamepadProxy();
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

    /**
     * Generates a short, memorable 6-character room code (e.g. ROM-7821)
     */
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

        // Capture WebGL canvas at 60 FPS
        const videoStream = canvas.captureStream(60);

        // Capture Web Audio from window.myApp
        let audioTrack = null;
        if (window.myApp && window.myApp.audioContext && window.myApp.gainNode) {
            const dest = window.myApp.audioContext.createMediaStreamDestination();
            window.myApp.gainNode.connect(dest);
            audioTrack = dest.stream.getAudioTracks()[0];
        }

        const tracks = [...videoStream.getVideoTracks()];
        if (audioTrack) tracks.push(audioTrack);
        this.mediaStream = new MediaStream(tracks);

        return new Promise((resolve, reject) => {
            // Use PeerJS with Google STUN
            this.peer = new Peer(this.roomId, {
                config: {
                    iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:global.stun.twilio.com:3478' }
                    ]
                }
            });

            this.peer.on('open', (id) => {
                console.log(`[Netplay] Host listening on Room ID: ${id}`);
                this.roomId = id;
                this.setupHostListeners();
                this.startPingLoop();
                resolve(id);
            });

            this.peer.on('error', (err) => {
                console.error('[Netplay] Peer error:', err);
                // If room ID is taken, retry with random ID
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
                // Send welcome packet with assigned slot
                conn.send({ type: 'WELCOME', slot: assignedSlot, roomId: this.roomId });
                this.updateUI();
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
        });

        // Incoming media calls (Answering with captured canvas & audio stream)
        this.peer.on('call', (call) => {
            console.log(`[Netplay] Answering call from: ${call.peer}`);
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

        const slot = u8[0]; // 1 = P2, 2 = P3, 3 = P4
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

        return new Promise((resolve, reject) => {
            this.peer = new Peer({
                config: {
                    iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:global.stun.twilio.com:3478' }
                    ]
                }
            });

            this.peer.on('open', (myId) => {
                console.log(`[Netplay] Client peer ready: ${myId}. Connecting to ${this.roomId}...`);

                // 1. Establish Data Connection
                this.hostConnection = this.peer.connect(this.roomId, {
                    reliable: false,
                    serialization: 'binary'
                });

                this.hostConnection.on('open', () => {
                    console.log(`[Netplay] Data channel established with host.`);
                });

                this.hostConnection.on('data', (data) => {
                    if (data && data.type === 'WELCOME') {
                        this.playerSlot = data.slot;
                        console.log(`[Netplay] Welcome received. Playing as Player ${this.playerSlot + 1}`);
                        this.updateUI();
                        this.startClientInputLoop();
                    } else if (data && data.type === 'PING') {
                        this.hostConnection.send({ type: 'PONG', timestamp: data.timestamp });
                        this.rtt = Math.round(performance.now() - data.timestamp);
                        this.updateUI();
                    }
                });

                this.hostConnection.on('error', (err) => {
                    console.error('[Netplay] Connection error:', err);
                    reject(err);
                });

                // 2. Establish Media Call (receive video/audio)
                // We send an empty audio track so peerjs initiates call
                const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                const dummyStream = audioCtx.createMediaStreamDestination().stream;

                this.hostCall = this.peer.call(this.roomId, dummyStream);

                this.hostCall.on('stream', (remoteStream) => {
                    console.log('[Netplay] Remote MediaStream received!', remoteStream);
                    this.attachRemoteStream(remoteStream);
                    resolve(this.playerSlot);
                });

                this.hostCall.on('error', (err) => {
                    console.error('[Netplay] Call error:', err);
                });
            });

            this.peer.on('error', (err) => {
                console.error('[Netplay] Client Peer error:', err);
                reject(err);
            });
        });
    }

    attachRemoteStream(stream) {
        let videoEl = document.getElementById('netplayVideo');
        if (!videoEl) {
            videoEl = document.createElement('video');
            videoEl.id = 'netplayVideo';
            videoEl.autoplay = true;
            videoEl.playsInline = true;
            videoEl.muted = false;
            videoEl.style.width = '100%';
            videoEl.style.maxWidth = '960px';
            videoEl.style.borderRadius = '8px';
            videoEl.style.boxShadow = '0 8px 30px rgba(0,0,0,0.8)';
            videoEl.style.backgroundColor = '#000';

            const container = document.getElementById('netplayClientView');
            if (container) container.appendChild(videoEl);
        }
        videoEl.srcObject = stream;
        videoEl.play().catch(e => console.warn('[Netplay] Autoplay prevented, clicking video will start audio:', e));
    }

    startClientInputLoop() {
        if (this.inputLoopId) cancelAnimationFrame(this.inputLoopId);

        const packet = new Uint8Array(5);

        const loop = () => {
            if (!this.isClient || !this.hostConnection || !this.hostConnection.open) {
                this.inputLoopId = requestAnimationFrame(loop);
                return;
            }

            // Read Gamepad API
            let buttonsMask = 0;
            let stickX = 0;
            let stickY = 0;

            const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
            const gp = gamepads[0] || gamepads[1] || null;

            if (gp) {
                // Map standard gamepad buttons
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
                // Keyboard fallback from InputController
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
                stickX = ic.VectorX || 0;
                stickY = ic.VectorY || 0;
            }

            // Encode packet
            packet[0] = this.playerSlot; // 1 = P2
            packet[1] = (buttonsMask >> 8) & 0xFF;
            packet[2] = buttonsMask & 0xFF;
            packet[3] = Math.round(stickX * 127 + 128) & 0xFF;
            packet[4] = Math.round(stickY * 127 + 128) & 0xFF;

            this.hostConnection.send(packet);

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
                        c.conn.send({ type: 'PING', timestamp: now });
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
        this.updateUI();
    }
}

// Global instance
window.netplayManager = new NetplayManager();
