const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(cors());


// Serve the HTML file directly from the server
app.use(express.static(__dirname));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
// NEW: A lightweight backdoor just for UptimeRobot!
app.get('/ping', (req, res) => {
    res.status(200).send('I am awake!');
});
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// We will store basic room info here
const rooms = {};

// --- MULTIPLAYER GAME LOGIC ---
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    socket.on('joinRoom', (roomId) => {
        // If the room doesn't exist yet, create it and set default capacity to 2
        if (!rooms[roomId]) {
            rooms[roomId] = { players: [], maxPlayers: 2 };
        }

        // DYNAMIC CHECK: Is the room full based on the Host's current setting?
        if (rooms[roomId].players.length >= rooms[roomId].maxPlayers) {
            console.log(`Player ${socket.id} tried to join ${roomId}, but it is full (Max: ${rooms[roomId].maxPlayers}).`);
            socket.emit('roomFull', rooms[roomId].maxPlayers); 
            return; 
        }

        // If not full, let them join
        socket.join(roomId);
        const myPlayerId = rooms[roomId].players.length;
        rooms[roomId].players.push(socket.id);

        console.log(`Player ${socket.id} joined ${roomId} as Player ${myPlayerId}`);
        socket.emit('assignPlayerId', myPlayerId);
        io.to(roomId).emit('playerCountUpdate', rooms[roomId].players.length);
    });

    socket.on('hostStartedGame', (data) => {
        console.log(`Game started in room ${data.roomId} with ${data.numPlayers} players`);
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
    });
});


// --- TELEGRAM BOT LOGIC ---
const rawToken = process.env.TELEGRAM_BOT_TOKEN;
// .trim() strips away any invisible spaces or formatting hackers!
const token = rawToken ? rawToken.trim() : undefined;
const GAME_URL = 'https://atomic-blast.onrender.com'; 

// DEBUG TRACKER: This will tell us if Render is actually loading the token!
console.log("DEBUG - Token check:", token ? token.substring(0, 5) + "******" : "UNDEFINED! (Render is not loading the variable)");

// Added a stricter check here
if (token && token !== 'YOUR_BOT_TOKEN_HERE') {
    const bot = new TelegramBot(token, { polling: true });

    // FIX 1: Clear any stuck webhooks that might prevent polling from working
    bot.deleteWebHook().catch(console.error);

    // This handles the inline @username query
    bot.on('inline_query', (query) => {
        console.log(`[BOT] Received inline query from: ${query.from.first_name}`);

        const randomRoom = Math.random().toString(36).substring(2, 8).toUpperCase();
        const roomLink = `${GAME_URL}/?room=${randomRoom}`;

        const results = [
            {
                type: 'article',
                id: query.id, // FIX 2: Use a unique ID so Telegram doesn't get confused
                title: 'Play Atomic Blast!',
                description: 'Click to drop a game button in this chat.',
                thumbnail_url: 'https://raw.githubusercontent.com/Pravprp/atomic-blast-bot/refs/heads/main/Image.png',
                input_message_content: {
                    message_text: '💥 **Atomic Blast**\nI challenge you to a multiplayer match! Click the button below to join the lobby.',
                    parse_mode: 'Markdown'
                },
                reply_markup: {
                    inline_keyboard: [[
                        {
                            text: "🎮 Join Game",
                            url: roomLink
                        }
                    ]]
                }
            }
        ];
        
        // FIX 3: Add cache_time: 0 so Telegram generates a fresh room link every single time
        bot.answerInlineQuery(query.id, results, { cache_time: 0 }).catch(err => {
            console.error("\n[BOT ERROR] Telegram rejected the query!");
            console.error("Reason:", err.response ? err.response.body : err.message);
            console.error("\n");
        });
    });
    
    console.log("Telegram Bot logic is initialized!");
} else {
    console.log("WARNING: Telegram Bot is NOT running. Please replace 'YOUR_BOT_TOKEN_HERE' with your real token.");
}

const PORT = process.env.PORT || 3000;
// We add '0.0.0.0' so Render's port scanner instantly detects it!
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});






