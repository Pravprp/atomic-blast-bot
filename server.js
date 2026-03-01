const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(cors());

// NEW: This tells the server to send your index.html file to anyone who visits the link
app.use(express.static(__dirname));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = {};

// --- MULTIPLAYER GAME LOGIC ---
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    socket.on('joinRoom', (roomId) => {
        if (!rooms[roomId]) { rooms[roomId] = { players: [], maxPlayers: 2 }; }

        if (rooms[roomId].players.length >= rooms[roomId].maxPlayers) {
            socket.emit('roomFull', rooms[roomId].maxPlayers); 
            return; 
        }

        socket.join(roomId);
        const myPlayerId = rooms[roomId].players.length;
        rooms[roomId].players.push(socket.id);
        socket.emit('assignPlayerId', myPlayerId);
        io.to(roomId).emit('playerCountUpdate', rooms[roomId].players.length);
    });

    socket.on('hostStartedGame', (data) => {
        socket.to(data.roomId).emit('gameStartedByHost', data);
    });

    socket.on('lobbyUpdate', (data) => {
        if (rooms[data.roomId]) { rooms[data.roomId].maxPlayers = data.numPlayers; }
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
// !!! REPLACE THIS WITH YOUR TOKEN FROM BOTFATHER !!!
const token = '8508348463:AAGlD368tiBlU6u7p1uFLFHbqAtDpeUADFA'; 

// !!! REPLACE THIS WITH YOUR FUTURE GLITCH URL (e.g., https://my-atomic-game.glitch.me) !!!
const GAME_URL = 'https://atomic-blast.onrender.com/'; 

if (token !== 'YOUR_BOT_TOKEN_HERE') {
    const bot = new TelegramBot(token, { polling: true });

    // This handles the inline @username query
    bot.on('inline_query', (query) => {
        // Generate a random room ID for this specific chat
        const randomRoom = Math.random().toString(36).substring(2, 8).toUpperCase();
        const roomLink = `${GAME_URL}/?room=${randomRoom}`;

        const results = [
            {
                type: 'article',
                id: '1',
                title: 'Play Atomic Blast!',
                description: 'Click to drop a game button in this chat.',
                input_message_content: {
                    message_text: '💥 **Atomic Blast**\nI challenge you to a multiplayer match! Click the button below to join the lobby.'
                },
                reply_markup: {
                    inline_keyboard: [[
                        {
                            text: "🎮 Join Game",
                            web_app: { url: roomLink } // Opens the game natively in Telegram
                        }
                    ]]
                }
            }
        ];
        bot.answerInlineQuery(query.id, results);
    });
    console.log("Telegram Bot is running!");
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);

});

