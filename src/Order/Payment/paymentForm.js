const {
	postSlackMessage,
	createSlackResponse,
	postSlackMessageWithRetry,
} = require("../../Common/slackUtils");
const { fetchEntity, bankOptions } = require("../../Common/utils");
const {
	getCaisseTypes,
} = require("../../Caisse/Handlers/caisseFundingRequestHandlers");
const PaymentRequest = require("../../Database/dbModels/PaymentRequest");
const { Order } = require("../../Database/dbModels/Order");
const { Caisse } = require("../../Database/dbModels/Caisse");
const { notifyTechSlack } = require("../../Common/notifyProblem");

async function generatePaymentForm({
	payload,
	action,
	context,
	selectedPaymentMode,
	orderId,
	selectedCaisseId,
}) {
	const caisseOptions = await getCaisseTypes();
	console.log("** selectedPaymentMode", selectedPaymentMode);
	console.log("** ''generatePaymentForm");
	context.log("Opening payment modal for order:", action.value);
	context.log("Génération du formulaire pour le mode:", selectedPaymentMode);
	console.log("selectedCaisseId::::", selectedCaisseId);
	if (selectedCaisseId == null) {
		// Try to find the caisse with type = "Centrale"
		const centraleCaisse = await Caisse.findOne({ type: "Centrale" });
		if (centraleCaisse) {
			selectedCaisseId = centraleCaisse._id.toString();
		} else {
			selectedCaisseId = "6848a25fe472b1c054fef321";
		}
	}
	// Parse private_metadata if available (for updates from modal)
	const privateMetadata = payload.view
		? JSON.parse(payload.view.private_metadata || "{}")
		: {};
	let orderRemainingAmount;
	let orderCurrency; // Default currency
	// const effectiveOrderId = orderId || privateMetadata.orderId || action.value;
	const effectiveOrderId = (() => {
		// Handle case where orderId is an object
		if (orderId && typeof orderId === "object") {
			return orderId.entityId || orderId.id || orderId.orderId;
		}

		// Handle case where privateMetadata.orderId is an object
		if (
			privateMetadata.orderId &&
			typeof privateMetadata.orderId === "object"
		) {
			return (
				privateMetadata.orderId.entityId ||
				privateMetadata.orderId.id ||
				privateMetadata.orderId.orderId
			);
		}

		// Handle case where action.value is an object (parse if it's a JSON string)
		let actionValue = action?.value;
		if (typeof actionValue === "string") {
			try {
				const parsed = JSON.parse(actionValue);
				if (typeof parsed === "object" && parsed.entityId) {
					return parsed.entityId;
				}
			} catch (e) {}
		} else if (typeof actionValue === "object" && actionValue?.entityId) {
			return actionValue.entityId;
		}

		// Fallback to original string values
		return orderId || privateMetadata.orderId || actionValue;
	})();
	console.log("ùùù Effective order ID:", effectiveOrderId);
	if (effectiveOrderId) {
		try {
			// First try to find as an order
			const order = await Order.findOne({ id_commande: effectiveOrderId });
			if (order) {
				console.log("ùùù Order found:", order);

				orderRemainingAmount = order.remainingAmount || 0;
				console.log("ùùù Order remaining amount:", orderRemainingAmount);

				// If remaining amount is 0, get amount from validated proforma
				if (
					orderRemainingAmount === 0 &&
					order.proformas &&
					order.proformas.length > 0
				) {
					const validatedProforma = order.proformas.find(
						(proforma) => proforma.validated === true
					);
					if (validatedProforma && validatedProforma.montant) {
						orderRemainingAmount = validatedProforma.montant;
						console.log(
							"ùùù Using validated proforma amount:",
							orderRemainingAmount
						);
					}
				}

				// If you want to get the currency from the order's proformas or payments
				orderCurrency = order.proformas?.[0]?.devise || "XOF"; // Default to XOF
				console.log("ùùù Order currency:", orderCurrency);
			} else {
				// If not found as order, try to find as payment request
				const paymentRequest = await PaymentRequest.findOne({
					id_paiement: effectiveOrderId,
				});

				if (paymentRequest) {
					// Handle payment request data
					orderRemainingAmount = paymentRequest.remainingAmount || 0;
					console.log(
						"ùùù Payment request remaining amount:",
						orderRemainingAmount
					);
					orderCurrency = paymentRequest.devise || "XOF";
					if (orderRemainingAmount === 0) {
						orderRemainingAmount = paymentRequest.montant;
						console.log(
							"ùùù Using validated proforma amount:",
							orderRemainingAmount
						);
					}

					console.log("ùùù Payment request currency:", orderCurrency);
				}
			}
		} catch (error) {
			await notifyTechSlack(error);

			context.log("ùùù Error fetching order/payment remaining amount:", error);
		}
	}

	const originalChannel =
		privateMetadata.originalChannel || (payload.channel && payload.channel.id);
	let caisseBalance = null;
	let caisseName = null;
	if (selectedCaisseId) {
		try {
			const caisse = await Caisse.findById(selectedCaisseId);
			if (caisse) {
				// Get all three currency balances
				caisseBalance = {
					XOF: caisse.balances.XOF || 0,
					USD: caisse.balances.USD || 0,
					EUR: caisse.balances.EUR || 0,
				};
				caisseName = caisse.type || "Caisse sélectionnée";
			}
		} catch (error) {
			await notifyTechSlack(error);

			context.log("Error fetching caisse balance:", error);
		}
	}
	// Determine payment method code
	const validPaymentMethods = [
		"Espèces",
		"Chèque",
		"Virement",
		"Mobile Money",
		"Julaya",
	];
	let paymentMethod = selectedPaymentMode || "Espèces"; // Default

	// Normalize the method to a valid system code
	const getPaymentMethodDisplayText = (method) => {
		const methodMap = {
			Espèces: "Espèces",
			Chèque: "Chèque",
			Virement: "Virement",
			"Mobile Money": "Mobile Money",
			Julaya: "Julaya",
		};
		return methodMap[method] || method;
	};
	console.log("** caisseBalance", caisseBalance);
	const baseBlocks = [
		// Add caisse balance display block if balance is available
		...(caisseBalance !== null || orderRemainingAmount !== null
			? [
					{
						type: "section",
						block_id: "caisse_info",
						text: {
							type: "mrkdwn",
							text: `${
								caisseBalance !== null
									? `Caisse *${caisseName}*\n XOF: *${caisseBalance.XOF.toLocaleString()} XOF* | USD: *${caisseBalance.USD.toLocaleString()} USD* | EUR: *${caisseBalance.EUR.toLocaleString()} EUR*`
									: ""
							}${
								caisseBalance !== null && orderRemainingAmount !== null
									? "\n\n"
									: ""
							}${
								orderRemainingAmount !== null
									? `*=> Montant restant* ${(
											orderRemainingAmount || 0
									  ).toLocaleString()} ${orderCurrency}`
									: ""
							}`,
						},
					},
					{
						type: "divider",
					},
			  ]
			: []),
		// Only show payment method selection for payment requests (PAY/), not orders (CMD/)

		{
			type: "input",
			block_id: "payment_mode",
			label: { type: "plain_text", text: "Mode de paiement" },
			element: {
				type: "static_select",
				action_id: "select_payment_mode",
				options: [
					{ text: { type: "plain_text", text: "Espèces" }, value: "Espèces" },
					{ text: { type: "plain_text", text: "Chèque" }, value: "Chèque" },
					{ text: { type: "plain_text", text: "Virement" }, value: "Virement" },
					{
						text: { type: "plain_text", text: "Mobile Money" },
						value: "Mobile Money",
					},
					{ text: { type: "plain_text", text: "Julaya" }, value: "Julaya" },
				],
				...(selectedPaymentMode && {
					initial_option: {
						text: { type: "plain_text", text: selectedPaymentMode },
						value: selectedPaymentMode,
					},
				}),
			},
			dispatch_action: true, // Enable block_actions event on selection
		},

		// {
		// 	type: "actions",
		// 	block_id: "confirm_payment_mode",
		// 	elements: [
		// 		{
		// 			type: "button",
		// 			action_id: "confirm_payment_mode",
		// 			text: { type: "plain_text", text: "Ajouter les détails " },
		// 			value: "confirm_payment_mode",
		// 		},
		// 	],
		// },

		{
			type: "input",
			block_id: "payment_proof_unique",
			optional: true,
			label: {
				type: "plain_text",
				text: "📎 Justificatif de paiement ",
			},
			element: {
				type: "file_input",
				action_id: "input_payment_proof",
				filetypes: ["pdf", "png", "jpg", "jpeg"],
				max_files: 5,
			},
		},
		{
			type: "input",
			block_id: "paiement_url",
			optional: true,
			label: { type: "plain_text", text: "🔗 URL paiement" },
			element: {
				type: "plain_text_input",
				action_id: "input_paiement_url",
				placeholder: { type: "plain_text", text: "https://..." },
			},
		},
		{
			type: "input",
			block_id: "payment_title",
			label: { type: "plain_text", text: "Intitulé du paiement" },
			element: {
				type: "plain_text_input",
				action_id: "input_payment_title",
				// initial_value: "Acompte 1",
			},
		},
		{
			type: "input",
			block_id: "amount_paid",
			label: { type: "plain_text", text: "Montant payé" },
			element: {
				type: "number_input",
				action_id: "input_amount_paid",
				is_decimal_allowed: true,
				min_value: "0",
			},
		},
	];
	// Payment method specific blocks
	const getPaymentMethodBlocks = (method) => {
		if (method === "Chèque") {
			return [
				{ type: "divider" },

				{
					type: "input",
					block_id: "cheque_number",
					label: { type: "plain_text", text: "Numéro du chèque" },
					element: {
						action_id: "input_cheque_number",
						type: "number_input",
						is_decimal_allowed: true,
						min_value: "0",
					},
				},
				{
					type: "input",
					block_id: "cheque_bank",
					label: { type: "plain_text", text: "Banque" },
					element: {
						type: "static_select",
						action_id: "input_cheque_bank",
						options: bankOptions,
					},
				},
				{
					type: "input",
					block_id: "cheque_date",
					label: { type: "plain_text", text: "Date du chèque" },
					element: { type: "datepicker", action_id: "input_cheque_date" },
				},
				{
					type: "input",
					block_id: "cheque_order",
					label: { type: "plain_text", text: "Ordre" },
					element: {
						type: "plain_text_input",
						action_id: "input_cheque_order",
					},
				},
			];
		} else if (method === "Virement") {
			return [
				{ type: "divider" },
				{
					type: "input",
					block_id: "virement_number",
					label: { type: "plain_text", text: "Numéro de virement" },
					element: {
						type: "number_input",
						is_decimal_allowed: true,
						min_value: "0",
						action_id: "input_virement_number",
					},
				},
				{
					type: "input",
					block_id: "virement_bank",
					label: { type: "plain_text", text: "Banque" },
					element: {
						type: "static_select",
						action_id: "input_virement_bank",
						options: bankOptions,
					},
				},
				{
					type: "input",
					block_id: "virement_date",
					label: { type: "plain_text", text: "Date" },
					element: { type: "datepicker", action_id: "input_virement_date" },
				},
				{
					type: "input",
					block_id: "virement_order",
					label: { type: "plain_text", text: "Ordre" },
					element: {
						type: "plain_text_input",
						action_id: "input_virement_order",
					},
				},
			];
		} else if (method === "Mobile Money") {
			return [
				{ type: "divider" },
				{
					type: "input",
					block_id: "mobilemoney_recipient_phone",
					label: {
						type: "plain_text",
						text: "Numéro de téléphone bénéficiaire",
					},
					element: {
						type: "number_input",
						is_decimal_allowed: true,
						min_value: "0",
						action_id: "input_mobilemoney_recipient_phone",
					},
				},
				{
					type: "input",
					block_id: "mobilemoney_sender_phone",
					label: { type: "plain_text", text: "Numéro envoyeur" },
					element: {
						type: "number_input",
						is_decimal_allowed: true,
						min_value: "0",
						action_id: "input_mobilemoney_sender_phone",
					},
				},
				{
					type: "input",
					block_id: "mobilemoney_fees",
					label: { type: "plain_text", text: "Frais" },
					element: {
						type: "number_input",
						is_decimal_allowed: true,
						min_value: "0",
						action_id: "input_mobilemoney_fees",
						placeholder: {
							type: "plain_text",
							text: "Montant des frais",
						},
					},
				},
				{
					type: "input",
					block_id: "mobilemoney_date",
					label: { type: "plain_text", text: "Date" },
					element: { type: "datepicker", action_id: "input_mobilemoney_date" },
				},
			];
		} else if (method === "Julaya") {
			return [
				{ type: "divider" },
				{
					type: "input",
					block_id: "julaya_recipient",
					label: { type: "plain_text", text: "Bénéficiaire" },
					element: {
						type: "plain_text_input",
						action_id: "input_julaya_recipient",
					},
				},
				{
					type: "input",
					block_id: "julaya_date",
					label: { type: "plain_text", text: "Date" },
					element: { type: "datepicker", action_id: "input_julaya_date" },
				},
				{
					type: "input",
					block_id: "julaya_transaction_number",
					label: { type: "plain_text", text: "Numéro de transaction" },
					element: {
						type: "number_input",
						is_decimal_allowed: true,
						min_value: "0",
						action_id: "input_julaya_transaction_number",
					},
				},
			];
		}
		return [];
	};
	// // Add dynamic fields based on selected payment mode
	// if (selectedPaymentMode === "Chèque") {
	// 	blocks.push(
	// 		{ type: "divider" },

	// 		{
	// 			type: "input",
	// 			block_id: "cheque_number",
	// 			label: { type: "plain_text", text: "Numéro du chèque" },
	// 			element: {
	// 				action_id: "input_cheque_number",
	// 				type: "number_input",
	// 				is_decimal_allowed: true,
	// 				min_value: "0",
	// 			},
	// 		},
	// 		{
	// 			type: "input",
	// 			block_id: "cheque_bank",
	// 			label: { type: "plain_text", text: "Banque" },
	// 			element: {
	// 				type: "static_select",
	// 				action_id: "input_cheque_bank",
	// 				options: bankOptions,
	// 			},
	// 		},
	// 		{
	// 			type: "input",
	// 			block_id: "cheque_date",
	// 			label: { type: "plain_text", text: "Date du chèque" },
	// 			element: { type: "datepicker", action_id: "input_cheque_date" },
	// 		},
	// 		{
	// 			type: "input",
	// 			block_id: "cheque_order",
	// 			label: { type: "plain_text", text: "Ordre" },
	// 			element: { type: "plain_text_input", action_id: "input_cheque_order" },
	// 		}
	// 	);
	// } else if (selectedPaymentMode === "Virement") {
	// 	blocks.push(
	// 		{ type: "divider" },
	// 		{
	// 			type: "input",
	// 			block_id: "virement_number",
	// 			label: { type: "plain_text", text: "Numéro de virement" },
	// 			element: {
	// 				type: "number_input",
	// 				is_decimal_allowed: true,
	// 				min_value: "0",
	// 				action_id: "input_virement_number",
	// 			},
	// 		},
	// 		{
	// 			type: "input",
	// 			block_id: "virement_bank",
	// 			label: { type: "plain_text", text: "Banque" },
	// 			element: {
	// 				type: "static_select",
	// 				action_id: "input_virement_bank",
	// 				options: bankOptions,
	// 			},
	// 		},
	// 		{
	// 			type: "input",
	// 			block_id: "virement_date",
	// 			label: { type: "plain_text", text: "Date" },
	// 			element: { type: "datepicker", action_id: "input_virement_date" },
	// 		},
	// 		{
	// 			type: "input",
	// 			block_id: "virement_order",
	// 			label: { type: "plain_text", text: "Ordre" },
	// 			element: {
	// 				type: "plain_text_input",
	// 				action_id: "input_virement_order",
	// 			},
	// 		}
	// 	);
	// } else if (selectedPaymentMode === "Mobile Money") {
	// 	blocks.push(
	// 		{ type: "divider" },
	// 		{
	// 			type: "input",
	// 			block_id: "mobilemoney_recipient_phone",
	// 			label: { type: "plain_text", text: "Numéro de téléphone bénéficiaire" },
	// 			element: {
	// 				type: "number_input",
	// 				is_decimal_allowed: true,
	// 				min_value: "0",
	// 				action_id: "input_mobilemoney_recipient_phone",
	// 			},
	// 		},
	// 		{
	// 			type: "input",
	// 			block_id: "mobilemoney_sender_phone",
	// 			label: { type: "plain_text", text: "Numéro envoyeur" },
	// 			element: {
	// 				type: "number_input",
	// 				is_decimal_allowed: true,
	// 				min_value: "0",
	// 				action_id: "input_mobilemoney_sender_phone",
	// 			},
	// 		},
	// 		{
	// 			type: "input",
	// 			block_id: "mobilemoney_date",
	// 			label: { type: "plain_text", text: "Date" },
	// 			element: { type: "datepicker", action_id: "input_mobilemoney_date" },
	// 		}
	// 	);
	// } else if (selectedPaymentMode === "Julaya") {
	// 	blocks.push(
	// 		{ type: "divider" },
	// 		{
	// 			type: "input",
	// 			block_id: "julaya_recipient",
	// 			label: { type: "plain_text", text: "Bénéficiaire" },
	// 			element: {
	// 				type: "plain_text_input",
	// 				action_id: "input_julaya_recipient",
	// 			},
	// 		},
	// 		{
	// 			type: "input",
	// 			block_id: "julaya_date",
	// 			label: { type: "plain_text", text: "Date" },
	// 			element: { type: "datepicker", action_id: "input_julaya_date" },
	// 		},
	// 		{
	// 			type: "input",
	// 			block_id: "julaya_transaction_number",
	// 			label: { type: "plain_text", text: "Numéro de transaction" },
	// 			element: {
	// 				type: "number_input",
	// 				is_decimal_allowed: true,
	// 				min_value: "0",
	// 				action_id: "input_julaya_transaction_number",
	// 			},
	// 		}
	// 	);
	// }
	// Get payment method specific blocks
	const paymentMethodBlocks = getPaymentMethodBlocks(selectedPaymentMode);
	// Combine all blocks
	let blocks = [...baseBlocks, ...paymentMethodBlocks];

	const view = {
		type: "modal",
		callback_id: "payment_form_submission",
		title: { type: "plain_text", text: "Formulaire Paiement" },
		submit: { type: "plain_text", text: "Soumettre" },
		close: { type: "plain_text", text: "Annuler" },
		blocks: blocks,
		private_metadata: JSON.stringify({
			orderId: effectiveOrderId,
			originalChannel: originalChannel,
			selectedCaisseId: selectedCaisseId,
		}),
	};

	// context.log("Final view structure:", JSON.stringify(view, null, 2));

	// Use views.update if called from a modal, views.open if initial call
	const apiEndpoint = payload.view
		? "https://slack.com/api/views.update"
		: "https://slack.com/api/views.open";
	const requestBody = payload.view
		? { view_id: payload.view.id, hash: payload.view.hash, view }
		: { trigger_id: payload.trigger_id, view };

	const response = await postSlackMessage(
		apiEndpoint,
		requestBody,
		process.env.SLACK_BOT_TOKEN
	);

	if (!response.ok) {
		context.log(
			`❌ ${apiEndpoint.split("/").pop()} failed: ${JSON.stringify(
				response,
				null,
				2
			)}`
		);
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: `Erreur: ${response.error}`,
		});
	}

	return {
		statusCode: 200,
		headers: { "Content-Type": "application/json" },
		body: "",
	};
}

