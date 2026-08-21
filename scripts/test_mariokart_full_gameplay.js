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
    console.log(`🎮 ROMHub 2-Player Mario Kart 64 Real Character Select Test`);
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

        // 1. Load Host
        console.log(`[1/6] Loading Host and staging Mario Kart 64...`);
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

        // 2. Load Guest
        console.log(`[2/6] Connecting Guest (Mobile Touch Profile)...`);
        await guestPage.goto(`http://localhost:${PORT}#join=${hostRoomId}`, { waitUntil: 'networkidle0' });

        // Wait for ROM transfer and staging
        await guestPage.waitForFunction(() => {
            return window.netplayManager && window.netplayManager.stagedRomData && window.netplayManager.stagedRomData.byteLength > 10000000;
        }, { timeout: 35000 });
        console.log(`[Guest] ROM transferred and verified.`);

        // Wait for Host to acknowledge Guest as READY
        await hostPage.waitForFunction(() => {
            return window.netplayManager && window.netplayManager.slots.some(s => s.slot === 1 && s.status === 'READY');
        }, { timeout: 15000 });

        // 3. Host clicks START GAME
        console.log(`[3/6] Host launching synchronized game...`);
        await hostPage.evaluate(() => {
            window.myApp.startLobbyGame();
        });

        // Wait 10s for Title Screen to appear on both
        console.log(`[4/6] Waiting 10s for Title Screen (<PUSH START BUTTON>)...`);
        await new Promise(r => setTimeout(r, 10000));

        await hostPage.screenshot({ path: path.join(ARTIFACT_DIR, '2p_step1_host_title.png') });
        await guestPage.screenshot({ path: path.join(ARTIFACT_DIR, '2p_step1_guest_title.png') });

        // 4. Host presses START on Player 1 to enter Game Select menu
        console.log(`[5/6] Host pressing START to enter Menu, selecting 2P GAME...`);
        await hostPage.evaluate(async () => {
            const ic = window.myApp.rivetsData.inputController;
            // Press START
            ic.Key_Action_Start = true;
            await new Promise(r => setTimeout(r, 600));
            ic.Key_Action_Start = false;
            await new Promise(r => setTimeout(r, 2000));

            // Select 2P GAME (Down arrow)
            ic.Key_Down = true;
            await new Promise(r => setTimeout(r, 400));
            ic.Key_Down = false;
            await new Promise(r => setTimeout(r, 600));

            // Press A to confirm 2P GAME
            ic.Key_Action_A = true;
            await new Promise(r => setTimeout(r, 400));
            ic.Key_Action_A = false;
            await new Promise(r => setTimeout(r, 2000));

            // Press A to confirm MARIO GP
            ic.Key_Action_A = true;
            await new Promise(r => setTimeout(r, 400));
            ic.Key_Action_A = false;
            await new Promise(r => setTimeout(r, 2000));

            // Press A to confirm 50cc
            ic.Key_Action_A = true;
            await new Promise(r => setTimeout(r, 400));
            ic.Key_Action_A = false;
        });

        console.log(`Waiting 5s for Character Select Screen to render...`);
        await new Promise(r => setTimeout(r, 5000));

        await hostPage.screenshot({ path: path.join(ARTIFACT_DIR, '2p_step2_host_charselect_before.png') });
        await guestPage.screenshot({ path: path.join(ARTIFACT_DIR, '2p_step2_guest_charselect_before.png') });

        // 5. Guest on Phone moves Player 2 cursor to Peach (Right arrow + A)
        console.log(`[6/6] Guest on Mobile pressing DPAD_RIGHT and A on Player 2...`);
        await guestPage.evaluate(async () => {
            if (window.touchController) {
                // Move stick right
                window.touchController.state.stickX = 1.0;
                window.touchController.state.DPAD_RIGHT = true;
                await new Promise(r => setTimeout(r, 800));
                window.touchController.state.stickX = 0;
                window.touchController.state.DPAD_RIGHT = false;
                await new Promise(r => setTimeout(r, 500));

                // Press A to select character
                window.touchController.state.A = true;
                await new Promise(r => setTimeout(r, 600));
                window.touchController.state.A = false;
            }
        });

        await new Promise(r => setTimeout(r, 3000));

        await hostPage.screenshot({ path: path.join(ARTIFACT_DIR, '2p_step3_host_after_p2_input.png') });
        await guestPage.screenshot({ path: path.join(ARTIFACT_DIR, '2p_step3_guest_after_p2_input.png') });

        console.log(`\n================================================================`);
        console.log(`📸 Saved all screenshots for inspection!`);
        console.log(`================================================================\n`);

    } catch (e) {
        console.error(`❌ Test Error:`, e);
    } finally {
        if (hostBrowser) await hostBrowser.close();
        if (guestBrowser) await guestBrowser.close();
        server.close();
    }
});
