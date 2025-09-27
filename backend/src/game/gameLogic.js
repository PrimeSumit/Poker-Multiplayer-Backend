// src/game/gameLogic.js
// import {
//   createDeck,
//   shuffle,
//   dealHoleCards,
//   dealCommunityCards,
//   determineWinners,
// } from "./gameUtils.js";
// import { getRoom } from "../websocket/roomManager.js";

// const SMALL_BLIND = 1;
// const BIG_BLIND = 2;
// const MAX_RAISE = 150;
// const AUTO_NEXT_HAND_DELAY = 5000; // 5s before next hand
// const TURN_TIMEOUT = 20000; // 20 sec per turn

// // Track timers per room
// const turnTimers = {};

// // --- Start a new hand ---
// export function startGame(roomId, io) {
//   const room = getRoom(roomId);
//   if (!room || !room.players || room.players.length < 2) return;

//   // Reset players
//   room.players.forEach((p) => {
//     if (typeof p.chips !== "number") p.chips = 1000;
//     p.cards = [];
//     p.currentBet = 0;
//     p.hasFolded = false;
//     p.isAllIn = false;
//     p.isSpectator = p.chips <= 0;
//   });

//   const activePlayers = room.players.filter(
//     (p) => !p.isSpectator && p.chips > 0
//   );
//   if (activePlayers.length < 2) {
//     io.to(room.id).emit("handCancelled", {
//       reason: "Not enough active players",
//     });
//     return;
//   }

//   // Rotate dealer
//   if (typeof room.dealerIndex !== "number") room.dealerIndex = -1;
//   room.dealerIndex = (room.dealerIndex + 1) % room.players.length;

//   const smallBlindIndex = findNextActiveIndexFrom(room, room.dealerIndex + 1);
//   const bigBlindIndex = findNextActiveIndexFrom(room, smallBlindIndex + 1);

//   room.deck = shuffle(createDeck());
//   room.communityCards = [];
//   room.pot = 0;
//   room.currentRound = "pre-flop";
//   room.minBet = BIG_BLIND;
//   room.lastAggressorIndex = null;
//   room.currentPlayerIndex = findNextActiveIndexFrom(room, bigBlindIndex + 1);
//   room.handEnded = false; // reset hand status

//   // Post blinds
//   postBlind(room.players[smallBlindIndex], SMALL_BLIND, room);
//   postBlind(room.players[bigBlindIndex], BIG_BLIND, room);

//   // Deal hole cards
//   dealHoleCards(activePlayers, room.deck);

//   // Emit game start
//   io.to(room.id).emit("gameStart", {
//     players: room.players.map((p, i) => ({
//       id: p.id,
//       username: p.username,
//       chips: p.chips,
//       isDealer: i === room.dealerIndex,
//       isSmallBlind: i === smallBlindIndex,
//       isBigBlind: i === bigBlindIndex,
//       isSpectator: p.isSpectator,
//     })),
//     pot: room.pot,
//     round: room.currentRound,
//   });

//   // Send private cards
//   activePlayers.forEach((p) =>
//     io.to(p.id).emit("yourCards", { cards: p.cards })
//   );

//   // Start first turn
//   emitTurn(io, room);
// }

// // --- Player Action ---
// export function playerAction(roomId, playerId, action, amount = 0, io) {
//   const room = getRoom(roomId);
//   if (!room) return;

//   const playerIdx = room.players.findIndex((p) => p.id === playerId);
//   if (playerIdx === -1) return;
//   const player = room.players[playerIdx];

//   if (player.hasFolded || player.isAllIn || player.isSpectator) return;
//   if (playerIdx !== room.currentPlayerIndex) {
//     io.to(playerId).emit("actionRejected", { reason: "Not your turn" });
//     return;
//   }

//   clearTimeout(turnTimers[room.id]);

