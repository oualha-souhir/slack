const { OpenAI } = require("openai");
const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
});
const {
	createSlackResponse,
	postSlackMessageWithRetry,
} = require("../Common/slackUtils");
const ExcelJS = require("exceljs");
const axios = require("axios");
const querystring = require("querystring");
const PaymentSequence = require("../Database/dbModels/PaymentSequence");
const PaymentRequest = require("../Database/dbModels/PaymentRequest");
const { notifyTechSlack } = require("../Common/notifyProblem");
const { notifyPaymentRequest } = require("./Handlers/paymentRequestNotification");

async function createAndSavePaymentRequest(
	demandeurId,
	userName,
	channelId,
	channelName,
	formData,
	context
) {
	console.log("** createAndSavePaymentRequest");
	console.log("formData", userName);
	console.log("formData", formData);
	console.log("formData", formData);

	// Get the selected date string from the form data
	let requestDate;
	if (formData.request_date?.input_request_date?.selected_date) {
		const dateStr = formData.request_date.input_request_date.selected_date;
		requestDate = new Date(dateStr);
	} else {
		requestDate = new Date();
	}

	// Parse amount and currency from the amount field
	const amountInput = formData.amount_to_pay.input_amount_to_pay.value;
	const amountMatch = amountInput.match(/(\d+(?:\.\d+)?)\s*([A-Z]{3})/);

	if (!amountMatch) {
		throw new Error("Invalid amount format");
	}

	const amount = parseFloat(amountMatch[1]);
	const currency = amountMatch[2];

	if (!["XOF", "EUR", "USD"].includes(currency)) {
		throw new Error("Invalid currency");
	}

	// Validate date is not in the past
	if (requestDate < new Date().setHours(0, 0, 0, 0)) {
		throw new Error("Request date cannot be in the past");
	}

	// Generate payment ID
	const paymentId = await generatePaymentRequestId();

	const paymentData = {
		id_paiement: paymentId,
		project: channelName,
		id_projet: channelId,
		titre: formData.request_title?.input_request_title?.value,
		demandeur: userName,
		demandeurId: demandeurId,

		date_requete: requestDate,
		motif: formData.payment_reason?.input_payment_reason?.value,
		montant: amount,
		bon_de_commande: formData.po_number?.input_po_number?.value || null,
		justificatif: [], // No justificatifs from text parsing
		devise: currency,
		status: "En attente",
	};

	const paymentRequest = new PaymentRequest(paymentData);
	const savedPaymentRequest = await paymentRequest.save();
	return savedPaymentRequest;
}
async function generatePaymentRequestId() {
	console.log("** generatePaymentRequestId");
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const yearMonth = `${year}-${month}`;

	const seq = await PaymentSequence.findOneAndUpdate(
		{ yearMonth },
		{ $inc: { currentNumber: 1 } },
		{ new: true, upsert: true, returnDocument: "after" }
	);

	return `PAY/${year}/${month}/${String(seq.currentNumber).padStart(4, "0")}`;
}
async function parsePaymentFromText(text, context) {
	console.log("** parsePaymentFromText");
	try {
		const prompt = `
Parse the following text into a structured payment request object with these fields:
{
  "titre": "string",
  "date_requise": "string, in YYYY-MM-DD format",
  "motif": "string, reason for payment",
  "montant": "number, payment amount",
  "devise": "string, currency code (XOF, EUR, USD)",
  "bon_de_commande": "string, optional achat order number"
}

The input uses labels like "titre:", "date requise:", "motif:", "montant:", "devise:", "bon de commande:" followed by values. 
Extract only these fields and return a valid JSON string. If a field is missing, use reasonable defaults:
- devise defaults to 'XOF' if not specified
- date_requise defaults to today if not specified
- If montant includes currency (like "1000 XOF"), separate the amount and currency

Input text:
"${text}"
`;

		const timeoutPromise = new Promise((_, reject) =>
			setTimeout(() => reject(new Error("Request timed out")), 15000)
		);

		const openaiPromise = openai.chat.completions.create({
			model: "gpt-3.5-turbo",
			messages: [{ role: "user", content: prompt }],
			max_tokens: 300,
			temperature: 0.5,
		});

		const response = await Promise.race([openaiPromise, timeoutPromise]);
		const rawContent = response.choices[0].message.content.trim();
		context.log(`Raw OpenAI response: ${rawContent}`);

		let result;
		try {
			result = JSON.parse(rawContent);
		} catch (parseError) {
			await notifyTechSlack(parseError);

			context.log(
				`Failed to parse OpenAI response as JSON: ${parseError.message}`
			);
			throw new Error(`Invalid JSON from OpenAI: ${rawContent}`);
		}

		// Validate currency
		if (result.devise && !["XOF", "EUR", "USD"].includes(result.devise)) {
			result.devise = "XOF"; // Default to XOF if invalid currency
		}

		// Validate amount
		if (result.montant && (isNaN(result.montant) || result.montant <= 0)) {
			throw new Error("Invalid payment amount detected");
		}

		context.log("Parsed payment from AI:", JSON.stringify(result));
		return result;
	} catch (error) {
		await notifyTechSlack(error);

		context.log(`Error parsing payment with OpenAI: ${error.message}`);
		throw error;
	}
}
async function handlePaymentWelcomeMessage(userId) {
	return createSlackResponse(200, {
		response_type: "ephemeral",
		blocks: [
			{
				type: "header",
				text: {
					type: "plain_text",
					text: "👋 Bienvenue",
					emoji: true,
				},
			},
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `Bonjour <@${userId}> ! Voici comment passer une nouvelle demande de paiement :`,
				},
			},
			{
				type: "divider",
			},
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "*Option 1:* Créez une demande de paiement rapide avec la syntaxe suivante :",
				},
			},
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "```\n/payment titre: [Titre de la demande] date requise: yyyy-mm-dd motif: [Raison du paiement] montant: [Montant] [Devise] bon de commande: [Numéro de bon, optionnel]\n```",
				},
			},
			{
				type: "context",
				elements: [
					{
						type: "mrkdwn",
						text: "💡 *Exemple:* `/payment titre: Achat de matériel informatique date requise: 2025-12-12 motif: Remplacement ordinateurs défaillants montant: 50000 XOF bon de commande: PO-2025-001A`",
					},
				],
			},
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "*Option 2:* Utilisez le formulaire ci-dessous",
				},
			},
		],
		// Fallback for older Slack clients that don't support blocks
		text: `👋 Bonjour <@${userId}> ! Pour passer une demande, vous pouvez utiliser le formulaire ci-dessous.`,
		attachments: [
			{
				callback_id: "finance_payment_form",
				actions: [
					{
						name: "finance_payment_form",
						type: "button",
						text: "💰 Demande de paiement",
						value: "open",
						action_id: "finance_payment_form",
						style: "primary",
					},
				],
			},
		],
	});
}

