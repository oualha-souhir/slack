require("dotenv").config();

const {
	getGraphClient,
	getSiteId,
	getDriveId,
	updateRowInExcel,
	addRowToExcel,
	findRowIndex,
} = require("../Common.js/Excel");
require("isomorphic-fetch");

async function syncOrderToExcel(order) {
	if (process.env.NODE_ENV === "production") {
		try {
			console.log("** syncOrderToExcel");

			console.log(
				"Starting Excel sync for order:",
				order?.id_commande || "unknown"
			);

			// Validate order object
			if (!order || !order.id_commande) {
				console.error("[Excel Integration] Invalid order object:", order);
				return false;
			}

			// Check for recent sync to prevent duplicates
			if (
				order.lastExcelSync &&
				new Date() - new Date(order.lastExcelSync) < 30 * 1000
			) {
				console.log(
					`[Excel Integration] Skipping sync for recently synced order: ${order.id_commande}, last synced at: ${order.lastExcelSync}`
				);
				return true;
			}
			const { Order } = require("../../Database/dbModels/Order");

			// Fetch the latest order data
			let entity = await Order.findOne({ id_commande: order.id_commande });
			if (!entity) {
				console.error(
					`[Excel Integration] Order not found in database: ${order.id_commande}`
				);
				return false;
			}

			const siteId = await getSiteId();
			const driveId = await getDriveId(siteId);
			const fileId = "6AD4369C-C1C5-46E3-873B-AECC71234DDF";
			const tableName = process.env.EXCEL_TABLE_NAME || "";

			// Get latest validated proforma
			const validatedProforma =
				entity.proformas?.find((p) => p.validated) || null;

			// Calculate payment amounts
			const totalAmount = validatedProforma?.montant || 0; // Use montant_total
			const totalAmountPaid =
				entity.payments?.reduce(
					(sum, payment) => sum + (payment.amountPaid || 0),
					0
				) || 0; // Sum of all payments
			const lastPaymentAmount = entity.payments?.length
				? entity.payments[entity.payments.length - 1].amountPaid || 0
				: 0; // Last payment amount
			const remainingAmount = totalAmount - totalAmountPaid;

			console.log("totalAmount:", totalAmount);
			console.log("lastPaymentAmount:", lastPaymentAmount);
			console.log("totalAmountPaid:", totalAmountPaid);
			console.log("remainingAmount:", remainingAmount);
			console.log("entity.paymentDone:", entity.paymentDone);
			// Handle payment status
			let paymentStatus = "Non payé";
			if (totalAmount === 0) {
				paymentStatus = "Non Payé";
			} else if (
				entity.paymentDone == "true" ||
				totalAmountPaid >= totalAmount
			) {
				paymentStatus = "Payé";
				console.log("Set to Payé");
			} else if (totalAmountPaid > 0 && totalAmountPaid < totalAmount) {
				paymentStatus = "Partiellement payé";
				console.log("Set to Partiellement payé");
			}
			console.log("Final paymentStatus:", paymentStatus);
			console.log("entity.paymentDone:", entity.paymentDone);

			console.log(
				"Condition (entity.paymentDone || totalAmountPaid >= totalAmount):",
				entity.paymentDone || totalAmountPaid >= totalAmount
			);
			console.log("typeof totalAmount:", typeof totalAmount);
			console.log("typeof totalAmountPaid:", typeof totalAmountPaid);
			console.log("paymentStatus:", paymentStatus);
			// Format dates safely
			const formatDate = (date) => {
				if (!date || isNaN(new Date(date).getTime())) return "";
				return new Date(date).toISOString().split("T")[0];
			};

			const orderDate = formatDate(entity.date);
			const lastPaymentDate = entity.payments?.length
				? formatDate(
						[...entity.payments].sort(
							(a, b) => new Date(b.dateSubmitted) - new Date(a.dateSubmitted)
						)[0].dateSubmitted
				  )
				: "";
			const validatedAt = validatedProforma
				? formatDate(validatedProforma.validatedAt)
				: "";

			// Format article information
			let articleDesignation = entity.articles?.length
				? entity.articles
						.map((a) => `${a.quantity} ${a.unit || ""} ${a.designation}`)
						.join("; ")
				: "";
			// Prepare article data with photos
			const articlesWithPhotos = order.articles.map((article, index) => {
				const articleNumber = index + 1;
				let photoLinks = "";

				if (article.photos && article.photos.length > 0) {
					photoLinks = article.photos
						.map(
							(photo, photoIndex) =>
								`- Photo ${photoIndex + 1}: ${photo.permalink || photo.url}`
						)
						.join(" | ");
				}

				return {
					articleNumber,
					designation: article.designation || "Article sans nom",
					quantity: article.quantity || 1,
					unit: article.unit || "unité(s)",
					reference: article.reference || "",
					brand: article.brand || "",
					category: article.category || "",
					description: article.description || "",
					price: article.price || "",
					currency: article.currency || "XOF",
					supplier: article.supplier || "",
					photoLinks: photoLinks,
					photoCount: article.photos ? article.photos.length : 0,
				};
			});
			// Create a comprehensive articles string with photos
			const articlesString = articlesWithPhotos
				.map((article) => {
					let articleText = `${article.articleNumber}. ${article.designation} ${article.quantity} ${article.unit} `;

					if (article.photoCount > 0) {
						articleText += `\n  • Photos (${article.photoCount}): ${article.photoLinks}`;
					}

					return articleText;
				})
				.join("\n\n---\n\n");

			// Format payment information
			let paymentModes = "";
			let paymentDetails = "";
			let paymentUrl = "";
			if (entity.payments?.length) {
				paymentModes = entity.payments
					.map((payment) => payment.paymentMode || "")
					.filter((mode) => mode)
					.join("\n");

				paymentDetails = entity.payments
					.map((payment) => {
						const title = payment.paymentTitle || "";
						const amount = payment.amountPaid ? `${payment.amountPaid}` : "";
						const date = payment.dateSubmitted
							? `(${formatDate(payment.dateSubmitted)})`
							: "";
						const details = payment.details
							? Object.entries(payment.details)
									.map(([key, value]) => `${key}: ${value}`)
									.join(" | ")
							: "";
						const proofs = payment.paymentProofs?.length
							? `\n   📎 Proof: ${payment.paymentProofs.join("\n   📎 ")}`
							: "";
						const url = payment.paymentUrl
							? `\n   🔗 ${payment.paymentUrl}`
							: "";
						const detailsLine = details ? `\n   Details: ${details}` : "";
						return `• ${title}: ${amount} ${date}${detailsLine}${proofs}${url}`;
					})
					.join("\n\n");
				paymentUrl = entity.payments
					.map((payment) => payment.paymentUrl)
					.filter((url) => url)
					.join("\n");
			}

			let status =
				entity.autorisation_admin === "Oui" ? "Valide" : "Non Valide";

			// Construct row data
			const rowData = [
				entity.id_commande || "",
				entity.titre || "",
				entity.statut || "En attente",
				entity.demandeur || "",
				entity.channel || "",
				entity.equipe || "Non spécifié",
				new Date(entity.date).toLocaleString("fr-FR", {
					weekday: "long",
					year: "numeric",
					month: "long",
					day: "numeric",
					hour: "2-digit",
					minute: "2-digit",
					timeZoneName: "short",
				}),
				new Date(entity.date_requete).toLocaleString("fr-FR", {
					weekday: "long",
					year: "numeric",
					month: "long",
					day: "numeric",
				}) || "",

				// entity.autorisation_admin ? "Oui" : "Non",

				articlesString,

				totalAmount.toString(),
				totalAmountPaid.toString(),
				lastPaymentAmount.toString(),
				remainingAmount.toString(),

				// validatedProforma?.devise || "USD", // Use USD based on logs
				paymentStatus,
				// validatedProforma ? "Oui" : "Non",
				// validatedProforma?.fournisseur || "",
				// validatedProforma?.urls?.join("\n\n") || "",

				validatedProforma
					? `${validatedProforma.nom}: ${validatedProforma.montant} ${
							validatedProforma.devise
					  } ${validatedProforma.urls?.join("\n\n") || ""}`
					: "",
				entity.validatedBy || "",
				validatedAt,

				// paymentModes,
				// paymentDetails,
				// lastPaymentDate,

				entity.payments
					? entity.payments
							.map((payment) => {
								const title = payment.paymentTitle || "";
								const amount = payment.amountPaid
									? `${payment.amountPaid}`
									: "";
								const date = payment.dateSubmitted
									? `${formatDate(payment.dateSubmitted)}`
									: "";
								const paymentModes = payment.paymentMode || "";
								const details = payment.details
									? Object.entries(payment.details)
											.map(([key, value]) => `${key}: ${value}`)
											.join(" | ")
									: "";
								const proofs = payment.paymentProofs?.length
									? `\n   📎 Proof: ${payment.paymentProofs.join("\n   📎 ")}`
									: "";
								const url = payment.paymentUrl
									? `\n   🔗 ${payment.paymentUrl}`
									: "";
								const detailsLine = details ? `\n   Details: ${details}` : "";
								return `• ${title}: ${amount} ${date} ${paymentModes} ${detailsLine}${proofs}${url}`;
							})
							.join("\n\n")
					: "",
				entity.deleted ? "Oui" : "Non",
				formatDate(entity.deletedAt),
				entity.deletedByName || "",
				entity.rejection_reason || entity.deletionReason || "",
			];

			const rowIndex = await findRowIndex(
				siteId,
				driveId,
				fileId,
				tableName,
				entity.id_commande
			);

			if (rowIndex !== null) {
				const client = await getGraphClient();
				const rows = await client
					.api(
						`/sites/${siteId}/drives/${driveId}/items/${fileId}/workbook/tables('${tableName}')/rows`
					)
					.get();
				const currentRow = rows.value[rowIndex];
				if (JSON.stringify(currentRow.values[0]) === JSON.stringify(rowData)) {
					console.log(
						`[Excel Integration] Skipping update for unchanged row: ${entity.id_commande}`
					);
					return true;
				}
				await updateRowInExcel(
					siteId,
					driveId,
					fileId,
					tableName,
					rowIndex,
					rowData
				);
			} else {
				await addRowToExcel(siteId, driveId, fileId, tableName, rowData);
			}

			// Update lastExcelSync timestamp
			await Order.updateOne(
				{ id_commande: entity.id_commande },
				{ lastExcelSync: new Date() }
			);

			console.log("Excel sync completed for order:", entity.id_commande);
			return true;
		} catch (error) {
			console.error(
				`Failed to sync order to Excel: ${error.message}`,
				error.stack
			);
			return false;
		}
	} else {
		console.log(
			"[Excel Integration] Skipping Excel sync in non-production environment"
		);
		return true;
	}
}

module.exports = {
	syncOrderToExcel,
};
