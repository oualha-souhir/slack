const { Caisse } = require("../../Database/dbModels/Caisse.js");
const {
	createSlackResponse,
	postSlackMessageWithRetry,
} = require("../../Common/slackUtils");

const {
	generateFundingDetailsBlocks,
	getPaymentMethodText,
} = require("./caisseFundingRequestHandlers");
const { syncCaisseToExcel } = require("../../Excel/report");
//* 13 correct_funding_details
async function generateCorrectionModal(payload, context) {
	console.log("** generateCorrectionModal");
	const value = JSON.parse(payload.actions[0].value);
	const triggerId = payload.trigger_id;
	const requestId = value.requestId;
	const channelId = value.channelId;
	const messageTs = value.messageTs;
	const caisse = await Caisse.findOne({
		"fundingRequests.requestId": requestId,
	});
	if (!caisse) {
		console.error(`Caisse not found for request ${requestId}`);
		return;
	}

	const request = caisse.fundingRequests.find((r) => r.requestId === requestId);
	if (!request) {
		console.error(`Request ${requestId} not found`);
		return;
	}

	const chequeDetails = request.paymentDetails?.cheque || {};

	// Build bank select element
	const chequeBankElement = {
		type: "static_select",
		action_id: "input_cheque_bank",
		options: [
			{
				text: { type: "plain_text", text: "AFG BANK CI" },
				value: "AFGBANK_CI",
			},
			{
				text: { type: "plain_text", text: "AFRILAND FIRST BANK CI" },
				value: "AFRILAND_FIRST_BANK_CI",
			},
			{
				text: { type: "plain_text", text: "BOA - CÔTE D’IVOIRE" },
				value: "BOA_CI",
			},
			{
				text: { type: "plain_text", text: "BANQUE ATLANTIQUE CI (BACI)" },
				value: "BACI",
			},
			{
				text: { type: "plain_text", text: "BANQUE D’ABIDJAN" },
				value: "BANQUE_D_ABIDDAJAN",
			},
			{ text: { type: "plain_text", text: "BHCI" }, value: "BHCI" },
			{ text: { type: "plain_text", text: "BDU-CI" }, value: "BDU_CI" },
			{ text: { type: "plain_text", text: "BICICI" }, value: "BICICI" }, // Shortened from "BANQUE INTERNATIONALE POUR LE COMMERCE ET L’INDUSTRIE DE LA CÔTE D’IVOIRE"
			{ text: { type: "plain_text", text: "BNI" }, value: "BNI" },
			{
				text: { type: "plain_text", text: "BANQUE POPULAIRE CI" },
				value: "BANQUE_POPULAIRE",
			},
			{
				text: { type: "plain_text", text: "BSIC - CÔTE D’IVOIRE" },
				value: "BSIC_CI",
			}, // Shortened from "BANQUE SAHÉLO-SAHARIENNE POUR L’INVESTISSEMENT ET LE COMMERCE - CÔTE D’IVOIRE"
			{
				text: { type: "plain_text", text: "BGFIBANK-CI" },
				value: "BGFIBANK_CI",
			},
			{
				text: { type: "plain_text", text: "BRIDGE BANK GROUP CI" },
				value: "BBG_CI",
			},
			{
				text: { type: "plain_text", text: "CITIBANK CI" },
				value: "CITIBANK_CI",
			},
			{
				text: { type: "plain_text", text: "CORIS BANK INTL CI" },
				value: "CBI_CI",
			},
			{ text: { type: "plain_text", text: "ECOBANK CI" }, value: "ECOBANK_CI" },
			{ text: { type: "plain_text", text: "GTBANK-CI" }, value: "GTBANK_CI" },
			{ text: { type: "plain_text", text: "MANSA BANK" }, value: "MANSA_BANK" },
			{
				text: { type: "plain_text", text: "NSIA BANQUE CI" },
				value: "NSIA_BANQUE_CI",
			},
			{ text: { type: "plain_text", text: "ORABANK CI" }, value: "ORABANK_CI" },
			{
				text: { type: "plain_text", text: "ORANGE BANK AFRICA" },
				value: "ORANGE_BANK",
			},
			{
				text: { type: "plain_text", text: "SOCIETE GENERALE CI" },
				value: "SOCIETE_GENERALE_CI",
			},
			{ text: { type: "plain_text", text: "SIB" }, value: "SIB" },
			{
				text: { type: "plain_text", text: "STANBIC BANK" },
				value: "STANBIC_BANK",
			},
			{
				text: { type: "plain_text", text: "STANDARD CHARTERED CI" },
				value: "STANDARD_CHARTERED_CI",
			},
			{ text: { type: "plain_text", text: "UBA" }, value: "UBA" },
			{
				text: { type: "plain_text", text: "VERSUS BANK" },
				value: "VERSUS_BANK",
			},
			{ text: { type: "plain_text", text: "BMS CI" }, value: "BMS_CI" },
			{ text: { type: "plain_text", text: "BRM CI" }, value: "BRM_CI" },
			{ text: { type: "plain_text", text: "Autre" }, value: "Autre" },
		],
	};

	// Only add initial_option if there's a valid bank
	//*
	// if (chequeDetails.bank) {
	// 	bankOptions.initial_option = {
	// 		text: { type: "plain_text", text: chequeDetails.bank },
	// 		value: chequeDetails.bank,
	// 	};
	// }
	if (chequeDetails.bank) {
		chequeBankElement.initial_option = {
			text: { type: "plain_text", text: chequeDetails.bank },
			value: chequeDetails.bank,
		};
	}
	// Build date picker element
	const chequeDateElement = {
		type: "datepicker",
		action_id: "input_cheque_date",
	};
	// Map database payment method to modal options
	// Only add initial_date if there's a valid date
	if (chequeDetails.date && chequeDetails.date.match(/^\d{4}-\d{2}-\d{2}$/)) {
		chequeDateElement.initial_date = chequeDetails.date;
	}
	// Determine payment method code
	const validPaymentMethods = ["cash", "cheque"];
	let paymentMethod = "cash"; // Default

	// Get raw payment method from DB
	const rawDbMethod = request.paymentDetails?.method;
	console.log("$$ Raw payment method from DB:", rawDbMethod);

	// Normalize the method to a valid system code
	if (rawDbMethod) {
		const normalized = rawDbMethod.trim().toLowerCase();
		if (normalized === "cheque" || normalized === "chèque") {
			paymentMethod = "cheque";
		} else if (
			normalized === "cash" ||
			normalized === "espèces" ||
			normalized === "especes"
		) {
			paymentMethod = "cash";
		}
	}

	// Get display text for selected method
	const displayMethod = getPaymentMethodText(paymentMethod);
	console.log("$$ Selected payment method:", displayMethod);
	const modal = {
		type: "modal",
		callback_id: "correct_fund",
		private_metadata: JSON.stringify({
			entityId: requestId,
			channelId: channelId,
			messageTs: messageTs,
		}),
		title: { type: "plain_text", text: "Corriger les Détails" },
		submit: { type: "plain_text", text: "Soumettre" },
		close: { type: "plain_text", text: "Annuler" },
		blocks: [
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `*Demande*: ${requestId}\n*Montant*: ${request.amount} ${request.currency}\n*Motif*: ${request.reason}`,
				},
			},

			{
				type: "input",
				block_id: "payment_method",
				label: { type: "plain_text", text: "Méthode de paiement" },
				element: {
					type: "radio_buttons",
					action_id: "input_payment_method",
					options: [
						{ text: { type: "plain_text", text: "Espèces" }, value: "cash" },
						{ text: { type: "plain_text", text: "Chèque" }, value: "cheque" },
					],
					initial_option: {
						text: { type: "plain_text", text: displayMethod },
						value: paymentMethod,
					},
				},
			},
			{
				type: "input",
				block_id: "cheque_number",
				optional: true,
				element: {
					type: "plain_text_input",
					action_id: "input_cheque_number",
					initial_value: chequeDetails.number || "",
				},
				label: { type: "plain_text", text: "Numéro du Chèque" },
			},
			{
				type: "input",
				block_id: "cheque_bank",
				optional: true,
				element: chequeBankElement,
				label: { type: "plain_text", text: "Banque" },
			},
			{
				type: "input",
				block_id: "cheque_date",
				optional: true,
				element: chequeDateElement,
				label: { type: "plain_text", text: "Date du Chèque" },
			},
			{
				type: "input",
				block_id: "cheque_order",
				optional: true,
				element: {
					type: "plain_text_input",
					action_id: "input_cheque_order",
					initial_value: chequeDetails.order || "",
				},
				label: { type: "plain_text", text: "Ordre" },
			},
			// Add new file upload field
			{
				type: "input",
				block_id: "cheque_files",
				optional: true,
				element: {
					type: "file_input",
					action_id: "input_cheque_files",
					filetypes: ["pdf", "png", "jpg", "jpeg"],
					max_files: 3,
				},
				label: { type: "plain_text", text: "Fichiers" },
			},
			// Add URL input field for external links
			{
				type: "input",
				block_id: "cheque_urls",
				optional: true,
				element: {
					type: "plain_text_input",
					action_id: "input_cheque_urls",
					placeholder: {
						type: "plain_text",
						text: "URLs séparées par des virgules",
					},
				},
				// label: { type: "plain_text", text: "Liens vers les documents (séparés par des virgules)" },
				label: { type: "plain_text", text: "Lien " },
			},
		],
	};

	try {
		console.log("$$ Modal payment method:", request.paymentDetails?.method);
		console.log(
			"$$ Modal payment initial option:",
			modal.blocks[1].element.initial_option
		);
		const response = await postSlackMessageWithRetry(
			"https://slack.com/api/views.open",
			{ trigger_id: triggerId, view: modal },
			process.env.SLACK_BOT_TOKEN
		);
		console.log("Slack API response:", response);
	} catch (error) {
		await notifyTechSlack(error);

		console.error("Failed to open modal:", error);
	}
}
//* 14 correct_fund
async function handleCorrectionSubmission(payload, context) {
	console.log("** handleCorrectionSubmission");
	const metadata = JSON.parse(payload.view.private_metadata);
	const requestId = metadata.entityId;
	const channelId = metadata.channelId;
	const messageTs = metadata.messageTs;
	const userId = payload.user.username;

	const formData = payload.view.state.values;

	// Fetch caisse from database
	const caisse = await Caisse.findOne({
		"fundingRequests.requestId": requestId,
	});
	if (!caisse) {
		console.error(`Caisse not found for request ${requestId}`);
		return createSlackResponse(200, {
			response_action: "errors",
			errors: { general: "Demande introuvable" },
		});
	}

	// Find the specific funding request
	const requestIndex = caisse.fundingRequests.findIndex(
		(r) => r.requestId === requestId
	);
	if (requestIndex === -1) {
		console.error(`Request ${requestId} not found`);
		return createSlackResponse(200, {
			response_action: "errors",
			errors: { general: "Demande introuvable" },
		});
	}

	const request = caisse.fundingRequests[requestIndex];
	// Retrieve amount, currency, and paymentNotes from the database
	const amount = request.amount;
	const currency = request.currency?.toUpperCase();
	const paymentNotes = request.paymentDetails?.notes || "";

	// Validate amount and currency
	if (!amount || !currency) {
		return createSlackResponse(200, {
			response_action: "errors",
			errors: {
				general: "Montant ou devise manquant dans la base de données.",
			},
		});
	}

	if (amount <= 0) {
		return createSlackResponse(200, {
			response_action: "errors",
			errors: { general: "Le montant doit être supérieur à zéro." },
		});
	}

	// Validate payment method from form
	let paymentMethod =
		formData.payment_method?.input_payment_method?.selected_option?.value;
	console.log("paymentMethod", paymentMethod);
	if (!paymentMethod) {
		return createSlackResponse(200, {
			response_action: "errors",
			errors: { payment_method: "La méthode de paiement est requise." },
		});
	}
	const paymentMethod1 = getPaymentMethodText(paymentMethod);
	console.log("paymentMethod", paymentMethod1);

	// Update request details
	request.amount = amount; // Already set, but kept for clarity

	request.disbursementType = paymentMethod1; // Already set, but kept for clarity

	request.currency = currency; // Already set, but kept for clarity
	request.paymentDetails = {
		method: paymentMethod1,
		notes: paymentNotes, // Use database value
		approvedBy: userId,
		approvedAt: new Date(),
		filledBy: userId,
		filledAt: new Date(),
	};
	console.log("paymentMethod2", paymentMethod);
	if (paymentMethod !== "cheque") {
		delete request.paymentDetails.cheque; // Remove cheque details if method changes
	}
	if (paymentMethod === "cheque") {
		console.log("111");
		if (
			!formData.cheque_number?.input_cheque_number?.value ||
			!formData.cheque_bank?.input_cheque_bank?.selected_option?.value ||
			!formData.cheque_date?.input_cheque_date?.selected_date ||
			!formData.cheque_order?.input_cheque_order?.value
		) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_ADMIN_ID,
					text: "⚠️ Veuillez remplir tous les champs requis pour le chèque.",
				},
				process.env.SLACK_BOT_TOKEN
			);
			return createSlackResponse(200, "");
		}
		// Extract file IDs from file_input
		const fileIds =
			formData.cheque_files?.input_cheque_files?.files?.map(
				(file) => file.url_private
			) || [];
		console.log("File IDs:", fileIds);
		// Process URLs (comma-separated string to array)
		const urlsString = formData.cheque_urls?.input_cheque_urls?.value || "";
		const urls = urlsString
			? urlsString
					.split(",")
					.map((url) => url.trim())
					.filter((url) => /^https?:\/\/[^\s,]+$/.test(url))
			: [];
		console.log("URLs:", urls);
		request.paymentDetails.cheque = {
			number: formData.cheque_number.input_cheque_number.value,
			bank: formData.cheque_bank.input_cheque_bank.selected_option.value,
			date: formData.cheque_date.input_cheque_date.selected_date,
			order: formData.cheque_order.input_cheque_order.value,
			urls: urls.length > 0 ? urls : [],
			file_ids: fileIds.length > 0 ? fileIds : [],
		};
	}

	if (paymentMethod !== "cheque") {
		console.log("222");
		request.paymentDetails.cheque = null;
	}
	request.status = "Validé";
	request.approvedBy = userId;
	request.approvedAt = new Date(); // Approved At

	request.workflow.stage = "approved";
	request.workflow.history.push({
		stage: "approved",
		timestamp: new Date(),
		actor: userId,
		details: "Détails corrigés et approuvés",
	});
	// Consolidate database update
	const update = {
		$set: { [`fundingRequests.${requestIndex}`]: request },
		$push: {
			transactions: {
				type: "Funding",
				amount: amount,
				currency: currency,
				requestId,
				details: `Corrigé et approuvé par <@${userId}> `,
				timestamp: new Date(),
			},
		},
	};
	console.log("request.changed", request.changed);
	// Increment balance only if not previously updated
	if (request.changed == false) {
		update.$inc = { [`balances.${currency}`]: amount };
		console.log(
			`[Balance Update] Incrementing balances.${currency} by ${amount}`
		);
	}
	request.changed = true; // Already set, but kept for clarity

	// Perform atomic update and fetch updated document
	const updatedCaisse = await Caisse.findOneAndUpdate(
		{ "fundingRequests.requestId": requestId },
		update,
		{ new: true }
	);

	// Log the updated balance
	console.log(
		`[Balance Update] Updated caisse balances:`,
		JSON.stringify(updatedCaisse.balances, null, 2)
	);

	// Sync to Excel
	try {
		await syncCaisseToExcel(updatedCaisse, requestId);
	} catch (error) {
		console.error(`Excel sync failed: ${error.message}`);
		await notifyTechSlack(error);

		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ADMIN_ID,
				text: `Erreur lors de la synchronisation Excel pour ${requestId}. Contactez l'administrateur.`,
			},
			process.env.SLACK_BOT_TOKEN
		);
	}

	// Notify finance team
	const chequeDetailsText =
		paymentMethod === "cheque"
			? `\n• Numéro: ${request.paymentDetails.cheque.number}\n• Banque: ${request.paymentDetails.cheque.bank}\n• Date: ${request.paymentDetails.cheque.date}\n• Ordre: ${request.paymentDetails.cheque.order}`
			: "";
	const block = generateFundingDetailsBlocks(
		request,
		request.paymentDetails.method,
		request.paymentDetails.notes,
		request.paymentDetails,
		userId,
		caisse.type
	);
	console.log("request.paymentDetails.method", request.paymentDetails.method);
	console.log("request", request);
	console.log("request.paymentDetails", request.paymentDetails);

	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_FINANCE_CHANNEL_ID,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: `:heavy_dollar_sign: ✅ Demande de fonds - Corrigée et Approuvée : ${requestId}`,
						emoji: true,
					},
				},
				...block,
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: `Soldes actuels: XOF: *${caisse.balances.XOF}*, USD: *${caisse.balances.USD}*, EUR: *${caisse.balances.EUR}*`,
						},
					],
				},
			],
			text: `Demande ${requestId} corrigée et approuvée`,
		},
		process.env.SLACK_BOT_TOKEN
	);

	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_ADMIN_ID,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: `:heavy_dollar_sign: ✅ Demande de fonds - Corrigée et Approuvée : ${requestId}`,
						emoji: true,
					},
				},
				...block,
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: `Soldes actuels: XOF: *${caisse.balances.XOF}*, USD: *${caisse.balances.USD}*, EUR: *${caisse.balances.EUR}*`,
						},
					],
				},
			],
			text: `Demande ${requestId} corrigée et approuvée`,
		},
		process.env.SLACK_BOT_TOKEN
	);
	return createSlackResponse(200, { response_action: "clear" });
}

module.exports = {
	generateCorrectionModal,
	handleCorrectionSubmission,
};
