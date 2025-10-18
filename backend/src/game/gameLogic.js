import {
  createDeck,
  shuffle,
  dealHoleCards,
  dealCommunityCards,
  determineWinners,
} from "./game_utils.js";
import { getRoom, findNextActiveIndexFrom } from "../websocket/room_manager.js";

const AUTO_NEXT_HAND_DELAY = 7000; // Delay for regular hand restart
const FULL_GAME_RESET_DELAY = 10000; // Longer delay to announce winner before reset
const TURN_TIMEOUT = 60000;
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

    // CRITICAL FIX: Chips are cumulative. Players with 0 chips are spectators.
    // Chips are only refilled via endGameAndReset, not between hands.
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
  room.pots = [];
  room.currentRound = "pre-flop";
  room.minBet = 2; // Big blind amount
  room.lastRaise = 2;
  room.bigBlindIndex = bigBlindIndex;
  // MODIFIED: We use the big blind index to track the initial 'aggressor'.
  room.lastRaiserIndex = bigBlindIndex;
  room.currentPlayerIndex = findNextActiveIndexFrom(room, bigBlindIndex + 1);
  room.handEnded = false;

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

/** * Player action - Fold, Call, Raise.
 * FIX C: Added callback to report all failures explicitly instead of silent returns.
 */
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
    // Check for hand ended
    if (callback)
      callback({ success: false, error: "The current hand has ended." });
    return;
  }

  const playerIdx = room.players.findIndex((p) => p.id === playerId);
  const player = room.players[playerIdx];

  // Validation: Player not found OR it's not their turn (already checked in socket.js, but defensive check)
  if (playerIdx === -1) {
    if (callback)
      callback({ success: false, error: "Player not found in room." });
    return;
  }

  // Validation: Player state allows action
  if (player.hasFolded || player.isAllIn || player.isSpectator) {
    if (callback)
      callback({
        success: false,
        error: "Player cannot act: already folded, all-in, or spectator.",
      });
    return;
  }

  clearTimeout(turnTimers[room.id]);

  // The big blind's option is only used once.
  if (
    playerIdx === room.bigBlindIndex &&
    room.currentRound === "pre-flop" &&
    room.minBet === 2
  ) {
    room.lastRaiserIndex = -1; // Special case for BB option
  }

  switch (action) {
    case "fold":
      player.hasFolded = true;
      break;
    case "check":
      if (player.currentBet < room.minBet) {
        // Must reject check if player needs to match a bet
        if (callback)
          callback({ success: false, error: "You must call, raise, or fold." });
        return;
      }
      break;
    case "call": {
      const toCall = Math.min(room.minBet - player.currentBet, player.chips);
      player.chips -= toCall;
      player.currentBet += toCall;
      if (player.chips <= 0) player.isAllIn = true;
      break;
    }
    case "raise": {
      const totalBet = amount;
      const raiseAmount = totalBet - player.currentBet;
      const minRaiseAmount = room.lastRaise;
      const isAllIn = raiseAmount >= player.chips;

      // Check if the player is facing an incomplete raise (prevent re-raising incomplete)
      const lastRaiser = room.players[room.lastRaiserIndex];
      const isFacingIncompleteRaise =
        lastRaiser &&
        lastRaiser.isAllIn &&
        room.minBet - (room.minBet - room.lastRaise) < minRaiseAmount;

      if (isFacingIncompleteRaise) {
        if (callback)
          callback({
            success: false,
            error: "You cannot re-raise an incomplete all-in raise.",
          });
        return;
      }

      // The total bet must be at least the current bet plus the minimum raise, UNLESS it's an all-in.
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

      // Differentiate between a full raise and an incomplete one
      const fullRaiseAmount = totalBet - room.minBet;
      if (!isAllIn && fullRaiseAmount >= minRaiseAmount) {
        // This is a full, legitimate raise
        room.lastRaiserIndex = playerIdx;
        room.lastRaise = fullRaiseAmount;
      } else {
        // This is an incomplete all-in raise.
      }

      room.minBet = player.currentBet;
      if (player.chips <= 0) player.isAllIn = true;
      break;
    }
    default:
      if (callback)
        callback({ success: false, error: `Unknown action: ${action}` });
      return;
  }

  io.to(roomId).emit("playerActed", {
    playerId,
    action,
    currentBet: player.currentBet,
    chips: player.chips,
    minBet: room.minBet,
  });

  if (isBettingRoundComplete(room)) {
    nextRound(io, room);
  } else {
    advanceTurn(io, room);
  }

  if (callback) callback({ success: true }); // <<< SUCCESS CALLBACK
}