// Function to generate a payment report based on payment ID, project, or date
async function exportPaymentReport(
	context,
	reportType,
	value,
	userId,
	channelId
) {
	try {
		console.log(
			`Generating payment report: type=${reportType}, value=${value}, userId=${userId}`
		);

		let reportData = [];
		let reportTitle = "";
		let worksheetName = "";

		// Query based on report type
		switch (reportType.toLowerCase()) {
			case "payment":
				reportTitle = `Payment Report - ${value}`;
				worksheetName = `Payment`;
				const payment = await PaymentRequest.findOne({
					id_paiement: value,
				}).lean();
				if (!payment) {
					throw new Error(`Payment ${value} not found or is deleted`);
				}
				reportData = [payment];
				break;

			case "channel":
				reportTitle = `Project Payment Report`;
				worksheetName = `Project_${value}`;
				const match = value.match(/<#\w+\|([^>]+)>|#?(\w[\w-]*)/);
				value = match ? match[1] || match[2] : value;
				console.log("value", value);
				reportData = await PaymentRequest.find({ id_projet: value })
					.sort({ date: -1 })
					.lean();
				if (reportData.length === 0) {
					throw new Error(`No payments found for project ${value}`);
				}
				break;

			case "date":
				reportTitle = `Daily Payment Report - ${value}`;
				worksheetName = `PaymentDate_${value}`;
				const startDate = new Date(value);
				console.log("aaaa");

				console.log(startDate);
				const endDate = new Date(startDate);
				console.log(endDate);
				endDate.setDate(endDate.getDate() + 1);
				reportData = await PaymentRequest.find({
					date: { $gte: startDate, $lt: endDate },
				})
					.sort({ date: -1 })
					.lean();
				console.log(reportData);

				if (reportData.length === 0) {
					throw new Error(`No payments found for date ${value}`);
				}
				break;

			case "status":
				reportTitle = `Payment Status Report - ${value}`;
				worksheetName = `Status_${value}`;
				reportData = await PaymentRequest.find({ statut: value })
					.sort({ date: -1 })
					.lean();
				if (reportData.length === 0) {
					throw new Error(`No payments found with status ${value}`);
				}
				break;
			case "user":
				reportTitle = `User Orders Report - ${value}`;
				worksheetName = `User_${value}`;
				// If value looks like a Slack mention or username, resolve to user ID
				if (value.startsWith("@")) {
					const username = value.replace(/^@/, "").trim();
					try {
						const usersResp = await axios.get(
							"https://slack.com/api/users.list",
							{
								headers: {
									Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
								},
							}
						);
						if (usersResp.data.ok) {
							const userObj = usersResp.data.members.find(
								(u) =>
									u.name === username ||
									(u.profile && u.profile.display_name === username) ||
									(u.profile && u.profile.real_name === username)
							);
							if (userObj) {
								value = userObj.id; // Use Slack user ID for the query
							}
						}
					} catch (err) {
						await notifyTechSlack(err);

						context.log(`Failed to resolve Slack user: ${err.message}`);
					}
				}
				reportData = await PaymentRequest.find({ demandeurId: value })
					.sort({ date: -1 })
					.lean();
				if (reportData.length === 0) {
					throw new Error(`No payments found for user ${value}`);
				}

				break;

			default:
				throw new Error(
					'Invalid report type. Use "payment", "project", "date", "status", or "user".'
				);
		}

		context.log(`Retrieved ${reportData.length} payment records for report`);

		// Create Excel workbook
		const workbook = new ExcelJS.Workbook();
		const worksheet = workbook.addWorksheet(worksheetName);

		// Define columns for payment request data
		worksheet.columns = [
			{ header: "Payment ID", key: "id_paiement", width: 20 },
			{ header: "Title", key: "titre", width: 30 },
			{ header: "Status", key: "statut", width: 20 },
			{ header: "Requester", key: "demandeur", width: 20 },
			{ header: "Project/Channel", key: "project", width: 20 },
			{ header: "Request Date", key: "date", width: 30 },
			{ header: "Required Date", key: "date_requete", width: 30 },
			{ header: "Reason/Motif", key: "motif", width: 40 },
			{ header: "Reference", key: "bon_de_commande", width: 20 },
			{ header: "Justifications", key: "justificatifs", width: 50 },
			{ header: "Total Amount", key: "totalAmount", width: 15 },
			{ header: "Amount Paid", key: "amountPaid", width: 15 },
			{ header: "Last Payment Amount", key: "lastPaymentAmount", width: 15 },
			{ header: "Remaining Amount", key: "remainingAmount", width: 15 },
			{ header: "Payment Details", key: "paymentDetails", width: 60 }, // Includes Payment Modes, Currency, Last Payment Date
			{ header: "Rejection Reason", key: "rejection_reason", width: 30 },
		];

		// Enable text wrapping for all columns
		worksheet.columns.forEach((column) => {
			column.alignment = { wrapText: true, vertical: "top" };
		});

		// Format data for Excel
		for (const payment of reportData) {
			// Calculate payment amounts
			const totalAmount = payment.montant || 0;
			const totalAmountPaid = payment.amountPaid || 0;
			const remainingAmount =
				payment.remainingAmount || totalAmount - totalAmountPaid;
			const lastAmountPaid = payment.payments?.length
				? payment.payments[payment.payments.length - 1].amountPaid || 0
				: 0;

			// Get channel name for project
			let channelName = "";
			if (payment.project) {
				try {
					const result = await axios.post(
						"https://slack.com/api/conversations.info",
						querystring.stringify({ channel: payment.project }),
						{
							headers: {
								Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
								"Content-Type": "application/x-www-form-urlencoded",
							},
						}
					);
					if (result.data.ok) {
						channelName = result.data.channel.name;
					} else {
						context.log(`Failed to get channel info: ${result.data.error}`);
					}
				} catch (error) {
					await notifyTechSlack(error);

					context.log(`Failed to get channel name: ${error.message}`);
				}
			}
			console.log("channelName", channelName);
			console.log("payment.project", payment.project);

			// Get requester name
			let demandeur = "";
			if (payment.demandeurId) {
				try {
					const result = await axios.post(
						"https://slack.com/api/users.info",
						querystring.stringify({ user: payment.demandeurId }),
						{
							headers: {
								Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
								"Content-Type": "application/x-www-form-urlencoded",
							},
						}
					);
					if (result.data.ok) {
						demandeur =
							result.data.user.name || result.data.user.real_name || "";
					}
				} catch (error) {
					await notifyTechSlack(error);

					context.log(`Failed to get demandeur user name: ${error.message}`);
				}
			}

			// Format payment modes
			let paymentModes = "";
			if (payment.payments?.length) {
				paymentModes = payment.payments
					.map((p) => p.paymentMode || "")
					.filter((mode) => mode)
					.join("\n");
			}
			// Format dates safely
			const formatDate = (date) => {
				if (!date || isNaN(new Date(date).getTime())) return "";
				return new Date(date).toISOString().split("T")[0];
			};
			let paymentDetails = "";
			if (payment.payments?.length) {
				paymentDetails = payment.payments
					.map((p) => {
						const title = p.paymentTitle || "";
						const amount = p.amountPaid ? `${p.amountPaid}` : "";
						const date = p.dateSubmitted
							? `(${formatDate(p.dateSubmitted)})`
							: "";
						const mode = p.paymentMode ? `Mode: ${p.paymentMode}` : "";
						const currency = payment.devise || "XOF";
						const details = p.details
							? Object.entries(p.details)
									.map(([key, value]) => `${key}: ${value}`)
									.join(" | ")
							: "";
						const proofs = p.paymentProofs?.length
							? `\n   📎 Proof: ${p.paymentProofs.join("\n   📎 ")}`
							: "";
						const url = p.paymentUrl ? `\n   🔗 ${p.paymentUrl}` : "";
						const detailsLine = details ? `\n   Details: ${details}` : "";
						return `• ${title}: ${amount} ${currency} ${date}\n   ${mode}${detailsLine}${proofs}${url}`;
					})
					.join("\n\n");
			}

			// Format justifications
			let justificatifs = payment.justificatif?.length
				? payment.justificatif.map((doc) => `📄 ${doc.url}`).join("\n")
				: "";

			// Get last payment date
			const lastPaymentDate = payment.payments?.length
				? formatDate(
						[...payment.payments].sort(
							(a, b) => new Date(b.dateSubmitted) - new Date(a.dateSubmitted)
						)[0].dateSubmitted
				  )
				: "";

			const row = {
				id_paiement: payment.id_paiement || "",
				titre: payment.titre || "",
				statut: payment.statut || "En attente",
				demandeur: payment.demandeur || "",
				project: payment.project || "",
				date: new Date(payment.date).toLocaleString("fr-FR", {
					weekday: "long",
					year: "numeric",
					month: "long",
					day: "numeric",
					hour: "2-digit",
					minute: "2-digit",
					timeZoneName: "short",
				}),
				date_requete: payment.date_requete
					? new Date(payment.date_requete).toLocaleString("fr-FR", {
							weekday: "long",
							year: "numeric",
							month: "long",
							day: "numeric",
					  })
					: "",
				motif: payment.motif || "",
				bon_de_commande: payment.bon_de_commande || "",
				justificatifs: justificatifs,
				totalAmount: totalAmount.toString(),
				amountPaid: totalAmountPaid.toString(),
				lastPaymentAmount: lastAmountPaid.toString(),
				remainingAmount: remainingAmount.toString(),
				paymentDetails: paymentDetails, // Includes payment modes, currency, and last payment date
			};
			worksheet.addRow(row);
		}

		// Style the header
		worksheet.getRow(1).font = { bold: true };
		worksheet.getRow(1).fill = {
			type: "pattern",
			pattern: "solid",
			fgColor: { argb: "FFB6E5B6" }, // Light green color to differentiate from order reports
		};

		// Enable text wrapping for all rows
		worksheet.eachRow((row) => {
			row.eachCell((cell) => {
				cell.alignment = { wrapText: true, vertical: "top" };
			});
		});

		// Save the workbook to a buffer
		const buffer = await workbook.xlsx.writeBuffer();
		const fileName = `${worksheetName}_${Date.now()}.xlsx`;
		context.log(
			`Excel file generated: ${fileName}, size: ${buffer.length} bytes`
		);

		// Use the provided channel ID directly
		if (!channelId) {
			throw new Error("No channel ID provided for file upload");
		}
		context.log(`Using channel for upload: ${channelId}`);

		// Step 1: Get upload URL from Slack
		const uploadUrlResponse = await axios.post(
			"https://slack.com/api/files.getUploadURLExternal",
			{
				filename: fileName,
				length: buffer.length.toString(),
				content_type:
					"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			},
			{
				headers: {
					Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
					"Content-Type": "application/x-www-form-urlencoded",
				},
			}
		);

		if (!uploadUrlResponse.data.ok) {
			context.log(
				`Failed to get upload URL: ${JSON.stringify(uploadUrlResponse.data)}`
			);
			throw new Error(
				`Failed to get upload URL: ${uploadUrlResponse.data.error}`
			);
		}

		const { upload_url, file_id } = uploadUrlResponse.data;
		context.log(`Upload URL obtained: ${upload_url}, file_id: ${file_id}`);

		// Step 2: Upload the file to the provided URL
		const FormData = require("form-data");
		const form = new FormData();
		form.append("file", buffer, {
			filename: fileName,
			contentType:
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		});
		const uploadResponse = await axios.post(upload_url, form, {
			headers: {
				...form.getHeaders(),
			},
		});

		if (uploadResponse.status !== 200) {
			context.log(
				`Upload failed: status=${
					uploadResponse.status
				}, response=${JSON.stringify(uploadResponse.data)}`
			);
			throw new Error(
				`Failed to upload file to Slack URL: ${uploadResponse.statusText}`
			);
		}
		context.log(`File uploaded to Slack URL successfully`);

		// Step 4: Complete the upload
		const truncatedTitle = reportTitle.substring(0, 250); // Ensure title is within 255 chars
		const completeResponse = await axios.post(
			"https://slack.com/api/files.completeUploadExternal",
			{
				files: [
					{
						id: file_id,
						title: truncatedTitle,
					},
				],
				channel_id: process.env.SLACK_ADMIN_ID,
				initial_comment: `Here is your ${truncatedTitle}`,
			},
			{
				headers: {
					Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
					"Content-Type": "application/json",
				},
			}
		);

		if (!completeResponse.data.ok) {
			context.log(
				`Failed to complete upload: ${JSON.stringify(completeResponse.data)}`
			);
			throw new Error(
				`Failed to complete file upload: ${completeResponse.data.error}`
			);
		}

		context.log(
			`Payment report ${reportTitle} generated and uploaded successfully for user ${userId} in channel ${channelId}`
		);
		return {
			success: true,
			message: `Payment report ${reportTitle} sent to user`,
		};
	} catch (error) {
		await notifyTechSlack(error);

		context.log(
			`Error generating payment report: ${error.message}, stack: ${error.stack}`
		);
		throw error;
	}
}
async function handlePaymentReportCommand(
	text,
	userId,
	channelId,
	isUserAdmin,
	context
) {
	if (!isUserAdmin) {
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: userId,
				user: userId,
				text: "🚫 Seuls les administrateurs peuvent générer des rapports.",
			},
			process.env.SLACK_BOT_TOKEN
		);
		return { status: 200, body: "" };
	}

	setImmediate(async () => {
		const args = text.trim().split(" ").slice(1); // Remove "report" from args
		if (args.length < 2) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: userId,
					user: userId,
					text: "❌ Usage: /payment report [payment|project|date|status|user] [value]\nExemples:\n• /payment report payment PAY/2025/03/0001\n• /payment report project general\n• /payment report date 2025-03-01\n• /payment report status 'En attente'\n• /payment report user U1234567890",
				},
				process.env.SLACK_BOT_TOKEN
			);
			return { status: 200, body: "" };
		}

		const [reportType, ...valueParts] = args;
		const value = valueParts.join(" ");

		try {
			console.log("dddd");
			await exportPaymentReport(context, reportType, value, userId, channelId);
			return { status: 200, body: "" };
		} catch (error) {
			await notifyTechSlack(error);

			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: userId,
					user: userId,
					text: `❌ Erreur lors de la génération du rapport de paiement : ${error.message}`,
				},
				process.env.SLACK_BOT_TOKEN
			);
			return { status: 200, body: "" };
		}
	});
	return createSlackResponse(200, {
		response_type: "ephemeral",
		text: "⌛ Génération du rapport en cours... Vous recevrez le fichier Excel dans quelques instants.",
	});
}

