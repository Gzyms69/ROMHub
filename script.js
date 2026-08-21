// Suppress harmless WebGL spam from ParaLLEl-RDP
const originalConsoleError = console.error;
console.error = function(...args) {
  if (typeof args[0] === 'string' && 
      (args[0].includes('WebGL:') || args[0].includes('texParameter:'))) {
    return; // Suppress WebGL spam
  }
  originalConsoleError.apply(console, args);
};

var AUDIOBUFFSIZE = 1024;

class MyClass {
    constructor() {
        this.rom_name = '';
        this.mobileMode = false;
        this.iosMode = false;
        this.iosVersion = 0;
        this.audioInited = false;
        this.allSaveStates = [];
        this.loginModalOpened = false;
        this.loadSavestateAfterBoot = false;
        this.canvasSize = 640;
        this.eepData = null;
        this.sraData = null;
        this.flaData = null;
        this.dblist = [];
        var Module = {};
        Module['canvas'] = document.getElementById('canvas');
        window['Module'] = Module;
        document.getElementById('file-upload').addEventListener('change', this.uploadRom.bind(this));
        document.getElementById('file-upload-eep').addEventListener('change', this.uploadEep.bind(this));
        document.getElementById('file-upload-sra').addEventListener('change', this.uploadSra.bind(this));
        document.getElementById('file-upload-fla').addEventListener('change', this.uploadFla.bind(this));


        this.rivetsData = {
            message: '',
            beforeEmulatorStarted: true,
            moduleInitializing: true,
            showLogin: false,
            currentFPS: 0,
            audioSkipCount: 0,
            n64SaveStates: [],
            loggedIn: false,
            noCloudSave: true,
            password: '',
            inputController: null,
            remappings: null,
            remapMode: '',
            currKey: 0,
            currJoy: 0,
            chkUseJoypad: false,
            remappingPlayer1: false,
            hasRoms: false,
            romList: [],
            inputLoopStarted: false,
            noLocalSave: true,
            lblError: '',
            chkAdvanced: false,
            doubleSpeed: false,
            showDoubleSpeed: false,
            eepName: '',
            sraName: '',
            flaName: '',
            swapSticks: false,
            mouseMode: false,
            useZasCMobile: false,
            showFPS: true,
            invert2P: false,
            invert3P: false,
            invert4P: false,
            disableAudioSync: true,
            hadNipple: false,
            hadFullscreen: false,
            forceAngry: false,
            ricePlugin: false,
            useVBO: false,
            darkMode: getSystemDarkMode(),
            remapPlayer1: true,
            remapOptions: false,
            remapGameshark: false,
            settingMobile: 'Auto',
            iosShowWarning: false,
            cheatName: '',
            cheatAddress: '',
            cheatValue: '',
            cheats: [],
            settings: {
                CLOUDSAVEURL: "",
                SHOWADVANCED: false,
                SHOWOPTIONS: false
            }
        };

        //comes from settings.js
        this.rivetsData.settings = window["N64WASMSETTINGS"];

        if (window["ROMLIST"] && window["ROMLIST"].length > 0)
        {
            this.rivetsData.hasRoms = true;
            window["ROMLIST"].forEach(rom => {
                this.rivetsData.romList.push(rom);
            });
        }

        rivets.formatters.ev = function (value, arg) {
            return eval(value + arg);
        }
        rivets.formatters.ev_string = function (value, arg) {
            let eval_string = "'" + value + "'" + arg;
            return eval(eval_string);
        }

        const bindIfExists = (id) => { const el = document.getElementById(id); if (el) rivets.bind(el, { data: this.rivetsData }); };
bindIfExists('topPanel');
bindIfExists('buttonsModal');
bindIfExists('lblError');
bindIfExists('mobileMenuModal');
        
        this.setupDragDropRom();
        this.detectMobile();
        this.createDB();
        this.retrieveSettings();

        $('#topPanel').show();
        $('#lblErrorOuter').show();
        
    }

    setupInputController(){
        this.rivetsData.inputController = new InputController();
        
        try {
            let keymappings = localStorage.getItem('n64wasm_mappings_v3');
            if (keymappings) {
                let keymappings_object = JSON.parse(keymappings);

                for (let [key, value] of Object.entries(keymappings_object)) {
                    if (key in this.rivetsData.inputController.KeyMappings){
                        this.rivetsData.inputController.KeyMappings[key] = value;
                    }
                }
            }
        } catch (error) { } //
        
    }

    inputLoop(){
        myClass.rivetsData.inputController.update();
        if (myClass.rivetsData.beforeEmulatorStarted)
        {
            setTimeout(() => {
                myClass.inputLoop();
            }, 100);
        }
    }


    processPrintStatement(text) {
        console.log(text);

        if (text.includes('mupen64plus: Starting R4300 emulator: Cached Interpreter')) {
            console.log('detected emulator started');
            this.afterRun();
        }

        if (text.includes('writing game.savememory')){
            setTimeout(() => {
                myClass.SaveSram();
            }, 100);
        }
    }

    detectMobile(){
        let isIphone = navigator.userAgent.toLocaleLowerCase().includes('iphone');
        let isIpad = navigator.userAgent.toLocaleLowerCase().includes('ipad');
        if (isIphone || isIpad)
        {
            this.iosMode = true;
            try {
                let iosVersion = navigator.userAgent.substring(navigator.userAgent.indexOf("iPhone OS ") + 10);
                iosVersion = iosVersion.substring(0, iosVersion.indexOf(' '));
                iosVersion = iosVersion.substring(0, iosVersion.indexOf('_'));
                this.iosVersion = parseInt(iosVersion);
            } catch (err) { } //
        }
        if (window.innerWidth < 600 || isIphone)
            this.mobileMode = true;
        else
            this.mobileMode = false;
    }

    toggleDoubleSpeed(){
        if (this.rivetsData.doubleSpeed)
        {
            this.rivetsData.doubleSpeed = false;
            this.setDoubleSpeed(0)
        }
        else
        {
            this.rivetsData.doubleSpeed = true;
            this.setDoubleSpeed(1)
        }
    }

