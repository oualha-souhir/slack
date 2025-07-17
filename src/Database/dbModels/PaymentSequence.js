const mongoose = require("mongoose");

const paymentSequenceSchema = new mongoose.Schema({
	yearMonth: { type: String, required: true, unique: true },
	currentNumber: { type: Number, default: 1 },
	lastUpdated: { type: Date, default: Date.now },
});
const PaymentSequence = mongoose.model(
	"PaymentSequence",
	paymentSequenceSchema
);
module.exports = PaymentSequence;
