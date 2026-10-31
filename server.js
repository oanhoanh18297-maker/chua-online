const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Trang chua chinh (ban chanh dien day du) nam trong file xuat ban cua trang.
// Khi phuc vu, server tu chinh 3 cho cho moi truong cong khai:
//  - o dia chi server de trong (khach khong phai tu dien)
//  - dia chi mac dinh = chinh dia chi trang dang mo (tu ket noi)
//  - chen doan tu dong bam "Ket noi server" sau khi trang tai xong
const fs = require('fs');
const path = require('path');
let fullPageCache = null;
function fullPage() {
    if (fullPageCache) return fullPageCache;
    const file = path.join(__dirname, 'ch-a-thanh-t-nh-online.html');
    let html = fs.readFileSync(file, 'utf8');
    html = html.replace('<input id="serverUrl" type="url" value="http://localhost:3000"', '<input id="serverUrl" type="url" value="" placeholder="Dia chi server chua"');
    html = html.replace('serverUrlInput.value || "http://localhost:3000"', 'serverUrlInput.value || location.origin');
    const auto = '\n<script>\nwindow.addEventListener(\'load\', function () {\n  if (location.protocol !== \'http:\' && location.protocol !== \'https:\') return;\n  setTimeout(function () {\n    var inp = document.getElementById(\'serverUrl\');\n    var btn = document.getElementById(\'btnConnect\');\n    if (inp && btn) { inp.value = location.origin; btn.click(); }\n  }, 900);\n});\n</script>\n</body>';
    html = html.replace('</body>', auto);
    fullPageCache = html;
    return html;
}
app.get('/', (req, res, next) => {
    try { res.type('html').send(fullPage()); } catch (e) { next(); }
});

// Phuc vu cac file tinh con lai tai thu muc goc
app.use(express.static(__dirname));

// Diem nhan su kien TikTok qua HTTP (dung cho TikFinity "Trigger Webhook").
// TikFinity tren may cua chu phong se goi URL nay moi khi co binh luan lenh,
// qua tang, nguoi vao phong, follow... Kem khoa bi mat trong tham so k.
// Vi du: /tf?k=KHOA&type=gift&u=ten_dang_nhap&n=Ten Hien Thi&gift=Hoa hong&count=1
app.all('/tf', (req, res) => {
    if (!BRIDGE_KEY || String(req.query.k || '') !== BRIDGE_KEY) {
        return res.status(403).json({ ok: false, error: 'sai khoa' });
    }
    const q = Object.assign({}, req.query, req.body || {});
    const evt = {
        type: String(q.type || ''),
        user: String(q.u || q.user || ''),
        nickname: String(q.n || q.nickname || ''),
        text: String(q.text || ''),
        giftName: String(q.gift || ''),
        giftCount: parseInt(q.count, 10) || 1,
        coins: parseInt(q.coins, 10) || 0
    };
    // Lenh rut gon cho cac su kien lenh chat cua TikFinity: act -> cau chat co dinh
    if (evt.type === 'act') {
        const acts = { incense: 'dang huong', bow: 'vai lay', bell: 'thinh chuong', meditate: 'toa thien', chant: 'nam mo a di da phat' };
        evt.type = 'chat';
        evt.text = acts[String(q.act || '')] || '';
    }
    if (['member', 'chat', 'gift', 'follow'].includes(evt.type) && evt.user) {
        handleLiveEvent(evt);
        console.log('Su kien TikTok qua /tf:', evt.type, '|', evt.nickname || evt.user, '|', evt.text || evt.giftName || '');
        return res.json({ ok: true, received: evt });
    }
    return res.status(400).json({ ok: false, error: 'thieu type hoac u', received: evt });
});

// Luu tru trang thai cua tat ca "Phat tu" dang online
// Khong gian toa do chuan cua chua: 800 x 500 (khop voi trang client)
const users = {};

function publicUser(u) {
    return { x: u.x, y: u.y, action: u.action, color: u.color, name: u.name, gender: u.gender };
}

function applyProfile(socket, data) {
    if (!data || !users[socket.id]) return;
    const u = users[socket.id];
    if (typeof data.name === 'string' && data.name.trim()) u.name = data.name.trim().slice(0, 24);
    if (data.gender === 'nam' || data.gender === 'nu' || data.sex === 'nam' || data.sex === 'nu') u.gender = data.gender || data.sex;
    if (typeof data.color === 'string' && data.color) u.color = data.color;
    const payload = { id: socket.id, user: publicUser(u), name: u.name, gender: u.gender, color: u.color };
    socket.broadcast.emit('user_profile', payload);
    socket.broadcast.emit('profile_updated', payload);
}

/* ================= Khach TikTok Live (qua chuong trinh cau noi) =================
   Cau noi (bridge) chay tren may tinh cua chu phong live, nghe binh luan/qua tang
   tren TikTok Live roi gui su kien 'live_event' vao day. Server tao "nhan vat ao"
   cho tung khan gia TikTok va phat lai bang dung cac su kien chuan cua trang chua
   (new_user, user_moved, user_offering_incense, user_bowing, user_meditating,
   play_bell_sound, user_left) nen trang web khong can sua gi them.
   Khoa bao mat: bien moi truong BRIDGE_KEY tren Render; cau noi gui kem khoa nay. */