    async LoadEmulator(byteArray){
        if (this.rom_name.toLocaleLowerCase().endsWith('.zip'))
        {
            this.rivetsData.lblError = 'Zip format not supported. Please uncompress first.'
            this.rivetsData.beforeEmulatorStarted = false;
        }
        else
        {
            window.lastLoadedRomData = byteArray;
            window.lastLoadedRomName = this.rom_name || 'custom.v64';
            await this.writeAssets();
            FS.writeFile('custom.v64',byteArray);
            this.beforeRun();
            this.WriteConfigFile();
            this.initAudio();
            await this.LoadSram();

            // Ensure canvas is set
            if (!Module.canvas) {
                Module.canvas = document.getElementById('canvas');
            }

            // Pre-notify SDL2 of controllers
            if (window.netplayManager) {
                window.netplayManager.notifyGamepadConnected(0);
                window.netplayManager.notifyGamepadConnected(1);
            }

            Module.callMain(['custom.v64']);
            this.findInDatabase();
            this.configureEmulator();

            // Transition UI to Responsive GameStage with full toolbar
            $('#maindiv').show();
            $('#gameStage').show();
            this.rivetsData.beforeEmulatorStarted = false;
            this.resizeCanvas();

            // Initialize PPSSPP Touch Controls if touch device
            if (('ontouchstart' in window) || navigator.maxTouchPoints > 0) {
                if (window.touchController) {
                    window.touchController.init('touchOverlayContainer');
                    window.touchController.show();
                }
            }

            this.showToast = Module.cwrap('neil_toast_message', null, ['string']);
            this.toggleFPSModule = Module.cwrap('toggleFPS', null, ['number']);
            this.sendMobileControls = Module.cwrap('neil_send_mobile_controls', null, ['string','string','string']);
            this.setRemainingAudio = Module.cwrap('neil_set_buffer_remaining', null, ['number']);
            this.setDoubleSpeed = Module.cwrap('neil_set_double_speed', null, ['number']);
        }

    }

    async writeAssets(){
        let file = 'assets.zip';
        let responseText = await this.downloadFile(file);
        FS.writeFile(file, responseText);
    }

    async downloadFile(url) {
        return new Promise(function (resolve, reject) {
            var oReq = new XMLHttpRequest();
            oReq.open("GET", url, true);
            oReq.responseType = "arraybuffer";
            oReq.onload = function (oEvent) {
                var arrayBuffer = oReq.response;
                var byteArray = new Uint8Array(arrayBuffer);
                resolve(byteArray);
            };
            oReq.onerror = function(){
                reject({
                    status: oReq.status,
                    statusText: oReq.statusText
                });
            }
            oReq.send();
        });
    }

    async initAudio() {
        if (!this.audioInited)
        {
            this.audioInited = true;
            this.audioContext = new AudioContext({
                latencyHint: 'interactive',
                sampleRate: 44100,
            });
            this.gainNode = this.audioContext.createGain();
            this.gainNode.gain.value = 0.5;
            this.gainNode.connect(this.audioContext.destination);
    
            this.audioBufferResampled = new Int16Array(Module.HEAP16.buffer,Module._neilGetSoundBufferResampledAddress(),64000);
    
            this.audioWritePosition = 0;
            this.audioReadPosition = 0;
            this.audioBackOffCounter = 0;
            this.audioThreadLock = false;
    
            this.pcmPlayer = this.audioContext.createScriptProcessor(AUDIOBUFFSIZE, 2, 2);
            this.pcmPlayer.onaudioprocess = this.AudioProcessRecurring.bind(this);
            this.pcmPlayer.connect(this.gainNode);
        }
    }

    hasEnoughSamples(){
        let readPositionTemp = this.audioReadPosition;
        let enoughSamples = true;
        for (let sample = 0; sample < AUDIOBUFFSIZE; sample++)
        {
            if (this.audioWritePosition != readPositionTemp) {
                readPositionTemp += 2;
                if (readPositionTemp == 64000) {
                    readPositionTemp = 0;
                }
            }
            else {
                enoughSamples = false;
            }
        }
        return enoughSamples;
    }

    AudioProcessRecurring(audioProcessingEvent){
        if (this.audioThreadLock || this.rivetsData.beforeEmulatorStarted)
        {
            return;
        }
        this.audioThreadLock = true;

        let outputBuffer = audioProcessingEvent.outputBuffer;
        let outputData1 = outputBuffer.getChannelData(0);
        let outputData2 = outputBuffer.getChannelData(1);

        if (this.rivetsData.disableAudioSync)
        {
            this.audioWritePosition = Module._neilGetAudioWritePosition();
        }
        else
        {
            Module._runMainLoop();
            this.audioWritePosition = Module._neilGetAudioWritePosition();
            if (!this.hasEnoughSamples())
            {
                Module._runMainLoop();
            }
            this.audioWritePosition = Module._neilGetAudioWritePosition();
        }

        let hadSkip = false;
        for (let sample = 0; sample < AUDIOBUFFSIZE; sample++) {
            if (this.audioWritePosition != this.audioReadPosition) {
                outputData1[sample] = (this.audioBufferResampled[this.audioReadPosition] / 32768);
                outputData2[sample] = (this.audioBufferResampled[this.audioReadPosition + 1] / 32768);
                this.audioReadPosition += 2;
                if (this.audioReadPosition == 64000) {
                    this.audioReadPosition = 0;
                }
            }
            else {
                outputData1[sample] = 0;
                outputData2[sample] = 0;
                hadSkip = true;
            }
        }

        if (hadSkip)
            this.rivetsData.audioSkipCount++;

        let audioBufferRemaining = 0;
        let readPositionTemp = this.audioReadPosition;
        let writePositionTemp = this.audioWritePosition;
        for(let i = 0; i < 64000; i++)
        {
            if (readPositionTemp != writePositionTemp)
            {
                readPositionTemp += 2;
                audioBufferRemaining += 2;
                if (readPositionTemp == 64000) {
                    readPositionTemp = 0;
                }
            }
        }
        this.setRemainingAudio(audioBufferRemaining);
        this.audioThreadLock = false;
    }

    beforeRun(){}
    afterRun(){}

