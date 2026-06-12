const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Stockage des parties
const games = new Map();
const waitingPlayers = [];

class GameSession {
    constructor(roomId, player1Id) {
        this.roomId = roomId;
        this.players = {
            [player1Id]: { role: 'south', ready: false, name: 'Joueur 1' }
        };
        this.gameState = {
            southPits: [4, 4, 4, 4, 4, 4],
            northPits: [4, 4, 4, 4, 4, 4],
            southStore: 0,
            northStore: 0,
            currentTurn: 'south',
            gameActive: true,
            gameFinished: false
        };
        this.lastActivity = Date.now();
    }

    addPlayer(playerId, playerName = 'Joueur 2') {
        this.players[playerId] = { role: 'north', ready: false, name: playerName };
        return true;
    }

    setPlayerName(playerId, name) {
        if (this.players[playerId]) {
            this.players[playerId].name = name;
        }
    }

    playerReady(playerId) {
        if (this.players[playerId]) {
            this.players[playerId].ready = true;
            return this.areBothReady();
        }
        return false;
    }

    areBothReady() {
        const players = Object.values(this.players);
        return players.length === 2 && players.every(p => p.ready);
    }

    getPlayerRole(playerId) {
        return this.players[playerId]?.role;
    }

    disconnectPlayer(playerId) {
        if (this.players[playerId]) {
            this.players[playerId].disconnected = true;
        }
    }
}

io.on('connection', (socket) => {
    console.log(`🎮 Joueur connecté: ${socket.id}`);
    
    let currentRoom = null;
    let playerName = null;

    // Définir le nom du joueur
    socket.on('set-name', (name) => {
        playerName = name || `Joueur_${socket.id.slice(0,4)}`;
        console.log(`📝 ${socket.id} s'appelle: ${playerName}`);
    });

    // Chercher une partie
    socket.on('find-game', () => {
        console.log(`🔍 ${socket.id} cherche une partie`);
        
        if (waitingPlayers.length > 0) {
            const waitingPlayer = waitingPlayers.shift();
            const roomId = `game_${Date.now()}_${waitingPlayer}`;
            
            const game = new GameSession(roomId, waitingPlayer);
            game.addPlayer(socket.id, playerName);
            
            if (waitingPlayer.playerName) {
                game.setPlayerName(waitingPlayer, waitingPlayer.playerName);
            }
            
            games.set(roomId, game);
            currentRoom = roomId;
            
            socket.join(roomId);
            const waitingSocket = io.sockets.sockets.get(waitingPlayer.id);
            if (waitingSocket) {
                waitingSocket.join(roomId);
                waitingSocket.currentRoom = roomId;
                
                const player1Role = game.getPlayerRole(waitingPlayer.id);
                const player2Role = game.getPlayerRole(socket.id);
                
                io.to(roomId).emit('game-found', {
                    roomId: roomId,
                    players: {
                        [waitingPlayer.id]: { role: player1Role, name: waitingPlayer.playerName || 'Joueur 1' },
                        [socket.id]: { role: player2Role, name: playerName || 'Joueur 2' }
                    },
                    myId: socket.id
                });
                
                console.log(`✅ Partie créée: ${roomId}`);
            } else {
                games.delete(roomId);
                socket.emit('error', 'Erreur: joueur introuvable');
            }
        } else {
            waitingPlayers.push({ id: socket.id, playerName: playerName });
            socket.emit('waiting', 'Recherche d\'adversaire...');
            console.log(`⏳ ${socket.id} en file d'attente`);
        }
    });

    // Joueur prêt
    socket.on('player-ready', (roomId) => {
        const game = games.get(roomId);
        if (game && game.players[socket.id]) {
            const allReady = game.playerReady(socket.id);
            if (allReady) {
                const playersInfo = {};
                for (const [id, info] of Object.entries(game.players)) {
                    playersInfo[id] = { role: info.role, name: info.name };
                }
                
                io.to(roomId).emit('game-start', {
                    gameState: game.gameState,
                    players: playersInfo,
                    yourRole: game.getPlayerRole(socket.id)
                });
                console.log(`🎯 Partie démarrée: ${roomId}`);
            } else {
                socket.to(roomId).emit('opponent-waiting', 'En attente de l\'adversaire...');
            }
        }
    });

    // Mouvement joueur
    socket.on('make-move', (data) => {
        const { roomId, player, pitIndex, gameState } = data;
        const game = games.get(roomId);
        
        if (game && game.gameState.gameActive && !game.gameState.gameFinished) {
            const currentTurn = game.gameState.currentTurn;
            const playerRole = game.getPlayerRole(socket.id);
            
            if (playerRole === currentTurn) {
                game.gameState = gameState;
                game.lastActivity = Date.now();
                
                io.to(roomId).emit('game-update', {
                    gameState: game.gameState,
                    lastMove: { player, pitIndex }
                });
                
                if (game.gameState.gameFinished) {
                    let winner = null;
                    if (game.gameState.southStore > game.gameState.northStore) winner = 'south';
                    else if (game.gameState.northStore > game.gameState.southStore) winner = 'north';
                    
                    io.to(roomId).emit('game-over', {
                        winner: winner,
                        scores: {
                            south: game.gameState.southStore,
                            north: game.gameState.northStore
                        }
                    });
                    
                    setTimeout(() => games.delete(roomId), 300000);
                }
            } else {
                socket.emit('error', 'Ce n\'est pas votre tour !');
            }
        }
    });

    // Quitter la partie
    socket.on('leave-game', (roomId) => {
        const game = games.get(roomId);
        if (game) {
            io.to(roomId).emit('opponent-left', 'L\'adversaire a quitté la partie');
            games.delete(roomId);
        }
        
        const index = waitingPlayers.findIndex(w => w.id === socket.id);
        if (index !== -1) waitingPlayers.splice(index, 1);
        
        if (currentRoom) socket.leave(currentRoom);
        currentRoom = null;
    });

    // Déconnexion
    socket.on('disconnect', () => {
        console.log(`❌ Joueur déconnecté: ${socket.id}`);
        
        const index = waitingPlayers.findIndex(w => w.id === socket.id);
        if (index !== -1) waitingPlayers.splice(index, 1);
        
        for (const [roomId, game] of games.entries()) {
            if (game.players[socket.id]) {
                io.to(roomId).emit('opponent-left', 'L\'adversaire a quitté la partie');
                games.delete(roomId);
                break;
            }
        }
    });
});

// Nettoyage des parties inactives
setInterval(() => {
    const now = Date.now();
    for (const [roomId, game] of games.entries()) {
        if (now - game.lastActivity > 3600000) {
            games.delete(roomId);
        }
    }
}, 600000);

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`);
});