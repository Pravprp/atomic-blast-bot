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
    cors: { origin: "*", methods: ["GET", "POST"] },
    cookie: false 
});

const rooms = {};

// --- MULTIPLAYER GAME LOGIC ---
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    // NEW: We now receive both the Room ID and the Player's Name
    socket.on('joinRoom', (data) => {
        const roomId = data.roomId;
        const playerName = data.playerName || 'Guest';

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
        
        // NEW: Store the name alongside the connection ID
        rooms[roomId].players.push({ id: socket.id, name: playerName });

        console.log(`${playerName} joined ${roomId} as Player ${myPlayerId}`);
        socket.emit('assignPlayerId', myPlayerId);
        
        // NEW: Broadcast the full array of names to the room
        io.to(roomId).emit('lobbyPlayersUpdate', rooms[roomId].players);
    });

    socket.on('requestGameState', (roomId) => {
        if (rooms[roomId] && rooms[roomId].players.length > 0) {
            const hostId = rooms[roomId].players[0].id; 
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
            
            // Search for the disconnected player's ID
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            
            if (playerIndex !== -1) {
                room.players.splice(playerIndex, 1);
                
                // Broadcast the updated name list to everyone left in the lobby
                io.to(roomId).emit('lobbyPlayersUpdate', room.players);
                
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

if (token && token !== 'YOUR_BOT_TOKEN_HERE') {
    const bot = new TelegramBot(token, { polling: true });
    bot.deleteWebHook().catch(console.error);

    bot.on('inline_query', (query) => {
        const results = [
            {
                type: 'game',
                id: query.id, 
                game_short_name: 'atomicblast',
                reply_markup: {
                    inline_keyboard: [[
                        {
                            text: "🎮 Enter Game",
                            callback_game: {} 
                        }
                    ]]
                }
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

            // NEW: Grab their first name from Telegram and attach it to the URL!
            const userName = encodeURIComponent(query.from.first_name || 'Player');
            const gameLink = `${GAME_URL}/?room=${roomId}&name=${userName}`;

            bot.answerCallbackQuery(query.id, { url: gameLink }).catch(console.error);
        }
    });
    
    console.log("Telegram Bot logic initialized with Native Game API!");
} else {
    console.log("WARNING: Telegram Bot is NOT running.");
}

setInterval(() => {
    https.get(GAME_URL + '/ping', (res) => {
        if (res.statusCode === 200) {}
    }).on('error', (err) => {});
}, 840000); 

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
