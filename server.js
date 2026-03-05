const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const https = require('https'); // Required for the auto-ping system

const app = express();
app.use(cors());

// Serve the HTML file directly from the server
app.use(express.static(__dirname));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// A lightweight backdoor just for keeping the server awake!
app.get('/ping', (req, res) => {
    res.status(200).send('I am awake!');
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    cookie: false // <--- This proves to Telegram you are setting NO cookies!
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
            console.log(`Player ${socket.id} joined ${roomId} as a SPECTATOR.`);
            
            // Let them join the socket room so they can watch the live moves!
            socket.join(roomId); 
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

    // --- SPECTATOR STATE SYNC ---
    socket.on('requestGameState', (roomId) => {
        // The spectator asks the Host (Player 0) for a picture of the current board
        if (rooms[roomId] && rooms[roomId].players.length > 0) {
            const hostId = rooms[roomId].players[0]; 
            io.to(hostId).emit('hostPleaseSendState', socket.id);
        }
    });

    socket.on('hostRepliedWithState', (data) => {
        // Send the board state specifically to the spectator who asked for it
        io.to(data.spectatorId).emit('spectatorCatchUp', data.state);
    });
    // ---------------------------------

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

    // --- OPTIMIZED DISCONNECT LOGIC ---
    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        
        // Search through all rooms to find where this player was
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const playerIndex = room.players.indexOf(socket.id);
            
            if (playerIndex !== -1) {
                // Remove the player from the room
                room.players.splice(playerIndex, 1);
                io.to(roomId).emit('playerCountUpdate', room.players.length);
                
                // OPTIMIZATION: If the room is completely empty, delete it to free up RAM!
                if (room.players.length === 0) {
                    console.log(`Room ${roomId} is empty. Deleting to save memory.`);
                    delete rooms[roomId];
                }
                break; // Stop searching once we found them
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
    // We go back to Polling. It is 100% reliable and fixes the "not responding" bug!
    const bot = new TelegramBot(token, { polling: true });

    bot.deleteWebHook().catch(console.error);

    // This handles the inline @username query
    bot.on('inline_query', (query) => {
        console.log(`[BOT] Received inline query from: ${query.from.first_name}`);

        const randomRoom = Math.random().toString(36).substring(2, 8).toUpperCase();
        const roomLink = `${GAME_URL}/?room=${randomRoom}`;

        const results = [
            {
                // We switch back to 'article'. This completely kills the Privacy Popup and the Share Screen!
                type: 'article',
                id: query.id, 
                title: 'Play Atomic Blast!',
                description: 'Click to instantly drop the game in this chat.',
                thumbnail_url: 'https://raw.githubusercontent.com/Pravprp/atomic-blast-bot/refs/heads/main/Image.png',
                thumbnail_width: 120,
                thumbnail_height: 120,
                input_message_content: {
                    // The stealth link trick to generate the big clickable image
                    message_text: `[ ](${roomLink})💥 **Atomic Blast**\nI challenge you to a multiplayer match! Click the image or button below to join.`,
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
        
        bot.answerInlineQuery(query.id, results, { cache_time: 0 }).catch(err => {
            console.error("\n[BOT ERROR] Telegram rejected the query!");
            console.error("Reason:", err.response ? err.response.body : err.message);
        });
    });
    
    console.log("Telegram Bot logic initialized in Stealth Mode!");
} else {
    console.log("WARNING: Telegram Bot is NOT running. Please replace 'YOUR_BOT_TOKEN_HERE' with your real token.");
}

// --- AUTO PING TO PREVENT SLEEP ---
// This automatically hits your /ping route every 14 minutes
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
// We add '0.0.0.0' so Render's port scanner instantly detects it!
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});
