const mongoose = require("mongoose");
const { Order } = require("./dbModels/Order");
const { notifyTechSlack } = require("../Common/notifyProblem");

async function getOrderMessageFromDB(orderId) {
	console.log("** getOrderMessageFromDB");
	try {
		const order = await Order.findOne({ id_commande: orderId });
		if (!order || !order.slackMessages?.length) return null;
		return {
			channel: order.slackMessages[0].channel,
			ts: order.slackMessages[0].ts,
			orderId,
		};
	} catch (error) {
		await notifyTechSlack(error);

		console.error("Error retrieving order message from DB:", error);
		return null;
	}
}
async function saveOrderMessageToDB(orderId, messageDetails) {
	console.log("** saveOrderMessageToDB");
	try {
		const order = await Order.findOne({ id_commande: orderId });
		await Order.findOneAndUpdate(
			{ id_commande: orderId },
			{
				adminMessage: {
					ts: messageDetails.ts,
					createdAt: new Date(),
				},
			}
		);
		if (!order) return false;
		if (!order.slackMessages) order.slackMessages = [];
		order.slackMessages = [
			{
				channel: messageDetails.channel,
				ts: messageDetails.ts,
				messageType: "notification",
				createdAt: new Date(),
			},
		];
		await order.save();
		return true;
	} catch (error) {
		await notifyTechSlack(error);

		console.error("Error saving order message to DB:", error);
		return false;
	}
}
async function saveMessageReference(
	orderId,
	messageTs,
	channelId,
	messageType = "admin"
) {
	console.log("** saveMessageReference");
	try {
		// Define a schema for message references if not already defined
		if (!mongoose.models.MessageReference) {
			const MessageReferenceSchema = new mongoose.Schema({
				orderId: { type: String, required: true },
				messageTs: { type: String, required: true },
				channelId: { type: String, required: true },
				messageType: { type: String, required: true, default: "admin" },
				updatedAt: { type: Date, default: Date.now },
			});
			mongoose.model("MessageReference", MessageReferenceSchema);
		}

		const MessageReference = mongoose.model("MessageReference");

		// Try to update existing reference first
		const result = await MessageReference.findOneAndUpdate(
			{ orderId, messageType },
			{ messageTs, channelId, updatedAt: new Date() },
			{ new: true, upsert: false }
		);

		// If no document was updated, create a new one
		if (!result) {
			await MessageReference.create({
				orderId,
				messageTs,
				channelId,
				messageType,
				updatedAt: new Date(),
			});
		}

		return true;
	} catch (error) {
		await notifyTechSlack(error);

		console.error(`Error saving message reference: ${error.message}`);
		return false;
	}
}
async function getMessageReference(orderId, messageType = "admin") {
	console.log("** getMessageReference");
	console.log(`Looking for orderId: ${orderId}, messageType: ${messageType}`);

	try {
		if (!mongoose.models.MessageReference) {
			console.log("MessageReference model not found");
			return null;
		}

		const MessageReference = mongoose.model("MessageReference");

		// First, let's see what messageTypes exist for this orderId
		const allReferences = await MessageReference.find({ orderId });
		console.log(
			`Found ${allReferences.length} references for orderId ${orderId}:`,
			allReferences.map((ref) => ({
				messageType: ref.messageType,
				ts: ref.messageTs,
			}))
		);

		// Try exact match first
		let result = await MessageReference.findOne({ orderId, messageType });

		if (!result) {
			// Try case-insensitive match
			result = await MessageReference.findOne({
				orderId,
				messageType: { $regex: new RegExp(`^${messageType}$`, "i") },
			});

			if (result) {
				console.log(
					`Found case-insensitive match for messageType: ${result.messageType}`
				);
			}
		}

		if (!result) {
			console.log(
				`No message reference found for orderId: ${orderId}, messageType: ${messageType}`
			);
			console.log(
				`Available messageTypes for this order:`,
				allReferences.map((ref) => ref.messageType)
			);
		} else {
			console.log(`Found message reference:`, {
				orderId: result.orderId,
				messageType: result.messageType,
				messageTs: result.messageTs,
				channelId: result.channelId,
			});
		}

		return result;
	} catch (error) {
		await notifyTechSlack(error);

		console.error(`Error retrieving message reference: ${error.message}`);
		return null;
	}
}
//* ??
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
		await notifyTechSlack(err);

		console.log(`Error retrieving form data for key ${key}:`, err);
		throw err;
	}
}
module.exports = {
	getOrderMessageFromDB,
	saveOrderMessageToDB,
	saveMessageReference,
	getMessageReference,
	getFromStorage,
};
