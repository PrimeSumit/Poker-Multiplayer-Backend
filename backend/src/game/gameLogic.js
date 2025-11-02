import {
  createDeck,
  shuffle,
  dealHoleCards,
  dealCommunityCards,
  determineWinners,
} from "./gameUtils.js";
import { getRoom, findNextActiveIndexFrom } from "../websocket/roomManager.js";

const AUTO_NEXT_HAND_DELAY = 10000; // Delay for regular hand restart
const FULL_GAME_RESET_DELAY = 15000; // Longer delay to announce winner before reset
const TURN_TIMEOUT = 300000;
const INITIAL_CHIPS = 1000; // Defined constant for buy-in/reset
const turnTimers = {};

/** Checks if the entire tournament/game is over (one or zero players left with chips). */
function checkIfFullGameOver(room) {
  const playersWithChips = room.players.filter(
    (p) => !p.isDisconnected && p.chips > 0
  );
  return playersWithChips.length <= 1;
}

/** Start a new hand */
export function startGame(roomId, io) {
  const room = getRoom(roomId);
  if (!room || !room.players) return;

  room.players = room.players.filter((p) => !p.isDisconnected);
  if (room.players.length < 2) {
    io.to(room.id).emit("handCancelled", { reason: "Not enough players." });
    return;
  }

  room.players.forEach((p) => {
    p.cards = [];
    p.currentBet = 0;
    p.hasFolded = false;
    p.isAllIn = false;
    p.lastAction = null; // Clear last action
    p.isWinner = false; // Clear winner status
    p.winAmount = 0; // Clear win amount
    p.winningHand = null; // Clear winning hand
    p.isSpectator = p.chips <= 0;
  });

  const activePlayers = room.players.filter((p) => !p.isSpectator);
  if (activePlayers.length < 2) {
    io.to(room.id).emit("handCancelled", {
      reason: "Not enough active players to start (less than 2 with chips).",
    });
    return;
  }

  room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
  const smallBlindIndex = findNextActiveIndexFrom(room, room.dealerIndex + 1);
  const bigBlindIndex = findNextActiveIndexFrom(room, smallBlindIndex + 1);

  room.deck = shuffle(createDeck());
  room.communityCards = [];
  room.pots = []; // Clear previous pots
  room.currentRound = "pre-flop";
  room.minBet = 2; // Big blind amount
  room.lastRaise = 2;
  room.bigBlindIndex = bigBlindIndex;
  room.lastRaiserIndex = bigBlindIndex;
  room.currentPlayerIndex = findNextActiveIndexFrom(room, bigBlindIndex + 1);
  room.handEnded = false;

  postBlind(room.players[smallBlindIndex], 1, room);
  postBlind(room.players[bigBlindIndex], 2, room);

  dealHoleCards(activePlayers, room.deck);

  // --- FIX: Send full payload to gameStore ---
  const pot =
    (room.players[smallBlindIndex]?.currentBet || 0) +
    (room.players[bigBlindIndex]?.currentBet || 0);

  io.to(room.id).emit("gameStart", {
    players: room.players.map((p, i) => ({
      id: p.id,
      userId: p.userId, // Send persistent ID
      username: p.username,
      chips: p.chips,
      currentBet: p.currentBet,
      // Add all player states for frontend
      hasFolded: p.hasFolded,
      isAllIn: p.isAllIn,
      isDisconnected: p.isDisconnected,
      lastAction: p.lastAction,
      cards: [], // Send empty cards array
      isDealer: i === room.dealerIndex,
      isSmallBlind: i === smallBlindIndex,
      isBigBlind: i === bigBlindIndex,
    })),
    round: room.currentRound,
    // Add missing state for gameStore
    pot: pot,
    minBet: room.minBet,
    lastRaise: room.lastRaise,
    dealerIndex: room.dealerIndex,
    currentPlayerId: room.players[room.currentPlayerIndex]?.id || null,
  });
  // --- END FIX ---

  activePlayers.forEach((p) =>
    io.to(p.id).emit("yourCards", { cards: p.cards })
  );
  emitTurn(io, room);
}

