import mongoose from "mongoose";

const gameSchema = new mongoose.Schema(
  {
    room: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Room",
      required: true,
    },
    players: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        username: String,
        chips: { type: Number, default: 1000 }, // stack within this hand
        currentBet: { type: Number, default: 0 },
        hasFolded: { type: Boolean, default: false },
        isAllIn: { type: Boolean, default: false },
        cards: [{ suit: String, value: String }], // hole cards
      },
    ],
    communityCards: [
      {
        suit: String,
        value: String,
      },
    ],
    pot: { type: Number, default: 0 },
    round: {
      type: String,
      enum: ["pre-flop", "flop", "turn", "river", "showdown"],
      default: "pre-flop",
    },
    currentTurn: {
      type: Number,
      default: 0, // index in players[]
    },
    winner: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        handRank: String,
      },
    ],
  },
  { timestamps: true }
);

const Game = mongoose.model("Game", gameSchema);
export default Game;