const BRIDGE_KEY = process.env.BRIDGE_KEY || '';
const TT_MAX_GUESTS = 40;
const TT_IDLE_MS = 5 * 60 * 1000; // khan gia TikTok khong tuong tac 5 phut thi roi chua
const ttGuests = {}; // id -> { lastSeen }
let ttGenderFlip = false;

function stripAccents(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}

function ensureTtGuest(evt) {
    const uname = String(evt.user || '').replace(/[^a-zA-Z0-9_.]/g, '').slice(0, 30);
    if (!uname) return null;
    const id = 'tt_' + uname;
    if (!users[id]) {
        if (Object.keys(ttGuests).length >= TT_MAX_GUESTS) return null;
        ttGenderFlip = !ttGenderFlip;
        users[id] = {
            x: Math.floor(Math.random() * 300) + 250,
            y: Math.floor(Math.random() * 80) + 390,
            action: 'walking',
            color: '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'),
            name: String(evt.nickname || uname).slice(0, 24) || 'Phật tử',
            gender: ttGenderFlip ? 'nu' : 'nam',
            virtual: true
        };
        ttGuests[id] = { lastSeen: Date.now() };
        io.emit('new_user', { id, user: publicUser(users[id]) });
        console.log('Khach TikTok vao chua:', id, users[id].name);
    }
    ttGuests[id].lastSeen = Date.now();
    if (evt.nickname) users[id].name = String(evt.nickname).slice(0, 24);
    return id;
}

function ttWander(id) {
    const u = users[id];
    if (!u || u.action === 'meditating') return;
    u.x = Math.floor(Math.random() * 340) + 230;
    u.y = Math.floor(Math.random() * 90) + 385;
    io.emit('user_moved', { id, x: u.x, y: u.y, name: u.name, gender: u.gender });
}

// ---------- BANG CONG DUC (xep hang diem cong duc cua khach TikTok) ----------
// Diem cong tu qua tang: moi mon qua +1 diem (nhan so luong); neu su kien co
// kem so xu (coins) thi tinh theo so xu. Bang chi nam trong bo nho server.
const merit = {}; // username (chu thuong) -> { name, points }
function meritEntries() {
    return Object.values(merit).sort((a, b) => b.points - a.points).slice(0, 10)
        .map(e => ({ name: e.name, points: e.points }));
}
function broadcastMerit() { io.emit('merit_board', { entries: meritEntries() }); }
function addMerit(evt, giftCount) {
    const key = String(evt.user || '').toLowerCase();
    if (!key) return;
    const coins = parseInt(evt.coins, 10) || 0;
    const add = coins > 0 ? coins : Math.max(1, giftCount || 1);
    if (!merit[key]) merit[key] = { name: String(evt.nickname || evt.user).slice(0, 24), points: 0 };
    merit[key].name = String(evt.nickname || evt.user).slice(0, 24);
    merit[key].points += add;
    broadcastMerit();
}

function handleLiveEvent(evt) {
    if (!evt || typeof evt !== 'object') return;
    const type = evt.type;
    if (type === 'member' || type === 'chat' || type === 'gift' || type === 'follow') {
        const id = ensureTtGuest(evt);
        if (!id) return;
        if (type === 'gift') {
            // Co qua tang: thinh chuong vang ca chua + nhan vat vai lay cam on
            // + hien loi chuc/cam on lon tren man hinh chua cho moi nguoi cung thay
            io.emit('play_bell_sound', { id });
            io.emit('user_bowing', { id });
            const giftPayload = {
                id,
                name: users[id].name,
                giftName: String(evt.giftName || 'quà tặng').slice(0, 40),
                giftCount: Math.max(1, parseInt(evt.giftCount, 10) || 1)
            };
            addMerit(evt, giftPayload.giftCount);
            io.emit('gift_announcement', giftPayload);
            // Trang chua lang nghe loi chuc qua tang qua cac ten su kien nay
            io.emit('tiktok_gift', Object.assign({}, giftPayload, { ten: giftPayload.name, qua: giftPayload.giftName, nickname: giftPayload.name, gift: giftPayload.giftName }));
            io.emit('gift', Object.assign({}, giftPayload, { ten: giftPayload.name, qua: giftPayload.giftName, nickname: giftPayload.name }));
            return;
        }
        if (type === 'chat') {
            const text = stripAccents(evt.text);
            if (text.includes('a di da phat') || text.includes('adidaphat') || text.includes('nam mo a di da')) {
                // Khach niem Phat: nhan vat tu chat lai cau niem + vai lay
                io.emit('chat_message', { id, name: users[id].name, gender: users[id].gender, text: 'Nam mô A Di Đà Phật 🙏' });
                io.emit('user_bowing', { id });
            } else if (text.includes('dang huong') || text.includes('thap huong') || text.includes('thap nhang')) {
                io.emit('user_offering_incense', { id });
            } else if (text.includes('vai lay') || text.includes('lay phat') || text.includes('nam mo')) {
                io.emit('user_bowing', { id });
            } else if (text.includes('thinh chuong') || text.includes('go chuong') || text.includes('danh chuong')) {
                io.emit('play_bell_sound', { id });
            } else if (text.includes('toa thien') || text.includes('ngoi thien')) {
                users[id].action = 'meditating';
                io.emit('user_meditating', { id });
            } else {
                ttWander(id);
            }
        }
    }
}

