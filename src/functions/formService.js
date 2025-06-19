// src/formService.js
const { postSlackMessage, createSlackResponse } = require("./utils");
const {
	syncCaisseToExcel,
	handleValidationRequest,
	generateCorrectionModal,
	openFinanceDetailsForm,
	deductCashForPayment,
} = require("./caisseService");
const { generateFundingRequestForm } = require("./caisseService");

const {
	generateOrderForm,
	generatePaymentForm,
	generateArticleBlocks,
	generateProformaBlocks,
	proforma_form,
	extractProformas,
	generatePaymentRequestForm,
	bankOptions,
} = require("./form");
const axios = require("axios");
const { handleOrderStatus, reopenOrder } = require("./orderStatusService");
const { Order, FormData1, PaymentRequest, Caisse } = require("./db");
const {
	notifyAdmin,
	notifyFinancePayment,
	notifyAdminProforma,
	getOrderBlocks,
	notifyTeams,
	postSlackMessageWithRetry,
} = require("./notificationService");
const { getFournisseurOptions } = require("./config");

// Helper function to get human-readable problem type
function getProblemTypeText(problemType) {
	console.log("** getProblemTypeText");
	const types = {
		wrong_amount: "Montant incorrect",
		wrong_payment_mode: "Mode de paiement incorrect",
		wrong_proof: "Justificatif manquant ou incorrect",
		wrong_bank_details: "Détails bancaires incorrects",
		other: "Autre problème",
	};
	return types[problemType] || problemType;
}
// Handler for edit_proforma action
// Handler for edit_proforma action
async function handleEditProforma(payload, context) {
	console.log("** handleEditProforma");
	try {
		// Extract data from the button value
		const { orderId, proformaIndex } = JSON.parse(payload.actions[0].value);

		// Fetch the order
		const order = await Order.findOne({ id_commande: orderId });
		if (!order) {
			throw new Error(`Order ${orderId} not found`);
		}

		// Check if the proforma exists
		if (!order.proformas || !order.proformas[proformaIndex]) {
			throw new Error(
				`Proforma index ${proformaIndex} not found in order ${orderId}`
			);
		}

		const proforma = order.proformas[proformaIndex];
		// Check if any proforma in the order is already validated
		const hasValidatedProforma = order.proformas.some((p) => p.validated);
		if (hasValidatedProforma) {
			// Post Slack message to the designated channel
			const slackResponse = await postSlackMessage(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_ACHAT_CHANNEL_ID,
					text: "⚠️ Une proforma a été validée.",
				},
				process.env.SLACK_BOT_TOKEN
			);
			return {
				text: "⚠️ Une proforma a été validée.",
				replace_original: false,
				response_type: "ephemeral",
			};
		} else {
			// Create blocks for the existing URLs
			const urlBlocks = [];
			// Get fournisseur options
			const FOURNISSEUR_OPTIONS = await getFournisseurOptions();
			const currentFournisseur = proforma.fournisseur || "";

			let initialFournisseurOption = FOURNISSEUR_OPTIONS[0]; // default

			// Try to match the current fournisseur value
			const matchingOption = FOURNISSEUR_OPTIONS.find(
				(option) =>
					option.text.text === currentFournisseur ||
					option.value === currentFournisseur.toLowerCase().replace(/\s+/g, "_")
			);

			if (matchingOption) {
				initialFournisseurOption = matchingOption;
			}
			// Add header for existing files/URLs section if there are any
			if (proforma.urls && proforma.urls.length > 0) {
				urlBlocks.push({
					type: "section",
					block_id: "existing_urls_header",
					text: {
						type: "mrkdwn",
						text: "*Pages/URLs existantes:*",
					},
				});

				// Add each existing URL as a separate input field
				proforma.urls.forEach((url, index) => {
					urlBlocks.push({
						type: "input",
						block_id: `existing_url_${index}`,
						optional: true,
						label: {
							type: "plain_text",
							text: `🔗 Page ${index + 1}`,
						},
						element: {
							type: "plain_text_input",
							action_id: `edit_url_${index}`,
							initial_value: url,
						},
					});
				});

				// Add divider after existing URLs
				urlBlocks.push({
					type: "divider",
				});
			}

			// Create the edit form with pre-filled values
			const modalView = {
				type: "modal",
				callback_id: "edit_proforma_submission",
				title: {
					type: "plain_text",
					text: "Modifier la Proforma",
					emoji: true,
				},
				submit: {
					type: "plain_text",
					text: "Mettre à jour",
					emoji: true,
				},
				close: {
					type: "plain_text",
					text: "Annuler",
					emoji: true,
				},
				blocks: [
					{
						type: "input",
						block_id: "proforma_designation",
						element: {
							type: "plain_text_input",
							action_id: "designation_input",
							initial_value: proforma.nom || "",
						},
						label: {
							type: "plain_text",
							text: "Référence",
						},
					},
					{
						type: "input",
						block_id: "proforma_fournisseur",
						optional: false,
						element: {
							type: "static_select",
							action_id: "fournisseur_input",
							options: FOURNISSEUR_OPTIONS,
							initial_option: initialFournisseurOption,
						},
						label: {
							type: "plain_text",
							text: "Fournisseur",
						},
					},
					{
						type: "input",
						block_id: "proforma_amount",
						label: { type: "plain_text", text: "💰 Montant" },
						element: {
							type: "plain_text_input",
							action_id: "input_proforma_amount",
							initial_value: `${proforma.montant} ${proforma.devise}`,
							placeholder: { type: "plain_text", text: "Ex: 1000 XOF" },
						},
						hint: {
							type: "plain_text",
							text: "Entrez un montant suivi de la devise (XOF, USD, EUR)",
						},
					},
					// Add the existing URLs blocks
					...urlBlocks,
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: " Télécharger de nouveaux fichiers ou ajouter de nouvelles URLs",
						},
					},
					{
						type: "input",
						block_id: "proforma_file",
						optional: true,
						label: {
							type: "plain_text",
							text: "📎 Nouveaux fichiers",
						},
						element: {
							type: "file_input",
							action_id: "file_upload",
							filetypes: ["pdf", "jpg", "png"],
							max_files: 5,
						},
						hint: {
							type: "plain_text",
							text: "Si vous souhaitez conserver les fichiers existants, ne téléchargez pas de nouveaux fichiers.",
						},
					},
					{
						type: "input",
						block_id: "new_proforma_url",
						optional: true,
						label: {
							type: "plain_text",
							text: "🔗 Nouvelle URL",
						},
						element: {
							type: "plain_text_input",
							action_id: "input_new_proforma_url",
							placeholder: { type: "plain_text", text: "https://..." },
						},
						hint: {
							type: "plain_text",
							text: "Ajouter une nouvelle URL à cette proforma.",
						},
					},
					{
						type: "input",
						block_id: "keep_existing_files",
						optional: true,
						label: {
							type: "plain_text",
							text: "Conservation des fichiers existants",
						},
						element: {
							type: "checkboxes",
							action_id: "input_keep_existing",
							initial_options: [
								{
									text: {
										type: "plain_text",
										text: "Conserver les fichiers/URLs existants",
									},
									value: "keep",
								},
							],
							options: [
								{
									text: {
										type: "plain_text",
										text: "Conserver les fichiers/URLs existants",
									},
									value: "keep",
								},
							],
						},
					},
				],
				private_metadata: JSON.stringify({
					orderId,
					proformaIndex,
					existingUrls: proforma.urls || [],
					existingFileIds: proforma.file_ids || [],
				}),
			};

			const response = await postSlackMessageWithRetry(
				"https://slack.com/api/views.open",
				{
					trigger_id: payload.trigger_id,
					view: modalView,
				},
				process.env.SLACK_BOT_TOKEN
			);

			if (!response.ok) {
				throw new Error(`Failed to open edit form: ${response.error}`);
			}
		}

		return { text: "Chargement du formulaire de modification..." };
	} catch (error) {
		context.log(`Error in handleEditProforma: ${error.message}`);
		return {
			text: `❌ Erreur lors de l'ouverture du formulaire: ${error.message}`,
			replace_original: false,
			response_type: "ephemeral",
		};
	}
}
// Add a new handler for the confirmation modal

async function handleProformaValidationRequest(payload, context) {
	console.log("** handleProformaValidationRequest");
	try {
		const value = JSON.parse(payload.actions[0].value);
		const order = await Order.findOne({ id_commande: value.orderId });
		if (!order) {
			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: "❌ Erreur : Commande non trouvée.",
			});
		}

		// Check if a proforma is already validated
		const alreadyValidated = order.proformas.some((p) => p.validated);
		if (alreadyValidated) {
			return await postSlackMessage(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_ADMIN_ID,
					text: "❌ Une proforma a déjà été validée pour cette commande.",
				},
				process.env.SLACK_BOT_TOKEN
			);
		} else {
			console.log("value1", value);

			const response = await postSlackMessage(
				"https://slack.com/api/views.open",
				{
					trigger_id: payload.trigger_id,
					view: {
						type: "modal",
						callback_id: "proforma_validation_confirm",
						private_metadata: JSON.stringify({
							orderId: value.orderId,
							proformaIndex: value.proformaIndex,
							proformaName: value.proformaName, // Optional, for display
							proformaAmount: value.proformaAmount, // Optional, for display
						}),
						title: {
							type: "plain_text",
							text: " Validation",
							emoji: true,
						},
						submit: {
							type: "plain_text",
							text: "Valider",
							emoji: true,
						},
						close: {
							type: "plain_text",
							text: "Annuler",
							emoji: true,
						},
						blocks: [
							{
								type: "section",
								text: {
									type: "mrkdwn",
									text: `Êtes-vous sûr de vouloir valider cette proforma?`,
								},
							},
							{
								type: "section",
								text: {
									type: "mrkdwn",

									text: `*Commande:* ${
										value.orderId
									}\n*Proforma:*\n*URLs:*\n${order.proformas?.[
										value.proformaIndex
									]?.urls
										.map((url, j) => `  ${j + 1}. <${url}|Page ${j + 1}>`)
										.join("\n")} \n*Montant:* ${
										order.proformas?.[value.proformaIndex]?.montant
									} ${order.proformas?.[value.proformaIndex]?.devise}`,
								},
							},
							{
								type: "input",
								block_id: "validation_data",
								optional: true,
								label: {
									type: "plain_text",
									text: "Commentaire ",
									emoji: true,
								},
								element: {
									type: "plain_text_input",
									action_id: "comment",
								},
							},
						],
					},
				},
				process.env.SLACK_BOT_TOKEN
			);

			if (!response.ok) {
				context.log(`Failed to open confirmation modal: ${response.error}`);
				throw new Error(`Modal open failure: ${response.error}`);
			}

			return response;
		}
	} catch (error) {
		context.log(
			`Error in handleProformaValidationRequest: ${error.message}`,
			error.stack
		);
		throw error;
	}
}
async function postSlackMessage2(url, data, token) {
	console.log("** postSlackMessage2");
	if (!token) {
		console.log("❌ SLACK_BOT_TOKEN is missing");
		throw new Error("Slack bot token is missing");
	}

	console.log(
		`Calling Slack API: ${url} with data: ${JSON.stringify(data, null, 2)}`
	);
	try {
		const response = await axios.post(url, data, {
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			timeout: 10000, // 10-second timeout
		});
		console.log(`postSlackMessage2 success: ${JSON.stringify(response.data)}`);
		return response;
	} catch (error) {
		console.log(`Failed to post to Slack API: ${error.message}`);
		if (error.response) {
			console.log(`Slack API response: ${JSON.stringify(error.response.data)}`);
		} else if (error.request) {
			console.log(`No response received: ${error.request}`);
		} else {
			console.log(`Request setup error: ${error.message}`);
		}
		throw error; // Re-throw for caller to handle
	}
}
// Helper function to get the display name for an equipe value
function getEquipeDisplayName(equipeValue) {
	console.log("** getEquipeDisplayName");
	const equipeMap = {
		macons: "Maçons",
		carreleur: "Carreleur",
		peintre: "Peintre",
		coffreur: "Coffreur",
	};
	return equipeMap[equipeValue] || equipeValue;
}

// Helper function to get the unit option object
function getUnitOption(unitValue) {
	console.log("** getUnitOption");
	const unitDisplayMap = {
		piece: "Pièce",
		m2: "m²",
		pots: "Pots",
		rouleaux: "Rouleaux",
		cartons: "Cartons",
		sac: "Sac",
		kg: "kg",
		bottes: "Bottes",
		tonnes: "Tonnes",
	};

	return {
		text: {
			type: "plain_text",
			text: unitDisplayMap[unitValue] || unitValue,
			emoji: true,
		},
		value: unitValue,
	};
}

// Define unit options if not already defined
const UNIT_OPTIONS = [
	{ text: { type: "plain_text", text: "Pièce", emoji: true }, value: "piece" },
	{ text: { type: "plain_text", text: "m²", emoji: true }, value: "m2" },
	{ text: { type: "plain_text", text: "Pots", emoji: true }, value: "pots" },
	{
		text: { type: "plain_text", text: "Rouleaux", emoji: true },
		value: "rouleaux",
	},
	{
		text: { type: "plain_text", text: "Cartons", emoji: true },
		value: "cartons",
	},
	{ text: { type: "plain_text", text: "Sac", emoji: true }, value: "sac" },
	{ text: { type: "plain_text", text: "kg", emoji: true }, value: "kg" },
	{
		text: { type: "plain_text", text: "Bottes", emoji: true },
		value: "bottes",
	},
	{
		text: { type: "plain_text", text: "Tonnes", emoji: true },
		value: "tonnes",
	},
];
async function getFromStorage(key) {
	console.log("** getFromStorage");
	try {
		let result = await FormData1.findOne({ key }).exec();
		if (!result) {
			console.log(
				`Form data not found on first attempt for key: ${key}, retrying...`
			);
			await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1s
			result = await FormData1.findOne({ key }).exec();
		}
		if (!result) {
			console.log(`Form data not found for key: ${key}`);
			return null;
		}
		console.log(`Retrieved form data for key: ${key}`);
		return result.data;
	} catch (err) {
		console.log(`Error retrieving form data for key ${key}:`, err);
		throw err;
	}
}
async function updateOriginalMessage(paymentId, status) {
	console.log("** updateOriginalMessage");
	await axios.post(
		"https://slack.com/api/chat.update",
		{
			channel: process.env.SLACK_ADMIN_ID,
			ts: originalMessageTs, // You need to store this when first posting
			text: `Demande de paiement *${paymentId}* - ${status}`,
			blocks: [], // Update with new blocks if needed
		},
		{
			headers: {
				Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
			},
		}
	);
}
async function fetchEntity(entityId, context) {
	console.log("** fetchEntity");
	try {
		// For orders (CMD/xxx)
		if (entityId.startsWith("CMD/")) {
			return await Order.findOne({ id_commande: entityId });
		}
		// For payment requests (PAY/xxx)
		else if (entityId.startsWith("PAY/")) {
			return await PaymentRequest.findOne({ id_paiement: entityId });
		} else if (entityId.startsWith("FUND/")) {
			return await Caisse.findOne({
				"fundingRequests.requestId": entityId,
			});
		}
		// Invalid entity ID format
		else {
			context.log(`Invalid entity ID format: ${entityId}`);
			return null;
		}
	} catch (error) {
		context.log(`Error fetching entity ${entityId}: ${error.message}`);
		throw new Error(`Failed to fetch entity: ${error.message}`);
	}
}

// Handler for the "report_problem" button click
async function handleReportProblem(payload, context, messageTs) {
	console.log("** handleReportProblem");
	const entityId = payload.actions[0].value;
	const actionId = payload.actions[0].action_id;
	console.log("payload", payload);
	// Determine the callback_id based on which action triggered this handler
	const callback_id =
		actionId === "report_fund_problem"
			? "fund_problem_submission"
			: "payment_problem_submission";

	try {
		let entity;
		let request;
		if (callback_id == "payment_problem_submission") {
			// Fetch entity data (order or payment request)
			entity = await fetchEntity(entityId, context);
			if (!entity) {
				context.log(`Entity ${entityId} not found`);
				return {
					response_action: "errors",
					errors: {
						_error: `Entity ${entityId} not found`,
					},
				};
			}
		} else if (callback_id == "fund_problem_submission") {
			entity = await Caisse.findOne({
				"fundingRequests.requestId": entityId,
			});
			request = entity.fundingRequests.find((r) => r.requestId === entityId);
			if (request.status === "Validé") {
				context.log(`Funding blocked for request ${entityId}`);
				await postSlackMessageWithRetry(
					"https://slack.com/api/chat.postEphemeral",
					{
						channel: process.env.SLACK_FINANCE_CHANNEL_ID,
						user: payload.user.id,
						text: `🚫 La demande a été finalisée`,
					},
					process.env.SLACK_BOT_TOKEN,
					context
				);
				return {};
			}
		}

		if (
			callback_id == "payment_problem_submission" &&
			entity.paymentDone == "true"
		) {
			context.log(`Payment blocked for order ${entityId}`);
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: process.env.SLACK_FINANCE_CHANNEL_ID,
					user: payload.user.id,
					text: `🚫 La commande a été payée`,
				},
				process.env.SLACK_BOT_TOKEN,
				context
			);
			return {};
		} else {
			// // Get the last payment
			// const lastPayment = entity.payments[entity.payments.length - 1];

			// Open a modal for problem reporting
			// Open confirmation modal
			const view = {
				type: "modal",
				callback_id: callback_id,
				private_metadata: JSON.stringify({
					entityId: entityId,
					paymentIndex:
						callback_id === "payment_problem_submission"
							? entity.payments.length - 1
							: undefined,
					channelId: payload.channel.id,
					userId: payload.user.username,
					messageTs: messageTs,
				}),
				title: {
					type: "plain_text",
					text: "Signaler un problème",
					emoji: true,
				},
				submit: {
					type: "plain_text",
					text: "Envoyer",
					emoji: true,
				},
				close: {
					type: "plain_text",
					text: "Annuler",
					emoji: true,
				},
				blocks: [
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `*Signalement d'un problème pour ${entityId}*`,
						},
					},
					{
						type: "divider",
					},
					{
						type: "input",
						block_id: "problem_type",
						element: {
							type: "static_select",
							action_id: "select_problem_type",

							options:
								callback_id === "fund_problem_submission"
									? [
											{
												text: {
													type: "plain_text",
													text: "Mode de paiement incorrect",
												},
												value: "wrong_payment_mode",
											},
											{
												text: {
													type: "plain_text",
													text: "Justificatif manquant ou incorrect",
												},
												value: "wrong_proof",
											},
											{
												text: {
													type: "plain_text",
													text: "Détails bancaires incorrects",
												},
												value: "wrong_bank_details",
											},
											{
												text: {
													type: "plain_text",
													text: "Autre problème",
												},
												value: "other",
											},
									  ]
									: [
											{
												text: {
													type: "plain_text",
													text: "Montant incorrect",
												},
												value: "wrong_amount",
											},
											{
												text: {
													type: "plain_text",
													text: "Mode de paiement incorrect",
												},
												value: "wrong_payment_mode",
											},
											{
												text: {
													type: "plain_text",
													text: "Justificatif manquant ou incorrect",
												},
												value: "wrong_proof",
											},
											{
												text: {
													type: "plain_text",
													text: "Détails bancaires incorrects",
												},
												value: "wrong_bank_details",
											},
											{
												text: {
													type: "plain_text",
													text: "Autre problème",
												},
												value: "other",
											},
									  ],
						},
						label: {
							type: "plain_text",
							text: "Type de problème",
							emoji: true,
						},
					},
					{
						type: "input",
						block_id: "problem_description",
						element: {
							type: "plain_text_input",
							action_id: "input_problem_description",
							multiline: true,
						},
						label: {
							type: "plain_text",
							text: "Description du problème",
							emoji: true,
						},
					},
				],
			};

			const response = await postSlackMessage2(
				"https://slack.com/api/views.open",
				{ trigger_id: payload.trigger_id, view },
				process.env.SLACK_BOT_TOKEN
			);
			if (!response.data.ok) {
				throw new Error(`Slack API error: ${response.data.error}`);
			}
			context.log(`Problem report modal opened for ${entityId}`);
			return { response_action: "update" };
		}
	} catch (error) {
		context.log(`Error handling report problem: ${error.message}`);
		return {
			response_action: "errors",
			errors: {
				_error: `Une erreur s'est produite: ${error.message}`,
			},
		};
	}
}

// Helper function to get bank options
function getBankOptions() {
	console.log("** getBankOptions");
	return [
		{ text: { type: "plain_text", text: "SGCI" }, value: "SGCI" },
		{ text: { type: "plain_text", text: "NSIA" }, value: "NSIA" },
		{ text: { type: "plain_text", text: "ECOBANK" }, value: "ECOBANK" },
		{ text: { type: "plain_text", text: "SIB" }, value: "SIB" },
		{ text: { type: "plain_text", text: "Autre" }, value: "Autre" },
	];
}

// Helper function to get initial bank option
function getBankInitialOption(bank) {
	console.log("** getBankInitialOption");
	if (!bank) {
		return null; // No initial option if bank is undefined or null
	}

	const validBankValues = bankOptions.map((option) => option.value);
	console.log("validBanks", bankOptions);
	console.log("checking bank", bank);

	// Check if the provided bank matches one of the valid options
	if (validBankValues.includes(bank)) {
		const matchedBank = bankOptions.find((option) => option.value === bank);
		return {
			text: { type: "plain_text", text: matchedBank.text.text },
			value: matchedBank.value,
		};
	}

	// If no match, return "Autre" (we'll ensure it's in the options list later)
	return {
		text: { type: "plain_text", text: "Autre" },
		value: "Autre",
	};
}

