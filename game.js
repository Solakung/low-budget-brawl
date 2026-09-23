// --- 1. ตั้งค่า Firebase ---
const firebaseConfig = {
  apiKey: "AIzaSyDs7dfK0T27wPTmHnDB-8K_OJqhqNLx_PQ",
  authDomain: "low-budget-brawl.firebaseapp.com",
  databaseURL: "https://low-budget-brawl-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "low-budget-brawl",
  storageBucket: "low-budget-brawl.firebasestorage.app",
  messagingSenderId: "43420725668",
  appId: "1:43420725668:web:fc7fc6ed69026732891131",
  measurementId: "G-CMR3LZVNKG"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// --- 2. ตัวแปรของเกม ---
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");
let gameMode = ""; // 'bot', 'host', หรือ 'guest'
let roomId = "";
let gameLoop;
let gameOver = false;

// ส่งข้อมูลขึ้น Firebase สูงสุดกี่ ms/ครั้ง แทนที่จะส่งทุกเฟรม (~60/วิ) เพื่อประหยัด quota และลด jitter
const NET_SYNC_INTERVAL_MS = 50;
let lastNetSyncAt = 0;

// --- 2a. ระบบเสียง (Web Audio API สังเคราะห์เสียงสไตล์ 8-bit เพื่อประหยัดสเปค) ---
let audioCtx = null;
let audioMuted = false;

function ensureAudio() {
    if (!audioCtx) {
        try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
        catch (e) { audioCtx = null; }
    } else if (audioCtx.state === "suspended") {
        audioCtx.resume();
    }
    return audioCtx;
}

function playBeep(freq, duration, type, vol, glideTo) {
    if (audioMuted) return;
    const a = ensureAudio();
    if (!a) return;
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = type || "square";
    osc.frequency.setValueAtTime(freq, a.currentTime);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, glideTo), a.currentTime + duration);
    gain.gain.setValueAtTime(vol || 0.15, a.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, a.currentTime + duration);
    osc.connect(gain).connect(a.destination);
    osc.start();
    osc.stop(a.currentTime + duration);
}

function playNoiseBurst(duration, vol) {
    if (audioMuted) return;
    const a = ensureAudio();
    if (!a) return;
    const bufferSize = Math.max(1, Math.floor(a.sampleRate * duration));
    const buffer = a.createBuffer(1, bufferSize, a.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    const src = a.createBufferSource();
    src.buffer = buffer;
    const gain = a.createGain();
    gain.gain.setValueAtTime(vol || 0.2, a.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, a.currentTime + duration);
    src.connect(gain).connect(a.destination);
    src.start();
}

const sfx = {
    hit(strength) {
        const heavy = strength === "heavy";
        playNoiseBurst(heavy ? 0.14 : 0.08, heavy ? 0.28 : 0.18);
        playBeep(heavy ? 90 : 160, 0.08, "square", 0.12, 60);
    },
    block() { playBeep(220, 0.06, "square", 0.08, 180); },
    jump() { playBeep(300, 0.09, "square", 0.08, 500); },
    dash() { playBeep(500, 0.06, "square", 0.06, 700); },
    teleport() {
        playBeep(700, 0.1, "sine", 0.1, 1400);
        playBeep(350, 0.14, "sine", 0.08, 900);
    },
    taunt() {
        playBeep(300, 0.08, "sawtooth", 0.1, 500);
        setTimeout(() => playBeep(500, 0.1, "sawtooth", 0.1, 800), 90);
    },
    special() { playBeep(200, 0.18, "sawtooth", 0.12, 700); },
    super() {
        playNoiseBurst(0.3, 0.25);
        playBeep(80, 0.35, "square", 0.16, 500);
    },
    throwMove() { playBeep(140, 0.16, "triangle", 0.14, 60); },
    knockdown() { playBeep(70, 0.2, "square", 0.16, 40); },
    roundWin() {
        playBeep(523, 0.12, "square", 0.15);
        setTimeout(() => playBeep(659, 0.12, "square", 0.15), 130);
        setTimeout(() => playBeep(784, 0.22, "square", 0.15), 260);
    },
    roundDraw() { playBeep(220, 0.3, "sawtooth", 0.1, 180); },
    parry() {
        playBeep(880, 0.05, "square", 0.16, 1300);
        playBeep(440, 0.09, "triangle", 0.1, 1600);
    },
    ko() {
        playNoiseBurst(0.3, 0.32);
        playBeep(160, 0.35, "square", 0.18, 40);
    }
};

// เพลงพื้นหลัง: ลูปเบสไลน์สั้นๆ แบบ 8-bit วนซ้ำ (ประหยัดสเปค ไม่ต้องโหลดไฟล์เสียง)
const BGM_NOTES = [110, 110, 130.8, 110, 146.8, 130.8, 110, 98];
let bgmOn = false, bgmStep = 0, bgmTimer = null;
function startBGM() {
    if (bgmOn) return;
    bgmOn = true;
    const stepMs = 220;
    const tick = () => {
        if (!bgmOn) return;
        const note = BGM_NOTES[bgmStep % BGM_NOTES.length];
        playBeep(note, 0.16, "triangle", 0.05);
        if (bgmStep % 2 === 0) playBeep(note * 2, 0.08, "square", 0.025);
        bgmStep++;
        bgmTimer = setTimeout(tick, stepMs);
    };
    tick();
}
function stopBGM() { bgmOn = false; clearTimeout(bgmTimer); }
function toggleSound() {
    audioMuted = !audioMuted;
    const btn = document.getElementById("sound-toggle");
    if (btn) btn.innerText = audioMuted ? "🔇" : "🔊";
    if (audioMuted) { stopBGM(); window.speechSynthesis && window.speechSynthesis.cancel(); }
    else if (gameMode) startBGM();
}

// --- 2a-2. Announcer: ใช้ SpeechSynthesis ของเบราว์เซอร์ฟรี ไม่ต้องโหลดไฟล์เสียงเพิ่ม (สไตล์ประกาศเกมตู้) ---
function announce(text) {
    if (audioMuted) return;
    if (!("speechSynthesis" in window)) return;
    try {
        window.speechSynthesis.cancel(); // กันเสียงซ้อนถ้าพูดยังไม่ทันจบ
        const u = new SpeechSynthesisUtterance(text);
        u.lang = "en-US";
        u.rate = 1.05;
        u.pitch = 0.7;
        u.volume = 0.9;
        window.speechSynthesis.speak(u);
    } catch (e) { /* บาง browser/มือถือไม่รองรับ ปล่อยผ่านเงียบๆ */ }
}

// --- 2b. Hit Stop (หยุดเฟรม) / Screen Shake (จอแกว่ง) / Hit Sparks (เอฟเฟกต์อนุภาค) ---
let hitStopUntil = 0;
let shakeUntil = 0;
let shakeMag = 0;
function triggerHitStop(ms) { hitStopUntil = Math.max(hitStopUntil, Date.now() + ms); }
function triggerShake(ms, mag) {
    shakeUntil = Math.max(shakeUntil, Date.now() + ms);
    shakeMag = Math.max(shakeMag, mag);
}

// --- Throw Tech: ถ้าทั้งคู่กดทุ่มใกล้เคียงกัน = หลุดทุ่มทั้งคู่ ไม่มีใครโดนดาเมจ ---
let throwTechUntil = 0;
let throwTechX = 0, throwTechY = 0;

let hitSparks = [];
function spawnHitSparks(x, y, color, count) {
    for (let i = 0; i < count; i++) {
        hitSparks.push({
            x, y,
            vx: (Math.random() - 0.5) * 8,
            vy: -Math.random() * 6 - 2,
            size: 2 + Math.random() * 3,
            life: 260 + Math.random() * 200,
            born: Date.now(),
            color
        });
    }
}
function updateHitSparks() {
    const now = Date.now();
    for (const s of hitSparks) {
        s.vy += 0.5; // แรงโน้มถ่วงของเศษอนุภาค
        s.x += s.vx;
        s.y += s.vy;
    }
    hitSparks = hitSparks.filter(s => now - s.born < s.life && s.y < canvas.height + 30);
}
function drawHitSparks() {
    const now = Date.now();
    for (const s of hitSparks) {
        const t = 1 - (now - s.born) / s.life;
        ctx.globalAlpha = Math.max(0, t);
        ctx.fillStyle = s.color;
        ctx.fillRect(s.x - s.size / 2, s.y - s.size / 2, s.size, s.size);
    }
    ctx.globalAlpha = 1;
}

function drawKOOverlay(now) {
    if (!koPending) return;
    const elapsed = now - koFreezeAt;
    const t = Math.min(1, elapsed / 180); // ป็อปเข้ามาเร็วๆ ในช่วง 180ms แรก
    const scale = 0.5 + t * 0.6;
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2 - 30);
    ctx.scale(scale, scale);
    ctx.font = "bold 68px 'Courier New', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.strokeStyle = "#ff3300";
    ctx.lineWidth = 7;
    ctx.strokeText("K.O.!", 0, 0);
    ctx.fillStyle = "#ffff00";
    ctx.fillText("K.O.!", 0, 0);
    ctx.restore();
}

function drawComboPopups(now) {
    [p1, p2].forEach(p => {
        if (!p.comboPopupUntil || now > p.comboPopupUntil || (p.comboCount || 0) < 2) return;
        const age = now - (p.comboPopupBorn || now);
        const t = Math.min(1, age / 900);
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - t);
        ctx.font = "bold 20px 'Courier New', monospace";
        ctx.textAlign = "center";
        const text = `${p.comboCount} HITS!`;
        const x = p.x + p.width / 2;
        const y = p.y - 20 - t * 20;
        ctx.strokeStyle = "#ff3300";
        ctx.lineWidth = 3;
        ctx.strokeText(text, x, y);
        ctx.fillStyle = "#ffff00";
        ctx.fillText(text, x, y);
        ctx.restore();
    });
}

function drawThrowTechPopup(now) {
    if (now > throwTechUntil) return;
    const age = 700 - (throwTechUntil - now);
    const t = Math.min(1, age / 700);
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - t);
    ctx.font = "bold 24px 'Courier New', monospace";
    ctx.textAlign = "center";
    ctx.strokeStyle = "#00ffff";
    ctx.lineWidth = 4;
    ctx.strokeText("หลุดทุ่ม!", throwTechX, throwTechY - t * 20);
    ctx.fillStyle = "#ffffff";
    ctx.fillText("หลุดทุ่ม!", throwTechX, throwTechY - t * 20);
    ctx.restore();
}

function drawTauntPopup(now) {
    [p1, p2].forEach(p => {
        if (!p.tauntPopupUntil || now > p.tauntPopupUntil || !p.tauntText) return;
        const char = getChar(p);
        const remaining = p.tauntPopupUntil - now;
        const alpha = Math.max(0, Math.min(1, remaining / 300)); // จางลงในช่วง 300ms สุดท้าย
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.font = "bold 13px 'Courier New', monospace";
        ctx.textAlign = "center";
        const x = p.x + p.width / 2;
        const y = p.y - 44;
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = 3;
        ctx.strokeText(p.tauntText, x, y);
        ctx.fillStyle = char.accent;
        ctx.fillText(p.tauntText, x, y);
        ctx.restore();
    });
}

// --- 2c. ระบบยก (Best of 3) และตัวจับเวลา ---
const ROUND_TIME = 99;
let roundWins = { p1: 0, p2: 0 };
let currentRound = 1;
let roundTimeLeft = ROUND_TIME;
let roundTimerHandle = null;

function startRoundTimer() {
    roundTimeLeft = ROUND_TIME;
    updateTimerUI();
    announce(`Round ${currentRound}! Fight!`);
    clearInterval(roundTimerHandle);
    roundTimerHandle = setInterval(() => {
        if (gameOver) return;
        roundTimeLeft -= 1;
        updateTimerUI();
        if (roundTimeLeft <= 0) {
            clearInterval(roundTimerHandle);
            const winner = p1.hp === p2.hp ? null : (p1.hp > p2.hp ? p1 : p2);
            endRound(winner);
        }
    }, 1000);
}
function stopRoundTimer() { clearInterval(roundTimerHandle); }
function updateTimerUI() {
    const el = document.getElementById("round-timer");
    if (el) el.innerText = Math.max(0, roundTimeLeft);
    const label = document.getElementById("round-label");
    if (label) label.innerText = `ยกที่ ${currentRound}`;
}
function updateRoundPips() {
    const p1Pips = document.getElementById("p1-round-pips");
    const p2Pips = document.getElementById("p2-round-pips");
    if (p1Pips) p1Pips.innerText = "●".repeat(roundWins.p1) + "○".repeat(Math.max(0, 2 - roundWins.p1));
    if (p2Pips) p2Pips.innerText = "●".repeat(roundWins.p2) + "○".repeat(Math.max(0, 2 - roundWins.p2));
}

// --- 2c-2. KO Freeze-Frame: ตอนเลือดหมด หยุดจอนิ่งๆ สั้นๆ ก่อนเด้งไปจอผลแพ้ชนะ ---
let koPending = false;
let koWinner = null;
let koFreezeAt = 0;
const KO_FREEZE_MS = 650;

