const {
	handlePaymentModificationSubmission,
} = require("../../Caisse/Handlers/caissePaymentHandlers");
const { notifyTechSlack } = require("../../Common/notifyProblem");
const {
	createSlackResponse,
	postSlackMessage,
	postSlackMessageWithRetry,
	updateSlackMessage1,
	postSlackMessage2,
} = require("../../Common/slackUtils");
const { fetchEntity } = require("../../Common/utils");
const { Caisse } = require("../../Database/dbModels/Caisse");
const { Order } = require("../../Database/dbModels/Order");
const PaymentRequest = require("../../Database/dbModels/PaymentRequest");

const { getProformaBlocks, getOrderBlocks } = require("./orderMessageBlocks");

const { notifyTeams } = require("./orderNotificationService");
const { openRejectionReasonModal } = require("./orderRejectionHandlers");

async function getAvailableCaisses() {
	try {
		const caisses = await Caisse.find({}, "type channelId");
		return caisses;
	} catch (error) {
		await notifyTechSlack(error);

		console.error("Error fetching caisses:", error);
		return [];
	}
}
async function createPaymentConfirmationModal(
	paymentId,
	isAccept,
	message_ts,
	selectedPaymentMethod = null
) {
	const isPaymentRequest = paymentId.startsWith("PAY/");
	const caisses = await getAvailableCaisses();

	// Create options for caisse selection
	const caisseOptions = caisses.map((caisse) => ({
		text: {
			type: "plain_text",
			text: caisse.type,
		},
		value: caisse._id.toString(),
	}));

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
		private_metadata: JSON.stringify({
			paymentId,
			action: isAccept ? "accept" : "reject",
			message_ts,
			selectedPaymentMethod,
		}),
	};

	return view;
}
async function handlePaymentVerification(payload, action, context) {
	console.log("** payment_verif_accept or payment_verif_reject");

	console.log("payload1", payload);
	try {
		const actionId = action.action_id;
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
					text: "Payment request not found.",
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
		// Create enhanced confirmation modal with caisse selection
		const view = await createPaymentConfirmationModal(
			paymentId,
			isAccept,
			payload.message.ts
		);

		await postSlackMessage2(
			"https://slack.com/api/views.open",
			{ trigger_id: payload.trigger_id, view },
			process.env.SLACK_BOT_TOKEN
		);
		return { statusCode: 200, body: "" };
	} catch (error) {
		await notifyTechSlack(error);

		context.log(`Confirmation error: ${error}`);
		return createSlackResponse(500, "❌ Erreur de confirmation");
	}
}
async function updateSlackMessageAcceptance(messageTs, orderId, status, order) {
	console.log("** updateSlackMessageAcceptance");
	await postSlackMessage(
		"https://slack.com/api/chat.update",
		{
			channel: process.env.SLACK_ADMIN_ID,
			ts: messageTs,
			text: `Demande *${orderId}* - *${status}*`,
			blocks: [
				...getOrderBlocks(order),
				...getProformaBlocks(order),

				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `✅ Demande *${status}* avec succèes`,
					},
				},

				// {
				//   type: "actions",
				//   elements: [
				//     {
				//       type: "button",
				//       text: { type: "plain_text", text: "Rouvrir" },
				//       action_id: "reopen_order",
				//       value: orderId
				//     }
				//   ]
				// }
			],
		},
		process.env.SLACK_BOT_TOKEN
	);
}

// //* ??
// //* payment_modification_submission
// async function handlePaymentModificationSubmission(payload, context) {
// 	console.log("** ?? handlePaymentModificationSubmission");

// 	// Slack API configuration
// 	const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
// 	const SLACK_API_URL = "https://slack.com/api";

// 	// Helper function to post Slack messages
// 	async function postSlackMessage(channel, text, blocks) {
// 		try {
// 			const response = await axios.post(
// 				`${SLACK_API_URL}/chat.postMessage`,
// 				{
// 					channel,
// 					text,
// 					blocks,
// 				},
// 				{
// 					headers: {
// 						Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
// 						"Content-Type": "application/json",
// 					},
// 				}
// 			);
// 			if (!response.data.ok) {
// 				throw new Error(`Slack API error: ${response.data.error}`);
// 			}
// 			console.log(`Slack message posted to channel ${channel}`);
// 		} catch (error) {
// 			await notifyTechSlack(error);

// 			console.error(`Error posting Slack message: ${error.message}`);
// 			throw error;
// 		}
// 	}

// 	// Helper function to post ephemeral Slack messages
// 	async function postSlackEphemeral(channel, user, text) {
// 		try {
// 			const response = await axios.post(
// 				`${SLACK_API_URL}/chat.postEphemeral`,
// 				{
// 					channel,
// 					user,
// 					text,
// 				},
// 				{
// 					headers: {
// 						Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
// 						"Content-Type": "application/json",
// 					},
// 				}
// 			);
// 			if (!response.data.ok) {
// 				throw new Error(`Slack API error: ${response.data.error}`);
// 			}
// 			console.log(
// 				`Ephemeral Slack message posted to user ${user} in channel ${channel}`
// 			);
// 		} catch (error) {
// 			await notifyTechSlack(error);