// Handler for modifying payment by admin
// async function handleModifyPayment(payload, context) {
//   console.log("** handleModifyPayment");
//   try {
//     const actionValue = JSON.parse(payload.actions[0].value);
//     const entityId = actionValue.entityId;
//     const paymentIndex = actionValue.paymentIndex;
//     const problemType = actionValue.problemType;
//     console.log("problemType1", problemType);
//     const reporterId = actionValue.reporterId;
//     const problemDescription = actionValue.problemDescription;

//     console.log("actionValue", actionValue);
//     // Fetch the entity
//     const entity = await fetchEntity(entityId, context);
//     if (!entity) {
//       throw new Error(`Entity ${entityId} not found`);
//     }

//     // Get payment data
//     const paymentData = entity.payments[paymentIndex];
//     // Create blocks for existing payment proofs
//     const proofsBlocks = [];

//     // Add header for existing proofs if there are any
//     if (paymentData.paymentProofs && paymentData.paymentProofs.length > 0) {
//       proofsBlocks.push({
//         type: "section",
//         block_id: "existing_proofs_header",
//         text: {
//           type: "mrkdwn",
//           text: "*Justificatifs de paiement existants:*",
//         },
//       });
//       // Add each existing proof as a separate input field
//       paymentData.paymentProofs.forEach((proofUrl, index) => {
//         // Determine if it's a file or URL based on the structure
//         const isFile =
//           proofUrl.startsWith("https://files.slack.com") ||
//           proofUrl.includes("slack-files");

//         proofsBlocks.push({
//           type: "input",
//           block_id: `existing_proof_${index}`,
//           optional: true,
//           label: {
//             type: "plain_text",
//             text: isFile ? `📎 Fichier ${index + 1}` : `🔗 URL ${index + 1}`,
//           },
//           element: {
//             type: "plain_text_input",
//             action_id: `edit_proof_${index}`,
//             initial_value: proofUrl,
//           },
//         });
//       });

//       // Add divider after existing proofs
//       proofsBlocks.push({
//         type: "divider",
//       });
//     }
//     // Create a modal to modify payment details
//     let blocks = [
//       {
//         type: "section",
//         text: {
//           type: "mrkdwn",
//           text: `*Modification du paiement pour ${entityId}*\nProblème signalé:* ${getProblemTypeText(
//             problemType
//           )}\n*Description du problème:*\n${problemDescription}`,
//         },
//       },
//       {
//         type: "divider",
//       },
//       {
//         type: "input",
//         block_id: "payment_title",
//         element: {
//           type: "plain_text_input",
//           action_id: "input_payment_title",
//           initial_value: paymentData.paymentTitle || paymentData.title || "",
//         },
//         label: {
//           type: "plain_text",
//           text: "Titre du paiement",
//           emoji: true,
//         },
//       },
//       {
//         type: "input",
//         block_id: "payment_mode",
//         element: {
//           type: "static_select",
//           action_id: "select_payment_mode",

//           options: [
//             {
//               text: { type: "plain_text", text: "Chèque" },
//               value: "Chèque",
//             },
//             {
//               text: { type: "plain_text", text: "Virement" },
//               value: "Virement",
//             },
//             {
//               text: { type: "plain_text", text: "Mobile Money" },
//               value: "Mobile Money",
//             },
//             {
//               text: { type: "plain_text", text: "Julaya" },
//               value: "Julaya",
//             },
//             {
//               text: { type: "plain_text", text: "Espèces" },
//               value: "Espèces",
//             },
//           ],
//           initial_option: {
//             text: {
//               type: "plain_text",
//               text: paymentData.paymentMode || paymentData.mode || "Chèque",
//             },
//             value: paymentData.paymentMode || paymentData.mode || "Chèque",
//           },
//         },
//         label: {
//           type: "plain_text",
//           text: "Mode de paiement",
//           emoji: true,
//         },
//       },
//       {
//         type: "actions",
//         block_id: "confirm_payment_mode_2",
//         elements: [
//           {
//             type: "button",
//             action_id: "confirm_payment_mode_2",
//             text: { type: "plain_text", text: "Ajouter les détails" },
//             value: "confirm_payment_mode_2",
//           },
//         ],
//       },
//       {
//         type: "input",
//         block_id: "amount_paid",
//         element: {
//           type: "number_input", // Changed from "plain_text_input" to "number_input"
//           action_id: "input_amount_paid",
//           initial_value: (paymentData.amountPaid || 0).toString(), // Still needs to be a string
//           is_decimal_allowed: true, // Optional: allows decimal numbers (e.g., 10.50)
//           min_value: "0",
//         },
//         label: {
//           type: "plain_text",
//           text: "Montant payé",
//           emoji: true,
//         },
//       },
//       {
//         type: "input",
//         optional: true,
//         block_id: "paiement_url",
//         element: {
//           type: "plain_text_input",
//           action_id: "input_paiement_url",
//           initial_value: paymentData.paymentUrl || paymentData.url || "",
//         },
//         label: {
//           type: "plain_text",
//           text: "URL du paiement",
//           emoji: true,
//         },
//       },
//     ];

//     // Ajouter les justificatifs existants
//     blocks = blocks.concat(proofsBlocks);

//     // Ajouter les options pour télécharger de nouveaux justificatifs
//     blocks.push(
//       {
//         type: "section",
//         text: {
//           type: "mrkdwn",
//           text: "Télécharger de nouveaux justificatifs ou ajouter de nouvelles URLs",
//         },
//       },
//       {
//         type: "input",
//         block_id: "payment_proof_file",
//         optional: true,
//         label: {
//           type: "plain_text",
//           text: "📎 Nouveaux fichiers",
//         },
//         element: {
//           type: "file_input",
//           action_id: "file_upload_proof",
//           filetypes: ["pdf", "jpg", "png"],
//           max_files: 5,
//         },
//         hint: {
//           type: "plain_text",
//           text: "Si vous souhaitez conserver les fichiers existants, ne téléchargez pas de nouveaux fichiers.",
//         },
//       },
//       {
//         type: "input",
//         block_id: "new_payment_url",
//         optional: true,
//         label: {
//           type: "plain_text",
//           text: "🔗 Nouvelle URL",
//         },
//         element: {
//           type: "plain_text_input",
//           action_id: "input_new_payment_url",
//           placeholder: { type: "plain_text", text: "https://..." },
//         },
//         hint: {
//           type: "plain_text",
//           text: "Ajouter une nouvelle URL comme justificatif externe.",
//         },
//       },

//     );

//     // Add additional fields based on payment mode
//     const paymentMode = paymentData.paymentMode || paymentData.mode;
//     const details = paymentData.details || {};
//     console.log("details1", details);
//     // Dynamic fields based on payment mode
//     if (paymentMode === "Chèque") {
//       blocks.push(
//         {
//           type: "input",
//           block_id: "cheque_number",
//           element: {
//             type: "plain_text_input",
//             action_id: "input_cheque_number",
//             initial_value: details.cheque_number || "",
//           },
//           label: {
//             type: "plain_text",
//             text: "Numéro de chèque",
//             emoji: true,
//           },
//         },
//         {
//           type: "input",
//           block_id: "cheque_bank",
//           element: {
//             type: "static_select",
//             action_id: "input_cheque_bank",

//             options: bankOptions,
//             initial_option:
//               getBankInitialOption(details.cheque_bank) || bankOptions[0],
//           },
//           label: {
//             type: "plain_text",
//             text: "Banque",
//             emoji: true,
//           },
//         },
//         {
//           type: "input",
//           block_id: "cheque_date",
//           label: {
//             type: "plain_text",
//             text: "Date du chèque",
//             emoji: true,
//           },
//           element: {
//             type: "datepicker",
//             action_id: "input_cheque_date",

//             initial_date: details.cheque_date
//               ? new Date(details.cheque_date).toISOString().split("T")[0]
//               : undefined,
//           },
//         },
//         {
//           type: "input",
//           block_id: "cheque_order",
//           label: { type: "plain_text", text: "Ordre" },
//           element: {
//             type: "plain_text_input",
//             action_id: "input_cheque_order",
//             initial_value: details.cheque_order || "",
//           },
//         }
//       );
//     } else if (paymentMode === "Virement") {
//       blocks.push(
//         {
//           type: "input",
//           block_id: "virement_number",
//           element: {
//             type: "plain_text_input",
//             action_id: "input_virement_number",
//             initial_value: details.virement_number || "",
//           },
//           label: {
//             type: "plain_text",
//             text: "Numéro de virement",
//             emoji: true,
//           },
//         },
//         {
//           type: "input",
//           block_id: "virement_bank",
//           element: {
//             type: "static_select",
//             action_id: "input_virement_bank",

//             options: bankOptions,
//             initial_option: getBankInitialOption(details.virement_bank),
//           },
//           label: {
//             type: "plain_text",
//             text: "Banque",
//             emoji: true,
//           },
//         },
//         {
//           type: "input",
//           block_id: "virement_date",
//           label: {
//             type: "plain_text",
//             text: "Date du chèque",
//             emoji: true,
//           },
//           element: {
//             type: "datepicker",
//             action_id: "input_virement_date",

//             initial_date: details.virement_date
//               ? new Date(details.virement_date).toISOString().split("T")[0]
//               : undefined,
//           },
//         },
//         {
//           type: "input",
//           block_id: "virement_order",
//           label: { type: "plain_text", text: "Ordre" },
//           element: {
//             type: "plain_text_input",
//             action_id: "input_virement_order",
//             initial_value: details.virement_order || "",
//           },
//         }
//       );
//     } else if (paymentMode === "Mobile Money") {
//       blocks.push(
//         {
//           type: "input",
//           block_id: "mobilemoney_recipient_phone",
//           element: {
//             type: "plain_text_input",
//             action_id: "input_mobilemoney_recipient_phone",
//             initial_value: details.mobilemoney_recipient_phone || "",
//           },
//           label: {
//             type: "plain_text",
//             text: "Numéro de téléphone bénéficiaire",
//             emoji: true,
//           },
//         },
//         {
//           type: "input",
//           block_id: "mobilemoney_sender_phone",
//           element: {
//             type: "plain_text_input",
//             action_id: "input_mobilemoney_sender_phone",
//             initial_value: details.mobilemoney_sender_phone || "",
//           },
//           label: {
//             type: "plain_text",
//             text: "Numéro envoyeur",
//             emoji: true,
//           },
//         },
//         {
//           type: "input",
//           block_id: "mobilemoney_date",
//           label: {
//             type: "plain_text",
//             text: "Date",
//             emoji: true,
//           },
//           element: {
//             type: "datepicker",
//             action_id: "input_mobilemoney_date",

//             initial_date: details.mobilemoney_date
//               ? new Date(details.mobilemoney_date).toISOString().split("T")[0]
//               : undefined,
//           },
//         }
//       );
//     } else if (paymentMode === "Julaya") {
//       blocks.push(
//         {
//           type: "input",
//           block_id: "julaya_recipient",
//           element: {
//             type: "plain_text_input",
//             action_id: "input_julaya_recipient",
//             initial_value: details.julaya_recipient || "",
//           },
//           label: {
//             type: "plain_text",
//             text: "Bénéficiaire",
//             emoji: true,
//           },
//         },
//         {
//           type: "input",
//           block_id: "julaya_transaction_number",
//           element: {
//             type: "plain_text_input",
//             action_id: "input_julaya_transaction_number",
//             initial_value: details.julaya_transaction_number || "",
//           },
//           label: {
//             type: "plain_text",
//             text: "Numéro de transaction",
//             emoji: true,
//           },
//         },
//         {
//           type: "input",
//           block_id: "julaya_date",
//           label: {
//             type: "plain_text",
//             text: "Date",
//             emoji: true,
//           },
//           element: {
//             type: "datepicker",
//             action_id: "input_julaya_date",

//             initial_date: details.julaya_date
//               ? new Date(details.julaya_date).toISOString().split("T")[0]
//               : undefined,
//           },
//         }
//       );
//     }
//     console.log("paymentData.paymentProofs", paymentData.paymentProofs);
//     console.log("paymentData.paymentUrl",paymentData.paymentUrl);

//     const view = {
//       type: "modal",
//       callback_id: "payment_modification_submission",
//       private_metadata: JSON.stringify({
//         entityId: entityId,
//         paymentIndex: paymentIndex,
//         reporterId: reporterId,
//         channelId: payload.channel.id,
//         existingProofs: paymentData.paymentProofs || [],
//         existingUrls: paymentData.paymentUrl || [],
//         problemType: problemType,
//         problemDescription: problemDescription,

//       }),
//       title: {
//         type: "plain_text",
//         text: "Modifier le paiement",
//         emoji: true,
//       },
//       submit: {
//         type: "plain_text",
//         text: "Enregistrer",
//         emoji: true,
//       },
//       close: {
//         type: "plain_text",
//         text: "Annuler",
//         emoji: true,
//       },
//       blocks: blocks,
//     };
//     const response = await postSlackMessage2(
//       "https://slack.com/api/views.open",
//       { trigger_id: payload.trigger_id, view },
//       process.env.SLACK_BOT_TOKEN
//     );
//     if (!response.data.ok) {
//       throw new Error(`Slack API error: ${response.data.error}`);
//     }
//     context.log(`Payment modification modal opened for ${entityId}`);
//     // return { response_action: "update" };
//     return {
//       statusCode: 200,
//       headers: { "Content-Type": "application/json" },
//       body: "",
//     };
//   } catch (error) {
//     context.log(`Error handling modify payment: ${error.message}`);
//     return {
//       response_action: "errors",
//       errors: {
//         _error: `Une erreur s'est produite: ${error.message}`,
//       },
//     };
//   }
// }
// async function handleModifyPayment2(payload, context,selectedMode2,privateMetadata2) {
//   console.log("** handleModifyPayment2");
//   try {
//     const paymentIndex = privateMetadata2.paymentIndex;
//     const entityId = privateMetadata2.entityId;
//     const problemType = privateMetadata2.problemType;
//     const problemDescription = privateMetadata2.problemDescription;
//     const reporterId = privateMetadata2.reporterId;
//     console.log("privateMetadata2", privateMetadata2);
//     // Fetch the entity
//     const entity = await fetchEntity(entityId, context);
//     if (!entity) {
//       throw new Error(`Entity ${entityId} not found`);
//     }

//     // Get payment data
//     const paymentData = entity.payments[paymentIndex];
//     // Create blocks for existing payment proofs
//     const proofsBlocks = [];

//     // Add header for existing proofs if there are any
//     if (paymentData.paymentProofs && paymentData.paymentProofs.length > 0) {
//       proofsBlocks.push({
//         type: "section",
//         block_id: "existing_proofs_header",
//         text: {
//           type: "mrkdwn",
//           text: "*Justificatifs de paiement existants:*",
//         },
//       });
//       // Add each existing proof as a separate input field
//       paymentData.paymentProofs.forEach((proofUrl, index) => {
//         // Determine if it's a file or URL based on the structure
//         const isFile =
//           proofUrl.startsWith("https://files.slack.com") ||
//           proofUrl.includes("slack-files");

//         proofsBlocks.push({
//           type: "input",
//           block_id: `existing_proof_${index}`,
//           optional: true,
//           label: {
//             type: "plain_text",
//             text: isFile ? `📎 Fichier ${index + 1}` : `🔗 URL ${index + 1}`,
//           },
//           element: {
//             type: "plain_text_input",
//             action_id: `edit_proof_${index}`,
//             initial_value: proofUrl,
//           },
//         });
//       });

//       // Add divider after existing proofs
//       proofsBlocks.push({
//         type: "divider",
//       });
//     }
//     // Create a modal to modify payment details
//     let blocks = [
//       {
//         type: "section",
//         text: {
//           type: "mrkdwn",
//           text: `*Modification du paiement pour ${entityId}*\nProblème signalé:* ${getProblemTypeText(
//             problemType
//           )}\n*Description du problème:*\n${problemDescription}`,
//         },
//       },
//       {
//         type: "divider",
//       },
//       {
//         type: "input",
//         block_id: "payment_title",
//         element: {
//           type: "plain_text_input",
//           action_id: "input_payment_title",
//           initial_value: paymentData.paymentTitle || paymentData.title || "",
//         },
//         label: {
//           type: "plain_text",
//           text: "Titre du paiement",
//           emoji: true,
//         },
//       },
//       {
//         type: "input",
//         block_id: "payment_mode",
//         element: {
//           type: "static_select",
//           action_id: "select_payment_mode",

//           options: [
//             {
//               text: { type: "plain_text", text: "Chèque" },
//               value: "Chèque",
//             },
//             {
//               text: { type: "plain_text", text: "Virement" },
//               value: "Virement",
//             },
//             {
//               text: { type: "plain_text", text: "Mobile Money" },
//               value: "Mobile Money",
//             },
//             {
//               text: { type: "plain_text", text: "Julaya" },
//               value: "Julaya",
//             },
//             {
//               text: { type: "plain_text", text: "Espèces" },
//               value: "Espèces",
//             },
//           ],
//           initial_option: {
//             text: {
//               type: "plain_text",
//               text: paymentData.paymentMode || paymentData.mode || "Chèque",
//             },
//             value: paymentData.paymentMode || paymentData.mode || "Chèque",
//           },
//         },
//         label: {
//           type: "plain_text",
//           text: "Mode de paiement",
//           emoji: true,
//         },
//       },
//       {
//         type: "actions",
//         block_id: "confirm_payment_mode_2",
//         elements: [
//           {
//             type: "button",
//             action_id: "confirm_payment_mode_2",
//             text: { type: "plain_text", text: "Ajouter les détails" },
//             value: "confirm_payment_mode_2",
//           },
//         ],
//       },
//       {
//         type: "input",
//         block_id: "amount_paid",
//         element: {
//           type: "number_input", // Changed from "plain_text_input" to "number_input"
//           action_id: "input_amount_paid",
//           initial_value: (paymentData.amountPaid || 0).toString(), // Still needs to be a string
//           is_decimal_allowed: true, // Optional: allows decimal numbers (e.g., 10.50)
//           min_value: "0",
//         },
//         label: {
//           type: "plain_text",
//           text: "Montant payé",
//           emoji: true,
//         },
//       },
//       {
//         type: "input",
//         optional: true,
//         block_id: "paiement_url",
//         element: {
//           type: "plain_text_input",
//           action_id: "input_paiement_url",
//           initial_value: paymentData.paymentUrl || paymentData.url || "",
//         },
//         label: {
//           type: "plain_text",
//           text: "URL du paiement",
//           emoji: true,
//         },
//       },
//     ];

//     // Ajouter les justificatifs existants
//     blocks = blocks.concat(proofsBlocks);

//     // Ajouter les options pour télécharger de nouveaux justificatifs
//     blocks.push(
//       {
//         type: "section",
//         text: {
//           type: "mrkdwn",
//           text: "Télécharger de nouveaux justificatifs ou ajouter de nouvelles URLs",
//         },
//       },
//       {
//         type: "input",
//         block_id: "payment_proof_file",
//         optional: true,
//         label: {
//           type: "plain_text",
//           text: "📎 Nouveaux fichiers",
//         },
//         element: {
//           type: "file_input",
//           action_id: "file_upload_proof",
//           filetypes: ["pdf", "jpg", "png"],
//           max_files: 5,
//         },
//         hint: {
//           type: "plain_text",
//           text: "Si vous souhaitez conserver les fichiers existants, ne téléchargez pas de nouveaux fichiers.",
//         },
//       },
//       {
//         type: "input",
//         block_id: "new_payment_url",
//         optional: true,
//         label: {
//           type: "plain_text",
//           text: "🔗 Nouvelle URL",
//         },
//         element: {
//           type: "plain_text_input",
//           action_id: "input_new_payment_url",
//           placeholder: { type: "plain_text", text: "https://..." },
//         },
//         hint: {
//           type: "plain_text",
//           text: "Ajouter une nouvelle URL comme justificatif externe.",
//         },
//       },

//     );

//     // Add additional fields based on payment mode
//     const paymentMode = selectedMode2;

//     // Dynamic fields based on payment mode
//     if (paymentMode === "Chèque") {
//       blocks.push(
//         {
//           type: "input",
//           block_id: "cheque_number",
//           element: {
//             type: "plain_text_input",
//             action_id: "input_cheque_number",
//           },
//           label: {
//             type: "plain_text",
//             text: "Numéro de chèque",
//             emoji: true,
//           },
//         },
//         {
//           type: "input",
//           block_id: "cheque_bank",
//           element: {
//             type: "static_select",
//             action_id: "input_cheque_bank",

//             options: bankOptions,

//           },
//           label: {
//             type: "plain_text",
//             text: "Banque",
//             emoji: true,
//           },
//         },
//         {
//           type: "input",
//           block_id: "cheque_date",
//           label: {
//             type: "plain_text",
//             text: "Date du chèque",
//             emoji: true,
//           },
//           element: {
//             type: "datepicker",
//             action_id: "input_cheque_date",

//           },
//         },
//         {
//           type: "input",
//           block_id: "cheque_order",
//           label: { type: "plain_text", text: "Ordre" },
//           element: {
//             type: "plain_text_input",
//             action_id: "input_cheque_order",

//           },
//         }
//       );
//     } else if (paymentMode === "Virement") {
//       blocks.push(
//         {
//           type: "input",
//           block_id: "virement_number",
//           element: {
//             type: "plain_text_input",
//             action_id: "input_virement_number",

