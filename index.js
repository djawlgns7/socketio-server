const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const BACK_URL = 'https://back.bit-two.com';
const io = socketIo(server, {
    cors: {
        origin: "https://re.bit-two.com",
        methods: ["GET", "POST"],
        credentials: true, // 쿠키를 자동으로 전송
    },
    pingInterval: 25000, // 핑 간격을 25초로 설정
    pingTimeout: 30000   // 응답 대기 시간을 30초로 설정
});

app.use(cors());

const nicknameById = {};
const idByNickname = {};
const tokensByNickname = {};  // 유저별 토큰을 관리하는 객체
const disconnectTimers = {};
const DISCONNECT_TIMEOUT = 2000;

// JWT 만료 시간 계산
function getTokenExpiration(token) {
    try {
        const decoded = jwt.decode(token);
        return decoded.exp * 1000; // 밀리초 단위로 변환
    } catch (error) {
        console.error('Error decoding token:', error);
        return null;
    }
}

// 토큰 갱신 함수
async function refreshToken(nickname) {
    try {

        const response = await axios.post(`${BACK_URL}/reissue/socket?nickname=${nickname}`);
        const newAccessToken = response.data;

        tokensByNickname[nickname].accessToken = newAccessToken; // 새 토큰 저장

        // 새로운 만료 시간에 맞춰 다시 타이머 설정
        scheduleTokenRefresh(nickname, newAccessToken);
    } catch (error) {
        console.error("Error refreshing token:", error);
    }
}

// 토큰 갱신 타이머 설정
function scheduleTokenRefresh(nickname, token) {
    const expirationTime = getTokenExpiration(token);
    const currentTime = Date.now();
    const delay = expirationTime - currentTime - 60000; // 만료 1분 전에 갱신

    if (delay > 0) {
        setTimeout(() => {
            refreshToken(nickname);
        }, delay);
    }
}

// 소켓이 연결될 때
io.on('connection', (socket) => {
    console.log('a user connected:', socket.id);

    socket.on('login', async ({nickname, accessToken}) => {

        nicknameById[socket.id] = nickname;

        if (!idByNickname[nickname]) {
            idByNickname[nickname] = [];
        }
        idByNickname[nickname].push(socket.id);

        tokensByNickname[nickname] = {accessToken}; // 토큰 저장
        scheduleTokenRefresh(nickname, accessToken); // 토큰 갱신 타이머 설정

        if (disconnectTimers[nickname]) {
            clearTimeout(disconnectTimers[nickname]);
            delete disconnectTimers[nickname];
        }

        try {
            await setOnline(nickname, true);
            console.log(`User ${nickname}(${socket.id}) login`);

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

    socket.on('announce', (data) => {
        const {room, message} = data;
        io.to(room).emit('announce_message', {message});
    });

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

                        delete tokensByNickname[nickname]; // 유저가 완전히 끊기면 토큰 삭제

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
        const {accessToken} = tokensByNickname[nickname];

        await axios.put(`${BACK_URL}/api/user/status/update2?nickname=${nickname}&isOnline=${isOnline}`, {}, {
            headers: {
                Authorization: `Bearer ${accessToken}`
            }
        });
    } catch (error) {
        console.error("error setting online:", error);
    }
};

// 접속 중인 친구 목록을 받음
const getOnlineFriends = async (nickname) => {

    try {
        const {accessToken} = tokensByNickname[nickname];

        const response = await axios.get(`${BACK_URL}/friend/list/online2?nickname=${nickname}`, {
            headers: {
                Authorization: `Bearer ${accessToken}`
            }
        });
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
