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
    // DA GO doan tu dong bam nut Ket noi (ban .36): nut Ket noi la nut gat hai chieu,
    // cu bam tu dong o 900ms dap trung luc trang vua tu ket noi xong se NGAT ket noi
    // va khoa che do tu noi lai — nguyen nhan goc loi "live chi co 1 nhan vat",
    // nang nhat o che do dai sanh (man hinh phat khong nguoi trong). Trang tu .33
    // da tu ket noi cung nguon + co giam sat tu noi lai, khong can cu bam nay nua.
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
        src: String(q.src || 'tt'),
        user: String(q.u || q.user || ''),
        nickname: String(q.n || q.nickname || ''),
        text: String(q.text || ''),
        giftName: String(q.gift || ''),
        giftCount: parseInt(q.count, 10) || 1,
        coins: parseInt(q.coins, 10) || 0
    };
    // Lenh rut gon cho cac su kien lenh chat cua TikFinity: act -> cau chat co dinh
    if (evt.type === 'act') {
        const acts = { incense: 'dang huong', bow: 'vai lay', bell: 'thinh chuong', meditate: 'toa thien', chant: 'nam mo a di da phat', pray: 'cau phuc', fortune: 'xin que', lotus: 'hoa sen', lantern: 'tha hoa dang' };
        evt.rawText = evt.text;
        evt.type = 'chat';
        evt.text = acts[String(q.act || '')] || '';
    }
    if (['member', 'chat', 'gift', 'follow', 'live_end'].includes(evt.type) && (evt.type === 'live_end' || evt.user)) {
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
const TT_IDLE_MS = 2 * 60 * 60 * 1000; // chi la luoi an toan: khach TikTok o lai suot buoi live (cau noi bao live_end thi ca sảnh roi chua), 2 gio khong dau hieu moi tu roi
const ttGuests = {}; // id -> { lastSeen }
let ttGenderFlip = false;

function stripAccents(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}

// Nguon khach live: 'tt' (TikTok, mac dinh), 'fb' (Facebook), 'yt' (YouTube).
// Moi nguon co rieng mot nhom khach (id bat dau bang tt_/fb_/yt_), gioi han va
// nhuong cho tinh rieng tung nguon, live_end cua nguon nao chi don khach nguon do.
function guestSrc(evt) {
    const s = String((evt && evt.src) || 'tt').toLowerCase();
    return (s === 'fb' || s === 'yt') ? s : 'tt';
}

function ensureTtGuest(evt) {
    const src = guestSrc(evt);
    const uname = String(evt.user || '').replace(/[^a-zA-Z0-9_.]/g, '').slice(0, 30);
    if (!uname) return null;
    const id = src + '_' + uname;
    if (!users[id]) {
        const sameSrc = Object.keys(ttGuests).filter(g => g.startsWith(src + '_'));
        if (sameSrc.length >= TT_MAX_GUESTS) {
            // Nguon nay da day: khach cu ngoi lau nhat ma khong tuong tac va chua
            // tung co cong duc (tang qua/dang hoa/cau phuc) se nhuong cho cho
            // khach moi cung nguon. Chong ket khach cu khi live ket thuc ma tin
            // hieu live_end khong toi duoc may chu (chi con cho quet 2 gio).
            let victim = null, victimSeen = Infinity;
            for (const gid of sameSrc) {
                const mkey = src + ':' + gid.slice(src.length + 1).toLowerCase();
                if (merit[mkey] && merit[mkey].points > 0) continue;
                const seen = (ttGuests[gid] && ttGuests[gid].lastSeen) || 0;
                if (seen < victimSeen) { victimSeen = seen; victim = gid; }
            }
            if (!victim) return null;
            delete ttGuests[victim];
            delete users[victim];
            io.emit('user_left', { id: victim });
            console.log('Sanh', src, 'day: khach cu', victim, 'nhuong cho cho khach moi');
        }
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
        console.log('Khach live vao chua:', id, users[id].name);
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
function meritKey(evt) {
    return guestSrc(evt) + ':' + String(evt.user || '').toLowerCase();
}

function addMerit(evt, giftCount) {
    const key = meritKey(evt);
    if (!String(evt.user || '')) return;
    const coins = parseInt(evt.coins, 10) || 0;
    const add = coins > 0 ? coins : Math.max(1, giftCount || 1);
    if (!merit[key]) merit[key] = { name: String(evt.nickname || evt.user).slice(0, 24), points: 0 };
    merit[key].name = String(evt.nickname || evt.user).slice(0, 24);
    merit[key].points += add;
    broadcastMerit();
}
function addMeritFixed(evt, points) {
    const key = meritKey(evt);
    if (!String(evt.user || '') || !points) return;
    if (!merit[key]) merit[key] = { name: String(evt.nickname || evt.user).slice(0, 24), points: 0 };
    merit[key].name = String(evt.nickname || evt.user).slice(0, 24);
    merit[key].points += points;
    broadcastMerit();
}

// ---------- LOI CHUC CUA CHUA CHO KHACH BINH LUAN ----------
// Khach TikTok binh luan thuong (khong phai khau lenh) se nhan lai mot loi chuc
// hien tren dau nhan vat + dong su kien; moi khach toi da 1 loi chuc moi 45 giay.
const BLESSINGS = [
    'Chúc bạn thân tâm thường an lạc 🙏',
    'Chúc gia đình bạn bình an, vạn sự hanh thông',
    'Chúc bạn sức khỏe dồi dào, phiền não tiêu tan',
    'Nguyện chúc bạn một ngày an lành, tâm luôn thanh tịnh',
    'Chúc bạn cầu được ước thấy, phúc lộc song toàn',
    'Chúc nhà bạn ấm êm, cha mẹ an khang',
    'Nguyện ánh sáng Phật pháp soi đường cho bạn',
    'Chúc bạn gặp nhiều may mắn, quý nhân phù trợ'
];

// ---------- BO QUE XIN XAM CHO KHACH TIKTOK (lenh chat xin que / xin xam) ----------
const FORTUNES = [
    { hang: 'Thượng Thượng Cát', tho: 'Sen nở giữa hồ trong, phúc lộc tự nhiên đầy.', giai: 'Rất tốt: mọi việc hanh thông, cầu được ước thấy.' },
    { hang: 'Thượng Cát', tho: 'Nắng ấm sau mưa rào, đường đi dần sáng tỏ.', giai: 'Tốt: kiên nhẫn thêm chút nữa, tin vui đang tới.' },
    { hang: 'Trung Thượng', tho: 'Thuyền qua bến nước êm, chớ vội cũng đừng lo.', giai: 'Khá: giữ nhịp đều đặn, việc nhỏ thành trước.' },
    { hang: 'Trung Bình', tho: 'Trăng khi mờ khi tỏ, lòng an là phúc nhà.', giai: 'Bình: giữ tâm an, tránh quyết định lúc nóng vội.' },
    { hang: 'Trung Bình', tho: 'Gieo hạt đúng mùa xuân, đợi ngày cây trổ lá.', giai: 'Bình: việc đang gieo chưa tới ngày gặt, cứ chăm đều.' },
    { hang: 'Hạ Bình', tho: 'Mây che đỉnh núi cao, nghỉ chân rồi hãy bước.', giai: 'Hơi chậm: nên dừng lại xem xét, chớ vội đầu tư lớn.' },
    { hang: 'Thượng Cát', tho: 'Chuông chùa vang buổi sớm, tin lành đến tận nhà.', giai: 'Tốt: có quý nhân phù trợ, mạnh dạn tiến bước.' },
    { hang: 'Trung Thượng', tho: 'Nước nguồn trong lại ngọt, ơn trên độ trì nhiều.', giai: 'Khá tốt: gia đạo bình yên, sức khỏe là trên hết.' }
];

function handleLiveEvent(evt) {
    if (!evt || typeof evt !== 'object') return;
    const type = evt.type;
    if (type === 'live_end') {
        // Buoi live ket thuc (cau noi bao): chi khach cua DUNG nguon do roi chua,
        // khach TikTok/Facebook/YouTube cua cac buoi live khac khong bi anh huong
        const prefix = guestSrc(evt) + '_';
        for (const gid of Object.keys(ttGuests)) {
            if (!gid.startsWith(prefix)) continue;
            delete ttGuests[gid];
            if (users[gid]) { delete users[gid]; io.emit('user_left', { id: gid }); }
        }
        return;
    }
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
            } else if (text.includes('xin que') || text.includes('xin xam') || text.includes('gieo que') || text.includes('gieo xam')) {
                // Khach xin que: boc que + phat ket qua de trang hien vien chu giua sanh + doc thanh tieng
                const so = Math.floor(Math.random() * 24) + 1;
                const f = FORTUNES[(so - 1) % FORTUNES.length];
                io.emit('fortune_result', { id, name: users[id].name, so, hang: f.hang, tho: f.tho, giai: f.giai });
                io.emit('user_bowing', { id });
            } else if (text.includes('tha hoa dang') || text.includes('hoa dang') || text.includes('tha den')) {
                // Khach tha hoa dang: trang tha den mang ten + loi khan cua khach
                io.emit('user_lantern', { id, name: users[id].name, wish: String(evt.rawText || evt.text || '').slice(0, 80) });
            } else if (text.includes('hoa sen') || text.includes('dang hoa')) {
                // Khach dang hoa sen: +10 cong duc, trang hien hoa sen tai ban tho + khach vai lay
                addMeritFixed(evt, 10);
                io.emit('user_lotus', { id, name: users[id].name });
                io.emit('user_bowing', { id });
            } else if (text.includes('cau phuc') || text.includes('cau nguyen') || text.includes('cau binh an') || text.includes('cau an') || text.includes('cau cho')) {
                // Khach cau phuc: +10 cong duc, trang hien loi khan + nhan vat trung tam cau nguyen
                addMeritFixed(evt, 10);
                io.emit('user_praying', { id, name: users[id].name, text: String(evt.rawText || evt.text || '').slice(0, 80) });
            } else if (text.includes('dang huong') || text.includes('thap huong') || text.includes('thap nhang')) {
                io.emit('user_offering_incense', { id });
            } else if (text.includes('vai lay') || text.includes('lay phat') || text.includes('bai phat') || text.includes('nam mo')) {
                io.emit('user_bowing', { id });
            } else if (text.includes('thinh chuong') || text.includes('go chuong') || text.includes('danh chuong')) {
                io.emit('play_bell_sound', { id });
            } else if (text.includes('toa thien') || text.includes('ngoi thien')) {
                users[id].action = 'meditating';
                io.emit('user_meditating', { id });
            } else if (text === 'nam' || text === 'nu') {
                // Khach chon nhan vat: go dung "nam" hoac "nu" thi doi hinh nhan vat
                users[id].gender = text === 'nam' ? 'nam' : 'nu';
                const prof = { id, user: publicUser(users[id]), name: users[id].name, gender: users[id].gender, color: users[id].color };
                io.emit('user_profile', prof);
                io.emit('profile_updated', prof);
            } else {
                // Binh luan thuong: chua gui lai loi chuc cho khach (chong spam 45s/khach)
                const nowB = Date.now();
                if (ttGuests[id] && (!ttGuests[id].lastBlessing || nowB - ttGuests[id].lastBlessing > 45000)) {
                    ttGuests[id].lastBlessing = nowB;
                    const bl = BLESSINGS[Math.floor(Math.random() * BLESSINGS.length)];
                    io.emit('user_blessing', { id, name: users[id].name, text: bl });
                }
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