//   switch (action) {
//     case "fold":
//       player.hasFolded = true;
//       break;
//     case "check":
//       if ((player.currentBet || 0) !== (room.minBet || 0)) {
//         io.to(playerId).emit("actionRejected", {
//           reason: "Cannot check when behind",
//         });
//         return;
//       }
//       break;
//     case "call": {
//       const toCall = Math.min(
//         (room.minBet || 0) - (player.currentBet || 0),
//         player.chips
//       );
//       player.chips -= toCall;
//       player.currentBet += toCall;
//       room.pot += toCall;
//       if (player.chips <= 0) player.isAllIn = true;
//       break;
//     }
//     case "raise": {
//       if (amount <= 0) {
//         io.to(playerId).emit("actionRejected", { reason: "Invalid raise" });
//         return;
//       }
//       if (amount > MAX_RAISE) amount = MAX_RAISE;
//       const totalToPay = (room.minBet || 0) - (player.currentBet || 0) + amount;
//       if (totalToPay > player.chips) {
//         io.to(playerId).emit("actionRejected", { reason: "Not enough chips" });
//         return;
//       }
//       player.chips -= totalToPay;
//       player.currentBet += totalToPay;
//       room.pot += totalToPay;
//       room.minBet = player.currentBet;
//       room.lastAggressorIndex = playerIdx;
//       if (player.chips <= 0) player.isAllIn = true;
//       break;
//     }
//     case "all-in": {
//       const allInAmt = player.chips;
//       player.chips = 0;
//       player.currentBet += allInAmt;
//       room.pot += allInAmt;
//       player.isAllIn = true;
//       if (player.currentBet > (room.minBet || 0)) {
//         room.minBet = player.currentBet;
//         room.lastAggressorIndex = playerIdx;
//       }
//       break;
//     }
//     default:
//       io.to(playerId).emit("actionRejected", { reason: "Unknown action" });
//       return;
//   }

//   io.to(roomId).emit("gameUpdate", serializeRoom(room));

//   if (isBettingRoundComplete(room)) nextRound(io, room);
//   else advanceTurn(io, room);
// }

// // --- Auto next hand ---
// export function autoNextHand(roomId, io) {
//   const room = getRoom(roomId);
//   if (!room) return;
//   setTimeout(() => startGame(roomId, io), AUTO_NEXT_HAND_DELAY);
// }

// // --- Helpers ---
// function emitTurn(io, room) {
//   const player = room.players[room.currentPlayerIndex];
//   if (!player || player.hasFolded || player.isAllIn || player.isSpectator) {
//     advanceTurn(io, room);
//     return;
//   }

//   io.to(room.id).emit("turnUpdate", {
//     playerId: player.id,
//     username: player.username,
//     isSpectator: player.isSpectator,
//     timeLeft: TURN_TIMEOUT / 1000,
//   });

//   // Turn timer
//   turnTimers[room.id] = setTimeout(() => {
//     player.hasFolded = true;
//     io.to(room.id).emit("playerAutoFolded", { playerId: player.id });
//     if (isBettingRoundComplete(room)) nextRound(io, room);
//     else advanceTurn(io, room);
//   }, TURN_TIMEOUT);
// }

// function advanceTurn(io, room) {
//   room.currentPlayerIndex = findNextActiveIndexFrom(
//     room,
//     room.currentPlayerIndex + 1
//   );
//   emitTurn(io, room);
// }

// function isBettingRoundComplete(room) {
//   const active = room.players.filter(
//     (p) => !p.hasFolded && !p.isAllIn && !p.isSpectator && p.chips > 0
//   );
//   if (active.length <= 1) return true;
//   return active.every((p) => (p.currentBet || 0) === (room.minBet || 0));
// }

// function nextRound(io, room) {
//   clearTimeout(turnTimers[room.id]);
//   const remaining = room.players.filter(
//     (p) => !p.hasFolded && !p.isSpectator && p.chips > 0
//   );

//   if (remaining.length <= 1) {
//     if (remaining[0]) remaining[0].chips += room.pot;
//     room.handEnded = true;
//     io.to(room.id).emit("showdown", {
//       winners: remaining,
//       pot: room.pot,
//       communityCards: room.communityCards,
//     });
//     autoNextHand(room.id, io);
//     return;
//   }

