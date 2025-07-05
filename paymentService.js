// src/paymentService.js
const { Order, PaymentRequest } = require("./db");
// Payment Handling
const { createSlackResponse, postSlackMessage } = require("./utils");

// Helper function to fetch an entity (order or payment request)
async function fetchEntity(entityId, context) {
	try {
		console.log("** fetchEntity");
		if (entityId.startsWith("CMD/")) {
			return await Order.findOne({ id_commande: entityId });
		} else if (entityId.startsWith("PAY/")) {
			return await PaymentRequest.findOne({ id_paiement: entityId });
		} else {
			context.log(`Invalid entity ID format: ${entityId}`);
			return null;
		}
	} catch (error) {
		context.log(`Error fetching entity ${entityId}: ${error.message}`);
		return null;
	}
}
// async function handlePayment(orderId, paymentAmount, totalAmountDue, context) {
//   console.log("** handlePayment");
//   let document;

//   if (orderId.startsWith("PAY/")) {
//     // This is a payment request
//     document = await PaymentRequest.findOne({ id_paiement: orderId });
//   } else {
//     // This is a regular order
//     document = await Order.findOne({ id_commande: orderId });
//   }

//   if (!document) throw new Error("Commande non trouvée.");

//   const amountPaid = document.amountPaid;
//   console.log("amountPaid", amountPaid);
//   const remainingAmount = totalAmountDue - amountPaid;
//   console.log("totalAmountDue", totalAmountDue);
//   console.log("remainingAmount000", remainingAmount);
//   console.log("paymentAmount", paymentAmount);
//   if (paymentAmount > remainingAmount) {
//     // Post Slack message to the designated channel
//     const slackResponse = await postSlackMessage(
//       "https://slack.com/api/chat.postMessage",
//       {
//         channel: process.env.SLACK_FINANCE_CHANNEL_ID,
//         text: "❌ Le montant payé dépasse le montant restant dû.",
//       },
//       process.env.SLACK_BOT_TOKEN
//     );

