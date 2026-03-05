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

    socket.on('joinRoom', (data) => {
        const roomId = data.roomId;
        const playerName = data.playerName || 'Guest';

        // NEW: We track if the game has started, instead of maxPlayers!
        if (!rooms[roomId]) {
            rooms[roomId] = { players: [], gameStarted: false }; 
        }

        socket.join(roomId);

        // NEW: If the game is actively running, force them to be a late spectator
        if (rooms[roomId].gameStarted) {
            console.log(`Player ${socket.id} joined ${roomId} as a LATE SPECTATOR.`);
            socket.emit('roomFull'); // We use this to trigger the Spectate screen
            return; 
        }

        // Otherwise, everyone joins the lobby queue!
        const myPlayerId = rooms[roomId].players.length;
        rooms[roomId].players.push({ id: socket.id, name: playerName });

        console.log(`${playerName} joined ${roomId} as Player ${myPlayerId}`);
        socket.emit('assignPlayerId', myPlayerId);
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
        // Mark the room as actively playing so latecomers are sent to spectate
        if (rooms[data.roomId]) {
            rooms[data.roomId].gameStarted = true;
        }
        socket.to(data.roomId).emit('gameStartedByHost', data);
    });

    // NEW: When the host returns to the lobby, unlock the door for new players
    socket.on('returnToLobby', (roomId) => {
        if (rooms[roomId]) {
            rooms[roomId].gameStarted = false;
        }
    });

    socket.on('lobbyUpdate', (data) => {
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
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            
            if (playerIndex !== -1) {
                room.players.splice(playerIndex, 1);
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
            const gameLink = `${GAME_URL}/?room=${roomId}&name=${userName}`;

            bot.answerCallbackQuery(query.id, { url: gameLink }).catch(console.error);
        }
    });
    
    console.log("Telegram Bot logic initialized!");
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
