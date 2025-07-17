const { notifyTechSlack } = require("../Common/notifyProblem");
const { Caisse } = require("../Database/dbModels/Caisse");
const { getGraphClient, getSiteId, getDriveId } = require("./Common.js/Excel");

async function syncCaisseToExcel(caisse, requestId) {
	console.log("** syncCaisseToExcel");
	if (process.env.NODE_ENV === "production") {
		console.log("Input requestId:", requestId);
		console.log("Input caisse.type:", caisse.type);

		const maxRetries = 3;
		for (let i = 0; i < maxRetries; i++) {
			try {
				const client = await getGraphClient();
				const siteId = await getSiteId();
				const driveId = await getDriveId(siteId);
				const fileId = process.env.CAISSE_EXCEL_FILE_ID;
				const tableName = process.env.CAISSE_TABLE_NAME;

				if (!tableName) {
					throw new Error(
						"Excel table name is not defined in environment variables."
					);
				}
				if (!requestId) {
					console.log("No requestId provided. Syncing caisse balances only.");
					const now = new Date();
					const year = now.getFullYear();
					const month = (now.getMonth() + 1).toString().padStart(2, "0");
					const existingRequests = caisse.fundingRequests.filter((req) =>
						req.requestId.startsWith(`FUND/${year}/${month}/`)
					);
					console.log("Existing requests for this month:", existingRequests);
					const sequence = existingRequests.length + 1;
					const sequenceStr = sequence.toString().padStart(4, "0");
					const requestId = `FUND/${year}/${month}/${sequenceStr}`;

					const rowData = [
						requestId, // Request ID
						caisse.type,
						0, // Amount
						"", // Currency
						"", // Reason
						"Nouvelle caisse", // Status
						"", // Rejection Reason
						new Date().toLocaleString("fr-FR", {
							weekday: "long",
							year: "numeric",
							month: "long",
							day: "numeric",
						}) || new Date().toISOString(), // Requested Date
						"", // Submitted By
						"", // Submitted At
						"", // Approved By
						"", // Approved At
						"", // Notes
						"", // Disbursement Type
						"",
						0, // Balance XOF
						0, // Balance USD
						0, // Balance EUR
						"", // Latest Update
					];
					// Fetch the table columns to validate the column count
					const tableColumns = await client
						.api(
							`/sites/${siteId}/drives/${driveId}/items/${fileId}/workbook/tables/${tableName}/columns`
						)
						.get();
					const columnCount = tableColumns.value.length;

					if (rowData.length !== columnCount) {
						throw new Error(
							`Column count mismatch: rowData has ${rowData.length} columns, but table expects ${columnCount}`
						);
					}

					console.log("Adding new row for caisse:", rowData);

					// Add a new row to the Excel table
					await client
						.api(
							`/sites/${siteId}/drives/${driveId}/items/${fileId}/workbook/tables/${tableName}/rows`
						)
						.post({ values: [rowData] });

					console.log("Row added successfully for new caisse.");
					return;
				}
				const request = caisse.fundingRequests.find(
					(r) => r.requestId === requestId
				);
				if (!request) {
					throw new Error(`Funding request ${requestId} not found`);
				}

				let paymentDetailsString = "";
				if (
					request.paymentDetails?.method === "cheque" &&
					request.paymentDetails.cheque
				) {
					const cheque = request.paymentDetails.cheque;
					paymentDetailsString = [
						cheque.number ? `Numéro: ${cheque.number}` : "",
						cheque.bank ? `Banque: ${cheque.bank}` : "",
						cheque.date ? `Date: ${cheque.date}` : "",
						cheque.order ? `Ordre: ${cheque.order}` : "",
					]
						.filter(Boolean)
						.join(", ");
				}

				console.log("Fetching existing rows...");
				const rows = await client
					.api(
						`/sites/${siteId}/drives/${driveId}/items/${fileId}/workbook/tables/${tableName}/rows`
					)
					.get();

				// DEBUG: Log all rows to see what's in the Excel file
				console.log("Total rows found:", rows.value.length);
				console.log("First 5 rows in Excel:");
				rows.value.slice(0, 5).forEach((row, index) => {
					console.log(`Row ${index}:`, {
						requestId: row.values[0][0],
						type: row.values[0][1],
						fullFirstColumns: row.values[0].slice(0, 5),
					});
				});

				// Enhanced row finding with debugging
				console.log("Searching for existing row...");
				const existingRowIndex = rows.value.findIndex((row, index) => {
					const rowRequestId = String(row.values[0][0]);
					const rowType = String(row.values[0][1]);
					const targetRequestId = String(requestId);
					const targetType = String(caisse.type);

					const requestIdMatch = rowRequestId === targetRequestId;
					const typeMatch = rowType === targetType;
					const isMatch = requestIdMatch && typeMatch;

					if (index < 3 || isMatch) {
						// Log first 3 rows or any matches
						console.log(`Row ${index} comparison:`, {
							rowRequestId,
							rowType,
							targetRequestId,
							targetType,
							requestIdMatch,
							typeMatch,
							isMatch,
						});
					}

					return isMatch;
				});

				// Find the row with "Yes" in the "Dernièrement modifié" column (excluding the current row if it exists)
				const previousYesRowIndex = rows.value.findIndex(
					(row, index) =>
						String(row.values[0][1]) === String(caisse.type) &&
						String(row.values[0][18]) === "Yes" &&
						index !== existingRowIndex // Exclude the current row
				);

				console.log(`Previous "Yes" row index: ${previousYesRowIndex}`);
				console.log(`Current row index: ${existingRowIndex}`);

				// Log the previous row details before updating
				if (previousYesRowIndex >= 0) {
					const previousRow = rows.value[previousYesRowIndex];
					console.log(`Previous row details:`, {
						requestId: previousRow.values[0][0],
						caisseType: previousRow.values[0][1],
						currentStatus: previousRow.values[0][18],
						rowIndex: previousYesRowIndex,
					});

					const previousRowValues = previousRow.values[0];
					previousRowValues[18] = ""; // Set to "No"

					console.log(
						`Updating previous "Yes" row at index ${previousYesRowIndex} to "No".`
					);
					console.log(`Row values after update:`, {
						requestId: previousRowValues[0],
						caisseType: previousRowValues[1],
						newStatus: previousRowValues[18],
					});

					await client
						.api(
							`/sites/${siteId}/drives/${driveId}/items/${fileId}/workbook/tables/${tableName}/rows/itemAt(index=${previousYesRowIndex})`
						)
						.patch({ values: [previousRowValues] });

					console.log(
						`Successfully updated row ${previousYesRowIndex} to "No"`
					);
				}

				const rowData = [
					request.requestId, // Request ID
					caisse.type,
					request.amount || 0, // Amount
					request.currency || "XOF", // Currency
					request.reason || "", // Reason
					request.status || "En attente", // Status
					request.rejectionReason || "", // Rejection Reason
					new Date(request.requestedDate).toLocaleString("fr-FR", {
						weekday: "long",
						year: "numeric",
						month: "long",
						day: "numeric",
					}) || new Date().toISOString(), // Requested Date
					request.submittedBy || "", // Submitted By
					request.submittedAt
						? new Date(request.submittedAt).toLocaleString("fr-FR", {
								weekday: "long",
								year: "numeric",
								month: "long",
								day: "numeric",
								hour: "2-digit",
								minute: "2-digit",
								timeZoneName: "short",
						  })
						: "", // Submitted At
					request.approvedBy || "", // Approved By
					request.approvedAt
						? new Date(request.approvedAt).toLocaleString("fr-FR", {
								weekday: "long",
								year: "numeric",
								month: "long",
								day: "numeric",
								hour: "2-digit",
								minute: "2-digit",
								timeZoneName: "short",
						  })
						: "", // Approved At
					request.paymentDetails.notes || "", // Notes
					request.disbursementType || "", // Disbursement Type
					paymentDetailsString || "", // Payment Details
					caisse.balances.XOF || 0, // Balance XOF
					caisse.balances.USD || 0, // Balance USD
					caisse.balances.EUR || 0, // Balance EUR
					"Yes", // Latest Update - this row is now the latest
				];

				console.log("Row data to be inserted/updated:", rowData);

				if (existingRowIndex >= 0) {
					console.log(
						`Updating existing row at index ${existingRowIndex} for requestId: ${requestId}`
					);
					await client
						.api(
							`/sites/${siteId}/drives/${driveId}/items/${fileId}/workbook/tables/${tableName}/rows/itemAt(index=${existingRowIndex})`
						)
						.patch({ values: [rowData] });
					console.log(`Successfully updated row ${existingRowIndex}`);
				} else {
					console.log(`Adding new row for requestId: ${requestId}`);
					await client
						.api(
							`/sites/${siteId}/drives/${driveId}/items/${fileId}/workbook/tables/${tableName}/rows`
						)
						.post({ values: [rowData] });
					console.log(`Successfully added new row`);
				}

				console.log("Row synced successfully.");
				return;
			} catch (error) {
				await notifyTechSlack(error);

				console.error("[Excel Integration] Error in syncCaisseToExcel:", {
					message: error.message,
					stack: error.stack,
					attempt: i + 1,
					requestId,
				});

				if (i === maxRetries - 1) {
					throw new Error(`Excel sync failed: ${error.message}`);
				}

				await new Promise((resolve) => setTimeout(resolve, 1000));
			}
		}
	} else {
		console.log(
			"[Excel Integration] Skipping Excel sync in non-production environment"
		);
		return true;
	}
}
async function generateCaisseReport(context, format = "csv") {
	console.log("** generateCaisseReport");
	const caisse = await Caisse.findOne();
	if (!caisse) throw new Error("Caisse non initialisée");

	const reportData = [
		[
			"Date",
			"Type",
			"Montant",
			"Devise",
			"Détails",
			"Solde XOF",
			"Solde USD",
			"Solde EUR",
		],
		...caisse.transactions.map((t) => [
			t.timestamp.toISOString(),
			t.type,
			t.amount,
			t.currency,
			t.details,
			caisse.balances.XOF,
			caisse.balances.USD,
			caisse.balances.EUR,
		]),
	];

	if (format === "csv") {
		const csv = reportData.map((row) => row.join(",")).join("\n");
		return Buffer.from(csv).toString("base64");
	} else {
		// Excel export
		await syncCaisseToExcel(caisse);

		return "Report synced to Excel";
	}
}
module.exports = {
	syncCaisseToExcel,
};
