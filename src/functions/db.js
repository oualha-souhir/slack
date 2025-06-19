// src/db.js
const mongoose = require("mongoose");
const { syncOrderToExcel } = require("./excelReportORDER");
require("dotenv").config();
const { syncPaymentRequestToExcel } = require("./excelReportPAY");

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI?.match(/^mongodb(\+srv)?:\/\//)) {
	throw new Error(
		"Format MongoDB URI invalide. Doit commencer par mongodb:// ou mongodb+srv://"
	);
}

mongoose.set("debug", true);
mongoose
	.connect(MONGODB_URI, {
		useNewUrlParser: true,
		useUnifiedTopology: true,
	})
	.then(() => {
		console.log("MongoDB connected successfully");
	})
	.catch((err) => {
		console.error("MongoDB connection error:", err);
	});

const ConfigSchema = new mongoose.Schema({
	key: { type: String, required: true, unique: true }, // 'equipe_options', 'unit_options', 'currencies'
	values: { type: [String], default: [] },
});

const UserRoleSchema = new mongoose.Schema({
	userId: { type: String, required: true, unique: true },
	username: { type: String, required: true }, // Slack username or display name
	roles: { type: [String], default: [] }, // e.g., ['admin', 'finance', 'achat']
});

const Config = mongoose.model("Config", ConfigSchema);
const UserRole = mongoose.model("UserRole", UserRoleSchema);

const OrderSchema = new mongoose.Schema(
	{
		id_commande: { type: String, unique: true },
		titre: String,
		demandeur: String,
		demandeurId: String,

		channel: String,
		channelId: String, // Slack channel ID
		slackMessages: [
			{
				channel: { type: String, required: true },
				ts: { type: String, required: true }, // Slack timestamp serves as message ID
				messageType: { type: String, default: "notification" },
				createdAt: { type: Date, default: Date.now },
			},
		],
		articles: [
			{
				quantity: { type: Number, required: false }, // Numeric quantity
				unit: { type: String, required: false }, // Unit as a separate field
				designation: { type: String, required: false },
				photos: [
					{
						id: String,
						name: String,
						url: String,
						permalink: String,
						mimetype: String,
						size: Number,
						uploadedAt: { type: Date, default: Date.now },
					},
				],
			},
		],
		equipe: { type: String, default: "Non spécifié" },
		productPhotos: [
			{
				id: String,
				name: String,
				url: String,
				permalink: String,
				mimetype: String,
				size: Number,
				uploadedAt: { type: Date, default: Date.now },
			},
		],
		proformas: [
			{
				file_ids: [String], // Store multiple file IDs
				urls: [String], // Array for page URLs
				nom: String,
				montant: Number,
				devise: {
					type: String,
					required: false,
				},
				validated: {
					type: Boolean,
					default: false,
				},
				validatedAt: Date,
				validatedBy: String,
				validationComment: { type: String, default: "" },
				comment: { type: String, default: "" },
				fournisseur: { type: String, default: "" },
				pages: Number,
			},
		],
		blockPayment: { type: Boolean, default: false },
		// validatedBy: { type: String, default: "Admin" },
		validatedBy: { type: String, default: "" },

		statut: { type: String, enum: ["En attente", "Validé", "Rejeté"] },
		rejection_reason: { type: String, default: null },
		date: { type: Date, default: Date.now },
		date_requete: { type: String, required: true }, // Requested payment date

		autorisation_admin: { type: Boolean, default: false },
		isApprovedOnce: { type: Boolean, default: false }, // New field to track if approved at least once
		payment_reminder_sent: { type: Boolean, default: false },
		proforma_reminder_sent: { type: Boolean, default: false },
		admin_reminder_sent: {
			type: Boolean,
			default: false,
		},

		delay_history: [
			{
				type: {
					type: String,
					enum: [
						"reminder",
						"payment_reminder",
						"proforma_reminder",
						"admin_reminder",
					],
				},
				timestamp: { type: Date, default: Date.now },
			},
		],
		totalAmount: { type: Number, required: false },
		payments: [
			{
				paymentMode: { type: String, required: false }, // e.g., "Chèque", "Virement", etc.
				amountPaid: { type: Number, required: false },
				paymentTitle: { type: String, required: false }, // e.g., "Acompte 1"
				paymentProofs: [{ type: String }],
				paymentUrl: { type: String }, // External URL if provided
				details: { type: mongoose.Schema.Types.Mixed }, // Dynamic fields (e.g., cheque_number, virement_bank)
				dateSubmitted: { type: Date, default: Date.now },
				paymentStatus: { type: String },
			},
		],
		// lastExcelSync: { type: Date },
		amountPaid: { type: Number, default: 0 }, // Track cumulative amount paid
		remainingAmount: { type: Number, default: 0 },
		paymentDone: { type: String, default: "false" },
		delay_history: [
			{
				type: {
					type: String,
					enum: [
						"reminder",
						"payment_reminder",
						"proforma_reminder",
						"admin_reminder",
					],
					required: false,
				},
				timestamp: {
					type: Date,
					default: Date.now,
				},
				details: {
					type: String,
					default: "",
				},
			},
		],
		deleted: {
			type: Boolean,
			default: false,
		},
		deletedAt: {
			type: Date,
			default: null,
		},
		deletedBy: {
			type: String,
			default: null,
		},
		deletedByName: {
			type: String,
			default: null,
		},
		deletionReason: {
			type: String,
			default: null,
		},
		// Ensure createdAt is tracked
		createdAt: {
			type: Date,
			default: Date.now,
		},
	},
	{
		timestamps: false, // This adds createdAt and updatedAt fields automatically
	}
);

