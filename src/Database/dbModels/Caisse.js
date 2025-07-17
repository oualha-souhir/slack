const mongoose = require("mongoose");

mongoose.set("strictQuery", false);
const fundingRequestSchema = new mongoose.Schema({
	requestId: { type: String, required: true },
	changed: { type: Boolean, default: false },
	amount: { type: Number, required: true },
	currency: { type: String, required: true },
	reason: { type: String, required: true },
	requestedDate: { type: String },
	submittedBy: { type: String, required: true },
	submittedByID: { type: String },

	submitterName: { type: String },
	status: {
		type: String,
		required: true,
		default: "En attente",
	},
	rejectionReason: { type: String },
	submittedAt: { type: Date, default: Date.now },
	approvedBy: { type: String },
	approvedAt: { type: Date },
	disbursementType: { type: String },
	paymentDetails: {
		method: { type: String },
		notes: { type: String },
		approvedBy: { type: String },
		approvedAt: { type: Date },
		filledBy: { type: String },
		filledByName: { type: String },

		filledAt: { type: Date },
		cheque: {
			type: {
				number: String,
				bank: String,
				date: String,
				order: String,
				file_ids: [String], // Store multiple file IDs
				urls: [String], // Array for page URLs
			},
			default: null,
		},
	},
	workflow: {
		stage: { type: String, required: true, default: "initial_request" },
		history: [
			{
				stage: { type: String, required: true },
				timestamp: { type: Date, default: Date.now },
				actor: { type: String, required: true },
				details: { type: String },
			},
		],
	},
});
const transferRequestSchema = new mongoose.Schema({
	transferId: { type: String, required: true },
	fromCaisse: { type: String, required: true }, // Channel ID of source caisse
	toCaisse: { type: String, required: true }, // Channel ID of destination caisse
	currency: { type: String, required: true },
	amount: { type: Number, required: true },
	motif: { type: String, required: true },
	paymentMode: { type: String, required: true }, // Should be "espece" only
	submittedBy: { type: String, required: true },
	submittedByID: { type: String, required: true },
	status: {
		type: String,
		required: true,
		default: "En attente",
		enum: ["En attente", "Approuvé", "Rejeté"],
	},
	submittedAt: { type: Date, default: Date.now },
	approvedBy: { type: String },
	approvedAt: { type: Date },
	rejectedBy: { type: String },
	rejectedAt: { type: Date },
	rejectionReason: { type: String },
	workflow: {
		stage: { type: String, required: true, default: "initial_request" },
		history: [
			{
				stage: { type: String, required: true },
				timestamp: { type: Date, default: Date.now },
				actor: { type: String, required: true },
				details: { type: String },
			},
		],
	},
});

const transactionSchema = new mongoose.Schema({
	type: { type: String, required: true },
	amount: { type: Number, required: true },
	currency: { type: String, required: true },
	requestId: { type: String },
	orderId: { type: String },
	transferId: { type: String }, // Add this for transfer transactions

	paymentNumber: { type: String }, // e.g., "PAY/2025/03/0001"
	decaissementNumber: { type: String }, // e.g., "DEC/202
	details: { type: String },
	timestamp: { type: Date, default: Date.now },
	paymentMethod: { type: String },
	paymentDetails: { type: mongoose.Schema.Types.Mixed },
	accountingRequired: { type: String },
	transferDetails: {
		// Add transfer-specific details
		from: { type: String }, // Source caisse channel ID
		to: { type: String }, // Destination caisse channel ID
		motif: { type: String }, // Transfer reason
		approvedBy: { type: String }, // Who approved the transfer
	},
});
const PaymentCounterSchema = new mongoose.Schema({
	periodId: { type: String, required: true, unique: true },
	sequence: { type: Number, default: 0 },
});

const DecaissementCounterSchema = new mongoose.Schema({
	periodId: { type: String, required: true, unique: true },
	sequence: { type: Number, default: 0 },
});

const PaymentCounter = mongoose.model("PaymentCounter", PaymentCounterSchema);
const DecaissementCounter = mongoose.model(
	"DecaissementCounter",
	DecaissementCounterSchema
);

const caisseSchema = new mongoose.Schema({
	type: {
		type: String,
		required: true,
	},
	channelId: {
		type: String, // Slack channel ID associated with the caisse
		required: true,
	},
	channelName: {
		type: String, // Slack channel name associated with the caisse
		required: true,
	},
	balances: {
		XOF: { type: Number, default: 0 },
		USD: { type: Number, default: 0 },
		EUR: { type: Number, default: 0 },
	},
	latestRequestId: { type: String },
	fundingRequests: [fundingRequestSchema],
	transferRequests: [transferRequestSchema],
	transactions: [transactionSchema],
});

const Caisse = mongoose.model("Caisse", caisseSchema);
module.exports = {
	Caisse,
	DecaissementCounter,
	PaymentCounter,

};
