// ============================================================================
// RAP PHIM ONLINE — may chu rap chieu phim YouTube cho TikTok Live
// Theo cung mau voi may chu Chua Online (express + socket.io, nhan su kien
// TikTok qua /tf?k=KHOA tu cau noi chay tren may chu phong).
//   - Man hinh lon chieu video YouTube (trang tu nhung iframe + oEmbed)
//   - Khach TikTok binh luan la vao rap ngoi ghe co ten (toi da 100 ghe)
//   - Vote "skip" du nguong % so khach dang ngoi thi chuyen phim
//   - Khan gia gui link YouTube vao hang cho duyet; chu phong duyet/phat
// ============================================================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Khoa cau noi: bien moi truong BRIDGE_KEY (tren Render), mac dinh khoa hien tai
const BRIDGE_KEY = process.env.BRIDGE_KEY || '7870bf71808a471e2b5e51befae44deb';

// ---- Trang rap chinh: doc file html tu dia, phuc vu o "/" ----
let fullPageCache = null;
function fullPage() {
    if (fullPageCache) return fullPageCache;
    const file = path.join(__dirname, 'rap-phim.html');
    fullPageCache = fs.readFileSync(file, 'utf8');
    return fullPageCache;
}
app.get('/', (req, res, next) => {
    try { res.type('html').send(fullPage()); } catch (e) { next(); }
});

// Man hinh phat song (dung lam nguon TikTok Live Studio): /?rap=1
app.get('/phong-chieu.html', (req, res) => res.redirect('/?rap=1'));
app.get('/admin.html', (req, res) => res.redirect('/?admin=1'));

app.get('/health', (req, res) => res.type('text').send('ok'));

// Phuc vu cac file tinh con lai tai thu muc goc
app.use(express.static(__dirname));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================================
// TRANG THAI RAP
// ============================================================================
const MAX_GUESTS = 100;                 // 100 ghe
const IDLE_MS = 2 * 60 * 60 * 1000;     // luoi an toan: 2 gio khong tuong tac thi roi rap
const CHAT_FLOOD_MS = 1500;             // chat_message: toi da 1 tin / 1.5 giay / khach
const LINK_COOLDOWN_MS = 5 * 60 * 1000; // gui link: toi da 1 link / khach / 5 phut
const DEFAULT_THRESHOLD = 35;           // % khach dang ngoi vote skip thi chuyen phim

const guests = {};        // id -> { id, name, seat, gender, joinedAt, lastSeen, lastChatAt, lastLinkAt }
let nowPlaying = null;    // { videoId, title, startedAt } | null
const queue = [];         // [{ videoId, title, byName }] — hang cho DA DUYET
const submissions = [];   // [{ videoId, byName, at }]   — khan gia gui, cho duyet
let thresholdPercent = DEFAULT_THRESHOLD;
let voteIds = new Set();  // id khach da vote cho phim hien tai
let voteNames = [];       // ten khach da vote (theo thu tu)

function guestCount() { return Object.keys(guests).length; }

function voteState() {
    const n = guestCount();
    const needed = Math.max(1, Math.ceil(thresholdPercent / 100 * n));
    const percent = n > 0 ? Math.round(voteIds.size / n * 100) : 0;
    return { count: voteIds.size, needed, percent, voters: voteNames.slice() };
}

function resetVotes() {
    voteIds = new Set();
    voteNames = [];
}

function broadcastVotes() { io.emit('vote_update', voteState()); }
function broadcastQueue() { io.emit('queue_update', { queue, submissions }); }

function stateSnapshot() {
    return {
        guests: Object.values(guests).map(g => ({ id: g.id, name: g.name, seat: g.seat, gender: g.gender, joinedAt: g.joinedAt })),
        nowPlaying,
        queue: queue.slice(),
        submissions: submissions.slice(),
        votes: voteState(),
        thresholdPercent
    };
}

function stripAccents(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().trim();
}

// ============================================================================
// KHACH TIKTOK
// ============================================================================
// Ghe trong co so NHO NHAT (hang truoc truoc); rap day thi tra null
function smallestFreeSeat() {
    const taken = new Set(Object.values(guests).map(g => g.seat));
    for (let s = 1; s <= MAX_GUESTS; s++) {
        if (!taken.has(s)) return s;
    }
    return null;
}

