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

/**
 * Starts a new hand in the specified room.
 * @param {string} roomId - The ID of the room.
 * @param {object} io - The Socket.IO server instance.
 */
export function startGame(roomId, io) {
  const room = getRoom(roomId);
  if (!room || !room.players) return;

  // Clean up disconnected players between hands
  room.players = room.players.filter((p) => !p.isDisconnected);
  if (room.players.length < 2) {
    io.to(room.id).emit("handCancelled", { reason: "Not enough players." });
    return;
  }

  // Reset player states for the new hand
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
      reason: "Not enough players with chips.",
    });
    return;
  }

  // --- Hand Setup ---
  room.dealerIndex = findNextActiveIndexFrom(room, room.dealerIndex + 1);
  const smallBlindIndex = findNextActiveIndexFrom(room, room.dealerIndex + 1);
  const bigBlindIndex = findNextActiveIndexFrom(room, smallBlindIndex + 1);

  room.deck = shuffle(createDeck());
  room.communityCards = [];
  room.pots = [{ amount: 0, eligiblePlayers: [] }];
  room.currentRound = "pre-flop";
  room.minBet = 2; // Big blind amount
  room.lastRaise = 2; // Minimum raise amount is the big blind
  room.currentPlayerIndex = findNextActiveIndexFrom(room, bigBlindIndex + 1);
  room.handEnded = false;

  // Post blinds
  postBlind(room.players[smallBlindIndex], 1, room);
  postBlind(room.players[bigBlindIndex], 2, room);

  // The player to the left of the big blind is the first to act.
  room.actionOnPlayerIndex = bigBlindIndex;

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

  // Send cards to each player individually
  activePlayers.forEach((p) =>
    io.to(p.id).emit("yourCards", { cards: p.cards })
  );

  emitTurn(io, room);
}

/**
 * Processes an action from a player (fold, check, call, raise).
 * @param {string} roomId - The ID of the room.
 * @param {string} playerId - The ID of the player acting.
 * @param {string} action - The action taken ('fold', 'check', 'call', 'raise').
 * @param {number} amount - The amount for a raise.
 * @param {object} io - The Socket.IO server instance.
 */
export function playerAction(roomId, playerId, action, amount = 0, io) {
  const room = getRoom(roomId);
  if (!room || room.handEnded) return;

  const playerIdx = room.players.findIndex((p) => p.id === playerId);
  if (playerIdx === -1 || playerIdx !== room.currentPlayerIndex) return;

  const player = room.players[playerIdx];
  if (player.hasFolded || player.isAllIn || player.isSpectator) return;

  clearTimeout(turnTimers[room.id]);

  const amountToCall = room.minBet - player.currentBet;

  switch (action) {
    case "fold":
      player.hasFolded = true;
      break;

    case "check":
      // A player can only check if they have met the current minimum bet.
      if (amountToCall > 0) return;
      break;

    case "call": {
      const callAmount = Math.min(amountToCall, player.chips);
      player.chips -= callAmount;
      player.currentBet += callAmount;
      if (player.chips <= 0) player.isAllIn = true;
      break;
    }

    case "raise": {
      const totalBet = amount;
      const raiseAmount = totalBet - player.currentBet;

      // --- FIX: Correct raise logic validation ---
      if (
        totalBet < room.minBet + room.lastRaise || // Must raise at least by the last raise amount
        raiseAmount > player.chips // Cannot raise more than you have
      ) {
        return; // Invalid raise
      }

      player.chips -= raiseAmount;
      player.currentBet = totalBet;

      room.lastRaise = totalBet - room.minBet; // Update the last raise amount
      room.minBet = totalBet; // The new minimum bet is the total raise amount
      room.actionOnPlayerIndex = playerIdx; // The round ends when action gets back to this player

      if (player.chips <= 0) player.isAllIn = true;
      break;
    }
  }

  io.to(roomId).emit("playerActed", {
    playerId,
    action,
    currentBet: player.currentBet,
    chips: player.chips,
    isAllIn: player.isAllIn,
    hasFolded: player.hasFolded,
  });

  if (isBettingRoundComplete(room)) {
    nextRound(io, room);
  } else {
    advanceTurn(io, room);
  }
}

/**
 * Reconciles all bets into main and side pots.
 * @param {object} room - The room object.
 */
function reconcilePots(room) {
  // A simplified pot reconciliation for now.
  // A full implementation would handle complex side pots.
  let totalPot = room.pots.reduce((sum, pot) => sum + pot.amount, 0);
  room.players.forEach((p) => {
    totalPot += p.currentBet;
    p.currentBet = 0;
  });
  room.pots = [
    {
      amount: totalPot,
      eligiblePlayers: room.players
        .filter((p) => !p.hasFolded)
        .map((p) => p.id),
    },
  ];
}

