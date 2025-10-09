import { generateRoomId } from "../utils/generateRoomId.js";

let rooms = {}; // In-memory store for rooms

/**
 * Creates a new poker room with specified settings.
 * @param {object} options - The options for creating the room.
 * @param {string} options.region - The server region.
 * @param {number} options.maxPlayers - The maximum number of players.
 * @param {string} options.password - An optional password for the room.
 * @returns {object} The newly created room object.
 */
export function createRoom({ region = "IN", maxPlayers = 5, password = "" }) {
  const roomId = generateRoomId(region);
  rooms[roomId] = {
    id: roomId,
    region,
    password,
    maxPlayers: Math.min(maxPlayers, 5), // Capped at 5 players
    players: [],
    game: null, // Game state object, initialized later
    lastActive: Date.now(),
    dealerIndex: -1,
    deck: null,
    pots: [],
    communityCards: [],
  };
  console.log(`Room created: ${roomId}`);
  return rooms[roomId];
}

/**
 * Allows a player to join an existing room.
 * @param {string} roomId - The ID of the room to join.
 * @param {string} password - The password for the room, if required.
 * @returns {object} The room object if join is successful.
 * @throws {Error} If the room doesn't exist, is full, or password is wrong.
 */
export function joinRoom(roomId, password) {
  const room = rooms[roomId];
  if (!room) throw new Error("Room does not exist");
  if (room.password && room.password !== password)
    throw new Error("Invalid password");

  const activeCount = room.players.filter((p) => !p.isSpectator).length;
  if (activeCount >= room.maxPlayers) {
    throw new Error(`Room is full (max ${room.maxPlayers} players).`);
  }

  room.lastActive = Date.now();
  return room;
}

/**
 * Handles a player leaving a room or disconnecting.
 * @param {string} roomId - The ID of the room.
 * @param {string} socketId - The socket ID of the player leaving.
 * @param {object} io - The Socket.IO server instance for broadcasting updates.
 */
export function leaveRoom(roomId, socketId, io) {
  const room = rooms[roomId];
  if (!room) return;

  const playerIndex = room.players.findIndex((p) => p.id === socketId);
  if (playerIndex === -1) return;

  const player = room.players[playerIndex];
  const isHandInProgress = !!room.deck;

  if (isHandInProgress) {
    console.log(`${player.username} disconnected mid-hand, marking as folded.`);
    player.hasFolded = true;
    player.isDisconnected = true;
  } else {
    console.log(`${player.username} left room ${roomId}.`);
    room.players.splice(playerIndex, 1);
  }

  // If room is empty, delete it. Otherwise, update clients.
  if (room.players.filter((p) => !p.isDisconnected).length === 0) {
    delete rooms[roomId];
    console.log(`Room ${roomId} deleted (empty).`);
  } else {
    io.to(roomId).emit("roomUpdate", roomSummary(room));
    room.lastActive = Date.now();
  }
}

/**
 * Retrieves a room by its ID.
 * @param {string} roomId - The ID of the room.
 * @returns {object|undefined} The room object or undefined if not found.
 */
export function getRoom(roomId) {
  return rooms[roomId];
}

/**
 * Get active players in a room.
 * @param {string} roomId - The ID of the room.
 * @returns {Array} An array of active player objects.
 */
export function getActivePlayers(roomId) {
  const room = rooms[roomId];
  if (!room) return [];
  return room.players.filter((p) => !p.isSpectator && p.chips > 0);
}

/**
 * Get spectators in a room.
 * @param {string} roomId - The ID of the room.
 * @returns {Array} An array of spectator objects.
 */
export function getSpectators(roomId) {
  const room = rooms[roomId];
  if (!room) return [];
  return room.players.filter((p) => p.isSpectator);
}

/**
 * Initialize the game state object for a room.
 * @param {object} room - The room object.
 */
export function initGame(room) {
  if (!room) return;
  room.game = {
    stage: "pre-flop",
    currentPlayerIdx: 0,
    lastAggressorIdx: null,
  };
}

/**
 * Periodically cleans up inactive rooms.
 * @param {number} timeoutMs - The inactivity timeout in milliseconds.
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
 * @param {object} room - The room object.
 * @returns {object} A summary of the room.
 */
export function roomSummary(room) {
  if (!room) return {};
  return {
    id: room.id,
    region: room.region,
    maxPlayers: room.maxPlayers,
    players: room.players.map((p) => ({
      id: p.id,
      username: p.username,
      avatar: p.avatar,
      chips: p.chips,
      isDisconnected: !!p.isDisconnected,
    })),
  };
}

/**
 * Finds the index of the next active player in a room, starting from a given index.
 * This is crucial for managing turn order.
 * @param {object} room - The room object.
 * @param {number} start - The index to start searching from.
 * @returns {number|null} The index of the next active player, or null if none found.
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
  return null; // No active player found
}
