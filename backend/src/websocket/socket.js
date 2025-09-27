import {
  createRoom,
  joinRoom,
  leaveRoom,
  getRoom,
  startRoomExpiryWatcher,
  getActivePlayers,
  getSpectators,
  initGame,
} from "./roomManager.js";
import { startGame, playerAction } from "../game/gameLogic.js";

// --- FIX: Added a simple avatar function since it was missing ---
function getRandomAvatar() {
  const avatars = ["avatar1.png", "avatar2.png", "avatar3.png"];
  return avatars[Math.floor(Math.random() * avatars.length)];
}

// Start room expiry watcher (30 minutes)
startRoomExpiryWatcher(30 * 60 * 1000);

export const initSockets = (io) => {
  io.on("connection", (socket) => {
    console.log("Player connected:", socket.id);

    // Create Room
    socket.on("createRoom", (data, callback) => {
      try {
        const room = createRoom({
          region: data.region || "IN",
          maxPlayers: data.maxPlayers || 5, // Capped at 5 in roomManager
          password: data.password || "",
        });

        const player = {
          id: socket.id,
          username: data.username || "Host",
          avatar: data.avatar || getRandomAvatar(),
          chips: 1000,
          // Game-specific properties will be added when a game starts
        };

        room.players.push(player);
        socket.join(room.id);
        socket.data.roomId = room.id;

        initGame(room); // Initialize the game sub-object

        if (callback) callback({ success: true, roomId: room.id });
        io.to(room.id).emit("roomUpdate", roomSummary(room));
      } catch (err) {
        console.error("CreateRoom Error:", err);
        if (callback) callback({ success: false, error: err.message });
      }
    });

    // Join Room
    socket.on("joinRoom", (data, callback) => {
      try {
        const room = joinRoom(data.roomId, data.password || "");

        // Prevent duplicate players if a user reconnects
        if (room.players.some((p) => p.id === socket.id)) {
          socket.join(room.id);
          socket.data.roomId = room.id;
          if (callback) callback({ success: true, room: roomSummary(room) });
          return;
        }

        const player = {
          id: socket.id,
          username: data.username || `Player-${socket.id.slice(0, 5)}`,
          avatar: data.avatar || getRandomAvatar(),
          chips: 1000,
        };

        room.players.push(player);
        socket.join(room.id);
        socket.data.roomId = room.id;

        if (callback) callback({ success: true, room: roomSummary(room) });
        io.to(room.id).emit("roomUpdate", roomSummary(room));
      } catch (err) {
        console.error("JoinRoom Error:", err);
        if (callback) callback({ success: false, error: err.message });
      }
    });

    // Start Game
    socket.on("startGame", (payload, callback) => {
      const roomId = (payload && payload.roomId) || socket.data.roomId;
      if (!roomId) {
        if (callback) callback({ success: false, error: "No room" });
        return;
      }
      startGame(roomId, io);
      if (callback) callback({ success: true });
    });

    // Player Action
    socket.on("playerAction", (payload, callback) => {
      const roomId = (payload && payload.roomId) || socket.data.roomId;
      if (!roomId || !payload?.action) return;

      playerAction(roomId, socket.id, payload.action, payload.amount || 0, io);
      if (callback) callback({ success: true });
    });

    // Disconnect
    socket.on("disconnect", () => {
      const roomId = socket.data.roomId;
      if (roomId) {
        leaveRoom(roomId, socket.id, io); // Pass io to broadcast updates
        const room = getRoom(roomId);
        // The leaveRoom function will now handle the broadcast
      }
      console.log("Player disconnected:", socket.id);
    });
  });
};

function roomSummary(room) {
  if (!room) return {};
  return {
    id: room.id,
    region: room.region,
    maxPlayers: room.maxPlayers,
    players: room.players.map((p) => ({
      // Send all players, not just active/spectators
      id: p.id,
      username: p.username,
      avatar: p.avatar,
      chips: p.chips,
    })),
  };
}