    WriteConfigFile()
    {
        let configString = "";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Up + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Down + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Left + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Right + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Action_A + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Action_B + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Action_Start + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Action_Z + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Action_L + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Action_R + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Menu + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Action_CLEFT + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Action_CRIGHT + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Action_CUP + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Joy_Mapping_Action_CDOWN + "\r\n";

        configString += this.rivetsData.inputController.KeyMappings.Mapping_Left + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Right + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Up + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Down + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Action_Start + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Action_CUP + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Action_CDOWN + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Action_CLEFT + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Action_CRIGHT + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Action_Z + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Action_L + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Action_R + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Action_B + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Action_A + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Menu + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Action_Analog_Up + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Action_Analog_Down + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Action_Analog_Left + "\r\n";
        configString += this.rivetsData.inputController.KeyMappings.Mapping_Action_Analog_Right + "\r\n";

        if (this.eepData == null) configString += "0" + "\r\n"; else configString += "1" + "\r\n";
        if (this.sraData == null) configString += "0" + "\r\n"; else configString += "1" + "\r\n";
        if (this.flaData == null) configString += "0" + "\r\n"; else configString += "1" + "\r\n";

        if (this.rivetsData.showFPS) configString += "1" + "\r\n"; else configString += "0" + "\r\n";
        if (this.rivetsData.swapSticks) configString += "1" + "\r\n"; else configString += "0" + "\r\n";
        if (this.rivetsData.disableAudioSync) configString += "1" + "\r\n"; else configString += "0" + "\r\n";
        if (this.rivetsData.invert2P) configString += "1" + "\r\n"; else configString += "0" + "\r\n";
        if (this.rivetsData.invert3P) configString += "1" + "\r\n"; else configString += "0" + "\r\n";
        if (this.rivetsData.invert4P) configString += "1" + "\r\n"; else configString += "0" + "\r\n";

        if (this.rivetsData.settingMobile == 'ForceMobile') this.mobileMode = true;
        if (this.rivetsData.settingMobile == 'ForceDesktop') this.mobileMode = false;
        
        const isNetplay = window.netplayManager && (window.netplayManager.isHost || window.netplayManager.isClient);
        if (isNetplay) {
            configString += "0" + "\r\n"; // Standard Gamepad Mode for SDL2 Multi-Controller Netplay
        } else if (this.mobileMode) {
            configString += "1" + "\r\n";
        } else {
            configString += "0" + "\r\n";
        }
        if (this.rivetsData.forceAngry) configString += "1" + "\r\n"; else configString += "0" + "\r\n";
        if (this.rivetsData.mouseMode) configString += "1" + "\r\n"; else configString += "0" + "\r\n";
        if (this.iosMode || this.rivetsData.useVBO) configString += "1" + "\r\n"; else configString += "0" + "\r\n";
        if (this.rivetsData.ricePlugin) configString += "1" + "\r\n"; else configString += "0" + "\r\n";

        FS.writeFile('config.txt',configString);

        let cheatString = '';
        this.rivetsData.cheats.forEach(cheat => {
            if (cheat.active)
            {
                cheatString += cheat.address + "\r\n" + cheat.value + "\r\n";
            }
        });
        FS.writeFile('cheat.txt',cheatString);

        if (!this.rivetsData.disableAudioSync)
        {
            this.rivetsData.showDoubleSpeed = false;
        }
    }

    uploadBrowse() {
        this.initAudio();
        document.getElementById('file-upload').click();
    }

    uploadEepBrowse() { document.getElementById('file-upload-eep').click(); }
    uploadSraBrowse() { document.getElementById('file-upload-sra').click(); }
    uploadFlaBrowse() { document.getElementById('file-upload-fla').click(); }

    uploadEep(event) {
        var file = event.currentTarget.files[0];
        myClass.rivetsData.eepName = 'File Ready';
        var reader = new FileReader();
        reader.onload = function (e) {
            var byteArray = new Uint8Array(this.result);
            myClass.eepData = byteArray;
            FS.writeFile("game.eep", byteArray);
        }
        reader.readAsArrayBuffer(file);
    }
    uploadSra(event) {
        var file = event.currentTarget.files[0];
        myClass.rivetsData.sraName = 'File Ready';
        var reader = new FileReader();
        reader.onload = function (e) {
            var byteArray = new Uint8Array(this.result);
            myClass.sraData = byteArray;
            FS.writeFile("game.sra", byteArray);
        }
        reader.readAsArrayBuffer(file);
    }
    uploadFla(event) {
        var file = event.currentTarget.files[0];
        myClass.rivetsData.flaName = 'File Ready';
        var reader = new FileReader();
        reader.onload = function (e) {
            var byteArray = new Uint8Array(this.result);
            myClass.flaData = byteArray;
            FS.writeFile("game.fla", byteArray);
        }
        reader.readAsArrayBuffer(file);
    }

    uploadRom(event) {
        var file = event.currentTarget.files[0];
        myClass.rom_name = file.name;
        var reader = new FileReader();
        reader.onload = function (e) {
            var byteArray = new Uint8Array(this.result);
            myClass.LoadEmulator(byteArray);
        }
        reader.readAsArrayBuffer(file);
    }

    resizeCanvas() { $('#canvas').width(this.canvasSize); }
    zoomOut() { this.canvasSize -= 50; localStorage.setItem('n64wasm-size', this.canvasSize.toString()); this.resizeCanvas(); }
    zoomIn() { this.canvasSize += 50; localStorage.setItem('n64wasm-size', this.canvasSize.toString()); this.resizeCanvas(); }

    async initModule(){
        console.log('ROMHub: Module initialized successfully');
        myClass.rivetsData.moduleInitializing = false;
        // Verification Logging for ROMHub
        console.log("ROMHub: FS available?", typeof FS !== 'undefined');
    }

    setupDragDropRom(){
        let dropArea = document.getElementById('dropArea');
        if (!dropArea) return;
        dropArea.addEventListener('dragenter', this.preventDefaults, false);
        dropArea.addEventListener('dragover', this.preventDefaults, false);
        dropArea.addEventListener('dragleave', this.preventDefaults, false);
        dropArea.addEventListener('drop', this.preventDefaults, false);
        dropArea.addEventListener('dragenter', this.dragDropHighlight, false);
        dropArea.addEventListener('dragover', this.dragDropHighlight, false);
        dropArea.addEventListener('dragleave', this.dragDropUnHighlight, false);
        dropArea.addEventListener('drop', this.dragDropUnHighlight, false);
        dropArea.addEventListener('drop', this.handleDrop, false);
    }

    preventDefaults(e){ e.preventDefault(); e.stopPropagation(); }
    dragDropHighlight(e){ $('#dropArea').css({"background-color": "lightblue"}); }
    dragDropUnHighlight(e){ $('#dropArea').css({"background-color": "inherit"}); }

    handleDrop(e){
        let dt = e.dataTransfer;
        let files = dt.files;
        var file = files[0];
        myClass.rom_name = file.name;
        var reader = new FileReader();
        reader.onload = function (e) {
            var byteArray = new Uint8Array(this.result);
            myClass.LoadEmulator(byteArray);
        }
        reader.readAsArrayBuffer(file);

    }

    extractRomName(name){
        if (name.includes('/')) name = name.substr(name.lastIndexOf('/')+1);
        return name;
    }

