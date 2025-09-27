import mongoose from "mongoose";

const roomSchema = new mongoose.Schema(
  {
    roomCode: {
      type: String,
      required: true,
      unique: true, // e.g., "IN12345"
    },
    host: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    maxPlayers: {
      type: Number,
      required: true,
      min: 2,
      max: 6,
      default: 6,
    },
    status: {
      type: String,
      enum: ["waiting", "ongoing", "finished"],
      default: "waiting",
    },
    smallBlind: { type: Number, default: 1 },
    bigBlind: { type: Number, default: 2 },
    startingStack: { type: Number, default: 1000 },
    players: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        username: String, // quick lookup without extra query
        seat: Number,
      },
    ],
    // reference to the active game
    currentGame: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Game",
    },
  },
  { timestamps: true }
);

const Room = mongoose.model("Room", roomSchema);
export default Room;