//     if (!slackResponse.ok) {
//       context.log(`${slackResponse.error}`);
//     }
//     throw new Error("Le montant payé dépasse le montant restant dû.");
//   }
//   let newAmountPaid;
//   if (orderId.startsWith("PAY/")) {
//     // This is a payment request
//     newAmountPaid = amountPaid + paymentAmount;
//   } else {
//     // This is a regular order
//     newAmountPaid = amountPaid + paymentAmount;
//   }
//   console.log("newAmountPaid", newAmountPaid);
//   const paymentStatus = determinePaymentStatus(totalAmountDue, newAmountPaid);
//   console.log("paymentStatus", paymentStatus);
//   const newremainingAmount = totalAmountDue - newAmountPaid;
//   console.log("newremainingAmount", newremainingAmount);
//   if (newremainingAmount == 0) {
//     if (orderId.startsWith("CMD/")) {
//       const updateResult = await Order.updateOne(
//         { id_paiement: orderId },
//         {
//           $set: {
//             paymentDone: "true",
//           },
//         }
//       );
//       context.log(`Update result: ${JSON.stringify(updateResult)}`);
//       // Refresh entity to ensure latest data
//       updatedEntity = await fetchEntity(orderId, context);
//       console.log("1Updated entity:", updatedEntity);
//       if (updateResult.modifiedCount === 0) {
//         throw new Error(
//           `Failed to update entity ${orderId} - no documents modified`
//         );
//       }
//     } else if (orderId.startsWith("PAY/")) {
//       const updateResult = await PaymentRequest.updateOne(
//         { id_commande: orderId },
//         {
//           $set: {
//             paymentDone: "true",
//           },
//         }
//       );
//       context.log(`Update result: ${JSON.stringify(updateResult)}`);
//       // Refresh entity to ensure latest data
//       updatedEntity = await fetchEntity(orderId, context);
//       console.log("1Updated entity:", updatedEntity);
//       if (updateResult.modifiedCount === 0) {
//         throw new Error(
//           `Failed to update entity ${orderId} - no documents modified`
//         );
//       }
//     }
//   } else {
//     if (orderId.startsWith("CMD/")) {
//       const updateResult = await Order.updateOne(
//         { id_commande: orderId },
//         {
//           $set: {
//             paymentDone: "false",
//           },
//         }
//       );
//       context.log(`Update result: ${JSON.stringify(updateResult)}`);
//       // Refresh entity to ensure latest data
//       updatedEntity = await fetchEntity(orderId, context);
//       console.log("2Updated entity:", updatedEntity);
//     } else if (orderId.startsWith("PAY/")) {
//       const updateResult = await PaymentRequest.updateOne(
//         { id_paiement: orderId },
//         {
//           $set: {
//             paymentDone: "false",
//           },
//         }
//       );
//       context.log(`Update result: ${JSON.stringify(updateResult)}`);
//       // Refresh entity to ensure latest data
//       updatedEntity = await fetchEntity(orderId, context);
//       console.log("2Updated entity:", updatedEntity);
//     }
//   }
//   return {
//     newAmountPaid,
//     paymentStatus,
//     totalAmountDue,
//     remainingAmount: newremainingAmount,
//   };
// }
async function handlePayment(orderId, paymentAmount, totalAmountDue, context) {
	console.log("** handlePayment");
	console.log("Input parameters:", { orderId, paymentAmount, totalAmountDue });

	let document;
	if (orderId.startsWith("PAY/")) {
		document = await PaymentRequest.findOne({ id_paiement: orderId });
		// FIXED: Get the amount paid BEFORE the current payment was added
		// We need to subtract the current payment to get the previous state
		const currentTotalAmountPaid = document.amountPaid || 0;
		const previousAmountPaid = currentTotalAmountPaid - paymentAmount; // This is the key fix!
		const remainingAmount = totalAmountDue - previousAmountPaid;

		console.log("Payment validation:", {
			currentTotalAmountPaid,
			previousAmountPaid,
			totalAmountDue,
			remainingAmount,
			newPaymentAmount: paymentAmount,
			willExceed: paymentAmount > remainingAmount,
		});

		if (paymentAmount > remainingAmount) {
			console.log("❌ Payment exceeds remaining amount:", {
				paymentAmount,
				remainingAmount,
				difference: paymentAmount - remainingAmount,
			});

			await postSlackMessage(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_FINANCE_CHANNEL_ID,
					text: `❌ Le montant payé (${paymentAmount}) dépasse le montant restant dû (${remainingAmount}).`,
				},
				process.env.SLACK_BOT_TOKEN
			);

			throw new Error(
				`Le montant payé (${paymentAmount}) dépasse le montant restant dû (${remainingAmount}).`
			);
		}

		const newAmountPaid = currentTotalAmountPaid; // This is already correct
		const paymentStatus = determinePaymentStatus(totalAmountDue, newAmountPaid);
		const newremainingAmount = totalAmountDue - newAmountPaid;

		console.log("Payment calculation results:", {
			newAmountPaid,
			paymentStatus,
			newremainingAmount,
		});

		if (newremainingAmount == 0) {
			const updateResult = await PaymentRequest.updateOne(
				{ id_paiement: orderId }, // Fixed: was using id_commande instead of id_paiement
				{
					$set: {
						paymentDone: "true",
					},
				}
			);
			context.log(`Update result: ${JSON.stringify(updateResult)}`);

			if (updateResult.modifiedCount === 0) {
				throw new Error(
					`Failed to update entity ${orderId} - no documents modified`
				);
			}
		} else {
			const updateResult = await PaymentRequest.updateOne(
				{ id_paiement: orderId },
				{
					$set: {
						paymentDone: "false",
					},
				}
			);
			context.log(`Update result: ${JSON.stringify(updateResult)}`);
		}
		return {
			newAmountPaid,
			paymentStatus,
			totalAmountDue,
			remainingAmount: newremainingAmount,
		};
	} else {
		document = await Order.findOne({ id_commande: orderId });

		const amountPaid = document.amountPaid;
		console.log("amountPaid", amountPaid);
		const remainingAmount = totalAmountDue - amountPaid;
		console.log("totalAmountDue", totalAmountDue);
		console.log("remainingAmount000", remainingAmount);
		console.log("paymentAmount", paymentAmount);
		if (paymentAmount > remainingAmount) {
			// Post Slack message to the designated channel
			const slackResponse = await postSlackMessage(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_FINANCE_CHANNEL_ID,
					text: "❌ Le montant payé dépasse le montant restant dû.",
				},
				process.env.SLACK_BOT_TOKEN
			);

			if (!slackResponse.ok) {
				context.log(`${slackResponse.error}`);
			}
			throw new Error("Le montant payé dépasse le montant restant dû.");
		}
		let newAmountPaid;

		newAmountPaid = amountPaid + paymentAmount;

		console.log("newAmountPaid", newAmountPaid);
		const paymentStatus = determinePaymentStatus(totalAmountDue, newAmountPaid);
		console.log("paymentStatus", paymentStatus);
		const newremainingAmount = totalAmountDue - newAmountPaid;
		console.log("newremainingAmount", newremainingAmount);
		if (orderId.startsWith("CMD/")) {
			if (newremainingAmount == 0) {
				const updateResult = await Order.updateOne(
					{ id_commande: orderId },
					{
						$set: {
							paymentDone: "true",
						},
					}
				);
				context.log(`Update result: ${JSON.stringify(updateResult)}`);
				// Refresh entity to ensure latest data
				updatedEntity = await fetchEntity(orderId, context);
				console.log("1Updated entity:", updatedEntity);
				if (updateResult.modifiedCount === 0) {
					throw new Error(
						`Failed to update entity ${orderId} - no documents modified`
					);
				}
			} else {
				const updateResult = await Order.updateOne(
					{ id_commande: orderId },
					{
						$set: {
							paymentDone: "false",
						},
					}
				);
				context.log(`Update result: ${JSON.stringify(updateResult)}`);
				// Refresh entity to ensure latest data
				updatedEntity = await fetchEntity(orderId, context);
				console.log("2Updated entity:", updatedEntity);
			}
		} else if (orderId.startsWith("PAY/")) {
      if (newremainingAmount == 0) {
				const updateResult = await Order.updateOne(
					{ id_paiement: orderId },
					{
						$set: {
							paymentDone: "true",
						},
					}
				);
				context.log(`Update result: ${JSON.stringify(updateResult)}`);
				// Refresh entity to ensure latest data
				updatedEntity = await fetchEntity(orderId, context);
				console.log("1Updated entity:", updatedEntity);
				if (updateResult.modifiedCount === 0) {
					throw new Error(
						`Failed to update entity ${orderId} - no documents modified`
					);
				}
			} else {
				const updateResult = await Order.updateOne(
					{ id_paiement: orderId },
					{
						$set: {
							paymentDone: "false",
						},
					}
				);
				context.log(`Update result: ${JSON.stringify(updateResult)}`);
				// Refresh entity to ensure latest data
				updatedEntity = await fetchEntity(orderId, context);
				console.log("2Updated entity:", updatedEntity);
			}
		}
		return {
			newAmountPaid,
			paymentStatus,
			totalAmountDue,
			remainingAmount: newremainingAmount,
		};
	}

	if (!document) throw new Error("Commande non trouvée.");
}
function determinePaymentStatus(totalAmountDue, amountPaid) {
	console.log("** determinePaymentStatus");
	if (totalAmountDue < 0 || amountPaid < 0) {
		throw new Error(
			"Invalid amounts: totalAmountDue or amountPaid cannot be negative"
		);
	}
	if (amountPaid === 0) return "En attente";
	if (amountPaid < totalAmountDue) return "Paiement Partiel";
	return "Payé";
}

async function calculateTotalAmountDue(orderId, context) {
	console.log("** calculateTotalAmountDue");
	// Check if this is a payment request or an order
	if (orderId.startsWith("PAY/")) {
		// This is a payment request
		const paymentRequest = await PaymentRequest.findOne({
			id_paiement: orderId,
		});
		if (!paymentRequest) {
			context.log(`Payment request not found: ${orderId}`);
			throw new Error("Commande non trouvée.");
		}
		// For payment requests, the total amount is simply the montant field
		return paymentRequest.montant;
	} else {
		// This is a regular order
		const order = await Order.findOne({ id_commande: orderId });
		if (!order) {
			context.log(`Order not found: ${orderId}`);
			throw new Error("Commande non trouvée.");
		}
		// Calculate total from proformas for orders
		const validatedProforma = order.proformas.find((p) => p.validated);
		const totalAmountDue = validatedProforma.montant || 0;
		context.log(`Calculated totalAmountDue: ${totalAmountDue}`);
		return totalAmountDue;
	}
}
module.exports = {
	handlePayment,
	determinePaymentStatus,
	calculateTotalAmountDue,
};
