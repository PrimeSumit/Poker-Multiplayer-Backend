import {
  createRoom,
  joinRoom,
  leaveRoom,
  getRoom,
  roomSummary, // Still used for lobby
  getPublicRooms,
} from "./roomManager.js";
import { startGame, playerAction } from "../game/gameLogic.js";
import { getRandomAvatar } from "../utils/avatar.js";
import jwt from "jsonwebtoken";
import User from "../models/user.js";

// =====================================================
//  SOCKET INITIALIZATION WITH AUTH MIDDLEWARE
// =====================================================
export const initSockets = (io) => {
  // ✅ AUTHENTICATION MIDDLEWARE (runs BEFORE connection event)
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error("Authentication error: No token provided."));
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select("-password");
      if (!user) {
        return next(new Error("Authentication error: User not found."));
      }

      socket.user = {
        id: user._id.toString(),
        username: user.username,
        avatar: user.avatar || getRandomAvatar(),
      };

      next();
    } catch (err) {
      console.error("Socket Auth Error:", err.message);
      next(new Error("Authentication error: Invalid token."));
    }
  });

  // =====================================================
  //  CONNECTION HANDLER
  // =====================================================
  io.on("connection", (socket) => {
    console.log(`✅ Player connected: ${socket.user.username} (${socket.id})`);

    // =====================================================
    //  GET ROOM LIST
    // =====================================================
    socket.on("getRoomList", (callback) => {
      try {
        const rooms = getPublicRooms();
        callback?.({ success: true, rooms });
      } catch (err) {
        console.error("GetRoomList Error:", err);
        callback?.({ success: false, error: err.message });
      }
    });

    // =====================================================
    //  CREATE ROOM
    // =====================================================
    socket.on("createRoom", async (data, callback) => {
      try {
        const { region, maxPlayers, password } = data;

        const room = createRoom({
          region: region || "IN",
          maxPlayers: maxPlayers || 5,
          password: password || "",
        });

        const player = {
          id: socket.id,
          userId: socket.user.id,
          username: socket.user.username,
          avatar: socket.user.avatar,
          chips: 1000,
          isDisconnected: false,
        };

        room.players.push(player);
        socket.join(room.id);
        socket.data.roomId = room.id;
        socket.data.userId = socket.user.id;

        callback?.({ success: true, roomId: room.id });
        io.emit("lobbyUpdate", getPublicRooms());
      } catch (err) {
        console.error("CreateRoom Error:", err);
        callback?.({ success: false, error: err.message });
      }
    });

    // =====================================================
    //  JOIN ROOM
    // =====================================================
    socket.on("joinRoom", (data, callback) => {
      try {
        const { roomId, password } = data;

        const room = joinRoom(roomId, password || "");
        let player = room.players.find((p) => p.userId === socket.user.id);
        let isReconnecting = true;

        if (player) {
          player.id = socket.id;
          player.isDisconnected = false;
        } else {
          isReconnecting = false;
          player = {
            id: socket.id,
            userId: socket.user.id,
            username: socket.user.username,
            avatar: socket.user.avatar,
            chips: 1000,
            isDisconnected: false,
          };
          room.players.push(player);
        }

        socket.join(room.id);
        socket.data.roomId = room.id;
        socket.data.userId = socket.user.id;

        // --- FIX: Create the correct payload for the game room ---
        const gameRoomPayload = {
          id: room.id,
          // Send the full player list
          players: room.players.map((p) => ({
            id: p.id,
            userId: p.userId,
            username: p.username,
            avatar: p.avatar,
            chips: p.chips,
            isDisconnected: p.isDisconnected,
          })),
          hostId: room.players[0]?.userId || null, // Per Phase 1
        };
        // --- END FIX ---

        // --- FIX: Send the correct payload ---
        callback?.({ success: true, room: gameRoomPayload }); // For the person joining
        io.to(room.id).emit("roomUpdate", gameRoomPayload); // For everyone else
        // --- END FIX ---

        io.emit("lobbyUpdate", getPublicRooms()); // This is fine

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
        callback?.({ success: false, error: err.message });
      }
    });

    // =====================================================
    //  CHAT MESSAGE
    // =====================================================
    socket.on("sendMessage", (message, callback) => {
      const roomId = socket.data.roomId;
      const room = getRoom(roomId);

      if (!room) return callback?.({ success: false, error: "No room found." });

      const player = room.players.find((p) => p.userId === socket.data.userId);
      if (!player)
        return callback?.({ success: false, error: "Player not found." });

      if (!message || typeof message !== "string" || !message.trim()) {
        return callback?.({ success: false, error: "Empty message." });
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
      callback?.({ success: true });
    });

    // =====================================================
    //  START GAME
    // =====================================================
    socket.on("startGame", (payload, callback) => {
      const roomId = socket.data.roomId;
      const room = getRoom(roomId);

      if (!room)
        return callback?.({ success: false, error: "Room not found." });
      const hostId = room.players[0]?.id;

      if (hostId !== socket.id)
        return callback?.({
          success: false,
          error: "Only the host can start the game.",
        });

      if (room.deck && room.deck.length > 0)
        return callback?.({
          success: false,
          error: "A game is already in progress.",
        });

      startGame(roomId, io);
      callback?.({ success: true });
    });

    // =====================================================
    //  PLAYER ACTION
    // =====================================================
    socket.on("playerAction", (payload, callback) => {
      const roomId = socket.data.roomId;
      const room = getRoom(roomId);

      if (!room || !payload?.action)
        return callback?.({
          success: false,
          error: "Invalid room or action payload.",
        });

      const currentPlayer = room.players[room.currentPlayerIndex];
      if (!currentPlayer || currentPlayer.id !== socket.id)
        return callback?.({ success: false, error: "It's not your turn." });

      playerAction(
        roomId,
        socket.id,
        payload.action,
        payload.amount || 0,
        io,
        callback
      );
    });

    // =====================================================
    //  DISCONNECT HANDLER
    // =====================================================
    socket.on("disconnect", () => {
      const roomId = socket.data.roomId;
      const userId = socket.data.userId;

      if (roomId) {
        const room = getRoom(roomId);
        if (room) {
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

        leaveRoom(roomId, userId, io);
      }

      console.log(`❌ Player disconnected: ${socket.user.username}`);
    });
  });
};