// Define a schema for temporary form data
const FormDataSchema = new mongoose.Schema({
	key: { type: String, required: true, unique: true },
	data: { type: Object, required: true },
	createdAt: { type: Date, default: Date.now, expires: "1h" }, // Auto-expire after 1 hour
});

const FormData1 = mongoose.model("FormData1", FormDataSchema);

const PaymentRequestSchema = new mongoose.Schema({
	id_paiement: { type: String, required: true, unique: true }, // e.g., PAY/2025/03/0001
	project: { type: String, required: true }, // Slack channel ID (e.g., C06GR4XCK8X)
	id_projet: { type: String, required: true }, // Project ID (e.g., P12345)
	titre: { type: String, required: true }, // e.g., "Paiement Ouvrier"
	demandeur: { type: String, required: true }, // Slack user ID (e.g., U08F8FT3U85)
	demandeurId: String,

	date: { type: Date, default: Date.now }, // Creation date
	motif: { type: String, required: true }, // Payment reason
	montant: { type: Number, required: true }, // Amount to pay
	bon_de_commande: { type: String, default: null }, // PO number (optional)
	lastExcelSync: { type: Date },
	justificatif: [
		{
			url: { type: String, required: true },
			type: { type: String, enum: ["file", "url"], required: true },
			createdAt: { type: Date, default: Date.now },
		},
	],
	blockPayment: { type: Boolean, default: false },
	date_requete: { type: String, required: true }, // Requested payment date
	statut: {
		type: String,
		enum: [
			"En attente",
			"Validé",
			"Rejeté",
			"Payé",
			"Paiement Partiel",
			"Annulé",
		],
		default: "En attente",
	},
	updatedAt: Date,
	demandeur_message: { channel: String, ts: String }, // Added for demandeur message
	admin_message: { channel: String, ts: String }, // Added for admin message

	amountPaid: Number,
	remainingAmount: Number,
	rejectedByName: { type: String, default: null },
	rejectedById: { type: String, default: null },
	rejection_reason: { type: String, default: null },

	autorisation_admin: { type: Boolean, default: false },
	payments: [
		{
			paymentMode: { type: String, required: false }, // e.g., "Chèque", "Virement", etc.
			amountPaid: { type: Number, required: false },
			paymentTitle: { type: String, required: false }, // e.g., "Acompte 1"
			paymentProofs: [{ type: String }], // File URL if uploaded
			paymentUrl: { type: String }, // External URL if provided
			details: { type: mongoose.Schema.Types.Mixed }, // Dynamic fields (e.g., cheque_number, virement_bank)
			dateSubmitted: { type: Date, default: Date.now },
			paymentStatus: { type: String },
		},
	],
	paymentDone: { type: String, default: "false" },

	devise: {
		type: String,
		required: false,
	},
	createdAt: { type: Date, default: Date.now },
	updatedAt: { type: Date, default: Date.now },
});

