const { Order } = require("./db");
const { postSlackMessage, createSlackResponse } = require("./utils");
const { sendDelayReminder } = require("./notificationService");
let isScheduled = false;

async function checkPendingOrderDelays(context) {
  try {
    console.log("** checkPendingOrderDelays");

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    console.log(`Checking for pending orders created before: ${twentyFourHoursAgo}`);

    const pendingOrders = await Order.find({
      statut: "En attente",
      createdAt: { $lte: twentyFourHoursAgo },
      admin_reminder_sent: false,
    });

    console.log(`Found ${pendingOrders.length} delayed pending orders`);

    for (const order of pendingOrders) {
      console.log(`Attempting to process pending order: ${order.id_commande}`);
      
      const updatedOrder = await Order.findOneAndUpdate(
        {
          id_commande: order.id_commande,
          admin_reminder_sent: false,
        },
        {
          $set: { admin_reminder_sent: true },
          $push: {
            delay_history: {
              type: "admin_reminder",
              timestamp: new Date(),
            },
          },
        },
        { new: true }
      );

      if (updatedOrder) {
        console.log(`Claimed order ${order.id_commande} for reminder`);
        await sendDelayReminder(updatedOrder, context, "admin");
      } else {
        console.log(`Order ${order.id_commande} already claimed by another process`);
      }
    }
  } catch (error) {
    console.log(`Error in pending order delay monitoring: ${error.message}`);
    throw error;
  }
}
async function checkPaymentDelays(context) {
  try {
    console.log("** checkPaymentDelays");

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    console.log(`Checking for orders missing payments before: ${twentyFourHoursAgo}`);

    const delayedPaymentOrders = await Order.find({
      statut: "Validé",
      createdAt: { $lte: twentyFourHoursAgo },
      payments: { $size: 0 },
      proformas: { $not: { $size: 0 } },
      payment_reminder_sent: false,
    });

    console.log(`Found ${delayedPaymentOrders.length} orders missing payments`);

    for (const order of delayedPaymentOrders) {
      console.log(`Attempting to process payment delay for order: ${order.id_commande}`);
      
      const updatedOrder = await Order.findOneAndUpdate(
        {
          id_commande: order.id_commande,
          payment_reminder_sent: false,
        },
        {
          $set: { payment_reminder_sent: true },
          $push: {
            delay_history: {
              type: "payment_reminder",
              timestamp: new Date(),
            },
          },
        },
        { new: true }
      );

      if (updatedOrder) {
        console.log(`Claimed order ${order.id_commande} for reminder`);
        await sendDelayReminder(updatedOrder, context, "payment");
      } else {
        console.log(`Order ${order.id_commande} already claimed`);
      }
    }
  } catch (error) {
    console.log(`Error in payment delay monitoring: ${error.message}`);
    throw error;
  }
}

async function checkProformaDelays(context) {
  try {
    console.log("** checkProformaDelays");

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    console.log(`Checking for orders missing proformas before: ${twentyFourHoursAgo}`);

    const delayedProformaOrders = await Order.find({
      statut: "Validé",
      createdAt: { $lte: twentyFourHoursAgo },
      proformas: { $size: 0 },
      proforma_reminder_sent: false,
    });

    console.log(`Found ${delayedProformaOrders.length} orders missing proformas`);

    for (const order of delayedProformaOrders) { // Fixed loop variable
      console.log(`Attempting to process proforma delay for order: ${order.id_commande}`);
      
      const updatedOrder = await Order.findOneAndUpdate(
        {
          id_commande: order.id_commande,
          proforma_reminder_sent: false,
        },
        {
          $set: { proforma_reminder_sent: true },
          $push: {
            delay_history: {
              type: "proforma_reminder",
              timestamp: new Date(),
            },
          },
        },
        { new: true }
      );

      if (updatedOrder) {
        console.log(`Claimed order ${order.id_commande} for reminder`);
        await sendDelayReminder(updatedOrder, context, "proforma");
      } else {
        console.log(`Order ${order.id_commande} already claimed by another process`);
      }
    }
  } catch (error) {
    console.log(`Error in proforma delay monitoring: ${error.message}`);
    throw error;
  }
}

function  setupDelayMonitoring(context) {
  console.log("** setupDelayMonitoring");
  if (isScheduled) {
    console.log("Delay monitoring already scheduled, skipping duplicate setup.");
    return;
  }
  cron.schedule('0 * * * *', () => {
    console.log("Running scheduled delay check...");
    checkPendingOrderDelays(context);
    checkPaymentDelays(context);
    checkProformaDelays(context);
  });
  isScheduled = true;
  console.log("Delay monitoring scheduled to run every hour.");
}

module.exports = {
  checkPendingOrderDelays,
  sendDelayReminder,
  checkPaymentDelays,
  checkProformaDelays,
  setupDelayMonitoring,
};