//   switch (room.currentRound) {
//     case "pre-flop":
//       room.currentRound = "flop";
//       room.communityCards.push(...dealCommunityCards(room.deck, "flop"));
//       break;
//     case "flop":
//       room.currentRound = "turn";
//       room.communityCards.push(...dealCommunityCards(room.deck, "turn"));
//       break;
//     case "turn":
//       room.currentRound = "river";
//       room.communityCards.push(...dealCommunityCards(room.deck, "river"));
//       break;
//     case "river":
//       showdown(io, room);
//       return;
//   }

//   room.players.forEach((p) => (p.currentBet = 0));
//   room.minBet = 0;
//   room.currentPlayerIndex = findNextActiveIndexFrom(room, room.dealerIndex + 1);

//   io.to(room.id).emit("gameUpdate", serializeRoom(room));
//   emitTurn(io, room);
// }

// function showdown(io, room) {
//   const activePlayers = room.players.filter(
//     (p) => !p.hasFolded && !p.isSpectator
//   );
//   const winners = determineWinners(activePlayers, room.communityCards);
//   if (winners.length > 0) {
//     const split = Math.floor(room.pot / winners.length);
//     winners.forEach((w) => {
//       const p = room.players.find((pl) => pl.id === w.id);
//       if (p) p.chips += split;
//     });
//   }

//   room.handEnded = true;
//   io.to(room.id).emit("showdown", {
//     winners,
//     pot: room.pot,
//     communityCards: room.communityCards,
//   });
//   autoNextHand(room.id, io);
// }

// function findNextActiveIndexFrom(room, start) {
//   const total = room.players.length;
//   for (let i = 0; i < total; i++) {
//     const idx = (start + i) % total;
//     const p = room.players[idx];
//     if (p && !p.hasFolded && !p.isAllIn && !p.isSpectator && p.chips > 0)
//       return idx;
//   }
//   return start % total;
// }

// function postBlind(player, amount, room) {
//   if (!player || player.isSpectator) return;
//   const pay = Math.min(player.chips, amount);
//   player.chips -= pay;
//   player.currentBet += pay;
//   room.pot += pay;
//   if (player.chips <= 0) player.isAllIn = true;
// }

// function serializeRoom(room) {
//   return {
//     players: room.players.map((p) => ({
//       id: p.id,
//       username: p.username,
//       chips: p.chips,
//       currentBet: p.currentBet,
//       hasFolded: p.hasFolded,
//       isAllIn: p.isAllIn,
//       isSpectator: p.isSpectator,
//     })),
//     pot: room.pot,
//     round: room.currentRound,
//     communityCards: room.communityCards,
//   };
// }
// ✅ FINAL CORRECTED CODE: src/game/gameLogic.js

import {
  createDeck,
  shuffle,
  dealHoleCards,
  dealCommunityCards,
  determineWinners,
} from "./gameUtils.js";
import { getRoom, findNextActiveIndexFrom } from "../websocket/roomManager.js";

const AUTO_NEXT_HAND_DELAY = 7000;
const TURN_TIMEOUT = 20000;
const turnTimers = {};

/** Start a new hand */
export function startGame(roomId, io) {
  const room = getRoom(roomId);
  if (!room || !room.players) return;

  // Remove disconnected players between hands
  room.players = room.players.filter((p) => !p.isDisconnected);
  if (room.players.length < 2) {
    io.to(room.id).emit("handCancelled", { reason: "Not enough players." });
    return;
  }

  // Reset players for the new hand
  room.players.forEach((p) => {
    p.cards = [];
    p.currentBet = 0;
    p.hasFolded = false;
    p.isAllIn = false;
    p.isSpectator = p.chips <= 0;
  });

  const activePlayers = room.players.filter((p) => !p.isSpectator);
  if (activePlayers.length < 2) {
    io.to(room.id).emit("handCancelled", {
      reason: "Not enough active players.",
    });
    return;
  }

  room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
  const smallBlindIndex = findNextActiveIndexFrom(room, room.dealerIndex + 1);
  const bigBlindIndex = findNextActiveIndexFrom(room, smallBlindIndex + 1);

  room.deck = shuffle(createDeck());
  room.communityCards = [];
  room.pots = []; // Will be created by reconcilePots
  room.currentRound = "pre-flop";
  room.minBet = 2;
  room.currentPlayerIndex = findNextActiveIndexFrom(room, bigBlindIndex + 1);
  room.handEnded = false;

  // Post blinds
  postBlind(room.players[smallBlindIndex], 1, room);
  postBlind(room.players[bigBlindIndex], 2, room);

  dealHoleCards(activePlayers, room.deck);

  io.to(room.id).emit("gameStart", {
    players: room.players.map((p, i) => ({
      id: p.id,
      username: p.username,
      chips: p.chips,
      currentBet: p.currentBet,
      isDealer: i === room.dealerIndex,
      isSmallBlind: i === smallBlindIndex,
      isBigBlind: i === bigBlindIndex,
    })),
    round: room.currentRound,
  });

  activePlayers.forEach((p) =>
    io.to(p.id).emit("yourCards", { cards: p.cards })
  );
  emitTurn(io, room);
}

