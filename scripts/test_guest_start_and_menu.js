const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROM_PATH = '/home/gzyms/Downloads/Mario Kart 64/Mario Kart 64 (USA).z64';
const ARTIFACT_DIR = '/home/gzyms/.gemini/antigravity-cli/brain/eba18644-e045-474e-972b-93a8f217a06b';
const PORT = 8899;

if (!fs.existsSync(ROM_PATH)) {
    console.error(`❌ ROM file not found: ${ROM_PATH}`);
    process.exit(1);
}

const romBuffer = fs.readFileSync(ROM_PATH);

const server = http.createServer((req, res) => {
    let reqPath = req.url.split('?')[0].split('#')[0];
    if (reqPath === '/') reqPath = '/index.html';
    if (reqPath === '/mariokart.z64') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': romBuffer.length });
        res.end(romBuffer);
        return;
    }
    const filePath = path.join(__dirname, '..', reqPath);
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end(); return; }
        const ext = path.extname(filePath);
        const mime = {
            '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
            '.wasm': 'application/wasm', '.zip': 'application/zip', '.png': 'image/png'
        }[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
    });
});

server.listen(PORT, async () => {
    console.log(`================================================================`);
    console.log(`🎮 ROMHub Guest Co-Op Menu Navigation & Gameplay Test`);
    console.log(`================================================================\n`);

    let hostBrowser = null;
    let guestBrowser = null;

    try {
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

        hostBrowser = await puppeteer.launch({
            executablePath: '/usr/bin/google-chrome',
            headless: 'new',
            args: chromeArgs,
            defaultViewport: { width: 1280, height: 720 }
        });

        guestBrowser = await puppeteer.launch({
            executablePath: '/usr/bin/google-chrome',
            headless: 'new',
            args: chromeArgs,
            defaultViewport: { width: 412, height: 915, isMobile: true, hasTouch: true }
        });

        const hostPage = await hostBrowser.newPage();
        const guestPage = await guestBrowser.newPage();

        hostPage.on('console', msg => {
            const t = msg.text();
            if (t.includes('[Netplay]') || t.includes('MARIOKART') || t.includes('Starting R4300') || t.includes('Error')) {
                console.log(`[Host Console] ${t}`);
            }
        });
        guestPage.on('console', msg => {
            const t = msg.text();
            if (t.includes('[Netplay]') || t.includes('TouchController') || t.includes('Starting R4300') || t.includes('Error')) {
                console.log(`[Guest Console] ${t}`);
            }
        });

        // 1. Host stages ROM
        console.log(`[1/6] Staging Mario Kart 64 on Host...`);
        await hostPage.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle0' });

        const hostRoomId = await hostPage.evaluate(async () => {
            const res = await fetch('/mariokart.z64');
            const buf = await res.arrayBuffer();
            const u8 = new Uint8Array(buf);
            window.lastLoadedRomData = u8;
            window.lastLoadedRomName = 'Mario Kart 64 (USA).z64';
            window.myApp.rom_name = 'Mario Kart 64 (USA).z64';

            await window.myApp.LoadEmulator(u8);
            const roomId = await window.netplayManager.startHost();
            return roomId;
        });

        console.log(`[Host] Lobby online: ${hostRoomId}`);

        // 2. Guest connects
        console.log(`[2/6] Connecting Guest (Mobile Touch Profile)...`);
        await guestPage.goto(`http://localhost:${PORT}#join=${hostRoomId}`, { waitUntil: 'networkidle0' });

        await guestPage.waitForFunction(() => {
            return window.netplayManager && window.netplayManager.stagedRomData && window.netplayManager.stagedRomData.byteLength > 10000000;
        }, { timeout: 35000 });
        console.log(`[Guest] ROM transferred & verified.`);

        await hostPage.waitForFunction(() => {
            return window.netplayManager && window.netplayManager.slots.some(s => s.slot === 1 && s.status === 'READY');
        }, { timeout: 15000 });

        // 3. Launch
        console.log(`[3/6] Synchronized Launch...`);
        await hostPage.evaluate(() => {
            window.myApp.startLobbyGame();
        });

        // Wait 10s for Title Screen
        console.log(`[4/6] Waiting 10s for Title Screen...`);
        await new Promise(r => setTimeout(r, 10000));

        // 4. ONLY GUEST (on Phone) presses START
        console.log(`[5/6] GUEST (Mobile Phone) pressing START to start the game...`);
        await guestPage.evaluate(async () => {
            if (window.touchController) {
                window.touchController.state.Start = true;
                await new Promise(r => setTimeout(r, 800));
                window.touchController.state.Start = false;
            }
        });

        console.log(`Waiting 4s for Game Select Menu to appear on both screens...`);
        await new Promise(r => setTimeout(r, 4000));

        const pathHostMenu = path.join(ARTIFACT_DIR, 'guest_start_host_menu.png');
        const pathGuestMenu = path.join(ARTIFACT_DIR, 'guest_start_guest_menu.png');
        await hostPage.screenshot({ path: pathHostMenu });
        await guestPage.screenshot({ path: pathGuestMenu });
        console.log(`📸 Screenshots saved: [guest_start_host_menu.png], [guest_start_guest_menu.png]`);

        // 5. GUEST on Mobile navigates Menu (Down -> A -> A -> A) to enter 2P Mario GP
        console.log(`[6/6] GUEST navigating to 2P Mario GP (Down -> A -> A -> A)...`);
        await guestPage.evaluate(async () => {
            if (window.touchController) {
                // Down to 2P Game
                window.touchController.state.DPAD_DOWN = true;
                window.touchController.state.stickY = 1.0;
                await new Promise(r => setTimeout(r, 500));
                window.touchController.state.DPAD_DOWN = false;
                window.touchController.state.stickY = 0;
                await new Promise(r => setTimeout(r, 800));

                // Confirm 2P Game
                window.touchController.state.A = true;
                await new Promise(r => setTimeout(r, 400));
                window.touchController.state.A = false;
                await new Promise(r => setTimeout(r, 1500));

                // Confirm Mario GP
                window.touchController.state.A = true;
                await new Promise(r => setTimeout(r, 400));
                window.touchController.state.A = false;
                await new Promise(r => setTimeout(r, 1500));

                // Confirm 50cc
                window.touchController.state.A = true;
                await new Promise(r => setTimeout(r, 400));
                window.touchController.state.A = false;
            }
        });

        console.log(`Waiting 4s for 2P Character Select screen...`);
        await new Promise(r => setTimeout(r, 4000));

        const pathHost2P = path.join(ARTIFACT_DIR, 'guest_nav_2p_host.png');
        const pathGuest2P = path.join(ARTIFACT_DIR, 'guest_nav_2p_guest.png');
        await hostPage.screenshot({ path: pathHost2P });
        await guestPage.screenshot({ path: pathGuest2P });
        console.log(`📸 Screenshots saved: [guest_nav_2p_host.png], [guest_nav_2p_guest.png]`);

        console.log(`\n================================================================`);
        console.log(`🎉 TEST COMPLETE! Inspecting screenshots...`);
        console.log(`================================================================\n`);

    } catch (e) {
        console.error(`❌ Test Error:`, e);
    } finally {
        if (hostBrowser) await hostBrowser.close();
        if (guestBrowser) await guestBrowser.close();
        server.close();
    }
});