// 			console.error(`Error posting ephemeral Slack message: ${error.message}`);
// 			throw error;
// 		}
// 	}

// 	try {
// 		console.log("Handling payment modification submission");
// 		const metadata = JSON.parse(payload.view.private_metadata);
// 		console.log("Metadata$:", metadata);
// 		// Extract metadata and submitted values
// 		const privateMetadata = JSON.parse(payload.view.private_metadata);
// 		const entityId = metadata.entityId;
// 		const orderId = metadata.entityId;
// 		const paymentIndex = metadata.paymentIndex;
// 		const selectedCaisseId = metadata.selectedCaisseId;
// 		console.log("$$/ selectedCaisseId", selectedCaisseId);

// 		console.log("$$ existingProofs", metadata.existingProofs);
// 		console.log("$$ existingUrls", metadata.existingUrls);

// 		const values = payload.view.state.values;

// 		console.log("Submitted payload values:", JSON.stringify(values, null, 2));
// 		// console.log("Order ID:", orderId, "Payment Index:", paymentIndex);

// 		// Extract form data from the modal
// 		const paymentTitle = values.payment_title?.input_payment_title?.value || "";
// 		const paymentAmount =
// 			parseFloat(values.amount_paid?.input_amount_paid?.value) || 0;
// 		const paymentMode =
// 			values.payment_mode?.select_payment_mode?.selected_option?.value || "";
// 		let paymentUrl = values.paiement_url?.input_paiement_url?.value || "";
// 		const paymentDate = new Date();
// 		let paymentStatus = paymentAmount > 0 ? "Partiel" : "Non payé";
// 		paymentStatus = paymentAmount == 0 ? "Payé" : paymentStatus;

// 		console.log("$$ paymentStatus", paymentStatus);

// 		// // If new payment URL was provided, use that instead
// 		// if (values.new_payment_url?.input_new_payment_url?.value) {
// 		//   paymentUrl = values.new_payment_url.input_new_payment_url.value;
// 		// }
// 		// console.log(
// 		//   "Payment URL:",
// 		//   values.new_payment_url?.input_new_payment_url?.value
// 		// );

// 		console.log("Extracted payment data:", {
// 			paymentTitle,
// 			paymentAmount,
// 			paymentMode,
// 			paymentUrl,
// 			paymentDate,
// 			paymentStatus,
// 		});

// 		// Prepare payment details based on mode
// 		let paymentDetails = {};
// 		if (paymentMode === "Chèque") {
// 			paymentDetails = {
// 				cheque_number: values.cheque_number?.input_cheque_number?.value || "",
// 				cheque_bank:
// 					values.cheque_bank?.input_cheque_bank?.selected_option?.value || "",
// 				cheque_date: values.cheque_date?.input_cheque_date?.selected_date || "",
// 				cheque_order: values.cheque_order?.input_cheque_order?.value || "",
// 			};
// 		} else if (paymentMode === "Virement") {
// 			paymentDetails = {
// 				virement_number:
// 					values.virement_number?.input_virement_number?.value || "",
// 				virement_bank:
// 					values.virement_bank?.input_virement_bank?.selected_option?.value ||
// 					"",
// 				virement_date:
// 					values.virement_date?.input_virement_date?.selected_date || "",
// 				virement_order:
// 					values.virement_order?.input_virement_order?.value || "",
// 			};
// 		} else if (paymentMode === "Mobile Money") {
// 			paymentDetails = {
// 				mobilemoney_recipient_phone:
// 					values.mobilemoney_recipient_phone?.input_mobilemoney_recipient_phone
// 						?.value,
// 				mobilemoney_sender_phone:
// 					values.mobilemoney_sender_phone?.input_mobilemoney_sender_phone
// 						?.value,
// 				mobilemoney_fees:
// 					values.mobilemoney_fees?.input_mobilemoney_fees?.value,
// 				mobilemoney_date:
// 					values.mobilemoney_date?.input_mobilemoney_date?.selected_date,
// 			};
// 		} else if (paymentMode === "Julaya") {
// 			paymentDetails = {
// 				julaya_recipient:
// 					values.julaya_recipient?.input_julaya_recipient?.value,
// 				julaya_date: values.julaya_date?.input_julaya_date?.selected_date,
// 				julaya_transaction_number:
// 					values.julaya_transaction_number?.input_julaya_transaction_number
// 						?.value,
// 			};
// 		}
// 		// Find the entity and get the original payment
// 		let entity;
// 		let originalPayment;
// 		let currency = "USD";

// 		if (orderId.startsWith("CMD/")) {
// 			entity = await Order.findOne({ id_commande: orderId });
// 			if (!entity || !entity.payments) {
// 				throw new Error(`Commande ${orderId} non trouvée ou sans paiements`);
// 			}

// 			if (paymentIndex < 0 || paymentIndex >= entity.payments.length) {
// 				throw new Error(
// 					`Index de paiement ${paymentIndex} invalide pour la commande ${orderId}`
// 				);
// 			}

// 			originalPayment = entity.payments[paymentIndex];

// 			console.log("Original payment:", originalPayment);

