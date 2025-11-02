import { generateRoomId } from "../utils/generateRoomId.js";

let rooms = {}; // In-memory store for rooms

/**
 * Creates a new poker room with specified settings.
 */
export function createRoom({ region = "IN", maxPlayers = 6, password = "" }) {
  const roomId = generateRoomId(region);
  rooms[roomId] = {
    id: roomId,
    region,
    password,
    maxPlayers: Math.min(maxPlayers, 6),
    players: [],
    lastActive: Date.now(),
    dealerIndex: -1,
    currentPlayerIndex: null,
    deck: null,
    pots: [],
    communityCards: [],
  };
  console.log(`Room created: ${roomId}`);
  return rooms[roomId];
}

/**
 * Allows a player to join an existing room.
 */
export function joinRoom(roomId, password) {
  const room = rooms[roomId];
  if (!room) throw new Error("Room does not exist");
  if (room.password && room.password !== password)
    throw new Error("Invalid password");

  // Check if player is already in room (but disconnected)
  // This logic is handled in socket.js, but we check for max players here.
  // ... existing code ...
  const activeCount = room.players.filter((p) => !p.isDisconnected).length;
  if (activeCount >= room.maxPlayers) {
    // Check if the user trying to join is one of the disconnected players
    // Note: This logic is primarily in socket.js's joinRoom.
    // We'll assume socket.js handles the re-connect logic vs. new player logic.
    // This is just a safeguard.
    throw new Error(`Room is full (max ${room.maxPlayers} players).`);
  }

  room.lastActive = Date.now();
  return room;
}

/**
 * Handles a player leaving a room or disconnecting.
 * This function is DECOUPLED from Socket.IO and returns the status of the room.
 * @param {string} roomId The ID of the room.
 * @param {string} userId The persistent ID of the user.
 * @returns {{roomDeleted: boolean} | {roomUpdated: boolean, room: object} | null}
 */
export function leaveRoom(roomId, userId, io) {
  // Added io
  const room = rooms[roomId];
  if (!room) return null;

  const player = room.players.find((p) => p.userId === userId);
  if (!player) return null;

  console.log(`${player.username} has disconnected from room ${roomId}.`);
  player.isDisconnected = true;
  player.hasFolded = true; // Ensure they are folded if they were in a hand

  const remainingPlayers = room.players.filter((p) => !p.isDisconnected);

  if (remainingPlayers.length === 0) {
    delete rooms[roomId];
    console.log(`Room ${roomId} deleted because it is empty.`);
    io.emit("lobbyUpdate", getPublicRooms()); // Broadcast update
    return { roomDeleted: true };
  } else {
    room.lastActive = Date.now();

    // --- FIX: Create the correct payload for the game room ---
    // This payload includes the full player list, which the
    // "Waiting" screen needs to re-render.
    const gameRoomPayload = {
      id: room.id,
      players: room.players.map((p) => ({
        id: p.id,
        userId: p.userId,
        username: p.username,
        avatar: p.avatar,
        chips: p.chips,
        isDisconnected: p.isDisconnected,
      })),
      hostId: room.players[0]?.userId || null,
    }; // Broadcast updates
    // --- END FIX ---

    // --- FIX: Send the correct payload to the correct rooms ---
    io.to(room.id).emit("roomUpdate", gameRoomPayload); // Send full details to the game room
    io.emit("lobbyUpdate", getPublicRooms()); // Send lobby summary to the lobby
    // --- END FIX ---
    return { roomUpdated: true, room: roomSummary(room) };
  }
}

/**
 * Retrieves a room by its ID.
 */
export function getRoom(roomId) {
  return rooms[roomId];
}

/**
 * Retrieves a list of public, joinable rooms.
 */
export function getPublicRooms() {
  return Object.values(rooms)
    .filter((room) => {
      const activeCount = room.players.filter((p) => !p.isDisconnected).length;
      return activeCount < room.maxPlayers;
    })
    .map((room) => roomSummary(room));
}

/**
 * Finds the index of the next player who can act, starting from a given index.
 */
export function findNextActiveIndexFrom(room, start) {
  if (!room.players || room.players.length === 0) return null;
  const total = room.players.length;
  for (let i = 0; i < total; i++) {
    const idx = (start + i) % total;
    const p = room.players[idx];
    if (
      p &&
      !p.hasFolded &&
      !p.isAllIn &&
      !p.isSpectator &&
      !p.isDisconnected &&
      p.chips > 0
    )
      return idx;
  }
  return null;
}

/**
 * Periodically cleans up inactive rooms.
 * NOTE: This function needs the 'io' instance to broadcast updates.
 * Make sure to pass 'io' from server.js when you call this.
 */
export function startRoomExpiryWatcher(io, timeoutMs = 30 * 60 * 1000) {
  setInterval(() => {
    const now = Date.now();
    let lobbyUpdated = false;
    for (const [id, room] of Object.entries(rooms)) {
      if (now - room.lastActive > timeoutMs) {
        console.log(`Room ${id} expired and removed due to inactivity`);
        delete rooms[id];
        lobbyUpdated = true;
      }
    }
    if (lobbyUpdated) {
      io.emit("lobbyUpdate", getPublicRooms()); // Broadcast update
    }
  }, 60 * 1000); // Check every minute
}

/**
 * Returns a summary of a room, safe to send to clients (for the lobby).
 */
export function roomSummary(room) {
  if (!room) return {}; // The host is always the first player in the players array (index 0)

  const host = room.players[0];
  const hostName = host ? host.username : "Unknown"; // Fallback

  return {
    id: room.id,
    region: room.region,
    maxPlayers: room.maxPlayers,
    hasPassword: !!room.password,
    host: hostName, // Return player count for the lobby summary

    players: room.players.filter((p) => !p.isDisconnected).length,
    s, // Note: Full player list is sent separately for the game room // in socket.js and leaveRoom()
  };
}