function checkRoundEnd() {
    if (gameOver || koPending) return;
    if (p1.hp <= 0 || p2.hp <= 0) {
        const winner = p1.hp <= 0 && p2.hp <= 0 ? null : (p1.hp <= 0 ? p2 : p1);
        triggerKO(winner);
    }
}

function triggerKO(winner) {
    koPending = true;
    koWinner = winner;
    koFreezeAt = Date.now();
    triggerHitStop(KO_FREEZE_MS);
    triggerShake(300, 10);
    const loser = winner ? opponentOf(winner) : p1;
    spawnHitSparks(loser.x + loser.width / 2, loser.y + loser.height * 0.4, "#ffdd00", 16);
    sfx.ko();
    announce("K.O.!");
}

function resetRoundState() {
    const p1Char = p1.character, p2Char = p2.character;
    p1 = freshPlayer(100, p1Char, 1);
    p2 = freshPlayer(650, p2Char, -1);
    hitSparks = [];
    hitStopUntil = 0;
    shakeUntil = 0;
    gameOver = false;
    koPending = false;
    startRoundTimer();
}

function nextRound() {
    currentRound += 1;
    document.getElementById("round-over").style.display = "none";
    resetRoundState();
}

const GROUND_Y = 300;
const GRAVITY = 0.95;
const JUMP_FORCE = -19;
const JUMP_HFORCE = 4.2;      // ความเร็วแนวนอนตอนกระโดดหน้า/หลัง
const WALK_SPEED = 4.2;
const DASH_SPEED = 11;
const DASH_MS = 210;              // ระยะเวลาพุ่งตัว
const DASH_TAP_WINDOW = 280;      // กดทิศทางซ้ำภายในกี่ ms ถึงนับเป็น Dash
const DASH_COOLDOWN = 260;
const MAX_METER = 100;

// --- Rage / Comeback: เลือดต่ำกว่าเกณฑ์ = ดาเมจที่ตีออกไปแรงขึ้น ช่วยให้เกมพลิกกลับมาได้ตอนท้าย ---
const RAGE_HP_RATIO = 0.3;   // เลือดเหลือ <= 30% ของแม็กซ์ = เข้าสู่ Rage
const RAGE_DMG_MULT = 1.18;  // ดาเมจที่ตีออกไประหว่าง Rage คูณเท่านี้
function rageMult(p) {
    if (!p || !p.maxHp || p.hp <= 0) return 1;
    return p.hp <= p.maxHp * RAGE_HP_RATIO ? RAGE_DMG_MULT : 1;
}

// จังหวะท่าโจมตี (ms): startup = เตรียมท่า, active = ช่วงตีโดนได้จริง, recovery = ช่วงเก็บท่า
const STRENGTH = {
    light:  { dmg: 0.6,  hitstun: 240, blockstun: 130 },
    medium: { dmg: 1.0,  hitstun: 360, blockstun: 190 },
    heavy:  { dmg: 1.55, hitstun: 520, blockstun: 260 }
};
const NORMAL_TIMING = {
    light:  { startup: 70,  active: 90,  recovery: 140 },
    medium: { startup: 110, active: 120, recovery: 240 },
    heavy:  { startup: 170, active: 150, recovery: 400 }
};
const SWEEP_TIMING      = { startup: 190, active: 140, recovery: 480 };
const ANTIAIR_TIMING    = { startup: 140, active: 220, recovery: 420 };
const PROJECTILE_TIMING = { startup: 230, active: 60,  recovery: 340 };
const PROJECTILE_COOLDOWN = 1100;
const DASH_ATTACK_TIMING = { startup: 60, active: 140, recovery: 260 };
const THROW_TIMING = { startup: 110, active: 90, recovery: 380 };
const THROW_RANGE = 42;
const SUPER_TIMING = { startup: 220, active: 220, recovery: 520 };
// ท่าโจมตีกลางอากาศ: จังหวะไวกว่าท่าพื้นเล็กน้อย ใช้ได้แค่ 1 ครั้งต่อการกระโดด 1 ครั้ง
const AIR_ATTACK_TIMING = {
    light:  { startup: 60,  active: 110, recovery: 90 },
    medium: { startup: 90,  active: 130, recovery: 130 },
    heavy:  { startup: 120, active: 150, recovery: 170 }
};
const CANCEL_WINDOW_MS = 220; // หน้าต่างเวลาแทรกท่าพิเศษ/ซุปเปอร์หลังท่าเบา/กลางตีโดน (Cancel แบบ SF)
const PARRY_WINDOW_MS = 150;  // กดบล็อกภายในกี่ ms แรกถึงนับเป็น Parry (สวนฟรี)
const PARRY_PUNISH_MS = 420;  // ผู้โจมตีเสียหลักนานแค่ไหนหลังโดน Parry
const WAKEUP_WINDOW_MS = 280; // ช่วงเวลาก่อนลุกที่รับอินพุตเลือกท่าลุก

// --- 2b. ตัวละครที่เลือกได้ แต่ละตัวมีท่าไม้ตายของตัวเอง ---
const CHARACTERS = [
    {
        // --- Yellow Boxer: สาย Armor / Power ---
        // หมัดหนักมี Super Armor (ทนโดนท่าเบา 1 ฮิตแล้วชกต่อได้ ไม่ติด Hitstun),
        // Super "Haymaker" หมัดเดียวจบพุ่งเข้าประชิด ดาเมจสูงสุดในบรรดาซุปเปอร์ปกติ
        id: "boxer", name: "นักชก \"หมัดไฟ\"", color: "#ffff00", accent: "#ff3300", hasSword: false,
        altColor: "#ff9900", altAccent: "#ffffff",
        tauntLines: ["มาเลย! หมัดไฟยังไม่ปล่อยของจริงด้วยซ้ำ!", "ยืนนิ่งขนาดนี้ เดี๋ยวโดนน็อกไม่รู้ตัวนะ"],
        winLines: ["หมัดไฟยังไม่มีใครดับได้!", "แค่ชกไม่กี่ทีก็จบแล้ว"],
        punchDmg: 8, punchRange: 45,
        kickDmg: 14, kickRange: 55,
        projectileDmg: 10, superDmg: 30,
        hp: 100,
        armorOnHeavy: true,
        superType: "haymaker"
    },
    {
        // --- Cyan Kicker: สาย Speed / Multi-hit ---
        // เดิน/พุ่งตัว/โปรเจกไทล์เร็วกว่าตัวอื่น,
        // Super "Thunder Barrage" เตะรัว 4 ฮิตติดกัน จบด้วยล้ม
        id: "kicker", name: "นักเตะ \"สายฟ้า\"", color: "#00ccff", accent: "#ffffff", hasSword: false,
        altColor: "#3366ff", altAccent: "#ffff00",
        tauntLines: ["ช้าจัง ตามไม่ทันหรอกน่า!", "เก็บแรงไว้เท่าไหร่ก็ไม่พอหรอก"],
        winLines: ["เร็วเกินไปสำหรับนายจริงๆ", "สายฟ้าไม่เคยรอใคร"],
        punchDmg: 6, punchRange: 40,
        kickDmg: 18, kickRange: 72,
        projectileDmg: 9, superDmg: 28,
        hp: 100,
        walkSpeed: WALK_SPEED * 1.15, dashSpeed: DASH_SPEED * 1.15, projectileSpeed: 10.5,
        superType: "barrage"
    },
    {
        // --- Magenta-pink Swordsman: สาย Range / Poke ---
        // ท่าพิเศษยืน = พุ่งฟันดาบระยะไกลแทนปล่อยพลัง (Sword Lunge),
        // Super "Iaido" ชักดาบฟันระยะไกลสุด ดาเมจสูง แลกกับสตาร์ทอัพช้าที่สุด
        id: "swordsman", name: "นักดาบ \"จอมคม\"", color: "#ff66ff", accent: "#ffff00", hasSword: true,
        altColor: "#9933ff", altAccent: "#00ffcc",
        tauntLines: ["ดาบเล่มนี้ยังไม่ได้ขยับจริงจังเลยนะ", "ท่าทางนายยังไม่พร้อมเจอของจริง"],
        winLines: ["คมกริบ ไร้ที่ติ", "จบด้วยคมดาบเดียว พอแล้ว"],
        punchDmg: 11, punchRange: 72,
        kickDmg: 10, kickRange: 50,
        projectileDmg: 12, superDmg: 32,
        hp: 100,
        hasSwordLunge: true,
        superType: "iaido"
    },
    {
        // --- Cyan Assassin: สาย Rushdown / Mix-up ---
        // เบาแต่เร็ว, โจมตีเบา "Plus on block" กดต่อได้, ทุ่มแล้วเด้งไกล,
        // Spark Kunai (โปรเจกไทล์) เร็วแรงแต่ดาเมจน้อย, Super "Lightning Flurry" พุ่งเข้าใส่รัวหมัด
        id: "assassin", name: "นักฆ่า \"ไซแอน\"", color: "#00ffff", accent: "#ff2266", hasSword: false,
        altColor: "#33ff99", altAccent: "#ffffff",
        tauntLines: ["อยู่ตรงนั้นแหละ เดี๋ยวไปหาเอง", "หนีไม่พ้นหรอก รู้ตัวไหม"],
        winLines: ["จบง่ายกว่าที่คิดอีก", "เงาไม่เคยพลาดเป้า"],
        punchDmg: 7, punchRange: 42,
        kickDmg: 9, kickRange: 46,
        projectileDmg: 5, superDmg: 34,
        hp: 85,
        walkSpeed: WALK_SPEED * 1.25, dashSpeed: DASH_SPEED * 1.2, jumpForce: JUMP_FORCE * 1.1,
        projectileSpeed: 11,
        plusOnBlock: true, bigThrowKnockback: true,
        superType: "flurry"
    },
    {
        // --- Magenta Bruiser: สาย Grappler / Juggernaut ---
        // เลือดเยอะ เดินช้า กระโดดเตี้ย, Command Grab ทะลุการบล็อก 100% แทนโปรเจกไทล์,
        // Titan Dash (พุ่งชนตอน Dash) มี Super Armor กันโดนโจมตีเบา 1 ฮิต,
        // Super "Earthquake Piledriver" จับทุ่มทะลุบล็อก ดาเมจมหาศาล
        id: "bruiser", name: "นักซัด \"มาเจนต้า\"", color: "#ff00aa", accent: "#ffcc00", hasSword: false,
        altColor: "#ffaa00", altAccent: "#ff0055",
        tauntLines: ["แค่นี้เอาไม่อยู่แล้วเหรอ?", "มาเลย ข้ายังไม่ออกแรงจริงด้วยซ้ำ"],
        winLines: ["กล้ามนี้ไม่มีคำว่าพ่ายแพ้", "หนักแค่ไหนก็ต้องล้ม"],
        punchDmg: 13, punchRange: 78,
        kickDmg: 12, kickRange: 60,
        projectileDmg: 0, superDmg: 40,
        hp: 120,
        walkSpeed: WALK_SPEED * 0.7, dashSpeed: DASH_SPEED * 0.75, jumpForce: JUMP_FORCE * 0.8,
        hasCommandGrab: true, hasSuperArmor: true, slowThrow: true,
        superType: "grab"
    },
    {
        // --- Purple Mage/Butterfly: สาย Teleport-Zoner ---
        // HP ต่ำสุดในเกม แลกกับท่าพิเศษยืน = วาร์ปสั้นๆ (แทนโปรเจกไทล์) มีอินวัลน์เต็มระหว่างวาร์ป
        // หลบได้ทั้งท่าโจมตีแนวสูง/แนวราบ/โปรเจกไทล์ เหมาะกับสายจับผิดจังหวะ/หลอกล่อ
        // Super "Phantom Slash" ฟันภาพลวงตา 2 ฮิตติดกัน ระยะไกลกว่าซุปเปอร์ตัวอื่น
        id: "mage", name: "นักเวท \"ผีเสื้อ\"", color: "#cc66ff", accent: "#ff99ff", hasSword: false,
        altColor: "#ff6699", altAccent: "#ccffff",
        tauntLines: ["จับฉันให้ได้ก่อนสิ~", "อยู่ตรงนี้ อยู่ตรงนั้น งงมั้ยล่ะ?"],
        winLines: ["ปีกผีเสื้อพาไปได้ไกลกว่าที่คิด", "มายากลไม่เคยหลอกใคร... เกินจริง"],
        punchDmg: 6, punchRange: 44,
        kickDmg: 7, kickRange: 48,
        projectileDmg: 0, superDmg: 26,
        hp: 65,
        walkSpeed: WALK_SPEED * 0.9, jumpForce: JUMP_FORCE * 1.05,
        hasTeleport: true, hasWings: true,
        superType: "phantom"
    }
];
function getChar(p) {
    const base = CHARACTERS.find(c => c.id === p.character) || CHARACTERS[0];
    // Palette Swap: ถ้าเป็น Mirror Match (P2 เลือกตัวเดียวกับ P1) ให้ P2 ใช้สีสำรองอัตโนมัติ
    // กันสีตัวละครซ้อนทับกันดูสับสนตอนสองคนเลือกตัวเดียวกัน
    if (p === p2 && p1 && p1.character === p2.character && base.altColor) {
        return Object.assign({}, base, { color: base.altColor, accent: base.altAccent || base.accent });
    }
    return base;
}