// 			if (
// 				entity.proformas &&
// 				entity.proformas.length > 0 &&
// 				entity.proformas[0].validated === true
// 			) {
// 				currency = entity.proformas[0].devise;
// 			}
// 		} else if (orderId.startsWith("PAY/")) {
// 			entity = await PaymentRequest.findOne({ id_paiement: orderId });
// 			if (!entity || !entity.payments) {
// 				throw new Error(
// 					`Demande de paiement ${orderId} non trouvée ou sans paiements`
// 				);
// 			}

// 			if (paymentIndex < 0 || paymentIndex >= entity.payments.length) {
// 				throw new Error(
// 					`Index de paiement ${paymentIndex} invalide pour la demande ${orderId}`
// 				);
// 			}

// 			originalPayment = entity.payments[paymentIndex];
// 			console.log("Original payment:", originalPayment);

// 			if (entity.devise) {
// 				currency = entity.devise;
// 			}
// 		} else {
// 			throw new Error(`Format d'ID non reconnu: ${orderId}`);
// 		}

// 		// Check caisse balance for cash payments
// 		if (paymentMode.trim() === "Espèces") {
// 			const originalAmount =
// 				originalPayment && originalPayment.paymentMode === "Espèces"
// 					? originalPayment.amountPaid || 0
// 					: 0;
// 			const amountChange = paymentAmount - originalAmount;
// 			console.log("Caisse check:", {
// 				originalAmount,
// 				paymentAmount,
// 				amountChange,
// 			});

// 			if (amountChange !== 0) {
// 				const caisse = await Caisse.findById(selectedCaisseId);

// 				if (!caisse) {
// 					throw new Error("Caisse document not found");
// 				}

// 				const currentBalance = caisse.balances[currency] || 0;
// 				const projectedBalance = currentBalance - amountChange;
// 				console.log("Caisse balance check:", {
// 					currentBalance,
// 					amountChange,
// 					projectedBalance,
// 				});

// 				if (projectedBalance < 0) {
// 					console.log(
// 						`❌ Error: Insufficient funds in Caisse for ${currency}. Current: ${currentBalance}, Required: ${amountChange}`
// 					);
// 					await postSlackMessage(
// 						process.env.SLACK_FINANCE_CHANNEL_ID || "C08KS4UH5HU",
// 						`❌ MODIFICATION DE PAIEMENT BLOQUÉE : Solde insuffisant dans la caisse pour ${currency}. Solde actuel: ${currentBalance}, Montant supplémentaire nécessaire: ${amountChange}. Veuillez recharger la caisse avant de procéder.`,
// 						[]
// 					);
// 					await postSlackEphemeral(
// 						payload.channel?.id || "C08KS4UH5HU",
// 						payload.user.id,
// 						`❌ Modification de paiement en espèces refusée pour ${orderId} : Solde insuffisant dans la caisse pour ${currency}. L'équipe des finances a été notifiée.`
// 					);
// 					return {
// 						status: 200,
// 						headers: { "Content-Type": "application/json" },
// 						body: JSON.stringify({ response_action: "clear" }),
// 					};
// 				}

// 				// Update Caisse balance
// 				const caisseUpdate = {
// 					$inc: { [`balances.${currency}`]: -amountChange },
// 					$push: {
// 						transactions: {
// 							type: "payment_modification",
// 							amount: -amountChange,
// 							currency,
// 							orderId,
// 							details: `Modification du paiement pour ${paymentTitle} (Order: ${orderId})`,
// 							timestamp: new Date(),
// 							paymentMethod: "Espèces",
// 							paymentDetails,
// 						},
// 					},
// 				};

// 				console.log("Caisse update:", caisseUpdate);
// 				const updatedCaisse = await Caisse.findOneAndUpdate(
// 					{ _id: selectedCaisseId },
// 					caisseUpdate,
// 					{ new: true }
// 				).catch((err) => {
// 					console.error(`Error updating Caisse: ${err.message}`);
// 					throw new Error(`Failed to update Caisse: ${err.message}`);
// 				});

// 				// Sync Caisse to Excel
// 				if (updatedCaisse.latestRequestId) {
// 					await syncCaisseToExcel(
// 						updatedCaisse,
// 						updatedCaisse.latestRequestId
// 					).catch((err) => {
// 						console.error(`Error syncing Caisse to Excel: ${err.message}`);
// 					});
// 					console.log(
// 						`Excel file updated for latest request ${updatedCaisse.latestRequestId} with new balance for ${currency}`
// 					);
// 				} else {
// 					console.log(
// 						"No latestRequestId found in Caisse, skipping Excel sync"
// 					);
// 				}

// 				// Notify finance team
// 				await postSlackMessage(
// 					process.env.SLACK_FINANCE_CHANNEL_ID || "C08KS4UH5HU",
// 					`✅ Modification de paiement en espèces traitée pour ${orderId}. Changement: ${amountChange} ${currency}. Nouveau solde de la caisse: ${updatedCaisse.balances[currency]}.`,
// 					[]
// 				);
// 			} else {
// 				console.log("No Caisse update needed: amountChange is 0");
// 			}
// 		}
// 		// FIX: Handle payment proofs properly
// 		// FIXED: Handle payment proofs properly
// 		let paymentProofs = [];