// Post-save hook
PaymentRequestSchema.post("save", async function (doc) {
	try {
		if (doc) {
			console.log(
				`[Excel Integration] Post-save hook triggered for payment request: ${doc.id_paiement}`
			);
			await syncPaymentRequestToExcel(doc).catch((err) => {
				console.error(
					`[Excel Integration] Excel sync failed but payment request saved to MongoDB: ${err.message}`
				);
			});
		}
	} catch (error) {
		console.error(
			`[Excel Integration] Error in post-save Excel sync for payment request: ${error}`
		);
	}
});

// Post-findOneAndUpdate hook
PaymentRequestSchema.post("findOneAndUpdate", async function (doc) {
	try {
		if (doc) {
			console.log(
				`[Excel Integration] Post-findOneAndUpdate hook triggered for payment request: ${doc.id_paiement}`
			);
			await syncPaymentRequestToExcel(doc).catch((err) => {
				console.error(
					`[Excel Integration] Excel sync failed after update for payment request: ${err.message}`
				);
			});
		}
	} catch (error) {
		console.error(
			`[Excel Integration] Error in post-findOneAndUpdate Excel sync for payment request: ${error}`
		);
	}
});
PaymentRequestSchema.pre("updateOne", async function (next) {
	try {
		const update = this._update;
		const conditions = this._conditions;

		// Check if the update involves modifying the payments array
		if (update.$push && update.$push.payments) {
			const payment = update.$push.payments;
			const paymentId = conditions.id_paiement;

			// Fetch the current document
			const doc = await this.model.findOne({ id_paiement: paymentId });
			if (!doc) {
				console.error(
					`[Excel Integration] Document not found for id_paiement: ${paymentId}`
				);
				return next();
			}

			// Calculate new amountPaid
			const currentAmountPaid = doc.amountPaid || 0;
			const newPaymentAmount = payment.amountPaid || 0;
			const newAmountPaid = currentAmountPaid + newPaymentAmount;

			// Calculate new remainingAmount
			const totalAmount = doc.montant || 0;
			const newRemainingAmount = totalAmount - newAmountPaid;

			// Update the document with new values
			this._update.$set = this._update.$set || {};
			this._update.$set.amountPaid = newAmountPaid;
			this._update.$set.remainingAmount = newRemainingAmount;

			console.log(
				`[Excel Integration] Pre-updateOne: Updated amountPaid to ${newAmountPaid}, remainingAmount to ${newRemainingAmount} for ${paymentId}`
			);
		}

		next();
	} catch (error) {
		console.error(
			`[Excel Integration] Error in pre-updateOne hook: ${error.message}`
		);
		next(error);
	}
});
// Post-updateOne hook
PaymentRequestSchema.post("updateOne", async function (result) {
	try {
		// Skip if middleware is explicitly disabled
		if (this._update && this._update.$set && this._update.$set.skipMiddleware) {
			console.log(
				`[Excel Integration] Skipping post-updateOne hook for payment request due to skipMiddleware`
			);
			return;
		}

		if (this && this._conditions && this._conditions.id_paiement) {
			const paymentId = this._conditions.id_paiement;
			console.log(
				`[Excel Integration] Post-updateOne hook triggered for payment request: ${paymentId}`
			);

			// Fetch the updated document
			const updatedDoc = await this.model.findOne({ id_paiement: paymentId });
			if (updatedDoc) {
				console.log(
					`[Excel Integration] Updated document: amountPaid=${updatedDoc.amountPaid}, remainingAmount=${updatedDoc.remainingAmount}`
				);
				await syncPaymentRequestToExcel(updatedDoc).catch((err) => {
					console.error(
						`[Excel Integration] Excel sync failed after update for payment request: ${err.message}`
					);
				});
			} else {
				console.error(
					`[Excel Integration] Could not find document after update: ${paymentId}`
				);
			}
		} else {
			console.error(
				"[Excel Integration] Unable to identify payment request in post-updateOne hook"
			);
			console.log("[Excel Integration] Result object:", result);
			console.log("[Excel Integration] Query conditions:", this._conditions);
		}
	} catch (error) {
		console.error(
			`[Excel Integration] Error in post-updateOne Excel sync for payment request: ${error}`
		);
	}
});

