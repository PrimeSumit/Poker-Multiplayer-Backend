// src/game/gameUtils.js
import pkg from "pokersolver";
const { Hand } = pkg;

// === Constants ===
export const SMALL_BLIND = 1;
export const BIG_BLIND = 2;
export const MAX_RAISE = 150;

// === Deck Utilities ===
export function createDeck() {
  const suits = ["s", "h", "d", "c"];
  const ranks = [
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "T",
    "J",
    "Q",
    "K",
    "A",
  ];
  const deck = [];
  for (const s of suits) for (const r of ranks) deck.push(r + s);
  return deck;
}

export function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// === Dealing ===
export function dealHoleCards(players, deck) {
  players.forEach((p) => {
    if (!p.isSpectator && p.chips > 0) {
      p.cards = [deck.pop(), deck.pop()];
      p.currentBet = 0;
      p.hasFolded = false;
      p.isAllIn = false;
    }
  });
}

export function dealCommunityCards(deck, stage) {
  if (deck.length > 0) deck.pop(); // burn
  switch (stage) {
    case "flop":
      return [deck.pop(), deck.pop(), deck.pop()];
    case "turn":
    case "river":
      return [deck.pop()];
    default:
      return [];
  }
}

// === Winners ===
export function determineWinners(players, communityCards) {
  try {
    const active = players.filter((p) => !p.hasFolded && !p.isSpectator);
    if (active.length === 0) return [];
    if (active.length === 1) {
      const p = active[0];
      return [
        {
          id: p.id,
          username: p.username,
          handName: null,
          handDescr: "Win by fold",
        },
      ];
    }

    const solved = active.map((p) => {
      const combined = [...(p.cards || []), ...(communityCards || [])];
      const hand = Hand.solve(combined);
      return { player: p, hand };
    });

    const winnerHands = Hand.winners(solved.map((s) => s.hand));
    const winners = solved
      .filter((s) => winnerHands.some((wh) => wh.descr === s.hand.descr))
      .map((s) => ({
        id: s.player.id,
        username: s.player.username,
        handName: s.hand.name,
        handDescr: s.hand.descr,
      }));

    return winners;
  } catch (err) {
    console.error("determineWinners error:", err);
    const active = players.filter((p) => !p.hasFolded && !p.isSpectator);
    if (active.length === 0) return [];
    const p = active[0];
    return [
      {
        id: p.id,
        username: p.username,
        handName: null,
        handDescr: "Fallback winner",
      },
    ];
  }
}

// === Betting Helpers ===
export function validateRaise(amount) {
  return Math.min(amount, MAX_RAISE);
}

export function collectBets(players) {
  let pot = 0;
  players.forEach((p) => {
    if (!p.isSpectator) {
      pot += p.currentBet;
      p.currentBet = 0;
    }
  });
  return pot;
}

export function allPlayersChecked(players, currentBet) {
  return players
    .filter((p) => !p.hasFolded && !p.isAllIn && !p.isSpectator)
    .every((p) => p.currentBet === currentBet);
}

// === Player Turn Helpers ===
export function findNextActiveIndex(room) {
  const players = room.players || [];
  if (players.length === 0) return null;
  let start = room.currentPlayerIndex % players.length;
  for (let i = 0; i < players.length; i++) {
    const idx = (start + i) % players.length;
    const p = players[idx];
    if (!p) continue;
    if (!p.hasFolded && !p.isAllIn && !p.isSpectator && p.chips > 0) return idx;
  }
  return null;
}
