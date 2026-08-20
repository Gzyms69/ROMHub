/**
 * ROMHub Touch Controller - Glassmorphic Virtual On-Screen Gamepad
 * 
 * Features:
 * - Full Nintendo 64 Layout: Floating 360° Analog Stick, D-Pad, A, B, Z, Start, L, R, C-Buttons diamond
 * - Pure Multi-Touch Engine with touch ID tracking (no stuck buttons)
 * - Haptic feedback support (navigator.vibrate)
 * - Seamless integration with both Local Emulator and Remote Netplay Client
 */

class TouchController {
    constructor() {
        this.container = null;
        this.enabled = false;
        this.activeTouches = {}; // touchId -> buttonName or 'stick'
        this.stickCenter = { x: 0, y: 0 };
        this.stickTouchId = null;
        this.stickRadius = 45;
        this.hapticsEnabled = true;

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
        console.log('[TouchController] Virtual Gamepad initialized.');
    }

    vibrate(ms = 12) {
        if (this.hapticsEnabled && navigator.vibrate) {
            try { navigator.vibrate(ms); } catch (e) { }
        }
    }

    renderHTML() {
        this.container.innerHTML = `
        <div id="n64TouchHUD" class="n64-touch-hud">
            <!-- Top Triggers & Utility -->
            <div class="hud-top-bar">
                <button type="button" class="touch-btn trigger-btn trigger-l" data-btn="L">L</button>
                <div class="hud-center-controls">
                    <button type="button" class="touch-btn start-btn" data-btn="Start">START</button>
                </div>
                <button type="button" class="touch-btn trigger-btn trigger-r" data-btn="R">R</button>
            </div>

            <!-- Main Control Zone (Left: Stick/Z, Right: A/B/C) -->
            <div class="hud-bottom-zone">
                <!-- Left Thumb Zone (Stick + Z + DPad) -->
                <div class="hud-left-zone" id="touchStickZone">
                    <div id="virtualStickBase" class="virtual-stick-base">
                        <div id="virtualStickKnob" class="virtual-stick-knob"></div>
                    </div>
                    <button type="button" class="touch-btn z-btn" data-btn="Z">Z</button>
                </div>

                <!-- Right Thumb Zone (C-Cluster + Action A/B) -->
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
        const rect = this.container.getBoundingClientRect();
        const stickZone = document.getElementById('touchStickZone');
        const stickZoneRect = stickZone ? stickZone.getBoundingClientRect() : null;

        for (let i = 0; i < e.changedTouches.length; i++) {
            const touch = e.changedTouches[i];
            const target = document.elementFromPoint(touch.clientX, touch.clientY);

            // Check if button pressed
            const btnEl = target ? target.closest('.touch-btn') : null;
            if (btnEl) {
                const btnName = btnEl.getAttribute('data-btn');
                if (btnName) {
                    this.pressButton(btnName, btnEl);
                    this.activeTouches[touch.identifier] = { type: 'button', name: btnName, element: btnEl };
                    continue;
                }
            }

            // Check if left thumb zone (Floating Stick)
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
                    base.style.left = `${touch.clientX - rect.left - 50}px`;
                    base.style.top = `${touch.clientY - rect.top - 50}px`;
                    base.style.display = 'block';
                    knob.style.transform = `translate(0px, 0px)`;
                }
                this.vibrate(8);
            }
        }
        this.syncWithInputController();
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

                // Normalize -1.0 to 1.0 (invert Y for N64 coordinates)
                this.state.stickX = Math.max(-1, Math.min(1, knobX / this.stickRadius));
                this.state.stickY = Math.max(-1, Math.min(1, -(knobY / this.stickRadius)));
            }
        }
        this.syncWithInputController();
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
        this.syncWithInputController();
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

    syncWithInputController() {
        if (!window.myApp || !window.myApp.rivetsData || !window.myApp.rivetsData.inputController) return;
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

    show() {
        if (this.container) this.container.style.display = 'block';
    }

    hide() {
        if (this.container) this.container.style.display = 'none';
    }
}

window.touchController = new TouchController();
