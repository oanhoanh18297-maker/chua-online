const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Phuc vu trang web tinh trong thu muc public (bo sung: ban goc thieu dong nay
// nen mo localhost:3000 se khong thay trang chua)
app.use(express.static(__dirname));

// Lưu trữ trạng thái của tất cả "Phật tử" đang online
const users = {};

io.on('connection', (socket) => {
    console.log('Một thiện nam/tín nữ vừa vào chùa:', socket.id);

    // Khởi tạo vị trí ngẫu nhiên trong sân chùa
    users[socket.id] = {
        x: Math.floor(Math.random() * 500) + 100,
        y: Math.floor(Math.random() * 300) + 100,
        action: 'walking', // 'walking' hoặc 'meditating'
        color: '#' + Math.floor(Math.random()*16777215).toString(16).padStart(6, '0') // Màu áo lam ngẫu nhiên
    };

    // Gửi danh sách người đang ở chùa cho người mới
    socket.emit('current_users', users);

    // Báo cho mọi người có người mới vào
    socket.broadcast.emit('new_user', { id: socket.id, user: users[socket.id] });

    // Lắng nghe sự kiện di chuyển
    socket.on('move', (data) => {
        if (users[socket.id]) {
            users[socket.id].x = data.x;
            users[socket.id].y = data.y;
            users[socket.id].action = 'walking';
            socket.broadcast.emit('user_moved', { id: socket.id, x: data.x, y: data.y });
        }
    });

    // Lắng nghe hành động NGỒI THIỀN
    socket.on('meditate', () => {
        if (users[socket.id]) {
            users[socket.id].action = 'meditating';
            io.emit('user_meditating', { id: socket.id });
        }
    });

    // Lắng nghe hành động THỈNH CHUÔNG (Vang cho mọi người)
    socket.on('ring_bell', () => {
        io.emit('play_bell_sound', { id: socket.id });
    });

    // Khi người dùng rời đi
    socket.on('disconnect', () => {
        console.log('Một người đã rời chùa:', socket.id);
        delete users[socket.id];
        io.emit('user_left', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Chùa online mở cửa tại port ' + PORT));
