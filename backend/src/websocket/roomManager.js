import { generateRoomId } from "../utils/generateRoomId.js";

let rooms = {}; // in-memory store

/** Create a room */
export function createRoom({ region = "IN", maxPlayers = 5, password = "" }) {
  const roomId = generateRoomId(region);
  rooms[roomId] = {
    id: roomId,
    region,
    password,
    maxPlayers: Math.min(maxPlayers, 5),
    players: [],
    game: null,
    lastActive: Date.now(),
    dealerIndex: -1,
    deck: null,
    pots: [],
    communityCards: [],
  };
  console.log(`Room created: ${roomId}`);
  return rooms[roomId];
}

/** Join a room */
export function joinRoom(roomId, password) {
  const room = rooms[roomId];
  if (!room) throw new Error("Room does not exist");
  if (room.password !== password) throw new Error("Invalid password");

  const activeCount = room.players.filter((p) => !p.isSpectator).length;
  if (activeCount >= room.maxPlayers) {
    throw new Error(`Room is full (max ${room.maxPlayers} players).`);
  }

  room.lastActive = Date.now();
  return room;
}

/** Leave a room */
export function leaveRoom(roomId, socketId, io) {
  const room = rooms[roomId];
  if (!room) return;

  const playerIndex = room.players.findIndex((p) => p.id === socketId);
  if (playerIndex === -1) return;

  const player = room.players[playerIndex];
  const isHandInProgress = !!room.deck;

  if (isHandInProgress) {
    console.log(`${player.username} disconnected mid-hand, folding.`);
    player.hasFolded = true;
    player.isDisconnected = true;
  } else {
    console.log(`${player.username} left room ${roomId}.`);
    room.players.splice(playerIndex, 1);
  }

  if (io) io.to(roomId).emit("roomUpdate", roomSummary(room));

  if (room.players.filter((p) => !p.isDisconnected).length === 0) {
    delete rooms[roomId];
    console.log(`Room ${roomId} deleted (empty).`);
  } else {
    room.lastActive = Date.now();
  }
}

/** Get room object */
export function getRoom(roomId) {
  return rooms[roomId];
}

/** Return all rooms */
export function getAllRooms() {
  return rooms;
}

/** Get active players */
export function getActivePlayers(roomId) {
  // <-- ADDED EXPORT
  const room = rooms[roomId];
  if (!room) return [];
  return room.players.filter((p) => !p.isSpectator && p.chips > 0);
}

/** Get spectators */
export function getSpectators(roomId) {
  // <-- ADDED EXPORT
  const room = rooms[roomId];
  if (!room) return [];
  return room.players.filter((p) => p.isSpectator);
}

/** Start periodic cleanup of inactive rooms */
export function startRoomExpiryWatcher(timeoutMs = 30 * 60 * 1000) {
  setInterval(() => {
    const now = Date.now();
    for (const [id, room] of Object.entries(rooms)) {
      if (now - room.lastActive > timeoutMs) {
        console.log(`Room ${id} expired and removed`);
        delete rooms[id];
      }
    }
  }, 60 * 1000);
}

/** Initialize game object */
export function initGame(room) {
  // <-- ADDED EXPORT
  room.game = {
    stage: "pre-flop",
    currentPlayerIdx: 0,
    lastAggressorIdx: null,
  };
}

/** Helper for broadcasting updates */
export function roomSummary(room) {
  // <-- ADDED EXPORT
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
      isDisconnected: p.isDisconnected,
    })),
  };
}

/** Find next active player */
export function findNextActiveIndexFrom(room, start) {
  // <-- ADDED MISSING FUNCTION
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
  return null; // Return null if no active player found
}