// 		// Extract existing_proof_${index} values
// 		const existingProofsFromForm = [];
// 		if (metadata.existingProofs && Array.isArray(metadata.existingProofs)) {
// 			metadata.existingProofs.forEach((_, index) => {
// 				const proofValue =
// 					values[`existing_proof_${index}`]?.[`edit_proof_${index}`]?.value;
// 				if (proofValue && typeof proofValue === "string" && proofValue.trim()) {
// 					existingProofsFromForm.push(proofValue.trim());
// 				}
// 			});
// 		}
// 		console.log("$$ Existing Proofs from Form:", existingProofsFromForm);

// 		// Start with existing proofs from form (non-deleted)
// 		paymentProofs = [...existingProofsFromForm];

// 		// Add existing URLs from metadata if available and not already included
// 		// if (metadata.existingUrls && typeof metadata.existingUrls === "string") {
// 		//   if (!paymentProofs.includes(metadata.existingUrls)) {
// 		//     paymentProofs.push(metadata.existingUrls);
// 		//     console.log(
// 		//       "$$ Added existing URL from metadata:",
// 		//       metadata.existingUrls
// 		//     );
// 		//   }
// 		// }

// 		// Add new URL as a proof if provided
// 		if (values.new_payment_url?.input_new_payment_url?.value) {
// 			const newUrl = values.new_payment_url.input_new_payment_url.value;
// 			if (!paymentProofs.includes(newUrl)) {
// 				paymentProofs.push(newUrl);
// 				console.log("$$ Added new payment URL as proof:", newUrl);
// 			}
// 		}
// 		console.log("$$ url", values.new_payment_url?.input_new_payment_url?.value);
// 		// Add file uploads if provided
// 		if (
// 			values.payment_proof_file?.file_upload_proof?.files &&
// 			values.payment_proof_file.file_upload_proof.files.length > 0
// 		) {
// 			const fileUrls = values.payment_proof_file.file_upload_proof.files
// 				.map(
// 					(file) =>
// 						file.permalink || file.url_private_download || file.url_private
// 				) // Use permalink first
// 				.filter(
// 					(url) =>
// 						url && typeof url === "string" && !paymentProofs.includes(url)
// 				);

// 			paymentProofs = paymentProofs.concat(fileUrls);
// 			console.log("$$ Added file upload proofs:", fileUrls);
// 		}

// 		// Remove any undefined/null values and duplicates
// 		paymentProofs = [
// 			...new Set(
// 				paymentProofs.filter(
// 					(proof) => proof && typeof proof === "string" && proof.trim()
// 				)
// 			),
// 		];
// 		console.log("$$ Final Payment proofs:", paymentProofs);
// 		// if (

// 		//   originalPayment &&
// 		//   originalPayment.paymentProofs
// 		// ) {
// 		//   paymentProofs = [...originalPayment.paymentProofs];
// 		// }

// 		// // Add new URL as a proof if provided
// 		// if (values.new_payment_url?.input_new_payment_url?.value) {
// 		//   paymentProofs.push(values.new_payment_url.input_new_payment_url.value);

// 		// }
// 		// console.log("$$ url", values.new_payment_url?.input_new_payment_url?.value);

// 		// // Add file uploads if provided
// 		// if (
// 		//   values.payment_proof_file?.file_upload_proof?.files &&
// 		//   values.payment_proof_file.file_upload_proof.files.length > 0
// 		// ) {
// 		//   paymentProofs = paymentProofs.concat(
// 		//     values.payment_proof_file.file_upload_proof.files.map(
// 		//       (file) => file.url
// 		//     )
// 		//   );
// 		// }Z
// 		console.log("$$ Payment proof:", paymentProofs);

// 		// Prepare the updated payment object
// 		const updatedPayment = {
// 			paymentMode,
// 			amountPaid: paymentAmount,
// 			paymentTitle,
// 			paymentUrl,
// 			paymentProofs,
// 			details: paymentDetails,
// 			status: paymentStatus,
// 			dateSubmitted: paymentDate,
// 		};

// 		console.log("Updated payment data:", updatedPayment);

// 		// Update the payment in the database
// 		if (orderId.startsWith("CMD/")) {
// 			entity.payments[paymentIndex] = {
// 				...entity.payments[paymentIndex],
// 				...updatedPayment,
// 				_id: entity.payments[paymentIndex]._id,
// 			};

// 			// Update total amount paid and remaining amount
// 			const totalAmountPaid = entity.payments.reduce(
// 				(sum, payment) => sum + (payment.amountPaid || 0),
// 				0
// 			);
// 			const totalAmountDue = await calculateTotalAmountDue(entityId, context);
// 			entity.amountPaid = totalAmountPaid;
// 			entity.remainingAmount = totalAmountDue - totalAmountPaid;
// 			entity.paymentDone = entity.remainingAmount <= 0;
// 			console.log("entity.remainingAmount:", entity.remainingAmount);
// 			entity.payments.paymentStatus =
// 				entity.remainingAmount == 0 ? "Payé" : paymentStatus;
// 			paymentStatus = entity.payments.paymentStatus;
// 			console.log("$$ paymentStatus", paymentStatus);

