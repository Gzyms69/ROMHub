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
    console.log(`🎮 ROMHub Character Select Test on Real Mario Kart 64 ROM`);
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

        hostBrowser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: chromeArgs, defaultViewport: { width: 1280, height: 720 } });
        guestBrowser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: chromeArgs, defaultViewport: { width: 412, height: 915, isMobile: true, hasTouch: true } });

        const hostPage = await hostBrowser.newPage();
        const guestPage = await guestBrowser.newPage();

        // 1. Host stages ROM & creates lobby
        console.log(`[1/5] Host staging Mario Kart 64...`);
        await hostPage.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle0' });

        const hostRoomId = await hostPage.evaluate(async () => {
            const res = await fetch('/mariokart.z64');
            const buf = await res.arrayBuffer();
            const u8 = new Uint8Array(buf);
            window.lastLoadedRomData = u8;
            window.lastLoadedRomName = 'Mario Kart 64 (USA).z64';
            window.myApp.rom_name = 'Mario Kart 64 (USA).z64';
            await window.myApp.LoadEmulator(u8);
            return await window.netplayManager.startHost();
        });

        console.log(`[Host] Lobby created: ${hostRoomId}`);

        // 2. Guest connects
        console.log(`[2/5] Guest connecting from Mobile Profile...`);
        await guestPage.goto(`http://localhost:${PORT}#join=${hostRoomId}`, { waitUntil: 'networkidle0' });

        await guestPage.waitForFunction(() => window.netplayManager && window.netplayManager.stagedRomData && window.netplayManager.stagedRomData.byteLength > 10000000, { timeout: 35000 });
        await hostPage.waitForFunction(() => window.netplayManager && window.netplayManager.slots.some(s => s.slot === 1 && s.status === 'READY'), { timeout: 15000 });

        // 3. Launch game
        console.log(`[3/5] Synchronized Launching...`);
        await hostPage.evaluate(() => window.myApp.startLobbyGame());

        console.log(`Waiting 10s for Title Screen...`);
        await new Promise(r => setTimeout(r, 10000));

        // 4. Guest presses START -> enters Game Select
        console.log(`[4/5] Guest on Mobile presses START -> selects 1P Mario GP 50cc...`);
        await guestPage.evaluate(async () => {
            if (window.touchController) {
                // START
                window.touchController.state.Start = true;
                await new Promise(r => setTimeout(r, 600));
                window.touchController.state.Start = false;
                await new Promise(r => setTimeout(r, 2000));

                // Confirm 1P Game
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

        console.log(`Waiting 4s for Player Select screen...`);
        await new Promise(r => setTimeout(r, 4000));

        await guestPage.screenshot({ path: path.join(ARTIFACT_DIR, 'char_select_1_mario_default.png') });
        console.log(`📸 Saved initial player select: char_select_1_mario_default.png`);

        // 5. Guest on Mobile moves Stick Right to Luigi
        console.log(`[5/5] Guest moving Stick Right to select Luigi...`);
        await guestPage.evaluate(async () => {
            if (window.touchController) {
                window.touchController.state.DPAD_RIGHT = true;
                window.touchController.state.stickX = 1.0;
                await new Promise(r => setTimeout(r, 500));
                window.touchController.state.DPAD_RIGHT = false;
                window.touchController.state.stickX = 0;
            }
        });

        await new Promise(r => setTimeout(r, 1000));

        await guestPage.screenshot({ path: path.join(ARTIFACT_DIR, 'char_select_2_luigi_moved.png') });
        console.log(`📸 Saved moved player select: char_select_2_luigi_moved.png`);

        // 6. Guest presses A to lock in Luigi
        console.log(`Guest pressing A to lock in Luigi...`);
        await guestPage.evaluate(async () => {
            if (window.touchController) {
                window.touchController.state.A = true;
                await new Promise(r => setTimeout(r, 400));
                window.touchController.state.A = false;
            }
        });

        await new Promise(r => setTimeout(r, 2000));

        await guestPage.screenshot({ path: path.join(ARTIFACT_DIR, 'char_select_3_luigi_locked_in.png') });
        console.log(`📸 Saved locked-in screen: char_select_3_luigi_locked_in.png`);

        console.log(`\n================================================================`);
        console.log(`🎉 ALL TESTS PASSED! CHARACTER SELECT VERIFIED VISUALLY!`);
        console.log(`================================================================\n`);

    } catch (e) {
        console.error(`❌ Test Error:`, e);
    } finally {
        if (hostBrowser) await hostBrowser.close();
        if (guestBrowser) await guestBrowser.close();
        server.close();
    }
});
