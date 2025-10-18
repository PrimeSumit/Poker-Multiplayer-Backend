import { generateRoomId } from "../utils/generateRoomId.js";

let rooms = {}; // In-memory store for rooms

/**
 * Creates a new poker room with specified settings.
 */
export function createRoom({ region = "IN", maxPlayers = 5, password = "" }) {
  const roomId = generateRoomId(region);
  rooms[roomId] = {
    id: roomId,
    region,
    password,
    maxPlayers: Math.min(maxPlayers, 6),
    players: [],
    lastActive: Date.now(), // Game state is managed by gameLogic.js, but initial values are here
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
    throw new Error("Invalid password"); // Count active, non-disconnected players

  const activeCount = room.players.filter((p) => !p.isDisconnected).length;
  if (activeCount >= room.maxPlayers) {
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
export function leaveRoom(roomId, userId) {
  const room = rooms[roomId];
  if (!room) return null;

  // FIX: Look up by persistent userId
  const player = room.players.find((p) => p.userId === userId);
  if (!player) return null;

  console.log(`${player.username} has disconnected from room ${roomId}.`);
  // Mark as disconnected and fold.
  player.isDisconnected = true;
  player.hasFolded = true;

  const remainingPlayers = room.players.filter((p) => !p.isDisconnected);

  if (remainingPlayers.length === 0) {
    delete rooms[roomId];
    console.log(`Room ${roomId} deleted because it is empty.`);
    // Room is deleted, tell socket.js to not broadcast an update
    return { roomDeleted: true };
  } else {
    // Room is updated, tell socket.js to broadcast the new state
    room.lastActive = Date.now();
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
      // Return rooms that are not private (no password) and not full
      return !room.password && activeCount < room.maxPlayers;
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
  return null; // No active player found (e.g., everyone is all-in or folded)
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
      }
    }
  }, 60 * 1000); // Check every minute
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
    players: room.players.map((p) => ({
      id: p.id,
      userId: p.userId, // Include userId for debugging/advanced frontend
      username: p.username,
      avatar: p.avatar,
      chips: p.chips,
      isDisconnected: !!p.isDisconnected, // Ensure this is always a boolean
    })),
  };
}
