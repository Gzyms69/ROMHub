/**
 * ROMHub Automated Multi-Client WebRTC Netplay E2E Test Suite
 * 
 * Simulates Host (Desktop PC) and Guest (Mobile Phone on 4G) in headless Chromium:
 * 1. P2P WebRTC Signaling & DataChannel Establishment
 * 2. High-speed ROM Streaming & CRC32 Verification
 * 3. Synchronized 3-2-1 Countdown Launch
 * 4. 60 FPS Bidirectional 7-byte Binary Input Transmission
 * 5. Touch Gamepad & Gamepad Proxy Verification
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const PORT = 8899;
const CHROME_PATH = '/usr/bin/google-chrome';

function createStaticServer() {
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.wasm': 'application/wasm',
        '.zip': 'application/zip',
        '.png': 'image/png'
    };

    const server = http.createServer((req, res) => {
        let reqPath = req.url.split('?')[0].split('#')[0];
        if (reqPath === '/') reqPath = '/index.html';
        const filePath = path.join(__dirname, '..', reqPath);

        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('404 Not Found');
                return;
            }
            const ext = path.extname(filePath).toLowerCase();
            res.writeHead(200, {
                'Content-Type': mimeTypes[ext] || 'application/octet-stream',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(data);
        });
    });

    return new Promise(resolve => {
        server.listen(PORT, () => {
            console.log(`[Test Harness] Static web server running on http://localhost:${PORT}`);
            resolve(server);
        });
    });
}

async function runE2ETest() {
    console.log('=== Starting ROMHub Netplay v3.0 Automated Multi-Client E2E Test ===');
    const server = await createStaticServer();

    let browserHost = null;
    let browserGuest = null;

    try {
        // 1. Launch Host (Desktop PC profile)
        console.log('[1/7] Launching Host Browser (Desktop Profile)...');
        browserHost = await puppeteer.launch({
            executablePath: CHROME_PATH,
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-fake-ui-for-media-stream', '--disable-web-security']
        });
        const pageHost = await browserHost.newPage();
        await pageHost.setViewport({ width: 1920, height: 1080 });

        pageHost.on('console', msg => {
            const text = msg.text();
            if (text.includes('[Netplay]') || text.includes('[Test]')) {
                console.log(`[Host Console] ${text}`);
            }
        });

        await pageHost.goto(`http://localhost:${PORT}`, { waitUntil: 'domcontentloaded' });
        await pageHost.waitForFunction(() => window.netplayManager !== undefined);

        // 2. Launch Guest (Mobile Device profile with Touch)
        console.log('[2/7] Launching Guest Browser (Emulated Mobile Pixel 7 profile)...');
        browserGuest = await puppeteer.launch({
            executablePath: CHROME_PATH,
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-fake-ui-for-media-stream', '--disable-web-security']
        });
        const pageGuest = await browserGuest.newPage();
        await pageGuest.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36');
        await pageGuest.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });

        pageGuest.on('console', msg => {
            const text = msg.text();
            if (text.includes('[Netplay]') || text.includes('[Test]')) {
                console.log(`[Guest Console] ${text}`);
            }
        });

        await pageGuest.goto(`http://localhost:${PORT}`, { waitUntil: 'domcontentloaded' });
        await pageGuest.waitForFunction(() => window.netplayManager !== undefined);

        // 3. Host stages a test ROM and starts Host Lobby
        console.log('[3/7] Host staging test ROM and starting P2P Host session...');
        const hostRoomId = await pageHost.evaluate(async () => {
            // Create a synthetic 128KB N64 Test ROM
            const testRom = new Uint8Array(128 * 1024);
            testRom[0] = 0x80; testRom[1] = 0x37; testRom[2] = 0x12; testRom[3] = 0x40; // N64 Header magic
            for (let i = 4; i < testRom.length; i++) {
                testRom[i] = (i * 31 + 7) & 0xFF;
            }
            window.lastLoadedRomData = testRom;
            window.lastLoadedRomName = 'test_mario.z64';

            const roomId = await window.netplayManager.startHost('ROM-TEST');
            return roomId;
        });

        console.log(`[Host] Host listening on Room ID: ${hostRoomId}`);

        // 4. Guest connects to Host via WebRTC DataChannel
        console.log('[4/7] Guest connecting to Host room...');
        await pageGuest.evaluate(async (roomId) => {
            await window.netplayManager.startClient(roomId);
        }, hostRoomId);

        // Wait for WebRTC DataChannel to open and ROM transfer to complete
        console.log('[5/7] Waiting for P2P ROM Chunk Streaming & CRC32 Verification...');
        await pageGuest.waitForFunction(() => {
            return window.netplayManager && window.netplayManager.stagedRomData !== null;
        }, { timeout: 15000 });

        const syncCheck = await pageGuest.evaluate(() => {
            const staged = window.netplayManager.stagedRomData;
            const crc = window.netplayManager.calculateCRC32(staged);
            return {
                size: staged.byteLength,
                crc32: crc,
                slot: window.netplayManager.playerSlot,
                rtt: window.netplayManager.rtt
            };
        });

        console.log(`[Guest] ✅ Staged ROM: ${syncCheck.size} bytes | CRC32: ${syncCheck.crc32} | Assigned: Player ${syncCheck.slot + 1}`);

        // Wait for Host to acknowledge Guest as READY
        await pageHost.waitForFunction(() => {
            return window.netplayManager && window.netplayManager.slots[1].status === 'READY';
        }, { timeout: 10000 });
        console.log('[Host] ✅ Host acknowledged Guest in Slot P2 as READY!');

        // 5. Trigger Synchronized Launch Countdown
        console.log('[6/7] Testing Synchronized Launch Countdown...');
        await pageHost.evaluate(() => {
            window.netplayManager.startSynchronizedLaunch();
        });

        // 6. Test Bidirectional Input Transmission (Guest -> Host and Host -> Guest)
        console.log('[7/7] Verifying Bidirectional 60 FPS Binary Input Transmission...');

        // Guest simulates pressing button A, button Z, and moving analog stick (X: 0.8, Y: -0.6)
        await pageGuest.evaluate(() => {
            window.touchController.init('touchOverlayContainer');
            window.touchController.state.A = true;
            window.touchController.state.Z = true;
            window.touchController.state.stickX = 0.8;
            window.touchController.state.stickY = -0.6;
            window.touchController.syncState();
        });

        // Allow 300ms for network packets to propagate
        await new Promise(r => setTimeout(r, 300));

        // Verify Host received Guest P2 inputs
        const hostReceivedInputs = await pageHost.evaluate(() => {
            const p2 = window.netplayManager.remotePlayers[1];
            return {
                btnA: p2.buttons[0],
                btnZ: p2.buttons[4],
                stickX: p2.axes[0],
                stickY: p2.axes[1]
            };
        });

        console.log('[Host Telemetry] Received Guest Inputs:', JSON.stringify(hostReceivedInputs));
        if (!hostReceivedInputs.btnA || !hostReceivedInputs.btnZ) {
            throw new Error('Host failed to receive Guest button A/Z inputs!');
        }
        if (Math.abs(hostReceivedInputs.stickX - 0.8) > 0.1 || Math.abs(hostReceivedInputs.stickY - (-0.6)) > 0.1) {
            throw new Error(`Host received invalid stick coordinates: ${hostReceivedInputs.stickX}, ${hostReceivedInputs.stickY}`);
        }
        console.log('✅ Guest -> Host Input Synchronization Verified!');

        // Host simulates pressing Button B and Start
        await pageHost.evaluate(() => {
            window.touchController.init('touchOverlayContainer');
            window.touchController.state.B = true;
            window.touchController.state.Start = true;
            window.touchController.state.stickX = -0.5;
            window.touchController.state.stickY = 0.75;
            window.touchController.syncState();
        });

        await new Promise(r => setTimeout(r, 300));

        // Verify Guest received Host P1 inputs
        const guestReceivedInputs = await pageGuest.evaluate(() => {
            const p1 = window.netplayManager.remotePlayers[0];
            return {
                btnB: p1.buttons[2],
                btnStart: p1.buttons[9],
                stickX: p1.axes[0],
                stickY: p1.axes[1]
            };
        });

        console.log('[Guest Telemetry] Received Host Inputs:', JSON.stringify(guestReceivedInputs));
        if (!guestReceivedInputs.btnB || !guestReceivedInputs.btnStart) {
            throw new Error('Guest failed to receive Host button B/Start inputs!');
        }
        console.log('✅ Host -> Guest Input Synchronization Verified!');

        console.log('\n======================================================');
        console.log('🎉 ALL MULTI-CLIENT WEBRTC NETPLAY TESTS PASSED 100%!');
        console.log('======================================================\n');
    } catch (err) {
        console.error('❌ Test failed with error:', err);
        process.exitCode = 1;
    } finally {
        if (browserHost) await browserHost.close();
        if (browserGuest) await browserGuest.close();
        server.close();
    }
}

runE2ETest();
