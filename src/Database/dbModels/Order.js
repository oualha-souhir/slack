const mongoose = require("mongoose");
const { notifyTechSlack } = require("../../Common/notifyProblem");
const { syncOrderToExcel } = require("../../Excel/Order/Order");
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
				channel: { type: String },
				ts: { type: String }, // Slack timestamp serves as message ID
				messageType: { type: String, default: "notification" },
				createdAt: { type: Date, default: Date.now },
			},
		],
		// New fields for specific channel message references
		achatMessage: {
			ts: { type: String }, // Message timestamp
			createdAt: { type: Date, default: Date.now },
		},
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
		validatedAt: { type: Date, default: null }, // Date when the order was validated

		statut: {
			type: String,
			enum: ["En attente", "Validé", "Rejeté", "Supprimée"],
		},
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
				paymentNumber: { type: String, required: false }, // e.g., "PAY/2025/03/0001"
				decaissementNumber: { type: String, required: false }, // e.g., "DEC/2025/03/0001"
				paymentMode: { type: String, required: false }, // e.g., "Chèque", "Virement", etc.
				amountPaid: { type: Number, required: false },
				paymentTitle: { type: String, required: false }, // e.g., "Acompte 1"
				paymentProofs: [{ type: String }],
				paymentUrl: { type: String }, // External URL if provided
				details: { type: mongoose.Schema.Types.Mixed }, // Dynamic fields (e.g., cheque_number, virement_bank)
				dateSubmitted: { type: Date, default: Date.now },
				paymentStatus: { type: String },
				slackFinanceMessageTs: { type: String }, 
				slackAdminMessageTs: { type: String }, // New field for admin message timestamp
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
		await notifyTechSlack(error);

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
		await notifyTechSlack(error);

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
		await notifyTechSlack(error);

		console.error(
			`[Excel Integration] Error in post-findOneAndUpdate Excel sync: ${error}`
		);
	}
});
const Order = mongoose.model("Order", OrderSchema);

module.exports = { Order };
