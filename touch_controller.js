/**
 * ROMHub Touch Controller - PPSSPP-Grade Glassmorphic Virtual Gamepad Engine
 * 
 * Features:
 * - Dynamic Floating 360° Analog Joystick (anywhere in left thumb area)
 * - Ergonomic Glassmorphic Triggers: L, R, Z, Start
 * - Translucent A & B Action Buttons with Neon Active Glow
 * - Dedicated C-Buttons Diamond Cluster (C-Up, C-Down, C-Left, C-Right)
 * - Multi-Touch Tracker (Smooth simultaneous thumb movement + multi-button taps)
 * - Haptic feedback support (navigator.vibrate)
 * - Seamless integration with W3C Gamepad API Proxy & Emscripten Core
 */

class TouchController {
    constructor() {
        this.container = null;
        this.enabled = false;
        this.activeTouches = {}; // touchId -> { type: 'button'|'stick', name, element }
        this.stickCenter = { x: 0, y: 0 };
        this.stickTouchId = null;
        this.stickRadius = 45;
        this.hapticsEnabled = true;
        this.opacity = 0.85;

        // Button state cache
        this.state = {
            A: false,
            B: false,
            Z: false,
            Start: false,
            L: false,
            R: false,
            CUP: false,
            CDOWN: false,
            CLEFT: false,
            CRIGHT: false,
            DPAD_UP: false,
            DPAD_DOWN: false,
            DPAD_LEFT: false,
            DPAD_RIGHT: false,
            stickX: 0,
            stickY: 0
        };
    }

    init(targetElementId = 'touchOverlayContainer') {
        this.container = document.getElementById(targetElementId);
        if (!this.container) return;

        this.renderHTML();
        this.bindEvents();
        this.enabled = true;
        this.setOpacity(this.opacity);
        console.log('[TouchController] PPSSPP Glassmorphic Gamepad initialized.');
    }

    setOpacity(val) {
        this.opacity = Math.max(0.1, Math.min(1.0, val));
        const hud = document.getElementById('n64TouchHUD');
        if (hud) {
            hud.style.opacity = this.opacity.toString();
        }
    }

    vibrate(ms = 10) {
        if (this.hapticsEnabled && navigator.vibrate) {
            try { navigator.vibrate(ms); } catch (e) { }
        }
    }

    renderHTML() {
        this.container.innerHTML = `
        <div id="n64TouchHUD" class="n64-touch-hud">
            <!-- Top Bar: L Trigger, Start Button, R Trigger -->
            <div class="hud-top-bar">
                <button type="button" class="touch-btn trigger-btn trigger-l" data-btn="L">L</button>
                <button type="button" class="touch-btn start-btn" data-btn="Start">START</button>
                <button type="button" class="touch-btn trigger-btn trigger-r" data-btn="R">R</button>
            </div>

            <!-- Bottom Control Zone -->
            <div class="hud-bottom-zone">
                <!-- Left Thumb Area: Floating Joystick & Z Trigger -->
                <div class="hud-left-zone" id="touchStickZone">
                    <div id="virtualStickBase" class="virtual-stick-base">
                        <div id="virtualStickKnob" class="virtual-stick-knob"></div>
                    </div>
                    <button type="button" class="touch-btn z-btn" data-btn="Z">Z</button>
                </div>

                <!-- Right Thumb Area: C-Buttons Cluster + A/B Buttons -->
                <div class="hud-right-zone">
                    <!-- C-Buttons Diamond -->
                    <div class="c-button-cluster">
                        <button type="button" class="touch-btn c-btn c-up" data-btn="CUP">▲</button>
                        <div class="c-btn-middle">
                            <button type="button" class="touch-btn c-btn c-left" data-btn="CLEFT">◀</button>
                            <span class="c-label">C</span>
                            <button type="button" class="touch-btn c-btn c-right" data-btn="CRIGHT">▶</button>
                        </div>
                        <button type="button" class="touch-btn c-btn c-down" data-btn="CDOWN">▼</button>
                    </div>

                    <!-- Action Buttons A & B -->
                    <div class="ab-button-cluster">
                        <button type="button" class="touch-btn b-btn" data-btn="B">B</button>
                        <button type="button" class="touch-btn a-btn" data-btn="A">A</button>
                    </div>
                </div>
            </div>
        </div>
        `;
    }

    bindEvents() {
        if (!this.container) return;

        // Prevent default gesture zoom / scroll
        this.container.addEventListener('touchstart', (e) => this.handleTouchStart(e), { passive: false });
        this.container.addEventListener('touchmove', (e) => this.handleTouchMove(e), { passive: false });
        this.container.addEventListener('touchend', (e) => this.handleTouchEnd(e), { passive: false });
        this.container.addEventListener('touchcancel', (e) => this.handleTouchEnd(e), { passive: false });
    }