let selectedCharacterId = "boxer";
function selectCharacter(id) {
    selectedCharacterId = id;
    document.querySelectorAll(".char-card").forEach(el => {
        el.classList.toggle("active", el.dataset.char === id);
    });
    document.getElementById("menu").style.display = "block";
    const stageSel = document.getElementById("stage-select");
    if (stageSel) stageSel.style.display = "block";
}

// --- 2d-2. Preview ตัวละครหน้าเลือกตัว: ขยับหายใจ/โยกตัวเบาๆ แทนที่จะเป็นแค่ไอคอนนิ่งๆ ---
const previewCanvas = document.getElementById("charPreviewCanvas");
const pctx = previewCanvas ? previewCanvas.getContext("2d") : null;
let previewT = 0;

function pLimb(x, y, midDx, midDy, endDx, endDy, width) {
    pctx.lineWidth = width;
    pctx.beginPath();
    pctx.moveTo(x, y);
    pctx.lineTo(x + midDx, midDy);
    pctx.lineTo(x + endDx, endDy);
    pctx.stroke();
}

function drawCharPreview(charId) {
    if (!pctx) return;
    const char = CHARACTERS.find(c => c.id === charId) || CHARACTERS[0];
    pctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);

    // วงแสงพื้นหลังสีธีมตัวละครจางๆ
    pctx.fillStyle = char.color;
    pctx.globalAlpha = 0.12;
    pctx.beginPath();
    pctx.arc(previewCanvas.width / 2, previewCanvas.height / 2 + 6, 58, 0, Math.PI * 2);
    pctx.fill();
    pctx.globalAlpha = 1;

    const cx = previewCanvas.width / 2;
    const feetY = previewCanvas.height - 18;
    const breathe = Math.sin(previewT) * 3;
    const sway = Math.sin(previewT * 0.6) * 4;

    const hipY = feetY - 46;
    const shoulderY = hipY - 34 - breathe * 0.3;
    const headR = 11;
    const headY = shoulderY - headR - 2;

    pctx.strokeStyle = char.color;
    pctx.fillStyle = char.color;
    pctx.lineCap = "round";

    // ขา
    pLimb(cx, hipY, sway * 0.6, hipY + 22, sway * 0.4, feetY, 8);
    pLimb(cx, hipY, -sway * 0.6, hipY + 22, -sway * 0.4, feetY, 8);

    // ลำตัว
    pctx.lineWidth = 10;
    pctx.beginPath();
    pctx.moveTo(cx, hipY);
    pctx.lineTo(cx + sway * 0.3, shoulderY);
    pctx.stroke();

    // ผ้าคาดหัว
    pctx.strokeStyle = char.accent;
    pctx.lineWidth = 3;
    pctx.beginPath();
    pctx.moveTo(cx - headR + sway * 0.3, headY - 2);
    pctx.lineTo(cx + headR + sway * 0.3, headY - 2);
    pctx.stroke();

    // หัว
    pctx.fillStyle = char.color;
    pctx.beginPath();
    pctx.arc(cx + sway * 0.3, headY, headR, 0, Math.PI * 2);
    pctx.fill();

    // แขนโยกหายใจ
    const armSwing = Math.sin(previewT * 0.8 + Math.PI) * 5;
    pctx.strokeStyle = char.color;
    pLimb(cx, shoulderY, armSwing, shoulderY + 16, armSwing * 0.6, hipY + 4, 8);
    pLimb(cx, shoulderY, -armSwing, shoulderY + 16, -armSwing * 0.6, hipY + 4, 8);

    // ดาบสำหรับตัวละครที่มีดาบ
    if (char.hasSword) {
        pctx.strokeStyle = char.accent;
        pctx.lineWidth = 3;
        pctx.beginPath();
        pctx.moveTo(cx + 10, hipY + 4);
        pctx.lineTo(cx + 27, hipY - 32);
        pctx.stroke();
    }

    // ปีกผีเสื้อสำหรับนักเวท
    if (char.hasWings) {
        const flap = Math.sin(previewT * 1.4) * 4;
        pctx.save();
        pctx.globalAlpha = 0.6;
        pctx.fillStyle = char.accent;
        pctx.beginPath();
        pctx.ellipse(cx - 9, shoulderY - 2, 16, 10 + flap, Math.PI / 5, 0, Math.PI * 2);
        pctx.fill();
        pctx.beginPath();
        pctx.ellipse(cx - 9, shoulderY + 14, 13, 8 + flap * 0.6, -Math.PI / 6, 0, Math.PI * 2);
        pctx.fill();
        pctx.restore();
    }
}

function previewLoop() {
    previewT += 0.06;
    drawCharPreview(selectedCharacterId);
    if (!gameMode) requestAnimationFrame(previewLoop);
}
previewLoop();

// --- 2d. สเตจ: วาดด้วย canvas ล้วนๆ ไม่ใช้รูปภาพ (ประหยัดสเปคตามคอนเซปต์เกม) ---
const STAGES = [
    { id: "alley", name: "ตรอกท้ายซอย", sky: ["#1a1a1a", "#000000"], floor: "#ff5500" },
    { id: "dojo", name: "โดโจ", sky: ["#3a1a12", "#160a08"], floor: "#cc5522" },
    { id: "neon", name: "นีออนซิตี้", sky: ["#0a0033", "#000011"], floor: "#00aacc" },
    { id: "volcano", name: "ภูเขาไฟ", sky: ["#330000", "#110000"], floor: "#ff3300" },
    { id: "space", name: "อวกาศ", sky: ["#000018", "#000000"], floor: "#5533aa" }
];
let selectedStageId = "alley";
let currentStage = "alley";
function selectStage(id) {
    selectedStageId = id;
    document.querySelectorAll(".stage-card").forEach(el => {
        el.classList.toggle("active", el.dataset.stage === id);
    });
}