async function handlePaymentTextParsing(
	text,
	params,
	userId,
	userName,
	context,
	logger
) {
	context.log(`Received payment text: "${text}"`);
	context.log("Starting AI payment parsing...");

	setImmediate(async () => {
		try {
			const parsedPayment = await parsePaymentFromText(text, logger);
			logger.log(`Parsed payment: ${JSON.stringify(parsedPayment)}`);

			if (parsedPayment.montant && parsedPayment.montant > 0) {
				const channelId = params.get("channel_id");
				const channelName = params.get("channel_name");
				logger.log(`Channel name resolved: ${channelId}`);
				console.log("params.get", params.get("user_id"));
				const requestedDate = new Date(parsedPayment.date_requise);
				const currentDate = new Date();

				if (requestedDate < currentDate) {
					logger.log("Invalid refund request - requested date is in the past.");
					await notifyUserAI(
						{ id: "N/A" },
						channelId,
						logger,
						"⚠️ *Erreur*: La date sélectionnée est dans le passé."
					);
					return createSlackResponse(200, {
						response_type: "ephemeral",
						text: "❌ Erreur : La date requise ne peut pas être dans le passé.",
					});
				}
				const newPaymentRequest = await createAndSavePaymentRequest(
					userId,
					userName,
					channelId,
					channelName,
					{
						request_title: {
							input_request_title: {
								value: parsedPayment.titre || "Demande de paiement sans titre",
							},
						},
						request_date: {
							input_request_date: {
								selected_date:
									parsedPayment.date_requise ||
									new Date().toISOString().split("T")[0],
							},
						},
						payment_reason: {
							input_payment_reason: {
								value: parsedPayment.motif || "Motif non spécifié",
							},
						},
						amount_to_pay: {
							input_amount_to_pay: {
								value: `${parsedPayment.montant} ${
									parsedPayment.devise || "XOF"
								}`,
							},
						},
						po_number: {
							input_po_number: {
								value: parsedPayment.bon_de_commande || null,
							},
						},
					},
					logger
				);

				logger.log(
					`Payment request created: ${JSON.stringify(newPaymentRequest)}`
				);

				await Promise.all([
					notifyPaymentRequest(newPaymentRequest, logger, userId),
					// notifyUserPayment(newPaymentRequest, userId, logger),
				]);
			} else {
				logger.log("No valid payment amount found in parsed request.");
				await notifyUserAI(
					{ id_paiement: "N/A" },
					userId,
					logger,
					"Aucun montant valide détecté dans votre demande de paiement."
				);
			}
		} catch (error) {
			await notifyTechSlack(error);

			logger.log(`Background payment request creation error: ${error.stack}`);
			// await notifyUserAI(
			// 	{ id_paiement: "N/A" },
			// 	channelId,
			// 	logger,
			// 	`❌ Erreur lors de la création de la demande : ${error.message}, réessayez plus tard.`
			// );
		}
	});

	return createSlackResponse(200, {
		response_type: "ephemeral",
		text: "⌛ Demande de paiement en cours de traitement... Vous serez notifié(e) bientôt !",
	});
}
module.exports = {
	parsePaymentFromText,
	createAndSavePaymentRequest,
	generatePaymentRequestId,
	handlePaymentWelcomeMessage,
	handlePaymentReportCommand,
	handlePaymentTextParsing,
	handlePaymentTextParsing,
	generatePaymentRequestId,
};
