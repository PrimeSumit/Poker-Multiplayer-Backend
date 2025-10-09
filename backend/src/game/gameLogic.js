import {
  createDeck,
  shuffle,
  dealHoleCards,
  dealCommunityCards,
  determineWinners,
} from "./gameUtils.js";
import { getRoom, findNextActiveIndexFrom } from "../websocket/roomManager.js";

const AUTO_NEXT_HAND_DELAY = 7000;
const TURN_TIMEOUT = 60000; // Changed from 20000 to 60000 (1 minute)
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
  room.pots = [];
  room.currentRound = "pre-flop";
  room.minBet = 2; // Big blind amount
  room.lastRaise = 2; // Initialize with big blind amount for pre-flop
  room.bigBlindIndex = bigBlindIndex; // Store big blind's index
  room.bigBlindHasOption = true; // Flag for the big blind's pre-flop option
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

  // The big blind's option is used or voided once they act or someone raises.
  if (playerIdx === room.bigBlindIndex || action === "raise") {
    room.bigBlindHasOption = false;
  }

  switch (action) {
    case "fold":
      player.hasFolded = true;
      break;
    case "check":
      // FIX: A player can only check if their bet matches the current minimum bet.
      if (player.currentBet < room.minBet) {
        io.to(playerId).emit("actionRejected", {
          reason: "You cannot check, you must call, raise, or fold.",
        });
        return; // Reject invalid action
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

      if (
        totalBet < room.minBet + minRaiseAmount || // Must raise at least the last raise amount
        raiseAmount <= 0 ||
        raiseAmount > player.chips
      ) {
        io.to(playerId).emit("actionRejected", {
          reason: `Invalid raise amount. Must raise at least to ${
            room.minBet + minRaiseAmount
          }.`,
        });
        return; // Invalid raise
      }

      player.chips -= raiseAmount;
      player.currentBet = totalBet;
      room.lastRaise = totalBet - room.minBet; // The amount *on top of* the previous bet
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
    minBet: room.minBet,
  });

  if (isBettingRoundComplete(room)) {
    nextRound(io, room);
  } else {
    advanceTurn(io, room);
  }
}

/** Reconcile pots */
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

    // Merge with existing pots if eligible players are the same
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

/** Check if betting round complete */
function isBettingRoundComplete(room) {
  const activePlayers = room.players.filter(
    (p) => !p.hasFolded && !p.isSpectator && p.chips > 0 && !p.isAllIn
  );

  // If 0 or 1 active players are left who can act, betting is over.
  if (activePlayers.length <= 1) {
    const allInPlayers = room.players.filter((p) => p.isAllIn);
    // Everyone is all-in or folded, proceed
    if (activePlayers.length === 0 && allInPlayers.length > 0) return true;

    // Check if the single active player needs to call
    const highestBet = room.minBet;
    if (
      activePlayers.length === 1 &&
      activePlayers[0].currentBet < highestBet
    ) {
      return false;
    }
  }

  const allBetsEqual = activePlayers.every((p) => p.currentBet === room.minBet);

  if (!allBetsEqual) {
    return false; // If bets aren't equal, round is definitely not over.
  }

  // If all bets ARE equal, we must still check if the big blind has exercised their option pre-flop.
  if (room.currentRound === "pre-flop" && room.bigBlindHasOption) {
    return false;
  }

  // If bets are equal and it's not the BB option scenario, the round is complete.
  return true;
}

/** Next round / showdown */
function nextRound(io, room) {
  reconcilePots(room);
  room.minBet = 0;
  room.lastRaise = 2; // Reset for next round (must bet at least big blind)

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

  io.to(room.id).emit("nextRound", {
    round: room.currentRound,
    communityCards: room.communityCards,
    pots: room.pots,
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
    // This can happen if all other players fold, check isBettingRoundComplete logic
    if (isBettingRoundComplete(room)) {
      nextRound(io, room);
    }
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