//           },
//           label: {
//             type: "plain_text",
//             text: "Numéro de virement",
//             emoji: true,
//           },
//         },
//         {
//           type: "input",
//           block_id: "virement_bank",
//           element: {
//             type: "static_select",
//             action_id: "input_virement_bank",

//             options: bankOptions,

//           },
//           label: {
//             type: "plain_text",
//             text: "Banque",
//             emoji: true,
//           },
//         },
//         {
//           type: "input",
//           block_id: "virement_date",
//           label: {
//             type: "plain_text",
//             text: "Date du chèque",
//             emoji: true,
//           },
//           element: {
//             type: "datepicker",
//             action_id: "input_virement_date",

//           },
//         },
//         {
//           type: "input",
//           block_id: "virement_order",
//           label: { type: "plain_text", text: "Ordre" },
//           element: {
//             type: "plain_text_input",
//             action_id: "input_virement_order",
//           },
//         }
//       );
//     } else if (paymentMode === "Mobile Money") {
//       blocks.push(
//         {
//           type: "input",
//           block_id: "mobilemoney_recipient_phone",
//           element: {
//             type: "plain_text_input",
//             action_id: "input_mobilemoney_recipient_phone",
//           },
//           label: {
//             type: "plain_text",
//             text: "Numéro de téléphone bénéficiaire",
//             emoji: true,
//           },
//         },
//         {
//           type: "input",
//           block_id: "mobilemoney_sender_phone",
//           element: {
//             type: "plain_text_input",
//             action_id: "input_mobilemoney_sender_phone",
//           },
//           label: {
//             type: "plain_text",
//             text: "Numéro envoyeur",
//             emoji: true,
//           },
//         },
//         {
//           type: "input",
//           block_id: "mobilemoney_date",
//           label: {
//             type: "plain_text",
//             text: "Date",
//             emoji: true,
//           },
//           element: {
//             type: "datepicker",
//             action_id: "input_mobilemoney_date",

//           },
//         }
//       );
//     } else if (paymentMode === "Julaya") {
//       blocks.push(
//         {
//           type: "input",
//           block_id: "julaya_recipient",
//           element: {
//             type: "plain_text_input",
//             action_id: "input_julaya_recipient",
//           },
//           label: {
//             type: "plain_text",
//             text: "Bénéficiaire",
//             emoji: true,
//           },
//         },
//         {
//           type: "input",
//           block_id: "julaya_transaction_number",
//           element: {
//             type: "plain_text_input",
//             action_id: "input_julaya_transaction_number",
//           },
//           label: {
//             type: "plain_text",
//             text: "Numéro de transaction",
//             emoji: true,
//           },
//         },
//         {
//           type: "input",
//           block_id: "julaya_date",
//           label: {
//             type: "plain_text",
//             text: "Date",
//             emoji: true,
//           },
//           element: {
//             type: "datepicker",
//             action_id: "input_julaya_date",

//           },
//         }
//       );
//     }
//     console.log("paymentData", paymentData);
//     console.log("paymentData.paymentProofs", paymentData.paymentProofs);
//     console.log("paymentData.paymentUrl",paymentData.paymentUrl);

//     const view = {
//       type: "modal",
//       callback_id: "payment_modification_submission",
//       private_metadata: JSON.stringify({
//         entityId: entityId,
//         paymentIndex: paymentIndex,
//         reporterId: reporterId,
//         channelId: process.env.SLACK_ADMIN_ID,
//         existingProofs: paymentData.paymentProofs || [],
//         existingUrls: paymentData.paymentUrl || [],

//       }),
//       title: {
//         type: "plain_text",
//         text: "Modifier le paiement",
//         emoji: true,
//       },
//       submit: {
//         type: "plain_text",
//         text: "Enregistrer",
//         emoji: true,
//       },
//       close: {
//         type: "plain_text",
//         text: "Annuler",
//         emoji: true,
//       },
//       blocks: blocks,
//     };
//     const response = await postSlackMessage2(
//       "https://slack.com/api/views.open",
//       { trigger_id: payload.trigger_id, view },
//       process.env.SLACK_BOT_TOKEN
//     );
//     if (!response.data.ok) {
//       throw new Error(`Slack API error: ${response.data.error}`);
//     }
//     context.log(`Payment modification modal opened for ${entityId}`);
//     return { response_action: "update" };
//   } catch (error) {
//     context.log(`Error handling modify payment: ${error.message}`);
//     return {
//       response_action: "errors",
//       errors: {
//         _error: `Une erreur s'est produite: ${error.message}`,
//       },
//     };
//   }
// }
// Function to handle restoring a deleted order
// async function handleModifyPayment(payload, context, selectedPaymentMode = null) {
//   console.log("** handleModifyPayment");
//   try {
//     const actionValue = JSON.parse(payload.actions[0]?.value || "{}");
//     const { entityId, paymentIndex, problemType, problemDescription, reporterId } = actionValue;
//     console.log("problemType", problemType);

//     // Fetch the entity
//     const entity = await fetchEntity(entityId, context);
//     if (!entity) {
//       throw new Error(`Entity ${entityId} not found`);
//     }

//     // Get payment data
//     const paymentData = entity.payments[paymentIndex];
//     const details = paymentData.details || {};

//     // Determine the payment mode to use
//     const paymentMode = selectedPaymentMode || paymentData.paymentMode || paymentData.mode || "Chèque";

//     // Create blocks for existing payment proofs
//     const proofsBlocks = [];
//     if (paymentData.paymentProofs?.length > 0) {
//       proofsBlocks.push({
//         type: "section",
//         block_id: "existing_proofs_header",
//         text: {
//           type: "mrkdwn",
//           text: "*Justificatifs de paiement existants:*",
//         },
//       });
//       paymentData.paymentProofs.forEach((proofUrl, index) => {
//         const isFile = proofUrl.startsWith("https://files.slack.com") || proofUrl.includes("slack-files");
//         proofsBlocks.push({
//           type: "input",
//           block_id: `existing_proof_${index}`,
//           optional: true,
//           label: {
//             type: "plain_text",
//             text: isFile ? `📎 Fichier ${index + 1}` : `🔗 URL ${index + 1}`,
//           },
//           element: {
//             type: "plain_text_input",
//             action_id: `edit_proof_${index}`,
//             initial_value: proofUrl,
//           },
//         });
//       });
//       proofsBlocks.push({ type: "divider" });
//     }

//     // Create modal blocks
//     let blocks = [
//       {
//         type: "section",
//         text: {
//           type: "mrkdwn",
//           text: `*Modification du paiement pour ${entityId}*\n*Problème signalé:* ${getProblemTypeText(
//             problemType
//           )}\n*Description du problème:*\n${problemDescription || "Non spécifié"}`,
//         },
//       },
//       { type: "divider" },
//       {
//         type: "input",
//         block_id: "payment_title",
//         element: {
//           type: "plain_text_input",
//           action_id: "input_payment_title",
//           initial_value: paymentData.paymentTitle || paymentData.title || "",
//         },
//         label: {
//           type: "plain_text",
//           text: "Titre du paiement",
//           emoji: true,
//         },
//       },
//       {
//         type: "input",
//         block_id: "payment_mode",
//         element: {
//           type: "static_select",
//           action_id: "select_payment_mode",
//           options: [
//             { text: { type: "plain_text", text: "Chèque" }, value: "Chèque" },
//             { text: { type: "plain_text", text: "Virement" }, value: "Virement" },
//             { text: { type: "plain_text", text: "Mobile Money" }, value: "Mobile Money" },
//             { text: { type: "plain_text", text: "Julaya" }, value: "Julaya" },
//             { text: { type: "plain_text", text: "Espèces" }, value: "Espèces" },
//           ],
//           initial_option: {
//             text: { type: "plain_text", text: paymentMode },
//             value: paymentMode,
//           },
//         },
//         label: {
//           type: "plain_text",
//           text: "Mode de paiement",
//           emoji: true,
//         },
//       },
//       {
//         type: "actions",
//         block_id: "confirm_payment_mode_2",
//         elements: [
//           {
//             type: "button",
//             action_id: "confirm_payment_mode_2",
//             text: { type: "plain_text", text: "Ajouter les détails" },
//             value: "confirm_payment_mode_2",
//           },
//         ],
//       },
//       {
//         type: "input",
//         block_id: "amount_paid",
//         element: {
//           type: "number_input",
//           action_id: "input_amount_paid",
//           initial_value: (paymentData.amountPaid || 0).toString(),
//           is_decimal_allowed: true,
//           min_value: "0",
//         },
//         label: {
//           type: "plain_text",
//           text: "Montant payé",
//           emoji: true,
//         },
//       },
//       {
//         type: "input",
//         optional: true,
//         block_id: "paiement_url",
//         element: {
//           type: "plain_text_input",
//           action_id: "input_paiement_url",
//           initial_value: paymentData.paymentUrl || "",
//         },
//         label: {
//           type: "plain_text",
//           text: "URL du paiement",
//           emoji: true,
//         },
//       },
//     ];

//     // Add existing proofs
//     blocks = blocks.concat(proofsBlocks);

//     // Add options for new proofs
//     blocks.push(
//       {
//         type: "section",
//         text: {
//           type: "mrkdwn",
//           text: "Télécharger de nouveaux justificatifs ou ajouter de nouvelles URLs",
//         },
//       },
//       {
//         type: "input",
//         block_id: "payment_proof_file",
//         optional: true,
//         label: {
//           type: "plain_text",
//           text: "📎 Nouveaux fichiers",
//         },
//         element: {
//           type: "file_input",
//           action_id: "file_upload_proof",
//           filetypes: ["pdf", "jpg", "png"],
//           max_files: 5,
//         },
//         hint: {
//           type: "plain_text",
//           text: "Si vous souhaitez conserver les fichiers existants, ne téléchargez pas de nouveaux fichiers.",
//         },
//       },
//       {
//         type: "input",
//         block_id: "new_payment_url",
//         optional: true,
//         label: {
//           type: "plain_text",
//           text: "🔗 Nouvelle URL",
//         },
//         element: {
//           type: "plain_text_input",
//           action_id: "input_new_payment_url",
//           placeholder: { type: "plain_text", text: "https://..." },
//         },
//         hint: {
//           type: "plain_text",
//           text: "Ajouter une nouvelle URL comme justificatif externe.",
//         },
//       }
//     );

//     // Add payment-mode-specific fields with prefill if the mode matches the original
//     const isSameMode = paymentMode === (paymentData.paymentMode || paymentData.mode);
//     if (paymentMode === "Chèque") {
//       blocks.push(
//         {
//           type: "input",
//           block_id: "cheque_number",
//           element: {
//             type: "plain_text_input",
//             action_id: "input_cheque_number",
//             initial_value: isSameMode ? details.cheque_number || "" : "",
//           },
//           label: {
//             type: "plain_text",
//             text: "Numéro de chèque",
//             emoji: true,
//           },
//         },
//         {
//           type: "input",
//           block_id: "cheque_bank",
//           element: {
//             type: "static_select",
//             action_id: "input_cheque_bank",
//             options: bankOptions,
//             initial_option: isSameMode ? getBankInitialOption(details.cheque_bank) || bankOptions[0] : bankOptions[0],
//           },
//           label: {
//             type: "plain_text",
//             text: "Banque",
//             emoji: true,
//           },
//         },
//         {
//           type: "input",
//           block_id: "cheque_date",
//           label: {
//             type: "plain_text",
//             text: "Date du chèque",
//             emoji: true,
//           },
//           element: {
//             type: "datepicker",
//             action_id: "input_cheque_date",
//             initial_date: isSameMode && details.cheque_date
//               ? new Date(details.cheque_date).toISOString().split("T")[0]
//               : undefined,
//           },
//         },
//         {
//           type: "input",
//           block_id: "cheque_order",
//           label: { type: "plain_text", text: "Ordre" },
//           element: {
//             type: "plain_text_input",
//             action_id: "input_cheque_order",
//             initial_value: isSameMode ? details.cheque_order || "" : "",
//           },
//         }
//       );
//     } else if (paymentMode === "Virement") {
//       blocks.push(
//         {
//           type: "input",
//           block_id: "virement_number",
//           element: {
//             type: "plain_text_input",
//             action_id: "input_virement_number",
//             initial_value: isSameMode ? details.virement_number || "" : "",
//           },
//           label: {
//             type: "plain_text",
//             text: "Numéro de virement",
//             emoji: true,
//           },
//         },
//         {
//           type: "input",
//           block_id: "virement_bank",
//           element: {
//             type: "static_select",
//             action_id: "input_virement_bank",
//             options: bankOptions,
//             initial_option: isSameMode ? getBankInitialOption(details.virement_bank) || bankOptions[0] : bankOptions[0],
//           },
//           label: {
//             type: "plain_text",
//             text: "Banque",
//             emoji: true,
//           },
//         },
//         {
//           type: "input",
//           block_id: "virement_date",
//           label: {
//             type: "plain_text",
//             text: "Date du virement",
//             emoji: true,
//           },
//           element: {
//             type: "datepicker",
//             action_id: "input_virement_date",
//             initial_date: isSameMode && details.virement_date
//               ? new Date(details.virement_date).toISOString().split("T")[0]
//               : undefined,
//           },
//         },
//         {
//           type: "input",
//           block_id: "virement_order",
//           label: { type: "plain_text", text: "Ordre" },
//           element: {
//             type: "plain_text_input",
//             action_id: "input_virement_order",
//             initial_value: isSameMode ? details.virement_order || "" : "",
//           },
//         }
//       );
//     } else if (paymentMode === "Mobile Money") {
//       blocks.push(
//         {
//           type: "input",
//           block_id: "mobilemoney_recipient_phone",
//           element: {
//             type: "plain_text_input",
//             action_id: "input_mobilemoney_recipient_phone",
//             initial_value: isSameMode ? details.mobilemoney_recipient_phone || "" : "",
//           },
//           label: {
//             type: "plain_text",
//             text: "Numéro de téléphone bénéficiaire",
//             emoji: true,
//           },
//         },
//         {
//           type: "input",
//           block_id: "mobilemoney_sender_phone",
//           element: {
//             type: "plain_text_input",
//             action_id: "input_mobilemoney_sender_phone",
//             initial_value: isSameMode ? details.mobilemoney_sender_phone || "" : "",
//           },
//           label: {
//             type: "plain_text",
//             text: "Numéro envoyeur",
//             emoji: true,
//           },
//         },
//         {
//           type: "input",
//           block_id: "mobilemoney_date",
//           label: {
//             type: "plain_text",
//             text: "Date",
//             emoji: true,
//           },
//           element: {
//             type: "datepicker",
//             action_id: "input_mobilemoney_date",
//             initial_date: isSameMode && details.mobilemoney_date
//               ? new Date(details.mobilemoney_date).toISOString().split("T")[0]
//               : undefined,
//           },
//         }
//       );
//     } else if (paymentMode === "Julaya") {
//       blocks.push(
//         {
//           type: "input",
//           block_id: "julaya_recipient",
//           element: {
//             type: "plain_text_input",
//             action_id: "input_julaya_recipient",
//             initial_value: isSameMode ? details.julaya_recipient || "" : "",
//           },
//           label: {
//             type: "plain_text",
//             text: "Bénéficiaire",
//             emoji: true,
//           },
//         },
//         {
//           type: "input",
//           block_id: "julaya_transaction_number",
//           element: {
//             type: "plain_text_input",
//             action_id: "input_julaya_transaction_number",
//             initial_value: isSameMode ? details.julaya_transaction_number || "" : "",
//           },
//           label: {
//             type: "plain_text",
//             text: "Numéro de transaction",
//             emoji: true,
//           },
//         },
//         {
//           type: "input",
//           block_id: "julaya_date",
//           label: {
//             type: "plain_text",
//             text: "Date",
//             emoji: true,
//           },
//           element: {
//             type: "datepicker",
//             action_id: "input_julaya_date",
//             initial_date: isSameMode && details.julaya_date
//               ? new Date(details.julaya_date).toISOString().split("T")[0]
//               : undefined,
//           },
//         }
//       );
//     }

//     console.log("paymentData", paymentData);
//     console.log("paymentData.paymentProofs", paymentData.paymentProofs);
//     console.log("paymentData.paymentUrl", paymentData.paymentUrl);

//     const view = {
//       type: "modal",
//       callback_id: "payment_modification_submission",
//       private_metadata: JSON.stringify({
//         entityId,
//         paymentIndex,
//         reporterId,
//         channelId: payload.channel?.id || process.env.SLACK_ADMIN_ID,
//         existingProofs: paymentData.paymentProofs || [],
//         existingUrls: paymentData.paymentUrl ? [paymentData.paymentUrl] : [],
//         problemType,
//         problemDescription,
//       }),
//       title: {
//         type: "plain_text",
//         text: "Modifier le paiement",
//         emoji: true,
//       },
//       submit: {
//         type: "plain_text",
//         text: "Enregistrer",
//         emoji: true,
//       },
//       close: {
//         type: "plain_text",
//         text: "Annuler",
//         emoji: true,
//       },
//       blocks,
//     };

//     const response = await postSlackMessage2(
//       "https://slack.com/api/views.open",
//       { trigger_id: payload.trigger_id, view },
//       process.env.SLACK_BOT_TOKEN
//     );

//     if (!response.data.ok) {
//       throw new Error(`Slack API error: ${response.data.error}`);
//     }

//     context.log(`Payment modification modal opened for ${entityId}`);
//     return {
//       statusCode: 200,
//       headers: { "Content-Type": "application/json" },
//       body: "",
//     };
//   } catch (error) {
//     context.log(`Error handling modify payment: ${error.message}`);
//     return {
//       response_action: "errors",
//       errors: {
//         _error: `Une erreur s'est produite: ${error.message}`,
//       },
//     };
//   }
// }
async function handleRestoreOrder(payload, context) {
	console.log("** handleRestoreOrder");
	try {
		const value = JSON.parse(payload.actions[0].value);
		const { orderId } = value;

		// Find the order
		const order = await Order.findOne({ id_commande: orderId });
		if (!order) {
			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: "❌ Erreur : Commande non trouvée.",
			});
		}

		// Restore the order
		order.deleted = false;
		order.deletedAt = null;
		order.deletedBy = null;

		// Save the updated order
		await order.save();

		// Notify admin channel about the restoration
		await postSlackMessage(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ADMIN_ID,
				text: `:recycle: Commande #${orderId} restaurée par <@${payload.user.id}>.`,
			},
			process.env.SLACK_BOT_TOKEN
		);

		// Also notify the achat channel if it exists
		if (process.env.SLACK_ACHAT_ID) {
			await postSlackMessage(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_ACHAT_ID,
					text: `:recycle: Commande #${orderId} a été restaurée par <@${payload.user.id}>.`,
				},
				process.env.SLACK_BOT_TOKEN
			);
		}

		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: `:white_check_mark: Commande #${orderId} restaurée avec succès.`,
		});
	} catch (error) {
		context.log(`Error in handleRestoreOrder: ${error.message}`, error.stack);
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: `❌ Erreur lors de la restauration: ${error.message}`,
		});
	}
}
// Add this function to your existing code
async function handleDeleteOrder(payload, context) {
	console.log("** handleDeleteOrder");
	try {
		context.log("Starting handleDeleteOrder function");

		// Extract the proforma index from the value
		const valueString = payload.actions[0].value;
		const proformaIndex = parseInt(valueString.split("_")[1]);

		// Get message info to help identify related data
		const messageTs = payload.container.message_ts;
		const channelId = payload.channel.id;

		// First, try to show a confirmation dialog
		try {
			context.log("Opening confirmation dialog");
			const dialogResponse = await postSlackMessage(
				"https://slack.com/api/views.open",
				{
					trigger_id: payload.trigger_id,
					view: {
						type: "modal",
						callback_id: "delete_order_confirmation",
						title: {
							type: "plain_text",
							text: "Confirmation",
						},
						submit: {
							type: "plain_text",
							text: "Supprimer",
						},
						close: {
							type: "plain_text",
							text: "Annuler",
						},
						private_metadata: JSON.stringify({
							proformaIndex,
							messageTs,
							channelId,
						}),
						blocks: [
							{
								type: "section",
								text: {
									type: "mrkdwn",
									text: `:warning: *Êtes-vous sûr de vouloir supprimer cette commande ?*\n\nCette action est irréversible.`,
								},
							},
							{
								type: "input",
								block_id: "delete_reason_block",
								optional: true,
								label: {
									type: "plain_text",
									text: "Raison de la suppression",
								},
								element: {
									type: "plain_text_input",
									action_id: "delete_reason_input",
								},
							},
						],
					},
				},
				process.env.SLACK_BOT_TOKEN
			);

			if (!dialogResponse.ok) {
				context.log(`Error opening modal: ${dialogResponse.error}`);
				throw new Error(
					`Unable to open confirmation dialog: ${dialogResponse.error}`
				);
			}

			// Return empty response as the modal is now handling the interaction
			return createSlackResponse(200);
		} catch (dialogError) {
			// If modal fails, fall back to ephemeral message with buttons
			context.log(`Dialog error: ${dialogError.message}, using fallback`);

			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: "Voulez-vous vraiment supprimer cette commande ?",
				blocks: [
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `:warning: *Confirmation de suppression*\n\nÊtes-vous sûr de vouloir supprimer cette commande ?`,
						},
					},
					{
						type: "actions",
						elements: [
							{
								type: "button",
								text: {
									type: "plain_text",
									text: "Oui, supprimer",
									emoji: true,
								},
								style: "danger",
								value: JSON.stringify({ proformaIndex, messageTs, channelId }),
								action_id: "delete_order_confirmed",
							},
							{
								type: "button",
								text: {
									type: "plain_text",
									text: "Annuler",
									emoji: true,
								},
								value: "cancel",
								action_id: "delete_order_canceled",
							},
						],
					},
				],
			});
		}
	} catch (error) {
		context.log(`Error in handleDeleteOrder: ${error.message}`, error.stack);
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: `❌ Erreur: ${error.message}`,
		});
	}
}