/**
 * --- FIX: Corrected betting round completion logic ---
 * Checks if the current betting round is over.
 * @param {object} room - The room object.
 * @returns {boolean} True if the round is complete.
 */
function isBettingRoundComplete(room) {
  const activePlayers = room.players.filter((p) => !p.hasFolded && !p.isAllIn);
  if (activePlayers.length === 0) return true;

  // The round is over if all active players have bet the same amount
  const firstBet = activePlayers[0].currentBet;
  const allMatched = activePlayers.every((p) => p.currentBet === firstBet);

  // And the action has returned to the last aggressor (or big blind pre-flop)
  const nextPlayerIndex = findNextActiveIndexFrom(
    room,
    room.currentPlayerIndex
  );

  return allMatched && nextPlayerIndex === room.actionOnPlayerIndex;
}

/**
 * Moves the game to the next round (flop, turn, river) or to showdown.
 * @param {object} io - The Socket.IO server instance.
 * @param {object} room - The room object.
 */
function nextRound(io, room) {
  reconcilePots(room);

  // Reset betting state for the new round
  room.minBet = 0;
  room.lastRaise = 0; // Reset last raise for the new round

  const remainingPlayers = room.players.filter((p) => !p.hasFolded);
  if (remainingPlayers.length <= 1) {
    showdown(io, room);
    return;
  }

  // Reset action index to be the first player after the dealer
  room.actionOnPlayerIndex = findNextActiveIndexFrom(
    room,
    room.dealerIndex + 1
  );

  if (room.currentRound === "river") {
    showdown(io, room);
    return;
  }

  switch (room.currentRound) {
    case "pre-flop":
      room.currentRound = "flop";
      room.communityCards.push(...dealCommunityCards(room.deck, "flop"));
      break;
    case "flop":
      room.currentRound = "turn";
      room.communityCards.push(...dealCommunityCards(room.deck, "turn"));
      break;
    case "turn":
      room.currentRound = "river";
      room.communityCards.push(...dealCommunityCards(room.deck, "river"));
      break;
  }

  room.currentPlayerIndex = findNextActiveIndexFrom(room, room.dealerIndex);

  const totalPot = room.pots.reduce((sum, pot) => sum + pot.amount, 0);
  io.to(room.id).emit("nextRound", {
    round: room.currentRound,
    communityCards: room.communityCards,
    totalPot: totalPot,
  });

  emitTurn(io, room);
}

/**
 * Handles the showdown, determines winners, and distributes pots.
 * @param {object} io - The Socket.IO server instance.
 * @param {object} room - The room object.
 */
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

/**
 * Posts a blind bet for a player.
 * @param {object} player - The player object.
 * @param {number} amount - The blind amount.
 * @param {object} room - The room object.
 */
function postBlind(player, amount, room) {
  if (!player || player.isSpectator) return;
  const pay = Math.min(player.chips, amount);
  player.chips -= pay;
  player.currentBet += pay;
  if (player.chips <= 0) player.isAllIn = true;
}

/**
 * Advances the turn to the next active player.
 * @param {object} io - The Socket.IO server instance.
 * @param {object} room - The room object.
 */
function advanceTurn(io, room) {
  room.currentPlayerIndex = findNextActiveIndexFrom(
    room,
    room.currentPlayerIndex + 1
  );
  emitTurn(io, room);
}

/**
 * Emits the turn update to clients and starts the turn timer.
 * @param {object} io - The Socket.IO server instance.
 * @param {object} room - The room object.
 */
function emitTurn(io, room) {
  if (room.handEnded) return;

  const activePlayers = room.players.filter(
    (p) => !p.hasFolded && !p.isAllIn && p.chips > 0
  );
  if (activePlayers.length <= 1 && room.currentRound !== "pre-flop") {
    return nextRound(io, room);
  }

  const player = room.players[room.currentPlayerIndex];
  if (!player) {
    // This can happen if no active players are found.
    return nextRound(io, room);
  }

  io.to(room.id).emit("turnUpdate", {
    playerId: player.id,
    username: player.username,
    time: TURN_TIMEOUT,
  });

  // --- Turn Timer ---
  turnTimers[room.id] = setTimeout(() => {
    if (room.players[room.currentPlayerIndex]?.id === player.id) {
      console.log(`Player ${player.username} timed out. Folding.`);
      playerAction(room.id, player.id, "fold", 0, io);
    }
  }, TURN_TIMEOUT);
}

/**
 * Schedules the next hand to start after a delay.
 * @param {string} roomId - The ID of the room.
 * @param {object} io - The Socket.IO server instance.
 */
function autoNextHand(roomId, io) {
  setTimeout(() => startGame(roomId, io), AUTO_NEXT_HAND_DELAY);
}