/** * Player action - Fold, Call, Raise. */
export function playerAction(
  roomId,
  playerId,
  action,
  amount = 0,
  io,
  callback
) {
  const room = getRoom(roomId);

  if (!room || !action) {
    if (callback)
      callback({ success: false, error: "Invalid room or action payload." });
    return;
  }

  if (room.handEnded) {
    if (callback)
      callback({ success: false, error: "The current hand has ended." });
    return;
  }

  const playerIdx = room.players.findIndex((p) => p.id === playerId);
  const player = room.players[playerIdx];

  if (playerIdx === -1) {
    if (callback)
      callback({ success: false, error: "Player not found in room." });
    return;
  }

  if (player.hasFolded || player.isAllIn || player.isSpectator) {
    if (callback)
      callback({
        success: false,
        error: "Player cannot act: already folded, all-in, or spectator.",
      });
    return;
  }

  clearTimeout(turnTimers[room.id]);

  if (
    playerIdx === room.bigBlindIndex &&
    room.currentRound === "pre-flop" &&
    room.minBet === 2
  ) {
    room.lastRaiserIndex = -1;
  }

  // --- FIX: Store lastAction on player object ---
  let lastActionString = action;
  // --- END FIX ---

  switch (action) {
    case "fold":
      player.hasFolded = true;
      lastActionString = "Fold";
      break;
    case "check":
      if (player.currentBet < room.minBet) {
        if (callback)
          callback({ success: false, error: "You must call, raise, or fold." });
        return;
      }
      lastActionString = "Check";
      break;
    case "call": {
      const toCall = Math.min(room.minBet - player.currentBet, player.chips);
      player.chips -= toCall;
      player.currentBet += toCall;
      if (player.chips <= 0) player.isAllIn = true;
      lastActionString = `Call $${toCall}`;
      break;
    }
    case "raise": {
      const totalBet = amount;
      const raiseAmount = totalBet - player.currentBet;
      const minRaiseAmount = room.lastRaise;
      const isAllIn = raiseAmount >= player.chips;

      // ... (rest of raise validation logic is fine) ...

      if (isFacingIncompleteRaise) {
        if (callback)
          callback({
            success: false,
            error: "You cannot re-raise an incomplete all-in raise.",
          });
        return;
      }

      if (!isAllIn && totalBet < room.minBet + minRaiseAmount) {
        if (callback)
          callback({
            success: false,
            error: `Invalid raise amount. Must raise at least to ${
              room.minBet + minRaiseAmount
            }.`,
          });
        return;
      }

      if (raiseAmount <= 0 || raiseAmount > player.chips) {
        if (callback)
          callback({ success: false, error: "Invalid chip amount for raise." });
        return;
      }

      player.chips -= raiseAmount;
      player.currentBet = totalBet;

      const fullRaiseAmount = totalBet - room.minBet;
      if (!isAllIn && fullRaiseAmount >= minRaiseAmount) {
        room.lastRaiserIndex = playerIdx;
        room.lastRaise = fullRaiseAmount;
      }

      room.minBet = player.currentBet;
      if (player.chips <= 0) player.isAllIn = true;
      lastActionString = `Raise to $${totalBet}`;
      break;
    }
    default:
      if (callback)
        callback({ success: false, error: `Unknown action: ${action}` });
      return;
  }

  // --- FIX: Set lastAction on player and calculate pot ---
  player.lastAction = lastActionString;
  // Calculate total pot for frontend
  const potInPots = room.pots.reduce((sum, p) => sum + p.amount, 0);
  const potOnTable = room.players.reduce((sum, p) => sum + p.currentBet, 0);
  const totalPot = potInPots + potOnTable;
  // --- END FIX ---

  // --- FIX: Send full payload to gameStore ---
  io.to(roomId).emit("playerActed", {
    playerId,
    // Send a 'playerUpdate' object as expected by gameStore
    playerUpdate: {
      chips: player.chips,
      currentBet: player.currentBet,
      hasFolded: player.hasFolded,
      isAllIn: player.isAllIn,
      lastAction: player.lastAction,
    },
    // Send the missing state
    pot: totalPot,
    minBet: room.minBet,
    lastRaise: room.lastRaise,
  });
  // --- END FIX ---

  if (isBettingRoundComplete(room)) {
    nextRound(io, room);
  } else {
    advanceTurn(io, room);
  }

  if (callback) callback({ success: true });
}

