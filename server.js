const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const app = express();

app.use(cors({
    origin: ["https://atomic-blast-bot.onrender.com", "http://localhost:3000"],
    methods: ["GET", "POST"]
}));

app.use(express.json());
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
        if (rooms[roomId] && rooms[roomId].gameState) {
            socket.emit('spectatorCatchUp', rooms[roomId].gameState);
        }
    });

    socket.on('hostStartedGame', (data) => {
        if (rooms[data.roomId]) {
            rooms[data.roomId].gameStarted = true;
            rooms[data.roomId].gameState = {
                rows: data.rows,
                cols: data.cols,
                numPlayers: data.numPlayers,
                gameActive: true
            };
        }
        socket.to(data.roomId).emit('gameStartedByHost', data);
    });

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

// --- TELEGRAM BOT LOGIC (WEBHOOK IMPLEMENTATION) ---
const rawToken = process.env.TELEGRAM_BOT_TOKEN;
const token = rawToken ? rawToken.trim() : undefined;
const GAME_URL = process.env.RENDER_EXTERNAL_URL || 'https://atomic-blast-bot.onrender.com';

if (token && token !== 'YOUR_BOT_TOKEN_HERE') {
    // Initialized without polling to avoid conflicts during deployment
    const bot = new TelegramBot(token);

    // Set up webhook route
    const webhookPath = `/bot${token}`;
    bot.setWebHook(`${GAME_URL}${webhookPath}`)
        .then(() => console.log(`Telegram Webhook set to: ${GAME_URL}${webhookPath}`))
        .catch((err) => console.error('Failed to set Webhook:', err.message));

    // Handle updates directly through Express
    app.post(webhookPath, (req, res) => {
        bot.processUpdate(req.body);
        res.sendStatus(200);
    });

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

    console.log("Telegram Bot logic initialized via Webhook!");
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});

// Graceful shutdown handling for Render
process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down gracefully...');
    server.close(() => {
        process.exit(0);
    });
});