// 			await entity.save();
// 			console.log(`Payment ${paymentIndex} updated in order ${orderId}`);
// 		} else if (orderId.startsWith("PAY/")) {
// 			entity.payments[paymentIndex] = {
// 				...entity.payments[paymentIndex],
// 				...updatedPayment,
// 				_id: entity.payments[paymentIndex]._id,
// 			};

// 			// Update total amount paid and remaining amount
// 			const totalAmountPaid = entity.payments.reduce(
// 				(sum, payment) => sum + (payment.amountPaid || 0),
// 				0
// 			);
// 			const totalAmountDue = await calculateTotalAmountDue(entityId, context);
// 			// Validate to prevent negative remaining amount
// 			const remainingAmount = totalAmountDue - totalAmountPaid;
// 			if (remainingAmount < 0) {
// 				throw new Error(
// 					`Overpayment detected: Payment of ${totalAmountPaid} exceeds total amount due of ${totalAmountDue}.`
// 				);
// 			}

// 			entity.amountPaid = totalAmountPaid;
// 			entity.remainingAmount = remainingAmount;
// 			entity.paymentDone = entity.remainingAmount <= 0;
// 			entity.payments.paymentStatus =
// 				entity.remainingAmount == 0 ? "Payé" : paymentStatus;

// 			console.log("$$ paymentStatus", paymentStatus);

// 			await entity.save();
// 			console.log(
// 				`Payment ${paymentIndex} updated in payment request ${orderId}. Total paid: ${totalAmountPaid}, Remaining: ${entity.remainingAmount}`
// 			);
// 		}
// 		console.log("C");
// 		if (entityId.startsWith("CMD/")) {
// 			updateResult = await Order.updateOne(
// 				{ id_commande: entityId },
// 				{
// 					$set: {
// 						blockPayment: false,
// 					},
// 				}
// 			);
// 			context.log(`Update result: ${JSON.stringify(updateResult)}`);
// 			// Refresh entity to ensure latest data
// 			updatedEntity = await fetchEntity(entityId, context);
// 			// console.log("Updated entity:", updatedEntity);
// 		} else if (entityId.startsWith("PAY/")) {
// 			updateResult = await PaymentRequest.findOneAndUpdate(
// 				{ id_paiement: entityId },
// 				{
// 					$set: {
// 						blockPayment: false,
// 					},
// 				}
// 			);
// 			context.log(`Update result: ${JSON.stringify(updateResult)}`);
// 			// Refresh entity to ensure latest data
// 			updatedEntity = await fetchEntity(entityId, context);
// 			// console.log("Updated entity:", updatedEntity);
// 		}
// 		// Notify the user via Slack
// 		const channelId = privateMetadata.channelId || "C08KS4UH5HU";
// 		const userId = payload.user.id;
// 		const channels = [
// 			process.env.SLACK_FINANCE_CHANNEL_ID,
// 			entity.demandeurId, // Assuming this is a Slack user ID for DM
// 			channelId, // Original channel ID
// 		];
// 		console.log("°°° paymentUrl", paymentUrl);
// 		console.log("°°° paymentProofs", paymentProofs);
// 		console.log("Channels to notify:", channels);
// 		console.log("paymentDetails", paymentDetails);

// 		for (const Channel of channels) {
// 			const isFinanceChannel = Channel === process.env.SLACK_FINANCE_CHANNEL_ID;

// 			// Build the base fields array
// 			// const baseFields = [
// 			//   { type: "mrkdwn", text: `*Titre:*\n${paymentTitle}` },
// 			//   {
// 			//     type: "mrkdwn",
// 			//     text: `*Date:*\n${new Date(paymentDate).toLocaleString("fr-FR", {
// 			//       weekday: "long",
// 			//       year: "numeric",
// 			//       month: "long",
// 			//       day: "numeric",
// 			//       hour: "2-digit",
// 			//       minute: "2-digit",
// 			//       timeZoneName: "short",
// 			//     })}`,
// 			//   },
// 			//   {
// 			//     type: "mrkdwn",
// 			//     text: `*Montant payé:*\n${paymentAmount} ${currency}`,
// 			//   },
// 			//   { type: "mrkdwn", text: `*Mode de paiement:*\n${paymentMode}` },
// 			//   { type: "mrkdwn", text: `*Statut:*\n${paymentStatus}` },
// 			// ];

// 			// Add payment proof fields
// 			// const proofFields = [];

// 			// // Add first proof if paymentUrl exists and is not empty
// 			// if (paymentUrl && paymentUrl.trim()) {
// 			//   proofFields.push({
// 			//     type: "mrkdwn",
// 			//     text: `*Preuve 1:*\n<${paymentUrl}|Voir le justificatif>`,
// 			//   });
// 			// }

// 			// Add additional proofs from paymentProofs array
// 			// if (paymentProofs && Array.isArray(paymentProofs)) {
// 			//   paymentProofs.forEach((proof, index) => {
// 			//     if (proof && proof.trim()) {
// 			//       const proofNumber =
// 			//         paymentUrl && paymentUrl.trim() ? index + 2 : index + 1;
// 			//       proofFields.push({
// 			//         type: "mrkdwn",
// 			//         text: `*Preuve ${proofNumber}:*\n<${proof}|Voir le justificatif>`,
// 			//       });
// 			//     }
// 			//   });
// 			// }

