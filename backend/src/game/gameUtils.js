import pkg from "pokersolver";
const { Hand } = pkg;

/**
 * Creates a standard 52-card deck.
 * @returns {string[]} An array of cards, e.g., ["As", "Kd", ...].
 */
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

/**
 * Shuffles an array of cards in place.
 * @param {string[]} deck - The deck of cards to shuffle.
 * @returns {string[]} The shuffled deck.
 */
export function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/**
 * Deals two hole cards to each active player.
 * @param {object[]} players - The array of player objects.
 * @param {string[]} deck - The shuffled deck of cards.
 */
export function dealHoleCards(players, deck) {
  players.forEach((p) => {
    if (!p.isSpectator && p.chips > 0) {
      p.cards = [deck.pop(), deck.pop()];
    }
  });
}

/**
 * Deals the community cards for a given stage (flop, turn, or river).
 * @param {string[]} deck - The deck of cards.
 * @param {string} stage - The current betting round ('flop', 'turn', 'river').
 * @returns {string[]} An array of community cards.
 */
export function dealCommunityCards(deck, stage) {
  if (deck.length > 0) deck.pop(); // Burn a card
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

/**
 * Determines the winner(s) of the hand from the eligible players.
 * @param {object[]} players - Players still in the hand.
 * @param {string[]} communityCards - The community cards on the board.
 * @returns {object[]} An array of winner objects.
 */
export function determineWinners(players, communityCards) {
  try {
    const active = players.filter((p) => !p.hasFolded && !p.isSpectator);
    if (active.length === 0) return [];

    // If only one player is left, they win by default.
    if (active.length === 1) {
      const p = active[0];
      return [
        {
          id: p.id,
          username: p.username,
          handName: "Winner",
          handDescr: "Win by default",
        },
      ];
    }

    const solvedHands = active.map((p) => {
      const combinedCards = [...(p.cards || []), ...(communityCards || [])];
      const hand = Hand.solve(combinedCards);
      return { player: p, hand };
    });

    const winnerHands = Hand.winners(solvedHands.map((s) => s.hand));

    const winners = solvedHands
      .filter((s) => winnerHands.some((wh) => wh.descr === s.hand.descr))
      .map((s) => ({
        id: s.player.id,
        username: s.player.username,
        handName: s.hand.name,
        handDescr: s.hand.descr,
      }));

    return winners;
  } catch (err) {
    console.error("Error determining winners:", err);
    // Fallback in case of a library error.
    const active = players.filter((p) => !p.hasFolded && !p.isSpectator);
    if (active.length === 0) return [];
    const p = active[0];
    return [
      {
        id: p.id,
        username: p.username,
        handName: "Error",
        handDescr: "Fallback winner due to error",
      },
    ];
  }
}
