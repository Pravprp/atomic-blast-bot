const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const https = require('https');

const app = express();
app.use(cors());
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
    cors: { origin: "*", methods: ["GET", "POST"] },
    cookie: false
});

const rooms = {};

// Clean external URL formatting
const PUBLIC_URL = (process.env.RENDER_EXTERNAL_URL || process.env.GAME_URL || 'https://atomic-blast.onrender.com').replace(/\/$/, '');

// --- MULTIPLAYER SOCKET LOGIC ---
io.on('connection', (socket) => {
    console.log(`Connection opened: ${socket.id}`);

    socket.on('joinRoom', (data) => {
        const roomId = data.roomId;
        const playerName = data.playerName || 'Guest';
        const uid = data.uid || socket.id;

        if (!rooms[roomId]) {
            rooms[roomId] = { players: [], gameStarted: false };
        }

        const room = rooms[roomId];

        // 1. Reconnection Check
        const existingPlayerIndex = room.players.findIndex(p => p.uid === uid);

        if (existingPlayerIndex !== -1) {
            const p = room.players[existingPlayerIndex];
            p.id = socket.id;
            p.online = true;

            socket.join(roomId);
            console.log(`${playerName} reconnected to room ${roomId}`);

            socket.emit('assignPlayerId', existingPlayerIndex);
            io.to(roomId).emit('lobbyPlayersUpdate', room.players);
            socket.to(roomId).emit('playerStatus', { name: playerName, status: 'online' });

            if (room.gameStarted) {
                const activePeer = room.players.find(other => other.online && other.id !== socket.id);
                if (activePeer) {
                    io.to(activePeer.id).emit('hostPleaseSendState', socket.id);
                }
            }
            return;
        }

        // 2. New Player Connection
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

    socket.on('hostStartedGame', (data) => {
        if (rooms[data.roomId]) rooms[data.roomId].gameStarted = true;
        socket.to(data.roomId).emit('gameStartedByHost', data);
    });

    socket.on('returnToLobby', (roomId) => {
        if (rooms[roomId]) rooms[roomId].gameStarted = false;
        io.to(roomId).emit('resetToLobby');
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
                console.log(`${player.name} disconnected from room ${roomId}`);

                socket.to(roomId).emit('playerStatus', { name: player.name, status: 'offline' });
                io.to(roomId).emit('lobbyPlayersUpdate', room.players);

                const anyoneOnline = room.players.some(p => p.online);
                if (!anyoneOnline) {
                    console.log(`Room ${roomId} is empty. Purging memory.`);
                    delete rooms[roomId];
                }
                break;
            }
        }
    });
});

// --- TELEGRAM BOT INTEGRATION ---
const rawToken = process.env.TELEGRAM_BOT_TOKEN;
const token = rawToken ? rawToken.trim() : undefined;

if (token && token !== 'YOUR_BOT_TOKEN_HERE') {
    const isProduction = Boolean(process.env.RENDER_EXTERNAL_URL || process.env.GAME_URL);
    let bot;

    if (isProduction) {
        // Use Webhook mode on Render to avoid 409 polling conflicts during deploys
        bot = new TelegramBot(token);
        const webhookPath = `/bot${token}`;
        const webhookUrl = `${PUBLIC_URL}${webhookPath}`;

        app.post(webhookPath, (req, res) => {
            bot.processUpdate(req.body);
            res.sendStatus(200);
        });

        bot.setWebHook(webhookUrl).then(() => {
            console.log(`Telegram Webhook activated: ${webhookUrl}`);
        }).catch((err) => {
            console.error('Webhook registration failed:', err.message);
        });
    } else {
        // Use Polling mode when running locally
        bot = new TelegramBot(token, { polling: true });
        bot.on('polling_error', (error) => {
            console.error('Telegram polling error:', error.code || error.message);
        });
        console.log('Telegram Bot operational in polling mode.');
    }

    // Direct /start command handler
    bot.onText(/\/start/, (msg) => {
        bot.sendGame(msg.chat.id, 'atomicblast').catch((err) => {
            console.error('sendGame error:', err.message);
            bot.sendMessage(msg.chat.id, `Welcome to Atomic Blast! Play here: ${PUBLIC_URL}`);
        });
    });

    // Inline queries for sharing the game into chats
    bot.on('inline_query', (query) => {
        const results = [
            {
                type: 'game',
                id: query.id,
                game_short_name: 'atomicblast'
            }
        ];
        bot.answerInlineQuery(query.id, results, { cache_time: 0 }).catch(console.error);
    });

    // Launch button clicked from Telegram game card
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
            const gameLink = `${PUBLIC_URL}/?room=${roomId}&name=${userName}&uid=${userId}`;

            bot.answerCallbackQuery(query.id, { url: gameLink }).catch(console.error);
        }
    });

    console.log("Telegram Bot logic initialized.");
}

// Keepalive self-ping for free-tier web services
if (process.env.RENDER_EXTERNAL_URL || process.env.GAME_URL) {
    setInterval(() => {
        const pingTarget = `${PUBLIC_URL}/ping`;
        const client = pingTarget.startsWith('https') ? https : http;
        client.get(pingTarget, () => {}).on('error', (err) => {
            console.error('Keepalive ping notice:', err.message);
        });
    }, 840000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
});
