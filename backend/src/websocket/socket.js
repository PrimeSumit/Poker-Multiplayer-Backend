import {
  createRoom,
  joinRoom,
  leaveRoom,
  getRoom,
  roomSummary,
  getPublicRooms,
} from "./room_manager.js";
import { startGame, playerAction } from "../game/game_logic.js";
import { getRandomAvatar } from "../utils/avatar.js";
import jwt from "jsonwebtoken"; // REQUIRED for token decoding

// NOTE: The redundant call to startRoomExpiryWatcher(30 * 60 * 1000)
// has been removed from this file. It should only run once in server.js.

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
    socket.on("createRoom", async (data, callback) => {
      try {
        const { username, avatar, token, region, maxPlayers, password } = data;

        let userId;
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          userId = decoded.id;
        } catch (err) {
          if (callback)
            callback({
              success: false,
              error: "Authentication failed: Invalid token.",
            });
          return;
        }

        const room = createRoom({
          region: region || "IN",
          maxPlayers: maxPlayers || 5,
          password: password || "",
        });

        const player = {
          id: socket.id, // Ephemeral Socket ID
          userId: userId, // Persistent User ID
          username: username || "Host",
          avatar: avatar || getRandomAvatar(),
          chips: 1000,
          isDisconnected: false,
        };

        room.players.push(player);
        socket.join(room.id);
        socket.data.roomId = room.id;
        socket.data.userId = userId;

        if (callback) callback({ success: true, roomId: room.id });

        // Broadcast to all connected clients that the lobby has updated
        io.emit("lobbyUpdate", getPublicRooms());
      } catch (err) {
        console.error("CreateRoom Error:", err);
        if (callback) callback({ success: false, error: err.message });
      }
    });

    // Join an existing Room
    socket.on("joinRoom", async (data, callback) => {
      try {
        const { roomId, password, token, username, avatar } = data;

        let userId;
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          userId = decoded.id;
        } catch (err) {
          if (callback)
            callback({
              success: false,
              error: "Authentication required or failed.",
            });
          return;
        }

        const room = joinRoom(roomId, password || "");

        // CRITICAL FIX: Find player by persistent userId, not socket.id!
        let player = room.players.find((p) => p.userId === userId);
        let isReconnecting = true;

        if (player) {
          // Player is reconnecting: Update their ephemeral socket ID
          player.id = socket.id;
          player.isDisconnected = false;
        } else {
          // New player is joining
          isReconnecting = false;
          player = {
            id: socket.id,
            userId: userId, // STORE PERSISTENT ID
            username: username || `Player-${userId.slice(-5)}`,
            avatar: avatar || getRandomAvatar(),
            chips: 1000,
            isDisconnected: false,
          };
          room.players.push(player);
        }

        socket.join(room.id);
        socket.data.roomId = room.id;
        socket.data.userId = userId; // Store persistent ID on socket data

        if (callback) callback({ success: true, room: roomSummary(room) });

        // Broadcast to players in the room and update the global lobby list
        io.to(room.id).emit("roomUpdate", roomSummary(room));
        io.emit("lobbyUpdate", getPublicRooms());

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

      // Lookup player by persistent userId (more reliable)
      const player = room.players.find((p) => p.userId === socket.data.userId);
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
        type: "player",
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
      if (!room) {
        if (callback) callback({ success: false, error: "Room not found." });
        return;
      }

      // Validation: Only the host (first player) can start
      const hostId = room.players[0]?.id;
      if (hostId !== socket.id) {
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

      if (!room || !payload?.action) {
        if (callback)
          callback({
            success: false,
            error: "Invalid room or action payload.",
          });
        return;
      }

      // Validation: Player can only act on their turn
      const currentPlayer = room.players[room.currentPlayerIndex];
      // Check turn using the current ephemeral socket.id
      if (!currentPlayer || currentPlayer.id !== socket.id) {
        if (callback)
          callback({ success: false, error: "It's not your turn." });
        return;
      }

      // Pass the callback so gameLogic can report back explicit errors (Fix C)
      playerAction(
        roomId,
        socket.id,
        payload.action,
        payload.amount || 0,
        io,
        callback
      );
    });

    // Handle Player Disconnection
    socket.on("disconnect", () => {
      const roomId = socket.data.roomId;
      const userId = socket.data.userId; // Use the persistent ID if available

      if (roomId) {
        const room = getRoom(roomId);
        if (room) {
          // Look up player using persistent userId for robust messaging
          const player = room.players.find((p) => p.userId === userId);

          if (player && !player.isDisconnected) {
            const systemMessage = {
              type: "system",
              message: `${player.username} has left the room.`,
              timestamp: new Date(),
            };
            io.to(roomId).emit("newMessage", systemMessage);
          }
        }

        // leaveRoom is updated to handle cleanup and trigger lobby updates
        leaveRoom(roomId, userId, io);
      }
      console.log("Player disconnected:", socket.id);
    });
  });
};
