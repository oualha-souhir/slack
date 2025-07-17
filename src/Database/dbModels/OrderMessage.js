const mongoose = require("mongoose");
// Create a schema for storing message references
const OrderMessageSchema = new mongoose.Schema({
	orderId: { type: String, required: true, unique: true },
	messageTs: { type: String, required: true },
	channelId: { type: String, required: true },
	lastUpdated: { type: Date, default: Date.now },
	// Optional: Set an expiration based on your needs (e.g., 30 days)
	createdAt: { type: Date, default: Date.now, expires: "30d" },
});
const OrderMessage = mongoose.model("OrderMessage", OrderMessageSchema);
module.exports = OrderMessage;
