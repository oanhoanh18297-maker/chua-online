const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Phuc vu trang web tinh tai thu muc goc (ban goc thieu dong nay
// nen mo trang se khong thay giao dien chua)
app.use(express.static(__dirname));

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

io.on('connection', (socket) => {
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
