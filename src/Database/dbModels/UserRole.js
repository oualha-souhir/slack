const mongoose = require("mongoose");

const UserRoleSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  username: { type: String, required: true }, // Slack username or display name
  roles: { type: [String], default: [] }, // e.g., ['admin', 'finance', 'achat']
});
const UserRole = mongoose.model("UserRole", UserRoleSchema);

module.exports = UserRole;