// reconcilePots function remains the same...
function reconcilePots(room) {
  const playersInHand = room.players.filter(
    (p) => p.currentBet > 0 || p.isAllIn || !p.hasFolded
  );
  // ... (rest of reconcilePots is fine) ...
  const bets = playersInHand
    .map((p) => ({ id: p.id, bet: p.currentBet, isAllIn: p.isAllIn }))
    .sort((a, b) => a.bet - b.bet);

  let lastBetLevel = 0;
  while (bets.some((b) => b.bet > lastBetLevel)) {
    const currentBetLevel = bets.find((b) => b.bet > lastBetLevel)?.bet || 0;
    if (currentBetLevel === 0) break;

    const pot = { amount: 0, eligiblePlayers: [] };

    playersInHand.forEach((p) => {
      const contribution =
        Math.min(p.currentBet, currentBetLevel) - lastBetLevel;
      if (contribution > 0) {
        pot.amount += contribution;
        if (!pot.eligiblePlayers.includes(p.id)) {
          pot.eligiblePlayers.push(p.id);
        }
      }
    });

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

    lastBetLevel = currentBetLevel;
  }

  room.players.forEach((p) => (p.currentBet = 0));
}

// isBettingRoundComplete function remains the same...
function isBettingRoundComplete(room) {
  const activePlayers = room.players.filter(
    (p) => !p.hasFolded && !p.isAllIn && !p.isSpectator
  );
  // ... (rest of isBettingRoundComplete is fine) ...
  if (activePlayers.length <= 1) {
    const playersInHand = room.players.filter(
      (p) => !p.hasFolded && !p.isSpectator
    );
    if (playersInHand.length <= 1) return true;
  }

  const aggressorIndex = room.lastRaiserIndex;

  if (room.currentRound === "pre-flop" && aggressorIndex === -1) {
    if (room.currentPlayerIndex === room.bigBlindIndex) return true;
  }

  if (room.currentPlayerIndex === aggressorIndex) {
    return true;
  }

  const allMatched = activePlayers.every((p) => p.currentBet === room.minBet);
  if (allMatched && aggressorIndex !== null) {
    const playerAfterAggressor = findNextActiveIndexFrom(room, aggressorIndex);
    if (
      room.currentPlayerIndex === playerAfterAggressor ||
      activePlayers.length <= 1
    ) {
      return true;
    }
  }

  return false;
}

/** Handles the game-ending condition (Phase 6). */
function endGameAndReset(roomId, io) {
  const room = getRoom(roomId);
  if (!room) return;

  const winner = room.players.find((p) => p.chips > 0);

  // --- FIX: Send full winner object ---
  io.to(roomId).emit("gameOver", {
    winner: winner
      ? {
          // Send full object
          id: winner.id,
          userId: winner.userId,
          username: winner.username,
          chips: winner.chips,
        }
      : null,
    message: winner
      ? `${winner.username} wins the entire game! Starting new game...`
      : "Game ended with no clear winner.",
  });
  // --- END FIX ---

  room.players.forEach((p) => {
    if (!p.isDisconnected) {
      p.chips = INITIAL_CHIPS;
    }
  });

  console.log(
    `Full game in Room ${roomId} ended. All players reset to ${INITIAL_CHIPS} chips.`
  );

  setTimeout(() => startGame(roomId, io), FULL_GAME_RESET_DELAY);
}