function drawStage(stageId) {
    const stage = STAGES.find(s => s.id === stageId) || STAGES[0];

    // ท้องฟ้า/พื้นหลังไล่สี
    const grad = ctx.createLinearGradient(0, 0, 0, 360);
    grad.addColorStop(0, stage.sky[0]);
    grad.addColorStop(1, stage.sky[1]);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, 360);

    // องค์ประกอบตกแต่งเฉพาะสเตจ (รูปทรงเรขาคณิตล้วนๆ)
    ctx.save();
    ctx.globalAlpha = 0.55;
    if (stage.id === "alley") {
        ctx.fillStyle = "#000000";
        for (let i = 0; i < 6; i++) {
            const bw = 60 + (i % 3) * 20;
            ctx.fillRect(i * 140 - 20, 360 - (90 + (i % 4) * 25), bw, 200);
        }
        ctx.fillStyle = "#ff9900";
        for (let i = 0; i < 10; i++) {
            if ((i * 37) % 5 < 2) ctx.fillRect(20 + i * 78, 300 - (i % 3) * 30, 6, 6);
        }
    } else if (stage.id === "dojo") {
        ctx.fillStyle = "#ff5533";
        ctx.beginPath();
        ctx.arc(canvas.width - 120, 110, 55, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#2a1208";
        ctx.lineWidth = 6;
        for (let i = 1; i < 5; i++) {
            ctx.beginPath();
            ctx.moveTo(i * 170 - 30, 190);
            ctx.lineTo(i * 170 - 30, 360);
            ctx.stroke();
        }
    } else if (stage.id === "neon") {
        ctx.fillStyle = "#150033";
        for (let i = 0; i < 8; i++) {
            const h = 80 + (i % 5) * 30;
            ctx.fillRect(i * 105, 360 - h, 80, h);
        }
        ctx.fillStyle = "#00ffff";
        for (let i = 0; i < 8; i++) {
            for (let w = 0; w < 3; w++) {
                if ((i + w) % 2 === 0) ctx.fillRect(i * 105 + 12 + w * 22, 360 - 60 - (i % 5) * 10, 6, 6);
            }
        }
    } else if (stage.id === "volcano") {
        ctx.fillStyle = "#1a0000";
        ctx.beginPath();
        ctx.moveTo(-20, 360); ctx.lineTo(180, 140); ctx.lineTo(360, 360); ctx.closePath(); ctx.fill();
        ctx.beginPath();
        ctx.moveTo(canvas.width + 20, 360); ctx.lineTo(canvas.width - 190, 170); ctx.lineTo(canvas.width - 420, 360); ctx.closePath(); ctx.fill();
        ctx.fillStyle = "#ff8800";
        ctx.beginPath(); ctx.arc(180, 140, 8, 0, Math.PI * 2); ctx.fill();
    } else if (stage.id === "space") {
        ctx.fillStyle = "#ffffff";
        for (let i = 0; i < 36; i++) {
            const sx = (i * 53) % canvas.width;
            const sy = (i * 97) % 300;
            ctx.fillRect(sx, sy, 2, 2);
        }
        ctx.fillStyle = "#aabbff";
        ctx.beginPath(); ctx.arc(120, 90, 32, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    // พื้น
    ctx.fillStyle = stage.floor;
    ctx.fillRect(0, 360, canvas.width, 40);
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    for (let i = 0; i < 20; i++) ctx.fillRect(i * 42, 360, 20, 40);
}

// สถานะปุ่มกด (เดิน/ย่อ/กระโดด เป็นแบบกดค้าง)
const keys = { a: false, d: false, s: false, w: false };

function freshPlayer(x, character, facing) {
    const char = CHARACTERS.find(c => c.id === character) || CHARACTERS[0];
    const maxHp = char.hp || 100;
    return {
        x, y: GROUND_Y, width: 30, height: 60, character, hp: maxHp, maxHp, super: 0,
        vx: 0, vy: 0, grounded: true, crouching: false,
        holdingBack: false, holdingForward: false, wasHoldingBack: false, blockStartAt: 0,
        parryFlashUntil: 0, wakeupChoice: null,
        state: "idle", action: null, actionEndAt: 0,
        stunUntil: 0, invulnUntil: 0, lastHit: 0, hitFlashUntil: 0,
        dashUntil: 0, dashCooldownUntil: 0, dashAttackWindowUntil: 0,
        lastTapLeft: 0, lastTapRight: 0, projectile: null, projectileCooldownUntil: 0,
        facing, legPhase: 0, prevX: x, isMoving: false,
        comboCount: 0, comboPopupUntil: 0, comboPopupBorn: 0, armorHitsLeft: 0,
        airActionUsed: false, tauntText: "", tauntPopupUntil: 0
    };
}

// ข้อมูลผู้เล่น 1 และ ผู้เล่น 2
let p1 = freshPlayer(100, "boxer", 1);
let p2 = freshPlayer(650, "kicker", -1);

function localPlayer() {
    if (!gameMode) return null;
    return gameMode === "guest" ? p2 : p1;
}
function opponentOf(p) {
    return p === p1 ? p2 : p1;
}

// --- 3. ระบบควบคุม (คีย์บอร์ด) ---
// ใช้ e.code (ตำแหน่งปุ่มจริงบนคีย์บอร์ด) แทน e.key เพื่อไม่ให้พังเวลาสลับภาษา/คีย์บอร์ดไทย
// (นี่คือสาเหตุของบัค "กด A/D แล้วเดินไม่ได้" เดิม — e.key จะเปลี่ยนค่าไปตามภาษาที่พิมพ์อยู่)
window.addEventListener("keydown", (e) => {
    switch (e.code) {
        case "KeyA": if (!keys.a) tryDash("left"); keys.a = true; break;
        case "KeyD": if (!keys.d) tryDash("right"); keys.d = true; break;
        case "KeyS":
        case "ArrowDown": keys.s = true; e.preventDefault(); break;
        case "KeyW":
        case "ArrowUp": keys.w = true; e.preventDefault(); break;
        case "Space": e.preventDefault(); doThrow(); break;
        case "KeyU": doAttack("punch", "light"); break;
        case "KeyI": doAttack("punch", "medium"); break;
        case "KeyO": doAttack("punch", "heavy"); break;
        case "KeyJ": doAttack("kick", "light"); break;
        case "KeyK": doAttack("kick", "medium"); break;
        case "KeyL": doAttack("kick", "heavy"); break;
        case "KeyE": doSpecial(); break;
        case "KeyQ": doSuper(); break;
        case "KeyT": doTaunt(); break;
    }
});

window.addEventListener("keyup", (e) => {
    switch (e.code) {
        case "KeyA": keys.a = false; break;
        case "KeyD": keys.d = false; break;
        case "KeyS":
        case "ArrowDown": keys.s = false; break;
        case "KeyW":
        case "ArrowUp": keys.w = false; break;
    }
});

// --- 3b. ปุ่มควบคุมบนจอ (Touch) ---
function bindHoldButton(id, onDown, onUp) {
    const el = document.getElementById(id);
    if (!el) return;

    const setActive = (on) => el.classList.toggle("active", on);

    const start = (e) => { e.preventDefault(); onDown(); setActive(true); };
    const end = (e) => { e.preventDefault(); onUp(); setActive(false); };

    el.addEventListener("touchstart", start, { passive: false });
    el.addEventListener("touchend", end, { passive: false });
    el.addEventListener("touchcancel", end, { passive: false });
    el.addEventListener("mousedown", start);
    el.addEventListener("mouseup", end);
    el.addEventListener("mouseleave", end);
}

function setupOnscreenControls() {
    bindHoldButton("btn-left", () => { tryDash("left"); keys.a = true; }, () => keys.a = false);
    bindHoldButton("btn-right", () => { tryDash("right"); keys.d = true; }, () => keys.d = false);
    bindHoldButton("btn-down", () => keys.s = true, () => keys.s = false);
    bindHoldButton("btn-jump", () => keys.w = true, () => keys.w = false);
    bindHoldButton("btn-attack", () => doAttack("punch", "light"), () => {});
    bindHoldButton("btn-kick", () => doAttack("kick", "light"), () => {});
    bindHoldButton("btn-heavy", () => doHeavy(), () => {});
    bindHoldButton("btn-throw", () => doThrow(), () => {});
    bindHoldButton("btn-special", () => doSpecial(), () => {});
    bindHoldButton("btn-super", () => doSuper(), () => {});

    document.getElementById("onscreen-controls").addEventListener("touchend", (e) => {
        e.preventDefault();
    }, { passive: false });
}

// --- 3c. Canvas ปรับขนาดอัตโนมัติ (Responsive / เต็มจอบนมือถือ) ---
function resizeCanvas() {
    const aspect = canvas.width / canvas.height;
    const isMobile = window.innerWidth <= 700;

    let availableWidth = window.innerWidth * (isMobile ? 1 : 0.95);
    let availableHeight = window.innerHeight * (isMobile ? 0.7 : 0.6);

    let targetWidth = availableWidth;
    let targetHeight = targetWidth / aspect;

    if (targetHeight > availableHeight) {
        targetHeight = availableHeight;
        targetWidth = targetHeight * aspect;
    }

    canvas.style.width = targetWidth + "px";
    canvas.style.height = targetHeight + "px";
}

window.addEventListener("resize", resizeCanvas);
window.addEventListener("orientationchange", resizeCanvas);

// --- 4. ฟังก์ชันเริ่มเกมโหมดต่างๆ ---
function startGame(mode) {
    document.getElementById("char-select").style.display = "none";
    document.getElementById("menu").style.display = "none";
    const stageSelEl = document.getElementById("stage-select");
    if (stageSelEl) stageSelEl.style.display = "none";
    document.getElementById("canvas-wrap").style.display = "flex";
    document.getElementById("controls").style.display = "block";
    document.getElementById("hud").style.display = "flex";
    const tauntBtn = document.getElementById("taunt-btn");
    if (tauntBtn) tauntBtn.style.display = "flex";
    document.body.classList.add("playing"); // ล็อกการเลื่อนจอตอนเริ่มเล่นจริง กันมือไปโดนเลื่อนจอกลางไฟต์

    if (mode === "bot") {
        p1.character = selectedCharacterId;
        const others = CHARACTERS.filter(c => c.id !== selectedCharacterId);
        p2.character = others[Math.floor(Math.random() * others.length)].id;
        currentStage = selectedStageId;
    } else if (mode === "host") {
        p1.character = selectedCharacterId;
        currentStage = selectedStageId;
    } else if (mode === "guest") {
        p2.character = selectedCharacterId;
        // ถ้ายังไม่ได้ค่าสเตจของ Host มาจาก Firebase ให้ใช้ที่เลือกไว้เองไปพลางๆก่อน
        if (!currentStage) currentStage = selectedStageId;
    }

    const onscreen = document.getElementById("onscreen-controls");
    onscreen.style.display = "flex";
    if (!onscreen.dataset.bound) {
        setupOnscreenControls();
        onscreen.dataset.bound = "true";
    }

    gameMode = mode;
    resizeCanvas();
    roundWins = { p1: 0, p2: 0 };
    currentRound = 1;
    gameOver = false;
    updateRoundPips();
    startRoundTimer();
    startBGM();
    update();
}

function createRoom() {
    p1.character = selectedCharacterId;
    roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    document.getElementById("displayRoomId").innerText = roomId;
    document.getElementById("room-info").style.display = "block";

    db.ref("rooms/" + roomId).set({ p1: p1, p2: p2, status: "waiting", stage: selectedStageId });

    db.ref("rooms/" + roomId).on("value", (snapshot) => {
        const data = snapshot.val();
        if (data && data.stage) currentStage = data.stage;
        if (data && data.status === "playing" && gameMode !== "host") {
            startGame("host");
        }
        if (data && data.p2) p2 = data.p2;
    });

    // ค่าพลังชีวิต/สถานะที่ Host คำนวณให้ P2 (เพราะ Host เป็นผู้ตัดสินการโดนตี)
    db.ref("rooms/" + roomId + "/combat").on("value", (snapshot) => {
        const d = snapshot.val();
        if (d && typeof d.p1hp === "number") p1.hp = d.p1hp;
    });

    // --- Presence: ประกาศตัวว่า Host ยังอยู่ และตั้งให้ Firebase เซ็ตค่าเป็น false อัตโนมัติถ้าหลุดการเชื่อมต่อ ---
    const hostPresenceRef = db.ref("rooms/" + roomId + "/hostPresent");
    hostPresenceRef.set(true);
    hostPresenceRef.onDisconnect().set(false);

    // จับตาดู Guest: ถ้าเคยเชื่อมต่อแล้วหลุดไประหว่างเล่น ให้จบเกมทันทีแทนที่จะค้างรอเฉยๆ
    let guestWasConnected = false;
    db.ref("rooms/" + roomId + "/guestPresent").on("value", (snapshot) => {
        const present = snapshot.val();
        if (present === true) guestWasConnected = true;
        if (present === false && guestWasConnected && gameMode === "host") {
            handleOpponentDisconnect();
        }
    });
}

function joinRoom() {
    p2.character = selectedCharacterId;
    roomId = document.getElementById("roomIdInput").value.toUpperCase();
    if (!roomId) return alert("กรุณาใส่รหัสห้อง!");

    db.ref("rooms/" + roomId).update({ status: "playing" });

    db.ref("rooms/" + roomId).on("value", (snapshot) => {
        const data = snapshot.val();
        if (data && data.stage) currentStage = data.stage;
        if (data && data.p1) p1 = data.p1;
    });

    // Host เป็นผู้ตัดสินการโดนตี ฝั่ง Guest จึงต้องรับผลของ P2 กลับมาจาก Host
    db.ref("rooms/" + roomId + "/combat").on("value", (snapshot) => {
        const d = snapshot.val();
        if (d && typeof d.p2hp === "number") p2.hp = d.p2hp;
    });

    // --- Presence: ประกาศตัวว่า Guest ยังอยู่ และตั้งให้ Firebase เซ็ตค่าเป็น false อัตโนมัติถ้าหลุดการเชื่อมต่อ ---
    const guestPresenceRef = db.ref("rooms/" + roomId + "/guestPresent");
    guestPresenceRef.set(true);
    guestPresenceRef.onDisconnect().set(false);

    // จับตาดู Host: ห้องมีอยู่แล้วก่อน Guest จะ join ได้ ถือว่า Host เชื่อมต่ออยู่ตั้งแต่แรก
    let hostWasConnected = true;
    db.ref("rooms/" + roomId + "/hostPresent").on("value", (snapshot) => {
        const present = snapshot.val();
        if (present === false && hostWasConnected && gameMode === "guest") {
            handleOpponentDisconnect();
        }
    });

    startGame("guest");
}

// --- 5. ระบบท่าโจมตี / สถานะการกระทำ ---
function canAct(p) {
    return !!p && !gameOver && p.grounded && (p.state === "idle" || p.state === "walk" || p.state === "crouch");
}

// ใช้เฉพาะท่าพิเศษ/ซุปเปอร์: ให้แทรกเข้าไปได้ทันทีถ้ายังอยู่ในหน้าต่าง Cancel
// (เปิดจากท่าเบา/กลางที่เพิ่งตีโดนคู่ต่อสู้) แม้ตัวเองจะยังอยู่ในสถานะ "attack" (กำลัง recovery) ก็ตาม
function canActOrCancel(p) {
    if (canAct(p)) return true;
    return !!p && !gameOver && p.grounded && p.state === "attack" && Date.now() < (p.cancelWindowUntil || 0);
}

function beginAction(p, def, timing) {
    const now = Date.now();
    p.cancelWindowUntil = 0; // เริ่มท่าใหม่แล้ว เคลียร์หน้าต่าง Cancel เก่าทิ้ง
    p.state = def.isThrow ? "throw" : "attack";
    const startupEnd = now + timing.startup;
    const activeEnd = startupEnd + (timing.active || 0);
    const recoveryEnd = activeEnd + timing.recovery;
    p.action = Object.assign({ phase: "startup", startupEnd, activeEnd, recoveryEnd, hitDone: false, spawned: false }, def);
    p.actionEndAt = recoveryEnd;
    if (def.invulnStartup) p.invulnUntil = startupEnd;
}

function updateAction(p) {
    if (!p.action) {
        if (p.state === "attack" || p.state === "throw") p.state = "idle";
        return;
    }
    const now = Date.now();
    const a = p.action;
    const prevPhase = a.phase;
    a.phase = now < a.startupEnd ? "startup" : (now < a.activeEnd ? "active" : (now < a.recoveryEnd ? "recovery" : "done"));
    if (a.phase === "active" && prevPhase === "startup" && a.spawnsProjectile && !a.spawned) {
        spawnProjectile(p);
        a.spawned = true;
    }
    if (a.dashMove) {
        if (a.phase === "startup" || a.phase === "active") {
            p.x += p.vx;
            clampX(p);
        } else {
            p.vx = 0;
        }
    }
    if (a.phase === "done") {
        p.action = null;
        p.state = "idle";
    }
}

function updateStun(p) {
    const now = Date.now();
    if ((p.state === "hitstun" || p.state === "blockstun") && now > (p.stunUntil || 0)) {
        p.state = "idle";
    } else if (p.state === "knockdown" && now > (p.stunUntil || 0)) {
        // ลุกจากพื้น: เลือกท่าลุกตาม wakeupChoice ที่รับอินพุตไว้ระหว่างช่วงท้ายของการล้ม
        const choice = p.wakeupChoice;
        p.wakeupChoice = null;
        if (choice === "roll") {
            // ลุกกลิ้งหนี: สไลด์ถอยออกจากคู่ต่อสู้ แลกกับอินวัลน์สั้นๆ ระหว่างกลิ้ง
            p.x -= p.facing * 46;
            p.invulnUntil = now + 260;
            sfx.dash();
        } else if (choice === "reversal") {
            // ลุกสวนทันที: อินวัลน์สั้นๆ ให้แทรกท่าโจมตีได้ทันทีที่ลุกขึ้น
            p.invulnUntil = now + 160;
            sfx.special();
        }
        p.state = "idle";
    }
}

// รับอินพุตเลือกท่าลุก (เฉพาะผู้เล่นในเครื่องนี้) ในช่วงท้ายๆ ก่อนจะลุกจากพื้นจริง
function handleWakeupInput(p) {
    if (!p || p.state !== "knockdown" || p.wakeupChoice) return;
    const now = Date.now();
    const timeLeft = (p.stunUntil || 0) - now;
    if (timeLeft <= 0 || timeLeft > WAKEUP_WINDOW_MS) return;
    const rollKey = p.facing === 1 ? keys.a : keys.d; // กดถอยหนีออกจากคู่ต่อสู้
    if (rollKey) p.wakeupChoice = "roll";
}

function gainMeter(p, amt) {
    p.super = Math.min(MAX_METER, (p.super || 0) + (amt || 0));
}

// -- ท่าธรรมดา: ต่อย/เตะ x เบา/กลาง/หนัก, ท่ากวาดขา (Sweep), ท่าพุ่งโจมตี (Dash Attack) --
function attackWith(p, type, strength) {
    if (!p || gameOver) return;
    const now = Date.now();

    // กดปุ่มโจมตีระหว่างช่วงท้ายของการล้ม = เลือกลุกแบบ "สวนทันที" (ยังลุกไม่ได้ตอนนี้ แค่บันทึกท่าลุกไว้)
    if (p.state === "knockdown") {
        if (!p.wakeupChoice) {
            const timeLeft = (p.stunUntil || 0) - now;
            if (timeLeft > 0 && timeLeft <= WAKEUP_WINDOW_MS) p.wakeupChoice = "reversal";
        }
        return;
    }

    const inDash = p.state === "dash" && now < (p.dashAttackWindowUntil || 0);
    // ลอยตัวอยู่ (กระโดด/ตกอิสระ) และยังไม่เคยใช้ท่ากลางอากาศในเที่ยวนี้ = โจมตีกลางอากาศได้
    const airborne = !p.grounded && !p.action && !p.airActionUsed &&
        (p.state === "jump" || p.state === "idle") && p.state !== "hitstun" && p.state !== "blockstun" && p.state !== "knockdown";
    if (!inDash && !airborne && !canAct(p)) return;

    const char = getChar(p);
    const crouch = p.crouching;
    let def, timing;
    p.armorHitsLeft = 0; // เคลียร์เกราะเก่าทิ้งก่อนเริ่มท่าใหม่ (กันเกราะค้างจากท่าก่อนหน้า)

    if (airborne) {
        const st = STRENGTH[strength];
        timing = AIR_ATTACK_TIMING[strength] || AIR_ATTACK_TIMING.light;
        def = {
            id: "air_" + type + "_" + strength, type, strength, isLow: false, knockdown: false, isAir: true,
            dmg: Math.round((type === "kick" ? char.kickDmg : char.punchDmg) * st.dmg * 0.85),
            range: (type === "kick" ? char.kickRange : char.punchRange) - 2,
            hitstunMs: Math.round(st.hitstun * 0.8), blockstunMs: Math.round(st.blockstun * 0.8),
            meterGain: strength === "heavy" ? 7 : (strength === "medium" ? 5 : 3)
        };
        p.airActionUsed = true;
    } else if (inDash) {
        timing = DASH_ATTACK_TIMING;
        def = {
            id: "dashAttack", type, strength, isLow: false, knockdown: false,
            dmg: Math.round((type === "kick" ? char.kickDmg : char.punchDmg) * 1.3),
            range: (type === "kick" ? char.kickRange : char.punchRange) + 18,
            hitstunMs: 340, blockstunMs: 190, meterGain: 7
        };
        p.vx = p.facing * 6.5;
        p.dashAttackWindowUntil = 0;
        if (char.hasSuperArmor) p.armorHitsLeft = 1; // Titan Dash: กันโดนโจมตีเบา 1 ฮิตระหว่างพุ่งชน
    } else if (crouch && type === "kick" && strength === "heavy") {
        timing = SWEEP_TIMING;
        def = {
            id: "sweep", type: "kick", strength: "heavy", isLow: true, knockdown: true,
            dmg: Math.round(char.kickDmg * 1.3), range: char.kickRange - 4,
            hitstunMs: 0, blockstunMs: 280, meterGain: 9
        };
    } else {
        const st = STRENGTH[strength];
        timing = NORMAL_TIMING[strength];
        if (strength === "light" && char.plusOnBlock) {
            // ท่าเบา "Plus on block": ฟื้นตัวเร็วกว่าปกติ กดต่อเนื่องบีบคู่ต่อสู้ได้
            timing = Object.assign({}, timing, { recovery: Math.max(70, timing.recovery - 60) });
        }
        def = {
            id: type + "_" + strength, type, strength, isLow: crouch, knockdown: false,
            dmg: Math.round((type === "kick" ? char.kickDmg : char.punchDmg) * st.dmg),
            range: (type === "kick" ? char.kickRange : char.punchRange) - (crouch ? 4 : 0),
            hitstunMs: st.hitstun, blockstunMs: st.blockstun,
            meterGain: strength === "heavy" ? 9 : (strength === "medium" ? 6 : 3),
            cancelable: strength !== "heavy"
        };
        if (type === "punch" && strength === "heavy" && char.armorOnHeavy) p.armorHitsLeft = 1;
    }
    beginAction(p, def, timing);
}

function doAttack(type, strength) { attackWith(localPlayer(), type, strength); }
function doHeavy() {
    const p = localPlayer();
    if (!p) return;
    doAttack(p.crouching ? "kick" : "punch", "heavy");
}

// -- การทุ่ม (Throw / Grapple) --
function tryThrow(p) {
    if (!canAct(p)) return;
    const char = getChar(p);
    const timing = char.slowThrow
        ? Object.assign({}, THROW_TIMING, { recovery: THROW_TIMING.recovery + 140 })
        : THROW_TIMING;
    beginAction(p, {
        id: "throw", isThrow: true, range: THROW_RANGE, dmg: 12,
        hitstunMs: 0, knockdown: true, meterGain: 8,
        knockbackPush: char.bigThrowKnockback ? 70 : 30
    }, timing);
}
function doThrow() { tryThrow(localPlayer()); }

// -- Command Grab (เฉพาะตัวละครที่ hasCommandGrab): ระยะกว้างกว่าทุ่มปกติ ทะลุการบล็อก 100% --
function tryCommandGrab(p) {
    if (!canActOrCancel(p)) return;
    const char = getChar(p);
    beginAction(p, {
        id: "commandGrab", isThrow: true, range: THROW_RANGE + 34, dmg: (char.punchDmg || 10) + 14,
        hitstunMs: 0, knockdown: true, meterGain: 10, knockbackPush: 24
    }, { startup: 230, active: 90, recovery: 460 });
    sfx.special();
}

// -- ท่าพิเศษ: ย่อ+พิเศษ = สวนกลับกลางอากาศ (Anti-air) / ยืน+พิเศษ = ปล่อยพลัง (Projectile) --
function tryAntiAir(p) {
    if (!canActOrCancel(p)) return;
    const char = getChar(p);
    beginAction(p, {
        id: "antiair", type: "special", isLow: false, knockdown: true,
        dmg: Math.round(char.punchDmg * 1.4), range: 50,
        hitstunMs: 0, blockstunMs: 260, meterGain: 10, invulnStartup: true
    }, ANTIAIR_TIMING);
    p.vy = JUMP_FORCE * 0.85;
    p.grounded = false;
    sfx.special();
}
// -- Sword Lunge (เฉพาะตัวละครที่ hasSwordLunge): พุ่งฟันดาบระยะไกล แทนการปล่อยพลัง --
const SWORD_LUNGE_TIMING = { startup: 150, active: 160, recovery: 300 };
function trySwordLunge(p) {
    if (!canActOrCancel(p)) return;
    const char = getChar(p);
    beginAction(p, {
        id: "swordLunge", type: "special", isLow: false, knockdown: false,
        dmg: Math.round(char.punchDmg * 1.6), range: 100,
        dashMove: true, hitstunMs: 420, blockstunMs: 240, meterGain: 9
    }, SWORD_LUNGE_TIMING);
    p.vx = p.facing * 9;
    sfx.special();
}
// -- Teleport (เฉพาะตัวละครที่ hasTeleport): วาร์ปสั้นๆ แทนโปรเจกไทล์ อินวัลน์เต็มระหว่างวาร์ป
// หลบได้ทั้งท่าโจมตีแนวสูง/แนวราบ/โปรเจกไทล์ เพราะฮิตบ็อกซ์เดิมหายไปทั้งตัวทันที ---
const TELEPORT_TIMING = { startup: 70, active: 60, recovery: 260 };
const TELEPORT_DISTANCE = 150;
function tryTeleport(p) {
    if (!canActOrCancel(p)) return;
    const now = Date.now();
    const char = getChar(p);
    // เดินหน้า(หรือไม่กดทิศ) = วาร์ปเข้าหา, กดถอยหลัง(ท่าบล็อก) = วาร์ปหนีออกห่าง
    const dir = p.holdingBack ? -p.facing : p.facing;
    const fromX = p.x;
    let toX = p.x + dir * TELEPORT_DISTANCE;
    toX = Math.max(0, Math.min(canvas.width - p.width, toX));
    beginAction(p, {
        id: "teleport", type: "special", isLow: false, knockdown: false,
        dmg: 0, range: -1, noHit: true,
        hitstunMs: 0, blockstunMs: 0, meterGain: 6
    }, TELEPORT_TIMING);
    p.invulnUntil = now + TELEPORT_TIMING.startup + TELEPORT_TIMING.active;
    p.x = toX;
    spawnHitSparks(fromX + p.width / 2, p.y - 14, char.accent, 9);
    spawnHitSparks(toX + p.width / 2, p.y - 14, char.accent, 9);
    gainMeter(p, 6);
    sfx.teleport();
}
// -- Taunt (ยั่วคู่ต่อสู้): เสี่ยงโดนตีฟรีเพราะบล็อกไม่ได้ระหว่างทำท่า แลกกับเกจพลังที่ได้ทันที ---
const TAUNT_TIMING = { startup: 100, active: 550, recovery: 250 };
const TAUNT_METER_GAIN = 18;
function tryTaunt(p) {
    if (!canAct(p)) return; // ยั่วได้เฉพาะตอนว่างๆ ไม่แทรกกลางท่าอื่น
    const char = getChar(p);
    beginAction(p, {
        id: "taunt", type: "taunt", isLow: false, knockdown: false,
        dmg: 0, range: -1, noHit: true,
        hitstunMs: 0, blockstunMs: 0, meterGain: 0
    }, TAUNT_TIMING);
    const lines = char.tauntLines || ["ยั่วเล่นๆ!"];
    p.tauntText = lines[Math.floor(Math.random() * lines.length)];
    p.tauntPopupUntil = Date.now() + TAUNT_TIMING.startup + TAUNT_TIMING.active + 300;
    gainMeter(p, TAUNT_METER_GAIN);
    sfx.taunt();
}
function doTaunt() { tryTaunt(localPlayer()); }

function tryProjectile(p) {
    const now = Date.now();
    if (!canActOrCancel(p) || now < (p.projectileCooldownUntil || 0)) return;
    const char = getChar(p);
    beginAction(p, {
        id: "projectile", type: "special", isLow: false, knockdown: false,
        dmg: char.projectileDmg, range: 0, spawnsProjectile: true,
        hitstunMs: 380, blockstunMs: 210, meterGain: 8
    }, PROJECTILE_TIMING);
    p.projectileCooldownUntil = now + PROJECTILE_COOLDOWN + PROJECTILE_TIMING.startup;
    sfx.special();
}
function doSpecial() {
    const p = localPlayer();
    if (!p) return;
    const char = getChar(p);
    if (p.crouching) { tryAntiAir(p); return; }
    if (char.hasTeleport) { tryTeleport(p); return; }
    if (char.hasCommandGrab) { tryCommandGrab(p); return; }
    if (char.hasSwordLunge) { trySwordLunge(p); return; }
    tryProjectile(p);
}

function spawnProjectile(p) {
    const char = getChar(p);
    p.projectile = {
        x: p.x + p.width / 2 + p.facing * p.width,
        y: p.y + p.height * 0.35,
        vx: p.facing * (char.projectileSpeed || 7.5),
        dmg: p.action.dmg
    };
}
function updateProjectilesMotion(p) {
    if (!p.projectile) return;
    p.projectile.x += p.projectile.vx;
    if (p.projectile.x < -20 || p.projectile.x > canvas.width + 20) p.projectile = null;
}

// -- เกจพลัง / ท่าไม้ตายสุดยอด (Super Art) --
function trySuper(p) {
    if (!canActOrCancel(p) || (p.super || 0) < MAX_METER) return;
    const char = getChar(p);
    let timing = SUPER_TIMING;
    const def = {
        id: char.superType ? char.superType : "super", type: "super", isLow: false, knockdown: true,
        dmg: char.superDmg, range: 70,
        hitstunMs: 0, blockstunMs: 320, meterGain: 0, invulnStartup: true
    };

    if (char.superType === "flurry") {
        // Lightning Flurry: พุ่งเข้าใส่แล้วรัวหมัด 3 ฮิตติดกัน โดนแล้วดาเมจสูง แต่ถ้าบล็อกติดจะเปิดช่องโหว่นาน
        def.range = 95;
        def.dashMove = true;
        def.hits = 3;
        def.hitInterval = 130;
        def.dmg = Math.round(char.superDmg / 3);
        timing = { startup: 150, active: 320, recovery: 560 };
        p.vx = p.facing * 14;
    } else if (char.superType === "grab") {
        // Earthquake Piledriver: จับทุ่มทะลุการบล็อก ดาเมจมหาศาล แต่ต้องประชิดตัวมากๆ
        def.isThrow = true;
        def.range = 55;
        timing = { startup: 260, active: 110, recovery: 480 };
    } else if (char.superType === "haymaker") {
        // Haymaker: หมัดเดียวจบ พุ่งเข้าประชิดสั้นๆ ทนโดนท่าเบาระหว่างพุ่ง (Super Armor) ดาเมจสูงสุดในเกม
        def.range = 60;
        def.dashMove = true;
        timing = { startup: 180, active: 180, recovery: 460 };
        p.vx = p.facing * 10;
        p.armorHitsLeft = 1;
    } else if (char.superType === "barrage") {
        // Thunder Barrage: เตะรัว 4 ฮิตติดกันอยู่กับที่ ระยะไกล จบด้วยล้ม
        def.range = 110;
        def.hits = 4;
        def.hitInterval = 110;
        def.dmg = Math.round(char.superDmg / 4);
        timing = { startup: 130, active: 480, recovery: 460 };
    } else if (char.superType === "iaido") {
        // Iaido: ชักดาบฟันระยะไกลสุดในเกม ดาเมจสูง แลกกับสตาร์ทอัพช้าที่สุด
        def.range = 130;
        def.dashMove = true;
        timing = { startup: 300, active: 160, recovery: 520 };
        p.vx = p.facing * 12;
    } else if (char.superType === "phantom") {
        // Phantom Slash: ภาพลวงตาฟันรัว 2 ครั้งอยู่กับที่ ระยะไกลกว่าท่าไม้ตายตัวอื่น
        def.range = 95;
        def.hits = 2;
        def.hitInterval = 150;
        def.dmg = Math.round(char.superDmg / 2);
        timing = { startup: 130, active: 320, recovery: 440 };
    }

    beginAction(p, def, timing);
    p.super = 0;
    sfx.super();
}
function doSuper() { trySuper(localPlayer()); }

// -- พุ่งตัว (Dash / Backdash): กดทิศทางซ้ำเร็วๆ --
function tryDash(dir) {
    const p = localPlayer();
    if (!p || !canAct(p) || p.crouching) return;
    const now = Date.now();
    if (now < (p.dashCooldownUntil || 0)) {
        if (dir === "left") p.lastTapLeft = now; else p.lastTapRight = now;
        return;
    }
    const last = dir === "left" ? p.lastTapLeft : p.lastTapRight;
    if (dir === "left") p.lastTapLeft = now; else p.lastTapRight = now;
    if (now - last < DASH_TAP_WINDOW) {
        startDash(p, dir === "left" ? -1 : 1);
    }
}
function startDash(p, dir) {
    const now = Date.now();
    const char = getChar(p);
    p.state = "dash";
    p.vx = dir * (char.dashSpeed || DASH_SPEED);
    p.dashUntil = now + DASH_MS;
    p.dashCooldownUntil = now + DASH_MS + DASH_COOLDOWN;
    p.dashAttackWindowUntil = now + DASH_MS + 160;
    sfx.dash();
}

// --- 5a. ลอจิกของ Bot ---
function runBotAI() {
    const p = p2, opp = p1;
    if (p.state === "hitstun" || p.state === "blockstun" || p.state === "throw") {
        return;
    }
    if (p.state === "knockdown") {
        // บอทสุ่มเลือกท่าลุกเหมือนผู้เล่นจริง ให้ดูมีชีวิตชีวาไม่ลุกแบบเดิมทุกครั้ง
        if (!p.wakeupChoice) {
            const timeLeft = (p.stunUntil || 0) - Date.now();
            if (timeLeft > 0 && timeLeft <= WAKEUP_WINDOW_MS) {
                const roll = Math.random();
                if (roll < 0.35) p.wakeupChoice = "roll";
                else if (roll < 0.55) p.wakeupChoice = "reversal";
            }
        }
        return;
    }
    const char = getChar(p);

    // Cancel: ถ้าเพิ่งตีท่าเบา/กลางโดนแล้วยังอยู่ในหน้าต่าง Cancel บอทมีโอกาสแทรกท่าพิเศษ/ซุปเปอร์ต่อ
    if (p.state === "attack") {
        const inCancelWindow = Date.now() < (p.cancelWindowUntil || 0);
        if (!inCancelWindow) return;
        const roll = Math.random();
        if (roll < 0.55 && (p.super || 0) >= MAX_METER) {
            trySuper(p);
        } else if (roll < 0.85) {
            if (char.hasCommandGrab) tryCommandGrab(p);
            else if (char.hasSwordLunge) trySwordLunge(p);
            else if (char.hasTeleport) tryTeleport(p);
            else tryProjectile(p);
        }
        // roll >= 0.85: ปล่อยผ่าน ไม่แทรกท่า ให้ท่าเดิม recovery จบไปตามปกติ (กันบอทกดคอมโบทุกครั้งจนดูเป็นหุ่นยนต์เกินไป)
        return;
    }

    const botWalkSpeed = (char.walkSpeed || WALK_SPEED) * 0.62;
    const dx = opp.x - p.x;
    const dist = Math.abs(dx);

    if (dist > 90) {
        p.x += dx > 0 ? botWalkSpeed : -botWalkSpeed;
        p.crouching = false;
        p.state = "walk";
        if (Math.random() < 0.004 && p.grounded) {
            p.vy = (char.jumpForce || JUMP_FORCE); p.grounded = false; p.state = "jump";
            p.vx = dx > 0 ? JUMP_HFORCE : -JUMP_HFORCE;
        }
        if (Math.random() < 0.006 && !char.hasCommandGrab) {
            if (char.hasSwordLunge) trySwordLunge(p); else tryProjectile(p);
        }
    } else if (dist > 55) {
        p.crouching = Math.random() < 0.15;
        p.state = p.crouching ? "crouch" : "idle";
        if (Math.random() < 0.025) attackWith(p, Math.random() < 0.5 ? "punch" : "kick", Math.random() < 0.3 ? "heavy" : "medium");
    } else {
        const roll = Math.random();
        if (roll < 0.015) {
            if (char.hasCommandGrab) tryCommandGrab(p); else tryThrow(p);
        } else if (roll < 0.045) {
            p.crouching = Math.random() < 0.5;
            attackWith(p, Math.random() < 0.5 ? "punch" : "kick", p.crouching ? "heavy" : "light");
        } else if (roll < 0.06 && (p.super || 0) >= MAX_METER) {
            trySuper(p);
        } else if (Math.random() < 0.012 && p.grounded) {
            p.vy = JUMP_FORCE; p.grounded = false; p.state = "jump";
        } else {
            p.holdingBack = Math.random() < 0.35;
            p.crouching = false;
            p.state = "idle";
        }
    }
}

// --- 5b. ตรวจการโดนตี (เฉพาะ bot / host เป็นผู้ตัดสิน) ---
function isBlocking(p) {
    return p.grounded && p.holdingBack && (p.state === "idle" || p.state === "walk" || p.state === "crouch");
}

function resolveAttackAgainst(attacker, defender) {
    if (!attacker.action) return;
    if (attacker.state !== "attack" && attacker.state !== "throw") return;
    const maxHits = attacker.action.hits || 1;
    const hitsDone = attacker.action.hitsDone || 0;
    if (attacker.action.phase !== "active" || hitsDone >= maxHits) return;
    if (attacker.action.spawnsProjectile) return;
    if (attacker.action.noHit) return;
    const now = Date.now();
    if (now < (attacker.action.nextHitAt || 0)) return; // ท่าหลายฮิต (เช่น Barrage/Flurry) ต้องเว้นจังหวะระหว่างฮิต
    if (now < (defender.invulnUntil || 0)) return;

    const distance = Math.abs((attacker.x + attacker.width / 2) - (defender.x + defender.width / 2));
    if (distance > attacker.action.range) return;

    const isThrow = !!attacker.action.isThrow;
    if (isThrow) {
        const busy = ["hitstun", "blockstun", "knockdown", "attack", "throw"].includes(defender.state);
        if (!defender.grounded || busy) return; // ท่ากดจับใช้ไม่ได้ถ้าคู่ต่อสู้กำลังโจมตี/ลอยตัว/ล้มอยู่แล้ว
    }

    attacker.action.hitsDone = hitsDone + 1;
    if (attacker.action.hitsDone < maxHits) {
        attacker.action.nextHitAt = now + (attacker.action.hitInterval || 120);
    }
    const isFinalHit = attacker.action.hitsDone >= maxHits;

    // Super Armor: ถ้าตัวละครกำลังอยู่ในท่าที่ติดเกราะ (Titan Dash ของ Bruiser / หมัดหนักของ Boxer)
    // และโดนแค่โจมตีเบา จะไม่ติด Hitstun แค่เสียเลือดแล้วทำท่าต่อได้
    if (!isThrow && (defender.armorHitsLeft || 0) > 0 &&
        defender.state === "attack" && attacker.action.strength === "light") {
        defender.hp -= Math.round(attacker.action.dmg * rageMult(attacker));
        defender.hp = Math.max(0, defender.hp);
        defender.hitFlashUntil = now + 100;
        defender.armorHitsLeft -= 1;
        gainMeter(attacker, Math.round((attacker.action.meterGain || 4) * 0.5));
        gainMeter(defender, 3);
        defender.lastHit = now;
        sfx.block();
        return;
    }

    const low = !!attacker.action.isLow;
    const stillBlockingString = defender.state === "blockstun" && maxHits > 1;
    const blocked = !isThrow && (isBlocking(defender) || stillBlockingString) && (!low || defender.crouching);

    if (blocked) {
        const isParry = now - (defender.blockStartAt || 0) <= PARRY_WINDOW_MS;
        if (isParry) {
            // Parry: กดบล็อกแม่นจังหวะ ไม่โดนดาเมจเลย แถมผู้โจมตีเสียหลักให้สวนกลับได้ฟรี
            defender.blockStartAt = 0; // กันสวนซ้ำถ้าท่านั้นมีหลายฮิต
            defender.parryFlashUntil = now + 280;
            gainMeter(defender, 20);
            attacker.state = "hitstun";
            attacker.stunUntil = now + PARRY_PUNISH_MS;
            attacker.action = null;
            attacker.hitFlashUntil = now + 120;
            attacker.x -= attacker.facing * 6;
            spawnHitSparks(defender.x + defender.width / 2 + attacker.facing * 10, defender.y + defender.height * 0.4, "#00ffff", 14);
            triggerHitStop(90);
            triggerShake(140, 4);
            sfx.parry();
            return;
        }
        const dmg = Math.max(1, Math.round(attacker.action.dmg * rageMult(attacker) * 0.12));
        defender.hp -= dmg;
        defender.state = "blockstun";
        defender.stunUntil = now + (attacker.action.blockstunMs || 200);
        defender.x += attacker.facing * 3;
        defender.hitFlashUntil = now + 80;
        const blockMeterGain = attacker.action.meterGain != null ? attacker.action.meterGain : 4;
        gainMeter(attacker, Math.round(blockMeterGain * 0.5));
        gainMeter(defender, 2);
        defender.comboCount = 0;
        sfx.block();
    } else {
        defender.hp -= Math.round(attacker.action.dmg * rageMult(attacker));
        defender.hitFlashUntil = now + 150;
        defender.action = null;
        const meterGain = attacker.action.meterGain != null ? attacker.action.meterGain : 5;
        gainMeter(attacker, meterGain);
        gainMeter(defender, 5);

        // Hit Sparks: เศษอนุภาคกระเด็นจากจุดที่โดนตี
        const sparkX = defender.x + defender.width / 2 - attacker.facing * 6;
        const sparkY = defender.y + defender.height * 0.4;
        spawnHitSparks(sparkX, sparkY, isThrow ? "#ffffff" : "#ffdd00", isThrow ? 10 : 7);

        // ตัวนับคอมโบ: ถ้าโดนตีซ้ำระหว่างที่ยังติด Hitstun เดิมอยู่ ให้นับคอมโบต่อ
        const chained = defender.state === "hitstun" && now < (defender.stunUntil || 0);
        defender.comboCount = chained ? (defender.comboCount || 1) + 1 : 1;
        if (defender.comboCount >= 2) {
            defender.comboPopupBorn = now;
            defender.comboPopupUntil = now + 900;
        }

        // Hit Stop / Screen Shake: เพิ่มความสะใจให้ท่าหนักๆ
        const bigHit = attacker.action.strength === "heavy" || attacker.action.type === "super" ||
            attacker.action.id === "sweep" || attacker.action.id === "commandGrab" ||
            attacker.action.id === "swordLunge";
        if (bigHit) triggerHitStop(attacker.action.type === "super" ? 90 : 60);
        if (isThrow) triggerShake(200, 5);
        if (attacker.action.type === "super") triggerShake(260, 8);

        if (isThrow) sfx.throwMove(); else sfx.hit(attacker.action.strength || "medium");

        // Cancel: ถ้าเป็นท่าเบา/กลางที่ตั้งค่าไว้ว่า cancelable และตีโดนแล้ว
        // เปิดหน้าต่างเวลาสั้นๆ ให้ผู้โจมตีแทรกท่าพิเศษ/ซุปเปอร์เข้าไปได้ทันที (ฟีลแบบ Street Fighter)
        if (attacker.action.cancelable && isFinalHit) {
            attacker.cancelWindowUntil = now + CANCEL_WINDOW_MS;
        }

        if (attacker.action.knockdown && isFinalHit) {
            defender.state = "knockdown";
            defender.stunUntil = now + 900;
            defender.grounded = true;
            defender.vy = 0;
            defender.x += attacker.facing * (attacker.action.knockbackPush || 30);
            sfx.knockdown();
        } else {
            defender.state = "hitstun";
            defender.stunUntil = now + (attacker.action.hitstunMs || 300);
            const push = attacker.action.strength === "heavy" ? 20 : (attacker.action.strength === "medium" ? 13 : 7);
            defender.x += attacker.facing * push;
        }
    }
    defender.hp = Math.max(0, defender.hp);
    defender.lastHit = now;
}

function resolveProjectile(owner, target) {
    const pr = owner.projectile;
    if (!pr) return;
    if (Date.now() < (target.invulnUntil || 0)) return;
    const distance = Math.abs(pr.x - (target.x + target.width / 2));
    if (distance > 24) return;
    owner.projectile = null;

    const now = Date.now();
    const blocked = isBlocking(target);
    if (blocked) {
        const dmg = Math.max(1, Math.round(pr.dmg * rageMult(owner) * 0.15));
        target.hp -= dmg;
        target.state = "blockstun";
        target.stunUntil = now + 220;
        target.hitFlashUntil = now + 80;
    } else {
        target.hp -= Math.round(pr.dmg * rageMult(owner));
        target.state = "hitstun";
        target.stunUntil = now + 380;
        target.hitFlashUntil = now + 150;
        target.action = null;
        target.x += owner.facing * 10;
    }
    target.hp = Math.max(0, target.hp);
    gainMeter(owner, 4);
    gainMeter(target, 4);
}

// ถ้าทั้งคู่อยู่ในสถานะ "throw" พร้อมกัน (กดทุ่มใกล้เคียงกันพอ) = หลุดทุ่มทั้งคู่ ไม่มีฝ่ายไหนโดนทุ่ม
function checkThrowTech() {
    if (p1.state !== "throw" || p2.state !== "throw") return false;
    if (!p1.action || !p2.action || !p1.action.isThrow || !p2.action.isThrow) return false;

    const now = Date.now();
    p1.action = null; p2.action = null;
    p1.state = "idle"; p2.state = "idle";

    // ผลักออกจากกัน (เช็คทิศทางจากตำแหน่งจริง กันกรณีตัวละครสลับฝั่งกัน)
    const dir = (p1.x + p1.width / 2) <= (p2.x + p2.width / 2) ? 1 : -1;
    p1.x -= dir * 24;
    p2.x += dir * 24;
    clampX(p1); clampX(p2);

    gainMeter(p1, 5); gainMeter(p2, 5);
    p1.hitFlashUntil = now + 120; p2.hitFlashUntil = now + 120;

    throwTechX = (p1.x + p1.width / 2 + p2.x + p2.width / 2) / 2;
    throwTechY = GROUND_Y - 40;
    throwTechUntil = now + 700;
    spawnHitSparks(throwTechX, throwTechY, "#ffffff", 12);
    triggerHitStop(80);
    sfx.parry();
    return true;
}

function checkHits() {
    if (gameOver) return;
    if (checkThrowTech()) {
        p1.hp = Math.max(0, p1.hp);
        p2.hp = Math.max(0, p2.hp);
        if (gameMode === "host") {
            db.ref("rooms/" + roomId + "/combat").set({ p1hp: p1.hp, p2hp: p2.hp });
        }
        return;
    }
    resolveAttackAgainst(p1, p2);
    resolveAttackAgainst(p2, p1);
    resolveProjectile(p1, p2);
    resolveProjectile(p2, p1);

    p1.hp = Math.max(0, p1.hp);
    p2.hp = Math.max(0, p2.hp);

    if (gameMode === "host") {
        // ส่งผลพลังชีวิตที่ตัดสินแล้วกลับไปให้ฝั่ง Guest (สำหรับโหมดออนไลน์)
        db.ref("rooms/" + roomId + "/combat").set({ p1hp: p1.hp, p2hp: p2.hp });
    }
}

// --- 5c. ระบบพลังชีวิต / เกจซุปเปอร์ (HUD) ---
function updateHealthUI() {
    const hp1 = document.getElementById("hp1-fill");
    const hp2 = document.getElementById("hp2-fill");
    const p1Max = p1.maxHp || 100, p2Max = p2.maxHp || 100;
    if (hp1) {
        hp1.style.width = Math.max(0, (p1.hp / p1Max) * 100) + "%";
        hp1.classList.toggle("rage", rageMult(p1) > 1);
    }
    if (hp2) {
        hp2.style.width = Math.max(0, (p2.hp / p2Max) * 100) + "%";
        hp2.classList.toggle("rage", rageMult(p2) > 1);
    }

    const sp1 = document.getElementById("super1-fill");
    const sp2 = document.getElementById("super2-fill");
    if (sp1) sp1.style.width = Math.max(0, p1.super || 0) + "%";
    if (sp2) sp2.style.width = Math.max(0, p2.super || 0) + "%";

    const myPlayer = localPlayer();
    const superBtn = document.getElementById("btn-super");
    if (superBtn) superBtn.classList.toggle("ready", !!myPlayer && (myPlayer.super || 0) >= MAX_METER);
}

// อีกฝ่ายหลุดการเชื่อมต่อ (ปิดแท็บ/เน็ตหลุด) กลางเกม Online: จบเกมทันทีแทนที่จะค้างรอเฉยๆ
function handleOpponentDisconnect() {
    if (gameOver) return;
    gameOver = true;
    stopRoundTimer();
    stopBGM();
    const winnerText = document.getElementById("winner-text");
    const winnerQuote = document.getElementById("winner-quote");
    const nextBtn = document.getElementById("next-round-btn");
    const restartBtn = document.getElementById("restart-btn");
    if (winnerText) winnerText.innerText = "อีกฝ่ายหลุดการเชื่อมต่อ 🔌";
    if (winnerQuote) winnerQuote.innerText = "";
    if (nextBtn) nextBtn.style.display = "none";
    if (restartBtn) restartBtn.style.display = "inline-block";
    const overlay = document.getElementById("round-over");
    if (overlay) overlay.style.display = "flex";
}

function endRound(winner) {
    if (gameOver) return;
    gameOver = true;
    stopRoundTimer();

    // Juice: ค้างท่าชนะ/ท่าแพ้ไว้ให้เห็นก่อนจอผลจะเด้งขึ้นมาทับ
    if (winner) {
        winner.state = "victory";
        winner.action = null;
        const loser = opponentOf(winner);
        loser.state = "knockdown";
        loser.grounded = true;
        loser.vy = 0;
        loser.action = null;
    } else {
        [p1, p2].forEach(p => {
            p.state = "knockdown";
            p.grounded = true;
            p.vy = 0;
            p.action = null;
        });
    }

    if (winner) roundWins[winner === p1 ? "p1" : "p2"] += 1;
    updateRoundPips();

    const matchWinner = roundWins.p1 >= 2 ? p1 : (roundWins.p2 >= 2 ? p2 : null);
    const winnerText = document.getElementById("winner-text");
    const winnerQuote = document.getElementById("winner-quote");
    const nextBtn = document.getElementById("next-round-btn");
    const restartBtn = document.getElementById("restart-btn");

    if (matchWinner) {
        const wChar = getChar(matchWinner);
        const label = matchWinner === p1 ? "P1" : "P2";
        winnerText.innerText = `${label} (${wChar.name}) ชนะการแข่งขัน! 🏆 (${roundWins.p1}-${roundWins.p2})`;
        if (winnerQuote) {
            const lines = wChar.winLines || [];
            winnerQuote.innerText = lines.length ? `"${lines[Math.floor(Math.random() * lines.length)]}"` : "";
        }
        if (nextBtn) nextBtn.style.display = "none";
        if (restartBtn) restartBtn.style.display = "inline-block";
        sfx.roundWin();
    } else if (winner) {
        const wChar = getChar(winner);
        const label = winner === p1 ? "P1" : "P2";
        winnerText.innerText = `${label} (${wChar.name}) ชนะยกที่ ${currentRound}! (${roundWins.p1}-${roundWins.p2})`;
        if (winnerQuote) {
            const lines = wChar.winLines || [];
            winnerQuote.innerText = lines.length ? `"${lines[Math.floor(Math.random() * lines.length)]}"` : "";
        }
        if (nextBtn) nextBtn.style.display = "inline-block";
        if (restartBtn) restartBtn.style.display = "inline-block";
        sfx.roundWin();
    } else {
        winnerText.innerText = `หมดเวลา - เสมอ! (${roundWins.p1}-${roundWins.p2})`;
        if (winnerQuote) winnerQuote.innerText = "";
        if (nextBtn) nextBtn.style.display = "inline-block";
        if (restartBtn) restartBtn.style.display = "inline-block";
        sfx.roundDraw();
    }

    // หน่วงเวลาก่อนโชว์จอผลแพ้ชนะ ให้ทันเห็นท่าชนะ/ท่าล้มก่อน
    setTimeout(() => {
        document.getElementById("round-over").style.display = "flex";
    }, 550);
}

// --- 6. วาดตัวละครแบบมีรูปร่าง (หัว-ลำตัว-แขน-ขา) สไตล์ Street Fighter ---
function trackMovement(p) {
    if (p.prevX === undefined) p.prevX = p.x;
    p.isMoving = Math.abs(p.x - p.prevX) > 0.3;
    p.prevX = p.x;
}

function drawLimb(x, y, midDx, midDy, endDx, endDy, width) {
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + midDx, midDy);
    ctx.lineTo(x + endDx, endDy);
    ctx.stroke();
}

function updateFacing(p, opp) {
    if (["attack", "throw", "hitstun", "blockstun", "knockdown"].includes(p.state)) return;
    const cx = p.x + p.width / 2;
    p.facing = (opp.x + opp.width / 2) >= cx ? 1 : -1;
}

function drawFighter(p, opp) {
    const char = getChar(p);
    const cx = p.x + p.width / 2;
    const f = p.facing;
    const jumping = !p.grounded;
    const crouching = p.crouching && p.grounded;
    const knockedDown = p.state === "knockdown";
    const blocking = p.state === "blockstun" || isBlocking(p);
    const flashing = Date.now() < p.hitFlashUntil;
    const a = p.action;
    const kicking = p.state === "attack" && a && a.type === "kick" && a.id !== "dashAttack";
    const punching = p.state === "attack" && a && (a.type === "punch" || a.id === "sweep" ? false : a.type === "punch");
    const isSweep = p.state === "attack" && a && a.id === "sweep";
    const isDashAttack = p.state === "attack" && a && (a.id === "dashAttack" || a.id === "haymaker" || a.id === "iaido" || a.id === "swordLunge" || a.id === "flurry");
    const isThrowing = p.state === "throw";
    const isSpecial = p.state === "attack" && a && (a.id === "projectile" || a.id === "antiair" || a.id === "super" || a.id === "barrage" || a.id === "teleport" || a.id === "phantom");
    const isVictory = p.state === "victory";
    const isTaunting = p.state === "attack" && a && a.type === "taunt";
    const parrying = Date.now() < (p.parryFlashUntil || 0);
    const invulnActive = Date.now() < (p.invulnUntil || 0);

    ctx.save();
    ctx.strokeStyle = flashing ? "#ffffff" : (parrying ? "#00ffff" : char.color);
    ctx.fillStyle = flashing ? "#ffffff" : (parrying ? "#00ffff" : char.color);
    ctx.lineCap = "round";
    if (invulnActive) ctx.globalAlpha = 0.45 + 0.35 * Math.sin(Date.now() / 45); // ระยิบระยับตอนอมตะชั่วคราว (parry punish window/wake-up/ท่าพิเศษ)

    if (knockedDown) {
        // ท่านอนล้มกับพื้น
        const groundLineY = p.y + p.height - 4;
        ctx.lineWidth = 8;
        ctx.beginPath();
        ctx.moveTo(cx - 22, groundLineY);
        ctx.lineTo(cx + 20 * f, groundLineY);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx - 26, groundLineY - 3, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        return;
    }

    const feetY = p.y + p.height;
    const legLen = jumping ? 15 : (crouching ? 13 : 24);
    const hipY = feetY - legLen;
    const shoulderY = hipY - (crouching ? 13 : 20);
    const headR = 7;
    const headY = shoulderY - headR - 1;

    if (!jumping && !kicking && !crouching && p.isMoving) {
        p.legPhase += 0.35;
    } else if (!jumping && !kicking) {
        p.legPhase = 0;
    }

    // ขา
    if (isSweep) {
        drawLimb(cx, hipY, f * 16, hipY + 6, f * 40, hipY + 10, 7);
        drawLimb(cx, hipY, -f * 4, hipY + 10, -f * 3, feetY, 6);
    } else if (kicking) {
        drawLimb(cx, hipY, f * 14, hipY - 4, f * 34, hipY - 8, 7);
        drawLimb(cx, hipY, -f * 3, hipY + 16, -f * 2, feetY, 6);
    } else if (jumping) {
        drawLimb(cx, hipY, f * 9, hipY + 9, f * 5, feetY, 6);
        drawLimb(cx, hipY, -f * 4, hipY + 13, -f * 2, feetY - 3, 6);
    } else if (crouching) {
        drawLimb(cx, hipY, f * 8, hipY + 10, f * 6, feetY, 7);
        drawLimb(cx, hipY, -f * 8, hipY + 10, -f * 6, feetY, 7);
    } else {
        const swing = Math.sin(p.legPhase) * 9;
        drawLimb(cx, hipY, swing, hipY + 12, swing * 0.7, feetY, 6);
        drawLimb(cx, hipY, -swing, hipY + 12, -swing * 0.7, feetY, 6);
    }

    // ลำตัว
    const leanX = (p.state === "attack" || isThrowing) ? f * 4 : 0;
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(cx, hipY);
    ctx.lineTo(cx + leanX, shoulderY);
    ctx.stroke();

    // ผ้าคาดหัว/เครื่องประดับ
    ctx.strokeStyle = flashing ? "#ffffff" : char.accent;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx + leanX - headR, headY - 2);
    ctx.lineTo(cx + leanX + headR, headY - 2);
    ctx.stroke();

    // หัว
    ctx.fillStyle = flashing ? "#ffffff" : char.color;
    ctx.beginPath();
    ctx.arc(cx + leanX, headY, headR, 0, Math.PI * 2);
    ctx.fill();

    // แขน
    const shoulderX = cx + leanX;
    ctx.strokeStyle = flashing ? "#ffffff" : char.color;
    if (blocking) {
        // ยกแขนตั้งการ์ด
        drawLimb(shoulderX, shoulderY, f * 10, shoulderY - 4, f * 14, shoulderY - 10, 7);
        drawLimb(shoulderX, shoulderY, f * 8, shoulderY + 6, f * 10, shoulderY + 2, 6);
    } else if (isThrowing) {
        drawLimb(shoulderX, shoulderY, f * 14, shoulderY + 4, f * 26, shoulderY + 6, 7);
        drawLimb(shoulderX, shoulderY, f * 10, shoulderY - 2, f * 22, shoulderY - 4, 7);
    } else if (isTaunting) {
        // ท่ายั่ว: มือเท้าเอวสองข้าง โยกหัวเราะเยาะ
        drawLimb(shoulderX, shoulderY, f * 8, shoulderY + 10, -f * 2, hipY - 6, 6);
        drawLimb(shoulderX, shoulderY, -f * 8, shoulderY + 10, f * 2, hipY - 6, 6);
    } else if (isSpecial) {
        drawLimb(shoulderX, shoulderY, f * 14, shoulderY - 2, f * 30, shoulderY - 4, 7);
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(shoulderX + f * 30, shoulderY - 4, 6, 0, Math.PI * 2);
        ctx.fill();
    } else if (isDashAttack) {
        drawLimb(shoulderX, shoulderY, f * 16, shoulderY, f * 34, shoulderY - 2, 6);
        drawLimb(shoulderX, shoulderY, -f * 6, shoulderY + 8, -f * 10, shoulderY + 12, 6);
    } else if (kicking) {
        drawLimb(shoulderX, shoulderY, f * 6, shoulderY + 6, f * 4, shoulderY + 14, 6);
        drawLimb(shoulderX, shoulderY, -f * 6, shoulderY + 6, -f * 4, shoulderY + 14, 6);
    } else if (p.state === "attack" && a && a.type === "punch") {
        drawLimb(shoulderX, shoulderY, f * 12, shoulderY, f * 30, shoulderY - 2, 6);
        drawLimb(shoulderX, shoulderY, -f * 6, shoulderY + 8, -f * 10, shoulderY + 12, 6);

        if (char.hasSword) {
            ctx.strokeStyle = flashing ? "#ffffff" : char.accent;
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.moveTo(shoulderX + f * 30, shoulderY - 2);
            ctx.lineTo(shoulderX + f * 55, shoulderY - 6);
            ctx.stroke();
        }

        const tipX = shoulderX + f * (char.hasSword ? 55 : 30);
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(tipX, shoulderY - (char.hasSword ? 6 : 2), 5, 0, Math.PI * 2);
        ctx.fill();
    } else if (crouching) {
        drawLimb(shoulderX, shoulderY, f * 5, shoulderY + 8, f * 3, hipY, 6);
        drawLimb(shoulderX, shoulderY, -f * 5, shoulderY + 8, -f * 3, hipY, 6);
    } else if (isVictory) {
        // ท่าชนะเฉพาะตัวละคร: นักดาบชักดาบชูฟ้า ส่วนตัวอื่นชูหมัดฉลอง
        if (char.hasSword) {
            drawLimb(shoulderX, shoulderY, f * 10, shoulderY - 20, f * 6, shoulderY - 46, 7);
            ctx.strokeStyle = flashing ? "#ffffff" : char.accent;
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.moveTo(shoulderX + f * 6, shoulderY - 46);
            ctx.lineTo(shoulderX + f * 2, shoulderY - 82);
            ctx.stroke();
        } else if (char.hasCommandGrab) {
            // นักซัด: ยกทั้งสองแขนโชว์กล้าม
            drawLimb(shoulderX, shoulderY, f * 10, shoulderY - 8, f * 14, shoulderY - 30, 8);
            drawLimb(shoulderX, shoulderY, -f * 10, shoulderY - 8, -f * 14, shoulderY - 30, 8);
        } else {
            drawLimb(shoulderX, shoulderY, f * 8, shoulderY - 18, f * 4, shoulderY - 48, 7);
            ctx.fillStyle = "#ffffff";
            ctx.beginPath();
            ctx.arc(shoulderX + f * 4, shoulderY - 48, 5, 0, Math.PI * 2);
            ctx.fill();
        }
        if (!char.hasCommandGrab) {
            drawLimb(shoulderX, shoulderY, -f * 6, shoulderY + 10, -f * 3, hipY, 6);
        }
    } else {
        const armSwing = Math.sin(p.legPhase + Math.PI) * 6;
        drawLimb(shoulderX, shoulderY, armSwing, shoulderY + 10, armSwing * 0.6, hipY + 2, 6);
        drawLimb(shoulderX, shoulderY, -armSwing, shoulderY + 10, -armSwing * 0.6, hipY + 2, 6);
    }

    if (char.hasWings) {
        // ปีกผีเสื้อกระพือเบาๆ หลังหลัง เฉพาะนักเวท/ผีเสื้อ
        const flap = Math.sin(Date.now() / 130) * 5;
        ctx.save();
        ctx.globalAlpha = flashing ? 0.9 : 0.6;
        ctx.fillStyle = flashing ? "#ffffff" : char.accent;
        ctx.beginPath();
        ctx.ellipse(cx - f * 8, shoulderY - 4, 13, 8 + flap, Math.PI / 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(cx - f * 8, shoulderY + 10, 11, 7 + flap * 0.6, -Math.PI / 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    if (parrying) {
        // วงแหวนฟ้าเรืองแสงตอน Parry สำเร็จ
        ctx.save();
        ctx.globalAlpha = 0.6;
        ctx.strokeStyle = "#00ffff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, shoulderY, 32, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }

    ctx.restore();
}

function drawProjectile(p) {
    if (!p.projectile) return;
    const char = getChar(p);
    ctx.save();
    ctx.fillStyle = char.accent;
    ctx.shadowColor = char.accent;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(p.projectile.x, p.projectile.y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

function applyPhysics(p) {
    if (!p.grounded) p.x += p.vx || 0;
    p.vy += GRAVITY;
    p.y += p.vy;
    if (p.y >= GROUND_Y) {
        p.y = GROUND_Y;
        p.vy = 0;
        if (!p.grounded) {
            p.grounded = true;
            if (p.state === "jump") p.state = "idle";
            p.vx = 0;
            p.airActionUsed = false; // แตะพื้นแล้ว ใช้ท่าโจมตีกลางอากาศได้ใหม่ในเที่ยวกระโดดถัดไป
        }
    } else {
        p.grounded = false;
    }
}

function clampX(p) {
    if (p.x < 0) p.x = 0;
    if (p.x > canvas.width - p.width) p.x = canvas.width - p.width;
}

// --- Pushbox: กันตัวละครสองฝั่งเดินทะลุ/ซ้อนทับกัน ---
// ตั้งใจไม่ให้ระยะกันชนเท่าความกว้างเต็มตัว (0.85 เท่า) เพื่อให้ท่าโจมตีระยะประชิด/ทุ่มยังเข้าประชิดตัวได้ตามปกติ
const PUSHBOX_RATIO = 0.85;
function resolvePushbox(p1, p2) {
    // ไม่กันชนตอนมีใครลอยตัว/ล้ม/กำลังทุ่ม-โดนทุ่มอยู่ กันท่าที่ตั้งใจให้เข้าประชิด/ทะลุกันได้เพี้ยน
    if (!p1.grounded || !p2.grounded) return;
    if (p1.state === "knockdown" || p2.state === "knockdown") return;
    if (p1.state === "throw" || p2.state === "throw") return;

    const minGap = ((p1.width + p2.width) / 2) * PUSHBOX_RATIO;
    const c1 = p1.x + p1.width / 2;
    const c2 = p2.x + p2.width / 2;
    const dist = c2 - c1;
    const overlap = minGap - Math.abs(dist);
    if (overlap <= 0) return;

    const dir = dist >= 0 ? 1 : -1; // ทิศจาก p1 ไปหา p2
    const push = overlap / 2;
    p1.x -= dir * push;
    p2.x += dir * push;
    clampX(p1);
    clampX(p2);
}

// --- 6b. การเคลื่อนไหวของผู้เล่นในเครื่อง (เดิน/ย่อ/กระโดด/พุ่งตัว) ---
function handleLocalMovement(p) {
    if (!p) return;
    const now = Date.now();
    const char = getChar(p);
    const walkSpeed = char.walkSpeed || WALK_SPEED;
    const jumpForce = char.jumpForce || JUMP_FORCE;

    p.holdingBack = (keys.a && p.facing === 1) || (keys.d && p.facing === -1);
    p.holdingForward = (keys.d && p.facing === 1) || (keys.a && p.facing === -1);

    // จับจังหวะเริ่มกดบล็อก (ขอบขาขึ้นของ holdingBack) ไว้ตั้งเวลาหน้าต่าง Parry
    if (p.holdingBack && !p.wasHoldingBack) p.blockStartAt = now;
    p.wasHoldingBack = p.holdingBack;

    const freeToMove = p.state === "idle" || p.state === "walk" || p.state === "crouch";

    // เดิมท่าโจมตี "ธรรมดา" (ไม่ใช่ dash move อย่าง Sword Lunge/ซุปเปอร์ที่พุ่งตัว) จะล็อกการเดินทั้งอนิเมชัน
    // ทั้งที่จริงๆ ฮิตจบไปแล้วตั้งแต่ช่วง active — พอเข้าสู่ช่วง Recovery (เก็บท่า) ให้เริ่มเดินต่อได้เลย
    // แค่ช้าลงกว่าปกติ (ยังมีความเสี่ยงโดนสวนอยู่ แต่ไม่ถึงกับหยุดนิ่งสนิททั้งท่า) ทำให้ควบคุมลื่นขึ้น
    const inRecoveryWalk = p.state === "attack" && p.action && p.action.phase === "recovery" && !p.action.dashMove;
    const canWalk = freeToMove || inRecoveryWalk;

    // ย่อตัว (Crouch)
    if (keys.s && p.grounded && freeToMove) {
        p.crouching = true;
        p.state = "crouch";
    } else if (p.crouching && (!keys.s || !p.grounded)) {
        p.crouching = false;
        if (p.state === "crouch") p.state = "idle";
    }

    if (p.state === "dash") {
        if (now > p.dashUntil) { p.state = "idle"; p.vx = 0; }
        else { p.x += p.vx; }
    } else if (canWalk && !p.crouching && p.grounded) {
        const speed = freeToMove ? walkSpeed : walkSpeed * 0.6; // ช่วง Recovery เดินได้แต่ช้าลง
        if (keys.a) { p.x -= speed; if (freeToMove) p.state = "walk"; }
        else if (keys.d) { p.x += speed; if (freeToMove) p.state = "walk"; }
        else if (p.state === "walk") { p.state = "idle"; }
    }

    // กระโดด (ตรง/หน้า/หลัง)
    if (keys.w && p.grounded && (freeToMove || p.state === "dash")) {
        p.vy = jumpForce;
        p.grounded = false;
        p.crouching = false;
        p.state = "jump";
        if (keys.a) p.vx = -JUMP_HFORCE;
        else if (keys.d) p.vx = JUMP_HFORCE;
        else p.vx = 0;
        sfx.jump();
    }
}

// --- 7. ลูปหลักของเกม ---
function render(now) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (now < shakeUntil) {
        const dx = (Math.random() - 0.5) * shakeMag * 2;
        const dy = (Math.random() - 0.5) * shakeMag * 2;
        ctx.translate(dx, dy);
    }

    drawStage(currentStage);

    drawProjectile(p1);
    drawProjectile(p2);
    drawFighter(p1, p2);
    drawFighter(p2, p1);
    drawHitSparks();
    drawComboPopups(now);
    drawThrowTechPopup(now);
    drawTauntPopup(now);
    drawKOOverlay(now);

    ctx.restore();
}

function update() {
    const now = Date.now();

    // จอนิ่งค้างไว้ระหว่าง KO แล้วค่อยเด้งไปจอผลแพ้ชนะ (ทำงานนอก gate ของ hitStop เพื่อให้ freeze จริงๆ)
    if (koPending && now - koFreezeAt >= KO_FREEZE_MS) {
        koPending = false;
        endRound(koWinner);
    }

    if (!gameOver && now >= hitStopUntil) {
        updateFacing(p1, p2);
        updateFacing(p2, p1);

        const myPlayer = localPlayer();
        handleLocalMovement(myPlayer);
        handleWakeupInput(myPlayer);

        updateAction(p1); updateAction(p2);
        updateStun(p1); updateStun(p2);

        clampX(p1); clampX(p2);

        applyPhysics(p1);
        applyPhysics(p2);

        resolvePushbox(p1, p2);

        trackMovement(p1);
        trackMovement(p2);

        if (gameMode === "bot") runBotAI();

        if (gameMode === "bot" || gameMode === "host") checkHits();

        updateProjectilesMotion(p1);
        updateProjectilesMotion(p2);

        updateHealthUI();
        checkRoundEnd();

        // ส่งข้อมูลขึ้น Firebase แค่ทุกๆ NET_SYNC_INTERVAL_MS แทนที่จะส่งทุกเฟรม (~60/วิ)
        // ลด bandwidth/quota และลด jitter ที่เกิดจากการยิง write รัวเกินไป
        if ((gameMode === "host" || gameMode === "guest") && now - lastNetSyncAt >= NET_SYNC_INTERVAL_MS) {
            lastNetSyncAt = now;
            if (gameMode === "host") {
                db.ref("rooms/" + roomId + "/p1").set(p1);
            } else {
                db.ref("rooms/" + roomId + "/p2").set(p2);
            }
        }
    }

    updateHitSparks();
    render(now);

    gameLoop = requestAnimationFrame(update);
}