// Function to perform the actual deletion after confirmation
async function executeOrderDeletion(payload, metadata, reason, context) {
	console.log("** executeOrderDeletion");
	try {
		context.log("Executing order deletion");
		let orderId;
		let order;
		// Parse metadata if it's a string
		const data = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
		const { proformaIndex, messageTs, channelId } = data;
		if (messageTs) {
			order = await Order.findOne({
				"slackMessages.ts": messageTs,
				"slackMessages.channel": channelId,
			});
			console.log("$$ order", order);
			// If not found, try by the proforma validation info from the message
			if (!order) {
				// Get the user ID from the message text
				const validatorId = payload.user
					? payload.user.id
					: payload.user_id || "unknown";

				// Find orders with validated proformas by this user
				const orders = await Order.find({
					"proformas.validated": true,
					"proformas.validatedBy": validatorId,
				}).sort({ "proformas.validatedAt": -1 });

				if (orders.length > 0) {
					order = orders[0];
				}
			}

			if (!order) {
				throw new Error("Impossible de trouver la commande associée");
			}

			orderId = order.id_commande;
		} else {
			order = await Order.findOne({
				id_commande: metadata.orderId,
			});
			console.log("$$ order", order);
			orderId = metadata.orderId;
			console.log("$$ orderId", orderId);
			console.log("$$ payload.user", payload.user);
		}
		// Look up the order based on message timestamp
		// First try by slack_message_ts if you store it
		// let order = await Order.findOne({ slack_message_ts: messageTs });

		// Update order using findOneAndUpdate
		const updateData = {
			deleted: true,
			deletedAt: new Date(),
			deletedBy: payload.user ? payload.user.id : payload.user_id || "unknown",
			deletedByName: payload.user
				? payload.user.username
				: payload.username || "unknown",
			...(reason && { deletionReason: reason }), // Conditionally add deletionReason
		};

		const updatedOrder = await Order.findOneAndUpdate(
			{ _id: order._id },
			{ $set: updateData },
			{ new: true } // Return the updated document
		);

		// Update the original message
		if (channelId && messageTs) {
			await postSlackMessage(
				"https://slack.com/api/chat.update",
				{
					channel: channelId,
					ts: messageTs,
					text: `❌ *11SUPPRIMÉE* - Commande #${orderId}`,
					// blocks: [
					//   {
					//     type: "section",
					//     text: {
					//       type: "mrkdwn",
					//       text:
					//          `❌ *22SUPPRIMÉE* par <@${payload.user ? payload.user.username : payload.user_id || "unknown"}> le ${new Date().toLocaleString(
					//               "fr-FR"
					//             )}\n*  Raison:* ${reason || "Non spécifiée"}`
					//     },
					//   },
					// {
					//   type: "section",
					//   text: {
					//     type: "mrkdwn",
					//     text: `❌ *SUPPRIMÉE* - Commande #${orderId}`,
					//   },
					// },
					// {
					//   type: "context",
					//   elements: [
					//     {
					//       type: "mrkdwn",
					//       text:
					//         `Supprimée par <@${
					//           order.deletedBy
					//         }> le ${new Date().toLocaleString("fr-FR")}` +
					//         (reason ? `\nRaison: ${reason}` : ""),
					//     },
					//   ],
					// },
					// ],
					blocks: [
						{
							type: "header",
							text: {
								type: "plain_text",
								text:
									":package:  ❌ Commande: " +
									orderId +
									" - Supprimée" +
									` par <@${
										payload.user.username
									}> le ${new Date().toLocaleDateString()}, Raison: ` +
									(reason ? ` ${reason}` : " Non spécifiée"),
								emoji: true,
							},
						},
					],
				},
				process.env.SLACK_BOT_TOKEN
			);
		}

		// Notify admin channel
		await postSlackMessage(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ADMIN_ID,
				// blocks: [
				//   {
				//     type: "header",
				//     text: {
				//       type: "plain_text",
				//       text:
				//         ":package:  ❌ Commande: " +
				//         orderId +
				//         " - Supprimée" +
				//         ` par <@${payload.user.username}> le ${new Date().toLocaleDateString()} `+(reason ? `\nRaison: ${reason}` : "Non spécifiée"),
				//       emoji: true,
				//     },
				//   },
				// ],
			},
			process.env.SLACK_BOT_TOKEN
		);
		const channels = [
			process.env.SLACK_FINANCE_CHANNEL_ID,
			order.demandeurId, // Assuming this is a Slack user ID for DM
			process.env.SLACK_ACHAT_CHANNEL_ID,
		];
		console.log("Channels to notify:", channels);
		for (const Channel of channels) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: Channel,
					blocks: [
						{
							type: "header",
							text: {
								type: "plain_text",
								text:
									":package:  ❌ Commande: " +
									orderId +
									" - Supprimée" +
									` par <@${
										payload.user.username
									}> le ${new Date().toLocaleDateString()}, Raison:` +
									(reason ? ` ${reason}` : " Non spécifiée"),
								emoji: true,
							},
						},
					],
				},
				process.env.SLACK_BOT_TOKEN
			);
		}

		return {
			success: true,
			message: `:white_check_mark: Commande #${orderId} supprimée avec succès.`,
		};
	} catch (error) {
		context.log(`Error executing deletion: ${error.message}`, error.stack);
		return {
			success: false,
			message: `❌ Erreur lors de la suppression: ${error.message}`,
		};
	}
}

// Handle the confirmed delete action
async function handleDeleteOrderConfirmed(payload, context) {
	console.log("** handleDeleteOrderConfirmed");
	try {
		const value = payload.actions[0].value;
		let metadata;

		try {
			metadata = JSON.parse(value);
		} catch (parseError) {
			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: "❌ Erreur: Format de données invalide.",
			});
		}
		console.log("metadata", metadata);
		const result = await executeOrderDeletion(payload, metadata, null, context);

		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: result.message,
		});
	} catch (error) {
		context.log(
			`Error in handleDeleteOrderConfirmed: ${error.message}`,
			error.stack
		);
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: `❌ Erreur: ${error.message}`,
		});
	}
}

// Handle cancellation
async function handleDeleteOrderCanceled(payload, context) {
	console.log("** handleDeleteOrderCanceled");
	return createSlackResponse(200, {
		response_type: "ephemeral",
		text: "Suppression annulée.",
	});
}
async function handleDeleteProformaConfirmation(payload, context) {
	console.log("** handleDeleteProformaConfirmation");
	try {
		// Extract data from the button value
		const { orderId, proformaIndex } = JSON.parse(payload.actions[0].value);

		// Fetch the order
		const order = await Order.findOne({ id_commande: orderId });
		if (!order) {
			throw new Error(`Order ${orderId} not found`);
		}

		// Check if the proforma exists
		if (!order.proformas || !order.proformas[proformaIndex]) {
			throw new Error(
				`Proforma index ${proformaIndex} not found in order ${orderId}`
			);
		}

		const proforma = order.proformas[proformaIndex];

		// Check if any proforma in the order is already validated
		const hasValidatedProforma = order.proformas.some((p) => p.validated);
		if (hasValidatedProforma) {
			// Post Slack message to the designated channel
			const slackResponse = await postSlackMessage(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_ACHAT_CHANNEL_ID,
					text: "⚠️ Une proforma a été validée.",
				},
				process.env.SLACK_BOT_TOKEN
			);
			// return {
			//   text: ,
			//   replace_original: false,
			//   response_type: "ephemeral"
			// };
		} else {
			// Open a confirmation dialog
			const modalView = {
				type: "modal",
				callback_id: "delete_proforma_confirmation",
				title: {
					type: "plain_text",
					text: "Confirmer la suppression",
					emoji: true,
				},
				submit: {
					type: "plain_text",
					text: "Supprimer",
					emoji: true,
				},
				close: {
					type: "plain_text",
					text: "Annuler",
					emoji: true,
				},
				blocks: [
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: "⚠️ Êtes-vous sûr de vouloir supprimer cette proforma ? Cette action est irréversible.",
						},
					},
				],
				private_metadata: JSON.stringify({ orderId, proformaIndex }),
			};

			const response = await postSlackMessage(
				"https://slack.com/api/views.open",
				{
					trigger_id: payload.trigger_id,
					view: modalView,
				},
				process.env.SLACK_BOT_TOKEN
			);

			if (!response.ok) {
				throw new Error(
					`Failed to open deletion confirmation: ${response.error}`
				);
			}
		}

		return { text: "Chargement de la confirmation de suppression..." };
	} catch (error) {
		context.log(`Error in handleDeleteProformaConfirmation: ${error.message}`);
		return {
			text: `❌ Erreur lors de la confirmation de suppression: ${error.message}`,
		};
	}
}
// Function to generate modal for funding approval with payment options
// Function to generate modal for funding approval with payment options
async function generateFundingApprovalPaymentModal(
	context,
	trigger_id,
	messageTs,
	requestId,
	channelId
) {
	console.log(
		`** generateFundingApprovalPaymentModal - messageTs: ${messageTs}, channelId: ${
			channelId || "not provided"
		}`
	);

	// Find the funding request in the database
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
	const metadata = JSON.stringify({
		requestId: requestId,
		messageTs: messageTs,
		channelId: channelId,
		amount: request.amount, // Include amount
		currency: request.currency, // Include currency
		reason: request.reason, // Include reason
		requestedDate: request.requestedDate, // Include requested date
		submitterName: request.submitterName || request.submittedBy, // Include submitter name
	});
	console.log(`Modal metadata: ${metadata}`);

	// Bank options for dropdown (used later in handlePaymentMethodSelection)

	// Create blocks for the modal
	const blocks = [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `*Approbation de demande de fonds*\nID: ${requestId}\nMontant: ${
					request.amount
				} ${request.currency}\nMotif: ${request.reason}\nDemandeur: ${
					request.submitterName || request.submittedBy
				}`,
			},
		},
		{
			type: "divider",
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
					text: { type: "plain_text", text: "Espèces" },
					value: "cash",
				},
			},
			dispatch_action: true, // Enable block_actions event on selection
		},
		{
			type: "input",
			block_id: "payment_notes",
			optional: true,
			label: { type: "plain_text", text: "Notes (optionnel)" },
			element: {
				type: "plain_text_input",
				action_id: "input_payment_notes",
			},
		},
	];

	const modal = {
		type: "modal",
		callback_id: "submit_finance_details",
		private_metadata: metadata,
		title: { type: "plain_text", text: "Détails financiers" },
		submit: { type: "plain_text", text: "Soumettre" },
		close: { type: "plain_text", text: "Annuler" },
		blocks: blocks,
	};

	try {
		await postSlackMessageWithRetry(
			"https://slack.com/api/views.open",
			{ trigger_id, view: modal },
			process.env.SLACK_BOT_TOKEN
		);
		console.log(`Modal opened for request ${requestId}`);
	} catch (error) {
		console.error(`Error opening modal for ${requestId}:`, error);
	}
}

// Function to handle the block actions for payment method selection
async function handlePaymentMethodSelection(payload, context) {
	console.log("** handlePaymentMethodSelection");
	const selectedValue = payload.actions[0].selected_option?.value;
	console.log("Selected payment method:", selectedValue);

	if (!selectedValue) {
		console.error("No payment method selected in payload");
		return;
	}

	if (selectedValue !== "cheque") {
		console.log("Not cheque, no modal update needed");
		// Optionally, remove cheque fields if previously added
		const viewId = payload.view.id;
		let blocks = payload.view.blocks.filter(
			(block) =>
				![
					"cheque_number",
					"cheque_bank",
					"cheque_date",
					"cheque_order",
				].includes(block.block_id)
		);

		try {
			await postSlackMessageWithRetry(
				"https://slack.com/api/views.update",
				{
					view_id: viewId,
					view: {
						type: "modal",
						callback_id: "submit_finance_details",
						private_metadata: payload.view.private_metadata,
						title: { type: "plain_text", text: "Détails financiers" },
						submit: { type: "plain_text", text: "Soumettre" },
						close: { type: "plain_text", text: "Annuler" },
						blocks: blocks,
					},
				},
				process.env.SLACK_BOT_TOKEN
			);
			console.log("Modal updated to remove cheque fields");
		} catch (error) {
			console.error("Error removing cheque fields:", error);
		}
		return;
	}

	const viewId = payload.view.id;
	const requestId = payload.view.private_metadata;

	// Get current blocks and remove existing cheque fields to avoid duplicates
	let blocks = payload.view.blocks.filter(
		(block) =>
			!["cheque_number", "cheque_bank", "cheque_date", "cheque_order"].includes(
				block.block_id
			)
	);

	// Add cheque detail blocks
	blocks.push(
		{ type: "divider" },
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: "*Détails du chèque*",
			},
		},
		{
			type: "input",
			block_id: "cheque_number",
			element: {
				type: "number_input",
				action_id: "input_cheque_number",
				is_decimal_allowed: false,
				min_value: "0",
			},
			label: { type: "plain_text", text: "Numéro du Chèque" },
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
			element: { type: "plain_text_input", action_id: "input_cheque_order" },
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
		}
	);

	// Update the modal
	try {
		await postSlackMessageWithRetry(
			"https://slack.com/api/views.update",
			{
				view_id: viewId,
				view: {
					type: "modal",
					callback_id: "submit_finance_details",
					private_metadata: requestId,
					title: { type: "plain_text", text: "Détails financiers" },
					submit: { type: "plain_text", text: "Soumettre" },
					close: { type: "plain_text", text: "Annuler" },
					blocks: blocks,
				},
			},
			process.env.SLACK_BOT_TOKEN
		);
		console.log("Modal updated with cheque fields for request:", requestId);
	} catch (error) {
		console.error("Error updating modal with cheque fields:", error);
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: payload.user.id,
				user: payload.user.id,
				text: "❌ Erreur lors de la mise à jour du formulaire. Veuillez réessayer.",
			},
			process.env.SLACK_BOT_TOKEN
		);
	}
}

// Function to handle the approval submission
async function handleFundingApprovalPaymentSubmission(
	payload,
	context,
	userName,
	messageTs
) {
	console.log("** handleFundingApprovalPaymentSubmission");
	const formData = payload.view.state.values;
	const privateMetadata = JSON.parse(payload.view.private_metadata);
	console.log("privateMetadata", privateMetadata);
	const requestId = privateMetadata.requestId;
	const userId = userName || payload.user.id;
	const originalMessageTs = privateMetadata.messageTs; // Original message timestamp
	const channelId = privateMetadata.channelId || process.env.SLACK_ADMIN_ID; // Channel ID
	const amount = privateMetadata.amount; // Use metadata
	const currency = privateMetadata.currency; // Use metadata
	const reason = privateMetadata.reason; // Use metadata
	const requestedDate = privateMetadata.requestedDate; // Use metadata
	const submitterName = privateMetadata.submitterName; // Use metadata

	// Get payment method
	const paymentMethod =
		formData.payment_method.input_payment_method.selected_option.value;
	const paymentNotes = formData.payment_notes?.input_payment_notes?.value || "";
	const disbursementType = paymentMethod === "cash" ? "Espèces" : "Chèque";

	// Build payment details object
	const paymentDetails = {
		method: paymentMethod,
		notes: paymentNotes,
		approvedBy: userId,
		approvedAt: new Date(),
	};

	// Add cheque details if method is cheque
	if (paymentMethod === "cheque") {
		if (
			!formData.cheque_number ||
			!formData.cheque_bank ||
			!formData.cheque_date ||
			!formData.cheque_order
		) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: userId,
					user: userId,
					text: "❌ Veuillez remplir tous les champs requis pour le chèque (numéro, banque, date, ordre).",
				},
				process.env.SLACK_BOT_TOKEN
			);
			return createSlackResponse(200, "");
		}

		paymentDetails.cheque = {
			number: formData.cheque_number.input_cheque_number.value,
			bank: formData.cheque_bank.input_cheque_bank.selected_option.value,
			date: formData.cheque_date.input_cheque_date.selected_date,
			order: formData.cheque_order.input_cheque_order.value,
		};
	}

	try {
		// Process the funding approval with payment details
		await processFundingApprovalWithPayment(
			requestId,
			disbursementType,
			userId,
			paymentDetails
		);

		// Delete the processing message
		if (messageTs) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.delete",
				{
					channel: channelId,
					ts: messageTs,
				},
				process.env.SLACK_BOT_TOKEN
			);
		}

		// Update the original message in the admin channel
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.update",
			{
				channel: channelId,
				ts: originalMessageTs, // Use the original message timestamp
				blocks: [
					{
						type: "header",
						text: {
							type: "plain_text",
							text: ":heavy_dollar_sign: Demande de fonds ",
							emoji: true,
						},
					},
					{
						type: "divider",
					},
					{
						type: "section",
						fields: [
							{ type: "mrkdwn", text: `*ID:*\n${requestId}` },
							{ type: "mrkdwn", text: `*Montant:*\n${amount} ${currency}` },
							{ type: "mrkdwn", text: `*Motif:*\n${reason}` },
							{ type: "mrkdwn", text: `*Date requise:*\n${requestedDate}` },
							{
								type: "mrkdwn",
								text: `*Demandeur:*\n${submitterName || userId}`,
							},
							{
								type: "mrkdwn",
								text: `*Date d'approbation:*\n${new Date().toLocaleDateString()}`,
							},
						],
					},
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `✅ Approuvé par <@${userId}> (Méthode: ${
								paymentMethod === "cash" ? "Espèces" : "Chèque"
							})`,
						},
					},
				],
				text: `Demande ${requestId} approuvée par ${userId}`,
			},
			process.env.SLACK_BOT_TOKEN
		);

		// Send confirmation message to the user
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: userId,
				text: `✅ Demande ${requestId} approuvée avec succès (Méthode: ${
					paymentMethod === "cash" ? "Espèces" : "Chèque"
				})`,
			},
			process.env.SLACK_BOT_TOKEN
		);

		return createSlackResponse(200, "");
	} catch (error) {
		console.error("Error processing funding approval:", error);
		// Delete the processing message if there's an error
		if (messageTs) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.delete",
				{
					channel: channelId,
					ts: messageTs,
				},
				process.env.SLACK_BOT_TOKEN
			);
		}

		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: userId,
				user: userId,
				text: `❌ Erreur lors de l'approbation: ${error.message}`,
			},
			process.env.SLACK_BOT_TOKEN
		);

		return createSlackResponse(200, "");
	}
}