async function handleFinancePaymentForm(payload, action, context) {
	console.log("** finance_payment_form");
	let entityId, selectedCaisseId;
	const caisseId = await Caisse.findOne({ type: "Centrale" }, "_id").then(
		(caisse) => caisse?._id?.toString() || null
	); // Add .toString()
	console.log("Caisse ID:", caisseId);
	try {
		// Check if the value is a JSON string or a plain order ID
		if (
			action.value &&
			typeof action.value === "string" &&
			action.value.startsWith("{")
		) {
			// If it's a JSON string, parse it to get both values
			const parsedValue = JSON.parse(action.value);
			entityId = parsedValue.entityId;
			selectedCaisseId = parsedValue.selectedCaisseId;
		} else {
			// If it's a plain string (order ID), use it directly
			entityId = action.value;
			selectedCaisseId = caisseId; // No caisse selection in this case
		}
	} catch (parseError) {
		await notifyTechSlack(parseError);

		console.log(
			"Failed to parse action.value as JSON, using as plain entityId:",
			action.value
		);
		entityId = action.value;
		selectedCaisseId = null;
	}
	console.log("action.value:", action.value);
	console.log("entityId:", entityId);
	console.log("selectedCaisseId:", selectedCaisseId);

	console.log("entityId2222", entityId);
	// Fetch the entity
	const entity = await fetchEntity(entityId, context);
	if (!entity) {
		throw new Error(`Entity ${entityId} not found`);
	}

	// Check if blockPayment is true
	if (entity.blockPayment) {
		context.log(`Payment blocked for order ${entityId}`);
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: payload.channel.id,
				user: payload.user.id,
				text: `🚫 Le paiement pour ${entityId} est bloqué. Veuillez contacter un administrateur pour plus d'informations.`,
			},
			process.env.SLACK_BOT_TOKEN,
			context
		);
		return {};
	}
	console.log("entity.remainingAmount", entity.remainingAmount);
	if (entity.paymentDone == "true") {
		context.log(`Payment blocked for order ${entityId}`);
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: payload.channel.id,
				user: payload.user.id,
				text: `🚫 La commande a été payée`,
			},
			process.env.SLACK_BOT_TOKEN,
			context
		);
		throw new Error(`🚫 La commande a été payée`);
	}
	if (entityId.startsWith("CMD/")) {
		console.log('entityId.startsWith("CMD/")', entityId.startsWith("CMD/"));
		console.log("entity.deleted", entity.deleted);

		if (entity.deleted == true) {
			console.log("entity.deleted", entity.deleted);

			context.log(`Payment blocked for order ${entityId}`);
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: payload.channel.id,
					user: payload.user.id,
					text: `🚫 La commande a été supprimée`,
				},
				process.env.SLACK_BOT_TOKEN,
				context
			);
			throw new Error(`🚫 La commande a été supprimée`);
		}
	}

	// If blockPayment is false, proceed to open the form
	context.log(`Opening payment form for order ${entityId}`);
	return await generatePaymentForm({
		payload,
		action,
		context,
		selectedPaymentMode: null,
		orderId: action.value,
		selectedCaisseId,
	});
}
module.exports = {
	handleFinancePaymentForm,
	generatePaymentForm,
};
