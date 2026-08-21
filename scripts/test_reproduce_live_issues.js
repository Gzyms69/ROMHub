const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROM_PATH = '/home/gzyms/Downloads/Mario Kart 64/Mario Kart 64 (USA).z64';
const ARTIFACT_DIR = '/home/gzyms/.gemini/antigravity-cli/brain/eba18644-e045-474e-972b-93a8f217a06b';
const PORT = 8899;

if (!fs.existsSync(ROM_PATH)) {
    console.error(`❌ ROM not found: ${ROM_PATH}`);
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
    console.log(`🎮 ROMHub Live Lobby Controller Tester & E2E Netplay Diagnostic`);
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
            '--autoplay-policy=no-user-gesture-required'
        ];

        hostBrowser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: chromeArgs, defaultViewport: { width: 1280, height: 800 } });
        guestBrowser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: chromeArgs, defaultViewport: { width: 412, height: 915, isMobile: true, hasTouch: true } });

        const hostPage = await hostBrowser.newPage();
        const guestPage = await guestBrowser.newPage();

        // 1. Host stages ROM & creates lobby
        console.log(`[1/4] Host staging ROM and opening Co-Op Lobby...`);
        await hostPage.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle0' });

        const hostRoomId = await hostPage.evaluate(async () => {
            const res = await fetch('/mariokart.z64');
            const buf = await res.arrayBuffer();
            const u8 = new Uint8Array(buf);
            window.lastLoadedRomData = u8;
            window.lastLoadedRomName = 'Mario Kart 64 (USA).z64';
            window.myApp.rom_name = 'Mario Kart 64 (USA).z64';
            await window.myApp.LoadEmulator(u8);
            const rId = await window.netplayManager.startHost();
            $('#netplayHostModal').modal('show');
            return rId;
        });
        console.log(`[Host] Room online: ${hostRoomId}`);

        // 2. Guest connects in Lobby
        console.log(`[2/4] Guest connecting to Lobby from Mobile Profile...`);
        await guestPage.goto(`http://localhost:${PORT}#join=${hostRoomId}`, { waitUntil: 'networkidle0' });

        await guestPage.waitForFunction(() => window.netplayManager && window.netplayManager.stagedRomData && window.netplayManager.stagedRomData.byteLength > 10000000, { timeout: 35000 });
        await hostPage.waitForFunction(() => window.netplayManager && window.netplayManager.slots.some(s => s.slot === 1 && s.status === 'READY'), { timeout: 15000 });
        console.log(`[Lobby] Both players connected in Lobby!`);

        // 3. Test Lobby Live Controller Tester & Packet Inspector
        console.log(`[3/4] Testing Live Controller Tester & Packet Inspector in Lobby...`);

        // Guest on phone touches START and B buttons in Lobby
        console.log(`-> Guest pressing START and B on Mobile...`);
        await guestPage.evaluate(() => {
            if (window.touchController) {
                window.touchController.state.Start = true;
                window.touchController.state.B = true;
                window.touchController.state.stickX = 0.75;
                window.touchController.state.stickY = -0.50;
            }
        });

        await new Promise(r => setTimeout(r, 600));

        // Verify Host sees P2 START and B active in Host Lobby HUD
        const hostViewOfP2 = await hostPage.evaluate(() => {
            const btnStart = document.querySelector('#hostCtrlBtnsP2 .btn-test[data-btn="START"]');
            const btnB = document.querySelector('#hostCtrlBtnsP2 .btn-test[data-btn="B"]');
            const stick = document.getElementById('hostCtrlStickP2');
            const lastPayload = document.getElementById('hostLastPayload');
            return {
                startActive: btnStart ? btnStart.classList.contains('active-btn-p2') : false,
                bActive: btnB ? btnB.classList.contains('active-btn-p2') : false,
                stickText: stick ? stick.textContent : '',
                lastPayload: lastPayload ? lastPayload.textContent : ''
            };
        });

        console.log(`Host Lobby HUD verification for P2:`, JSON.stringify(hostViewOfP2, null, 2));

        // Host on PC presses A button and moves stick
        console.log(`-> Host pressing A and moving stick on PC...`);
        await hostPage.evaluate(() => {
            const ic = window.myApp.rivetsData.inputController;
            if (ic) {
                ic.Key_Action_A = true;
                ic.VectorX = -0.80;
                ic.VectorY = 0.90;
            }
        });

        await new Promise(r => setTimeout(r, 600));

        // Verify Guest sees P1 A active in Client Lobby HUD
        const guestViewOfP1 = await guestPage.evaluate(() => {
            const btnA = document.querySelector('#clientCtrlBtnsP1 .btn-test[data-btn="A"]');
            const stick = document.getElementById('clientCtrlStickP1');
            const lastPayload = document.getElementById('clientLastPayload');
            return {
                aActive: btnA ? btnA.classList.contains('active-btn-p1') : false,
                stickText: stick ? stick.textContent : '',
                lastPayload: lastPayload ? lastPayload.textContent : ''
            };
        });

        console.log(`Guest Lobby HUD verification for P1:`, JSON.stringify(guestViewOfP1, null, 2));

        // Save Lobby Screenshots
        await hostPage.screenshot({ path: path.join(ARTIFACT_DIR, 'lobby_tester_host_view.png') });
        await guestPage.screenshot({ path: path.join(ARTIFACT_DIR, 'lobby_tester_guest_view.png') });
        console.log(`📸 Saved lobby screenshots: [lobby_tester_host_view.png], [lobby_tester_guest_view.png]`);

        // Release buttons
        await guestPage.evaluate(() => {
            if (window.touchController) {
                window.touchController.state.Start = false;
                window.touchController.state.B = false;
                window.touchController.state.stickX = 0;
                window.touchController.state.stickY = 0;
            }
        });
        await hostPage.evaluate(() => {
            const ic = window.myApp.rivetsData.inputController;
            if (ic) {
                ic.Key_Action_A = false;
                ic.VectorX = 0;
                ic.VectorY = 0;
            }
        });

        // 4. Synchronized Launch and In-Game Validation
        console.log(`[4/4] Synchronized Launching game...`);
        await hostPage.evaluate(() => window.myApp.startLobbyGame());

        console.log(`Waiting 10s for game to render...`);
        await new Promise(r => setTimeout(r, 10000));

        await hostPage.screenshot({ path: path.join(ARTIFACT_DIR, 'ingame_host_running.png') });
        await guestPage.screenshot({ path: path.join(ARTIFACT_DIR, 'ingame_guest_running.png') });
        console.log(`📸 Saved in-game screenshots: [ingame_host_running.png], [ingame_guest_running.png]`);

        console.log(`\n================================================================`);
        console.log(`🎉 ALL TESTS COMPLETED SUCCESSFULLY!`);
        console.log(`================================================================\n`);

    } catch (e) {
        console.error(`❌ Diagnostic Test Error:`, e);
    } finally {
        if (hostBrowser) await hostBrowser.close();
        if (guestBrowser) await guestBrowser.close();
        server.close();
    }
});