// Enhanced function to process funding approval with payment details
async function processFundingApprovalWithPayment(
	requestId,
	paymentMethod,
	userId,
	paymentDetails
) {
	console.log("** processFundingApprovalWithPayment");
	const caisse = await Caisse.findOne({
		"fundingRequests.requestId": requestId,
	});

	if (!caisse) throw new Error("Caisse non trouvée");

	const requestIndex = caisse.fundingRequests.findIndex(
		(r) => r.requestId === requestId
	);

	if (requestIndex === -1) throw new Error("Demande non trouvée");

	const request = caisse.fundingRequests[requestIndex];

	// Update request status and details
	request.status = "Validé";
	request.approvedBy = userId;
	request.approvedAt = new Date();
	request.disbursementType = paymentMethod === "cash" ? "Espèces" : "Chèque";
	request.workflow.stage = "approved";
	request.workflow.history.push({
		stage: "approved",
		timestamp: new Date(),
		actor: userId,
		details: "Demande approuvée avec détails de paiement",
	});
	// Store payment details
	request.paymentDetails = paymentDetails;

	// Update balance for the specific currency
	caisse.balances[request.currency] =
		(caisse.balances[request.currency] || 0) + request.amount;

	// Add transaction record
	let transactionDetails = `Approuvé par ${userId} (${request.disbursementType})`;

	if (paymentMethod === "cheque" && paymentDetails.cheque) {
		transactionDetails += ` - Chèque #${paymentDetails.cheque.number} de ${paymentDetails.cheque.bank}`;
	}

	caisse.transactions.push({
		type: "Funding",
		amount: request.amount,
		currency: request.currency,
		requestId,
		details: transactionDetails,
		timestamp: new Date(),
		paymentMethod: request.disbursementType,
		paymentDetails: request.paymentDetails,
	});

	// Save changes to database
	await caisse.save();

	// Sync to Excel to update the existing row
	try {
		await syncCaisseToExcel(caisse, requestId);
	} catch (error) {
		console.error(`Excel sync failed: ${error.message}`);
		// Continue despite Excel sync failure
	}

	// Notify the requester
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: request.submittedByID,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: "✅ Demande de fonds Approuvée",
						emoji: true,
					},
				},
				{
					type: "section",
					fields: [
						{ type: "mrkdwn", text: `*ID:*\n${requestId}` },
						{
							type: "mrkdwn",
							text: `*Montant:*\n${request.amount} ${request.currency}`,
						},
						{ type: "mrkdwn", text: `*Méthode:*\n${request.disbursementType}` },
					],
				},
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: `Approuvé par <@${userId}> le ${new Date().toLocaleDateString(
								"fr-FR"
							)}`,
						},
					],
				},
			],
			text: `Votre demande de fonds ${requestId} a été approuvée (${request.amount} ${request.currency})`,
		},
		process.env.SLACK_BOT_TOKEN
	);

	return true;
}
// Function to open a modal for rejection reason
async function openRejectionReasonModalFund(payload, requestId) {
	console.log("** openRejectionReasonModalFund");
	try {
		await postSlackMessage(
			"https://slack.com/api/views.open",
			{
				trigger_id: payload.trigger_id,
				view: {
					type: "modal",
					callback_id: "reject_funding",

					private_metadata: JSON.stringify({
						requestId: requestId,
						channel_id: payload.channel.id,
						message_ts: payload.message.ts,
					}),
					title: {
						type: "plain_text",
						text: "Motif de rejet",
						emoji: true,
					},
					submit: {
						type: "plain_text",

						text: "Confirmer le rejet",
						emoji: true,
					},
					close: {
						type: "plain_text",
						text: "Annuler",
						emoji: true,
					},
					blocks: [
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: `Veuillez indiquer la raison du rejet de la demande *${requestId}*`,
							},
						},
						{
							type: "input",
							block_id: "rejection_reason_block",
							element: {
								type: "plain_text_input",
								action_id: "rejection_reason_input",
								multiline: true,
							},
							label: {
								type: "plain_text",
								text: "Motif du rejet",
								emoji: true,
							},
						},
					],
				},
			},
			process.env.SLACK_BOT_TOKEN
		);

		return createSlackResponse(200, "");
	} catch (error) {
		console.error("Error opening rejection modal:", error);
		return createSlackResponse(500, "Error opening rejection modal");
	}
}
// New function to open a confirmation dialog
async function openPreApprovalConfirmationDialog(payload) {
	console.log("** openPreApprovalConfirmationDialog");
	const requestId = payload.actions[0].value;

	try {
		// Find the funding request to show details in confirmation
		const caisse = await Caisse.findOne({
			"fundingRequests.requestId": requestId,
		});
		console.log("requestId1", requestId);
		if (!caisse) {
			console.error(`Caisse not found for request ${requestId}`);
			return;
		}

		const request = caisse.fundingRequests.find(
			(r) => r.requestId === requestId
		);
		if (!request) {
			console.error(`Request ${requestId} not found`);
			return;
		}

		// Open confirmation modal
		const view = {
			type: "modal",
			callback_id: "pre_approval_confirmation_submit",
			title: { type: "plain_text", text: "Confirmation" },
			submit: { type: "plain_text", text: "Confirmer" },
			close: { type: "plain_text", text: "Annuler" },
			blocks: [
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `Êtes-vous sûr de vouloir approuver cette demande ?`,
					},
				},
			],
			private_metadata: JSON.stringify({
				requestId,
				action: "accept",
				messageTs: payload.message.ts,
			}),
		};

		await postSlackMessage2(
			"https://slack.com/api/views.open",
			{ trigger_id: payload.trigger_id, view },
			process.env.SLACK_BOT_TOKEN
		);
		return { statusCode: 200, body: "" };
	} catch (error) {
		console.error(`Error opening confirmation dialog: ${error.message}`);
	}
}
// New function to handle the pre-approval after confirmation
async function handlePreApprovalAfterConfirmation(payload, context) {
	console.log("** handlePreApprovalAfterConfirmation");
	// Parse the private metadata to get request info
	const metadata = JSON.parse(payload.view.private_metadata);
	const requestId = metadata.requestId;
	const messageTs = metadata.messageTs;
	const channelId = metadata.channelId;
	const userId = payload.user.id;
	const userName = payload.user.username || userId;

	// Get admin notes if provided
	const adminNotes =
		payload.view.state.values.admin_notes?.admin_notes_input?.value || "";

	// Find the funding request
	const caisse = await Caisse.findOne({
		"fundingRequests.requestId": requestId,
	});
	if (!caisse) {
		console.error(`Caisse not found for request ${requestId}`);
		return;
	}

	const requestIndex = caisse.fundingRequests.findIndex(
		(r) => r.requestId === requestId
	);
	if (requestIndex === -1) {
		console.error(`Request ${requestId} not found`);
		return;
	}

	const request = caisse.fundingRequests[requestIndex];

	// Update request status and workflow tracking
	request.status = "Pré-approuvé";
	request.preApprovedBy = userId;
	request.preApprovedAt = new Date();
	request.adminNotes = adminNotes; // Store admin notes if provided
	request.workflow.stage = "pre_approved";
	request.workflow.history.push({
		stage: "pre_approved",
		timestamp: new Date(),
		actor: userId,
		details: adminNotes
			? `Demande pré-approuvée par admin avec note: ${adminNotes}`
			: "Demande pré-approuvée par admin",
	});

	await caisse.save();

	// Update admin message
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.update",
		{
			channel: channelId,
			ts: messageTs,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: `:heavy_dollar_sign: Demande de fonds (Pré-approuvée)${requestId}`,
						emoji: true,
					},
				},
				{
					type: "divider",
				},
				{
					type: "section",
					fields: [
						{
							type: "mrkdwn",
							text: `*Montant:*\n${request.amount} ${request.currency}`,
						},
						{ type: "mrkdwn", text: `*Motif:*\n${request.reason}` },
						{
							type: "mrkdwn",
							text: `*Date requise:*\n${request.requestedDate}`,
						},
						{
							type: "mrkdwn",
							text: `*Demandeur:*\n${
								request.submitterName || request.submittedBy
							}`,
						},
						{
							type: "mrkdwn",
							text: `*Pré-approuvé par:*<@${userId}> le ${new Date().toLocaleDateString()}`,
						},
					],
				},
				...(adminNotes
					? [
							{
								type: "section",
								text: {
									type: "mrkdwn",
									text: `*Notes:* ${adminNotes}`,
								},
							},
					  ]
					: []),
				{
					type: "context",
					elements: [
						{
							type: "mrkdwn",
							text: "✅ *Pré-approuvé* - En attente des détails de la finance",
						},
					],
				},
			],
			text: `Demande de fonds ${requestId} pré-approuvée - En attente des détails de la finance`,
		},
		process.env.SLACK_BOT_TOKEN
	);

	// Notify finance team to fill details form
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: process.env.SLACK_FINANCE_CHANNEL_ID,
			blocks: [
				{
					type: "header",
					text: {
						type: "plain_text",
						text: ":heavy_dollar_sign: Demande de fonds à Traiter",
						emoji: true,
					},
				},
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `Une demande de fonds a été pré-approuvée et nécessite vos détails pour finalisation.\n\n*ID:* ${requestId}\n*Montant:* ${
							request.amount
						} ${request.currency}\n*Motif:* ${
							request.reason
						}\n*Date requise:* ${
							request.requestedDate
						}\n*Pré-approuvé par:* <@${userId}>${
							adminNotes ? `\n*Notes:* ${adminNotes}` : ""
						}`,
					},
				},
				{
					type: "actions",
					elements: [
						{
							type: "button",
							text: {
								type: "plain_text",
								text: "Fournir les détails",
								emoji: true,
							},
							style: "primary",
							value: requestId,
							action_id: "fill_funding_details",
						},
					],
				},
			],
			text: `Demande de fonds ${requestId} à traiter - Veuillez fournir les détails de paiement`,
		},
		process.env.SLACK_BOT_TOKEN
	);

	// Notify requester of pre-approval
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: request.submittedByID,
			text: `📝 Votre demande de fonds (ID: ${requestId}) a été pré-approuvée par <@${userId}>. L'équipe finance va maintenant traiter votre demande.${
				adminNotes ? `\n*Notes:* ${adminNotes}` : ""
			}`,
		},
		process.env.SLACK_BOT_TOKEN
	);
}
// New function to open a confirmation dialog for final approval
async function openFinalApprovalConfirmationDialog(payload) {
	console.log("** openFinalApprovalConfirmationDialog");
	const action = payload.actions[0];
	const requestId = action.value;

	try {
		// Find the funding request to show details in confirmation
		const caisse = await Caisse.findOne({
			"fundingRequests.requestId": requestId,
		});

		if (!caisse) {
			console.error(`Caisse not found for request ${requestId}`);
			return;
		}

		const request = caisse.fundingRequests.find(
			(r) => r.requestId === requestId
		);
		if (!request) {
			console.error(`Request ${requestId} not found`);
			return;
		}

		// Get payment method text for display
		const paymentMethodText =
			request.disbursementType === "Espèces" ? "Espèces" : "Chèque";
		let paymentDetailsText = "";

		if (
			request.disbursementType === "Chèque" &&
			request.paymentDetails?.cheque
		) {
			const cheque = request.paymentDetails.cheque;
			paymentDetailsText = `*Numéro:* ${cheque.number}\n*Banque:* ${cheque.bank}\n*Date:* ${cheque.date}\n*Ordre:* ${cheque.order}`;
		}

		// Open confirmation modal
		const view = {
			type: "modal",
			callback_id: "final_approval_confirmation_submit",
			title: { type: "plain_text", text: "Confirmation" },
			submit: { type: "plain_text", text: "Confirmer" },
			close: { type: "plain_text", text: "Annuler" },
			blocks: [
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `Êtes-vous sûr de vouloir approuver cette demande ?`,
					},
				},
			],
			private_metadata: JSON.stringify({
				requestId: requestId,
				messageTs: payload.message.ts,
				channelId: payload.channel.id,
			}),
		};

		await postSlackMessage2(
			"https://slack.com/api/views.open",
			{ trigger_id: payload.trigger_id, view },
			process.env.SLACK_BOT_TOKEN
		);
		return { statusCode: 200, body: "" };
	} catch (error) {
		console.error(
			`Error opening final approval confirmation dialog: ${error.message}`
		);
	}
}
async function postSlackMessage9(url, data, token) {
	console.log("** postSlackMessage");
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 2500); // 2.5s timeout

		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json; charset=utf-8", // Add charset
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(data),
			signal: controller.signal,
		});

		clearTimeout(timeoutId);
		const result = await response.json();
		console.log("** postSlackMessage response:", JSON.stringify(result));
		return result;
	} catch (error) {
		console.log("** postSlackMessage error:", error.message);
		throw new Error(`Slack API call failed: ${error.message}`);
	}
}
async function generatePaymentForm1(formData = {}) {
	console.log("** generatePaymentForm1");

	const view = {
		type: "modal",
		callback_id: "payment_modif_submission",
		title: {
			type: "plain_text",
			text: "Modifier Paiement",
			emoji: true,
		},
		submit: {
			type: "plain_text",
			text: "Soumettre",
			emoji: true,
		},
		close: {
			type: "plain_text",
			text: "Annuler",
			emoji: true,
		},
		blocks: [
			{
				type: "input",
				block_id: "request_title",
				element: {
					type: "plain_text_input",
					action_id: "input_request_title",
					initial_value:
						formData.payment_title?.input_payment_title?.value || "",
				},
				label: {
					type: "plain_text",
					text: "Titre de la demande",
					emoji: true,
				},
			},
			{
				type: "input",
				block_id: "request_date",
				element: {
					type: "datepicker",
					action_id: "input_request_date",
					initial_date:
						formData.payment_date?.input_payment_date?.selected_date ||
						new Date().toISOString().split("T")[0],
				},
				label: {
					type: "plain_text",
					text: "Date de la requête",
					emoji: true,
				},
			},
			{
				type: "input",
				block_id: "payment_reason",
				element: {
					type: "plain_text_input",
					action_id: "input_payment_reason",
					multiline: true,
					initial_value:
						formData.payment_description?.input_payment_description?.value ||
						"",
				},
				label: {
					type: "plain_text",
					text: "Motif du paiement",
					emoji: true,
				},
			},
			{
				type: "input",
				block_id: "amount_to_pay",
				label: {
					type: "plain_text",
					text: "Montant",
				},
				element: {
					type: "plain_text_input",
					action_id: "input_amount_to_pay",
					placeholder: { type: "plain_text", text: "Ex: 1000 XOF" },
					initial_value:
						formData.payment_amount?.input_payment_amount?.value &&
						formData.currency
							? `${formData.payment_amount.input_payment_amount.value} ${formData.currency}`
							: "",
				},
				hint: {
					type: "plain_text",
					text: "Entrez un montant suivi de la devise (XOF, USD, EUR)",
				},
			},
			{
				type: "input",
				block_id: "po_number",
				optional: false,
				element: {
					type: "plain_text_input",
					action_id: "input_po_number",
					initial_value: formData.po_number?.input_po_number?.value || "",
				},
				label: {
					type: "plain_text",
					text: "Référence",
					emoji: true,
				},
			},
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "*Justificatifs existants*",
				},
			},
			...(formData.existing_justificatifs?.length > 0
				? formData.existing_justificatifs.map((url, index) => ({
						type: "input",
						block_id: `existing_justificatif_${index}`,
						optional: true,
						label: {
							type: "plain_text",
							text: `Justificatif ${index + 1}`,
							emoji: true,
						},
						element: {
							type: "plain_text_input",
							action_id: `input_existing_justificatif_${index}`,
							placeholder: {
								type: "plain_text",
								text: "URL du justificatif",
							},
							initial_value: url,
						},
				  }))
				: []),
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "*Ajouter des justificatifs*",
				},
			},
			{
				type: "input",
				block_id: "justificatif",
				optional: true,
				label: {
					type: "plain_text",
					text: "Fichiers justificatifs",
					emoji: true,
				},
				element: {
					type: "file_input",
					action_id: "input_justificatif",
					filetypes: ["pdf", "doc", "docx", "jpg", "jpeg", "png"],
					max_files: 10,
				},
			},
			{
				type: "input",
				block_id: "justificatif_url",
				optional: true,
				label: {
					type: "plain_text",
					text: "URL du justificatif (optionnel)",
					emoji: true,
				},
				element: {
					type: "plain_text_input",
					action_id: "input_justificatif_url",
					placeholder: {
						type: "plain_text",
						text: "https://...",
					},
					initial_value:
						formData.justificatif_url?.input_justificatif_url?.value || "",
				},
			},
			{
				type: "context",
				elements: [
					{
						type: "mrkdwn",
						text: "Vous pouvez ajouter plusieurs fichiers ou une URL externe. Au moins un justificatif est recommandé.",
					},
				],
			},
		],
	};

	return view;
}
// Updated edit_payment handler to use the corrected function
async function handleModifyPayment(
	payload,
	context,
	selectedPaymentMode = null
) {
	console.log("** handleModifyPayment");
	try {
		let actionValue;
		// Determine if this is triggered by "confirm_payment_mode_2" or an initial action
		if (
			payload.actions &&
			payload.actions[0]?.action_id === "confirm_payment_mode_2"
		) {
			// For "Ajouter les détails" button, use private_metadata
			actionValue = JSON.parse(payload.view.private_metadata || "{}");
			// Get the selected payment mode from the current form state
			if (!selectedPaymentMode) {
				selectedPaymentMode =
					payload.view.state.values.payment_mode.select_payment_mode
						.selected_option?.value;
			}
		} else if (
			payload.actions &&
			payload.actions[0]?.action_id === "select_payment_mode" &&
			payload.view?.private_metadata
		) {
			// For automatic payment mode changes (dispatch_action), use private_metadata
			actionValue = JSON.parse(payload.view.private_metadata || "{}");
			// Get the selected payment mode from the current form state
			if (!selectedPaymentMode) {
				selectedPaymentMode = payload.actions[0].selected_option?.value;
			}
		} else {
			// For initial action, use actions[0].value
			actionValue = JSON.parse(payload.actions[0]?.value || "{}");
		}

		const {
			entityId,
			paymentIndex,
			problemType,
			problemDescription,
			reporterId,
		} = actionValue;
		console.log("problemType", problemType);

		// Fetch the entity
		const entity = await fetchEntity(entityId, context);
		if (!entity) {
			throw new Error(`Entity ${entityId} not found`);
		}

		// Get payment data
		const paymentData = entity.payments[paymentIndex];
		const details = paymentData.details || {};

		// Determine the payment mode to use
		const paymentMode =
			selectedPaymentMode ||
			paymentData.paymentMode ||
			paymentData.mode ||
			"Chèque";

		// Create blocks for existing payment proofs
		const proofsBlocks = [];
		if (paymentData.paymentProofs?.length > 0) {
			proofsBlocks.push({
				type: "section",
				block_id: "existing_proofs_header",
				text: {
					type: "mrkdwn",
					text: "*Justificatifs de paiement existants:*",
				},
			});
			paymentData.paymentProofs.forEach((proofUrl, index) => {
				const isFile =
					proofUrl.startsWith("https://files.slack.com") ||
					proofUrl.includes("slack-files");
				proofsBlocks.push({
					type: "input",
					block_id: `existing_proof_${index}`,
					optional: true,
					label: {
						type: "plain_text",
						text: isFile ? `📎 Fichier ${index + 1}` : `🔗 URL ${index + 1}`,
					},
					element: {
						type: "plain_text_input",
						action_id: `edit_proof_${index}`,
						initial_value: proofUrl,
					},
				});
			});
			proofsBlocks.push({ type: "divider" });
		}

		// Create modal blocks
		let blocks = [
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `*Modification du paiement pour ${entityId}*\n*Problème signalé:* ${getProblemTypeText(
						problemType
					)}\n*Description du problème:*\n${
						problemDescription || "Non spécifié"
					}`,
				},
			},
			{ type: "divider" },
			{
				type: "input",
				block_id: "payment_title",
				element: {
					type: "plain_text_input",
					action_id: "input_payment_title",
					initial_value: paymentData.paymentTitle || paymentData.title || "",
				},
				label: {
					type: "plain_text",
					text: "Titre du paiement",
					emoji: true,
				},
			},

			// {
			// 	type: "actions",
			// 	block_id: "select_payment_mode",
			// 	elements: [
			// 		{
			// 			type: "button",
			// 			action_id: "select_payment_mode",
			// 			text: { type: "plain_text", text: "Ajouter les détails" },
			// 			value: "select_payment_mode",
			// 		},
			// 	],
			// },
			{
				type: "input",
				block_id: "amount_paid",
				element: {
					type: "number_input",
					action_id: "input_amount_paid",
					initial_value: (paymentData.amountPaid || 0).toString(),
					is_decimal_allowed: true,
					min_value: "0",
				},
				label: {
					type: "plain_text",
					text: "Montant payé",
					emoji: true,
				},
			},
			{
				type: "input",
				block_id: "payment_mode",
				element: {
					type: "static_select",
					action_id: "select_payment_mode",
					options: [
						{ text: { type: "plain_text", text: "Chèque" }, value: "Chèque" },
						{
							text: { type: "plain_text", text: "Virement" },
							value: "Virement",
						},
						{
							text: { type: "plain_text", text: "Mobile Money" },
							value: "Mobile Money",
						},
						{ text: { type: "plain_text", text: "Julaya" }, value: "Julaya" },
						{ text: { type: "plain_text", text: "Espèces" }, value: "Espèces" },
					],
					initial_option: {
						text: { type: "plain_text", text: paymentMode },
						value: paymentMode,
					},
				},
				label: {
					type: "plain_text",
					text: "Mode de paiement",
					emoji: true,
				},
				dispatch_action: true, // Enable automatic updates when selection changes
			},
			{ type: "divider" },
			// {
			// 	type: "input",
			// 	optional: true,
			// 	block_id: "paiement_url",
			// 	element: {
			// 		type: "plain_text_input",
			// 		action_id: "input_paiement_url",
			// 		initial_value: paymentData.paymentUrl || "",
			// 	},
			// 	label: {
			// 		type: "plain_text",
			// 		text: "URL du paiement",
			// 		emoji: true,
			// 	},
			// },
		];
		// Conditionally add payment URL block only if it has a value
		if (paymentData.paymentUrl && paymentData.paymentUrl.trim() !== "") {
			blocks.push({
				type: "input",
				optional: true,
				block_id: "paiement_url",
				element: {
					type: "plain_text_input",
					action_id: "input_paiement_url",
					initial_value: paymentData.paymentUrl,
				},
				label: {
					type: "plain_text",
					text: "URL du paiement",
					emoji: true,
				},
			});
		}
		// Add existing proofs
		blocks = blocks.concat(proofsBlocks);

		// Add options for new proofs
		blocks.push(
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "Télécharger de nouveaux justificatifs ou ajouter de nouvelles URLs",
				},
			},
			{
				type: "input",
				block_id: "payment_proof_file",
				optional: true,
				label: {
					type: "plain_text",
					text: "📎 Nouveaux fichiers",
				},
				element: {
					type: "file_input",
					action_id: "file_upload_proof",
					filetypes: ["pdf", "jpg", "png"],
					max_files: 5,
				},
				hint: {
					type: "plain_text",
					text: "Si vous souhaitez conserver les fichiers existants, ne téléchargez pas de nouveaux fichiers.",
				},
			},
			{
				type: "input",
				block_id: "new_payment_url",
				optional: true,
				label: {
					type: "plain_text",
					text: "🔗 Nouvelle URL",
				},
				element: {
					type: "plain_text_input",
					action_id: "input_new_payment_url",
					placeholder: { type: "plain_text", text: "https://..." },
				},
				hint: {
					type: "plain_text",
					text: "Ajouter une nouvelle URL comme justificatif externe.",
				},
			}
		);

		// Add payment-mode-specific fields with prefill if the mode matches the original
		const isSameMode =
			paymentMode === (paymentData.paymentMode || paymentData.mode);
		if (paymentMode === "Chèque") {
			blocks.push(
				{ type: "divider" },
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: "*Détails du chèque*",
					},
				},
				{
					type: "input",
					block_id: "cheque_number",
					element: {
						type: "plain_text_input",
						action_id: "input_cheque_number",
						initial_value: isSameMode ? details.cheque_number || "" : "",
					},
					label: {
						type: "plain_text",
						text: "Numéro de chèque",
						emoji: true,
					},
				},
				{
					type: "input",
					block_id: "cheque_bank",
					element: {
						type: "static_select",
						action_id: "input_cheque_bank",
						options: bankOptions,
						initial_option: isSameMode
							? getBankInitialOption(details.cheque_bank) || bankOptions[0]
							: bankOptions[0],
					},
					label: {
						type: "plain_text",
						text: "Banque",
						emoji: true,
					},
				},
				{
					type: "input",
					block_id: "cheque_date",
					label: {
						type: "plain_text",
						text: "Date du chèque",
						emoji: true,
					},
					element: {
						type: "datepicker",
						action_id: "input_cheque_date",
						initial_date:
							isSameMode && details.cheque_date
								? new Date(details.cheque_date).toISOString().split("T")[0]
								: undefined,
					},
				},
				{
					type: "input",
					block_id: "cheque_order",
					label: { type: "plain_text", text: "Ordre" },
					element: {
						type: "plain_text_input",
						action_id: "input_cheque_order",
						initial_value: isSameMode ? details.cheque_order || "" : "",
					},
				}
			);
		} else if (paymentMode === "Virement") {
			blocks.push(
				{ type: "divider" },
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: "*Détails du virement*",
					},
				},
				{
					type: "input",
					block_id: "virement_number",
					element: {
						type: "plain_text_input",
						action_id: "input_virement_number",
						initial_value: isSameMode ? details.virement_number || "" : "",
					},
					label: {
						type: "plain_text",
						text: "Numéro de virement",
						emoji: true,
					},
				},
				{
					type: "input",
					block_id: "virement_bank",
					element: {
						type: "static_select",
						action_id: "input_virement_bank",
						options: bankOptions,
						initial_option: isSameMode
							? getBankInitialOption(details.virement_bank) || bankOptions[0]
							: bankOptions[0],
					},
					label: {
						type: "plain_text",
						text: "Banque",
						emoji: true,
					},
				},
				{
					type: "input",
					block_id: "virement_date",
					label: {
						type: "plain_text",
						text: "Date du virement",
						emoji: true,
					},
					element: {
						type: "datepicker",
						action_id: "input_virement_date",
						initial_date:
							isSameMode && details.virement_date
								? new Date(details.virement_date).toISOString().split("T")[0]
								: undefined,
					},
				},
				{
					type: "input",
					block_id: "virement_order",
					label: { type: "plain_text", text: "Ordre" },
					element: {
						type: "plain_text_input",
						action_id: "input_virement_order",
						initial_value: isSameMode ? details.virement_order || "" : "",
					},
				}
			);
		} else if (paymentMode === "Mobile Money") {
			blocks.push(
				{ type: "divider" },
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: "*Détails du Mobile Money*",
					},
				},
				{
					type: "input",
					block_id: "mobilemoney_recipient_phone",
					element: {
						type: "plain_text_input",
						action_id: "input_mobilemoney_recipient_phone",
						initial_value: isSameMode
							? details.mobilemoney_recipient_phone || ""
							: "",
					},
					label: {
						type: "plain_text",
						text: "Numéro de téléphone bénéficiaire",
						emoji: true,
					},
				},
				{
					type: "input",
					block_id: "mobilemoney_sender_phone",
					element: {
						type: "plain_text_input",
						action_id: "input_mobilemoney_sender_phone",
						initial_value: isSameMode
							? details.mobilemoney_sender_phone || ""
							: "",
					},
					label: {
						type: "plain_text",
						text: "Numéro envoyeur",
						emoji: true,
					},
				},
				{
					type: "input",
					block_id: "mobilemoney_date",
					label: {
						type: "plain_text",
						text: "Date",
						emoji: true,
					},
					element: {
						type: "datepicker",
						action_id: "input_mobilemoney_date",
						initial_date:
							isSameMode && details.mobilemoney_date
								? new Date(details.mobilemoney_date).toISOString().split("T")[0]
								: undefined,
					},
				}
			);
		} else if (paymentMode === "Julaya") {
			blocks.push(
				{ type: "divider" },
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: "*Détails Julaya*",
					},
				},
				{
					type: "input",
					block_id: "julaya_recipient",
					element: {
						type: "plain_text_input",
						action_id: "input_julaya_recipient",
						initial_value: isSameMode ? details.julaya_recipient || "" : "",
					},
					label: {
						type: "plain_text",
						text: "Bénéficiaire",
						emoji: true,
					},
				},
				{
					type: "input",
					block_id: "julaya_transaction_number",
					element: {
						type: "plain_text_input",
						action_id: "input_julaya_transaction_number",
						initial_value: isSameMode
							? details.julaya_transaction_number || ""
							: "",
					},
					label: {
						type: "plain_text",
						text: "Numéro de transaction",
						emoji: true,
					},
				},
				{
					type: "input",
					block_id: "julaya_date",
					label: {
						type: "plain_text",
						text: "Date",
						emoji: true,
					},
					element: {
						type: "datepicker",
						action_id: "input_julaya_date",
						initial_date:
							isSameMode && details.julaya_date
								? new Date(details.julaya_date).toISOString().split("T")[0]
								: undefined,
					},
				}
			);
		}

		console.log("paymentData", paymentData);
		console.log("paymentData.paymentProofs", paymentData.paymentProofs);
		console.log("paymentData.paymentUrl", paymentData.paymentUrl);

		const view = {
			type: "modal",
			callback_id: "payment_modification_submission",
			private_metadata: JSON.stringify({
				entityId,
				paymentIndex,
				reporterId,
				channelId: payload.channel?.id || process.env.SLACK_ADMIN_ID,
				existingProofs: paymentData.paymentProofs || [],
				existingUrls: paymentData.paymentUrl ? [paymentData.paymentUrl] : [],
				problemType,
				problemDescription,
			}),
			title: {
				type: "plain_text",
				text: "Modifier le paiement",
				emoji: true,
			},
			submit: {
				type: "plain_text",
				text: "Enregistrer",
				emoji: true,
			},
			close: {
				type: "plain_text",
				text: "Annuler",
				emoji: true,
			},
			blocks,
		};

		let response;
		if (payload.view?.id && selectedPaymentMode) {
			// Update existing modal
			console.log("Updating modal with view_id:", payload.view.id);
			response = await postSlackMessage2(
				"https://slack.com/api/views.update",
				{
					view_id: payload.view.id,
					hash: payload.view.hash, // Include hash to prevent conflicts
					view,
				},
				process.env.SLACK_BOT_TOKEN,
				{ headers: { "Content-Type": "application/json; charset=utf-8" } }
			);
		} else {
			// Open new modal
			console.log("Opening new modal with trigger_id:", payload.trigger_id);
			response = await postSlackMessage2(
				"https://slack.com/api/views.open",
				{ trigger_id: payload.trigger_id, view },
				process.env.SLACK_BOT_TOKEN,
				{ headers: { "Content-Type": "application/json; charset=utf-8" } }
			);
		}

		if (!response.data.ok) {
			throw new Error(`Slack API error: ${response.data.error}`);
		}

		context.log(`Payment modification modal opened for ${entityId}`);
		return {
			statusCode: 200,
			headers: { "Content-Type": "application/json" },
			body: "",
		};
		// return { response_action: "update" };
	} catch (error) {
		context.log(`Error handling modify payment: ${error.message}`);
		return {
			response_action: "errors",
			errors: {
				_error: `Une erreur s'est produite: ${error.message}`,
			},
		};
	}
}
// Function to handle payment mode selection in payment form
async function handlePaymentFormModeSelection(payload, context) {
	console.log("** handlePaymentFormModeSelection");
	const selectedValue = payload.actions[0].selected_option?.value;
	console.log("Selected payment mode:", selectedValue);

	if (!selectedValue) {
		console.error("No payment mode selected in payload");
		return;
	}

	const viewId = payload.view.id;
	const privateMetadata = payload.view.private_metadata;
	const metadata = JSON.parse(privateMetadata);

	// Get current blocks and remove existing payment method specific fields
	let blocks = payload.view.blocks.filter((block, index) => {
		// Keep base blocks and remove payment method specific blocks
		return (
			![
				"cheque_number",
				"cheque_bank",
				"cheque_date",
				"cheque_order",
				"virement_number",
				"virement_bank",
				"virement_date",
				"virement_order",
				"mobilemoney_recipient_phone",
				"mobilemoney_sender_phone",
				"mobilemoney_date",
				"julaya_recipient",
				"julaya_date",
				"julaya_transaction_number",
			].includes(block.block_id) &&
			!(block.type === "divider" && index > 4) &&
			!(block.type === "section" && block.text?.text?.includes("Détails"))
		);
	});

	// Add payment method specific blocks based on selection
	if (selectedValue === "Chèque") {
		blocks.push(
			{ type: "divider" },
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "*Détails du chèque*",
				},
			},
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
				element: { type: "plain_text_input", action_id: "input_cheque_order" },
			}
		);
	} else if (selectedValue === "Virement") {
		blocks.push(
			{ type: "divider" },
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "*Détails du virement*",
				},
			},
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
			}
		);
	} else if (selectedValue === "Mobile Money") {
		blocks.push(
			{ type: "divider" },
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "*Détails du Mobile Money*",
				},
			},
			{
				type: "input",
				block_id: "mobilemoney_recipient_phone",
				label: { type: "plain_text", text: "Numéro de téléphone bénéficiaire" },
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
				block_id: "mobilemoney_date",
				label: { type: "plain_text", text: "Date" },
				element: { type: "datepicker", action_id: "input_mobilemoney_date" },
			}
		);
	} else if (selectedValue === "Julaya") {
		blocks.push(
			{ type: "divider" },
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "*Détails Julaya*",
				},
			},
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
			}
		);
	}

	// Update the modal
	try {
		await postSlackMessageWithRetry(
			"https://slack.com/api/views.update",
			{
				view_id: viewId,
				view: {
					type: "modal",
					callback_id: "payment_form_submission",
					private_metadata: privateMetadata,
					title: { type: "plain_text", text: "Formulaire Paiement" },
					submit: { type: "plain_text", text: "Soumettre" },
					close: { type: "plain_text", text: "Annuler" },
					blocks: blocks,
				},
			},
			process.env.SLACK_BOT_TOKEN
		);
		console.log("Payment form modal updated with payment method fields");
	} catch (error) {
		console.error("Error updating payment form modal:", error);
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: payload.user.id,
				user: payload.user.id,
				text: "❌ Erreur lors de la mise à jour du formulaire. Veuillez réessayer.",
			},
			process.env.SLACK_BOT_TOKEN
		);
	}
}