    saveStateLocal(){
        console.log('saveStateLocal');
        this.rivetsData.noLocalSave = false;
        Module._neil_serialize();
    }

    loadStateLocal(){
        console.log('loadStateLocal');
        myClass.loadFromDatabase();
    }

    createDB() {
        if (window["indexedDB"]==undefined) return;
        var request = indexedDB.open('N64WASMDB');
        request.onupgradeneeded = function (ev) {
            let db = ev.target.result;
            db.createObjectStore('N64WASMSTATES', { autoIncrement: true });
        }
        request.onsuccess = function (ev) {
            var db = ev.target.result;
            var romStore = db.transaction("N64WASMSTATES", "readwrite").objectStore("N64WASMSTATES");
            romStore.openCursor().onsuccess = function (ev) {
                var cursor = ev.target.result;
                if (cursor) {
                    myClass.dblist.push(cursor.key.toString());
                    cursor.continue();
                }
            }
        }
    }

    findInDatabase() {
        if (window["indexedDB"]==undefined) return;
        var request = indexedDB.open('N64WASMDB');
        request.onsuccess = function (ev) {
            var db = ev.target.result;
            var romStore = db.transaction("N64WASMSTATES", "readwrite").objectStore("N64WASMSTATES");
            romStore.openCursor().onsuccess = function (ev) {
                var cursor = ev.target.result;
                if (cursor) {
                    if (myClass.rom_name == cursor.key.toString()) myClass.rivetsData.noLocalSave = false;
                    cursor.continue();
                }
            }
        }
    }

    async LoadSram() {
        return new Promise(function (resolve, reject) {
            var request = indexedDB.open('N64WASMDB');
            request.onsuccess = function (ev) {
                var db = ev.target.result;
                var romStore = db.transaction("N64WASMSTATES", "readwrite").objectStore("N64WASMSTATES");
                var rom = romStore.get(myClass.rom_name + '.sram');
                rom.onsuccess = function (event) {
                    if (rom.result) FS.writeFile('/game.savememory', rom.result);
                    resolve();
                };
                rom.onerror = function (event) { reject(); }
            }
            request.onerror = function (ev) { reject(); }
        });
    }

    SaveSram() {
        let data = FS.readFile('/game.savememory');
        var request = indexedDB.open('N64WASMDB');
        request.onsuccess = function (ev) {
            var db = ev.target.result;
            var romStore = db.transaction("N64WASMSTATES", "readwrite").objectStore("N64WASMSTATES");
            romStore.put(data, myClass.rom_name + '.sram');
        }
    }

    saveToDatabase(data) {
        if (window["indexedDB"]==undefined) return;
        var request = indexedDB.open('N64WASMDB');
        request.onsuccess = function (ev) {
            var db = ev.target.result;
            var romStore = db.transaction("N64WASMSTATES", "readwrite").objectStore("N64WASMSTATES");
            var addRequest = romStore.put(data, myClass.rom_name);
            addRequest.onsuccess = function (event) { toastr.info('State Saved'); };
        }
    }

    loadFromDatabase() {
        var request = indexedDB.open('N64WASMDB');
        request.onsuccess = function (ev) {
            var db = ev.target.result;
            var romStore = db.transaction("N64WASMSTATES", "readwrite").objectStore("N64WASMSTATES");
            var rom = romStore.get(myClass.rom_name);
            rom.onsuccess = function (event) {
                if (rom.result) {
                    FS.writeFile('/savestate.gz',rom.result);
                    Module._neil_unserialize();
                }
            };
        }
    }

    clearDatabase() { indexedDB.deleteDatabase('N64WASMDB'); }
    exportEep(){ Module._neil_export_eep(); }
    ExportEepEvent() { saveAs(new File([FS.readFile("/game.eep")], "game.eep", {type: "text/plain; charset=x-user-defined"})); }
    exportSra(){ Module._neil_export_sra(); }
    ExportSraEvent() { saveAs(new File([FS.readFile("/game.sra")], "game.sra", {type: "text/plain; charset=x-user-defined"})); }
    exportFla(){ Module._neil_export_fla(); }
    ExportFlaEvent() { saveAs(new File([FS.readFile("/game.fla")], "game.fla", {type: "text/plain; charset=x-user-defined"})); }

    SaveStateEvent() {
        this.hideMobileMenu();
        this.saveToDatabase(FS.readFile('/savestate.gz'));
    }

    fullscreen() {
        this.toggleFullscreen();
    }

    newRom(){ location.reload(); }

    configureEmulator(){
        let size = localStorage.getItem('n64wasm-size');
        if (size) this.canvasSize = parseInt(size);
        if (this.mobileMode) this.setupMobileMode();
        this.resizeCanvas();
        if (this.rivetsData.mouseMode)
            document.getElementById('canvasDiv').addEventListener("click", this.canvasClick.bind(this));
    }

    canvasClick(){ if (!document.pointerLockElement) this.captureMouse(); }
    captureMouse(){
        let canvas = document.getElementById('canvas');
        canvas.requestPointerLock = canvas.requestPointerLock || canvas.mozRequestPointerLock;
        canvas.requestPointerLock();
    }

    setupMobileMode() {
        this.canvasSize = window.innerWidth;
        $("#btnHideMenu").show();
        let halfWidth = (window.innerWidth / 2) - 35;
        document.getElementById("menuDiv").style.left = halfWidth + "px";
        this.rivetsData.inputController.setupMobileControls('divTouchSurface');
        $("#mobileDiv").show();
        $("#maindiv").hide();
        $("#middleDiv").hide();
        $('#canvas').appendTo("#mobileCanvas");
        document.getElementById('maindiv').classList.remove('container');
        document.getElementById('canvas').style.display = 'block';
        try { document.body.scrollTop = 0; document.documentElement.scrollTop = 0; } catch (error) { } //
    }

    hideMobileMenu() { if (this.mobileMode) { $("#mobileButtons").hide(); $('#menuDiv').show(); } }

    setFromLocalStorage(localStorageName, rivetsName){
        let val = localStorage.getItem(localStorageName);
        if (val) {
            if (val=="true") this.rivetsData[rivetsName] = true;
            else if (val=="false") this.rivetsData[rivetsName] = false;
            else this.rivetsData[rivetsName] = val;
        }
    }

    setToLocalStorage(localStorageName, rivetsName){
        let val = this.rivetsData[rivetsName];
        if (typeof(val) == 'boolean') localStorage.setItem(localStorageName, val ? 'true' : 'false');
        else localStorage.setItem(localStorageName, val);
    }