function ensureGuest(evt) {
    const uname = String(evt.user || '').replace(/[^a-zA-Z0-9_.]/g, '').slice(0, 30);
    if (!uname) return null;
    const id = 'tt_' + uname;
    if (!guests[id]) {
        if (guestCount() >= MAX_GUESTS) {
            // Rap day: khach vang mat lau nhat (tuong tac cu nhat, ngoi lau nhat
            // lam moc phu) nhuong ghe cho khach moi
            let victim = null;
            for (const g of Object.values(guests)) {
                if (!victim || g.lastSeen < victim.lastSeen ||
                    (g.lastSeen === victim.lastSeen && g.joinedAt < victim.joinedAt)) victim = g;
            }
            if (!victim) return null;
            delete guests[victim.id];
            io.emit('user_left', { id: victim.id });
            console.log('Rap day: khach cu', victim.id, 'nhuong ghe cho khach moi');
        }
        guests[id] = {
            id,
            name: String(evt.nickname || uname).slice(0, 24) || uname,
            seat: smallestFreeSeat(),
            gender: 'nam',
            joinedAt: Date.now(),
            lastSeen: Date.now(),
            lastChatAt: 0,
            lastLinkAt: 0
        };
        io.emit('new_user', { id, name: guests[id].name, seat: guests[id].seat, gender: guests[id].gender });
        console.log('Khach vao rap:', id, guests[id].name, '| ghe', guests[id].seat);
    }
    guests[id].lastSeen = Date.now();
    if (evt.nickname) guests[id].name = String(evt.nickname).slice(0, 24);
    return guests[id];
}

function removeAllGuests() {
    for (const id of Object.keys(guests)) delete guests[id];
}

// Trich videoId (11 ky tu) tu link YouTube; khong phai link thi tra null
const YT_RE = /(?:youtube\.com\/(?:watch\?[^ \s]*v=|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;
function extractVideoId(text) {
    const m = String(text || '').match(YT_RE);
    return m ? m[1] : null;
}

const VOTE_WORDS = new Set(['skip', 'bo qua', 'skip di', 'chuyen phim']);

function handleChat(guest, rawText) {
    const text = String(rawText || '').trim();
    if (!text) return;
    const plain = stripAccents(text);

    // 0a) Lenh chon ghe: "ghe 12", "ghe12", "chon ghe 12", "ghe so 12"
    const seatMatch = plain.match(/^(?:chon\s+)?ghe\s*(?:so\s*)?(\d{1,3})$/);
    if (seatMatch) {
        const target = parseInt(seatMatch[1], 10);
        if (target < 1 || target > MAX_GUESTS) return; // ngoai 1..100: bo qua
        if (target === guest.seat) return; // dang ngoi dung ghe do: coi nhu xong, khong phat su kien thua
        const occupied = Object.values(guests).some(g => g.id !== guest.id && g.seat === target);
        if (occupied) {
            io.emit('seat_taken', { id: guest.id, seat: target });
            console.log('Chon ghe that bai (da co nguoi):', guest.name, '-> ghe', target);
            return;
        }
        guest.seat = target;
        io.emit('seat_changed', { id: guest.id, seat: target });
        console.log('Khach doi ghe:', guest.name, '-> ghe', target);
        return;
    }

    // 0b) Lenh chon nhan vat: "nam" / "nu" (go khong dau "nu" cung tinh)
    if (plain === 'nam' || plain === 'nu') {
        guest.gender = plain;
        io.emit('user_profile', { id: guest.id, gender: guest.gender });
        console.log('Khach chon nhan vat:', guest.name, '->', guest.gender);
        return;
    }

    // 1) Lenh vote bo qua phim hien tai
    if (VOTE_WORDS.has(stripAccents(text))) {
        if (!nowPlaying) return; // chua co phim thi khong vote
        if (voteIds.has(guest.id)) return; // moi khach 1 vote / phim
        voteIds.add(guest.id);
        voteNames.push(guest.name);
        const st = voteState();
        io.emit('vote_update', st);
        console.log('Vote skip:', guest.name, '(' + st.count + '/' + st.needed + ')');
        if (st.count >= st.needed) {
            resetVotes();
            io.emit('skip_now', {});
            io.emit('vote_update', voteState());
            console.log('Du vote -> SKIP_NOW');
        }
        return;
    }

    // 2) Gui link YouTube vao hang cho duyet
    const vid = extractVideoId(text);
    if (vid) {
        const now = Date.now();
        if (now - guest.lastLinkAt < LINK_COOLDOWN_MS) return; // 1 link / 5 phut
        const dup = (nowPlaying && nowPlaying.videoId === vid) ||
            queue.some(q => q.videoId === vid) ||
            submissions.some(s => s.videoId === vid);
        if (dup) return;
        guest.lastLinkAt = now;
        submissions.push({ videoId: vid, byName: guest.name, at: now });
        broadcastQueue();
        console.log('Khach gui link cho duyet:', guest.name, vid);
        return;
    }

    // 3) Binh luan thuong -> bong bong chat (chong flood 1.5s/khach)
    const now = Date.now();
    if (now - guest.lastChatAt < CHAT_FLOOD_MS) return;
    guest.lastChatAt = now;
    io.emit('chat_message', { id: guest.id, name: guest.name, text: text.slice(0, 300) });
}

function handleLiveEvent(evt) {
    if (!evt || typeof evt !== 'object') return;
    const type = evt.type;

    if (type === 'live_end') {
        // Buoi live ket thuc: don toan bo khach + reset vote.
        // Hang cho phim (queue + submissions) GIU NGUYEN cho buoi sau.
        removeAllGuests();
        resetVotes();
        io.emit('cinema_cleared', {});
        console.log('Live ket thuc: da don rap (hang cho phim giu nguyen)');
        return;
    }

    if (type === 'member' || type === 'follow' || type === 'like') {
        ensureGuest(evt);
        return;
    }

    if (type === 'gift') {
        const guest = ensureGuest(evt);
        if (!guest) return;
        io.emit('gift_announcement', {
            name: guest.name,
            giftName: String(evt.giftName || 'quà tặng').slice(0, 40),
            count: Math.max(1, parseInt(evt.giftCount, 10) || 1)
        });
        return;
    }

    if (type === 'chat' || type === 'act') {
        // Khach chua co trong rap -> tu vao ghe truoc (member-on-first-comment)
        const guest = ensureGuest(evt);
        if (!guest) return;
        handleChat(guest, evt.text);
    }
}

// Diem nhan su kien TikTok qua HTTP (cau noi goi vao day, kem khoa bi mat k)
// Vi du: /tf?k=KHOA&type=chat&u=ten_dang_nhap&n=Ten Hien Thi&text=skip
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
    if (['member', 'chat', 'act', 'gift', 'follow', 'like', 'live_end'].includes(evt.type) &&
        (evt.type === 'live_end' || evt.user)) {
        handleLiveEvent(evt);
        console.log('Su kien TikTok qua /tf:', evt.type, '|', evt.nickname || evt.user, '|', evt.text || evt.giftName || '');
        return res.json({ ok: true, received: evt });
    }
    return res.status(400).json({ ok: false, error: 'thieu type hoac u', received: evt });
});