// Add this new handler for payment mode selection in modification modal
async function handleModifyPaymentModeSelection(payload, context) {
	console.log("** handleModifyPaymentModeSelection");
	const selectedValue = payload.actions[0].selected_option?.value;
	console.log("Selected payment mode:", selectedValue);

	if (!selectedValue) {
		console.error("No payment mode selected in payload");
		return;
	}

	// Call handleModifyPayment with the selected mode to update the modal
	return await handleModifyPayment(payload, context, selectedValue);
}
async function handleBlockActions(payload, context) {
	console.log("** handleBlockActions");
	const action = payload.actions[0];
	const actionId = action.action_id;
	const userName = payload.user.username;
	console.log("** payloadType", payload.type);
	console.log("** action", payload.actions[0]);
	console.log("** action.value", action.value);
	console.log("** actionId", payload.actions[0].action_id);
	if (actionId === "edit_order") {
		console.log("** edit_order");
		try {
			// Get the order ID from the payload
			const orderId = payload.actions[0].value;
			context.log(`Editing order with ID: ${orderId}`);

			// Fetch the order from the database
			const order = await Order.findOne({ id_commande: orderId });
			if (!order) {
				throw new Error(`Order with ID ${orderId} not found`);
			}
			console.log("Order object:", order);

			console.log(`order.status ${order.statut}`);
			if (order.statut == "En attente") {
				// Prepare the form data from the existing order
				const formData = {
					request_title: {
						input_request_title: {
							value: order.titre || "",
						},
					},
					equipe_selection: {
						select_equipe: {
							selected_option: {
								value: order.equipe || "Non spécifié",
								text: {
									type: "plain_text",
									text: order.equipe || "Non spécifié",
								},
							},
						},
					},
					request_date: {
						input_request_date: {
							selected_date: order.date_requete
								? new Date(order.date_requete).toISOString().split("T")[0]
								: new Date().toISOString().split("T")[0],
						},
					},
				};
				console.log("formData:", formData);
				// Add articles data
				if (order.articles && order.articles.length > 0) {
					order.articles.forEach((article, index) => {
						const articleIndex = index + 1;

						// Add designation
						formData[`designation_${articleIndex}`] = {
							[`input_designation_${articleIndex}`]: {
								value: article.designation || "",
							},
						};

						// Add quantity
						formData[`quantity_number_${articleIndex}`] = {
							[`input_quantity_${articleIndex}`]: {
								value: article.quantity ? String(article.quantity) : "0",
							},
						};

						// Add unit - Make sure to include both value and text properties
						const unitValue = article.unit || "piece";
						const unitText = article.unit || "Pièce";

						formData[`quantity_unit_${articleIndex}`] = {
							[`select_unit_${articleIndex}`]: {
								selected_option: {
									value: unitValue,
									text: {
										type: "plain_text",
										text: unitText,
									},
								},
							},
						};
					});
				}

				// Prepare the suggestions object with any proformas
				const suggestions = {
					titre: order.titre || "",
					designations: order.articles?.map((a) => a.designation) || [],
				};

				// Generate the form view with the order data
				const view = await generateOrderForm(
					order.proformas || [],
					suggestions,
					formData
				);

				// Add metadata to track that this is an edit operation
				const metadata = {
					formData: formData,
					originalViewId: payload.trigger_id,
					orderId: orderId,
					isEdit: true,
					proformas: order.proformas || [],
					// Store the original message details
					originalMessage: {
						channel: payload.channel?.id || payload.channel || payload.user.id,
						ts: payload.message?.ts, // Store the timestamp of the original message
					},
				};
				console.log("$ metadata", metadata);

				// Open the modal with the prefilled data
				const response = await postSlackMessage2(
					"https://slack.com/api/views.open",
					{
						trigger_id: payload.trigger_id,
						view: {
							...view,
							private_metadata: JSON.stringify(metadata),
						},
					},
					process.env.SLACK_BOT_TOKEN
				);

				context.log(
					`Edit order form response: ${JSON.stringify(response.data)}`
				);
				if (!response.data.ok) {
					throw new Error(`Slack API error: ${response.data.error}`);
				}
			} else {
				await axios.post(
					"https://slack.com/api/chat.postEphemeral",
					{
						channel: payload.channel?.id || payload.channel || payload.user.id,
						user: payload.user.id,
						//text: `🛑 Échec de l'édition de la commande: ${error.message}`,
						text: `⚠️ Commande ${order.statut}e par l'Administrateur vous ne pouvez pas la modifier`,
					},
					{
						headers: {
							Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
						},
					}
				);
			}
		} catch (error) {
			context.log(
				`❌ Error in edit_order: ${error.message}\nStack: ${error.stack}`
			);
			await axios.post(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: payload.channel?.id || payload.channel || payload.user.id,
					user: payload.user.id,
					text: `🛑 Échec de l'édition de la commande: ${error.message}`,
				},
				{
					headers: {
						Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
					},
				}
			);
		}
	}
	// 2. Add the edit payment handler (similar to edit_order)
	if (actionId === "edit_payment") {
		console.log("** edit_payment");
		await handleEditPayment(payload, context);
	}
	if (actionId === "fill_funding_details") {
		console.log("**3 fill_funding_details");
		console.log("Message TS:", payload.message?.ts);
		console.log("Channel ID:", payload.channel?.id);
		// Immediate response to close modal
		context.res = {
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ response_action: "clear" }),
		};

		// Process in background
		setImmediate(async () => {
			console.log("approve_funding");
			const messageTs = payload.message?.ts;
			const channelId = payload.channel?.id; // Get the current channel ID

			console.log("Processing fill_funding_details");
			console.log(`Message TS: ${messageTs}, Channel ID: ${channelId}`);

			const requestId = action.value; // e.g., FUND/2025/04/0070

			await generateFundingApprovalPaymentModal(
				context,
				payload.trigger_id,
				messageTs,
				requestId,
				channelId
			);
			return createSlackResponse(200, "");
		});

		return context.res;
	}
	if (payload.type === "interactive_message" && action.value === "open") {
		console.log("** interactive_message");
		console.log("** open");

		if (action.name === "open_form") {
			context.res = {
				status: 200,
				body: "", // Empty response acknowledges receipt
			};
			setImmediate(async () => {
				try {
					const autoSuggestions = [];
					// await require("./aiService").suggestAutoCompletions(
					//   payload.user.id,
					//   context
					// );

					const view = await generateOrderForm([], {
						titre: autoSuggestions.titre,
						equipe: autoSuggestions.equipe,
						quantity: autoSuggestions.quantity,
						unit: autoSuggestions.unit,
						designations: autoSuggestions.designations,
					});

					if (payload.channel && payload.channel.id) {
						view.private_metadata = JSON.stringify({
							channelId: payload.channel.id,
						});
					}

					const response = await postSlackMessage2(
						"https://slack.com/api/views.open",
						{ trigger_id: payload.trigger_id, view },
						process.env.SLACK_BOT_TOKEN
					);

					context.log(`views.open response: ${JSON.stringify(response.data)}`);
					if (!response.data.ok) {
						context.log(`views.open error: ${response.data.error}`);
						return {
							statusCode: 200,
							body: JSON.stringify({
								response_type: "ephemeral",
								text: `❌ Erreur: ${response.data.error}`,
							}),
							headers: { "Content-Type": "application/json" },
						};
					}
					return { statusCode: 200, body: "" };
				} catch (error) {
					context.log(
						`❌ Error opening form: ${error.message}\nStack: ${error.stack}`
					);
					return {
						statusCode: 200,
						body: JSON.stringify({
							response_type: "ephemeral",
							text: `❌ Erreur: Impossible d'ouvrir le formulaire (${error.message})`,
						}),
						headers: { "Content-Type": "application/json" },
					};
				}
			});

			return context.res;
		} else if (action.name === "finance_payment_form") {
			context.res = {
				status: 200,
				body: "", // Empty response acknowledges receipt
			};

			// Then process the command asynchronously after acknowledgment
			setImmediate(async () => {
				try {
					console.log("aaaa ");
					const view = generatePaymentRequestForm({});

					if (payload.channel && payload.channel.id) {
						view.private_metadata = JSON.stringify({
							channelId: payload.channel.id,
						});
					}

					const response = await postSlackMessage9(
						"https://slack.com/api/views.open",
						{ trigger_id: payload.trigger_id, view },
						process.env.SLACK_BOT_TOKEN
					);
					console.log(
						"Full postSlackMessage response:",
						JSON.stringify(response)
					);
					console.log("Returning context.res:", JSON.stringify(context.res));
					context.log(`views.open response: ${JSON.stringify(response)}`);
					if (!response.ok) {
						context.log(`views.open error: ${response.error}`);
						return createSlackResponse(200, {
							response_type: "ephemeral",
							text: `❌ Erreur: ${response.error}`,
						});
					}
					if (response.warning) {
						console.log("views.open warning:", response.warning);
						// Optionally handle warnings without showing an error to the user
					}
					return createSlackResponse(200, "");
				} catch (error) {
					context.log(
						`❌ Error opening payment form: ${error.message}\nStack: ${error.stack}`
					);
					return createSlackResponse(200, {
						response_type: "ephemeral",
						text: `❌ Erreur: Impossible d'ouvrir le formulaire de paiement (${error.message})`,
					});
				}
			});
			return context.res;
		}
	}

	if (actionId === "return_to_form") {
		try {
			// Use payload.actions[0].value instead of payload.value
			const { viewId, formDataKey } = JSON.parse(payload.actions[0].value);
			console.log("formDataKey", formDataKey);
			const formData = await getFromStorage(formDataKey);
			if (!formData) {
				context.log(`Form data not found for key: ${formDataKey}`);
				return await postSlackMessage2(
					"https://slack.com/api/chat.postEphemeral",
					{
						channel: payload.user.id, // Fallback to team_id if channelId is missing
						user: payload.user.id,
						text: "🛑 Les données du formulaire ont expiré ou sont introuvables. Veuillez recommencer.",
					},
					process.env.SLACK_BOT_TOKEN
				);
			}

			// Log the button value length (for debugging, optional)
			const buttonValue = payload.actions[0].value;
			context.log(`Button value length: ${buttonValue.length}`);
			if (buttonValue.length > 2000) {
				throw new Error("Button value exceeds 2000 characters");
			}

			// Safely parse private_metadata with a fallback
			let parsedMetadata;
			try {
				parsedMetadata = payload.view.private_metadata
					? JSON.parse(payload.view.private_metadata)
					: {};
			} catch (parseError) {
				context.log(`Failed to parse private_metadata: ${parseError.message}`);
				parsedMetadata = {};
			}

			// Use parsedMetadata safely
			const safeFormData = formData || {}; // Use retrieved formData instead of metadata
			const originalViewId = parsedMetadata.viewId || payload.view.root_view_id;

			const view = await generateOrderForm([], {}, safeFormData); // Pass the retrieved formData
			const response = await postSlackMessage2(
				"https://slack.com/api/views.update",
				{
					view_id: originalViewId, // Use the original view ID
					view: {
						...view,
						private_metadata: JSON.stringify({
							...parsedMetadata,
							formDataKey: formDataKey, // Store the key for future reference
						}),
					},
				},
				process.env.SLACK_BOT_TOKEN
			);

			context.log(`Return to form response: ${JSON.stringify(response.data)}`);
			if (!response.data.ok) {
				throw new Error(`Slack API error: ${response.data.error}`);
			}
		} catch (error) {
			context.log(
				`❌ Error in return_to_form: ${error.message}\nStack: ${error.stack}`
			);
			await postSlackMessage2(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: payload.user.id, // Fallback to team_id if channelId is missing
					user: payload.user.id,
					text: `🛑 Échec du rechargement du formulaire: ${error.message}`,
				},
				process.env.SLACK_BOT_TOKEN
			);
		}
	}
	if (actionId === "input_payment_method") {
		console.log("Handling payment method selection");
		await handlePaymentMethodSelection(payload, context);
		return createSlackResponse(200, "");
	}
	if (actionId === "process_delayed_order") {
		return await handleDelayedOrderAction(payload, action, context);
	}
	if (actionId === "process_delayed_order") {
		return await handleDelayedOrderAction(payload, action, context);
	}
	const paymentId = action.value;
	if (action.action_id === "accept_payment") {
		const paymentRequest = await PaymentRequest.findOneAndUpdate(
			{ id_paiement: paymentId },
			{ statut: "Validé", autorisation_admin: true, updatedAt: new Date() },
			{ new: true }
		);
		console.log("paymentRequest1", paymentRequest);

		await notifyFinancePayment(paymentRequest, context, validatedBy);
		// Update Slack message (e.g., via chat.update)
		return { statusCode: 200, body: "" };
	} else if (action.action_id === "reject_payment") {
		console.log("sssdd");
		// Open rejection modal (similar to orderStatusService.js)
		const view = {
			type: "modal",
			callback_id: "reject_payment_reason",
			title: { type: "plain_text", text: "Raison du rejet" },
			submit: { type: "plain_text", text: "Soumettre" },
			close: { type: "plain_text", text: "Annuler" },
			blocks: [
				{
					type: "input",
					block_id: "rejection_reason",
					element: {
						type: "plain_text_input",
						action_id: "input_reason",
						multiline: true,
					},
					label: { type: "plain_text", text: "Raison du rejet" },
				},
			],
			private_metadata: JSON.stringify({ paymentId }),
		};
		const response = await postSlackMessage(
			"https://slack.com/api/views.open",
			{ trigger_id: payload.trigger_id, view },
			process.env.SLACK_BOT_TOKEN
		);
		context.log(`Rejection modal response: ${JSON.stringify(response)}`);
		return { statusCode: 200, body: "" };
	}
	if (payload.type === "dialog_submission") {
		console.log("** dialog_submission");

		// Handle dialog submissions
		const callbackId = payload.callback_id;

		switch (callbackId) {
			case "delete_order_confirm":
				return await handleDeleteOrderConfirmed(payload, context);
			// Add other dialog submissions as needed
			default:
				return createSlackResponse(200, {
					response_type: "ephemeral",
					text: "Action de dialogue non reconnue.",
				});
		}
	}
	let requestId;
	if (payload.type === "block_actions") {
		console.log("** block_actions");
		if (actionId.startsWith("view_order_")) {
			return await view_order(payload, action, context);
		}
		switch (actionId) {
			case "correct_funding_details":
				console.log("** correct_funding_details");
				const value = JSON.parse(payload.actions[0].value);
				console.log("** value", value);
				const requestId = value.requestId;
				console.log("** requestId", requestId);

				const channelId = value.channelId;
				console.log("** channelId", channelId);

				const message = value.messageTs;

				await generateCorrectionModal(
					context,
					payload.trigger_id,
					requestId,
					channelId,
					message
				);
				return createSlackResponse(200, "");

			// Modify the case statement for funding_approval_payment
			case "funding_approval_payment":
				console.log("**5 funding_approval_payment");
				// Open confirmation dialog instead of processing immediately
				await openFinalApprovalConfirmationDialog(payload);
				return createSlackResponse(200, "");

			// In handleBlockActions function under block_actions switch
			case "open_funding_form":
				console.log("** open_funding_form");
				try {
					const triggerId = payload.trigger_id;
					const channelId = payload.channel?.id;
					if (!triggerId || !channelId) {
						throw new Error("Missing trigger_id or channel_id");
					}
					const mockParams = new Map();
					mockParams.set("channel_id", channelId);
					mockParams.set("trigger_id", triggerId);

					// const view =
					await generateFundingRequestForm(context, triggerId, mockParams);
					// if (!view.blocks || !Array.isArray(view.blocks)) {
					// 	throw new Error("Modal view missing blocks array");
					// }

					// const response = await postSlackMessage2(
					// 	"https://slack.com/api/views.open",
					// 	{ trigger_id: payload.trigger_id, view },
					// 	process.env.SLACK_BOT_TOKEN
					// );

					// context.log(`views.open response: ${JSON.stringify(response.data)}`);
					// if (!response.data.ok) {
					// 	throw new Error(`Slack API error: ${response.data.error}`);
					// }
					return createSlackResponse(200, "");
				} catch (error) {
					context.log(
						`❌ Error opening funding form: ${error.message}\nStack: ${error.stack}`
					);
					return createSlackResponse(200, {
						response_type: "ephemeral",
						text: "❌ Erreur lors de l'ouverture du formulaire. Veuillez réessayer.",
					});
				}
			case "payment_verif_accept":
			case "payment_verif_reject":
				console.log("** payment_verif_accept or payment_verif_reject");

				console.log("payload1", payload);
				try {
					const isAccept = actionId === "payment_verif_accept";
					const paymentId = action.value;
					console.log("paymentId1", paymentId);
					let order;
					if (paymentId.startsWith("CMD/")) {
						order = await Order.findOne({ id_commande: paymentId });

						if (!order) {
							return createSlackResponse(200, {
								response_type: "ephemeral",
								text: "Order not found.",
							});
						}
						// Check order status
						const status = order.statut;
						console.log("status1", status);
						// Check if the order has already been approved once
						if (order.isApprovedOnce) {
							await postSlackMessage(
								"https://slack.com/api/chat.postEphemeral",
								{
									channel: process.env.SLACK_ADMIN_ID,
									user: payload.user.id,
									text: `❌ Cet demande a déjà été ${status}e`,
								},
								process.env.SLACK_BOT_TOKEN
							);
							return { response_action: "clear" };
						}
					}
					if (paymentId.startsWith("PAY/")) {
						order = await PaymentRequest.findOne({ id_paiement: paymentId });
						// Check order status
						const status = order.statut;
						console.log("status1", status);
						if (!order) {
							return createSlackResponse(200, {
								response_type: "ephemeral",
								text: "Order not found.",
							});
						}

						// Check if the order has already been approved once
						if (order.isApprovedOnce) {
							await postSlackMessage(
								"https://slack.com/api/chat.postEphemeral",
								{
									channel: process.env.SLACK_ADMIN_ID,
									user: payload.user.id,
									text: `❌ Cet demande a déjà été ${status}e`,
								},
								process.env.SLACK_BOT_TOKEN
							);
							return { response_action: "clear" };
						}
					}
					// Open confirmation modal
					const view = {
						type: "modal",
						callback_id: "payment_verif_confirm",
						title: { type: "plain_text", text: "Confirmation" },
						submit: { type: "plain_text", text: "Confirmer" },
						close: { type: "plain_text", text: "Annuler" },
						blocks: [
							{
								type: "section",
								text: {
									type: "mrkdwn",
									text: `Êtes-vous sûr de vouloir ${
										isAccept ? "approuver" : "rejeter"
									} cette demande ?`,
								},
							},
						],
						private_metadata: JSON.stringify({
							paymentId,
							action: isAccept ? "accept" : "reject",
							message_ts: payload.message.ts,
						}),
					};

					await postSlackMessage2(
						"https://slack.com/api/views.open",
						{ trigger_id: payload.trigger_id, view },
						process.env.SLACK_BOT_TOKEN
					);
					return { statusCode: 200, body: "" };
				} catch (error) {
					context.log(`Confirmation error: ${error}`);
					return createSlackResponse(500, "❌ Erreur de confirmation");
				}
			case "reject_fund":
				fundId = action.value;
				console.log("Rejecting FUND", fundId);
				return openRejectionReasonModalFund(payload, fundId);

			case "accept_order":
			case "reject_order":
				const entityId1 = action.value;
				let order;
				console.log("paymentId", entityId1);
				console.log("action&", action);

				const entity1 = await fetchEntity(entityId1, context);
				if (!entity1) {
					context.log(`Entity ${entityId1} not found`);
					return {
						response_action: "errors",
						errors: {
							_error: `Entity ${entityId1} not found`,
						},
					};
				}

				// Check order status
				const status = entity1.statut;
				console.log("status1", status);
				// Check if the order has already been approved once
				if (entity1.isApprovedOnce) {
					await postSlackMessage(
						"https://slack.com/api/chat.postEphemeral",
						{
							channel: process.env.SLACK_ADMIN_ID,
							user: payload.user.id,
							text: `❌ Cet demande a déjà été ${status}e.`,
						},
						process.env.SLACK_BOT_TOKEN
					);
					return { response_action: "clear" };
				}

				return await handleOrderStatus(payload, action, context);

			case "reopen_order":
				return await reopenOrder(payload, action, context);

			//!$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$
			case "approve_funding":
				const messageTs = payload.message?.ts;
				console.log("approve_funding");
				requestId = action.value; // e.g., FUND/2025/04/0070

				await generateFundingApprovalPaymentModal(
					context,
					payload.trigger_id,
					messageTs,
					requestId
				);
				return createSlackResponse(200, "");
			case "approve_1":
				//!
				console.log("**2 approve_1");
				await handleValidationRequest(payload, context);
				return createSlackResponse(200, "");
			// Modify the case statement for pre_approve_funding
			case "pre_approve_funding":
				console.log("**2 pre_approve_funding");
				// Instead of directly handling pre-approval, open a confirmation dialog
				await openPreApprovalConfirmationDialog(payload);
				return createSlackResponse(200, "");

			case "finance_payment_form":
				const entityId = action.value;
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
					console.log(
						'entityId.startsWith("CMD/")',
						entityId.startsWith("CMD/")
					);
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
				});
				return await generatePaymentForm({
					payload,
					action,
					context,
					selectedPaymentMode: null,
					orderId: action.value,
				});
			case "confirm_payment_mode_2":
				console.log("** confirm_payment_mode_2");
				const selectedMode2 =
					payload.view.state.values.payment_mode.select_payment_mode
						.selected_option?.value;
				if (!selectedMode2) {
					context.log("No payment mode selected");
					return createSlackResponse(200, {
						response_type: "ephemeral",
						text: "Veuillez sélectionner un mode de paiement avant de confirmer.",
					});
				}
				return await handleModifyPayment(payload, context, selectedMode2);
			// Add this case in the handleBlockActions function
			case "select_payment_mode":
				// Check if this is from the payment form modal
				if (payload.view?.callback_id === "payment_form_submission") {
					console.log("Handling payment mode selection for payment form");
					await handlePaymentFormModeSelection(payload, context);
					return createSlackResponse(200, "");
				}
				// Check if this is from the payment modification modal
				else if (
					payload.view?.callback_id === "payment_modification_submission"
				) {
					console.log(
						"Handling payment mode selection for payment modification"
					);
					await handleModifyPaymentModeSelection(payload, context);
					return createSlackResponse(200, "");
				}
				// Existing logic for other cases
				break;
			case "confirm_payment_mode":
				console.log("** confirm_payment_mode");
				const selectedMode =
					payload.view.state.values.payment_mode.select_payment_mode
						.selected_option?.value;
				if (!selectedMode) {
					context.log("No payment mode selected");
					return createSlackResponse(200, {
						response_type: "ephemeral",
						text: "Veuillez sélectionner un mode de paiement avant de confirmer.",
					});
				}
				const privateMetadata = JSON.parse(
					payload.view.private_metadata || "{}"
				);
				return await generatePaymentForm({
					payload,
					action,
					context,
					selectedPaymentMode: selectedMode,
					orderId: privateMetadata.entityId,
				});
			case "confirm_validate_proforma":
				return await handleProformaValidationRequest(payload, context);
			case "proforma_form":
				return await proforma_form(payload, action, context);
			case "validate_proforma":
				return await validateProforma(payload, context);
			case "delete_confirmation": // For canceling validation
				return await cancelValidation(payload, context);

			case "delete_order":
				return await handleDeleteOrder(payload, context);

			case "delete_order_confirmed":
				return await handleDeleteOrderConfirmed(payload, context);

			case "delete_order_canceled":
				return await handleDeleteOrderCanceled(payload, context);

			case "Modifier_paiement":
				return await handlePaymentModification(payload, context);

			case "mode_input":
				return await handlePaymentModeSelection(payload, context);
			case "report_problem":
				// Process in background
				setImmediate(async () => {
					console.log("111111");
					return await handleReportProblem(payload, context);
				});
			case "modify_payment":
				console.log("22222");
				return await handleModifyPayment(payload, context);
			case "edit_proforma":
				return await handleEditProforma(payload, context);
			case "confirm_delete_proforma":
				return await handleDeleteProformaConfirmation(payload, context);
			case "confirm_validate_proforma":
				return await handleValidateProforma(payload, context);
			case "report_fund_problem":
				const msg = payload.container.message_ts;
				console.log("messageTs", msg);
				return await handleReportProblem(payload, context, msg);

			default:
				return await handleDynamicFormUpdates(payload, action, context);
		}
	}

	if (payload.actions && payload.actions[0].action_id === "return_to_form") {
		console.log("** return_to_form");

		try {
			// Close the error modal
			await axios.post(
				"https://slack.com/api/views.update",
				{
					view_id: payload.view.id,
					view: {
						type: "modal",
						callback_id: "closing",
						title: {
							type: "plain_text",
							text: "Closing...",
						},
						blocks: [
							{
								type: "section",
								text: {
									type: "plain_text",
									text: "Returning to form...",
								},
							},
						],
					},
				},
				{
					headers: {
						Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
						"Content-Type": "application/json",
					},
				}
			);

			// Re-open the original form (you'll need to store or recreate your form view)
			// This requires you to save your view content elsewhere

			return { status: 200 };
		} catch (error) {
			context.log(`Error handling button action: ${error}`);
			return { status: 200 };
		}
	}

	return createSlackResponse(400, "Type d'action non supporté");
}