PaymentRequestSchema.post("findOneAndUpdate", async function (doc) {
	try {
		let orderDoc = doc;

		// If doc is not provided or is an update result (e.g., { acknowledged: false }), query the document manually
		if (
			!orderDoc ||
			!orderDoc.id_commande ||
			typeof orderDoc.id_commande !== "string"
		) {
			orderDoc = await this.model.findOne(this.getQuery());
		}

		// Check if a valid document was found and it's not soft-deleted
		if (orderDoc) {
			console.log(
				`[Excel Integration] Post-findOneAndUpdate hook triggered for order: ${orderDoc.id_commande}`
			);
			await syncPaymentRequestToExcel(orderDoc).catch((err) => {
				console.error(
					`[Excel Integration] Excel sync failed after update: ${err.message}`
				);
			});
		} else {
			console.log(
				`[Excel Integration] No valid document found in post-findOneAndUpdate hook for query: ${JSON.stringify(
					this.getQuery()
				)}`
			);
		}
	} catch (error) {
		console.error(
			`[Excel Integration] Error in post-findOneAndUpdate Excel sync: ${error.message}`,
			error.stack
		);
	}
});
PaymentRequestSchema.pre("findOneAndUpdate", async function (next) {
	try {
		const update = this._update;
		const conditions = this._conditions;

		// Check if the update involves modifying the payments array
		if (update.$push && update.$push.payments) {
			const payment = update.$push.payments;
			const paymentId = conditions.id_paiement;

			// Fetch the current document
			const doc = await this.model.findOne({ id_paiement: paymentId });
			if (!doc) {
				console.error(
					`[Excel Integration] Document not found for id_paiement: ${paymentId}`
				);
				return next();
			}

			// Calculate new amountPaid
			const currentAmountPaid = doc.amountPaid || 0;
			const newPaymentAmount = payment.amountPaid || 0;
			const newAmountPaid = currentAmountPaid + newPaymentAmount;

			// Calculate new remainingAmount
			const totalAmount = doc.montant || 0;
			const newRemainingAmount = totalAmount - newAmountPaid;

			// Update the document with new values
			this._update.$set = this._update.$set || {};
			this._update.$set.amountPaid = newAmountPaid;
			this._update.$set.remainingAmount = newRemainingAmount;

			console.log(
				`[Excel Integration] Pre-findOneAndUpdate: Updated amountPaid to ${newAmountPaid}, remainingAmount to ${newRemainingAmount} for ${paymentId}`
			);
		}

		next();
	} catch (error) {
		console.error(
			`[Excel Integration] Error in pre-findOneAndUpdate hook: ${error.message}`
		);
		next(error);
	}
});
PaymentRequestSchema.post("insertOne", async function (doc) {
	try {
		if (doc) {
			console.log(
				`[Excel Integration] Post-insertOne hook triggered for payment request: ${doc.id_paiement}`
			);
			await syncPaymentRequestToExcel(doc).catch((err) => {
				console.error(
					`[Excel Integration] Excel sync failed after update for payment request: ${err.message}`
				);
			});
		}
	} catch (error) {
		console.error(
			`[Excel Integration] Error in post-updateOne Excel sync for payment request: ${error}`
		);
	}
});
const PaymentRequest = mongoose.model("PaymentRequest", PaymentRequestSchema);

OrderSchema.index({ date: -1 }); // For sorting
OrderSchema.index({ statut: 1 }); // For status filtering
/// Add post-save middleware to the OrderSchema
OrderSchema.post("save", async function (doc) {
	try {
		if (doc && !doc.deleted) {
			console.log(
				`[Excel Integration] Post-save hook triggered for order: ${doc.id_commande}`
			);
			await syncOrderToExcel(doc).catch((err) => {
				console.error(
					`[Excel Integration] Excel sync failed but order saved to MongoDB: ${err.message}`
				);
			});
		}
	} catch (error) {
		console.error(
			`[Excel Integration] Error in post-save Excel sync: ${error}`
		);
	}
});

