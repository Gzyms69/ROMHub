/**
 * ROMHub Diagnostic Logger & Mobile On-Screen Debug Console
 * 
 * Intercepts console logs, records WebRTC / Emulation telemetry,
 * and provides a floating in-app debug HUD for mobile & desktop debugging.
 */

class DiagnosticLogger {
    constructor() {
        this.logs = [];
        this.maxLogs = 600;
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
            timestamp: new Date().toISOString(),
            userAgent: navigator.userAgent,
            screen: `${window.innerWidth}x${window.innerHeight} (dpr: ${window.devicePixelRatio})`,
            touchSupport: ('ontouchstart' in window) || navigator.maxTouchPoints > 0,
            webRTCSupported: !!(window.RTCPeerConnection && window.RTCDataChannel),
            netplay: netplay && typeof netplay.getTelemetry === 'function' ? netplay.getTelemetry() : null
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
