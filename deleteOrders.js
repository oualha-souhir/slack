const { PaymentRequest, Order } = require("./db"); // Adjust path if needed

async function deleteOrdersInRange() {
	try {
		const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
		console.log(
			`Checking for orders missing proformas before: ${twentyFourHoursAgo}`
		);
		// const result = await PaymentRequest.deleteMany({
		// 	id_paiement: {
		// 		$gte: "PAY/2025/07/00072",
		// 		$lte: "PAY/2025/07/0075",
		// 	},
		// });
		// const pendingOrders = await Order.find({
		// 	statut: "En attente",
		// 	createdAt: { $lte: twentyFourHoursAgo },
		// 	admin_reminder_sent: false,
		// });
		// const delayedPaymentOrders = await Order.find({
		// 	statut: "Validé",
		// 	createdAt: { $lte: twentyFourHoursAgo },
		// 	proformas: { $not: { $size: 0 } },
		// 	payment_reminder_sent: false,
		// 	$or: [
		// 		{ paymentDone: "false" },
		// 		{ paymentDone: false },
		// 		{ paymentDone: { $exists: false } },
		// 	],
		// });
		const delayedProformaOrders = await Order.find({
			statut: "Validé",
			createdAt: { $lte: twentyFourHoursAgo },
			proformas: { $not: { $elemMatch: { validated: true } } }, // No validated proforma
			// proforma_reminder_sent: false,
		});
		// console.log("All unpaid orders:", delayedPaymentOrders);
		// console.log("All pending orders:", pendingOrders);
		console.log("All delayed proforma orders:", delayedProformaOrders);

		//*
		// statut: "Validé";
		// createdAt older than 24h
		// proformas is not empty
		// payment_reminder_sent: false
		// paymentDone: "false" (string or boolean)
		// AND payments.length === 0 (empty array)

		// const result = await Order.find({
		// 	statut: "Validé",
		// 	createdAt: { $lte: twentyFourHoursAgo },
		// 	proformas: { $not: { $size: 0 } },
		// 	payment_reminder_sent: false,
		// 	$or: [
		// 		{ paymentDone: "false" },
		// 		{ paymentDone: false },
		// 		{ paymentDone: { $exists: false } },
		// 	],
		// 	// payments: { $size: 0 }, // Only orders with no payments
		// });

		// console.log(`✅ Found ${delayedApprovalRequests.length} orders`);
		// console.log(`delayedApprovalRequests`, delayedApprovalRequests);
	} catch (error) {
		console.error("❌ Error deleting orders:", error);
	}
}

deleteOrdersInRange();