    retrieveSettings(){
        this.loadCheats();
        let settings = ['showFPS', 'disableAudioSync', 'swapSticks', 'invert2P', 'settingMobile', 'mouseMode', 'forceAngry', 'ricePlugin', 'useVBO', 'darkMode'];
        settings.forEach(s => this.setFromLocalStorage('n64wasm-' + s.toLowerCase(), s));
    }

    saveOptions(){
        let d = this.rivetsData;
        d.showFPS = d.showFPSTemp; d.swapSticks = d.swapSticksTemp; d.mouseMode = d.mouseModeTemp;
        d.invert2P = d.invert2PTemp; d.disableAudioSync = d.disableAudioSyncTemp; d.settingMobile = d.settingMobileTemp;
        d.forceAngry = d.pluginTemp == 'angry'; d.ricePlugin = d.pluginTemp == 'rice'; d.useVBO = d.useVBOTemp; d.darkMode = d.darkModeTemp;
        let settings = ['showFPS', 'disableAudioSync', 'swapSticks', 'mouseMode', 'invert2P', 'settingMobile', 'forceAngry', 'ricePlugin', 'useVBO', 'darkMode'];
        settings.forEach(s => this.setToLocalStorage('n64wasm-' + s.toLowerCase(), s));
    }

    showRemapModal() {
        let d = this.rivetsData;
        d.remapPlayer1 = true; d.remapOptions = false; d.remapGameshark = false;
        d.showFPSTemp = d.showFPS; d.swapSticksTemp = d.swapSticks; d.mouseModeTemp = d.mouseMode;
        d.invert2PTemp = d.invert2P; d.disableAudioSyncTemp = d.disableAudioSync; d.settingMobileTemp = d.settingMobile;
        d.pluginTemp = 'glide'; if (d.forceAngry) d.pluginTemp = 'angry'; if (d.ricePlugin) d.pluginTemp = 'rice';
        d.useVBOTemp = d.useVBO; d.darkModeTemp = d.darkMode;
        if (!d.inputLoopStarted) { d.inputLoopStarted = true; d.inputController.setupGamePad(); setTimeout(() => { myClass.inputLoop(); }, 100); }
        if (d.inputController.Gamepad_Process_Axis) d.chkUseJoypad = true;
        d.remappings = JSON.parse(JSON.stringify(d.inputController.KeyMappings));
        d.remapWait = false;
        $("#buttonsModal").modal();
    }

    addCheat(){
        this.rivetsData.cheats.push({ name: this.rivetsData.cheatName.trim(), address: this.rivetsData.cheatAddress.trim(), value: this.rivetsData.cheatValue.trim(), active: true });
        this.rivetsData.cheatName = ''; this.rivetsData.cheatAddress = ''; this.rivetsData.cheatValue = ''; this.saveCheats();
    }

    loadCheats(){
        try {
            let cheats = JSON.parse(localStorage.getItem('n64wasm-cheats'));
            cheats.forEach(c => { if (c.name && c.address && c.value) this.rivetsData.cheats.push(c); });
        } catch(err){}
    }

    saveCheats(){ localStorage.setItem('n64wasm-cheats',JSON.stringify(this.rivetsData.cheats)); }
    deleteCheat(cheat){ this.rivetsData.cheats = this.rivetsData.cheats.filter((a)=>{ return a.name != cheat.name; }); this.saveCheats(); }

    swapRemap(id){
        this.rivetsData.remapPlayer1 = id=='player1'; this.rivetsData.remapOptions = id=='options'; this.rivetsData.remapGameshark = id=='gameshark';
    }

    saveRemap() {
        this.rivetsData.inputController.Gamepad_Process_Axis = !!this.rivetsData.chkUseJoypad;
        this.rivetsData.inputController.KeyMappings = JSON.parse(JSON.stringify(this.rivetsData.remappings));
        this.rivetsData.inputController.setGamePadButtons();
        this.saveOptions();
        localStorage.setItem('n64wasm_mappings_v3', JSON.stringify(this.rivetsData.remappings));
        $("#buttonsModal").modal('hide');
    }

    btnRemapKey(keynum) { this.rivetsData.currKey = keynum; this.rivetsData.remapMode = 'Key'; this.readyRemap(); }
    btnRemapJoy(joynum) { this.rivetsData.currJoy = joynum; this.rivetsData.remapMode = 'Button'; this.readyRemap(); }
    readyRemap() { this.rivetsData.remapWait = true; this.rivetsData.inputController.Key_Last = ''; this.rivetsData.inputController.Joy_Last = null; this.rivetsData.inputController.Remap_Check = true; }

    restoreDefaultKeymappings(){
        this.rivetsData.remappings = this.rivetsData.inputController.defaultKeymappings();
        let d = this.rivetsData;
        d.showFPSTemp = true; d.swapSticksTemp = false; d.mouseModeTemp = false; d.invert2PTemp = false;
        d.disableAudioSyncTemp = true; d.settingMobileTemp = 'Auto'; d.pluginTemp = 'glide'; d.useVBOTemp = false; d.darkModeTemp = getSystemDarkMode();
    }

    remapPressed() {
        let d = this.rivetsData;
        if (d.remapMode == 'Key') {
            let k = d.inputController.Key_Last;
            let m = d.remappings;
            if (d.currKey == 1) m.Mapping_Up = k; if (d.currKey == 2) m.Mapping_Down = k; if (d.currKey == 3) m.Mapping_Left = k; if (d.currKey == 4) m.Mapping_Right = k;
            if (d.currKey == 5) m.Mapping_Action_A = k; if (d.currKey == 6) m.Mapping_Action_B = k; if (d.currKey == 8) m.Mapping_Action_Start = k; if (d.currKey == 9) m.Mapping_Menu = k;
            if (d.currKey == 10) m.Mapping_Action_Z = k; if (d.currKey == 11) m.Mapping_Action_L = k; if (d.currKey == 12) m.Mapping_Action_R = k;
            if (d.currKey == 13) m.Mapping_Action_CUP = k; if (d.currKey == 14) m.Mapping_Action_CDOWN = k; if (d.currKey == 15) m.Mapping_Action_CLEFT = k; if (d.currKey == 16) m.Mapping_Action_CRIGHT = k;
            if (d.currKey == 17) m.Mapping_Action_Analog_Up = k; if (d.currKey == 18) m.Mapping_Action_Analog_Down = k; if (d.currKey == 19) m.Mapping_Action_Analog_Left = k; if (d.currKey == 20) m.Mapping_Action_Analog_Right = k;
        }
        if (d.remapMode == 'Button') {
            let j = d.inputController.Joy_Last;
            let m = d.remappings;
            if (d.currJoy == 1) m.Joy_Mapping_Up = j; if (d.currJoy == 2) m.Joy_Mapping_Down = j; if (d.currJoy == 3) m.Joy_Mapping_Left = j; if (d.currJoy == 4) m.Joy_Mapping_Right = j;
            if (d.currJoy == 5) m.Joy_Mapping_Action_A = j; if (d.currJoy == 6) m.Joy_Mapping_Action_B = j; if (d.currJoy == 8) m.Joy_Mapping_Action_Start = j; if (d.currJoy == 9) m.Joy_Mapping_Menu = j;
            if (d.currJoy == 10) m.Joy_Mapping_Action_Z = j; if (d.currJoy == 11) m.Joy_Mapping_Action_L = j; if (d.currJoy == 12) m.Joy_Mapping_Action_R = j;
        }
        d.remapWait = false;
    }

