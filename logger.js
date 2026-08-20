/**
 * ROMHub Diagnostic Logger & Mobile On-Screen Debug Console
 * 
 * Intercepts console logs, records WebRTC / Emulation telemetry,
 * and provides a floating in-app debug HUD for mobile & desktop debugging.
 */

class DiagnosticLogger {
    constructor() {
        this.logs = [];
        this.maxLogs = 500;
        this.listeners = [];
        this.enabled = true;

        this.hookConsole();
    }

    hookConsole() {
        const methods = ['log', 'info', 'warn', 'error'];
        const self = this;

        methods.forEach(level => {
            const original = console[level].bind(console);
            console[level] = function (...args) {
                original(...args);
                self.record(level, args);
            };
        });

        window.addEventListener('error', (evt) => {
            self.record('error', [`[Uncaught Error] ${evt.message} (${evt.filename}:${evt.lineno})`]);
        });

        window.addEventListener('unhandledrejection', (evt) => {
            self.record('error', [`[Unhandled Promise Rejection]`, evt.reason]);
        });
    }

    record(level, args) {
        if (!this.enabled) return;

        const time = new Date().toISOString().substring(11, 19);
        const formatted = args.map(arg => {
            if (typeof arg === 'string') return arg;
            try {
                return JSON.stringify(arg);
            } catch (e) {
                return String(arg);
            }
        }).join(' ');

        const entry = { time, level, text: formatted };
        this.logs.push(entry);
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }

        this.notifyListeners(entry);
    }

    notifyListeners(entry) {
        this.listeners.forEach(fn => {
            try { fn(entry); } catch (e) { }
        });
    }

    getLogsText() {
        return this.logs.map(l => `[${l.time}] [${l.level.toUpperCase()}] ${l.text}`).join('\n');
    }

    clear() {
        this.logs = [];
        this.notifyListeners(null);
    }

    getSystemTelemetry() {
        const netplay = window.netplayManager;
        return {
            userAgent: navigator.userAgent,
            screen: `${window.innerWidth}x${window.innerHeight} (dpr: ${window.devicePixelRatio})`,
            touchSupport: ('ontouchstart' in window) || navigator.maxTouchPoints > 0,
            webRTCSupported: !!(window.RTCPeerConnection && window.RTCDataChannel),
            netplay: netplay ? {
                isHost: netplay.isHost,
                isClient: netplay.isClient,
                roomId: netplay.roomId,
                peerId: netplay.peer ? netplay.peer.id : null,
                playerSlot: netplay.playerSlot,
                rtt: netplay.rtt,
                iceState: netplay.iceConnectionState,
                dataChannelState: netplay.getDataChannelStatus(),
                videoTrackStatus: netplay.getVideoTrackStatus()
            } : null
        };
    }
}

window.appLogger = new DiagnosticLogger();
console.log('[Logger] In-app diagnostic logging initialized.');
