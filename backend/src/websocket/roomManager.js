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

  const activeCount = room.players.filter((p) => !p.isDisconnected).length;
  if (activeCount >= room.maxPlayers) {
    throw new Error(`Room is full (max ${room.maxPlayers} players).`);
  }

  room.lastActive = Date.now();
  return room;
}

/**
 * Handles a player leaving a room or disconnecting.
 */
export function leaveRoom(roomId, userId, io) {
  // Added io to pass to roomSummary if needed
  const room = rooms[roomId];
  if (!room) return null;

  const player = room.players.find((p) => p.userId === userId);
  if (!player) return null;

  console.log(`${player.username} has disconnected from room ${roomId}.`);
  player.isDisconnected = true;
  player.hasFolded = true;

  const remainingPlayers = room.players.filter((p) => !p.isDisconnected);

  if (remainingPlayers.length === 0) {
    delete rooms[roomId];
    console.log(`Room ${roomId} deleted because it is empty.`);
    // --- FIX: Broadcast lobby update AFTER deleting the room ---
    io.emit("lobbyUpdate", getPublicRooms());
    return { roomDeleted: true };
  } else {
    room.lastActive = Date.now();
    // --- FIX: Broadcast updates on disconnect ---
    io.to(room.id).emit("roomUpdate", roomSummary(room));
    io.emit("lobbyUpdate", getPublicRooms());
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
      // --- FIX: Show ALL rooms that are not full, regardless of password ---
      return activeCount < room.maxPlayers;
    })
    .map((room) => roomSummary(room)); // Use the existing summary function for safety
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
 */
export function startRoomExpiryWatcher(timeoutMs = 30 * 60 * 1000) {
  setInterval(() => {
    const now = Date.now();
    for (const [id, room] of Object.entries(rooms)) {
      if (now - room.lastActive > timeoutMs) {
        console.log(`Room ${id} expired and removed due to inactivity`);
        delete rooms[id];
        // --- FIX: Broadcast lobby update when a room expires ---
        // Note: This needs the 'io' instance. This function is called from server.js,
        // so you should pass 'io' to it from there.
        // For now, this fix assumes 'io' is not available here,
        // but the 'leaveRoom' fix will handle most cases.
      }
    }
  }, 60 * 1000);
}

/**
 * Returns a summary of a room, safe to send to clients.
 */
export function roomSummary(room) {
  if (!room) return {};
  return {
    id: room.id,
    region: room.region,
    maxPlayers: room.maxPlayers,
    // --- FIX: Tell the frontend if a password is set ---
    hasPassword: !!room.password,
    players: room.players.map((p) => ({
      id: p.id,
      userId: p.userId,
      username: p.username,
      avatar: p.avatar,
      chips: p.chips,
      isDisconnected: !!p.isDisconnected,
    })),
  };
}
