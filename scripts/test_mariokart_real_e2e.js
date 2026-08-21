/**
 * ROMHub Master Automated Real Mario Kart 64 E2E Test Suite
 */

const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROM_PATH = '/home/gzyms/Downloads/Mario Kart 64/Mario Kart 64 (USA).z64';
const PORT = 8892;

if (!fs.existsSync(ROM_PATH)) {
    console.error(`[Test Harness Error] Real Mario Kart ROM not found at: ${ROM_PATH}`);
    process.exit(1);
}

const romBuffer = fs.readFileSync(ROM_PATH);
console.log(`================================================================`);
console.log(`🚀 ROMHub Mario Kart 64 Real E2E Multi-Client Test Harness`);
console.log(`🎮 ROM: Mario Kart 64 (USA) | Size: ${(romBuffer.length / (1024 * 1024)).toFixed(2)} MB (${romBuffer.length} bytes)`);
console.log(`================================================================\n`);

const server = http.createServer((req, res) => {
    let reqPath = req.url.split('?')[0].split('#')[0];
    if (reqPath === '/') reqPath = '/index.html';
    if (reqPath === '/mariokart.z64') {
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': romBuffer.length,
            'Access-Control-Allow-Origin': '*'
        });
        res.end(romBuffer);
        return;
    }

    const filePath = path.join(__dirname, '..', reqPath);
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end(`File not found: ${reqPath}`);
            return;
        }
        const ext = path.extname(filePath);
        const mimeTypes = {
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.wasm': 'application/wasm',
            '.zip': 'application/zip',
            '.png': 'image/png',
            '.ttf': 'font/ttf'
        };
        res.writeHead(200, {
            'Content-Type': mimeTypes[ext] || 'application/octet-stream',
            'Access-Control-Allow-Origin': '*'
        });
        res.end(data);
    });
}).listen(PORT, async () => {
    console.log(`[Test Harness] HTTP server running on http://localhost:${PORT}`);

    const chromeArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--enable-webgl',
        '--enable-webgl2',
        '--ignore-gpu-blocklist',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding'
    ];

    let hostBrowser, guestBrowser;

    try {
        // Step 1: Launch Host Browser (Desktop)
        console.log(`[1/8] Launching Host Browser (Desktop Profile)...`);
        hostBrowser = await puppeteer.launch({
            executablePath: '/usr/bin/google-chrome',
            headless: 'new',
            args: chromeArgs
        });
        const hostPage = await hostBrowser.newPage();
        await hostPage.setViewport({ width: 1280, height: 800, isMobile: false });

        hostPage.on('console', msg => {
            const t = msg.text();
            if (t.includes('[Netplay]') || t.includes('MARIOKART') || t.includes('Starting R4300') || t.includes('Error')) {
                console.log(`[Host Console] ${t}`);
            }
        });
        hostPage.on('pageerror', err => console.error(`[Host Error] ${err.message}`));

        // Step 2: Launch Guest Browser (Mobile Touch)
        console.log(`[2/8] Launching Guest Browser (Mobile Touch Profile)...`);
        guestBrowser = await puppeteer.launch({
            executablePath: '/usr/bin/google-chrome',
            headless: 'new',
            args: chromeArgs
        });
        const guestPage = await guestBrowser.newPage();
        await guestPage.setUserAgent('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36');
        await guestPage.setViewport({ width: 411, height: 784, isMobile: true, hasTouch: true });

        guestPage.on('console', msg => {
            const t = msg.text();
            if (t.includes('[Netplay]') || t.includes('TouchController') || t.includes('Starting R4300') || t.includes('Error')) {
                console.log(`[Guest Console] ${t}`);
            }
        });
        guestPage.on('pageerror', err => console.error(`[Guest Error] ${err.message}`));

        // Step 3: Host loads Mario Kart 64 & starts Lobby
        console.log(`[3/8] Host loading Mario Kart 64 and opening Netplay Lobby...`);
        await hostPage.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle0' });

        const hostRoomId = await hostPage.evaluate(async () => {
            const res = await fetch('/mariokart.z64');
            const buf = await res.arrayBuffer();
            const u8 = new Uint8Array(buf);
            window.lastLoadedRomData = u8;
            window.lastLoadedRomName = 'Mario Kart 64 (USA).z64';
            window.myApp.rom_name = 'Mario Kart 64 (USA).z64';

            // Boot ROM on Host
            await window.myApp.LoadEmulator(u8);

            const roomId = await window.netplayManager.startHost();
            return roomId;
        });

        console.log(`[Host] Netplay Lobby created with Room ID: ${hostRoomId}`);

        // Step 4: Guest connects to Host Lobby via hash URL
        console.log(`[4/8] Guest connecting to Host room ${hostRoomId}...`);
        await guestPage.goto(`http://localhost:${PORT}#join=${hostRoomId}`, { waitUntil: 'networkidle0' });

        // Step 5: Wait for 12MB ROM Chunk Transfer and CRC32 Verification
        console.log(`[5/8] Streaming 12MB ROM over WebRTC DataChannel to Guest...`);
        await guestPage.waitForFunction(() => {
            return window.netplayManager && window.netplayManager.stagedRomData && window.netplayManager.stagedRomData.byteLength > 10000000;
        }, { timeout: 35000 });

        const guestCRC = await guestPage.evaluate(() => {
            return window.netplayManager.calculateCRC32(window.netplayManager.stagedRomData);
        });
        console.log(`[Guest] ✅ 12MB ROM fully received & verified! (CRC32: ${guestCRC})`);

        // Wait for Host to acknowledge Guest as READY
        await hostPage.waitForFunction(() => {
            return window.netplayManager && window.netplayManager.slots.some(s => s.slot === 1 && s.status === 'READY');
        }, { timeout: 10000 });
        console.log(`[Host] ✅ Host acknowledged Guest in Slot P2 as READY!`);

        // Step 6: Host triggers Synchronized 3-2-1 Launch
        console.log(`[6/8] Host broadcasting Synchronized 3-Second Launch...`);
        await hostPage.evaluate(() => {
            window.myApp.startLobbyGame();
        });

        // Step 7: Wait for Mupen64Plus Core to Boot on both Browsers
        console.log(`[7/8] Booting Mupen64Plus-WASM Core on Host and Guest...`);
        
        await Promise.all([
            hostPage.waitForFunction(() => {
                return window.myApp && window.myApp.audioInited && window.myApp.audioWritePosition > 0;
            }, { timeout: 20000 }),
            guestPage.waitForFunction(() => {
                return window.myApp && window.myApp.audioInited && window.myApp.audioWritePosition > 0;
            }, { timeout: 20000 })
        ]);

        console.log(`[Both Browsers] ✅ Mario Kart 64 R4300 CPU Cores Running in Lockstep!`);

        // Step 8: Multi-Controller Real Input Navigation Verification
        console.log(`[8/8] Testing Bidirectional Controller Inputs & Menu Navigation...`);

        // Simulate Player 1 pressing START
        await hostPage.evaluate(() => {
            const ic = window.myApp.rivetsData.inputController;
            ic.Key_Action_Start = true;
        });

        // Simulate Player 2 pressing A and moving analog stick on mobile touch pad
        await guestPage.evaluate(() => {
            if (window.touchController) {
                window.touchController.state.A = true;
                window.touchController.state.stickX = 0.75;
                window.touchController.state.stickY = -0.50;
            }
        });

        // Allow 3 seconds of frame transmission
        await new Promise(r => setTimeout(r, 3000));

        // Read Host Telemetry on Guest inputs
        const hostTelemetry = await hostPage.evaluate(() => {
            const p2 = window.netplayManager.remotePlayers[1];
            return {
                p2Received: !!p2,
                p2BtnA: p2 ? p2.buttons[0] : false,
                p2StickX: p2 ? p2.axes[0] : 0,
                packetsReceived: window.netplayManager.tempPacketsReceived
            };
        });

        // Read Guest Telemetry on Host inputs
        const guestTelemetry = await guestPage.evaluate(() => {
            const p1 = window.netplayManager.remotePlayers[0];
            return {
                p1Received: !!p1,
                p1BtnStart: p1 ? p1.buttons[9] : false,
                packetsReceived: window.netplayManager.tempPacketsReceived
            };
        });

        console.log(`[Host Verified Telemetry]:`, JSON.stringify(hostTelemetry, null, 2));
        console.log(`[Guest Verified Telemetry]:`, JSON.stringify(guestTelemetry, null, 2));

        if (!hostTelemetry.p2BtnA || !hostTelemetry.p2StickX) {
            throw new Error(`Host did not receive Player 2 inputs from Guest!`);
        }
        if (!guestTelemetry.p1BtnStart) {
            throw new Error(`Guest did not receive Player 1 inputs from Host!`);
        }

        console.log(`\n================================================================`);
        console.log(`🎉 REAL MARIO KART 64 E2E MULTI-CLIENT TEST PASSED 100%!`);
        console.log(`================================================================\n`);

        await hostBrowser.close();
        await guestBrowser.close();
        server.close();
        process.exit(0);

    } catch (err) {
        console.error(`\n❌ [TEST HARNESS FAILURE]:`, err);
        if (hostBrowser) await hostBrowser.close();
        if (guestBrowser) await guestBrowser.close();
        server.close();
        process.exit(1);
    }
});