    reset(){ Module._neil_reset(); }
    localCallback(){}
    listenForDarkModeCheckbox(){
        $(document).on("change", "input[name='darkmode']", function () {
            if (this.checked) document.documentElement.dataset.darkmode = true;
            else document.documentElement.removeAttribute("data-darkmode");
        });
    }

    // --- Netplay Multiplayer Integration ---
    async showNetplayHostModal() {
        if (this.rivetsData.beforeEmulatorStarted) {
            toastr.warning('Please load a ROM first before hosting a multiplayer session.');
            return;
        }
        $('#netplayHostModal').modal('show');
        try {
            const roomId = await window.netplayManager.startHost();
            $('#netplayRoomCodeInput').val(roomId);

            window.netplayManager.onLobbyUpdate = (lobbyState) => {
                this.renderHostLobby(lobbyState);
            };
            window.netplayManager.onTelemetryUpdate = (t) => {
                this.updateTelemetryUI(t);
            };
            window.netplayManager.onSynchronizedLaunch = (seconds, onReady) => {
                this.runSynchronizedCountdown(seconds, onReady);
            };

            this.renderHostLobby({
                roomId: roomId,
                slots: window.netplayManager.slots,
                eventLogs: window.netplayManager.eventLogs,
                isReadyToPlay: window.netplayManager.slots.some(s => s.slot > 0 && s.status === 'READY')
            });
        } catch (err) {
            console.error('Failed to start host:', err);
            toastr.error('Failed to initialize WebRTC Host: ' + (err.message || err));
        }
    }

    runSynchronizedCountdown(seconds, onComplete) {
        $('#netplayHostModal').modal('hide');
        $('#netplayClientView').hide();
        $('#syncCountdownOverlay').css('display', 'flex');

        let remaining = seconds;
        const countText = document.getElementById('syncCountdownText');
        if (countText) countText.textContent = remaining;

        const interval = setInterval(() => {
            remaining--;
            if (remaining > 0) {
                if (countText) countText.textContent = remaining;
            } else if (remaining === 0) {
                if (countText) countText.textContent = 'GO!';
            } else {
                clearInterval(interval);
                $('#syncCountdownOverlay').hide();
                $('#gameStage').show();
                $('#inGameNetplayBadge').show();
                $('#inGamePingBadge').show();

                if (typeof onComplete === 'function') onComplete();
                toastr.success('Multiplayer Session LIVE at 60 FPS!');
            }
        }, 1000);
    }

    renderHostLobby(lobby) {
        const container = $('#lobbySlotsContainer');
        container.empty();

        (lobby.slots || []).forEach(s => {
            let badgeHtml = '';
            let borderClass = 'border-secondary';
            if (s.status === 'READY') {
                badgeHtml = `<span class="badge badge-success px-2 py-1">🟢 READY (${s.ping || 0} ms)</span>`;
                borderClass = 'border-success';
            } else if (s.status === 'TRANSFERRING') {
                badgeHtml = `<span class="badge badge-info px-2 py-1">⚡ TRANSFERRING ROM...</span>`;
                borderClass = 'border-info';
            } else if (s.status === 'CONNECTING') {
                badgeHtml = `<span class="badge badge-warning px-2 py-1">🟡 CONNECTING (TURN)...</span>`;
                borderClass = 'border-warning';
            } else if (s.status === 'WAITING') {
                badgeHtml = `<span class="badge badge-secondary px-2 py-1">⏳ WAITING FOR PLAYER...</span>`;
            } else {
                badgeHtml = `<span class="badge badge-dark text-muted px-2 py-1">OPEN SLOT</span>`;
            }

            const col = `
            <div class="col-sm-6 mb-2">
                <div class="card bg-dark ${borderClass} text-white p-2">
                    <div class="d-flex justify-content-between align-items-center">
                        <div>
                            <strong>${s.slot === 0 ? '👑' : '🎮'} ${s.label}</strong>
                        </div>
                        <div>${badgeHtml}</div>
                    </div>
                </div>
            </div>`;
            container.append(col);
        });

        // Event Log
        const logBox = document.getElementById('lobbyEventLog');
        if (logBox && lobby.eventLogs) {
            logBox.textContent = lobby.eventLogs.join('\n');
            logBox.scrollTop = logBox.scrollHeight;
        }

        // Start Game Button
        const startBtn = document.getElementById('btnLobbyStartGame');
        if (startBtn) {
            if (lobby.isReadyToPlay) {
                startBtn.className = 'btn btn-success btn-lg px-4 font-weight-bold';
                startBtn.innerHTML = '▶ START / RESUME GAME (Ready!)';
                startBtn.disabled = false;
            } else {
                startBtn.className = 'btn btn-primary btn-lg px-4 font-weight-bold';
                startBtn.innerHTML = '▶ START GAME (Waiting for players...)';
            }
        }
    }

    setNetplayMode(mode) {
        window.netplayManager.setMode(mode);
        if (mode === 'ROM_SYNC') {
            $('#currentModeBadge').removeClass('badge-info').addClass('badge-success').text('⚡ Local WebGL (ROM & Input Sync)');
            $('#netplayModeDesc').text('Host transfers ROM to Guest in 1-2s over DataChannel. Both run native 60 FPS WebGL emulator with 0ms lag!');
            $('#lblModeRomSync').addClass('active');
            $('#lblModeStream').removeClass('active');
        } else {
            $('#currentModeBadge').removeClass('badge-success').addClass('badge-info').text('📺 Remote Video Stream');
            $('#netplayModeDesc').text('Host streams video/audio from active canvas. Guest only needs a browser without downloading ROM.');
            $('#lblModeStream').addClass('active');
            $('#lblModeRomSync').removeClass('active');
        }
    }

