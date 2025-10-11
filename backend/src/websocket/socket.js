import {
  createRoom,
  joinRoom,
  leaveRoom,
  getRoom,
  startRoomExpiryWatcher,
  roomSummary,
  getPublicRooms,
} from "./roomManager.js";
import { startGame, playerAction } from "../game/gameLogic.js";
import { getRandomAvatar } from "../utils/avatar.js";

// Start room expiry watcher (30 minutes)
startRoomExpiryWatcher(30 * 60 * 1000);

export const initSockets = (io) => {
  io.on("connection", (socket) => {
    console.log("Player connected:", socket.id);

    // Get Public Room List
    socket.on("getRoomList", (callback) => {
      try {
        const rooms = getPublicRooms();
        if (callback) callback({ success: true, rooms });
      } catch (err) {
        console.error("GetRoomList Error:", err);
        if (callback) callback({ success: false, error: err.message });
      }
    });

    // Create a new Room
    socket.on("createRoom", (data, callback) => {
      try {
        const room = createRoom({
          region: data.region || "IN",
          maxPlayers: data.maxPlayers || 5,
          password: data.password || "",
        });

        const player = {
          id: socket.id,
          username: data.username || "Host",
          avatar: data.avatar || getRandomAvatar(),
          chips: 1000,
          isDisconnected: false,
        };

        room.players.push(player);
        socket.join(room.id);
        socket.data.roomId = room.id;

        if (callback) callback({ success: true, roomId: room.id });
        io.to(room.id).emit("roomUpdate", roomSummary(room));
      } catch (err) {
        console.error("CreateRoom Error:", err);
        if (callback) callback({ success: false, error: err.message });
      }
    });

    // Join an existing Room
    socket.on("joinRoom", (data, callback) => {
      try {
        const room = joinRoom(data.roomId, data.password || "");
        let player = room.players.find((p) => p.id === socket.id);
        let isReconnecting = true;

        if (player) {
          // Player is reconnecting
          player.isDisconnected = false;
        } else {
          // New player is joining
          isReconnecting = false;
          player = {
            id: socket.id,
            username: data.username || `Player-${socket.id.slice(0, 5)}`,
            avatar: data.avatar || getRandomAvatar(),
            chips: 1000,
            isDisconnected: false,
          };
          room.players.push(player);
        }
        socket.join(room.id);
        socket.data.roomId = room.id;

        if (callback) callback({ success: true, room: roomSummary(room) });
        io.to(room.id).emit("roomUpdate", roomSummary(room));

        // Send a system message to the chat when a new player joins
        if (!isReconnecting) {
          const systemMessage = {
            type: "system",
            message: `${player.username} has joined the room.`,
            timestamp: new Date(),
          };
          io.to(room.id).emit("newMessage", systemMessage);
        }
      } catch (err) {
        console.error("JoinRoom Error:", err);
        if (callback) callback({ success: false, error: err.message });
      }
    });

    // Handle Chat Messages
    socket.on("sendMessage", (message, callback) => {
      const roomId = socket.data.roomId;
      const room = getRoom(roomId);

      if (!room) {
        if (callback)
          callback({ success: false, error: "You are not in a room." });
        return;
      }

      const player = room.players.find((p) => p.id === socket.id);
      if (!player) {
        if (callback) callback({ success: false, error: "Player not found." });
        return;
      }

      if (!message || typeof message !== "string" || message.trim() === "") {
        if (callback)
          callback({ success: false, error: "Message cannot be empty." });
        return;
      }

      const messageData = {
        type: "player", // Differentiate player messages from system messages
        senderId: player.id,
        username: player.username,
        avatar: player.avatar,
        message: message.trim(),
        timestamp: new Date(),
      };

      io.to(roomId).emit("newMessage", messageData);

      if (callback) callback({ success: true });
    });

    // Start the Game
    socket.on("startGame", (payload, callback) => {
      const roomId = socket.data.roomId;
      const room = getRoom(roomId);
      if (!room) return;

      // Validation: Only the host (first player) can start
      if (room.players[0].id !== socket.id) {
        if (callback)
          callback({
            success: false,
            error: "Only the host can start the game.",
          });
        return;
      }
      // Validation: Can't start a game that's already in progress
      if (room.deck && room.deck.length > 0) {
        if (callback)
          callback({ success: false, error: "A game is already in progress." });
        return;
      }

      startGame(roomId, io);
      if (callback) callback({ success: true });
    });

    // Handle a Player's Action (Fold, Call, Raise)
    socket.on("playerAction", (payload, callback) => {
      const roomId = socket.data.roomId;
      const room = getRoom(roomId);
      if (!room || !payload?.action) return;

      // Validation: Player can only act on their turn
      const currentPlayer = room.players[room.currentPlayerIndex];
      if (!currentPlayer || currentPlayer.id !== socket.id) {
        if (callback)
          callback({ success: false, error: "It's not your turn." });
        return;
      }

      playerAction(roomId, socket.id, payload.action, payload.amount || 0, io);
      if (callback) callback({ success: true });
    });

    // Handle Player Disconnection
    socket.on("disconnect", () => {
      const roomId = socket.data.roomId;
      if (roomId) {
        const room = getRoom(roomId);
        if (room) {
          const player = room.players.find((p) => p.id === socket.id);
          // Send a system message if a known player disconnects
          if (player && !player.isDisconnected) {
            const systemMessage = {
              type: "system",
              message: `${player.username} has left the room.`,
              timestamp: new Date(),
            };
            io.to(roomId).emit("newMessage", systemMessage);
          }
        }
        leaveRoom(roomId, socket.id, io);
      }
      console.log("Player disconnected:", socket.id);
    });
  });
};
