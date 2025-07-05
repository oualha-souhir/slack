const { Order } = require("./db"); // Adjust path if needed

async function deleteOrdersInRange() {
	try {
		const result = await Order.deleteMany({
			id_commande: {
				$gte: "CMD/2025/07/0001",
				$lte: "CMD/2025/07/0127",
			},
		});
		console.log(`✅ Deleted ${result.deletedCount} orders`);
	} catch (error) {
		console.error("❌ Error deleting orders:", error);
	}
}

deleteOrdersInRange();