// nextRound function
function nextRound(io, room) {
  reconcilePots(room);
  room.minBet = 0;
  room.lastRaise = 2; // Reset for next round

  // --- FIX: Calculate total pot ---
  const totalPot = room.pots.reduce((sum, pot) => sum + pot.amount, 0);
  // --- END FIX ---

  const remaining = room.players.filter((p) => !p.hasFolded);
  if (remaining.length <= 1) {
    const winner = remaining[0];
    if (winner) {
      winner.chips += totalPot;

      // --- FIX: Update player object for showdown payload ---
      winner.isWinner = true;
      winner.winAmount = totalPot;
      winner.winningHand = "Win by fold";
      // --- END FIX ---

      io.to(room.id).emit("showdown", {
        // Send full updated player list
        players: room.players.map((p) => ({
          ...p,
          cards: p.hasFolded ? [] : p.cards, // Show cards only if not folded
        })),
      });
    }

    if (checkIfFullGameOver(room)) {
      endGameAndReset(room.id, io);
    } else {
      autoNextHand(room.id, io);
      G;
    }
    return;
  }

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

  room.currentPlayerIndex = findNextActiveIndexFrom(room, room.dealerIndex + 1);
  room.lastRaiserIndex = room.currentPlayerIndex;

  // --- FIX: Send full payload to gameStore ---
  io.to(room.id).emit("nextRound", {
    round: room.currentRound,
    communityCards: room.communityCards,
    pot: totalPot, // Send single number
    currentPlayerId: room.players[room.currentPlayerIndex]?.id || null,
    lastRaise: room.lastRaise,
  });
  // --- END FIX ---
  emitTurn(io, room);
}

// showdown function
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
        // --- FIX: Attach winner info to player object ---
        player.isWinner = true;
        player.winAmount = (player.winAmount || 0) + splitAmount;
        player.winningHand = winnerInfo.handName;
        // --- END FIX ---
        potResults.push({
          // (still used for messages, can keep)
          username: player.username,
          amount: splitAmount,
          hand: winnerInfo.handDescr,
        });
      }
    });
  }

  // --- FIX: Send full updated player list ---
  io.to(room.id).emit("showdown", {
    // Send the *entire* player list from the room,
    // now updated with winner info and chips
    players: room.players.map((p) => ({
      ...p,
      // Ensure cards are visible for all showdown players
      cards: showdownPlayers.find((sp) => sp.id === p.id) ? p.cards : [],
    })),
  });
  // --- END FIX ---

  if (checkIfFullGameOver(room)) {
    endGameAndReset(room.id, io);
  } else {
    autoNextHand(room.id, io);
  }
}

// postBlind function remains the same...
function postBlind(player, amount, room) {
  if (!player || player.isSpectator) return;
  const pay = Math.min(player.chips, amount);
  player.chips -= pay;
  player.currentBet += pay;
  if (player.chips <= 0) player.isAllIn = true;
}

// advanceTurn function remains the same...
function advanceTurn(io, room) {
  room.currentPlayerIndex = findNextActiveIndexFrom(
    room,
    room.currentPlayerIndex + 1
  );
  emitTurn(io, room);
}

// emitTurn function
function emitTurn(io, room) {
  if (room.handEnded) return;

  if (isBettingRoundComplete(room)) {
    nextRound(io, room);
    return;
  }

  const player = room.players[room.currentPlayerIndex];
  if (!player) {
    console.log("Error: emitTurn could not find next active player.");
    return;
  }

  // --- FIX: Send full payload to gameStore ---
  io.to(room.id).emit("turnUpdate", {
    playerId: player.id,
    username: player.username,
    // Add missing state for ActionControls
    minBet: room.minBet,
    lastRaise: room.lastRaise,
  });
  // --- END FIX ---

  turnTimers[room.id] = setTimeout(() => {
    if (room.players[room.currentPlayerIndex]?.id === player.id) {
      console.log(`Player ${player.username} timed out. Folding.`);
      // --- FIX: Use correct callback signature ---
      playerAction(room.id, player.id, "fold", 0, io, (res) => {
        if (!res.success)
          console.error("Timeout fold action failed:", res.error);
      });
      // --- END FIX ---
    }
  }, TURN_TIMEOUT);
}

function autoNextHand(roomId, io) {
  setTimeout(() => startGame(roomId, io), AUTO_NEXT_HAND_DELAY);
}
