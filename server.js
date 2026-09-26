const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const app = express();

// FIXED: Locked down CORS policy to prevent unauthorized domain hijacking
app.use(cors({
    origin: ["https://atomic-blast-bot.onrender.com", "http://localhost:3000"],
    methods: ["GET", "POST"]
}));

app.use(express.static(__dirname));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/ping', (req, res) => {
    res.status(200).send('I am awake!');
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: { 
        origin: ["https://atomic-blast-bot.onrender.com", "http://localhost:3000"], 
        methods: ["GET", "POST"] 
    },
    cookie: false
});

const rooms = {};

// --- MULTIPLAYER GAME LOGIC ---
io.on('connection', (socket) => {
    console.log(`Connection opened: ${socket.id}`);

    socket.on('joinRoom', (data) => {
        const roomId = data.roomId;
        const playerName = data.playerName || 'Guest';
        const uid = data.uid || null;

        if (!rooms[roomId]) {
            // FIXED: Server now initializes and tracks the game state
            rooms[roomId] = { players: [], gameStarted: false, gameState: null };
        }

        const room = rooms[roomId];
        const existingPlayerIndex = uid ? room.players.findIndex(p => p.uid === uid) : -1;

        if (existingPlayerIndex !== -1) {
            const p = room.players[existingPlayerIndex];
            p.id = socket.id;
            p.name = playerName;
            p.online = true;

            socket.join(roomId);
            console.log(`${playerName} RECONNECTED to ${roomId}`);

            socket.emit('assignPlayerId', existingPlayerIndex);
            io.to(roomId).emit('lobbyPlayersUpdate', room.players);
            socket.to(roomId).emit('playerStatus', { name: playerName, status: 'online' });

            if (room.gameStarted && room.gameState) {
                // FIXED: Server sends state directly, bypassing malicious host manipulation
                socket.emit('spectatorCatchUp', room.gameState);
            }
            return;
        }

        socket.join(roomId);

        if (room.gameStarted) {
            socket.emit('roomFull');
            return;
        }

        const myPlayerId = room.players.length;
        room.players.push({ id: socket.id, uid: uid, name: playerName, online: true });

        socket.emit('assignPlayerId', myPlayerId);
        io.to(roomId).emit('lobbyPlayersUpdate', room.players);
    });

    socket.on('requestGameState', (roomId) => {
        // FIXED: Server answers spectator directly from memory
        if (rooms[roomId] && rooms[roomId].gameState) {
            socket.emit('spectatorCatchUp', rooms[roomId].gameState);
        }
    });

    socket.on('hostStartedGame', (data) => {
        if (rooms[data.roomId]) {
            rooms[data.roomId].gameStarted = true;
            // Initialize basic state structure
            rooms[data.roomId].gameState = {
                rows: data.rows,
                cols: data.cols,
                numPlayers: data.numPlayers,
                gameActive: true
            };
        }
        socket.to(data.roomId).emit('gameStartedByHost', data);
    });

    // FIXED: Continuous state syncing from the host to keep server updated
    socket.on('syncGameState', (data) => {
        if (rooms[data.roomId]) {
            rooms[data.roomId].gameState = data.state;
        }
    });

    socket.on('returnToLobby', (roomId) => {
        if (rooms[roomId]) {
            rooms[roomId].gameStarted = false;
            rooms[roomId].gameState = null;
        }
        socket.to(roomId).emit('returnToLobby');
    });

    socket.on('requestUndo', (data) => {
        socket.to(data.roomId).emit('receiveUndo');
    });

    socket.on('lobbyUpdate', (data) => {
        socket.to(data.roomId).emit('lobbyUpdated', data);
    });

    socket.on('timeoutSkip', (data) => {
        socket.to(data.roomId).emit('receiveTimeoutSkip');
    });

    socket.on('makeMove', (data) => {
        socket.to(data.roomId).emit('receiveMove', data);
    });

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const player = room.players.find(p => p.id === socket.id);

            if (player) {
                player.online = false;
                console.log(`${player.name} disconnected from ${roomId}`);

                socket.to(roomId).emit('playerStatus', { name: player.name, status: 'offline' });
                io.to(roomId).emit('lobbyPlayersUpdate', room.players);

                const anyoneOnline = room.players.some(p => p.online);
                if (!anyoneOnline) {
                    console.log(`Room ${roomId} is entirely empty. Deleting.`);
                    delete rooms[roomId];
                }
                break;
            }
        }
    });
});

// --- TELEGRAM BOT LOGIC ---
const rawToken = process.env.TELEGRAM_BOT_TOKEN;
const token = rawToken ? rawToken.trim() : undefined;
const GAME_URL = process.env.RENDER_EXTERNAL_URL || 'https://atomic-blast-bot.onrender.com';

if (token && token !== 'YOUR_BOT_TOKEN_HERE') {
    const bot = new TelegramBot(token, { polling: true });

    // FIXED: Added polling retry logic for network blips
    bot.on('polling_error', (error) => {
        const errorDetail = (error.response && error.response.body && error.response.body.description) 
            ? error.response.body.description 
            : error.message;
        console.error('Telegram polling error:', errorDetail);
        
        bot.stopPolling().then(() => {
            console.log("Retrying Telegram polling in 5 seconds...");
            setTimeout(() => bot.startPolling(), 5000);
        });
    });

    bot.deleteWebHook().catch(() => {});

    bot.on('inline_query', (query) => {
        const results = [{ type: 'game', id: query.id, game_short_name: 'atomicblast' }];
        bot.answerInlineQuery(query.id, results, { cache_time: 0 }).catch(console.error);
    });

    bot.on('callback_query', (query) => {
        if (query.game_short_name === 'atomicblast') {
            let roomId = "ROOM";
            if (query.inline_message_id) {
                roomId = query.inline_message_id.replace(/[^a-zA-Z0-9]/g, '').substring(0, 10).toUpperCase();
            } else {
                roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
            }

            const userName = encodeURIComponent(query.from.first_name || 'Player');
            const userId = query.from.id;
            const gameLink = `${GAME_URL}/?room=${roomId}&name=${userName}&uid=${userId}`;

            bot.answerCallbackQuery(query.id, { url: gameLink }).catch(console.error);
        }
    });

    console.log("Telegram Bot logic initialized!");
}

// FIXED: Removed the internal self-pinging setInterval that caused crashes on Render.

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
