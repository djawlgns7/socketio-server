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
    pingTimeout: 30000   // 응답 대기 시간을 30초로 설정
});

app.use(cors());

// id를 키값으로 닉네임을 저장
const nicknameById = {};
// 닉네임을 키값으로 id의 리스트를 저장
const idByNickname = {};
// disconnect 후에 일정 시간 동안 재접속을 기다리기 위한 타이머 리스트
const disconnectTimers = {};
// 재접속 대기 시간
const DISCONNECT_TIMEOUT = 2500;

// 소켓이 연결될 때
io.on('connection', (socket) => {
    console.log('a user connected:', socket.id);

    // 소켓을 활용해서 로그인을 한다.
    socket.on('login', async (nickname) => {

        // 유저의 아이디와 닉네임을 키 값으로 정보를 저장
        nicknameById[socket.id] = nickname;

        if (!idByNickname[nickname]) {
            idByNickname[nickname] = [];
        }
        idByNickname[nickname].push(socket.id);

        // 재접속 시 disconnect 타이머 취소
        if (disconnectTimers[nickname]) {
            clearTimeout(disconnectTimers[nickname]);
            delete disconnectTimers[nickname];
        }

        try {
            // 유저의 상태를 db에서 online으로 바꿈
            await setOnline(nickname, true);
            console.log(`User ${nickname}(${socket.id}) login`);

            // 접속중인 친구 목록을 DB에서 받아와서 그 친구들에게 소켓으로 로그인을 했다고 알려줌
            const onlineFriends = await getOnlineFriends(nickname);

            onlineFriends.forEach(friend => {
                if (idByNickname[friend.nickname]) {
                    idByNickname[friend.nickname].forEach(friendSocketId => {
                        io.to(friendSocketId).emit('friend_login', {nickname: nickname});
                    });
                }
            });
        } catch (error) {
            console.error("Error in login event:", error);
        }
    });

    // 채팅 방에 입장
    socket.on('join_room', (room) => {
        socket.join(room);
        console.log(`User ${socket.id} joined room ${room}`);
    });

    // 채팅 방을 떠남
    socket.on('leave_room', (room) => {
        socket.leave(room);
        console.log(`User ${socket.id} left room ${room}`);
    });

    // 나와 같은 방에 있는 사람들에게 메시지를 보냄
    socket.on('send_message', (data) => {
        const {nickname, room, message} = data;
        io.to(room).emit('receive_message', {nickname, message});
    });

    // 접속중인 친구들에게 메시지를 보냄
    socket.on('send_message_to_friends', async (data) => {
        const {nickname, message} = data;
        try {
            const onlineFriends = await getOnlineFriends(nickname);

            onlineFriends.forEach(friend => {
                if (idByNickname[friend.nickname]) {
                    idByNickname[friend.nickname].forEach(friendSocketId => {
                        console.log('friend message:', nickname, message, friend.nickname, friendSocketId);
                        io.to(friendSocketId).emit('friend_message', {nickname, message});
                    });
                }
            });
        } catch (error) {
            console.error("Error in send_message_to_friends event:", error);
        }
    });

    // 소켓 접속 종료 시 작동
    socket.on('disconnect', () => {
        const nickname = nicknameById[socket.id];
        delete nicknameById[socket.id];

        if (nickname) {
            idByNickname[nickname] = idByNickname[nickname].filter(id => id !== socket.id);
            if (idByNickname[nickname].length === 0) {
                // 일정 시간 동안 재접속을 기다리기 위한 타이머 설정
                disconnectTimers[nickname] = setTimeout(async () => {
                    try {
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

                        console.log(`User ${nickname} fully disconnected after timeout`);
                    } catch (error) {
                        console.error("Error in disconnect event:", error);
                    }
                }, DISCONNECT_TIMEOUT);
            }
        }

        console.log(`user disconnected: ${nickname}, ${socket.id}`);
    });
});

// DB에서 특정 유저의 접속 상태를 변경
const setOnline = async (nickname, isOnline) => {
    try {
        await axios.put(`${BACK_URL}/user/status/update2?nickname=${nickname}&isOnline=${isOnline}`, {});
    } catch (error) {
        console.error("error setting online:", error);
    }
};

// 접속 중인 친구 목록을 받음
const getOnlineFriends = async (nickname) => {
    try {
        const response = await axios.get(`${BACK_URL}/friend/list/online2?nickname=${nickname}`);
        return response.data;
    } catch (error) {
        console.error("error fetching online friends list:", error);
        return [];
    }
};

// 연결되는 포트 번호 설정
server.listen(3000, () => {
    console.log('listening on *:3000');
});