/** Player action */
export function playerAction(roomId, playerId, action, amount = 0, io) {
  const room = getRoom(roomId);
  if (!room || room.handEnded) return;

  const playerIdx = room.players.findIndex((p) => p.id === playerId);
  if (playerIdx === -1 || playerIdx !== room.currentPlayerIndex) return;

  const player = room.players[playerIdx];
  if (player.hasFolded || player.isAllIn || player.isSpectator) return;

  clearTimeout(turnTimers[room.id]);

  switch (action) {
    case "fold":
      player.hasFolded = true;
      break;
    case "check":
      if (player.currentBet < room.minBet) return;
      break;
    case "call": {
      const toCall = Math.min(room.minBet - player.currentBet, player.chips);
      player.chips -= toCall;
      player.currentBet += toCall;
      if (player.chips <= 0) player.isAllIn = true;
      break;
    }
    case "raise": {
      // FIX: Correct raise logic
      const raiseAmount = amount - player.currentBet;
      if (
        amount <= room.minBet ||
        raiseAmount <= 0 ||
        raiseAmount > player.chips
      ) {
        return; // Invalid raise
      }
      player.chips -= raiseAmount;
      player.currentBet = amount;
      room.minBet = player.currentBet;
      if (player.chips <= 0) player.isAllIn = true;
      break;
    }
  }

  io.to(roomId).emit("playerActed", {
    playerId,
    action,
    currentBet: player.currentBet,
    chips: player.chips,
  });

  if (isBettingRoundComplete(room)) {
    nextRound(io, room);
  } else {
    advanceTurn(io, room);
  }
}

/** Reconcile pots - CORRECTED LOGIC */
function reconcilePots(room) {
  const playersInHand = room.players.filter((p) => p.currentBet > 0);
  if (playersInHand.length === 0) return;

  // Combine all current bets into the existing pots
  while (true) {
    const activeBets = playersInHand.filter(
      (p) => p.currentBet > 0 && !p.hasFolded
    );
    if (activeBets.length === 0) break;

    const minBet = Math.min(...activeBets.map((p) => p.currentBet));
    const pot = { amount: 0, eligiblePlayers: activeBets.map((p) => p.id) };

    activeBets.forEach((player) => {
      const contribution = Math.min(player.currentBet, minBet);
      pot.amount += contribution;
      player.currentBet -= contribution;
      if (player.currentBet === 0 && player.isAllIn) {
        // Player is all-in, remove them from being eligible for future side pots
        pot.eligiblePlayers = pot.eligiblePlayers.filter(
          (id) => id !== player.id
        );
      }
    });

    // Find if a similar pot exists to merge with
    const existingPot = room.pots.find(
      (p) =>
        JSON.stringify(p.eligiblePlayers.sort()) ===
        JSON.stringify(pot.eligiblePlayers.sort())
    );
    if (existingPot) {
      existingPot.amount += pot.amount;
    } else {
      room.pots.push(pot);
    }
  }
}

/** Check if betting round complete */
function isBettingRoundComplete(room) {
  const activePlayers = room.players.filter(
    (p) => !p.hasFolded && !p.isAllIn && p.chips > 0
  );
  if (activePlayers.length <= 1) return true;

  // All active players must have bet the same amount
  const firstBet = activePlayers[0].currentBet;
  return activePlayers.every((p) => p.currentBet === firstBet);
}