// Function to handle the dynamic mode selection - for Action Response
async function handlePaymentModeSelection(payload, context) {
	console.log("** handlePaymentModeSelection");
	const { WebClient } = require("@slack/web-api");
	const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

	try {
		const selectedMode = payload.actions[0].selected_option.value;
		const viewId = payload.view.id;
		const privateMetadata = payload.view.private_metadata;

		// Get the current blocks
		let blocks = payload.view.blocks;

		// Find the index where mode-specific blocks would start
		// Typically after the payment_mode block
		let insertIndex =
			blocks.findIndex((block) => block.block_id === "payment_mode") + 1;

		// Remove any existing payment-specific blocks (between mode selection and URL)
		const urlIndex = blocks.findIndex(
			(block) => block.block_id === "payment_url"
		);
		if (urlIndex > insertIndex) {
			blocks = [...blocks.slice(0, insertIndex), ...blocks.slice(urlIndex)];
		}

		// Insert new blocks based on mode
		let newBlocks = [];
		switch (selectedMode) {
			case "Chèque":
				newBlocks = createChequeBlocks({});
				break;
			case "Virement":
				newBlocks = createVirementBlocks({});
				break;
			case "Mobile Money":
				newBlocks = createMobileMoneyBlocks({});
				break;
			case "Julaya":
				newBlocks = createJulayaBlocks({});
				break;
			// No blocks for Espèces
		}
		if (selectedMode === "Espèces") {
			try {
				await deductCashForPayment(orderId, payment, context);
			} catch (error) {
				return createSlackResponse(400, `Erreur: ${error.message}`);
			}
		}
		// Insert the new blocks
		blocks.splice(insertIndex, 0, ...newBlocks);

		// Update the view
		await slack.views.update({
			view_id: viewId,
			view: {
				type: "modal",
				callback_id: "payment_modification_modal",
				private_metadata: privateMetadata,
				title: {
					type: "plain_text",
					text: "Modifier le paiement",
					emoji: true,
				},
				submit: {
					type: "plain_text",
					text: "Enregistrer",
					emoji: true,
				},
				close: {
					type: "plain_text",
					text: "Annuler",
					emoji: true,
				},
				blocks: blocks,
			},
		});
	} catch (error) {
		context.log.error(`Error handling payment mode selection: ${error}`);
	}
}