    startLobbyGame() {
        window.netplayManager.startSynchronizedLaunch();
    }

    showNetplayJoinModal() {
        $('#netplayJoinModal').modal('show');
    }

    copyNetplayLink() {
        const roomId = window.netplayManager.roomId;
        if (!roomId) return;
        const url = window.location.origin + window.location.pathname + '#join=' + roomId;
        navigator.clipboard.writeText(url).then(() => {
            toastr.info('Invite link copied to clipboard!');
        }).catch(() => {
            toastr.info('Room Code: ' + roomId);
        });
    }

    async connectNetplay(customCode) {
        const code = (customCode || $('#netplayJoinCodeInput').val() || '').trim();
        if (!code) {
            toastr.error('Please enter a valid Room Code.');
            return;
        }
        $('#netplayJoinModal').modal('hide');

        // Hide main setup UI, Show Guest Lobby
        $('#maindiv').hide();
        $('#gameStage').hide();
        $('#netplayClientView').show();

        // Reset progress UI
        $('#clientStatusBadge').removeClass('badge-success badge-danger').addClass('badge-warning').text('🟡 Connecting...');
        $('#clientStepIndicator').text('Step 1 / 4');
        $('#clientStepMessage').text('Connecting to WebRTC Signaling Broker...');
        const term = document.getElementById('clientLiveTerminal');
        if (term) term.textContent = `[Starting connection to Host room ${code}...]\n`;

        window.netplayManager.onClientProgress = (p) => {
            this.renderClientProgress(p);
        };
        window.netplayManager.onTelemetryUpdate = (t) => {
            this.updateTelemetryUI(t);
        };
        window.netplayManager.onSynchronizedLaunch = async (seconds, onReady) => {
            this.runSynchronizedCountdown(seconds, async () => {
                if (window.netplayManager.stagedRomData) {
                    this.rom_name = 'Online Multiplayer Game';
                    await this.LoadEmulator(window.netplayManager.stagedRomData);
                }
                if (typeof onReady === 'function') onReady();
            });
        };

        // Ensure input controller is ready for client gamepad/keyboard capture
        if (this.rivetsData.inputController) {
            this.rivetsData.inputController.setupGamePad();
        }

        try {
            const slot = await window.netplayManager.startClient(code);
            const slotNum = slot + 1;
            $('#netplayPlayerLabel').text(`Player ${slotNum}`);
            $('#clientStatusBadge').removeClass('badge-warning badge-danger').addClass('badge-info').text('⚡ ROM Staged');
            toastr.info(`ROM Staged! Waiting for Host to start game...`);
        } catch (err) {
            console.error('Client connection failed:', err);
            $('#clientStatusBadge').removeClass('badge-warning badge-success').addClass('badge-danger').text('🔴 Connection Failed');
            $('#clientStepMessage').html(`<span class="text-danger">Failed to connect: ${err.message || err}</span>`);
            toastr.error('Failed to connect to host: ' + (err.message || err));
        }
    }

    updateTelemetryUI(t) {
        if (!t) return;

        // Host HUD Update
        if (window.netplayManager && window.netplayManager.isHost) {
            $('#netplayHostHUD').show();
            $('#hostHudRoomCode').text(t.roomId || '--');
            $('#hostHudMode').text(t.mode || 'ROM_SYNC');
            $('#hostHudPing').text(t.rtt || 0);

            const hasP2 = (t.connectedSlots || []).includes(1);
            if (hasP2) {
                $('#hostHudP2Status').removeClass('badge-secondary badge-warning').addClass('badge-success').text(`P2: Connected (${t.rtt} ms)`);
            } else {
                $('#hostHudP2Status').removeClass('badge-success badge-warning').addClass('badge-secondary').text(`P2: Waiting...`);
            }
        }

        // Client View Update
        $('#telemBroker').text(t.brokerConnected ? 'Connected (0.peerjs.com)' : 'Disconnected')
            .attr('class', t.brokerConnected ? 'text-success' : 'text-danger');
        
        let iceClass = 'text-warning';
        if (t.iceConnectionState === 'connected' || t.iceConnectionState === 'completed') iceClass = 'text-success';
        else if (t.iceConnectionState === 'failed') iceClass = 'text-danger';
        $('#telemIce').text(t.iceConnectionState).attr('class', iceClass);

        let dataClass = 'text-warning';
        if (t.dataChannelStatus === 'OPEN') dataClass = 'text-success';
        $('#telemData').text(t.dataChannelStatus).attr('class', dataClass);

        let videoText = 'N/A';
        let videoClass = 'text-warning';
        if (t.videoElement) {
            if (t.videoElement.readyState >= 2) {
                videoText = `${t.videoElement.videoWidth}x${t.videoElement.videoHeight} (Live 60 FPS)`;
                videoClass = 'text-success';
            } else {
                videoText = `ReadyState ${t.videoElement.readyState}`;
            }
        }
        $('#telemVideo').text(videoText).attr('class', videoClass);

        // Diagnostics Modal Metrics
        $('#diagRole').text(t.role || 'Idle');
        $('#diagPeerId').text(`${t.roomId || '--'} (${t.peerId ? t.peerId.substring(0, 8) + '...' : '--'})`);
        $('#diagIceState').text(t.iceConnectionState || '--');
        $('#diagDataChannel').text(t.dataChannelStatus || '--');
        $('#diagPing').text(t.rtt || 0);
        $('#diagPpsSent').text(t.ppsSent || 0);
        $('#diagPpsRecv').text(t.ppsReceived || 0);
        $('#diagBytes').text(`↑ ${t.bytesSentKB || 0} KB | ↓ ${t.bytesReceivedKB || 0} KB`);

        // Live Controller Visual Inspector
        const netplay = window.netplayManager;
        if (netplay && typeof netplay.getLiveControllerState === 'function') {
            const p1 = netplay.getLiveControllerState(0);
            const p2 = netplay.getLiveControllerState(1);

            if (p1 && p1.buttons) {
                this.updateBtnBadge('diagP1_A', p1.buttons[0], 'badge-primary');
                this.updateBtnBadge('diagP1_B', p1.buttons[2], 'badge-success');
                this.updateBtnBadge('diagP1_Z', p1.buttons[4], 'badge-light text-dark');
                this.updateBtnBadge('diagP1_Start', p1.buttons[9], 'badge-danger');
                this.updateBtnBadge('diagP1_L', p1.buttons[6], 'badge-secondary');
                this.updateBtnBadge('diagP1_R', p1.buttons[5], 'badge-secondary');
                const p1StickX = (p1.axes && p1.axes[0] !== undefined) ? p1.axes[0].toFixed(2) : '0.00';
                const p1StickY = (p1.axes && p1.axes[1] !== undefined) ? p1.axes[1].toFixed(2) : '0.00';
                $('#diagP1_Stick').text(`X: ${p1StickX}, Y: ${p1StickY}`);
            }

            if (p2 && p2.buttons) {
                this.updateBtnBadge('diagP2_A', p2.buttons[0], 'badge-primary');
                this.updateBtnBadge('diagP2_B', p2.buttons[2], 'badge-success');
                this.updateBtnBadge('diagP2_Z', p2.buttons[4], 'badge-light text-dark');
                this.updateBtnBadge('diagP2_Start', p2.buttons[9], 'badge-danger');
                this.updateBtnBadge('diagP2_L', p2.buttons[6], 'badge-secondary');
                this.updateBtnBadge('diagP2_R', p2.buttons[5], 'badge-secondary');
                const p2StickX = (p2.axes && p2.axes[0] !== undefined) ? p2.axes[0].toFixed(2) : '0.00';
                const p2StickY = (p2.axes && p2.axes[1] !== undefined) ? p2.axes[1].toFixed(2) : '0.00';
                $('#diagP2_Stick').text(`X: ${p2StickX}, Y: ${p2StickY}`);
            }
        }
    }

