// src/orderStatusService.js
const { Order, PaymentRequest } = require("./db");
const { postSlackMessage, createSlackResponse } = require("./utils");
const {
  notifyTeams,
  postSlackMessageWithRetry,
  getOrderBlocks,
  getProformaBlocks,
  getPaymentRequestBlocks,
} = require("./notificationService"); // Import notification functions
const axios = require("axios");

// Order Status Management
async function handleOrderStatus(payload, action, context) {
  console.log("** handleOrderStatus");
  console.log("payload", payload);
  console.log("action", action);

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
    await syncCaisseToExcel(caisse);

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
  if (action.action_id === "reject_order") {
    
    paymentId = action.value;
    console.log("Rejecting order", paymentId);
    return openRejectionReasonModal(payload, paymentId);
  } else if (action === "accept") {
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
    await postSlackMessage(
      "https://slack.com/api/chat.postMessage",
      {
        channel: process.env.SLACK_ADMIN_ID,
        text: "⌛ Commande en cours de traitement... Vous serez notifié(e) bientôt !",
      },
      process.env.SLACK_BOT_TOKEN
    );
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
  context.log("validatedBy", validatedBy);
  const updatedOrder = await Order.findOneAndUpdate(
    { id_commande: paymentId },
    {
      $set: {
        statut: updatedStatus,
        autorisation_admin: true,
        validatedBy: validatedBy,
      },
    },
    { new: true }
  );

  if (!updatedOrder) {
    context.log("Commande non trouvée:", paymentId);
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
  await notifyTeams(payload, updatedOrder, context);

  return { response_action: "clear" };
}

async function handlePaymentModificationSubmission(payload, context) {
  console.log("** handlePaymentModificationSubmission");
  console.log(
    "handlePaymentModificationSubmission1",
    handlePaymentModificationSubmission
  );
  const { Order, PaymentRequest } = require("./db");
  const { WebClient } = require("@slack/web-api");
  const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

  try {
    console.log("Handling payment modification submission");

    // Extract metadata and submitted values
    const privateMetadata = JSON.parse(payload.view.private_metadata);
    const { orderId, paymentId } = privateMetadata;
    const values = payload.view.state.values;

    console.log("Submitted payload values:", JSON.stringify(values, null, 2));
    console.log("Order ID:", orderId, "Payment ID:", paymentId);

    // Extract form data from the modal
    const paymentTitle = values.payment_title?.payment_title_input?.value || "";
    const paymentDate =
      values.payment_date?.payment_date_input?.selected_date || "";
    const paymentAmount =
      parseFloat(values.payment_amount?.payment_amount_input?.value) || 0;
    const paymentMode =
      values.payment_mode?.payment_mode_input?.selected_option?.value || "";
    const paymentStatus =
      values.payment_status?.payment_status_input?.selected_option?.value || "";
    const paymentUrl = values.payment_url?.payment_url_input?.value || "";

    // Prepare payment details based on mode
    let paymentDetails = {};
    if (paymentMode === "Chèque") {
      paymentDetails = {
        cheque_number: values.cheque_number?.cheque_number_input?.value || "",
        cheque_bank: values.cheque_bank?.cheque_bank_input?.value || "",
      };
    } else if (paymentMode === "Virement") {
      paymentDetails = {
        virement_number:
          values.virement_number?.virement_number_input?.value || "",
        virement_bank: values.virement_bank?.virement_bank_input?.value || "",
      };
    } // No details for "Espèces" or "Carte bancaire"

    // Prepare the updated payment object
    const updatedPayment = {
      paymentMode,
      amountPaid: paymentAmount,
      paymentTitle,
      paymentUrl,
      details: paymentDetails,
      status: paymentStatus,
      dateSubmitted: paymentDate ? new Date(paymentDate) : new Date(), // Use submitted date or current date
    };

    console.log("Updated payment data:", updatedPayment);

    // Update the payment in the database
    let entity;
    if (orderId.startsWith("CMD/")) {
      entity = await Order.findOne({ id_commande: orderId });
      if (!entity || !entity.payments) {
        throw new Error(`Commande ${orderId} non trouvée ou sans paiements`);
      }

      // Find and update the specific payment
      const paymentIndex = entity.payments.findIndex(
        (p) => String(p._id) === paymentId || String(p.id) === paymentId
      );
      if (paymentIndex === -1) {
        throw new Error(
          `Paiement ${paymentId} non trouvé dans la commande ${orderId}`
        );
      }

      entity.payments[paymentIndex] = {
        ...entity.payments[paymentIndex], // Preserve existing fields not in the modal
        ...updatedPayment,
        _id: entity.payments[paymentIndex]._id, // Ensure _id remains unchanged
      };

      await entity.save();
      console.log(`Payment ${paymentId} updated in order ${orderId}`);
    } else if (orderId.startsWith("PAY/")) {
      entity = await PaymentRequest.findOne({ id_paiement: orderId });
      if (!entity || !entity.payments) {
        throw new Error(
          `Demande de paiement ${orderId} non trouvée ou sans paiements`
        );
      }

      const paymentIndex = entity.payments.findIndex(
        (p) => String(p._id) === paymentId || String(p.id) === paymentId
      );
      if (paymentIndex === -1) {
        throw new Error(
          `Paiement ${paymentId} non trouvé dans la demande ${orderId}`
        );
      }

      entity.payments[paymentIndex] = {
        ...entity.payments[paymentIndex],
        ...updatedPayment,
        _id: entity.payments[paymentIndex]._id,
      };

      await entity.save();
      console.log(`Payment ${paymentId} updated in payment request ${orderId}`);
    } else {
      throw new Error(`Format d'ID non reconnu: ${orderId}`);
    }

    // Notify the user via Slack
    const channelId = payload.channel?.id || "C08KS4UH5HU"; // Fallback to a default channel if needed
    const userId = payload.user.id;
    const channels = [
      process.env.SLACK_FINANCE_CHANNEL_ID,
      entity.demandeurId, // Assuming this is a Slack user ID for DM
      channelId, // Original channel ID
    ];
    console.log("Channels to notify:", channels);
    for (const Channel of channels) {
      await slack.chat.postMessage({
        channel: Channel,
        text: `✅ Paiement modifié avec succès pour ${orderId}`,
        blocks: [
          {
            type: "header",
            text: {
              type: "plain_text",
              text: `Paiement Modifié: ${orderId}`,
              emoji: true,
            },
          },
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: `*Titre:*\n${paymentTitle}` },
              { type: "mrkdwn", text: `*Date:*\n${paymentDate}` },
              {
                type: "mrkdwn",
                text: `*Montant payé:*\n${paymentAmount} ${entity.devise || "USD"
                  }`,
              },
              { type: "mrkdwn", text: `*Mode de paiement:*\n${paymentMode}` },
              { type: "mrkdwn", text: `*Statut:*\n${paymentStatus}` },
              ...(paymentUrl
                ? [
                  {
                    type: "mrkdwn",
                    text: `*URL:*\n<${paymentUrl}|Voir le lien>`,
                  },
                ]
                : []),
                ...(paymentProofs
                  ? [
                    {
                      type: "mrkdwn",
                      text: `*Fichiers:*\n<${paymentProofs}|Voir le lien>`,
                    },
                  ]
                  : []),
              ...(paymentMode === "Chèque"
                ? [
                  {
                    type: "mrkdwn",
                    text: `*Numéro de chèque:*\n${paymentDetails.cheque_number}`,
                  },
                  {
                    type: "mrkdwn",
                    text: `*Banque:*\n${paymentDetails.cheque_bank}`,
                  },
                ]
                : []),
              ...(paymentMode === "Virement"
                ? [
                  {
                    type: "mrkdwn",
                    text: `*Numéro de virement:*\n${paymentDetails.virement_number}`,
                  },
                  {
                    type: "mrkdwn",
                    text: `*Banque:*\n${paymentDetails.virement_bank}`,
                  },
                ]
                : []),
            ],
          },
        ],
      });
    }

    console.log(`Notification sent to channel ${channelId} for user ${userId}`);
  } catch (error) {
    console.error(`Error in handlePaymentModificationSubmission: ${error}`);

    // Notify the user of the error
    try {
      await slack.chat.postEphemeral({
        channel: payload.channel?.id || "C08KS4UH5HU",
        user: payload.user.id,
        text: `❌ Erreur lors de la modification du paiement: ${error.message}`,
      });
    } catch (slackError) {
      console.error(`Error sending error notification: ${slackError}`);
    }

    // Re-throw the error to ensure the modal doesn't close silently on failure
    throw error;
  }
}
// Function to open a modal for rejection reason
async function openRejectionReasonModal(payload, orderId) {
  console.log("** openRejectionReasonModal");
  try {
    await postSlackMessage(
      "https://slack.com/api/views.open",
      {
        trigger_id: payload.trigger_id,
        view: {
          type: "modal",
          callback_id: "rejection_reason_modal",
          private_metadata: JSON.stringify({
            entityId: orderId,
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
                text: `Veuillez indiquer la raison du rejet de la commande *${orderId}*`,
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

// Handle modal submission with rejection reason
async function handleRejectionReasonSubmission(payload, context) {
  console.log("** handleRejectionReasonSubmission");
  try {
    const { entityId, channel_id, message_ts } = JSON.parse(
      payload.view.private_metadata
    );
    console.log("payload5", payload);
    console.log("message_ts", message_ts);

    const rejectionReason =
      payload.view.state.values.rejection_reason_block.rejection_reason_input
        .value;
    if (entityId.startsWith("CMD/")) {
      const order = await Order.findOne({ id_commande: entityId });
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
                  ":package:  ❌ Commande: " +
                  entityId +
                  " - Rejetée" +
                  ` par <@${
                    payload.user.username
                  }> le ${new Date().toLocaleDateString()}, Raison: ${rejectionReason}`,
                emoji: true,
              },
            },
          ],
        },
        process.env.SLACK_BOT_TOKEN
      );
      // Update order with rejection status and reason
      const updatedOrder = await Order.findOneAndUpdate(
        { id_commande: entityId },
        {
          $set: {
            statut: "Rejeté",
            rejection_reason: rejectionReason,
            autorisation_admin: false,
          },
        },
        { new: true }
      );

      if (!updatedOrder) {
        context.log("Commande non trouvée:", entityId);
        return createSlackResponse(404, "Commande non trouvée");
      }

      // Update the original message
      await updateSlackMessageWithReason(payload.user.username,
        channel_id,
        message_ts,
        entityId,
        "Rejeté",
        rejectionReason,
        updatedOrder
      );
      context.log("Message Slack mis à jour avec succès");

      // Notify the requester with rejection reason
      await notifyRequesterWithReason(updatedOrder, rejectionReason);

      return { response_action: "clear" };
    }
    // For payment requests (PAY/xxx)
    else if (entityId.startsWith("PAY/")) {
      await PaymentRequest.findOne({ id_paiement: entityId });
      // Update order with rejection status and reason
      const updatedPAY = await PaymentRequest.findOneAndUpdate(
        { id_paiement: entityId },
        {
          $set: {
            statut: "Rejeté",
            rejectedById: payload.user.id,
            rejectedByName: payload.user.username,
            rejection_reason: rejectionReason,
            autorisation_admin: false,
          },
        },
        { new: true }
      );

      if (!updatedPAY) {
        context.log("Commande non trouvée:", entityId);
        return createSlackResponse(404, "Commande non trouvée");
      }

      
      // Update the original message
      await updateSlackMessageWithReason1(payload.user.username,
        channel_id,
        message_ts,
        entityId,
        "Rejeté",
        rejectionReason,
        updatedPAY
      );
      context.log("Message Slack mis à jour avec succès");

      // Notify the requester with rejection reason
      await notifyRequesterWithReason(updatedPAY, rejectionReason);

      return { response_action: "clear" };
    }
    // Invalid entity ID format
    else {
      context.log(`Invalid entity ID format: ${entityId}`);
      return null;
    }
  } catch (error) {
    context.log(
      "Erreur lors de la mise à jour du message Slack:",
      error.message
    );

    console.error("Error handling rejection reason submission:", error);
    return createSlackResponse(500, "Error handling rejection");
  }
}

async function updateSlackMessageWithReason1(user,
  channelId,
  messageTs,
  orderId,
  status,
  reason,
  order
) {
  console.log("** updateSlackMessageWithReason1");
  await postSlackMessage(
    "https://slack.com/api/chat.update",
    {
      channel: channelId,
      ts: messageTs,
      text: `Commande *${orderId}* - *${status}*`,
      blocks: [
        ...getPaymentRequestBlocks(order),
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `❌ - *REJETÉE* par <@${user}> le ${new Date().toLocaleString(
                      "fr-FR"
                    )}`,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Motif de rejet: ${reason}`,
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
// Update Slack message to include rejection reason
async function updateSlackMessageWithReason(user,
  channelId,
  messageTs,
  orderId,
  status,
  reason,
  order
) {
  console.log("** updateSlackMessageWithReason");
  await postSlackMessage(
    "https://slack.com/api/chat.update",
    {
      channel: channelId,
      ts: messageTs,
      text: `Commande *${orderId}* - *${status}*`,
      blocks: [
        ...getOrderBlocks(order),
        ...getProformaBlocks(order),
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `❌ - *REJETÉE par* <@${user}> le ${new Date().toLocaleString(
                      "fr-FR"
                    )}`,
          },
        },
       
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Motif de rejet: ${reason}`,
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
// Helper function to update the Slack message
async function updateSlackMessage1(payload, paymentId, status) {
  console.log("** updateSlackMessage1");
  const updatedBlocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Commande *${paymentId}* a été *${status}* par <@${payload.user.id}>`,
      },
    },
    // No actions block here, so buttons disappear
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `✅ Traitement terminé le ${new Date().toLocaleDateString()}`,
        },
      ],
    },
  ];

  await postSlackMessage(
    "https://slack.com/api/chat.update",
    {
      channel: payload.channel?.id || process.env.SLACK_ADMIN_ID, // Use the original channel
      ts: payload.message?.ts, // Use the original message timestamp
      blocks: updatedBlocks,
      text: `Commande ${paymentId} mise à jour`,
    },
    process.env.SLACK_BOT_TOKEN
  );
}
// Update the original function to include rejection reason
async function updateSlackMessage(payload, orderId, status, reason = null) {
  console.log("** updateSlackMessage");
  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Commande ID:* ${orderId}\n*Statut:* *${status}*${
          reason ? `Motif de rejet: ${reason}` : ""
        }`,
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
  ];

  // await postSlackMessage(
  //   "https://slack.com/api/chat.update",
  //   {
  //     channel: payload.channel.id,
  //     ts: payload.message.ts,
  //     text: `Commande *${orderId}* - *${status}*`,
  //     blocks
  //   },
  //   process.env.SLACK_BOT_TOKEN
  // );
}

// Notify requester with rejection reason
async function notifyRequesterWithReason(order, rejectionReason) {
  console.log("** notifyRequesterWithReason");
  console.log("order", order);
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
              "❌ Demande de paiement: " +
              order.id_paiement +
              " - Rejetée" +
              ` par <@${
                order.rejectedByName
              }> le ${new Date().toLocaleDateString()}, Raison: ${rejectionReason}`,
            emoji: true,
          },
        },
      ],
    },
    process.env.SLACK_BOT_TOKEN
  );
  // await postSlackMessage(
  //   "https://slack.com/api/chat.postMessage",
  //   {
  //     channel: order.demandeur,
  //     text: `Bonjour <@${order.demandeur}>, votre demande a été *rejetée* par l'administrateur.`,
  //     blocks: [
  //       {
  //         type: "section",
  //         text: {
  //           type: "mrkdwn",
  //           text: `Bonjour <@${order.demandeur}>, votre demande a été *rejetée* par l'administrateur.`,
  //         },
  //       },
  //       {
  //         type: "section",
  //         text: {
  //           type: "mrkdwn",
  //           text: `*Motif du rejet:*\n${rejectionReason}`,
  //         },
  //       },
  //     ],
  //   },
  //   process.env.SLACK_BOT_TOKEN
  // );
}

async function reopenOrder(payload, action, context) {
  console.log("** reopenOrder");
  const orderId = action.value;
  const updatedOrder = await Order.findOneAndUpdate(
    { id_commande: orderId },
    {
      statut: "En attente",
      $unset: { rejection_reason: "" }, // Remove rejection reason when reopening
    },
    { new: true }
  );

  if (!updatedOrder) return createSlackResponse(404, "Order not found");

  await postSlackMessage(
    "https://slack.com/api/chat.update",
    {
      channel: payload.container.channel_id,
      ts: payload.container.message_ts,
      text: `Commande *${orderId}* - *En attente*`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Commande ID:* ${orderId}\n*Statut:* *En attente*`,
          },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Accepter" },
              style: "primary",
              action_id: "accept_order",
              value: orderId,
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Refuser" },
              style: "danger",
              action_id: "reject_order",
              value: orderId,
            },
          ],
        },
      ],
    },
    process.env.SLACK_BOT_TOKEN
  );

  return createSlackResponse(200, "");
}

module.exports = {
  handleOrderStatus,
  updateSlackMessage,
  reopenOrder,
  updateSlackMessage1,
  handleRejectionReasonSubmission, // Export the new function
};