function formatDateForDatepicker(dateInput) {
	console.log("** formatDateForDatepicker");
	const date = new Date(dateInput);
	if (isNaN(date.getTime())) return null;

	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
		2,
		"0"
	)}-${String(date.getDate()).padStart(2, "0")}`;
}

// Helper functions to create payment-specific blocks
function createChequeBlocks(details) {
	console.log("** createChequeBlocks");
	return [
		{
			type: "input",
			block_id: "cheque_number",
			label: {
				type: "plain_text",
				text: "Numéro de chèque",
				emoji: true,
			},
			element: {
				type: "plain_text_input",
				action_id: "cheque_number_input",
				initial_value: details.cheque_number || "",
			},
		},
		{
			type: "input",
			block_id: "cheque_bank",
			label: {
				type: "plain_text",
				text: "Banque",
				emoji: true,
			},
			element: {
				type: "plain_text_input",
				action_id: "cheque_bank_input",
				initial_value: details.cheque_bank || "",
			},
		},
		{
			type: "input",
			block_id: "cheque_date",
			label: {
				type: "plain_text",
				text: "Date du chèque",
				emoji: true,
			},
			element: {
				type: "datepicker",
				action_id: "cheque_date_input",
				initial_date:
					formatDateForDatepicker(details.cheque_date) ||
					formatDateForDatepicker(new Date()),
			},
		},
		{
			type: "input",
			block_id: "cheque_order",
			label: {
				type: "plain_text",
				text: "Ordre",
				emoji: true,
			},
			element: {
				type: "plain_text_input",
				action_id: "cheque_order_input",
				initial_value: details.cheque_order || "",
			},
		},
	];
}

function createVirementBlocks(details) {
	console.log("** createVirementBlocks");
	return [
		{
			type: "input",
			block_id: "virement_number",
			label: {
				type: "plain_text",
				text: "Numéro de virement",
				emoji: true,
			},
			element: {
				type: "plain_text_input",
				action_id: "virement_number_input",
				initial_value: details.virement_number || "",
			},
		},
		{
			type: "input",
			block_id: "virement_bank",
			label: {
				type: "plain_text",
				text: "Banque",
				emoji: true,
			},
			element: {
				type: "plain_text_input",
				action_id: "virement_bank_input",
				initial_value: details.virement_bank || "",
			},
		},
		{
			type: "input",
			block_id: "virement_date",
			label: {
				type: "plain_text",
				text: "Date du virement",
				emoji: true,
			},
			element: {
				type: "datepicker",
				action_id: "virement_date_input",
				initial_date:
					formatDateForDatepicker(details.virement_date) ||
					formatDateForDatepicker(new Date()),
			},
		},
		{
			type: "input",
			block_id: "virement_order",
			label: {
				type: "plain_text",
				text: "Ordre",
				emoji: true,
			},
			element: {
				type: "plain_text_input",
				action_id: "virement_order_input",
				initial_value: details.virement_order || "",
			},
		},
	];
}

function createMobileMoneyBlocks(details) {
	console.log("** createMobileMoneyBlocks");
	return [
		{
			type: "input",
			block_id: "mobilemoney_recipient_phone",
			label: {
				type: "plain_text",
				text: "Téléphone destinataire",
				emoji: true,
			},
			element: {
				type: "plain_text_input",
				action_id: "mobilemoney_recipient_phone_input",
				initial_value: details.mobilemoney_recipient_phone || "",
			},
		},
		{
			type: "input",
			block_id: "mobilemoney_sender_phone",
			label: {
				type: "plain_text",
				text: "Téléphone émetteur",
				emoji: true,
			},
			element: {
				type: "plain_text_input",
				action_id: "mobilemoney_sender_phone_input",
				initial_value: details.mobilemoney_sender_phone || "",
			},
		},
		{
			type: "input",
			block_id: "mobilemoney_date",
			label: {
				type: "plain_text",
				text: "Date du transfert",
				emoji: true,
			},
			element: {
				type: "datepicker",
				action_id: "mobilemoney_date_input",
				initial_date:
					formatDateForDatepicker(details.mobilemoney_date) ||
					formatDateForDatepicker(new Date()),
			},
		},
	];
}

function createJulayaBlocks(details) {
	console.log("** createJulayaBlocks");
	return [
		{
			type: "input",
			block_id: "julaya_recipient",
			label: {
				type: "plain_text",
				text: "Destinataire",
				emoji: true,
			},
			element: {
				type: "plain_text_input",
				action_id: "julaya_recipient_input",
				initial_value: details.julaya_recipient || "",
			},
		},
		{
			type: "input",
			block_id: "julaya_date",
			label: {
				type: "plain_text",
				text: "Date de la transaction",
				emoji: true,
			},
			element: {
				type: "datepicker",
				action_id: "julaya_date_input",
				initial_date:
					formatDateForDatepicker(details.julaya_date) ||
					formatDateForDatepicker(new Date()),
			},
		},
		{
			type: "input",
			block_id: "julaya_transaction_number",
			label: {
				type: "plain_text",
				text: "Numéro de transaction",
				emoji: true,
			},
			element: {
				type: "plain_text_input",
				action_id: "julaya_transaction_number_input",
				initial_value: details.julaya_transaction_number || "",
			},
		},
	];
}

async function view_order(payload, action, context) {
	console.log("** view_order");
	const orderId = action.value.split("order_details_")[1];
	context.log(`Fetching details for order ID: ${orderId}`);

	const order = await Order.findOne({ id_commande: orderId });
	if (!order) {
		context.log(`Order ${orderId} not found`);
		return axios.post(payload.response_url, {
			response_type: "ephemeral",
			text: `⚠️ Commande #${orderId} non trouvée.`,
		});
	}

	// Construct the response text in the same style as handleOrderList
	let responseText = `*📦 Commande #${order.id_commande}*\n\n`;

	// Order Header Information
	const headerDetails = [
		`👤 *Demandeur:* <@${order.demandeur}>`,
		`📌 *Titre:* ${order.titre || "Sans titre"}`,
		`#️⃣ *Canal:* ${order.channel || "Non spécifié"}`,
		`👥 *Équipe:* ${order.equipe || "Non spécifié"}`,
		`📅 *Date:* ${order.date.toLocaleString()}`,
		`⚙️ *Statut:* ${order.statut || "Non défini"}`,
		`🔐 *Autorisation Admin:* ${
			order.autorisation_admin ? "✅ Autorisé" : "❌ Non autorisé"
		}`,
	];
	responseText += headerDetails.join("\n") + "\n";

	// Rejection Reason (if applicable)
	if (order.rejection_reason) {
		responseText += `\n🚫 *Raison du Rejet:* ${order.rejection_reason}\n`;
	}

	// Articles Details
	responseText += "\n*📦 Articles Commandés:*\n";
	if (order.articles.length > 0) {
		order.articles.forEach((article, i) => {
			responseText += `  ${i + 1}. ${article.quantity} ${
				article.unit || ""
			} - ${article.designation}\n`;
		});
	} else {
		responseText += "  - Aucun article\n";
	}

	// Proformas
	responseText += "\n*📝 Proformas:*\n";
	if (order.proformas.length > 0) {
		order.proformas.forEach((proforma, i) => {
			responseText += `  ${i + 1}. `;
			responseText += `*Nom:* <${proforma.urls}|${
				proforma.nom || `Proforma ${i + 1}`
			}> `;
			responseText += `| *Montant:* ${proforma.montant} ${proforma.devise} `;
			responseText += `| *fichiers:* ${proforma.file_ids || "N/A"}\n`;
		});
	} else {
		responseText += "  - Aucun\n";
	}

	// Payments
	responseText += "\n*💰 Détails des Paiements:*\n";
	if (order.payments.length > 0) {
		order.payments.forEach((payment, i) => {
			responseText += `  *Paiement ${i + 1}:*\n`;
			responseText += `    • *Mode:* ${payment.paymentMode}\n`;
			responseText += `    • *Titre:* ${payment.paymentTitle}\n`;
			responseText += `    • *Montant:* ${payment.amountPaid}\n`;
			responseText += `    • *Statut:* ${payment.paymentStatus || "Partiel"}\n`;
			responseText += `    • *Date:* ${payment.dateSubmitted.toLocaleString()}\n`;

			// Payment Proof
			if (payment.paymentProofs?.length > 0) {
				responseText += `    • *Preuve:* <${payment.paymentProofs}|Justificatif>\n`;
			} else if (payment.paymentUrl) {
				responseText += `    • *Lien:* <${payment.paymentUrl}|Lien de Paiement>\n`;
			} else {
				responseText += `    • *Preuve:* Aucune\n`;
			}

			// Payment Details
			responseText += "    • *Détails Supplémentaires:*\n";
			if (payment.details && Object.keys(payment.details).length > 0) {
				Object.entries(payment.details).forEach(([key, value]) => {
					responseText += `      - ${key}: ${value}\n`;
				});
			} else {
				responseText += "      - Aucun détail supplémentaire\n";
			}
		});
	} else {
		responseText += "  - Aucun paiement\n";
	}

	// Total Amount Paid
	responseText += `\n*Total Payé:* ${order.amountPaid || 0}€\n`;

	try {
		console.log("payload.channel.id", payload.channel.id);
		console.log("payload.channel.id", payload);
		try {
			console.log("payload.channel.id", payload.channel.id);

			// Post as a new message in the channel (visible to everyone)
			const slackResponse = await axios.post(
				"https://slack.com/api/chat.postMessage",
				{
					channel: payload.channel.id,
					text: responseText,
					// Optional: make it a thread reply to the original message
					thread_ts: payload.container.message_ts,
				},
				{
					headers: {
						Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
						"Content-Type": "application/json",
					},
				}
			);

			context.log(`Slack response: ${JSON.stringify(slackResponse.data)}`);

			if (!slackResponse.data.ok) {
				throw new Error(`Slack API error: ${slackResponse.data.error}`);
			}

			return createSlackResponse(200, "");
		} catch (error) {
			context.log(`Error sending to Slack API: ${error.message}`);
			if (error.response) {
				context.log(
					`Slack error response: ${JSON.stringify(error.response.data)}`
				);
			}

			// Fallback to response_url if channel posting fails
			try {
				await axios.post(payload.response_url, {
					response_type: "ephemeral",
					text: responseText,
				});
			} catch (fallbackError) {
				context.log(`Fallback also failed: ${fallbackError.message}`);
			}

			return createSlackResponse(200, "");
		}

		context.log(`Slack response: ${JSON.stringify(slackResponse.data)}`);
	} catch (error) {
		context.log(`Error sending to Slack API: ${error.message}`);
		if (error.response) {
			context.log(
				`Slack error response: ${JSON.stringify(error.response.data)}`
			);
		}
	}

	return createSlackResponse1(200, ""); // Empty response to avoid Slack timeout error
}

function createSlackResponse1(statusCode, content) {
	console.log("** createSlackResponse1");
	return {
		statusCode: statusCode,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(content),
	};
}

function createSlackResponse1(statusCode, content) {
	console.log("** createSlackResponse1");
	return {
		statusCode: statusCode,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(content),
	};
}
const VALID_CURRENCIES = ["XOF", "USD", "EUR"];

// Dynamic Form Updates
async function handleDynamicFormUpdates(payload, action, context) {
	console.log("** handleDynamicFormUpdates");
	if (!payload.view || !payload.view.blocks) {
		context.log("❌ Payload invalide: view.blocks manquant");
		return createSlackResponse(400, "Payload invalide");
	}
	if (
		payload.actions[0].type === "overflow" &&
		payload.actions[0].selected_option
	) {
		const selectedValue = payload.actions[0].selected_option.value;
		if (selectedValue.startsWith("remove_proforma_")) {
			try {
				console.log("remove_proforma");
				const indexToRemove = parseInt(selectedValue.split("_")[2], 10);
				const metadata = JSON.parse(payload.view.private_metadata);
				let { formData, suggestions, proformas } = metadata;

				// Remove the proforma at the specified index
				proformas = proformas.filter((_, i) => i !== indexToRemove);

				// Regenerate the form view
				const updatedView = await generateOrderForm(
					proformas,
					suggestions,
					formData
				);

				// Update metadata
				metadata.proformas = proformas;
				updatedView.private_metadata = JSON.stringify(metadata);

				// Update the modal
				const response = await postSlackMessage2(
					"https://slack.com/api/views.update",
					{
						view_id: payload.view.id,
						view: updatedView,
					},
					process.env.SLACK_BOT_TOKEN
				);

				context.log(
					`Remove proforma response: ${JSON.stringify(response.data)}`
				);
				if (!response.data.ok) {
					throw new Error(`Slack API error: ${response.data.error}`);
				}
			} catch (error) {
				context.log(
					`❌ Error in remove_proforma: ${error.message}\nStack: ${error.stack}`
				);
				await axios.post(
					"https://slack.com/api/chat.postEphemeral",
					{
						channel: payload.channel?.id || payload.user.id,
						user: payload.user.id,
						text: `🛑 Échec de la suppression du proforma: ${error.message}`,
					},
					{
						headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
					}
				);
			}
		}
	}
	const actionId = action.action_id;
	let updatedBlocks = [...payload.view.blocks];
	if (actionId === "add_article") {
		const newArticleIndex = updatedBlocks.filter((b) =>
			b.block_id?.startsWith("article_")
		).length;
		console.log("newArticleIndex", newArticleIndex);
		updatedBlocks.splice(-1, 0, ...generateArticleBlocks(newArticleIndex));
	} else if (actionId.startsWith("add_proforma_")) {
		const articleIndex = actionId.split("_").pop();
		const insertIndex = updatedBlocks.findIndex(
			(b) => b.block_id === `add_proforma_${articleIndex}`
		);
		updatedBlocks.splice(
			insertIndex,
			1,
			...generateProformaBlocks(articleIndex)
		);
	} else if (actionId.startsWith("cancel_proforma_")) {
		const articleIndex = actionId.split("_").pop();
		const insertIndex = updatedBlocks.findIndex(
			(b) => b.block_id === `cancel_proforma_${articleIndex}`
		);

		if (insertIndex !== -1) {
			// Add check to ensure block was found
			updatedBlocks.splice(insertIndex, 4, {
				// Change 3 to 4 to match all proforma blocks
				type: "actions",
				block_id: `add_proforma_${articleIndex}`,
				elements: [
					{
						type: "button",
						action_id: `add_proforma_${articleIndex}`,
						text: { type: "plain_text", text: "📎 Ajouter une proforma" },
						value: `add_proforma_${articleIndex}`,
					},
				],
			});
		}
	} else if (actionId.startsWith("remove_article_")) {
		const index = actionId.split("_").pop();
		updatedBlocks = updatedBlocks.filter(
			(block) =>
				!block.block_id?.startsWith(`article_${index}`) &&
				!block.block_id?.startsWith(`quantity_${index}`) &&
				!block.block_id?.startsWith(`input_quantity_${index}`) &&
				!block.block_id?.startsWith(`quantity_unit_${index}`) &&
				!block.block_id?.startsWith(`quantity_number_${index}`) &&
				!block.block_id?.startsWith(`designation_${index}`) &&
				!block.block_id?.startsWith(`add_proforma_${index}`) &&
				!block.block_id?.startsWith(`divider_${index}`) &&
				!block.block_id?.startsWith(`article_photos_${index}`)
		);
	}
	const originalPrivateMetadata = payload.view.private_metadata;
	await postSlackMessage(
		"https://slack.com/api/views.update",
		{
			view_id: payload.view.id,
			hash: payload.view.hash,
			view: {
				type: "modal",
				callback_id: "order_form_submission",
				title: { type: "plain_text", text: "Nouvelle Commande" },
				submit: { type: "plain_text", text: "Envoyer" },
				close: { type: "plain_text", text: "Annuler" },
				blocks: updatedBlocks,
				private_metadata: originalPrivateMetadata,
			},
		},
		process.env.SLACK_BOT_TOKEN
	);

	return createSlackResponse(200, "");
}

async function updateView(viewId) {
	console.log("** updateView");
	await postSlackMessage(
		"https://slack.com/api/views.update",
		{
			view_id: viewId,
			view: {
				type: "modal",
				title: { type: "plain_text", text: "Processing..." },
				close: { type: "plain_text", text: "Close" },
			},
		},
		process.env.SLACK_BOT_TOKEN
	);
}

async function validateProforma(payload, context) {
	console.log("** validateProforma");
	try {
		const value = JSON.parse(payload.actions[0].value);
		const { orderId, proformaIndex, comment } = value;
		console.log("val11");
		// Find the order
		const order = await Order.findOne({ id_commande: orderId });
		if (!order) {
			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: "❌ Erreur : Commande non trouvée.",
			});
		}

		// Check if any proforma is already validated
		const alreadyValidated = order.proformas.some((p) => p.validated);
		if (alreadyValidated) {
			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: "❌ Une proforma a déjà été validée pour cette commande.",
			});
		}

		// Validate the proforma
		const proformaToValidate = order.proformas[proformaIndex];
		if (!proformaToValidate) {
			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: "❌ Erreur : Proforma non trouvée.",
			});
		}

		// Update the proforma with validation info
		proformaToValidate.validated = true;
		proformaToValidate.validatedAt = new Date();
		proformaToValidate.validatedBy = payload.user.id;
		if (comment) {
			proformaToValidate.validationComment = comment;
		}

		// Save the updated order
		await order.save();

		// Notify both admin and achat channels with updated message
		await notifyAdminProforma(order, context, proformaIndex);

		// // Post a confirmation message to the thread
		// const slackResponse = await postSlackMessage(
		//   "https://slack.com/api/chat.postMessage",
		//   {
		//     channel: process.env.SLACK_ADMIN_ID,
		//     text: `:white_check_mark: Proforma ${
		//       proformaToValidate.nom || `#${parseInt(proformaIndex) + 1}`
		//     } validée par <@${payload.user.id}>${
		//       comment ? ` avec commentaire: "${comment}"` : ""
		//     }.`,
		//     blocks: [
		//       {
		//         type: "section",
		//         text: {
		//           type: "mrkdwn",
		//           text: `:white_check_mark: Proforma ${
		//             proformaToValidate.nom || `#${parseInt(proformaIndex) + 1}`
		//           } validée par <@${payload.user.id}>${
		//             comment ? ` avec commentaire: "${comment}"` : ""
		//           }.`,
		//         },
		//       },
		//       {
		//         type: "actions",
		//         elements: [
		//           // {
		//           //   type: "button",
		//           //   text: {
		//           //     type: "plain_text",
		//           //     text: "Annuler la valdation",
		//           //     emoji: true,
		//           //   },
		//           //   style: "danger", // Moved style to button level
		//           //   value: `proforma_${proformaIndex}`,
		//           //   action_id: "delete_confirmation",
		//           // },
		//           {
		//             type: "button",
		//             text: {
		//               type: "plain_text",
		//               text: "Supprimer la commande",
		//               emoji: true,
		//             },
		//             style: "danger", // Moved style to button level
		//             value: `proforma_${proformaIndex}`,
		//             action_id: "delete_order",
		//           },
		//         ],
		//       },
		//     ],
		//   },
		//   process.env.SLACK_BOT_TOKEN
		// );

		// if (!slackResponse.ok) {
		//   context.log(
		//     `Error posting Slack message: ${
		//       slackResponse.error
		//     }, Details: ${JSON.stringify(slackResponse)}`
		//   );
		// }
		const actionValue = JSON.parse(payload.actions[0].value);
		// Extract the orderId from the parsed object
		const orderId1 = actionValue.orderId;
		// Query the Order collection with a proper filter object
		const order2 = await Order.findOne({ id_commande: orderId1 });
		console.log("order111", order2);
		return await notifyTeams(payload, order2, context);
		// Continue execution even if finance notification fails

		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: `:white_check_mark: Proforma validée avec succès.`,
		});
	} catch (error) {
		context.log(`Error in validateProforma: ${error.message}`, error.stack);
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: `❌ Erreur lors de la validation: ${error.message}`,
		});
	}
}

// New function to handle proforma submission
async function handleProformaSubmission(payload, context) {
	console.log("** handleProformaSubmission");
	const { orderId } = JSON.parse(payload.view.private_metadata);
	const values = payload.view.state.values;
	context.log("payload11112", payload);

	context.log("orderId", orderId);
	context.log("values", JSON.stringify(values));
	let userId = payload.user.id;

	try {
		let timestampedProformas;
		let i = 0;
		// Use the extractProformas function to process all proforma data
		const proformaDataArray = await extractProformas(
			values,
			context,
			0,
			userId
		);
		console.log("proformaDataArray2", proformaDataArray);

		if (proformaDataArray.valid == false) {
			console.log("proformaDataArray1", proformaDataArray);
			return { response_action: "clear" };
		} else {
			// Add createdAt timestamp to each proforma
			timestampedProformas = proformaDataArray.map((proforma) => ({
				...proforma,
				createdAt: new Date(),
			}));
		}

		// Update the order in MongoDB with all proforma entries
		const updatedOrder = await Order.findOneAndUpdate(
			{ id_commande: orderId },
			{ $push: { proformas: { $each: timestampedProformas } } },
			{ new: true }
		);

		if (!updatedOrder) {
			throw new Error(`Order ${orderId} not found`);
		}

		context.log("Updated order with proformas:", JSON.stringify(updatedOrder));

		// Prepare notification message
		let messageText;
		if (proformaDataArray.length === 1) {
			const proforma = proformaDataArray[0];
			const hasFile = !!proforma.file_id;
			messageText = `✅ Proforma ajoutée pour *${orderId}*: ${proforma.nom} - ${
				proforma.montant
			} ${proforma.devise}${
				hasFile ? ` avec fichier <${proforma.url}|voir>` : ` (URL)`
			}`;
		} else {
			messageText = `✅ ${
				proformaDataArray.length
			} proformas ajoutées pour *${orderId}* (Total: ${proformaDataArray.reduce(
				(sum, p) => sum + p.montant,
				0
			)} ${proformaDataArray[0].devise})`;
		}
		try {
			// Notify admin
			await notifyAdminProforma(updatedOrder, context);
		} catch (notifyError) {
			context.log(`WARNING: Admin notification failed: ${notifyError.message}`);
			// Continue execution even if admin notification fails
		}
		// // Post Slack message to the designated channel
		// const slackResponse = await postSlackMessage(
		//   "https://slack.com/api/chat.postMessage",
		//   { channel: process.env.SLACK_ACHAT_CHANNEL_ID, text: messageText },
		//   process.env.SLACK_BOT_TOKEN
		// );

		// if (!slackResponse.ok) {
		//   context.log(`${slackResponse.error}`);
		// }
		return { response_action: "clear" };
	} catch (error) {
		const slackResponse = await postSlackMessage(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ACHAT_CHANNEL_ID,
				// text: `Error in proforma submission: ${error.message}`,
				text: "❌ Veuillez charger au moins une proforma avant de continuer.",
			},
			process.env.SLACK_BOT_TOKEN
		);
		context.log(
			`❌ Error in proforma submission: ${error.message}`,
			error.stack
		);
		return {
			response_action: "errors",
			errors: {
				proforma_submission: `❌ Erreur lors de l'enregistrement des proformas: ${error.message}`,
			},
		};
	}
}
// Updated edit_payment handler to use the corrected function
async function handleEditPayment(payload, context) {
	console.log("** edit_payment");

	try {
		const paymentId = payload.actions[0].value;
		context.log(`Editing payment with ID: ${paymentId}`);

		const payment = await PaymentRequest.findOne({ id_paiement: paymentId });
		if (!payment) {
			throw new Error(`Payment with ID ${paymentId} not found`);
		}
		console.log("Payment request object:", payment);

		console.log(`payment.status ${payment.statut}`);

		if (payment.statut === "En attente") {
			// Separate files and URLs from justificatifs
			const justificatifs = payment.justificatif.map((j) => j.url); // Include all justificatifs (files and URLs)
			const urlJustificatif =
				payment.justificatif.find((j) => j.type === "url")?.url || "";
			const formData = {
				payment_title: {
					input_payment_title: {
						value: payment.titre || "",
					},
				},
				payment_date: {
					input_payment_date: {
						selected_date: payment.date_requete
							? new Date(payment.date_requete).toISOString().split("T")[0]
							: new Date().toISOString().split("T")[0],
					},
				},
				payment_description: {
					input_payment_description: {
						value: payment.motif || "",
					},
				},
				payment_amount: {
					input_payment_amount: {
						value: payment.montant ? String(payment.montant) : "",
					},
				},
				po_number: {
					input_po_number: {
						value: payment.bon_de_commande || "",
					},
				},
				justificatif_url: {
					input_justificatif_url: {
						value: urlJustificatif,
					},
				},
				existing_justificatifs: justificatifs,
				currency: payment.devise || "", // Store file URLs for display
			};
			console.log("Payment formData:", formData);

			const metadata = {
				formData: formData,
				originalViewId: payload.trigger_id,
				paymentId: paymentId,
				isEdit: true,
				originalMessage: {
					channel: payload.channel?.id || payload.channel || payload.user.id,
					ts: payload.message?.ts,
				},
			};
			console.log("$ payment metadata", metadata);

			const view = await generatePaymentForm1(formData);

			const response = await postSlackMessage2(
				"https://slack.com/api/views.open",
				{
					trigger_id: payload.trigger_id,
					view: {
						...view,
						private_metadata: JSON.stringify(metadata),
					},
				},
				process.env.SLACK_BOT_TOKEN
			);

			context.log(
				`Edit payment form response: ${JSON.stringify(response.data)}`
			);

			if (!response.data.ok) {
				throw new Error(`Slack API error: ${response.data.error}`);
			}
		} else {
			await axios.post(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: payload.channel?.id || payload.channel || payload.user.id,
					user: payload.user.id,
					text: `⚠️ Demande de paiement ${payment.statut}e par l'Administrateur, vous ne pouvez pas la modifier`,
				},
				{
					headers: {
						Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
					},
				}
			);
		}
	} catch (error) {
		context.log(
			`❌ Error in edit_payment: ${error.message}\nStack: ${error.stack}`
		);

		await axios.post(
			"https://slack.com/api/chat.postEphemeral",
			{
				channel: payload.channel?.id || payload.channel || payload.user.id,
				user: payload.user.id,
				text: `🛑 Échec de l'édition de la demande de paiement: ${error.message}`,
			},
			{
				headers: {
					Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
				},
			}
		);
	}
}
module.exports = {
	handleDynamicFormUpdates,
	validateProforma,
	updateView,
	handleBlockActions,
	handleProformaSubmission,
	handleBlockActions,
	executeOrderDeletion,
	handleFundingApprovalPaymentSubmission,
	postSlackMessage2,
};
