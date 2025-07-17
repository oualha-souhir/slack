const mongoose = require("mongoose");
const {
	syncPaymentRequestToExcel,
} = require("../../Excel/PaymentRequest/PaymentRequest");
const { notifyTechSlack } = require("../../Common/notifyProblem");

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
			"Supprimée",
		],
		default: "En attente",
	},
	payment_reminder_sent: { type: Boolean, default: false },
	proforma_reminder_sent: { type: Boolean, default: false },
	admin_reminder_sent: {
		type: Boolean,
		default: false,
	},
	updatedAt: Date,
	demandeur_message: { channel: String, ts: String }, // Added for demandeur message
	admin_message: { channel: String, ts: String }, // Added for admin message

	amountPaid: Number,
	remainingAmount: Number,
	rejectedByName: { type: String, default: null },
	rejectedById: { type: String, default: null },
	rejection_reason: { type: String, default: null },
	validatedBy: { type: String, default: "" }, // User ID of the person who validated the payment request
	validatedAt: { type: Date, default: null }, // Date when the payment request was validated
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
			slackFinanceMessageTs: { type: String },
			slackAdminMessageTs: { type: String }, // New field for admin message timestamp
		},
	],
	paymentDone: { type: String, default: "false" },
	financeMessage: {
		ts: { type: String }, // Message timestamp
		createdAt: { type: Date, default: Date.now },
	},
	financeMessageTransfer: {
		ts: { type: String }, // Message timestamp
		createdAt: { type: Date, default: Date.now },
		channel: { type: String, default: "" }, // Channel ID for transfer messages
	},
	adminMessage: {
		ts: { type: String }, // Message timestamp
		createdAt: { type: Date, default: Date.now },
	},
	devise: {
		type: String,
		required: false,
	},
	createdAt: { type: Date, default: Date.now },
	updatedAt: { type: Date, default: Date.now },
});
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
		await notifyTechSlack(error);

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
		await notifyTechSlack(error);

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
		await notifyTechSlack(error);

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
		await notifyTechSlack(error);

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
		await notifyTechSlack(error);

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
		await notifyTechSlack(error);

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
		await notifyTechSlack(error);

		console.error(
			`[Excel Integration] Error in post-updateOne Excel sync for payment request: ${error}`
		);
	}
});
module.exports = mongoose.model("PaymentRequest", PaymentRequestSchema);
