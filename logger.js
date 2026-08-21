/**
 * ROMHub Diagnostic Logger & Mobile On-Screen Debug Console (High-Fidelity v2.0)
 * 
 * Intercepts console logs, records WebRTC / Emulation telemetry,
 * suppresses binary packet noise, and provides full diagnostic dumps.
 */

class DiagnosticLogger {
    constructor() {
        this.logs = [];
        this.maxLogs = 800;
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

                // Filter out high-frequency raw PeerJS packet noise if any leaks
                if (args[0] && typeof args[0] === 'string') {
                    if (args[0].includes('dc onmessage:') || args[0].includes('texParameter:')) {
                        return;
                    }
                }

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
            if (arg instanceof Error || (arg && (arg.message || arg.stack))) {
                return `${arg.name || 'Error'}: ${arg.message || ''}\n${arg.stack || ''}`;
            }
            if (arg instanceof Uint8Array || arg instanceof ArrayBuffer) {
                const len = arg.byteLength !== undefined ? arg.byteLength : arg.length;
                return `[Binary ArrayBuffer: ${len} bytes]`;
            }
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
            timestamp: new Date().toISOString(),
            userAgent: navigator.userAgent,
            screen: `${window.innerWidth}x${window.innerHeight} (dpr: ${window.devicePixelRatio})`,
            touchSupport: ('ontouchstart' in window) || navigator.maxTouchPoints > 0,
            webRTCSupported: !!(window.RTCPeerConnection && window.RTCDataChannel),
            netplay: netplay && typeof netplay.getTelemetry === 'function' ? netplay.getTelemetry() : null,
            controllers: {
                p1: netplay && typeof netplay.getLiveControllerState === 'function' ? netplay.getLiveControllerState(0) : null,
                p2: netplay && typeof netplay.getLiveControllerState === 'function' ? netplay.getLiveControllerState(1) : null
            }
        };
    }

    generateFullReport() {
        const telemetry = this.getSystemTelemetry();
        let report = `=== ROMHub Full Diagnostic Report ===\n`;
        report += `Generated At: ${telemetry.timestamp}\n`;
        report += `User Agent: ${telemetry.userAgent}\n`;
        report += `Viewport: ${telemetry.screen}\n`;
        report += `Touch Screen: ${telemetry.touchSupport}\n`;
        report += `WebRTC Support: ${telemetry.webRTCSupported}\n\n`;

        if (telemetry.netplay) {
            report += `--- WebRTC Netplay Telemetry ---\n`;
            for (const [key, val] of Object.entries(telemetry.netplay)) {
                report += `${key}: ${typeof val === 'object' ? JSON.stringify(val) : val}\n`;
            }
            report += `\n`;
        }

        if (telemetry.controllers) {
            report += `--- Live Controller States ---\n`;
            report += `P1: ${JSON.stringify(telemetry.controllers.p1)}\n`;
            report += `P2: ${JSON.stringify(telemetry.controllers.p2)}\n\n`;
        }

        report += `--- Recent Console Logs (Last ${this.logs.length}) ---\n`;
        report += this.getLogsText();
        report += `\n=== End of Report ===\n`;
        return report;
    }

    copyFullReport() {
        const report = this.generateFullReport();
        if (navigator.clipboard && navigator.clipboard.writeText) {
            return navigator.clipboard.writeText(report);
        } else {
            const ta = document.createElement('textarea');
            ta.value = report;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            return Promise.resolve();
        }
    }
}

window.appLogger = new DiagnosticLogger();
console.log('[Logger] In-app diagnostic logging initialized.');
