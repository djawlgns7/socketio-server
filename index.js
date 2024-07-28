const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const BACK_URL = 'http://localhost:8080';
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    pingInterval: 25000, // 핑 간격을 25초로 설정
    pingTimeout: 60000   // 응답 대기 시간을 60초로 설정
});

app.use(cors());

const nicknameById = {};
const idByNickname = {};

io.on('connection', (socket) => {
    console.log('a user connected:', socket.id);

    socket.on('login', async (nickname) => {
        nicknameById[socket.id] = nickname;

        if (!idByNickname[nickname]) {
            idByNickname[nickname] = [];
        }
        idByNickname[nickname].push(socket.id);

        setOnline(nickname, true).then(() => console.log(`User ${nickname}(${socket.id}) login`));

        const onlineFriends = await getOnlineFriends(nickname);

        onlineFriends.forEach(friend => {
            if (idByNickname[friend.nickname]) {
                idByNickname[friend.nickname].forEach(friendSocketId => {
                    io.to(friendSocketId).emit('friend_login', {nickname: nickname});
                });
            }
        });
    });

    socket.on('join_room', (room) => {
        socket.join(room);
        console.log(`User ${socket.id} joined room ${room}`);
    });

    socket.on('leave_room', (room) => {
        socket.leave(room);
        console.log(`User ${socket.id} left room ${room}`);
    });

    socket.on('send_message', (data) => {
        const {nickname, room, message} = data;
        io.to(room).emit('receive_message', {nickname, message});
    });

    socket.on('send_message_to_friends', async (data) => {
        const {nickname, message} = data;
        const onlineFriends = await getOnlineFriends(nickname);

        onlineFriends.forEach(friend => {
            if (idByNickname[friend.nickname]) {
                idByNickname[friend.nickname].forEach(friendSocketId => {
                    io.to(friendSocketId).emit('message_alarm', {nickname, message});
                });
            }
        });
    });

    socket.on('disconnect', async () => {
        const nickname = nicknameById[socket.id];
        delete nicknameById[socket.id];

        if (nickname) {
            idByNickname[nickname] = idByNickname[nickname].filter(id => id !== socket.id);
            if (idByNickname[nickname].length === 0) {
                await setOnline(nickname, false);
                delete idByNickname[nickname];

                const onlineFriends = await getOnlineFriends(nickname);

                onlineFriends.forEach(friend => {
                    if (idByNickname[friend.nickname]) {
                        idByNickname[friend.nickname].forEach(friendSocketId => {
                            io.to(friendSocketId).emit('friend_logout', {nickname: nickname});
                        });
                    }
                });
            }
        }

        console.log(`user disconnected: ${nickname}, ${socket.id}`);
    });
});

const setOnline = async (nickname, isOnline) => {
    try {
        await axios.put(`${BACK_URL}/user/status/update2?nickname=${nickname}&isOnline=${isOnline}`, {});
    } catch (error) {
        console.error("error setting online:", error);
    }
};

const getOnlineFriends = async (nickname) => {
    try {
        const response = await axios.get(`${BACK_URL}/friend/list/online2?nickname=${nickname}`);
        return response.data;
    } catch (error) {
        console.error("error fetching online friends list:", error);
    }
};

server.listen(3000, () => {
    console.log('listening on *:3000');
});
