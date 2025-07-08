const { PaymentRequest } = require("./db");
const { sendDelayReminder } = require("./notificationService");
let isScheduledPaymentRequest = false;

async function checkPendingPaymentRequestDelays(context) {
	try {
		console.log("** checkPendingPaymentRequestDelays");

		const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
		console.log(
			`Checking for pending payment requests created before: ${twentyFourHoursAgo}`
		);

		const pendingPaymentRequests = await PaymentRequest.find({
			statut: "En attente",
			createdAt: { $lte: twentyFourHoursAgo },
			admin_reminder_sent: false,
		});

		console.log(
			`Found ${pendingPaymentRequests.length} delayed pending payment requests`
		);

		for (const paymentRequest of pendingPaymentRequests) {
			console.log(
				`Attempting to process pending payment request: ${paymentRequest.id_paiement}`
			);

			const updatedPaymentRequest = await PaymentRequest.findOneAndUpdate(
				{
					id_paiement: paymentRequest.id_paiement,
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

			if (updatedPaymentRequest) {
				console.log(
					`Claimed payment request ${paymentRequest.id_paiement} for reminder`
				);
				await sendDelayReminder(updatedPaymentRequest, context, "admin");
			} else {
				console.log(
					`Payment request ${paymentRequest.id_paiement} already claimed by another process`
				);
			}
		}
	} catch (error) {
		console.log(
			`Error in pending payment request delay monitoring: ${error.message}`
		);
		throw error;
	}
}

async function checkPaymentRequestApprovalDelays(context) {
	try {
		console.log("** checkPaymentRequestApprovalDelays");

		const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
		console.log(
			`Checking for payment requests awaiting approval before: ${twentyFourHoursAgo}`
		);

		const delayedApprovalRequests = await PaymentRequest.find({
			statut: "En attente",
			createdAt: { $lte: twentyFourHoursAgo },
			approval_reminder_sent: false,
		});

		console.log(
			`Found ${delayedApprovalRequests.length} payment requests awaiting approval`
		);

		for (const paymentRequest of delayedApprovalRequests) {
			console.log(
				`Attempting to process pending payment request: ${paymentRequest.id_paiement}`
			);

			const updatedPaymentRequest = await PaymentRequest.findOneAndUpdate(
				{
					id_paiement: paymentRequest.id_paiement,
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

			if (updatedPaymentRequest) {
				console.log(
					`Claimed payment request ${paymentRequest.id_paiement} for reminder`
				);
				await sendDelayReminder(updatedPaymentRequest, context, "admin");
			} else {
				console.log(
					`Payment request ${paymentRequest.id_paiement} already claimed by another process`
				);
			}
		}
	} catch (error) {
		console.log(
			`Error in pending payment request delay monitoring: ${error.message}`
		);
		throw error;
	}
}

async function checkPaymentRequestApprovalDelays(context) {
	try {
		console.log("** checkPaymentRequestApprovalDelays");

		const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
		console.log(
			`Checking for payment requests awaiting approval before: ${twentyFourHoursAgo}`
		);

		const delayedApprovalRequests = await PaymentRequest.find({
			statut: "En attente",
			createdAt: { $lte: twentyFourHoursAgo },
			approval_reminder_sent: false,
		});

		console.log(
			`Found ${delayedApprovalRequests.length} payment requests awaiting approval`
		);

		for (const paymentRequest of delayedApprovalRequests) {
			console.log(
				`Attempting to process approval delay for payment request: ${paymentRequest.id_paiement}`
			);

			const updatedPaymentRequest = await PaymentRequest.findOneAndUpdate(
				{
					id_paiement: paymentRequest.id_paiement,
					approval_reminder_sent: false,
				},
				{
					$set: { approval_reminder_sent: true },
					$push: {
						delay_history: {
							type: "approval_reminder",
							timestamp: new Date(),
						},
					},
				},
				{ new: true }
			);
			if (updatedPaymentRequest) {
				console.log(
					`Claimed payment request ${paymentRequest.id_paiement} for reminder`
				);
				await sendDelayReminder(updatedPaymentRequest, context, "approval");
			} else {
				console.log(
					`Payment request ${paymentRequest.id_paiement} already claimed`
				);
			}
		}
	} catch (error) {
		console.log(
			`Error in payment request approval delay monitoring: ${error.message}`
		);
		throw error;
	}
}

function setupPaymentRequestDelayMonitoring(context) {
	console.log("** setupPaymentRequestDelayMonitoring");
	if (isScheduledPaymentRequest) {
		console.log(
			"Payment request delay monitoring already scheduled, skipping duplicate setup."
		);
		return;
	}
	cron.schedule("0 * * * *", () => {
		console.log("Running scheduled payment request delay check...");
		checkPendingPaymentRequestDelays(context);
		checkPaymentRequestApprovalDelays(context);
	});
	isScheduledPaymentRequest = true;
	console.log("Payment request delay monitoring scheduled to run every hour.");
}
module.exports = {
	checkPendingPaymentRequestDelays,
	checkPaymentRequestApprovalDelays,
	setupPaymentRequestDelayMonitoring,
};
