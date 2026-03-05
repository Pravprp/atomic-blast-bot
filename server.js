const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const https = require('https'); 

const app = express();
app.use(cors());

// Serve the HTML file directly from the server
app.use(express.static(__dirname));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// A lightweight backdoor just for keeping the server awake
app.get('/ping', (req, res) => {
    res.status(200).send('I am awake!');
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    cookie: false 
});

const rooms = {};

// --- MULTIPLAYER GAME LOGIC ---
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    socket.on('joinRoom', (roomId) => {
        if (!rooms[roomId]) {
            rooms[roomId] = { players: [], maxPlayers: 2 };
        }

        if (rooms[roomId].players.length >= rooms[roomId].maxPlayers) {
            console.log(`Player ${socket.id} joined ${roomId} as a SPECTATOR.`);
            socket.join(roomId); 
            socket.emit('roomFull', rooms[roomId].maxPlayers); 
            return; 
        }

        socket.join(roomId);
        const myPlayerId = rooms[roomId].players.length;
        rooms[roomId].players.push(socket.id);

        console.log(`Player ${socket.id} joined ${roomId} as Player ${myPlayerId}`);
        socket.emit('assignPlayerId', myPlayerId);
        io.to(roomId).emit('playerCountUpdate', rooms[roomId].players.length);
    });

    socket.on('requestGameState', (roomId) => {
        if (rooms[roomId] && rooms[roomId].players.length > 0) {
            const hostId = rooms[roomId].players[0]; 
            io.to(hostId).emit('hostPleaseSendState', socket.id);
        }
    });

    socket.on('hostRepliedWithState', (data) => {
        io.to(data.spectatorId).emit('spectatorCatchUp', data.state);
    });

    socket.on('hostStartedGame', (data) => {
        socket.to(data.roomId).emit('gameStartedByHost', data);
    });

    socket.on('lobbyUpdate', (data) => {
        if (rooms[data.roomId]) {
            rooms[data.roomId].maxPlayers = data.numPlayers;
        }
        socket.to(data.roomId).emit('lobbyUpdated', data);
    });

    socket.on('requestUndo', (data) => {
        socket.to(data.roomId).emit('receiveUndo');
    });

    socket.on('timeoutSkip', (data) => {
        socket.to(data.roomId).emit('receiveTimeoutSkip');
    });

    socket.on('makeMove', (data) => {
        socket.to(data.roomId).emit('receiveMove', data);
    });

    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const playerIndex = room.players.indexOf(socket.id);
            
            if (playerIndex !== -1) {
                room.players.splice(playerIndex, 1);
                io.to(roomId).emit('playerCountUpdate', room.players.length);
                
                if (room.players.length === 0) {
                    console.log(`Room ${roomId} is empty. Deleting to save memory.`);
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
const GAME_URL = 'https://atomic-blast.onrender.com'; 

console.log("DEBUG - Token check:", token ? token.substring(0, 5) + "******" : "UNDEFINED!");

if (token && token !== 'YOUR_BOT_TOKEN_HERE') {
    const bot = new TelegramBot(token, { polling: true });

    bot.deleteWebHook().catch(console.error);

    bot.on('inline_query', (query) => {
        console.log(`[BOT] Received inline query from: ${query.from.first_name}`);

        const results = [
            {
                type: 'game',
                id: query.id, 
                game_short_name: 'atomicblast'
                // FIX: We completely deleted the 'reply_markup' block here!
                // Telegram will now perfectly auto-generate the native Play button itself.
            }
        ];
        
        bot.answerInlineQuery(query.id, results, { cache_time: 0 }).catch(err => {
            console.error("\n[BOT ERROR]", err);
        });
    });

    bot.on('callback_query', (query) => {
        if (query.game_short_name === 'atomicblast') {
            
            let roomId = "ROOM";
            if (query.inline_message_id) {
                roomId = query.inline_message_id.replace(/[^a-zA-Z0-9]/g, '').substring(0, 10).toUpperCase();
            } else {
                roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
            }

            const gameLink = `${GAME_URL}/?room=${roomId}`;

            bot.answerCallbackQuery(query.id, { url: gameLink }).catch(console.error);
        }
    });
    
    console.log("Telegram Bot logic initialized with Native Game API!");
} else {
    console.log("WARNING: Telegram Bot is NOT running.");
}

// --- AUTO PING TO PREVENT SLEEP ---
setInterval(() => {
    https.get(GAME_URL + '/ping', (res) => {
        if (res.statusCode === 200) {
            console.log("Self-ping successful. Keeping the server awake.");
        }
    }).on('error', (err) => {
        console.error("Self-ping failed:", err.message);
    });
}, 840000); 

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