    handleTouchStart(e) {
        e.preventDefault();
        if (window.myApp && window.myApp.audioContext && window.myApp.audioContext.state === 'suspended') {
            try { window.myApp.audioContext.resume(); } catch (err) { }
        }
        const rect = this.container.getBoundingClientRect();
        const stickZone = document.getElementById('touchStickZone');
        const stickZoneRect = stickZone ? stickZone.getBoundingClientRect() : null;

        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i];
            const target = document.elementFromPoint(touch.clientX, touch.clientY);

            // Check if a discrete button was touched
            const btnEl = target ? target.closest('.touch-btn') : null;
            if (btnEl) {
                const btnName = btnEl.getAttribute('data-btn');
                if (btnName) {
                    this.pressButton(btnName, btnEl);
                    this.activeTouches[touch.identifier] = { type: 'button', name: btnName, element: btnEl };
                    continue;
                }
            }

            // Floating Joystick (Left Half / Left Stick Zone)
            if (stickZoneRect &&
                touch.clientX >= stickZoneRect.left && touch.clientX <= stickZoneRect.right &&
                touch.clientY >= stickZoneRect.top && touch.clientY <= stickZoneRect.bottom &&
                this.stickTouchId === null) {

                this.stickTouchId = touch.identifier;
                this.stickCenter = { x: touch.clientX, y: touch.clientY };
                this.activeTouches[touch.identifier] = { type: 'stick' };

                const base = document.getElementById('virtualStickBase');
                const knob = document.getElementById('virtualStickKnob');
                if (base && knob) {
                    const localX = touch.clientX - stickZoneRect.left;
                    const localY = touch.clientY - stickZoneRect.top;
                    base.style.left = `${localX - 65}px`;
                    base.style.top = `${localY - 65}px`;
                    base.style.display = 'block';
                    knob.style.transform = `translate(0px, 0px)`;
                }
                this.vibrate(8);
            }
        }
        this.syncState();
    }

    handleTouchMove(e) {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i];
            if (touch.identifier === this.stickTouchId) {
                const dx = touch.clientX - this.stickCenter.x;
                const dy = touch.clientY - this.stickCenter.y;
                const dist = Math.hypot(dx, dy);
                const angle = Math.atan2(dy, dx);
                const clampedDist = Math.min(dist, this.stickRadius);

                const knobX = Math.cos(angle) * clampedDist;
                const knobY = Math.sin(angle) * clampedDist;

                const knob = document.getElementById('virtualStickKnob');
                if (knob) {
                    knob.style.transform = `translate(${knobX}px, ${knobY}px)`;
                }

                // Standard N64 Joystick Coordinate Normalization: -1.0 (UP) to 1.0 (DOWN)
                this.state.stickX = Math.max(-1, Math.min(1, knobX / this.stickRadius));
                this.state.stickY = Math.max(-1, Math.min(1, knobY / this.stickRadius));
            }
        }
        this.syncState();
    }

    handleTouchEnd(e) {
        e.preventDefault();
        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i];
            const record = this.activeTouches[touch.identifier];

            if (record) {
                if (record.type === 'button') {
                    this.releaseButton(record.name, record.element);
                } else if (record.type === 'stick') {
                    this.stickTouchId = null;
                    this.state.stickX = 0;
                    this.state.stickY = 0;
                    const base = document.getElementById('virtualStickBase');
                    if (base) base.style.display = 'none';
                }
                delete this.activeTouches[touch.identifier];
            }
        }
        this.syncState();
    }

    pressButton(name, element) {
        this.state[name] = true;
        if (element) element.classList.add('active');
        this.vibrate(12);
    }

    releaseButton(name, element) {
        this.state[name] = false;
        if (element) element.classList.remove('active');
    }

    syncState() {
        // Sync with InputController
        if (window.myApp && window.myApp.rivetsData && window.myApp.rivetsData.inputController) {
            const ic = window.myApp.rivetsData.inputController;
            ic.Key_Action_A = !!this.state.A;
            ic.Key_Action_B = !!this.state.B;
            ic.Key_Action_Z = !!this.state.Z;
            ic.Key_Action_Start = !!this.state.Start;
            ic.Key_Action_L = !!this.state.L;
            ic.Key_Action_R = !!this.state.R;
            ic.Key_Action_CUP = !!this.state.CUP;
            ic.Key_Action_CDOWN = !!this.state.CDOWN;
            ic.Key_Action_CLEFT = !!this.state.CLEFT;
            ic.Key_Action_CRIGHT = !!this.state.CRIGHT;
            ic.VectorX = this.state.stickX;
            ic.VectorY = this.state.stickY;
        }
    }

    show() {
        if (this.container) this.container.style.display = 'block';
    }

    hide() {
        if (this.container) this.container.style.display = 'none';
    }
}

window.touchController = new TouchController();