/** Next round / showdown */
function nextRound(io, room) {
  reconcilePots(room);
  room.players.forEach((p) => (p.currentBet = 0));
  room.minBet = 0;

  const remaining = room.players.filter((p) => !p.hasFolded);
  if (remaining.length <= 1) {
    const winner = remaining[0];
    if (winner) {
      const totalWinnings = room.pots.reduce((sum, pot) => sum + pot.amount, 0);
      winner.chips += totalWinnings;
      io.to(room.id).emit("showdown", {
        results: [
          {
            username: winner.username,
            amount: totalWinnings,
            hand: "Win by fold",
          },
        ],
      });
    }
    autoNextHand(room.id, io);
    return;
  }

  if (room.currentRound === "river") {
    showdown(io, room);
    return;
  }

  switch (room.currentRound) {
    case "pre-flop":
      room.currentRound = "flop";
      dealCommunityCards(room.deck, "flop", room);
      break;
    case "flop":
      room.currentRound = "turn";
      dealCommunityCards(room.deck, "turn", room);
      break;
    case "turn":
      room.currentRound = "river";
      dealCommunityCards(room.deck, "river", room);
      break;
  }

  room.currentPlayerIndex = findNextActiveIndexFrom(room, room.dealerIndex + 1);

  io.to(room.id).emit("nextRound", {
    round: room.currentRound,
    communityCards: room.communityCards,
    totalPot: room.pots.reduce((sum, pot) => sum + pot.amount, 0),
  });
  emitTurn(io, room);
}

/** Showdown */
function showdown(io, room) {
  room.handEnded = true;
  reconcilePots(room);

  const showdownPlayers = room.players.filter((p) => !p.hasFolded);
  const potResults = [];

  for (const pot of room.pots) {
    const eligiblePlayers = showdownPlayers.filter((p) =>
      pot.eligiblePlayers.includes(p.id)
    );
    if (eligiblePlayers.length === 0) continue;

    const winners = determineWinners(eligiblePlayers, room.communityCards);
    if (winners.length === 0) continue;

    const splitAmount = Math.floor(pot.amount / winners.length);

    winners.forEach((winnerInfo) => {
      const player = room.players.find((p) => p.id === winnerInfo.id);
      if (player) {
        player.chips += splitAmount;
        potResults.push({
          username: player.username,
          amount: splitAmount,
          hand: winnerInfo.handDescr,
        });
      }
    });
  }

  io.to(room.id).emit("showdown", {
    results: potResults,
    players: showdownPlayers.map((p) => ({
      username: p.username,
      cards: p.cards,
      chips: p.chips,
    })),
    communityCards: room.communityCards,
  });

  autoNextHand(room.id, io);
}

/** Helpers */
function postBlind(player, amount, room) {
  if (!player || player.isSpectator) return;
  const pay = Math.min(player.chips, amount);
  player.chips -= pay;
  player.currentBet += pay;
  if (player.chips <= 0) player.isAllIn = true;
}

function advanceTurn(io, room) {
  room.currentPlayerIndex = findNextActiveIndexFrom(
    room,
    room.currentPlayerIndex + 1
  );
  emitTurn(io, room);
}

function emitTurn(io, room) {
  if (room.handEnded) return;
  const player = room.players[room.currentPlayerIndex];
  if (!player) {
    return nextRound(io, room);
  }

  io.to(room.id).emit("turnUpdate", {
    playerId: player.id,
    username: player.username,
  });

  // FIX: Restore the turn timer
  turnTimers[room.id] = setTimeout(() => {
    // To prevent race conditions, double-check if it's still this player's turn
    if (room.players[room.currentPlayerIndex]?.id === player.id) {
      console.log(`Player ${player.username} timed out. Folding.`);
      playerAction(room.id, player.id, "fold", 0, io);
    }
  }, TURN_TIMEOUT);
}

function autoNextHand(roomId, io) {
  setTimeout(() => startGame(roomId, io), AUTO_NEXT_HAND_DELAY);
}