// 			// Add payment method specific fields
// 			// const paymentMethodFields = [];
// 			// if (paymentMode === "Chèque" && paymentDetails) {
// 			//   paymentMethodFields.push(
// 			//     {
// 			//       type: "mrkdwn",
// 			//       text: `*Numéro de chèque:*\n${
// 			//         paymentDetails.cheque_number || "N/A"
// 			//       }`,
// 			//     },
// 			//     {
// 			//       type: "mrkdwn",
// 			//       text: `*Banque:*\n${paymentDetails.cheque_bank || "N/A"}`,
// 			//     },
// 			//     {
// 			//       type: "mrkdwn",
// 			//       text: `*Date du chèque:*\n${paymentDetails.cheque_date || "N/A"}`,
// 			//     },
// 			//     {
// 			//       type: "mrkdwn",
// 			//       text: `*Ordre:*\n${paymentDetails.cheque_order || "N/A"}`,
// 			//     }
// 			//   );
// 			// } else if (paymentMode === "Virement" && paymentDetails) {
// 			//   paymentMethodFields.push(
// 			//     {
// 			//       type: "mrkdwn",
// 			//       text: `*Numéro de virement:*\n${
// 			//         paymentDetails.virement_number || "N/A"
// 			//       }`,
// 			//     },
// 			//     {
// 			//       type: "mrkdwn",
// 			//       text: `*Banque:*\n${paymentDetails.virement_bank || "N/A"}`,
// 			//     }
// 			//   );
// 			// }

// 			// // Combine all fields (Slack has a limit of 10 fields per section)
// 			// const allFields = [...baseFields, ...proofFields, ...paymentMethodFields];

// 			// // Split fields into chunks if there are too many (max 10 per section)
// 			// const fieldChunks = [];
// 			// for (let i = 0; i < allFields.length; i += 10) {
// 			//   fieldChunks.push(allFields.slice(i, i + 10));
// 			// }

// 			// Build the blocks array
// 			const blocks = [
// 				{
// 					type: "header",
// 					text: {
// 						type: "plain_text",
// 						text: `💲 🔄 Paiement Modifié: ${orderId}`,
// 						emoji: true,
// 					},
// 				},
// 			];

// 			// Add section blocks for each chunk of fields
// 			// fieldChunks.forEach((fields) => {
// 			//   blocks.push({
// 			//     type: "section",
// 			//     fields: fields,
// 			//   });
// 			// });

// 			// Add payment details to blocks
// 			console.log("à entity", entity);
// 			console.log("entity.paymentStatus", entity.paymentStatus);
// 			console.log("entity.statut", entity.statut);
// 			console.log("paymentUrl", paymentUrl);
// 			console.log("paymentProofs", paymentProofs);
// 			console.log("paymentDetails", paymentDetails);

// 			const paymentBlocks = await getPaymentBlocks(
// 				entity,
// 				{
// 					title: paymentTitle || "",
// 					mode: paymentMode || "",
// 					amountPaid: paymentAmount || "",
// 					date: paymentDate || "",
// 					url: paymentUrl || [],
// 					proofs: paymentProofs || [],

// 					details: paymentDetails,
// 				},
// 				entity.remainingAmount,
// 				paymentStatus || entity.statut
// 			);

// 			// Add all payment details except header (which is blocks[0])
// 			blocks.push(...paymentBlocks.slice(1));

// 			// Add action buttons for finance channel
// 			if (isFinanceChannel) {
// 				blocks.push({
// 					type: "actions",
// 					elements: [
// 						{
// 							type: "button",
// 							text: {
// 								type: "plain_text",
// 								text: "Enregistrer paiement",
// 								emoji: true,
// 							},
// 							style: "primary",
// 							action_id: "finance_payment_form",

// 							value: entityId,
// 						},
// 					],
// 				});
// 			}

// 			// Post the message
// 			await postSlackMessage(
// 				Channel,
// 				`✅ Paiement modifié avec succès pour ${orderId}`,
// 				blocks
// 			);
// 		}
// 		console.log(`Notification sent to channel ${channelId} for user ${userId}`);

// 		// Return response to clear the modal
// 		return {
// 			status: 200,
// 			headers: { "Content-Type": "application/json" },
// 			body: JSON.stringify({ response_action: "clear" }),
// 		};
// 	} catch (error) {
// 		await notifyTechSlack(error);

// 		console.error(`Error in handlePaymentModificationSubmission: ${error}`);

// 		try {
// 			await postSlackEphemeral(
// 				payload.channel?.id || "C08KS4UH5HU",
// 				payload.user.id,
// 				`❌ Erreur lors de la modification du paiement: ${error.message}`
// 			);
// 		} catch (slackError) {
// 			await notifyTechSlack(slackError);

// 			console.error(`Error sending error notification: ${slackError}`);
// 		}