// Don khach TikTok khong con tuong tac
setInterval(() => {
    const now = Date.now();
    for (const id of Object.keys(ttGuests)) {
        if (now - ttGuests[id].lastSeen > TT_IDLE_MS) {
            delete ttGuests[id];
            delete users[id];
            io.emit('user_left', id);
            console.log('Khach TikTok roi chua (vang mat):', id);
        }
    }
}, 30000);

io.on('connection', (socket) => {
    // Gui bang cong duc hien tai cho nguoi vua ket noi
    socket.emit('merit_board', { entries: meritEntries() });
    // Cau noi TikTok xac thuc bang khoa rieng; khan gia web binh thuong khong can
    const isBridge = !!BRIDGE_KEY && socket.handshake.auth && socket.handshake.auth.key === BRIDGE_KEY;
    if (isBridge) {
        console.log('Cau noi TikTok da ket noi:', socket.id);
        socket.on('live_event', handleLiveEvent);
        socket.on('disconnect', () => console.log('Cau noi TikTok ngat ket noi:', socket.id));
        return;
    }

    console.log('Mot thien nam/tin nu vua vao chua:', socket.id);

    // Xuat hien trong loi di giua dien (vung toa do hop le cua client)
    users[socket.id] = {
        x: Math.floor(Math.random() * 300) + 250,
        y: Math.floor(Math.random() * 80) + 390,
        action: 'walking', // 'walking', 'meditating', 'offering', 'bowing'
        color: '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'),
        name: 'Phật tử',
        gender: 'nam'
    };

    // Gui danh sach nguoi dang o chua cho nguoi moi
    const snapshot = {};
    for (const id of Object.keys(users)) snapshot[id] = publicUser(users[id]);
    socket.emit('current_users', snapshot);

    // Bao cho moi nguoi co nguoi moi vao
    socket.broadcast.emit('new_user', { id: socket.id, user: publicUser(users[socket.id]) });

    // Nguoi vao chua tu dat ten + gioi tinh (client gui nhieu ten su kien, nhan tat ca)
    socket.on('set_profile', (data) => applyProfile(socket, data));
    socket.on('update_profile', (data) => applyProfile(socket, data));
    socket.on('profile', (data) => applyProfile(socket, data));
    socket.on('join', (data) => applyProfile(socket, data));

    // Di chuyen (client gui kem ten + gioi tinh trong moi lan move)
    socket.on('move', (data) => {
        if (users[socket.id] && data) {
            users[socket.id].x = data.x;
            users[socket.id].y = data.y;
            if (users[socket.id].action === 'meditating') users[socket.id].action = 'walking';
            if (typeof data.name === 'string' && data.name.trim()) users[socket.id].name = data.name.trim().slice(0, 24);
            if (data.gender === 'nam' || data.gender === 'nu') users[socket.id].gender = data.gender;
            socket.broadcast.emit('user_moved', { id: socket.id, x: data.x, y: data.y, name: users[socket.id].name, gender: users[socket.id].gender });
        }
    });

    // CHAT GIUA CAC PHAT TU TRONG CHUA (trang gui 'chat_message')
    const relayChat = (data) => {
        if (!users[socket.id] || !data) return;
        const text = String(data.text || data.message || '').trim().slice(0, 300);
        if (!text) return;
        io.emit('chat_message', {
            id: socket.id,
            name: users[socket.id].name,
            gender: users[socket.id].gender,
            text
        });
    };
    socket.on('chat_message', relayChat);
    socket.on('chat', relayChat);
    socket.on('message', relayChat);

    // NGOI THIEN
    socket.on('meditate', () => {
        if (users[socket.id]) {
            users[socket.id].action = 'meditating';
            io.emit('user_meditating', { id: socket.id });
        }
    });

    // DANG HUONG
    socket.on('offer_incense', () => {
        socket.broadcast.emit('user_offering_incense', { id: socket.id });
    });

    // VAI LAY
    socket.on('bow', () => {
        socket.broadcast.emit('user_bowing', { id: socket.id });
    });

    // Su kien hanh dong tong quat cua client
    socket.on('action', (data) => {
        if (!data) return;
        if (data.action === 'offer_incense') socket.broadcast.emit('user_offering_incense', { id: socket.id });
        else if (data.action === 'bow') socket.broadcast.emit('user_bowing', { id: socket.id });
    });

    // THINH CHUONG (vang cho moi nguoi)
    socket.on('ring_bell', () => {
        io.emit('play_bell_sound', { id: socket.id });
    });

    // Khi nguoi dung roi di
    socket.on('disconnect', () => {
        console.log('Mot nguoi da roi chua:', socket.id);
        delete users[socket.id];
        io.emit('user_left', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Chùa online mở cửa tại port ' + PORT));