OrderSchema.post("findOneAndUpdate", async function (doc) {
	console.log("111333");
	try {
		let orderDoc = doc;

		// If doc is not provided or is an update result (e.g., { acknowledged: false }), query the document manually
		if (
			!orderDoc ||
			!orderDoc.id_commande ||
			typeof orderDoc.id_commande !== "string"
		) {
			orderDoc = await this.model.findOne(this.getQuery());
		}

		// Check if a valid document was found and it's not soft-deleted
		if (orderDoc) {
			console.log(
				`[Excel Integration] Post-findOneAndUpdate hook triggered for order: ${orderDoc.id_commande}`
			);
			await syncOrderToExcel(orderDoc).catch((err) => {
				console.error(
					`[Excel Integration] Excel sync failed after update: ${err.message}`
				);
			});
		} else {
			console.log(
				`[Excel Integration] No valid document found in post-findOneAndUpdate hook for query: ${JSON.stringify(
					this.getQuery()
				)}`
			);
		}
	} catch (error) {
		console.error(
			`[Excel Integration] Error in post-findOneAndUpdate Excel sync: ${error.message}`,
			error.stack
		);
	}
});

OrderSchema.post("updateOne", async function (doc) {
	console.log("1112222");
	try {
		if (doc) {
			console.log(
				`[Excel Integration] Post-findOneAndUpdate hook triggered for order: ${doc.id_commande}`
			);
			await syncOrderToExcel(doc).catch((err) => {
				console.error(
					`[Excel Integration] Excel sync failed after update: ${err.message}`
				);
			});
		}
	} catch (error) {
		console.error(
			`[Excel Integration] Error in post-findOneAndUpdate Excel sync: ${error}`
		);
	}
});
const Order = mongoose.model("Order", OrderSchema);
console.log("Order model defined:", Order !== undefined);
// Command sequence schema
const commandSequenceSchema = new mongoose.Schema({
	yearMonth: { type: String, required: true, unique: true },
	currentNumber: { type: Number, default: 1 },
	lastUpdated: { type: Date, default: Date.now },
});
const CommandSequence = mongoose.model(
	"CommandSequence",
	commandSequenceSchema
);

// Payment sequence schema
const paymentSequenceSchema = new mongoose.Schema({
	yearMonth: { type: String, required: true, unique: true },
	currentNumber: { type: Number, default: 1 },
	lastUpdated: { type: Date, default: Date.now },
});
const PaymentSequence = mongoose.model(
	"PaymentSequence",
	paymentSequenceSchema
);
// Create a schema for storing message references
const OrderMessageSchema = new mongoose.Schema({
	orderId: { type: String, required: true, unique: true },
	messageTs: { type: String, required: true },
	channelId: { type: String, required: true },
	lastUpdated: { type: Date, default: Date.now },
	// Optional: Set an expiration based on your needs (e.g., 30 days)
	createdAt: { type: Date, default: Date.now, expires: "30d" },
});
const OrderMessage = mongoose.model("OrderMessage", OrderMessageSchema);

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

const transactionSchema = new mongoose.Schema({
	type: { type: String, required: true },
	amount: { type: Number, required: true },
	currency: { type: String, required: true },
	requestId: { type: String },
	orderId: { type: String },
	details: { type: String },
	timestamp: { type: Date, default: Date.now },
	paymentMethod: { type: String },
	paymentDetails: { type: mongoose.Schema.Types.Mixed },
});

const caisseSchema = new mongoose.Schema({
	balances: {
		XOF: { type: Number, default: 0 },
		USD: { type: Number, default: 0 },
		EUR: { type: Number, default: 0 },
	},
	latestRequestId: { type: String },
	fundingRequests: [fundingRequestSchema],
	transactions: [transactionSchema],
});

const Caisse = mongoose.model("Caisse", caisseSchema);

module.exports = {
	Order,
	FormData1,
	PaymentRequest,
	CommandSequence,
	PaymentSequence,
	OrderMessage,
	Caisse,
	Config,
	UserRole,
};