    updateBtnBadge(elemId, isPressed, activeClass) {
        const el = document.getElementById(elemId);
        if (!el) return;
        if (isPressed) {
            el.className = `badge ${activeClass} p-1 mr-1 mb-1 shadow`;
        } else {
            el.className = 'badge badge-dark p-1 mr-1 mb-1';
        }
    }

    copyDiagnosticReport() {
        if (window.appLogger) {
            window.appLogger.copyFullReport().then(() => {
                toastr.success('Full Diagnostic Report copied to clipboard!');
            }).catch(() => {
                toastr.info('Report copied.');
            });
        }
    }

    renderClientProgress(p) {
        if (p.isError) {
            $('#clientStatusBadge').removeClass('badge-warning badge-success').addClass('badge-danger').text('🔴 Connection Failed');
            $('#clientStepMessage').html(`<span class="text-danger font-weight-bold">${p.message}</span>`);
        } else {
            $('#clientStepIndicator').text(`Step ${p.step} / 4`);
            $('#clientStepMessage').text(p.message);
            if (p.step === 4) {
                $('#clientStatusBadge').removeClass('badge-warning badge-danger').addClass('badge-success').text('🟢 P2P Live (60 FPS)');
            }
        }

        const term = document.getElementById('clientLiveTerminal');
        if (term) {
            term.textContent += `${p.message}\n`;
            term.scrollTop = term.scrollHeight;
        }
    }

    toggleFullscreen() {
        const stage = document.getElementById('gameStage');
        if (!stage) return;

        if (!document.fullscreenElement) {
            if (stage.requestFullscreen) stage.requestFullscreen().catch(() => {});
            else if (stage.webkitRequestFullscreen) stage.webkitRequestFullscreen();
            else if (stage.mozRequestFullScreen) stage.mozRequestFullScreen();
            else if (stage.msRequestFullscreen) stage.msRequestFullscreen();
            stage.classList.add('fullscreen-mode');

            // Try orientation lock on mobile
            if (screen.orientation && screen.orientation.lock) {
                screen.orientation.lock('landscape').catch(() => {});
            }
        } else {
            if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
            stage.classList.remove('fullscreen-mode');
        }
    }

    showMobileMenu() {
        $('#mobileMenuModal').modal('show');
    }

    disconnectNetplay() {
        window.netplayManager.disconnect();
        if (window.touchController) window.touchController.hide();
        $('#syncCountdownOverlay').hide();
        $('#netplayHostModal').modal('hide');
        $('#netplayClientView').hide();
        $('#gameStage').hide();
        $('#maindiv').show();
        this.rivetsData.beforeEmulatorStarted = true;
        toastr.info('Disconnected from multiplayer session.');
    }

    toggleNetplayFullscreen() {
        this.toggleFullscreen();
    }

    checkNetplayHash() {
        if (window.location.hash && window.location.hash.startsWith('#join=')) {
            const code = window.location.hash.replace('#join=', '').trim();
            if (code) {
                setTimeout(() => {
                    this.connectNetplay(code);
                }, 500);
            }
        }
    }

    // --- Diagnostics & Debugging Console ---
    showDebugConsole() {
        if (!window.appLogger) return;
        const telemetry = window.appLogger.getSystemTelemetry();

        if (telemetry.netplay) {
            this.updateTelemetryUI(telemetry.netplay);
        }
        $('#diagScreen').text(telemetry.screen + (telemetry.touchSupport ? ' (Touch)' : ' (No Touch)'));

        const logPre = document.getElementById('diagLogPre');
        if (logPre) {
            logPre.textContent = window.appLogger.getLogsText();
            logPre.scrollTop = logPre.scrollHeight;
        }
        $('#diagLogCount').text(window.appLogger.logs.length);

        $('#debugConsoleModal').modal('show');
    }

    copyDiagnostics() {
        if (!window.appLogger) return;
        const report = window.appLogger.generateFullReport();

        navigator.clipboard.writeText(report).then(() => {
            toastr.success('Diagnostic report & logs copied to clipboard!');
        }).catch(() => {
            toastr.info('Please select and copy text manually.');
        });
    }

    clearDiagnostics() {
        if (window.appLogger) {
            window.appLogger.clear();
            const logPre = document.getElementById('diagLogPre');
            if (logPre) logPre.textContent = '';
            $('#diagLogCount').text('0');
        }
    }
}
let myClass = new MyClass();
window["myApp"] = myClass;
if (window.postLoad) window.postLoad();
window["Module"] = {
    onRuntimeInitialized: myClass.initModule,
    canvas: document.getElementById('canvas'),
    print: (text) => myClass.processPrintStatement(text),
}
var rando2 = Math.floor(Math.random() * 100000);
var script2 = document.createElement('script');
script2.src = 'input_controller.js?v=' + rando2;
document.getElementsByTagName('head')[0].appendChild(script2);
myClass.listenForDarkModeCheckbox();
myClass.checkNetplayHash();