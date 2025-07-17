const mongoose = require("mongoose");

const commandSequenceSchema = new mongoose.Schema({
	yearMonth: { type: String, required: true, unique: true },
	currentNumber: { type: Number, default: 1 },
	lastUpdated: { type: Date, default: Date.now },
});
const CommandSequence = mongoose.model(
	"CommandSequence",
	commandSequenceSchema
);
module.exports = CommandSequence;