// reconcilePots function remains the same...
function reconcilePots(room) {
  const playersInHand = room.players.filter(
    (p) => p.currentBet > 0 || p.isAllIn || !p.hasFolded
  );
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

// MODIFIED: The logic for checking round completion is now more robust.
function isBettingRoundComplete(room) {
  const activePlayers = room.players.filter(
    (p) => !p.hasFolded && !p.isAllIn && !p.isSpectator
  );

  // If 1 or 0 players can act, betting is over.
  if (activePlayers.length <= 1) {
    const playersInHand = room.players.filter(
      (p) => !p.hasFolded && !p.isSpectator
    );
    // If only one person is left in the hand at all, round is over.
    if (playersInHand.length <= 1) return true;
  }

  // Find the index of the player who made the last legitimate raise.
  const aggressorIndex = room.lastRaiserIndex;

  // Special pre-flop BB option case
  if (room.currentRound === "pre-flop" && aggressorIndex === -1) {
    if (room.currentPlayerIndex === room.bigBlindIndex) return true;
  }

  // The round is over if the action has returned to the last aggressor.
  if (room.currentPlayerIndex === aggressorIndex) {
    return true;
  }

  // The round is also over if all remaining players have matched the bet and the aggressor has acted.
  const allMatched = activePlayers.every((p) => p.currentBet === room.minBet);
  if (allMatched && aggressorIndex !== null) {
    // Check if the current player is the one who made the last raise (and action came around)
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

/** * Handles the game-ending condition (only one player remains with chips).
 * Resets chips for all players and restarts the game.
 */
function endGameAndReset(roomId, io) {
  const room = getRoom(roomId);
  if (!room) return;

  // Find the single winner (player with chips > 0)
  const winner = room.players.find((p) => p.chips > 0);

  // 1. Announce End of Game and Winner (LEADERBOARD)
  io.to(roomId).emit("gameOver", {
    winnerUsername: winner ? winner.username : "No Winner (all eliminated)",
    message: winner
      ? `${winner.username} wins the entire game! Starting Game 2...`
      : "Game ended with no clear winner.",
  });

  // 2. Reset Chips for all non-disconnected players (The 1000 chip rule)
  room.players.forEach((p) => {
    if (!p.isDisconnected) {
      // CRITICAL: Resets the winner's chips (and everyone else's) to 1000
      p.chips = INITIAL_CHIPS;
    }
  });

  console.log(
    `Full game in Room ${roomId} ended. All players reset to ${INITIAL_CHIPS} chips.`
  );

  // 3. Start the new game (Game 2) after a delay
  setTimeout(() => startGame(roomId, io), FULL_GAME_RESET_DELAY);
}

// nextRound function remains the same...
function nextRound(io, room) {
  reconcilePots(room);
  room.minBet = 0;
  room.lastRaise = 2; // Reset for next round

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

    // CHECK FOR FULL GAME OVER
    if (checkIfFullGameOver(room)) {
      endGameAndReset(room.id, io);
    } else {
      autoNextHand(room.id, io);
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

  // NEW: Action starts with the first active player after the dealer.
  room.currentPlayerIndex = findNextActiveIndexFrom(room, room.dealerIndex + 1);
  room.lastRaiserIndex = room.currentPlayerIndex; // The first player to act is the initial 'aggressor' post-flop.

  io.to(room.id).emit("nextRound", {
    round: room.currentRound,
    communityCards: room.communityCards,
    pots: room.pots,
  });
  emitTurn(io, room);
}

// showdown and helper functions remain the same...
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

  // CHECK FOR FULL GAME OVER
  if (checkIfFullGameOver(room)) {
    endGameAndReset(room.id, io);
  } else {
    autoNextHand(room.id, io);
  }
}

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

  // NEW: Check if the round should end before emitting the next turn.
  if (isBettingRoundComplete(room)) {
    nextRound(io, room);
    return;
  }

  const player = room.players[room.currentPlayerIndex];
  if (!player) {
    return;
  }

  io.to(room.id).emit("turnUpdate", {
    playerId: player.id,
    username: player.username,
  });

  turnTimers[room.id] = setTimeout(() => {
    if (room.players[room.currentPlayerIndex]?.id === player.id) {
      console.log(`Player ${player.username} timed out. Folding.`);
      playerAction(room.id, player.id, "fold", 0, io);
    }
  }, TURN_TIMEOUT);
}

function autoNextHand(roomId, io) {
  setTimeout(() => startGame(roomId, io), AUTO_NEXT_HAND_DELAY);
}