// Don khach khong con tuong tac qua 2 gio (luoi an toan)
setInterval(() => {
    const now = Date.now();
    for (const g of Object.values(guests)) {
        if (now - g.lastSeen > IDLE_MS) {
            delete guests[g.id];
            io.emit('user_left', { id: g.id });
            console.log('Khach roi rap (vang mat 2 gio):', g.id);
        }
    }
}, 30000);

// ============================================================================
// SU KIEN TU TRANG (chu phong dieu khien qua cac su kien host_*)
// ============================================================================
function setNowPlaying(videoId, title) {
    nowPlaying = videoId ? { videoId, title: String(title || ''), startedAt: Date.now() } : null;
    resetVotes();
    io.emit('now_playing', nowPlaying);
    broadcastVotes();
}

io.on('connection', (socket) => {
    // Gui trang thai hien tai cho trang vua ket noi
    socket.emit('current_state', stateSnapshot());

    socket.on('host_play_video', (data) => {
        if (!data || !data.videoId) return;
        setNowPlaying(String(data.videoId), data.title || '');
        console.log('Chu phong phat ngay:', nowPlaying.videoId, nowPlaying.title);
    });

    socket.on('host_play_next', () => {
        const next = queue.shift();
        if (next) setNowPlaying(next.videoId, next.title || '');
        else setNowPlaying(null, '');
        broadcastQueue();
        console.log('Chu phong chuyen phim tiep:', nowPlaying ? nowPlaying.videoId : '(dung)');
    });

    socket.on('host_add_queue', (data) => {
        if (!data || !data.videoId) return;
        queue.push({ videoId: String(data.videoId), title: String(data.title || ''), byName: String(data.byName || '') });
        broadcastQueue();
    });

    socket.on('host_remove_queue', (data) => {
        const i = data && parseInt(data.index, 10);
        if (Number.isInteger(i) && i >= 0 && i < queue.length) queue.splice(i, 1);
        broadcastQueue();
    });

    socket.on('host_approve_submission', (data) => {
        const i = data && parseInt(data.index, 10);
        if (Number.isInteger(i) && i >= 0 && i < submissions.length) {
            const s = submissions.splice(i, 1)[0];
            queue.push({ videoId: s.videoId, title: '', byName: s.byName });
        }
        broadcastQueue();
    });

    socket.on('host_remove_submission', (data) => {
        const i = data && parseInt(data.index, 10);
        if (Number.isInteger(i) && i >= 0 && i < submissions.length) submissions.splice(i, 1);
        broadcastQueue();
    });

    socket.on('host_set_threshold', (data) => {
        const p = data && parseInt(data.percent, 10);
        if (Number.isInteger(p)) {
            thresholdPercent = Math.min(90, Math.max(10, p));
            broadcastVotes();
            console.log('Nguong vote skip:', thresholdPercent + '%');
        }
    });

    socket.on('host_stop', () => {
        setNowPlaying(null, '');
        console.log('Chu phong dung chieu');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Rap Phim Online mo cua tai port ' + PORT));
