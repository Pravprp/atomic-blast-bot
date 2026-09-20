const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const https = require('https');

const app = express();
app.use(cors());

app.use(express.static(__dirname));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/ping', (req, res) => {
    res.status(200).send('I am awake!');
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// rooms[roomId] = { players: [...], gameStarted: bool, settings: { numPlayers, rows, cols } }
const rooms = {};

io.on('connection', (socket) => {
    console.log(`Connected: ${socket.id}`);

    socket.on('joinRoom', (data) => {
        const roomId = data.roomId;
        const playerName = data.playerName || 'Player';
        const uid = data.uid;

        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [],
                gameStarted: false,
                settings: { numPlayers: 2, rows: 6, cols: 6 }
            };
        }

        const room = rooms[roomId];
        socket.join(roomId);

        // 1. RECONNECTING TO ACTIVE GAME
        if (room.gameStarted) {
            const existingIndex = room.players.findIndex(p => p.uid === uid);
            if (existingIndex !== -1) {
                const p = room.players[existingIndex];
                p.id = socket.id;
                p.online = true;

                socket.emit('assignPlayerId', existingIndex);
                io.to(roomId).emit('lobbyPlayersUpdate', room.players);
                socket.to(roomId).emit('playerStatus', { name: playerName, status: 'online' });

                // Request active board from another online player
                const activePeer = room.players.find(other => other.online && other.id !== socket.id);
                if (activePeer) {
                    io.to(activePeer.id).emit('hostPleaseSendState', socket.id);
                }
                return;
            } else {
                socket.emit('roomFull');
                return;
            }
        }

        // 2. IN LOBBY (Clean up duplicate sessions for same UID)
        const duplicateIndex = room.players.findIndex(p => p.uid === uid);
        if (duplicateIndex !== -1) {
            room.players[duplicateIndex].id = socket.id;
            room.players[duplicateIndex].online = true;
            room.players[duplicateIndex].name = playerName;
        } else {
            room.players.push({ id: socket.id, uid: uid, name: playerName, online: true });
        }

        // Send settings to newcomer
        socket.emit('lobbyUpdated', room.settings);

        // Re-assign IDs for all players in lobby to ensure room.players[0] is Host
        room.players.forEach((p, idx) => {
            io.to(p.id).emit('assignPlayerId', idx);
        });

        io.to(roomId).emit('lobbyPlayersUpdate', room.players);
    });

    socket.on('lobbyUpdate', (data) => {
        if (rooms[data.roomId]) {
            rooms[data.roomId].settings = {
                numPlayers: data.numPlayers,
                rows: data.rows,
                cols: data.cols
            };
            socket.to(data.roomId).emit('lobbyUpdated', data);
        }
    });

    socket.on('hostStartedGame', (data) => {
        if (rooms[data.roomId]) {
            rooms[data.roomId].gameStarted = true;
            socket.to(data.roomId).emit('gameStartedByHost', data);
        }
    });

    socket.on('requestGameState', (roomId) => {
        if (rooms[roomId]) {
            const activePeer = rooms[roomId].players.find(p => p.online && p.id !== socket.id);
            if (activePeer) {
                io.to(activePeer.id).emit('hostPleaseSendState', socket.id);
            }
        }
    });

    socket.on('hostRepliedWithState', (data) => {
        io.to(data.spectatorId).emit('spectatorCatchUp', data.state);
    });

    socket.on('returnToLobby', (roomId) => {
        const room = rooms[roomId];
        if (room) {
            room.gameStarted = false;
            // Clean up players who dropped out during the game
            room.players = room.players.filter(p => p.online);

            // Re-assign hosts
            room.players.forEach((p, idx) => {
                io.to(p.id).emit('assignPlayerId', idx);
            });

            io.to(roomId).emit('returnedToLobby');
            io.to(roomId).emit('lobbyPlayersUpdate', room.players);
        }
    });

    socket.on('makeMove', (data) => {
        socket.to(data.roomId).emit('receiveMove', data);
    });

    socket.on('timeoutSkip', (data) => {
        socket.to(data.roomId).emit('receiveTimeoutSkip');
    });

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);

            if (playerIndex !== -1) {
                const player = room.players[playerIndex];

                if (!room.gameStarted) {
                    // In lobby: remove them completely so host privileges pass to next in line
                    room.players.splice(playerIndex, 1);

                    if (room.players.length === 0) {
                        delete rooms[roomId];
                    } else {
                        // Promote new host and reassign indices
                        room.players.forEach((p, idx) => {
                            io.to(p.id).emit('assignPlayerId', idx);
                        });
                        io.to(roomId).emit('lobbyPlayersUpdate', room.players);
                    }
                } else {
                    // In active game: mark offline so reconnect is possible
                    player.online = false;
                    socket.to(roomId).emit('playerStatus', { name: player.name, status: 'offline' });
                    io.to(roomId).emit('lobbyPlayersUpdate', room.players);

                    const anyoneOnline = room.players.some(p => p.online);
                    if (!anyoneOnline) {
                        delete rooms[roomId];
                    }
                }
                break;
            }
        }
    });
});

// --- TELEGRAM BOT LOGIC ---
const rawToken = process.env.TELEGRAM_BOT_TOKEN;
const token = rawToken ? rawToken.trim() : undefined;
// Use Render's system URL or custom environment variable
const GAME_URL = process.env.RENDER_EXTERNAL_URL || process.env.GAME_URL || 'https://atomic-blast.onrender.com';

if (token && token !== 'YOUR_BOT_TOKEN_HERE') {
    const bot = new TelegramBot(token, { polling: true });

    bot.on('inline_query', (query) => {
        bot.answerInlineQuery(query.id, [
            {
                type: 'game',
                id: query.id,
                game_short_name: 'atomicblast'
            }
        ], { cache_time: 0 }).catch(console.error);
    });

    bot.on('callback_query', (query) => {
        if (query.game_short_name === 'atomicblast') {
            let roomId = "ROOM";

            // CRITICAL FIX: Share the same room across group chats and message clicks
            if (query.inline_message_id) {
                roomId = query.inline_message_id.replace(/[^a-zA-Z0-9]/g, '').substring(0, 10).toUpperCase();
            } else if (query.message) {
                // If clicked from a chat message, bind to chat ID + message ID
                roomId = `C${Math.abs(query.message.chat.id)}M${query.message.message_id}`.replace(/[^a-zA-Z0-9]/g, '').substring(0, 10).toUpperCase();
            } else {
                roomId = "GLOBAL";
            }

            const userName = encodeURIComponent(query.from.first_name || 'Player');
            const userId = query.from.id;
            const gameLink = `${GAME_URL}/?room=${roomId}&name=${userName}&uid=${userId}`;

            bot.answerCallbackQuery(query.id, { url: gameLink }).catch(console.error);
        }
    });

    console.log("Telegram Bot logic initialized!");
}

// Keep-alive ping
setInterval(() => {
    https.get(GAME_URL + '/ping', (res) => {}).on('error', () => {});
}, 600000); // every 10 minutes

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