// 		throw error;
// 	}
// }
async function handleOrderStatus(payload, comment, action, context) {
	console.log("** handleOrderStatus");
	console.log("payload", payload);
	console.log("action", action);
	console.log("==: comment", comment);

	let paymentId;

	// Handle funds received confirmation
	if (action.action_id === "confirm_funds_received") {
		const requestId = action.value;
		const caisse = await Caisse.findOne({
			"fundingRequests.requestId": requestId,
		});

		if (!caisse) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: payload.channel.id,
					user: payload.user.id,
					text: "Erreur: Caisse non trouvée",
				},
				process.env.SLACK_BOT_TOKEN
			);
			return createSlackResponse(200, "");
		}

		const requestIndex = caisse.fundingRequests.findIndex(
			(r) => r.requestId === requestId
		);
		if (requestIndex === -1) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postEphemeral",
				{
					channel: payload.channel.id,
					user: payload.user.id,
					text: "Erreur: Demande non trouvée",
				},
				process.env.SLACK_BOT_TOKEN
			);
			return createSlackResponse(200, "");
		}

		caisse.fundingRequests[requestIndex].fundsReceived = true;
		caisse.fundingRequests[requestIndex].receivedBy = payload.user.id;
		caisse.fundingRequests[requestIndex].receivedAt = new Date();

		await caisse.save();
		if (process.env.NODE_ENV === "production") {
			await syncCaisseToExcel(caisse);
		}

		// Update the message to show confirmation
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.update",
			{
				channel: payload.channel.id,
				ts: payload.message.ts,
				blocks: [
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `✅ Réception des fonds confirmée pour la demande *${requestId}*`,
						},
					},
					{
						type: "context",
						elements: [
							{
								type: "mrkdwn",
								text: `Confirmé par <@${
									payload.user.id
								}> le ${new Date().toLocaleDateString()}`,
							},
						],
					},
				],
				text: `Réception des fonds confirmée pour ${requestId}`,
			},
			process.env.SLACK_BOT_TOKEN
		);

		// Notify admin
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ADMIN_ID,
				text: `✅ <@${payload.user.id}> a confirmé la réception des fonds pour la demande ${requestId}`,
			},
			process.env.SLACK_BOT_TOKEN
		);

		return createSlackResponse(200, "");
	}
	//!********************************
	// If it's a rejection, open a modal to collect rejection reason instead of immediate update
	if (action === "accept") {
		console.log("accept order", action);
		const metadata = JSON.parse(payload.view.private_metadata); // Parse the metadata
		paymentId = metadata.paymentId;
		console.log("orderId", paymentId);
	}
	if (
		payload.type === "view_submission" &&
		payload.view.callback_id === "rejection_reason_modal"
	) {
		// Immediate response to close modal
		context.res = {
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ response_action: "clear" }),
		};

		// Process in background
		setImmediate(async () => {
			return await handleRejectionReasonSubmission(payload, context);
		});

		return context.res;
	}
	if (
		payload.type === "view_submission" &&
		payload.view.callback_id === "payment_modification_modal"
	) {
		console.log("3333");

		// Handle the form submission
		await handlePaymentModificationSubmission(payload, context);

		// Return empty 200 response to close the modal
		context.res = {
			status: 200,
			body: "",
		};
	}
	// For acceptance, proceed as before
	const updatedStatus = "Validé";

	const validatedBy = payload.user.username;
	console.log("validatedBy", validatedBy);
	const updatedOrder = await Order.findOneAndUpdate(
		{ id_commande: paymentId },
		{
			$set: {
				statut: updatedStatus,
				autorisation_admin: true,
				validatedAt: new Date(),
				validatedBy: payload.user.id,
				validatedBy: validatedBy,
			},
		},
		{ new: true }
	);

	if (!updatedOrder) {
		return createSlackResponse(404, "Commande non trouvée");
	}
	// Update the original Slack message to remove buttons
	await updateSlackMessage1(payload, paymentId, updatedStatus);
	// await notifyRequester(updatedOrder, updatedStatus);
	const blocks = [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `Bonjour <@${updatedOrder.demandeur}>, votre commande *${updatedOrder.id_commande}* est *${updatedStatus}*.`,
			},
		},
		...(updatedOrder.rejection_reason
			? [
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `*Motif du rejet:*\n${updatedOrder.rejection_reason}`,
						},
					},
			  ]
			: []),
	];
	await postSlackMessageWithRetry(
		"https://slack.com/api/chat.postMessage",
		{
			channel: updatedOrder.demandeur,
			text: `Commande *${updatedOrder.id_commande}* rejetée`,
			blocks,
		},
		process.env.SLACK_BOT_TOKEN,
		context
	);
	await notifyTeams(payload, comment, updatedOrder, context);

	return { response_action: "clear" };
}
async function handlePaymentVerificationConfirm(payload, context) {
	console.log("* handlePaymentVerificationConfirm");
	const { paymentId, action, message_ts, selectedPaymentMethod } = JSON.parse(
		payload.view.private_metadata
	);
	const { orderId, channel_id } = JSON.parse(payload.view.private_metadata);

	const comment =
		payload.view.state.values.validation_data?.comment?.value || "";

	console.log("payload", payload);
	// Get selected caisse from the form submission
	let selectedCaisseId = null;
	if (payload.view.state && payload.view.state.values) {
		// Look for caisse selection in the form state
		for (const blockId in payload.view.state.values) {
			const block = payload.view.state.values[blockId];
			if (block.caisse_selection && block.caisse_selection.selected_option) {
				selectedCaisseId = block.caisse_selection.selected_option.value;
				break;
			}
		}
	}
	console.log("selectedCaisseId", selectedCaisseId);
	console.log("selectedPaymentMethod", selectedPaymentMethod);
	let order;
	let status;
	if (paymentId.startsWith("CMD/")) {
		order = await Order.findOne({ id_commande: paymentId });

		if (!order) {
			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: "Order not found.",
			});
		}

		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: order.demandeurId,
				blocks: [
					{
						type: "header",
						text: {
							type: "plain_text",
							text:
								":package:  ✅ Commande: " +
								paymentId +
								" - Approuvée" +
								` par <@${
									payload.user.username
								}> le ${new Date().toLocaleDateString()}`,
							emoji: true,
						},
					},
					...(comment
						? [
								{
									type: "section",
									text: {
										type: "mrkdwn",
										text: `💬 *Commentaire:*\n> ${comment}`,
									},
								},
						  ]
						: []),
				],
			},
			process.env.SLACK_BOT_TOKEN
		);

		// Check order status
		status = order.statut;

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

		if (!order) {
			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: "Order not found.",
			});
		}
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: order.demandeur,
				blocks: [
					{
						type: "header",
						text: {
							type: "plain_text",
							text:
								"✅ Demande de paiement: " +
								paymentId +
								" - Approuvée" +
								` par <@${
									payload.user.username
								}> le ${new Date().toLocaleDateString()}`,
							emoji: true,
						},
					},
				],
			},
			process.env.SLACK_BOT_TOKEN
		);
		// Check order status
		status = order.statut;
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

	// In view_submission handler for payment_verif_confirm
	if (action === "accept") {
		console.log("** accept payment_verif_confirm");

		context.res = {
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ response_action: "clear" }),
		};
		// Process in background
		setImmediate(async () => {
			try {
				let paymentRequest;
				// Get paymentId from metadata NOT action.value
				const { paymentId } = JSON.parse(payload.view.private_metadata); // ← CORRECT SOURCE
				if (paymentId.startsWith("CMD/")) {
					console.log("Payment2", paymentId);
					// await notifyAdmin(order, context, false,true,status);
					await updateSlackMessageAcceptance(
						message_ts,
						paymentId,
						"validée",
						order
					);

					paymentRequest = await Order.findOneAndUpdate(
						{ id_commande: paymentId }, // ← Verify field name matches DB
						{
							statut: "Validé",
							validatedAt: new Date(),
							validatedBy: payload.user.id,
							autorisation_admin: true,
							updatedAt: new Date(),
							isApprovedOnce: true,
						},
						{ new: true }
					);
					return await handleOrderStatus(payload, comment, action, context);
					// Add validation before using paymentRequest
					if (!paymentRequest) {
						context.log(`❌ order request not found: ${paymentId}`);
						await postSlackMessage2(
							"https://slack.com/api/chat.postEphemeral",
							{
								channel: process.env.SLACK_ADMIN_ID,
								user: payload.user.id,
								text: `⚠️ Demande de paiement ${paymentId} introuvable`,
							},
							process.env.SLACK_BOT_TOKEN
						);

						return { response_action: "clear" };
					}
				} else if (paymentId.startsWith("PAY/")) {
					paymentRequest = await PaymentRequest.findOneAndUpdate(
						{ id_paiement: paymentId }, // ← Verify field name matches DB
						{
							statut: "Validé",
							validatedAt: new Date(),
							validatedBy: payload.user.id,
							autorisation_admin: true,
							updatedAt: new Date(),
						},
						{ new: true }
					);
					const {
						updateSlackPaymentMessage,
					} = require("../../Payment Request/Handlers/paymentRequestNotification");

					await updateSlackPaymentMessage(
						message_ts,
						paymentId,
						"validée",
						paymentRequest
					);
					// Add validation before using paymentRequest
					if (!paymentRequest) {
						context.log(`❌ Payment request not found: ${paymentId}`);

						await postSlackMessage2(
							"https://slack.com/api/chat.postEphemeral",
							{
								channel: process.env.SLACK_ADMIN_ID,
								user: payload.user.id,
								text: `⚠️ Demande de paiement ${paymentId} introuvable`,
							},
							process.env.SLACK_BOT_TOKEN
						);
						return { response_action: "clear" };
					}
					// Update the Slack message to remove buttons
					await updateSlackMessage1(payload, paymentId, "Validé");
					const {
						notifyFinancePayment,
					} = require("../../Payment Request/Handlers/paymentRequestNotification");

					await notifyFinancePayment(
						paymentRequest,
						context,
						payload.user.id,
						selectedCaisseId,
						selectedPaymentMethod,
						comment
					);
				}
			} catch (error) {
				await notifyTechSlack(error);

				console.log(
					`???????????????? Background processing error: ${error.message}\nStack: ${error.stack}`
				);

				await postSlackMessage2(
					"https://slack.com/api/chat.postMessage",
					{
						channel: payload.user.id,
						text: `Background processing error: ${error.message}\nStack: ${error.stack}`,
					},
					process.env.SLACK_BOT_TOKEN
				);
			}
		});
		return context.res;
	}
}
module.exports = {
	handlePaymentVerification,
	handlePaymentVerificationConfirm,
	handleOrderStatus,
	createPaymentConfirmationModal,
};
